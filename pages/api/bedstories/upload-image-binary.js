// pages/api/bedstories/upload-image-binary.js
// Accepts a multipart form upload (raw binary) — much smaller than base64
// Uses server-side Supabase admin key so no auth issues

import { IncomingForm } from 'formidable';
import fs from 'fs';
import supabaseAdmin from '../../../lib/supabaseAdmin';

export const config = {
  api: { bodyParser: false }, // required for formidable
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const form = new IncomingForm({ maxFileSize: 20 * 1024 * 1024 });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: err.message });

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const buffer = fs.readFileSync(file.filepath);
      const filename = `bs-upload-${Date.now()}.jpg`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from('bedstories-audio')
        .upload(filename, buffer, {
          contentType: file.mimetype || 'image/jpeg',
          cacheControl: '3600',
          upsert: true,
        });

      if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

      const { data } = supabaseAdmin.storage
        .from('bedstories-audio')
        .getPublicUrl(filename);

      return res.json({ url: data.publicUrl });
    } catch (e) {
      console.error('upload-image-binary error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });
}
