// pages/bedstories/setup.jsx
// Run once to generate all ambient sounds and piano via ElevenLabs
// and upload them permanently to Supabase

import { useState } from 'react';

const ASSETS = [
  { filename: 'bs-piano.mp3',  label: 'Piano backdrop',     icon: '🎹' },
  { filename: 'bs-rain.mp3',   label: 'Rain',               icon: '🌧' },
  { filename: 'bs-city.mp3',   label: 'City at night',      icon: '🌆' },
  { filename: 'bs-forest.mp3', label: 'Forest & birds',     icon: '🌲' },
  { filename: 'bs-ocean.mp3',  label: 'Ocean waves',        icon: '🌊' },
  { filename: 'bs-fire.mp3',   label: 'Fireplace',          icon: '🔥' },
  { filename: 'bs-cafe.mp3',   label: 'Soft café',          icon: '☕' },
];

export default function BedstoriesSetup() {
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [results, setResults] = useState([]);
  const [err, setErr] = useState(null);

  const run = async () => {
    setStatus('running');
    setErr(null);
    setResults([]);
    try {
      const res = await fetch('/api/bedstories/setup', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Setup failed');
      setResults(data.results);
      setStatus('done');
    } catch (e) {
      setErr(e.message);
      setStatus('error');
    }
  };

  const statusColor = s => ({ generated: '#7A9E7E', exists: '#D4A843', error: '#C4714A' }[s] || '#9A7A65');
  const statusLabel = s => ({ generated: '✓ Generated & uploaded', exists: '✓ Already exists', error: '✗ Failed' }[s] || '');

  return (
    <div style={{ minHeight: '100vh', background: '#FAF7F2', fontFamily: 'Georgia, serif', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 24, fontWeight: 600, color: '#2A1A0E', marginBottom: 8 }}>
            Bedstories — Audio Setup
          </div>
          <div style={{ fontSize: 14, color: '#9A7A65', lineHeight: 1.7 }}>
            This runs <strong>once</strong> to generate all ambient sounds and the piano backdrop using ElevenLabs, then uploads them permanently to your Supabase bucket. After this, rendering videos requires no external audio sources.
          </div>
        </div>

        {/* Asset list */}
        <div style={{ background: 'white', borderRadius: 14, border: '1px solid #EDE4D9', marginBottom: 24, overflow: 'hidden' }}>
          {ASSETS.map((asset, i) => {
            const result = results.find(r => r.filename === asset.filename);
            return (
              <div key={asset.filename} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: i < ASSETS.length - 1 ? '1px solid #F0E8DF' : 'none' }}>
                <span style={{ fontSize: 20 }}>{asset.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: '#2A1A0E', fontWeight: 500 }}>{asset.label}</div>
                  <div style={{ fontSize: 11, color: '#9A7A65', marginTop: 2 }}>{asset.filename}</div>
                </div>
                {result && (
                  <div style={{ fontSize: 12, color: statusColor(result.status), fontWeight: 500 }}>
                    {statusLabel(result.status)}
                  </div>
                )}
                {!result && status === 'running' && (
                  <div style={{ fontSize: 12, color: '#C4A882' }}>Waiting…</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Note about cost */}
        <div style={{ padding: '12px 16px', background: '#FFF8EC', border: '1px solid #D4A84344', borderRadius: 10, marginBottom: 24, fontSize: 12, color: '#6B4F3A', lineHeight: 1.7 }}>
          <strong>Cost:</strong> 7 × 30 seconds = 210 seconds of ElevenLabs sound generation. On the Creator plan this uses roughly 8,400 credits (about $0.84). Runs once, stored permanently.
        </div>

        {err && (
          <div style={{ padding: '12px 16px', background: '#FDF0EE', border: '1px solid #E8B4B0', borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#A05555' }}>
            ⚠ {err}
          </div>
        )}

        {status === 'done' && (
          <div style={{ padding: '12px 16px', background: '#F0F7F2', border: '1px solid #7A9E7E44', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#3D6B4A' }}>
            ✓ All assets ready. You can now render videos with ambient sound and piano.{' '}
            <a href="/bedstories" style={{ color: '#3D6B4A', fontWeight: 600 }}>Go to Production Hub →</a>
          </div>
        )}

        <button
          onClick={run}
          disabled={status === 'running'}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: status === 'running' ? '#D4B89A' : '#C4714A', color: 'white', fontSize: 14, fontWeight: 600, cursor: status === 'running' ? 'not-allowed' : 'pointer', fontFamily: 'Georgia, serif', boxShadow: '0 2px 8px #C4714A33' }}
        >
          {status === 'running' ? 'Generating… this takes about 2 minutes' : status === 'done' ? 'Run Again' : 'Generate All Audio Assets'}
        </button>

        <div style={{ marginTop: 16, fontSize: 11, color: '#9A7A65', textAlign: 'center' }}>
          Only run this once. Files already in Supabase will be skipped automatically.
        </div>
      </div>
    </div>
  );
}
