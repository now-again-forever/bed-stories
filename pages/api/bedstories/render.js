// pages/api/bedstories/render.js

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const BUCKET = 'bedstories-audio';

// Add a cache-busting query string so Shotstack always fetches fresh from Supabase
// and never serves a stale cached version of replaced files
function assetUrl(filename) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

const SOUND_FILE = {
  'Rain':           'bs-rain.mp3',
  'City at night':  'bs-city.mp3',
  'Forest & birds': 'bs-forest.mp3',
  'Ocean waves':    'bs-ocean.mp3',
  'Fireplace':      'bs-fire.mp3',
  'Soft café':      'bs-cafe.mp3',
};

// Duration of each ambient SFX clip from ElevenLabs (30s each)
const AMBIENT_CLIP_DURATION = 30;

// Piano fades out this many seconds before the video ends
const PIANO_FADE_BUFFER = 4;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const {
    videoUrl,
    audioUrl,
    audioDuration,
    sound,
    outputFormat,
    damonStartTime = 0,
    cropWatermark = false,
  } = req.body;

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing videoUrl or audioUrl' });
  }

  const totalDuration = Number(audioDuration) || 360;
  const damonStart    = Number(damonStartTime) || 0;

  // Piano: starts when Damon begins narrating, fades out before the end
  const pianoStart    = damonStart;
  const pianoEnd      = Math.max(totalDuration - PIANO_FADE_BUFFER, pianoStart + 1);
  const pianoDuration = pianoEnd - pianoStart;

  // Always bust Shotstack's cache so replaced files are always fresh
  const pianoUrl   = assetUrl('bs-piano-v2.mp3');
  const ambientUrl = assetUrl(SOUND_FILE[sound] || 'bs-rain.mp3');

  console.log('=== Render ===');
  console.log(`Total duration : ${totalDuration}s`);
  console.log(`Piano          : ${pianoStart.toFixed(2)}s → ${pianoEnd.toFixed(2)}s (${pianoDuration.toFixed(2)}s)`);
  console.log(`Sound          : ${sound}`);
  console.log(`Crop watermark : ${cropWatermark}`);

  const size = outputFormat === 'horizontal'
    ? { width: 1920, height: 1080 }
    : { width: 1080, height: 1920 };

  // ── Video clips — 5s hard cuts, muted ───────────────────────────────────
  const VIDEO_CLIP = 5;
  const videoClips = [];
  let t = 0;
  while (t < totalDuration) {
    const len = Math.min(VIDEO_CLIP, totalDuration - t);
    videoClips.push({
      asset: { type: 'video', src: videoUrl, trim: 0, volume: 0 },
      start: t,
      length: len,
      fit: 'cover',
      ...(cropWatermark ? { scale: 1.15 } : {}),
    });
    t += len;
  }

  // ── Narration — full duration ────────────────────────────────────────────
  const narrationTrack = {
    clips: [{
      asset: { type: 'audio', src: audioUrl, volume: 1.0, effect: 'fadeInFadeOut' },
      start: 0,
      length: totalDuration,
    }],
  };

  // ── Piano — tile clips to cover full narration duration ─────────────────
  const PIANO_CLIP_DURATION = 188; // 3:08 — matches the piano file length
  const pianoClips = [];
  let pt = pianoStart;
  while (pt < pianoEnd) {
    const len     = Math.min(PIANO_CLIP_DURATION, pianoEnd - pt);
    const isFirst = pt === pianoStart;
    const isLast  = pt + len >= pianoEnd;
    const effect  = isFirst && isLast ? 'fadeInFadeOut'
                  : isFirst           ? 'fadeIn'
                  : isLast            ? 'fadeOut'
                  :                     'none';
    pianoClips.push({
      asset: { type: 'audio', src: pianoUrl, volume: 0.12, effect },
      start: pt,
      length: len,
    });
    pt += len;
  }
  const pianoTrack = { clips: pianoClips };

  // ── Ambient — tile 30s clips to cover full duration ─────────────────────
  // Fade in on first clip, fade out on last, straight through in between
  const ambientClips = [];
  let at = 0;
  while (at < totalDuration) {
    const len     = Math.min(AMBIENT_CLIP_DURATION, totalDuration - at);
    const isFirst = at === 0;
    const isLast  = at + len >= totalDuration;
    const effect  = isFirst && isLast ? 'fadeInFadeOut'
                  : isFirst           ? 'fadeIn'
                  : isLast            ? 'fadeOut'
                  :                     'none';
    ambientClips.push({
      asset: { type: 'audio', src: ambientUrl, volume: 0.15, effect },
      start: at,
      length: len,
    });
    at += len;
  }
  const ambientTrack = { clips: ambientClips };

  console.log(`Video clips  : ${videoClips.length}`);
  console.log(`Ambient clips: ${ambientClips.length} × ~${AMBIENT_CLIP_DURATION}s`);

  const payload = {
    timeline: {
      tracks: [
        narrationTrack,
        pianoTrack,
        ambientTrack,
        { clips: videoClips },
      ],
    },
    output: { format: 'mp4', size },
  };

  try {
    const r = await fetch('https://api.shotstack.io/v1/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.SHOTSTACK_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    console.log('Shotstack response:', JSON.stringify(data));
    if (!data.success) throw new Error(JSON.stringify(data.response || data.message || data));
    return res.json({ renderId: data.response.id });
  } catch (e) {
    console.error('Render error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
