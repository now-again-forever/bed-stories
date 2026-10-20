// lib/bedstoriesJobs.js
//
// Background jobs for the Bedstories MCP connector: narration with exact word
// timings, and copying finished renders to permanent storage. Job state lives
// as small JSON files in the public bucket under jobs/, so no schema is needed
// and a cold serverless instance can pick up where another left off.

import supabaseAdmin from './supabaseAdmin';

export const BUCKET = 'bedstories-audio';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const publicUrl = (path) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

export const VOICES = {
  nicole: 'gc5LArFpEOmYx9nYmK9l',
  damon:  'xzZRXG86mSM3naOyL9fa',
};

// ── job store ────────────────────────────────────────────────────────────
export async function writeJob(id, data) {
  const body = Buffer.from(JSON.stringify({ ...data, id, updatedAt: new Date().toISOString() }));
  const { error } = await supabaseAdmin.storage.from(BUCKET)
    .upload(`jobs/${id}.json`, body, { contentType: 'application/json', upsert: true, cacheControl: '0' });
  if (error) throw new Error(`job write failed: ${error.message}`);
}
export async function readJob(id) {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(`jobs/${id}.json`);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
export const newId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── narration ────────────────────────────────────────────────────────────
// eleven_v3 dialogue requests have a per-request text limit, and a Bedstories
// story is ~5,000 characters. Each speaker segment is split into paragraphs,
// paragraphs are packed into requests under MAX_CHARS, and the MP3 parts are
// joined end to end. Subtitle timings come from forced alignment of the
// joined audio (below), not from the per-request timestamps.
const MAX_CHARS = 2400;

function toInputs(segments) {
  const inputs = [];
  segments.forEach((seg, si) => {
    const paras = String(seg.text || '').split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // Hard-split any single paragraph that is itself too long, at sentence ends
    for (const p of paras) {
      if (p.length <= MAX_CHARS) { inputs.push({ speaker: seg.speaker, text: p, seg: si }); continue; }
      let cur = '';
      for (const s of p.match(/[^.!?]+[.!?]+["”]?\s*|[^.!?]+$/g) || [p]) {
        if ((cur + s).length > MAX_CHARS && cur) { inputs.push({ speaker: seg.speaker, text: cur.trim(), seg: si }); cur = ''; }
        cur += s;
      }
      if (cur.trim()) inputs.push({ speaker: seg.speaker, text: cur.trim(), seg: si });
    }
  });
  return inputs;
}
function toBatches(inputs) {
  const batches = []; let cur = [], len = 0;
  for (const inp of inputs) {
    if (cur.length && len + inp.text.length > MAX_CHARS) { batches.push(cur); cur = []; len = 0; }
    cur.push(inp); len += inp.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
// Words straight from the character alignment: a word is a run of
// non-whitespace characters; it starts when its first character starts and
// ends when its last one ends.
function wordsFromAlignment(al, offset) {
  const { characters: ch = [], character_start_times_seconds: st = [], character_end_times_seconds: en = [] } = al || {};
  const words = []; let w = null;
  for (let i = 0; i < ch.length; i++) {
    if (/\s/.test(ch[i])) { if (w) { words.push(w); w = null; } continue; }
    if (!w) w = { word: '', start: (st[i] ?? 0) + offset, end: (en[i] ?? 0) + offset };
    w.word += ch[i]; w.end = (en[i] ?? w.end - offset) + offset;
  }
  if (w) words.push(w);
  return words;
}

async function dialogueRequest(batch) {
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: JSON.stringify({
      inputs: batch.map(b => ({ text: b.text, voice_id: VOICES[b.speaker] || VOICES.damon })),
      model_id: 'eleven_v3',
    }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.detail?.message || err?.detail || `ElevenLabs error ${r.status}`);
  }
  return r.json();
}

// ── real MP3 duration ────────────────────────────────────────────────────
// Walk the MPEG frame headers rather than assume a bitrate: correct for CBR,
// VBR, and parts joined end to end (each part's ID3 tag is skipped).
const BR = { 1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320], 2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160] };
const SR = { 3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000] };
export function mp3Duration(buf) {
  let i = 0, secs = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] === 0x49 && buf[i+1] === 0x44 && buf[i+2] === 0x33 && i + 10 <= buf.length) {   // "ID3"
      const size = ((buf[i+6] & 0x7f) << 21) | ((buf[i+7] & 0x7f) << 14) | ((buf[i+8] & 0x7f) << 7) | (buf[i+9] & 0x7f);
      i += 10 + size; continue;
    }
    if (buf[i] !== 0xff || (buf[i+1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (buf[i+1] >> 3) & 3, layer = (buf[i+1] >> 1) & 3, bri = buf[i+2] >> 4, sri = (buf[i+2] >> 2) & 3, pad = (buf[i+2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }   // Layer III only
    const kbps = BR[ver === 3 ? 1 : 2][bri], rate = SR[ver][sri];
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor((samples / 8) * kbps * 1000 / rate) + pad;
    if (len < 4) { i++; continue; }
    secs += samples / rate; i += len;
  }
  return secs;
}

// ── forced alignment ─────────────────────────────────────────────────────
// ElevenLabs listens to the finished audio and timestamps every word of the
// script against it. This is what the subtitles use: timings come from the
// real sound, so they cannot drift between recording parts.
async function forcedAlign(audio, text) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'narration.mp3');
  form.append('text', text);
  const r = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
    method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.detail?.message || err?.detail || `forced alignment error ${r.status}`);
  }
  const d = await r.json();
  const words = (d.words || [])
    .map(w => ({ word: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.word && isFinite(w.start) && isFinite(w.end));
  if (!words.length) throw new Error('forced alignment returned no words');
  return { words, characters: d.characters || [], loss: d.loss ?? null };
}

// The script exactly as it is sent for alignment, and where the story body
// (the second Damon segment, after "What story would you like to hear?") starts in it.
function scriptOf(segments) {
  const inputs = toInputs(segments);
  const text = inputs.map(x => x.text).join('\n');
  const damonSegs = [...new Set(inputs.filter(x => x.speaker === 'damon').map(x => x.seg))];
  const bodySeg = damonSegs[1] ?? damonSegs[0];
  let off = 0, bodyChar = 0, bodyWord = 0, words = 0;
  for (const x of inputs) {
    if (x.seg === bodySeg) { bodyChar = off; bodyWord = words; break; }
    off += x.text.length + 1; words += x.text.split(/\s+/).filter(Boolean).length;
  }
  return { inputs, text, bodyChar, bodyWord };
}

async function alignAndFinish(jobId, audio, segments, extra = {}) {
  const { text, bodyChar, bodyWord } = scriptOf(segments);
  const duration = mp3Duration(audio);
  await writeJob(jobId, { kind: 'narration', status: 'running', progress: 'aligning subtitles to the audio', ...extra });
  const fa = await forcedAlign(audio, text);
  // Piano cue: the body's first character, if the character list lines up with
  // the script; otherwise its first word by count.
  let damonStartTime = null;
  if (fa.characters.length === text.length && fa.characters[bodyChar]) damonStartTime = Number(fa.characters[bodyChar].start);
  if (!isFinite(damonStartTime)) damonStartTime = fa.words[Math.min(bodyWord, fa.words.length - 1)]?.start ?? 0;
  return {
    kind: 'narration', status: 'done', alignment: 'forced',
    duration: Number(duration.toFixed(3)), damonStartTime: Number(damonStartTime.toFixed(3)),
    wordCount: fa.words.length, words: fa.words, alignmentLoss: fa.loss, ...extra,
  };
}

export async function runNarration(jobId, segments) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set on Vercel');
    const { inputs } = scriptOf(segments);
    const batches = toBatches(inputs);
    const buffers = [];
    for (let b = 0; b < batches.length; b++) {
      await writeJob(jobId, { kind: 'narration', status: 'running', progress: `recording part ${b + 1} of ${batches.length}` });
      const { audio_base64 } = await dialogueRequest(batches[b]);
      buffers.push(Buffer.from(audio_base64, 'base64'));
    }
    const audio = Buffer.concat(buffers);
    const path = `narration/${jobId}.mp3`;
    const { error } = await supabaseAdmin.storage.from(BUCKET)
      .upload(path, audio, { contentType: 'audio/mpeg', upsert: true, cacheControl: '31536000' });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);
    const audioUrl = publicUrl(path);
    const parts = buffers.map(b => Number(mp3Duration(b).toFixed(3)));
    await writeJob(jobId, await alignAndFinish(jobId, audio, segments, { audioUrl, parts }));
  } catch (e) {
    await writeJob(jobId, { kind: 'narration', status: 'failed', error: e.message || String(e) }).catch(() => {});
  }
}

// Re-time an existing recording without re-recording it (no TTS credits spent).
export async function runRealign(jobId, audioUrl, segments) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set on Vercel');
    const r = await fetch(audioUrl);
    if (!r.ok) throw new Error(`could not fetch the narration (${r.status})`);
    const audio = Buffer.from(await r.arrayBuffer());
    await writeJob(jobId, await alignAndFinish(jobId, audio, segments, { audioUrl, realigned: true }));
  } catch (e) {
    await writeJob(jobId, { kind: 'narration', status: 'failed', error: e.message || String(e) }).catch(() => {});
  }
}

// ── keep the finished render ─────────────────────────────────────────────
export async function runSaveRender(renderId, shotstackUrl) {
  const jobId = `render-${renderId}`;
  try {
    const r = await fetch(shotstackUrl);
    if (!r.ok) throw new Error(`download from Shotstack failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const path = `final/bedstory-${renderId}.mp4`;
    const { error } = await supabaseAdmin.storage.from(BUCKET)
      .upload(path, buf, { contentType: 'video/mp4', upsert: true, cacheControl: '31536000' });
    if (error) throw new Error(`Supabase upload failed (${(buf.length / 1e6).toFixed(1)} MB): ${error.message}`);
    await writeJob(jobId, { kind: 'render', status: 'done', url: publicUrl(path), bytes: buf.length, shotstackUrl });
  } catch (e) {
    // Keep the temporary Shotstack link so nothing is lost; flag why it isn't permanent.
    await writeJob(jobId, { kind: 'render', status: 'done', url: shotstackUrl, temporary: true, saveError: e.message || String(e), shotstackUrl }).catch(() => {});
  }
}
