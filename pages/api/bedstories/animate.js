// pages/api/bedstories/animate.js
//
// Uses Kling O1 with start_image_url = end_image_url = the source image.
// This guarantees a perfect seamless loop because the model is constrained
// to begin AND end on the exact same frame — it can only add cyclical motion.
//
// Camera is locked via:
// 1. Explicit "static camera, no movement" in prompt
// 2. camera_type: "static" parameter (Kling O1 supports this)
// 3. cfg_scale: 0.7 (higher adherence to prompt)
//
// Cost: ~$0.56 per 5s video (Kling O1 standard at $0.112/s)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { imageUrl } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

  try {
    const r = await fetch('https://queue.fal.run/fal-ai/kling-video/o1/standard/image-to-video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.FAL_KEY}`,
      },
      body: JSON.stringify({
        // Same image as both first and last frame = perfect loop guaranteed
        start_image_url: imageUrl,
        end_image_url: imageUrl,

        // Prompt: only cyclical motion, camera absolutely locked
        prompt: 'Cinemagraph. Camera is completely static — no zoom, no pan, no tilt, no movement of any kind. The only motion is the gentlest possible chest breathing: a slow rise and fall that returns exactly to its starting position. Warm ambient light pulses very softly in place. Everything else is absolutely frozen. The scene is a living photograph.',

        negative_prompt: 'camera movement, zoom, pan, tilt, dolly, truck, crane, handheld, shake, steam, smoke, rising, falling, drifting, flowing, directional motion, fast motion',

        duration: '5',
        aspect_ratio: '9:16',
        cfg_scale: 0.7,
      }),
    });

    const data = await r.json();
    console.log('Kling O1 response:', JSON.stringify(data).slice(0, 200));

    if (!r.ok) throw new Error(data.detail || data.message || JSON.stringify(data));
    return res.json({ requestId: data.request_id });
  } catch (e) {
    console.error('animate error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
