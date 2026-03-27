// pages/api/bedstories/render.js

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const BUCKET = 'bedstories-audio';

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

  // Always cast to proper numbers — localStorage JSON can deserialise as strings
  const totalDuration = Number(audioDuration) || 360;
  const damonStart   = Number(damonStartTime) || 0;
  const pianoDuration = Math.max(totalDuration - damonStart, 1);

  const pianoUrl   = assetUrl('bs-piano.mp3');
  const ambientUrl = assetUrl(SOUND_FILE[sound] || 'bs-rain.mp3');

  console.log('=== Render payload ===');
  console.log('Total duration :', totalDuration, 's');
  console.log('Damon starts at:', damonStart, 's');
  console.log('Piano duration :', pianoDuration, 's');
  console.log('Narration URL  :', audioUrl);
  console.log('Piano URL      :', pianoUrl);
  console.log('Ambient URL    :', ambientUrl);
  console.log('Video URL      :', videoUrl);
  console.log('Crop watermark :', cropWatermark);

  const size = outputFormat === 'horizontal'
    ? { width: 1920, height: 1080 }
    : { width: 1080, height: 1920 };

  // ── Video clips ──────────────────────────────────────────────────────────
  // The fal.ai video is 5s. We repeat it in 5s chunks — hard cuts only,
  // no fade transitions (they cause black flashes).
  // volume: 0 removes any audio track baked into the fal.ai video.
  // scale: 1.15 when cropWatermark is on — zooms in enough to hide corner watermarks.
  const VIDEO_CLIP = 5; // matches fal.ai output length exactly
  const videoClips = [];
  let t = 0;
  while (t < totalDuration) {
    const len = Math.min(VIDEO_CLIP, totalDuration - t);
    videoClips.push({
      asset: {
        type: 'video',
        src: videoUrl,
        trim: 0,
        volume: 0,          // ← mute fal.ai soundtrack entirely
      },
      start: t,
      length: len,
      fit: 'cover',
      ...(cropWatermark ? { scale: 1.15 } : {}),
    });
    t += len;
  }

  // ── Audio tracks ─────────────────────────────────────────────────────────
  // Three separate tracks so volumes are independent and clearly logged.
  const narrationTrack = {
    clips: [{
      asset: { type: 'audio', src: audioUrl, volume: 1.0, effect: 'fadeInFadeOut' },
      start: 0,
      length: totalDuration,
    }],
  };

  const pianoTrack = {
    clips: [{
      asset: { type: 'audio', src: pianoUrl, volume: 0.18, effect: 'fadeInFadeOut' },
      start: damonStart,
      length: pianoDuration,
    }],
  };

  const ambientTrack = {
    clips: [{
      asset: { type: 'audio', src: ambientUrl, volume: 0.15, effect: 'fadeInFadeOut' },
      start: 0,
      length: totalDuration,
    }],
  };

  const videoTrack = { clips: videoClips };

  const payload = {
    timeline: {
      tracks: [
        narrationTrack,
        pianoTrack,
        ambientTrack,
        videoTrack,
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

    if (!data.success) {
      throw new Error(JSON.stringify(data.response || data.message || data));
    }

    return res.json({ renderId: data.response.id });
  } catch (e) {
    console.error('Render error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
