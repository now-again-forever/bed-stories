// pages/api/bedstories/claude.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { system, user, max_tokens = 1000 } = req.body;
  if (!system || !user) return res.status(400).json({ error: 'Missing system or user' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Claude error');
    return res.json({ text: data.content[0].text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
