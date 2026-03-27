// pages/api/bedstories/image.js
// Generates a still image using fal.ai + Flux 2 Pro in 9:16 portrait for TikTok

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    const r = await fetch('https://fal.run/fal-ai/flux-pro/v1.1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.FAL_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        image_size: 'portrait_16_9', // 9:16 portrait — correct for TikTok/Reels
        num_inference_steps: 28,
        num_images: 1,
        safety_tolerance: '2',
      }),
    });

    const text = await r.text();
    console.log('fal.ai image response:', text.slice(0, 300));
    const data = JSON.parse(text);
    if (!r.ok) throw new Error(data.detail || 'fal.ai failed');

    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error('No image URL in response');
    return res.json({ imageUrl });
  } catch (e) {
    console.error('image error:', e);
    return res.status(500).json({ error: e.message });
  }
}
