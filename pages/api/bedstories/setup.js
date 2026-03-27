// pages/api/bedstories/setup.js
// One-time setup: generates all ambient sounds + piano via ElevenLabs
// and uploads them permanently to Supabase Storage

import supabaseAdmin from '../../../lib/supabaseAdmin';

const ASSETS = [
  {
    filename: 'bs-rain.mp3',
    prompt: 'Gentle soft rain falling outdoors, steady and calm, no thunder, peaceful ambient loop',
    duration_seconds: 30,
    type: 'sfx',
  },
  {
    filename: 'bs-city.mp3',
    prompt: 'Quiet city street at night, distant traffic, occasional passing car, peaceful urban ambience',
    duration_seconds: 30,
    type: 'sfx',
  },
  {
    filename: 'bs-forest.mp3',
    prompt: 'Peaceful forest ambience, birdsong, gentle breeze through leaves, calm nature sounds',
    duration_seconds: 30,
    type: 'sfx',
  },
  {
    filename: 'bs-ocean.mp3',
    prompt: 'Calm ocean waves on a quiet beach, gentle and rhythmic, soft and soothing',
    duration_seconds: 30,
    type: 'sfx',
  },
  {
    filename: 'bs-fire.mp3',
    prompt: 'Cozy indoor fireplace crackling softly, warm and gentle, no harsh sounds',
    duration_seconds: 30,
    type: 'sfx',
  },
  {
    filename: 'bs-cafe.mp3',
    prompt: 'Quiet coffee shop ambience, soft murmur of distant conversation, gentle background noise',
    duration_seconds: 30,
    type: 'sfx',
  },
  {
    filename: 'bs-piano.mp3',
    prompt: 'Slow melancholic solo piano, gentle and peaceful, soft touch, minimal notes, sleep music',
    duration_seconds: 30,
    type: 'sfx', // Using SFX for piano too — ElevenLabs SFX handles musical ambience well
  },
];

async function assetExists(filename) {
  const { data } = supabaseAdmin.storage
    .from('bedstories-audio')
    .getPublicUrl(filename);
  const check = await fetch(data.publicUrl, { method: 'HEAD' }).catch(() => null);
  return check?.ok === true;
}

async function generateSFX(prompt, durationSeconds, apiKey) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: durationSeconds,
      prompt_influence: 0.3, // lower = more creative/ambient
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail?.message || `ElevenLabs SFX error ${res.status}`);
  }
  return await res.arrayBuffer();
}

async function uploadToSupabase(filename, buffer) {
  const { error } = await supabaseAdmin.storage
    .from('bedstories-audio')
    .upload(filename, Buffer.from(buffer), {
      contentType: 'audio/mpeg',
      cacheControl: '31536000',
      upsert: true,
    });
  if (error) throw new Error(`Upload failed for ${filename}: ${error.message}`);
  const { data } = supabaseAdmin.storage.from('bedstories-audio').getPublicUrl(filename);
  return data.publicUrl;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ELEVENLABS_API_KEY' });

  const results = [];

  for (const asset of ASSETS) {
    try {
      // Check if already exists
      const exists = await assetExists(asset.filename);
      if (exists) {
        const { data } = supabaseAdmin.storage.from('bedstories-audio').getPublicUrl(asset.filename);
        results.push({ filename: asset.filename, status: 'exists', url: data.publicUrl });
        continue;
      }

      // Generate via ElevenLabs
      console.log(`Generating: ${asset.filename}`);
      const buffer = await generateSFX(asset.prompt, asset.duration_seconds, apiKey);

      // Upload to Supabase
      const url = await uploadToSupabase(asset.filename, buffer);
      results.push({ filename: asset.filename, status: 'generated', url });
      console.log(`✓ Done: ${asset.filename}`);
    } catch (e) {
      console.error(`✗ Failed: ${asset.filename} — ${e.message}`);
      results.push({ filename: asset.filename, status: 'error', error: e.message });
    }
  }

  return res.json({ results });
}
