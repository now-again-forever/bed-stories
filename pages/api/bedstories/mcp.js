// pages/api/bedstories/mcp.js
//
// Minimal MCP server (Streamable HTTP, stateless JSON) exposing Shotstack
// render + poll as tools, so the Bedstories Claude artifact can trigger the
// final assembly through a claude.ai custom connector.
//
// Add in claude.ai → Settings → Connectors → Add custom connector:
//   https://bed-stories.vercel.app/api/bedstories/mcp?key=<MCP_SECRET>
// Set MCP_SECRET in Vercel env (any long random string). If unset, the
// endpoint is open — fine for testing, not for leaving up.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const BUCKET = 'bedstories-audio';
const assetUrl = (f) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${f}`;

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

const TOOLS = [
  {
    name: 'render_video',
    description:
      'Assemble a Bedstories video with Shotstack: looped 5s video, one or more narration clips placed sequentially, piano from damonStartTime, ambient sound throughout. Returns renderId; poll with poll_render.',
    inputSchema: {
      type: 'object',
      required: ['videoUrl', 'narration'],
      properties: {
        videoUrl: { type: 'string', description: 'Public MP4 URL of the looping visual' },
        narration: {
          type: 'array',
          description: 'Narration clips in order. Each has a public audio URL and its duration in seconds.',
          items: {
            type: 'object',
            required: ['url', 'duration'],
            properties: {
              url: { type: 'string' },
              duration: { type: 'number' },
              speaker: { type: 'string', description: 'nicole | damon (informational)' },
            },
          },
        },
        gapSeconds: { type: 'number', description: 'Silence between narration clips (default 0.6)' },
        damonStartTime: { type: 'number', description: 'Seconds at which piano starts (default: start of 2nd damon clip, else 0)' },
        sound: { type: 'string', enum: Object.keys(SOUND_FILE), description: 'Ambient bed (default Rain)' },
        outputFormat: { type: 'string', enum: ['vertical', 'horizontal'] },
        cropWatermark: { type: 'boolean', description: 'Zoom video 15% to hide bottom-right watermarks' },
      },
    },
  },
  {
    name: 'list_library',
    description: 'List previously uploaded felt-animal images (public URLs) from the Bedstories Supabase bucket, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items (default 40)' } } },
  },
  {
    name: 'poll_render',
    description: 'Check a Shotstack render. Returns { status: queued|rendering|done|failed, url }.',
    inputSchema: {
      type: 'object',
      required: ['renderId'],
      properties: { renderId: { type: 'string' } },
    },
  },
];

function clipsTiled(src, from, to, clipLen, volume) {
  const clips = [];
  let t = from;
  while (t < to) {
    const len = Math.min(clipLen, to - t);
    const isFirst = t === from;
    const isLast = t + len >= to;
    const effect = isFirst && isLast ? 'fadeInFadeOut' : isFirst ? 'fadeIn' : isLast ? 'fadeOut' : 'none';
    clips.push({ asset: { type: 'audio', src, volume, effect }, start: t, length: len });
    t += len;
  }
  return clips;
}

async function renderVideo(args) {
  const {
    videoUrl, narration = [], gapSeconds = 0.6, sound = 'Rain',
    outputFormat = 'vertical', cropWatermark = false,
  } = args;
  if (!videoUrl || !narration.length) throw new Error('videoUrl and narration[] are required');

  // Lay narration clips end to end
  const narrationClips = [];
  let t = 0;
  let damonSeen = 0;
  let damonStart = typeof args.damonStartTime === 'number' ? args.damonStartTime : null;
  for (const n of narration) {
    const len = Number(n.duration) || 0;
    if (!n.url || len <= 0) throw new Error('each narration clip needs url and positive duration');
    if (n.speaker === 'damon') { damonSeen++; if (damonSeen === 2 && damonStart === null) damonStart = t; }
    narrationClips.push({ asset: { type: 'audio', src: n.url, volume: 1.0 }, start: t, length: len });
    t += len + gapSeconds;
  }
  const totalDuration = t - gapSeconds + 0.5;
  if (damonStart === null) damonStart = 0;

  const pianoStart = damonStart;
  const pianoEnd = Math.max(totalDuration - PIANO_FADE_BUFFER, pianoStart + 1);

  const videoClips = [];
  let vt = 0;
  while (vt < totalDuration) {
    const len = Math.min(VIDEO_CLIP, totalDuration - vt);
    videoClips.push({
      asset: { type: 'video', src: videoUrl, trim: 0, volume: 0 },
      start: vt, length: len, fit: 'cover',
      ...(cropWatermark ? { scale: 1.15 } : {}),
    });
    vt += len;
  }

  const size = outputFormat === 'horizontal' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };

  const payload = {
    timeline: {
      tracks: [
        { clips: narrationClips },
        { clips: clipsTiled(assetUrl('bs-piano-v2.mp3'), pianoStart, pianoEnd, PIANO_CLIP_DURATION, 0.12) },
        { clips: clipsTiled(assetUrl(SOUND_FILE[sound] || 'bs-rain.mp3'), 0, totalDuration, AMBIENT_CLIP_DURATION, 0.15) },
        { clips: videoClips },
      ],
    },
    output: { format: 'mp4', size },
  };

  const r = await fetch('https://api.shotstack.io/v1/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SHOTSTACK_API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.success) throw new Error(JSON.stringify(data.response || data.message || data));
  return { renderId: data.response.id, totalDuration, damonStartTime: damonStart };
}

async function listLibrary({ limit = 40 } = {}) {
  const { default: supabaseAdmin } = await import('../../../lib/supabaseAdmin');
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list('', {
    limit: 200, sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error) throw new Error(`Supabase list failed: ${error.message}`);
  const items = (data || [])
    .filter(f => /^bs-upload-.*\.(jpe?g|png|webp)$/i.test(f.name))
    .slice(0, limit)
    .map(f => ({ name: f.name, url: assetUrl(f.name), createdAt: f.created_at }));
  return { items };
}

async function pollRender({ renderId }) {
  if (!renderId) throw new Error('renderId required');
  const r = await fetch(`https://api.shotstack.io/v1/render/${renderId}`, {
    headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY },
  });
  const data = await r.json();
  if (!data.success) throw new Error('Shotstack poll failed');
  const s = data.response?.status;
  const status = s === 'done' ? 'done' : s === 'failed' ? 'failed' : s === 'queued' ? 'queued' : 'rendering';
  return { status, url: data.response?.url || null, error: data.response?.error || null };
}

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export default async function handler(req, res) {
  // Auth: shared secret in query string
  const secret = process.env.MCP_SECRET;
  if (secret && req.query.key !== secret) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET' || req.method === 'DELETE') return res.status(405).end();
  if (req.method !== 'POST') return res.status(405).end();

  const msg = req.body;
  if (!msg || msg.jsonrpc !== '2.0') return res.status(400).json(rpcErr(null, -32600, 'Invalid request'));

  // Notifications carry no id and expect no body
  if (msg.id === undefined || msg.id === null) return res.status(202).end();

  try {
    switch (msg.method) {
      case 'initialize':
        return res.json(rpc(msg.id, {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'bedstories', version: '1.0.0' },
          instructions: 'Render Bedstories videos with Shotstack. Call render_video, then poll_render every ~10s until status is done.',
        }));
      case 'ping':
        return res.json(rpc(msg.id, {}));
      case 'tools/list':
        return res.json(rpc(msg.id, { tools: TOOLS }));
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        let out;
        if (name === 'render_video') out = await renderVideo(args);
        else if (name === 'poll_render') out = await pollRender(args);
        else if (name === 'list_library') out = await listLibrary(args);
        else return res.json(rpcErr(msg.id, -32602, `Unknown tool: ${name}`));
        return res.json(rpc(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false,
        }));
      }
      default:
        return res.json(rpcErr(msg.id, -32601, `Method not found: ${msg.method}`));
    }
  } catch (e) {
    console.error('mcp error:', e);
    // Tool failures are reported inside the result so the client sees the message
    return res.json(rpc(msg.id, {
      content: [{ type: 'text', text: e.message || String(e) }],
      isError: true,
    }));
  }
}

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };
