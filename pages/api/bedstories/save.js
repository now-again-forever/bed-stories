// pages/api/bedstories/save.js
import supabaseAdmin from '../../../lib/supabaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { id, ...fields } = req.body;

  try {
    if (id) {
      const { data, error } = await supabaseAdmin
        .from('bedstories')
        .update(fields)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ record: data });
    } else {
      const { data, error } = await supabaseAdmin
        .from('bedstories')
        .insert(fields)
        .select()
        .single();
      if (error) throw error;
      return res.json({ record: data });
    }
  } catch (e) {
    console.error('save error:', e);
    return res.status(500).json({ error: e.message });
  }
}
