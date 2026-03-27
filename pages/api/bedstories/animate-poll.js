// pages/api/bedstories/animate-poll.js
import supabaseAdmin from '../../../lib/supabaseAdmin';

// fal.ai uses a GENERIC queue path for all models:
// https://queue.fal.run/fal-ai/kling-video/requests/{id}/status
// The model-specific path in the URL does NOT work for polling.

const FAL_QUEUE_BASE = 'https://queue.fal.run/fal-ai/kling-video/requests';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { requestId } = req.query;
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

  try {
    // Poll status using the generic queue path
    const statusRes = await fetch(`${FAL_QUEUE_BASE}/${requestId}/status`, {
      headers: { 'Authorization': `Key ${process.env.FAL_KEY}` },
    });

    if (!statusRes.ok) {
      const text = await statusRes.text();
      throw new Error(`fal.ai status error ${statusRes.status}: ${text.slice(0, 200)}`);
    }

    const statusData = await statusRes.json();
    console.log(`Poll ${requestId}: ${statusData.status}`);

    if (statusData.status === 'COMPLETED') {
      // Fetch result using the same generic path (without /status)
      const resultRes = await fetch(`${FAL_QUEUE_BASE}/${requestId}`, {
        headers: { 'Authorization': `Key ${process.env.FAL_KEY}` },
      });
      if (!resultRes.ok) {
        const text = await resultRes.text();
        throw new Error(`fal.ai result error ${resultRes.status}: ${text.slice(0, 200)}`);
      }
      const result = await resultRes.json();
      const tempVideoUrl = result.video?.url;
      if (!tempVideoUrl) throw new Error('No video URL in fal.ai result');

      // Download and re-upload to Supabase for a permanent public URL
      console.log('Downloading video from fal.ai...');
      const videoRes = await fetch(tempVideoUrl);
      if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

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

      console.log(`✓ Video uploaded: ${urlData.publicUrl}`);
      return res.json({ status: 'done', videoUrl: urlData.publicUrl });
    }

    if (statusData.status === 'FAILED') {
      return res.json({ status: 'failed', error: 'Video generation failed on fal.ai' });
    }

    // Still processing (IN_QUEUE or IN_PROGRESS)
    return res.json({ status: 'processing' });

  } catch (e) {
    console.error('animate-poll error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
