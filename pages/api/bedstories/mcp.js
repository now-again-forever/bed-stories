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
import { BUCKET, publicUrl, newId, readJob, writeJob, runNarration, runRealign, runSaveRender, shotstackHostedUrl } from '../../../lib/bedstoriesJobs';

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
    name: 'health',
    description: 'Check the backend: API keys present, storage reachable, endpoint locked. Returns { ok, problems[], locked }.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'narrate_realign',
    description: 'Re-time an existing narration MP3 against its script with forced alignment (no re-recording, no TTS credits). Returns jobId; poll narrate_status.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Preferred: jobId of an earlier narration; its audio and script are reused.' },
        audioUrl: { type: 'string', description: 'The narration MP3 from an earlier narrate_status' },
        segments: { type: 'array', items: { type: 'object', required: ['speaker', 'text'], properties: { speaker: { type: 'string', enum: ['nicole', 'damon'] }, text: { type: 'string' } } } },
      },
    },
  },
  {
    name: 'narrate_status',
    description: 'Status of a narration job: { status: queued|running|done|failed, progress, audioUrl, duration, damonStartTime, words[] }. audioUrl is permanent.',
    inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, includeWords: { type: 'boolean', description: 'Default true. Pass false to skip the word list (render_video can load it by narrationJobId).' } } },
  },
  {
    name: 'render_video',
    description: 'Assemble a Bedstories video with Shotstack: looped 5s video, narration, piano from damonStartTime, ambient bed, and (with words) burned-in TikTok-style subtitles timed to the real speech. Returns renderId; poll with poll_render.',
    inputSchema: {
      type: 'object', required: ['videoUrl'],
      properties: {
        videoUrl: { type: 'string', description: 'Public MP4 URL of the looping visual' },
        narrationJobId: { type: 'string', description: 'Preferred: the jobId of a finished narration. Audio, duration, piano cue and word timings are loaded server-side, so audioUrl/audioDuration/words can be omitted.' },
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
    name: 'fetch_images',
    description: 'Fetch up to 4 images by URL (fal.media, Shotstack, Supabase only) and return them as image blocks, so a page that cannot load outside media can still look at them.',
    inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' }, description: '1-4 image URLs' } }, required: ['urls'] },
  },
  {
    name: 'render_frames',
    description: 'Two stills from a finished render, as image blocks: the exact middle frame, then a frame from just before the end.',
    inputSchema: { type: 'object', properties: { renderId: { type: 'string' } }, required: ['renderId'] },
  },
  {
    name: 'list_library',
    description: 'List previously uploaded felt-animal images (public URLs) from the Bedstories Supabase bucket, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items (default 40)' } } },
  },
];

// ── subtitles from real word timings ─────────────────────────────────────
const isDivider = (w) => /^[·•.\-–—*]+$/.test(w);
function captionLines(words, { maxWords = 4, maxChars = 22, mergeSlack = 6, gap = 0.45 } = {}) {
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
    if (p && l.length === 1 && !/[.!?]$/.test(p[p.length - 1].word) && text([...p, ...l]).length <= maxChars + mergeSlack && l[0].start - p[p.length - 1].end < gap) p.push(...l);
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
// ── THE SUBTITLE SAFE-AREA RULE ──────────────────────────────────────────
// Subtitles must never leave the phone-safe area, whatever size they are set
// to. Change SUB_STYLE freely; the three guards below keep the result legal.
//   1. The box is the safe area: clear of the right-hand TikTok/Reels buttons
//      (130px each side on a 1080 frame) and of the caption zone at the bottom.
//   2. The line length limit is DERIVED from the font size and box width, so a
//      bigger font automatically means fewer characters per line.
//   3. Any single line still too wide (one very long word) has its own font
//      shrunk to fit. Nothing is ever clipped or pushed off screen.
const SUB_STYLE = {
  vertical:   { fontPx: 64, safeW: 820,  boxH: 240, y: -0.2, maxWords: 4 },
  horizontal: { fontPx: 54, safeW: 1500, boxH: 190, y: -0.3, maxWords: 6 },
};
const CHAR_W = 0.62;      // average glyph width ÷ font size for Montserrat SemiBold, rounded up
const MIN_FONT_PX = 34;   // floor for guard 3; below this a long word wraps instead (the box holds two rows)
const estWidth = (text, fontPx) => text.length * fontPx * CHAR_W;

// Subtitles are Shotstack "rich-text" clips, which draw a real stroke around
// each letter. (The earlier HTML clips faked the border with stacked
// text-shadows, and Shotstack's HTML renderer dropped them, leaving only a
// soft shadow.)
function captionTrack(words, size) {
  const st = size.height > size.width ? SUB_STYLE.vertical : SUB_STYLE.horizontal;
  const maxChars = Math.max(8, Math.floor(st.safeW / (st.fontPx * CHAR_W)) - 3);             // guard 2
  return captionLines(words, { maxWords: st.maxWords, maxChars, mergeSlack: 3 }).map(l => {
    const w = estWidth(l.text, st.fontPx);
    const px = w <= st.safeW ? st.fontPx : Math.max(MIN_FONT_PX, Math.floor(st.fontPx * st.safeW / w));   // guard 3
    return {
      asset: {
        type: 'rich-text', text: l.text,
        font: { family: 'Montserrat', size: px, weight: 700, color: '#FFF6E8', opacity: 1 },
        style: { lineHeight: 1.2, letterSpacing: 0 },
        stroke: { width: Math.max(4, Math.round(px / 10)), color: '#000000', opacity: 1 },
        shadow: { offsetX: 0, offsetY: 4, blur: 8, color: '#000000', opacity: 0.55 },
        align: { horizontal: 'center', vertical: 'middle' },
      },
      width: st.safeW, height: st.boxH,                                                        // guard 1
      start: Number(l.start.toFixed(3)),
      length: Number((l.end - l.start).toFixed(3)),
      position: 'center',
      offset: { x: 0, y: st.y },
    };
  });
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
  // Preferred: narrationJobId. The backend already holds the audio, its real
  // length and every word timing, so nothing large travels through the page.
  if (args.narrationJobId) {
    const j = await readJob(args.narrationJobId);
    if (!j || j.status !== 'done') throw new Error('That narration is not finished (or was not found). Record it again.');
    if (args.subtitles !== false && j.alignment !== 'forced') throw new Error('This recording has no exact word timings yet. Re-time it first (narrate_realign), then render.');
    args = { ...args, audioUrl: j.audioUrl, audioDuration: j.duration, damonStartTime: args.damonStartTime ?? j.damonStartTime, words: j.words };
  }
  const { videoUrl, audioUrl, words, sound = 'Rain', outputFormat = 'vertical', cropWatermark = false } = args;
  const audioDuration = Number(args.audioDuration);
  if (!videoUrl || !audioUrl || !(audioDuration > 0)) throw new Error('videoUrl plus narrationJobId (or audioUrl and audioDuration) are required');

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
    // poster = a still from the exact middle, thumbnail = a still from just before the end.
    // The page looks at both to check the finished video before it is posted.
    output: { format: 'mp4', size, fps: 25, quality: 'low',
      poster: { capture: Number((totalDuration / 2).toFixed(2)) },
      thumbnail: { capture: Number(Math.max(0, totalDuration - 2).toFixed(2)), scale: 0.5 } },
  };

  const r = await fetch('https://api.shotstack.io/v1/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SHOTSTACK_API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.success) throw new Error(JSON.stringify(data.response || data.message || data));
  // What should be on screen halfway through: lets the page check a real frame
  // of the finished video against the subtitle that was meant to be showing.
  const mid = totalDuration / 2;
  const near = captions.filter(c => c.start + c.length > mid - 1.5 && c.start < mid + 1.5)
    .map(c => ({ text: c.asset.text, start: c.start, end: Number((c.start + c.length).toFixed(3)) }));
  const lastCaptionEnd = captions.length ? Number((captions[captions.length - 1].start + captions[captions.length - 1].length).toFixed(2)) : 0;
  return { renderId: data.response.id, totalDuration, captionLines: captions.length,
    check: { midTime: Number(mid.toFixed(2)), near, lastCaptionEnd, fontPx: captions[0]?.asset?.font?.size || null } };
}

async function pollRender({ renderId }) {
  if (!renderId) throw new Error('renderId required');
  const saved = await readJob(`render-${renderId}`);
  if (saved?.status === 'done' && !saved.temporary) return { status: 'done', url: saved.url, temporary: false, host: saved.host || null };
  if (saved?.status === 'done' && saved.temporary) {
    // An earlier save fell back to the 24h link. Shotstack's CDN copy may exist: upgrade to it.
    const hosted = await shotstackHostedUrl(renderId);
    if (hosted) { await writeJob(`render-${renderId}`, { ...saved, url: hosted, temporary: false, host: 'shotstack-cdn' }); return { status: 'done', url: hosted, temporary: false, host: 'shotstack-cdn' }; }
    return { status: 'done', url: saved.url, temporary: true, saveError: saved.saveError || null };
  }
  // A save that has sat for 3 minutes has died (timeout or crash): start it again below
  const savingFresh = saved?.status === 'saving' && Date.now() - new Date(saved.updatedAt).getTime() < 3 * 60 * 1000;
  if (savingFresh) return { status: 'saving', url: null };

  const r = await fetch(`https://api.shotstack.io/v1/render/${renderId}`, { headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY } });
  const data = await r.json();
  if (!data.success) throw new Error('Shotstack poll failed');
  const s = data.response?.status;
  if (s === 'failed') return { status: 'failed', url: null, error: data.response?.error || 'Shotstack render failed' };
  if (s !== 'done') return { status: s === 'queued' ? 'queued' : 'rendering', url: null };

  await writeJob(`render-${renderId}`, { kind: 'render', status: 'saving' });
  waitUntil(runSaveRender(renderId, data.response.url));
  return { status: 'saving', url: null };
}

// ── images as blocks ─────────────────────────────────────────────────────
// The page runs in a sandbox that cannot load outside images, so the backend
// fetches them and hands them over inside the tool result.
const IMAGE_HOSTS = /(^|\.)fal\.media$|(^|\.)shotstack\.io$|shotstack[^/]*\.amazonaws\.com$|(^|\.)supabase\.co$/i;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
async function imageBlock(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !IMAGE_HOSTS.test(u.hostname)) throw new Error(`not an allowed image host: ${u.hostname}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not fetch the image (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image is ${(buf.length / 1e6).toFixed(1)} MB, over the 3 MB limit`);
  const sig = buf.subarray(0, 4).toString('hex');
  const mimeType = sig.startsWith('ffd8') ? 'image/jpeg' : sig === '89504e47' ? 'image/png' : sig === '52494646' ? 'image/webp' : null;
  if (!mimeType) throw new Error('that URL did not return a JPEG, PNG or WebP image');
  return { type: 'image', data: buf.toString('base64'), mimeType };
}
async function fetchImages({ urls }) {
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, 4);
  if (!list.length) throw new Error('urls[] is required');
  const blocks = await Promise.all(list.map(imageBlock));
  return { count: blocks.length, __content: blocks };
}
async function renderFrames({ renderId }) {
  if (!renderId) throw new Error('renderId required');
  const r = await fetch(`https://api.shotstack.io/v1/render/${renderId}`, { headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY } });
  const data = await r.json();
  if (!data.success) throw new Error('Shotstack lookup failed');
  const { poster, thumbnail, status } = data.response || {};
  if (status !== 'done') throw new Error(`the render is not finished (${status})`);
  if (!poster || !thumbnail) throw new Error('this render has no stills (it was made before stills were added, or they have expired)');
  const blocks = await Promise.all([imageBlock(poster), imageBlock(thumbnail)]);
  return { count: 2, order: ['middle', 'end'], __content: blocks };
}

async function narrateStart({ segments }) {
  const segs = (segments || []).filter(s => s && s.text && String(s.text).trim());
  if (!segs.length) throw new Error('segments[] with text is required');
  const jobId = newId('narr');
  await writeJob(jobId, { kind: 'narration', status: 'queued' });
  waitUntil(runNarration(jobId, segs));
  return { jobId, status: 'queued' };
}

async function narrateRealign({ jobId: fromJob, audioUrl, segments }) {
  let segs = (segments || []).filter(s => s && s.text && String(s.text).trim());
  if (fromJob) {
    const j = await readJob(fromJob);
    if (!j?.audioUrl) throw new Error('That narration was not found.');
    audioUrl = audioUrl || j.audioUrl;
    // The script saved with the job; for older jobs, rebuild it from the words that were spoken
    if (!segs.length) segs = j.script?.length ? j.script : [{ speaker: 'damon', text: (j.words || []).map(w => w.word).join(' ') }];
  }
  if (!audioUrl || !segs.length) throw new Error('jobId, or audioUrl and segments[], are required');
  const jobId = newId('align');
  await writeJob(jobId, { kind: 'narration', status: 'queued', audioUrl });
  waitUntil(runRealign(jobId, audioUrl, segs));
  return { jobId, status: 'queued' };
}

// Do the subtitle timings match the recording? Measured, not guessed: every
// script word should have a timing, timings should run forwards, reach the
// end of the audio, and never leave a long hole with no caption.
function syncReport(j) {
  const ws = Array.isArray(j.words) ? j.words : [];
  const scriptWords = (j.script || []).reduce((n, s) => n + String(s.text || '').split(/\s+/).filter(Boolean).length, 0);
  let backwards = 0, maxGap = 0, gapAt = 0, zero = 0;
  for (let i = 0; i < ws.length; i++) {
    if (!(ws[i].end > ws[i].start)) zero++;
    if (i && ws[i].start < ws[i - 1].start - 0.02) backwards++;
    if (i) { const g = ws[i].start - ws[i - 1].end; if (g > maxGap) { maxGap = g; gapAt = ws[i - 1].end; } }
  }
  const last = ws.length ? ws[ws.length - 1].end : 0, first = ws.length ? ws[0].start : 0;
  const coverage = scriptWords ? ws.length / scriptWords : null;
  const problems = [];
  if (j.alignment !== 'forced') problems.push('timings were not taken from the finished audio');
  if (!ws.length) problems.push('no word timings');
  if (coverage !== null && (coverage < 0.97 || coverage > 1.03)) problems.push(`${ws.length} timed words for ${scriptWords} script words`);
  if (backwards) problems.push(`${backwards} words run backwards in time`);
  if (zero > ws.length * 0.02) problems.push(`${zero} words have no length`);
  if (first > 4) problems.push(`first word starts at ${first.toFixed(1)}s`);
  if (j.duration && last < j.duration - 6) problems.push(`timings stop ${(j.duration - last).toFixed(1)}s before the audio ends`);
  if (j.duration && last > j.duration + 0.5) problems.push('timings run past the end of the audio');
  if (maxGap > 9) problems.push(`a ${maxGap.toFixed(1)}s hole with no words at ${gapAt.toFixed(0)}s`);
  if (!(j.damonStartTime > 2)) problems.push('piano cue is at the very start (story body not found)');
  return { ok: problems.length === 0, problems, timedWords: ws.length, scriptWords, maxGap: Number(maxGap.toFixed(2)), lastWordEnd: Number(last.toFixed(2)) };
}

async function narrateStatus({ jobId, includeWords = true }) {
  if (!jobId) throw new Error('jobId required');
  const j = await readJob(jobId);
  if (!j) return { status: 'queued' };   // the job file can lag a moment behind narrate_start
  const { script, ...rest } = j;
  if (j.status === 'done') rest.sync = syncReport(j);
  if (!includeWords) delete rest.words;
  return rest;
}

// One call that says what, if anything, is wrong with the backend.
async function health() {
  const out = { ok: true, problems: [] };
  for (const k of ['ELEVENLABS_API_KEY', 'SHOTSTACK_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL']) if (!process.env[k]) out.problems.push(`${k} is not set on Vercel`);
  try {
    const { default: supabaseAdmin } = await import('../../../lib/supabaseAdmin');
    const { error } = await Promise.race([
      supabaseAdmin.storage.from(BUCKET).list('', { limit: 1 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000)),
    ]);
    if (error) throw new Error(error.message);
  } catch (e) { out.problems.push(`Storage is unreachable (${e.message}). The Supabase project is probably paused: restore it from the Supabase dashboard.`); }
  out.locked = !!process.env.MCP_SECRET;
  out.ok = out.problems.length === 0;
  return out;
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
const HANDLERS = { fetch_images: fetchImages, render_frames: renderFrames, health, narrate_start: narrateStart, narrate_realign: narrateRealign, narrate_status: narrateStatus, render_video: renderVideo, poll_render: pollRender, list_library: listLibrary };

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
        if (out?.__content) {   // image blocks travel next to the JSON, not inside it
          const { __content, ...meta } = out;
          return res.json(rpc(msg.id, { content: [{ type: 'text', text: JSON.stringify(meta) }, ...__content], structuredContent: meta, isError: false }));
        }
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
