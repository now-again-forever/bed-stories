// pages/api/bedstories/animate.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { imageUrl } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

  try {
    const r = await fetch('https://queue.fal.run/fal-ai/kling-video/v1.6/standard/image-to-video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.FAL_KEY}`,
      },
      body: JSON.stringify({
        image_url: imageUrl,
        prompt: 'Completely still and silent scene. No movement at all except the most imperceptible gentle breathing of the animal — chest rising and falling by one pixel only. No camera movement. No steam. No smoke. No flickering. No ripples. No sound. Frozen in time like a photograph. The first and last frame must be identical for a perfect seamless loop.',
        negative_prompt: 'steam, smoke, fire, flickering, ripples, waves, shaking, vibrating, flowing, camera movement, zoom, pan, motion, audio, music, sound',
        duration: '5',
        aspect_ratio: '9:16',
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    return res.json({ requestId: data.request_id });
  } catch (e) {
    console.error('animate error:', e);
    return res.status(500).json({ error: e.message });
  }
}
