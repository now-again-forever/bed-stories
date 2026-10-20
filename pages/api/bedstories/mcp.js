// pages/api/bedstories/mcp.js
//
// MCP server (Streamable HTTP, stateless JSON) for the Bedstories Claude
// artifact, added in claude.ai as the custom connector "Bedstories":
//   https://bed-stories.vercel.app/api/bedstories/mcp[?key=<MCP_SECRET>]
// Set MCP_SECRET in Vercel env to lock it; unset, the endpoint is open.
//
// Tools
//   narrate_start / narrate_status — two-voice narration via ElevenLabs
//       text-to-dialogue WITH timestamps, saved to Supabase (permanent URL),
//       returning exact word timings for subtitles. Runs in the background.
//   render_video / poll_render — Shotstack assembly; captions from the word
//       timings; the finished MP4 is copied to Supabase so links never expire.
//   list_library — previously uploaded felt-animal images.

import { waitUntil } from '@vercel/functions';
import { BUCKET, publicUrl, newId, readJob, writeJob, runNarration, runRealign, runSaveRender } from '../../../lib/bedstoriesJobs';

const SOUND_FILE = {
  'Rain':           'bs-rain.mp3',
  'City at night':  'bs-city.mp3',
  'Forest & birds': 'bs-forest.mp3',
  'Ocean waves':    'bs-ocean.mp3',
  'Fireplace':      'bs-fire.mp3',
  'Soft café':      'bs-cafe.mp3',
};
const AMBIENT_CLIP_DURATION = 30;
const PIANO_CLIP_DURATION = 188;
const PIANO_FADE_BUFFER = 4;
const VIDEO_CLIP = 5;

const WORD = { type: 'object', required: ['word', 'start', 'end'], properties: { word: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } };

const TOOLS = [
  {
    name: 'narrate_start',
    description: 'Start two-voice narration of a Bedstories script (Nicole + Damon) with ElevenLabs, with exact word timestamps. Returns jobId immediately; poll narrate_status every ~5s.',
    inputSchema: {
      type: 'object', required: ['segments'],
      properties: {
        segments: {
          type: 'array', description: 'Script in order. Paragraph breaks (blank lines) inside a segment are kept as natural pauses.',
          items: { type: 'object', required: ['speaker', 'text'], properties: { speaker: { type: 'string', enum: ['nicole', 'damon'] }, text: { type: 'string' } } },
        },
      },
    },
  },
  {
    name: 'narrate_realign',
    description: 'Re-time an existing narration MP3 against its script with forced alignment (no re-recording, no TTS credits). Returns jobId; poll narrate_status.',
    inputSchema: {
      type: 'object', required: ['audioUrl', 'segments'],
      properties: {
        audioUrl: { type: 'string', description: 'The narration MP3 from an earlier narrate_status' },
        segments: { type: 'array', items: { type: 'object', required: ['speaker', 'text'], properties: { speaker: { type: 'string', enum: ['nicole', 'damon'] }, text: { type: 'string' } } } },
      },
    },
  },
  {
    name: 'narrate_status',
    description: 'Status of a narration job: { status: queued|running|done|failed, progress, audioUrl, duration, damonStartTime, words[] }. audioUrl is permanent.',
    inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
  },
  {
    name: 'render_video',
    description: 'Assemble a Bedstories video with Shotstack: looped 5s video, narration, piano from damonStartTime, ambient bed, and (with words) burned-in TikTok-style subtitles timed to the real speech. Returns renderId; poll with poll_render.',
    inputSchema: {
      type: 'object', required: ['videoUrl', 'audioUrl', 'audioDuration'],
      properties: {
        videoUrl: { type: 'string', description: 'Public MP4 URL of the looping visual' },
        audioUrl: { type: 'string', description: 'Narration MP3 (from narrate_status)' },
        audioDuration: { type: 'number', description: 'Narration length in seconds' },
        damonStartTime: { type: 'number', description: 'Seconds at which piano starts' },
        words: { type: 'array', items: WORD, description: 'Word timings from narrate_status; enables subtitles' },
        subtitles: { type: 'boolean', description: 'Burn in subtitles (default true when words are given)' },
        sound: { type: 'string', enum: Object.keys(SOUND_FILE), description: 'Ambient bed (default Rain)' },
        outputFormat: { type: 'string', enum: ['vertical', 'horizontal'] },
        cropWatermark: { type: 'boolean', description: 'Zoom video 15% to hide bottom-right watermarks' },
      },
    },
  },
  {
    name: 'poll_render',
    description: 'Check a Shotstack render. Returns { status: queued|rendering|saving|done|failed, url, temporary }. When done, url is a permanent copy in Supabase (temporary:true means the copy failed and the 24h Shotstack link is returned instead).',
    inputSchema: { type: 'object', required: ['renderId'], properties: { renderId: { type: 'string' } } },
  },
  {
    name: 'list_library',
    description: 'List previously uploaded felt-animal images (public URLs) from the Bedstories Supabase bucket, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items (default 40)' } } },
  },
];

// ── subtitles from real word timings ─────────────────────────────────────
const isDivider = (w) => /^[·•.\-–—*]+$/.test(w);
function captionLines(words, { maxWords = 4, maxChars = 22, gap = 0.45 } = {}) {
  const ws = words.filter(w => w.word && !isDivider(w.word)).map(w => ({ ...w, word: w.word.replace(/["“”]/g, '') })).filter(w => w.word);
  const lines = []; let cur = [];
  const text = (a) => a.map(w => w.word).join(' ');
  const flush = () => { if (cur.length) { lines.push(cur); cur = []; } };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > gap || cur.length >= maxWords || text([...cur, w]).length > maxChars)) flush();
    cur.push(w);
    if (/[.!?;:,—]$/.test(w.word)) flush();
  }
  flush();
  // Fold a lone non-final word back into the previous line when it fits
  const merged = [];
  for (const l of lines) {
    const p = merged[merged.length - 1];
    if (p && l.length === 1 && !/[.!?]$/.test(p[p.length - 1].word) && text([...p, ...l]).length <= maxChars + 6 && l[0].start - p[p.length - 1].end < gap) p.push(...l);
    else merged.push(l);
  }
  return merged.map((l, i) => {
    const next = merged[i + 1];
    const start = l[0].start;
    // Hold each line until the next one starts (no flicker), but not more than 0.6s past its last word
    const end = Math.min(next ? next[0].start : Infinity, l[l.length - 1].end + 0.6);
    return { text: text(l), start, end: Math.max(end, start + 0.3) };
  });
}
const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function captionTrack(words, size) {
  const vertical = size.height > size.width;
  // Calm, sleep-friendly captions: sentence case, warm off-white, semi-bold,
  // a soft shadow instead of a hard outline. Still readable on a phone over
  // the felt scene, without shouting.
  const boxW = vertical ? 900 : 1400, boxH = vertical ? 220 : 160, fontPx = vertical ? 46 : 40;
  const css = `p { font-family: 'Montserrat SemiBold', 'Montserrat', 'Open Sans', sans-serif; font-weight: 600; font-size: ${fontPx}px; line-height: 1.25; color: #FFF6E8; text-align: center; letter-spacing: 0.3px; margin: 0; text-shadow: 0 2px 3px rgba(0,0,0,.75), 0 0 14px rgba(0,0,0,.45); }`;
  return captionLines(words).map(l => ({
    asset: { type: 'html', html: `<p>${escHtml(l.text)}</p>`, css, width: boxW, height: boxH, position: 'center' },
    start: Number(l.start.toFixed(3)),
    length: Number((l.end - l.start).toFixed(3)),
    position: 'center',
    offset: { x: 0, y: vertical ? -0.26 : -0.32 },
  }));
}

// ── assembly ─────────────────────────────────────────────────────────────
function tiledAudio(src, from, to, clipLen, volume) {
  const clips = []; let t = from;
  while (t < to) {
    const len = Math.min(clipLen, to - t);
    const isFirst = t === from, isLast = t + len >= to;
    const effect = isFirst && isLast ? 'fadeInFadeOut' : isFirst ? 'fadeIn' : isLast ? 'fadeOut' : 'none';
    clips.push({ asset: { type: 'audio', src, volume, effect }, start: t, length: len });
    t += len;
  }
  return clips;
}

async function renderVideo(args) {
  const { videoUrl, audioUrl, words, sound = 'Rain', outputFormat = 'vertical', cropWatermark = false } = args;
  const audioDuration = Number(args.audioDuration);
  if (!videoUrl || !audioUrl || !(audioDuration > 0)) throw new Error('videoUrl, audioUrl and audioDuration are required');

  const totalDuration = audioDuration + 0.5;
  const pianoStart = Number(args.damonStartTime) || 0;
  const pianoEnd = Math.max(totalDuration - PIANO_FADE_BUFFER, pianoStart + 1);
  const size = outputFormat === 'horizontal' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };

  const videoClips = []; let vt = 0;
  while (vt < totalDuration) {
    const len = Math.min(VIDEO_CLIP, totalDuration - vt);
    videoClips.push({ asset: { type: 'video', src: videoUrl, trim: 0, volume: 0 }, start: vt, length: len, fit: 'cover', ...(cropWatermark ? { scale: 1.15 } : {}) });
    vt += len;
  }

  const wantSubs = args.subtitles !== false && Array.isArray(words) && words.length > 0;
  const captions = wantSubs ? captionTrack(words, size) : [];

  const payload = {
    timeline: {
      tracks: [
        ...(captions.length ? [{ clips: captions }] : []),
        { clips: [{ asset: { type: 'audio', src: audioUrl, volume: 1.0 }, start: 0, length: audioDuration }] },
        { clips: tiledAudio(publicUrl('bs-piano-v2.mp3'), pianoStart, pianoEnd, PIANO_CLIP_DURATION, 0.12) },
        { clips: tiledAudio(publicUrl(SOUND_FILE[sound] || 'bs-rain.mp3'), 0, totalDuration, AMBIENT_CLIP_DURATION, 0.15) },
        { clips: videoClips },
      ],
    },
    // 'low' keeps a 6-minute 1080×1920 story small enough to store permanently
    // (medium came out at ~7.4 Mbps / 191 MB); the scene is nearly still, and
    // TikTok and Instagram re-encode on upload regardless.
    output: { format: 'mp4', size, fps: 25, quality: 'low' },
  };

  const r = await fetch('https://api.shotstack.io/v1/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SHOTSTACK_API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.success) throw new Error(JSON.stringify(data.response || data.message || data));
  return { renderId: data.response.id, totalDuration, captionLines: captions.length };
}

async function pollRender({ renderId }) {
  if (!renderId) throw new Error('renderId required');
  const saved = await readJob(`render-${renderId}`);
  if (saved?.status === 'done') return { status: 'done', url: saved.url, temporary: !!saved.temporary, saveError: saved.saveError || null };
  if (saved?.status === 'saving') return { status: 'saving', url: null };

  const r = await fetch(`https://api.shotstack.io/v1/render/${renderId}`, { headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY } });
  const data = await r.json();
  if (!data.success) throw new Error('Shotstack poll failed');
  const s = data.response?.status;
  if (s === 'failed') return { status: 'failed', url: null, error: data.response?.error || 'Shotstack render failed' };
  if (s !== 'done') return { status: s === 'queued' ? 'queued' : 'rendering', url: null };

  // Shotstack is done: copy the MP4 to Supabase in the background
  await writeJob(`render-${renderId}`, { kind: 'render', status: 'saving' });
  waitUntil(runSaveRender(renderId, data.response.url));
  return { status: 'saving', url: null };
}

async function narrateStart({ segments }) {
  const segs = (segments || []).filter(s => s && s.text && String(s.text).trim());
  if (!segs.length) throw new Error('segments[] with text is required');
  const jobId = newId('narr');
  await writeJob(jobId, { kind: 'narration', status: 'queued' });
  waitUntil(runNarration(jobId, segs));
  return { jobId, status: 'queued' };
}

async function narrateRealign({ audioUrl, segments }) {
  const segs = (segments || []).filter(s => s && s.text && String(s.text).trim());
  if (!audioUrl || !segs.length) throw new Error('audioUrl and segments[] are required');
  const jobId = newId('align');
  await writeJob(jobId, { kind: 'narration', status: 'queued', audioUrl });
  waitUntil(runRealign(jobId, audioUrl, segs));
  return { jobId, status: 'queued' };
}

async function narrateStatus({ jobId }) {
  if (!jobId) throw new Error('jobId required');
  const j = await readJob(jobId);
  if (!j) return { status: 'queued' };   // the job file can lag a moment behind narrate_start
  return j;
}

async function listLibrary({ limit = 40 } = {}) {
  const { default: supabaseAdmin } = await import('../../../lib/supabaseAdmin');
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list('', { limit: 200, sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw new Error(`Supabase list failed: ${error.message}`);
  return { items: (data || []).filter(f => /^bs-upload-.*\.(jpe?g|png|webp)$/i.test(f.name)).slice(0, limit).map(f => ({ name: f.name, url: publicUrl(f.name), createdAt: f.created_at })) };
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────
const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const HANDLERS = { narrate_start: narrateStart, narrate_realign: narrateRealign, narrate_status: narrateStatus, render_video: renderVideo, poll_render: pollRender, list_library: listLibrary };

export default async function handler(req, res) {
  const secret = process.env.MCP_SECRET;
  if (secret && req.query.key !== secret) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).end();

  const msg = req.body;
  if (!msg || msg.jsonrpc !== '2.0') return res.status(400).json(rpcErr(null, -32600, 'Invalid request'));
  if (msg.id === undefined || msg.id === null) return res.status(202).end();

  try {
    switch (msg.method) {
      case 'initialize':
        return res.json(rpc(msg.id, {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'bedstories', version: '2.0.0' },
          instructions: 'Bedstories production backend. Narrate with narrate_start then poll narrate_status (~5s) until done (subtitle timings come from forced alignment of the finished audio); pass its audioUrl, duration, damonStartTime and words to render_video; poll poll_render (~10s) until done. All returned media URLs are permanent.',
        }));
      case 'ping': return res.json(rpc(msg.id, {}));
      case 'tools/list': return res.json(rpc(msg.id, { tools: TOOLS }));
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const fn = HANDLERS[name];
        if (!fn) return res.json(rpcErr(msg.id, -32602, `Unknown tool: ${name}`));
        const out = await fn(args);
        // Word arrays are large; keep the text block short and put the full result in structuredContent
        const summary = name === 'narrate_status' && out?.words ? { ...out, words: `[${out.words.length} words]` } : out;
        return res.json(rpc(msg.id, { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: out, isError: false }));
      }
      default: return res.json(rpcErr(msg.id, -32601, `Method not found: ${msg.method}`));
    }
  } catch (e) {
    console.error('mcp error:', e);
    return res.json(rpc(msg.id, { content: [{ type: 'text', text: e.message || String(e) }], isError: true }));
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
