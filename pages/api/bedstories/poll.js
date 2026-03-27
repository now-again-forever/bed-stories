// pages/api/bedstories/poll.js
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  try {
    const r = await fetch(`https://api.shotstack.io/v1/render/${id}`, {
      headers: { 'x-api-key': process.env.SHOTSTACK_API_KEY },
    });
    const text = await r.text();
    console.log('Shotstack poll raw:', text);
    const data = JSON.parse(text);
    if (!data.success) throw new Error('Poll failed');
    const status = data.response?.status;
    const url = data.response?.url;
    console.log('Shotstack poll:', status, url);
    if (status === 'done') return res.json({ status: 'done', url });
    if (status === 'failed') return res.json({ status: 'failed', url: null });
    return res.json({ status: 'rendering', url: null });
  } catch (e) {
    console.error('poll error:', e);
    return res.status(500).json({ error: e.message });
  }
}