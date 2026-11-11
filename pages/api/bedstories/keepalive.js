// pages/api/bedstories/keepalive.js
//
// Called once a day by Vercel Cron (see vercel.json). Supabase free projects
// pause after about a week with no activity, which silently breaks narration,
// the library, the piano/ambient tracks and saved renders. One small storage
// query a day keeps the project awake.
import supabaseAdmin from '../../../lib/supabaseAdmin';

export default async function handler(req, res) {
  const { data, error } = await supabaseAdmin.storage.from('bedstories-audio').list('', { limit: 1 });
  if (error) return res.status(503).json({ ok: false, error: error.message });
  return res.status(200).json({ ok: true, at: new Date().toISOString(), seen: data?.length ?? 0 });
}
