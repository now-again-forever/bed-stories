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
// paragraphs are packed into requests under MAX_CHARS, and the MP3s are
// joined end to end. ElevenLabs returns 128 kbps CBR MP3, so each part's real
// length is bytes × 8 / 128000 — that, not the last character's timestamp, is
// what offsets the next part, so timings never drift across joins.
const MAX_CHARS = 2400;
const MP3_BITRATE = 128000;

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

export async function runNarration(jobId, segments) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set on Vercel');
    const inputs = toInputs(segments);
    const batches = toBatches(inputs);
    const buffers = []; const words = []; let offset = 0;
    // Where (in words) does each input begin? Used to place the piano cue.
    const inputWordStart = []; let wi = 0;

    for (let b = 0; b < batches.length; b++) {
      await writeJob(jobId, { kind: 'narration', status: 'running', progress: `${b + 1}/${batches.length}` });
      const { audio_base64, alignment } = await dialogueRequest(batches[b]);
      const buf = Buffer.from(audio_base64, 'base64');
      // The alignment is the inputs' texts concatenated with NO separator, so a
      // turn ending "story." runs straight into "What…". Cut it at each input's
      // exact character range so words never fuse across speaker turns.
      const total = (alignment?.characters || []).length;
      const expected = batches[b].reduce((a, x) => a + x.text.length, 0);
      if (total === expected) {
        let pos = 0;
        for (const inp of batches[b]) {
          const n = inp.text.length;
          const part = {
            characters: alignment.characters.slice(pos, pos + n),
            character_start_times_seconds: alignment.character_start_times_seconds.slice(pos, pos + n),
            character_end_times_seconds: alignment.character_end_times_seconds.slice(pos, pos + n),
          };
          inputWordStart.push({ seg: inp.seg, speaker: inp.speaker, word: words.length });
          words.push(...wordsFromAlignment(part, offset));
          pos += n;
        }
      } else {
        // Unexpected shape: fall back to whole-batch words (may fuse at turns)
        for (const inp of batches[b]) { inputWordStart.push({ seg: inp.seg, speaker: inp.speaker, word: wi }); wi += inp.text.split(/\s+/).filter(Boolean).length; }
        words.push(...wordsFromAlignment(alignment, offset));
      }
      wi = words.length;
      buffers.push(buf);
      offset += (buf.length * 8) / MP3_BITRATE;
    }

    const audio = Buffer.concat(buffers);
    const path = `narration/${jobId}.mp3`;
    const { error } = await supabaseAdmin.storage.from(BUCKET)
      .upload(path, audio, { contentType: 'audio/mpeg', upsert: true, cacheControl: '31536000' });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);

    // Piano enters at the start of the second Damon segment (the story body,
    // after "What story would you like to hear?").
    const damonSegs = [...new Set(inputWordStart.filter(x => x.speaker === 'damon').map(x => x.seg))];
    const bodySeg = damonSegs[1] ?? damonSegs[0];
    const firstWord = inputWordStart.find(x => x.seg === bodySeg)?.word ?? 0;
    const damonStartTime = words[Math.min(firstWord, words.length - 1)]?.start ?? 0;

    await writeJob(jobId, {
      kind: 'narration', status: 'done',
      audioUrl: publicUrl(path), duration: Number(offset.toFixed(3)),
      damonStartTime: Number(damonStartTime.toFixed(3)),
      wordCount: words.length, words,
    });
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
