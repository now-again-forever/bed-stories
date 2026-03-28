// pages/api/bedstories/upload-image.js
// Accepts a base64 data URL, uploads to Supabase, returns a public URL
// Needed when user uploads their own image (e.g. from Nano Banana)

import supabaseAdmin from '../../../lib/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'Missing dataUrl' });

  try {
    // Parse the base64 data URL
    const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid data URL format');
    const mimeType = matches[1];
    const base64Data = matches[2];
    const ext = mimeType.split('/')[1] || 'jpg';

    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `bs-upload-${Date.now()}.${ext}`;

    const { error } = await supabaseAdmin.storage
      .from('bedstories-audio') // reuse the same bucket
      .upload(filename, buffer, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: false,
      });
    if (error) throw new Error(`Upload failed: ${error.message}`);

    const { data } = supabaseAdmin.storage
      .from('bedstories-audio')
      .getPublicUrl(filename);

    return res.json({ url: data.publicUrl });
  } catch (e) {
    console.error('upload-image error:', e);
    return res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };