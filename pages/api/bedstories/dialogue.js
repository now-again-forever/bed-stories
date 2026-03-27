// pages/api/bedstories/dialogue.js
import supabaseAdmin from '../../../lib/supabaseAdmin';

const VOICES = {
  nicole: 'gc5LArFpEOmYx9nYmK9l',
  damon: 'xzZRXG86mSM3naOyL9fa',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { segments } = req.body;
  if (!segments?.length) return res.status(400).json({ error: 'Missing segments' });

  try {
    const elevenRes = await fetch(
      'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          inputs: segments.map(s => ({ text: s.text, voice_id: VOICES[s.speaker] })),
          model_id: 'eleven_v3',
        }),
      }
    );

    if (!elevenRes.ok) {
      const err = await elevenRes.json().catch(() => ({}));
      throw new Error(err?.detail?.message || `ElevenLabs error ${elevenRes.status}`);
    }

    const { audio_base64, alignment } = await elevenRes.json();
    const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;

    // Upload audio to Supabase Storage
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    const filename = `bedstory-${Date.now()}.mp3`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('bedstories-audio')
      .upload(filename, audioBuffer, {
        contentType: 'audio/mpeg',
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    const { data: urlData } = supabaseAdmin.storage
      .from('bedstories-audio')
      .getPublicUrl(filename);

    // Convert character alignment to word timings
    const fullText = segments.map(s => s.text).join(' ');
    const wordTimings = charToWords(fullText, characters, starts, ends);
    const audioDuration = ends.at(-1) + 0.5;

    // Find when Damon's narration starts (after Nicole's segments)
    const nicoleText = segments
      .filter(s => s.speaker === 'nicole')
      .map(s => s.text)
      .join(' ');
    const nicoleCharCount = nicoleText.length;
    const damonStartTime = starts[Math.min(nicoleCharCount + 1, starts.length - 1)] ?? 0;

    return res.json({ audioUrl: urlData.publicUrl, wordTimings, audioDuration, damonStartTime });
  } catch (e) {
    console.error('dialogue error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function charToWords(fullText, chars, starts, ends) {
  const words = [];
  let ci = 0;
  for (const token of fullText.split(/(\s+)/)) {
    if (!token.trim()) { ci += token.length; continue; }
    const wordStart = starts[ci] ?? 0;
    const wordEnd = ends[Math.min(ci + token.length - 1, ends.length - 1)] ?? wordStart + 0.3;
    words.push({ word: token, start: wordStart, end: wordEnd });
    ci += token.length;
  }
  return words;
}

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };
