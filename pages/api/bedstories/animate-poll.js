// pages/api/bedstories/animate-poll.js
import supabaseAdmin from '../../../lib/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { requestId } = req.query;
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

  try {
    const r = await fetch(
      `https://queue.fal.run/fal-ai/kling-video/requests/${requestId}/status`,
      { headers: { 'Authorization': `Key ${process.env.FAL_KEY}` } }
    );
    const data = await r.json();

    if (data.status === 'COMPLETED') {
      // Fetch the result
      const resultRes = await fetch(
        `https://queue.fal.run/fal-ai/kling-video/requests/${requestId}`,
        { headers: { 'Authorization': `Key ${process.env.FAL_KEY}` } }
      );
      const result = await resultRes.json();
      const tempVideoUrl = result.video?.url;
      if (!tempVideoUrl) throw new Error('No video URL in result');

      // Download the video from fal.ai
      const videoRes = await fetch(tempVideoUrl);
      if (!videoRes.ok) throw new Error('Failed to download video from fal.ai');
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // Upload to Supabase Storage for a permanent public URL
      const filename = `bedstory-video-${Date.now()}.mp4`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from('bedstories-audio')
        .upload(filename, videoBuffer, {
          contentType: 'video/mp4',
          cacheControl: '3600',
          upsert: false,
        });
      if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

      const { data: urlData } = supabaseAdmin.storage
        .from('bedstories-audio')
        .getPublicUrl(filename);

      return res.json({ status: 'done', videoUrl: urlData.publicUrl });
    }

    if (data.status === 'FAILED') {
      return res.json({ status: 'failed', error: 'Video generation failed' });
    }

    return res.json({ status: 'processing' });
  } catch (e) {
    console.error('animate-poll error:', e);
    return res.status(500).json({ error: e.message });
  }
}