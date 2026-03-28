// pages/bedstories/index.jsx
import { useState, useEffect, useRef } from 'react';

/* ─────────────────────────────────────────────────────────────
   API
───────────────────────────────────────────────────────────── */
async function post(path, body) {
  const r = await fetch(`/api/bedstories/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `${path} failed`);
  return d;
}

async function get(path) {
  const r = await fetch(`/api/bedstories/${path}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `${path} failed`);
  return d;
}

async function claude(system, user, max_tokens = 1000) {
  const d = await post('claude', { system, user, max_tokens });
  return d.text;
}

// Measure the real duration of an audio file from its URL
function getRealAudioDuration(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.addEventListener('loadedmetadata', () => resolve(audio.duration));
    audio.addEventListener('error', () => resolve(null));
    audio.src = url;
  });
}

/* ─────────────────────────────────────────────────────────────
   PERSIST — localStorage with proper number/null handling
───────────────────────────────────────────────────────────── */
function usePersist(key, initial) {
  const [val, setVal] = useState(initial);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const s = localStorage.getItem(`bs_${key}`);
      if (s !== null) setVal(JSON.parse(s));
    } catch {}
    setMounted(true);
  }, [key]);

  useEffect(() => {
    if (!mounted) return;
    try { localStorage.setItem(`bs_${key}`, JSON.stringify(val)); } catch {}
  }, [key, val, mounted]);

  return [val, setVal];
}

/* ─────────────────────────────────────────────────────────────
   STORY SEGMENTER
───────────────────────────────────────────────────────────── */
function parseSegments(story) {
  if (!story) return [];
  const segs = [];
  let cur = null;
  let acc = [];
  const flush = () => {
    if (cur && acc.join('').trim()) {
      segs.push({ speaker: cur, text: acc.join('\n').trim() });
    }
    acc = [];
  };
  for (const line of story.split('\n')) {
    const t = line.trim();
    const isNicole = /^"/.test(t) && (
      /tell me a story/i.test(t) ||
      /the one about/i.test(t) ||
      /^"damon,/i.test(t)
    );
    const spk = isNicole ? 'nicole' : 'damon';
    if (!cur) cur = spk;
    if (spk !== cur) { flush(); cur = spk; }
    acc.push(line);
  }
  flush();
  return segs;
}

/* ─────────────────────────────────────────────────────────────
   FORMAT HELPERS
───────────────────────────────────────────────────────────── */
function fmtDur(d) {
  const n = Number(d);
  if (!n || !isFinite(n)) return '—';
  return `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
}
function wc(t) { return t ? t.split(/\s+/).filter(Boolean).length : 0; }

/* ─────────────────────────────────────────────────────────────
   PROMPTS
───────────────────────────────────────────────────────────── */
const SYS = {

  imagePrompt: `You write image generation prompts for Bedstories — a cozy sleep content brand for adults.

The image shows a small anthropomorphic felt animal — a lovingly hand-crafted needle-felted puppet sitting upright like a person in a miniature felt world — wearing headphones and listening to a bedtime story. The animal and every single object in the scene is made of felt and wool. The animal is the star — cute, warm, irresistibly cosy.

ALWAYS include ALL of these:

HANDMADE FELT WORLD — THIS IS THE MOST IMPORTANT PART:
- The ENTIRE scene is built from needle-felted wool and felt fabric — the animal, the furniture, the walls, the floor, every single object
- This is stop-motion animation aesthetic — like Coraline or Isle of Dogs but cozier and softer
- Every surface shows felt texture: visible wool fibers, needle marks, slight fuzziness
- The animal itself is a felt puppet: slightly lumpy, hand-stitched seams visible, lovingly imperfect
- Nothing is real or photographic — everything is a handmade miniature set
- The world feels like someone spent weeks crafting every tiny detail by hand with wool and love

ANIMAL:
- Slightly anthropomorphic — sitting upright like a person, with expressive gentle eyes
- Wearing an oversized chunky knitted sweater or soft felt robe in warm colours
- Oversized vintage felt headphones on their head — slightly too big, adorably wonky
- A tiny cozy felt blanket draped over their lap or wrapped around their shoulders
- Expression: sleepy, content, peaceful — eyes half-closed or soft

SCALE & PROPS:
- All props are perfectly scaled to the animal's tiny size — like a dollhouse or Wes Anderson miniature set
- A tiny felt or ceramic mug they can hold in their paws
- A miniature worn felt book or two beside them
- Everything feels lovingly hand-built for this exact tiny animal

MOOD & COLOUR:
- Irresistibly cute, warm, safe, sleepy — the coziest place imaginable
- Colour palette: sage, terracotta, mustard, dusty pink, warm cream — earthy and deeply warm
- Soft warm golden light, like a single lamp on a winter evening
- Shallow depth of field — animal in focus, background softly blurred

COMPOSITION:
- Portrait orientation (9:16 vertical) — animal centered and filling the frame
- Intimate and close — we are right there with the animal
- Documentary-style macro photography of a real handmade diorama
- --ar 9:16 vertical composition, portrait orientation, full-frame subject, centered for mobile viewing, cinematic framing, no horizontal cropping, designed for TikTok screen

Output ONLY the prompt text. No introduction, no explanation.`,

  story: `You are Damon, the narrator of Bedstories — a sleep content brand for adults.
Write slow, sensorial, deeply cozy bedtime stories about animals.

MANDATORY OPENING FORMAT — start with exactly this exchange:
"Damon, tell me a story."
What story would you like to hear?
"The one about the [animals] [doing something]."

[STORY TITLE IN CAPITALS]
A [SETTING TYPE] STORY

[story body]

STORY RULES:
- Almost nothing happens. Animals arrive somewhere cozy, settle in slowly, eat, feel warmth
- SENSORY DETAIL is everything: describe scents, textures, temperatures, tastes, sounds with loving precision
- Food and warm drinks must appear and be described in detail
- No conflict, no urgency, no drama. Long, unhurried sentences. Repetition is welcome.
- Give animals charming proper names: Fig, Mallow, Sorrel, Bramble, Clem, Wren, Pip, Thistle
- Use · · · as scene dividers
- End with animals nearly asleep, or walking home slowly under stars
- 650–900 words for the story body

Output ONLY the story. No preamble, no explanation.`,

  qualityImage: `Quality checker for Bedstories image prompts. Return ONLY valid JSON, no markdown fences.
{"score":82,"passed":true,"checks":[{"name":"Felt world — everything handmade","passed":true,"note":""},{"name":"Anthropomorphic animal","passed":true,"note":""},{"name":"Scaled props","passed":true,"note":""},{"name":"Headphones present","passed":true,"note":""},{"name":"Cozy warm mood","passed":false,"note":""},{"name":"Earthy colour palette","passed":true,"note":""},{"name":"Portrait 9:16 vertical","passed":true,"note":""}],"suggestion":""}
Score 0–100. passed = score >= 75.`,

  qualityStory: `Quality checker for Bedstories sleep stories. Return ONLY valid JSON, no markdown fences.
{"score":88,"passed":true,"checks":[{"name":"Opening Nicole/Damon exchange","passed":true,"note":""},{"name":"Sensory richness — scent texture taste","passed":true,"note":""},{"name":"Food & warm drink present","passed":true,"note":""},{"name":"Very low action — no conflict","passed":true,"note":""},{"name":"Section breaks · · ·","passed":true,"note":""},{"name":"Charming animal names","passed":true,"note":""},{"name":"Long unhurried sentences","passed":true,"note":""},{"name":"Word count 650–900","passed":true,"note":""}],"suggestion":""}
Score 0–100. passed = score >= 75.`,
};

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
const ANIMALS = [
  'bear','otter','capybara','fox','rabbit','hedgehog',
  'deer','cat','dog','turtle','duck','owl','squirrel',
  'raccoon','mouse','hamster','koala','panda','beaver','badger',
];
const SETTINGS = [
  'jacuzzi','hammock','glasshouse','spa','library','garden',
  'rowboat','treehouse','café','greenhouse','canvas tent',
  'log cabin','bakery','bookshop','attic studio','tiny bathhouse',
  'reading nook','train carriage',
];
const SOUNDS = ['Rain','City at night','Forest & birds','Ocean waves','Fireplace','Soft café'];

const C = {
  bg: '#FAF7F2', card: '#FFFFFF', border: '#EDE4D9',
  accent: '#C4714A', sage: '#7A9E7E', gold: '#D4A843',
  text: '#2A1A0E', muted: '#9A7A65', dark: '#2A1A0E',
};

/* ─────────────────────────────────────────────────────────────
   UI ATOMS
───────────────────────────────────────────────────────────── */
function Spin({ size = 14 }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, flexShrink: 0,
      border: '2px solid #C4A88244', borderTopColor: C.accent,
      borderRadius: '50%', animation: 'spin 1s linear infinite',
    }} />
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: C.card, borderRadius: 14, padding: '22px 24px',
      border: `1px solid ${C.border}`, marginBottom: 16,
      boxShadow: '0 1px 4px #2A1A0E08', ...style,
    }}>
      {children}
    </div>
  );
}

function Lbl({ children, sub }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.accent, letterSpacing: '.08em', textTransform: 'uppercase' }}>
        {children}
      </div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Chip({ label, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', borderRadius: 20, marginBottom: 4,
      border: active ? 'none' : `1px solid ${C.border}`,
      background: active ? color : 'white',
      color: active ? 'white' : '#6B4F3A',
      cursor: 'pointer', fontSize: 12, fontFamily: 'Georgia,serif',
      transition: 'all .15s',
    }}>
      {label}
    </button>
  );
}

function Btn({ onClick, loading, label, secondary = false, disabled = false }) {
  const off = loading || disabled;
  return (
    <button onClick={onClick} disabled={off} style={{
      padding: secondary ? '8px 18px' : '10px 22px', borderRadius: 8,
      border: secondary ? `1px solid #C4A882` : 'none',
      background: secondary ? 'white' : off ? '#D4B89A' : C.accent,
      color: secondary ? '#6B4F3A' : 'white',
      cursor: off ? 'not-allowed' : 'pointer',
      fontSize: 13, fontFamily: 'Georgia,serif',
      display: 'flex', alignItems: 'center', gap: 8,
      fontWeight: secondary ? 400 : 500, whiteSpace: 'nowrap',
      boxShadow: secondary ? 'none' : '0 2px 8px #C4714A33',
      transition: 'all .2s',
    }}>
      {loading && <Spin />}{label}
    </button>
  );
}

function CopyBtn({ text, id, label = 'Copy', copied, onCopy }) {
  return (
    <button onClick={() => onCopy(text, id)} style={{
      padding: '6px 14px', borderRadius: 6, flexShrink: 0,
      border: `1px solid #C4A882`,
      background: copied[id] ? C.sage : 'white',
      color: copied[id] ? 'white' : '#6B4F3A',
      cursor: 'pointer', fontSize: 12, fontFamily: 'Georgia,serif',
      transition: 'all .2s',
    }}>
      {copied[id] ? '✓ Copied' : label}
    </button>
  );
}

function TA({ value, onChange, placeholder, rows = 5 }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: '100%', padding: '14px 16px', borderRadius: 10,
        border: `1px solid ${C.border}`, fontSize: 13, lineHeight: 1.7,
        color: C.text, resize: 'vertical', outline: 'none',
        fontFamily: 'Georgia,serif', background: 'white',
      }}
    />
  );
}

function TIn({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', padding: '10px 14px', borderRadius: 8,
        border: `1px solid ${C.border}`, fontSize: 13,
        color: C.text, outline: 'none',
        fontFamily: 'Georgia,serif', background: 'white',
      }}
    />
  );
}

function ErrBox({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      padding: '12px 16px', background: '#FDF0EE',
      border: '1px solid #E8B4B0', borderRadius: 8,
      fontSize: 12, color: '#A05555', marginTop: 12, lineHeight: 1.7,
    }}>
      ⚠ {msg}
    </div>
  );
}

function QCBadge({ qc }) {
  if (!qc) return null;
  const col = qc.passed ? C.sage : qc.score >= 60 ? C.gold : C.accent;
  return (
    <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 10, border: `1px solid ${col}22`, background: `${col}11` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: col, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 13 }}>
          {qc.score}
        </div>
        <div style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>
          {qc.passed ? '✓ Approved' : 'Needs revision'}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {qc.checks.map((c, i) => (
          <span key={i} style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 20,
            background: c.passed ? '#7A9E7E22' : '#C4714A22',
            color: c.passed ? '#4A7A5E' : '#A0552A',
            border: `1px solid ${c.passed ? '#7A9E7E44' : '#C4714A44'}`,
          }}>
            {c.passed ? '✓' : '✗'} {c.name}
          </span>
        ))}
      </div>
      {qc.suggestion && (
        <div style={{ fontSize: 12, color: '#6B4F3A', fontStyle: 'italic', marginTop: 10 }}>
          💡 {qc.suggestion}
        </div>
      )}
    </div>
  );
}

function Timer({ running }) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) { setS(0); return; }
    const i = setInterval(() => setS(x => x + 1), 1000);
    return () => clearInterval(i);
  }, [running]);
  if (!running) return null;
  return <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{s}s</span>;
}

function Toggle({ on, onToggle, label, sub }) {
  return (
    <div onClick={onToggle} style={{
      display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
      padding: '10px 14px', borderRadius: 8,
      background: on ? '#F0F7F2' : '#FAF7F2',
      border: `1px solid ${on ? C.sage : C.border}`,
      transition: 'all .2s',
    }}>
      <div style={{ width: 36, height: 20, borderRadius: 10, background: on ? C.sage : '#C4A882', position: 'relative', transition: 'all .2s', flexShrink: 0 }}>
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'white', position: 'absolute', top: 2, left: on ? 18 : 2, transition: 'all .2s' }} />
      </div>
      <div>
        <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   STEP 1 — VISUAL
───────────────────────────────────────────────────────────── */
function StepVisual({
  visualAnimal, setVisualAnimal, visualSetting, setVisualSetting,
  imagePrompt, setImagePrompt, imageQC, setImageQC,
  imageUrl, setImageUrl, videoUrl, setVideoUrl,
  cropWatermark, setCropWatermark,
  loading, setLoading, copied, onCopy,
}) {
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const genPrompt = async () => {
    setErr(null); setLoading(l => ({ ...l, imagePrompt: true })); setImageQC(null);
    try {
      const text = await claude(
        SYS.imagePrompt,
        `Create a prompt for: a little ${visualAnimal} in a ${visualSetting}, wearing headphones, listening to a bedtime story. Portrait 9:16 vertical.`,
        700
      );
      setImagePrompt(text);
    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, imagePrompt: false }));
  };

  const checkQC = async () => {
    setErr(null); setLoading(l => ({ ...l, imageQC: true }));
    try {
      const text = await claude(SYS.qualityImage, `Check:\n\n${imagePrompt}`, 500);
      setImageQC(JSON.parse(text.replace(/```json\n?|```/g, '').trim()));
    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, imageQC: false }));
  };

  const genImage = async () => {
    setErr(null); setLoading(l => ({ ...l, image: true })); setImageUrl(null); setVideoUrl(null);
    try {
      const { imageUrl: url } = await post('image', { prompt: imagePrompt });
      setImageUrl(url);
    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, image: false }));
  };

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      // Resize to max 1080px before storing — prevents 413 on upload
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const MAX_W = 1080;
        const MAX_H = 1920;
        const ratio = Math.min(MAX_W / img.width, MAX_H / img.height, 1);
        canvas.width  = Math.round(img.width  * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        setImageUrl(canvas.toDataURL("image/jpeg", 0.80));
        setVideoUrl(null);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  const genVideo = async () => {
    setErr(null); setLoading(l => ({ ...l, video: true })); setVideoUrl(null);
    try {
      let publicImageUrl = imageUrl;
      if (imageUrl.startsWith('data:')) {
        // Upload directly from browser to Supabase — bypasses Vercel body size limits entirely
        const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const base64 = imageUrl.split(',')[1];
        const mime  = imageUrl.split(';')[0].split(':')[1];
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const filename = `bs-upload-${Date.now()}.jpg`;
        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/bedstories-audio/${filename}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${SUPABASE_ANON}`,
              'Content-Type': mime,
              'x-upsert': 'true',
            },
            body: bytes,
          }
        );
        if (!uploadRes.ok) {
          const err = await uploadRes.json().catch(() => ({}));
          throw new Error(`Image upload failed: ${err.message || uploadRes.status}`);
        }
        publicImageUrl = `${SUPABASE_URL}/storage/v1/object/public/bedstories-audio/${filename}`;
        setImageUrl(publicImageUrl);
      }
      const { requestId } = await post('animate', { imageUrl: publicImageUrl });
      let found = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 6000));
        const { status, videoUrl: url } = await get(`animate-poll?requestId=${requestId}`);
        if (status === 'done') { setVideoUrl(url); found = true; break; }
        if (status === 'failed') throw new Error('Video generation failed — try again');
      }
      if (!found) throw new Error('Video generation timed out');
    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, video: false }));
  };

  return (
    <div>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: C.text, marginBottom: 4 }}>Visual</h2>
      <p style={{ color: C.muted, fontSize: 13, marginBottom: 24, lineHeight: 1.7 }}>
        The felt animal with headphones — the visual container. Independent from the story.
      </p>

      <Card>
        <Lbl>Animal wearing the headphones</Lbl>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {ANIMALS.map(a => <Chip key={a} label={a} active={visualAnimal === a} color={C.accent} onClick={() => setVisualAnimal(a)} />)}
        </div>
        <TIn value={visualAnimal} onChange={setVisualAnimal} placeholder="or type your own…" />
      </Card>

      <Card>
        <Lbl>Setting</Lbl>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {SETTINGS.map(s => <Chip key={s} label={s} active={visualSetting === s} color={C.sage} onClick={() => setVisualSetting(s)} />)}
        </div>
        <TIn value={visualSetting} onChange={setVisualSetting} placeholder="or type your own…" />
      </Card>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <Lbl>Image Prompt</Lbl>
          <div style={{ display: 'flex', gap: 8 }}>
            {imagePrompt && <Btn onClick={checkQC} loading={loading.imageQC} label="Quality Check" secondary />}
            <Btn onClick={genPrompt} loading={loading.imagePrompt} disabled={!visualAnimal || !visualSetting}
              label={imagePrompt ? 'Regenerate' : 'Generate Prompt'} secondary={!!imagePrompt} />
          </div>
        </div>
        <TA value={imagePrompt} onChange={setImagePrompt} placeholder="Select animal + setting, then Generate Prompt…" rows={8} />
        {imagePrompt && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <CopyBtn text={imagePrompt} id="imgPrompt" label="Copy Prompt" copied={copied} onCopy={onCopy} />
          </div>
        )}
        <QCBadge qc={imageQC} />
        <ErrBox msg={err} />
      </Card>

      {imagePrompt && (
        <Card>
          <Lbl sub="Generate with fal.ai, or upload your own from Nano Banana">Image</Lbl>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Btn onClick={genImage} loading={loading.image}
              label={imageUrl ? 'Regenerate with fal.ai' : 'Generate with fal.ai'} secondary={!!imageUrl} />
            <button onClick={() => fileRef.current?.click()} style={{ padding: '10px 18px', borderRadius: 8, border: `1px solid #C4A882`, background: 'white', color: '#6B4F3A', cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia,serif' }}>
              ↑ Upload your own
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleUpload} style={{ display: 'none' }} />
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: 1.6 }}>
            If uploading from Nano Banana, export in <strong>9:16 portrait</strong> (1080×1920px).
            Use the crop toggle below to remove the watermark.
          </div>
          {loading.image && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted, marginBottom: 10 }}>
              <Spin /> Generating… <Timer running={loading.image} />
            </div>
          )}
          {imageUrl && (
            <>
              <img src={imageUrl} alt="Visual" style={{ width: 'auto', maxHeight: 380, borderRadius: 10, display: 'block', marginBottom: 14 }} />
              <Toggle
                on={cropWatermark}
                onToggle={() => setCropWatermark(v => !v)}
                label="Crop watermark"
                sub="Zooms in 20% — removes bottom-right watermarks (Nano Banana etc.)"
              />
            </>
          )}
        </Card>
      )}

      {imageUrl && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Lbl sub="Adds very subtle ambient motion — 2–4 minutes">Looping Video</Lbl>
            <Btn onClick={genVideo} loading={loading.video}
              label={videoUrl ? 'Regenerate Video' : 'Generate Video'} secondary={!!videoUrl} />
          </div>
          {loading.video && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted, marginBottom: 10 }}>
              <Spin /> Animating… <Timer running={loading.video} />
            </div>
          )}
          {videoUrl && (
            <>
              <video src={videoUrl} autoPlay loop muted playsInline
                style={{ width: 'auto', maxHeight: 380, borderRadius: 10, display: 'block', marginBottom: 8 }} />
              <div style={{ fontSize: 12, color: C.sage }}>✓ Video ready</div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   STEP 2 — STORY
───────────────────────────────────────────────────────────── */
function StepStory({
  storyAnimal, setStoryAnimal, storySetting, setStorySetting,
  storySeed, setStorySeed, story, setStory, storyQC, setStoryQC,
  loading, setLoading, copied, onCopy,
}) {
  const [err, setErr] = useState(null);
  const count = wc(story);
  const wcOk = count >= 650 && count <= 950;

  const genStory = async () => {
    setErr(null); setLoading(l => ({ ...l, story: true })); setStoryQC(null);
    try {
      const text = await claude(
        SYS.story,
        `Animal: ${storyAnimal}. Setting: ${storySetting}.${storySeed ? ' Seed: ' + storySeed : ''}`,
        2000
      );
      setStory(text);
    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, story: false }));
  };

  const checkQC = async () => {
    setErr(null); setLoading(l => ({ ...l, storyQC: true }));
    try {
      const text = await claude(SYS.qualityStory, `Check this story:\n\n${story}`, 600);
      setStoryQC(JSON.parse(text.replace(/```json\n?|```/g, '').trim()));
    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, storyQC: false }));
  };

  return (
    <div>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: C.text, marginBottom: 4 }}>Story</h2>
      <p style={{ color: C.muted, fontSize: 13, marginBottom: 24, lineHeight: 1.7 }}>
        The bedtime story Damon narrates. Separate from the visual.
      </p>

      <Card>
        <Lbl>Story animals</Lbl>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {ANIMALS.map(a => <Chip key={a} label={a} active={storyAnimal === a} color={C.accent} onClick={() => setStoryAnimal(a)} />)}
        </div>
        <TIn value={storyAnimal} onChange={setStoryAnimal} placeholder="or type your own…" />
      </Card>

      <Card>
        <Lbl>Story setting</Lbl>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {SETTINGS.map(s => <Chip key={s} label={s} active={storySetting === s} color={C.sage} onClick={() => setStorySetting(s)} />)}
        </div>
        <TIn value={storySetting} onChange={setStorySetting} placeholder="or type your own…" />
      </Card>

      <Card>
        <Lbl sub="optional — steers the tone or theme">Story Seed</Lbl>
        <TIn value={storySeed} onChange={setStorySeed} placeholder="e.g. 'three capybaras share a slow breakfast in the rain'" />
      </Card>

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <Lbl>The Story</Lbl>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {count > 0 && (
              <span style={{ fontSize: 12, color: wcOk ? C.sage : C.accent, fontWeight: 500 }}>
                {count}w {wcOk ? '✓' : count < 650 ? '(too short)' : '(too long)'}
              </span>
            )}
            {story && <Btn onClick={checkQC} loading={loading.storyQC} label="Quality Check" secondary />}
            <Btn onClick={genStory} loading={loading.story} disabled={!storyAnimal || !storySetting}
              label={story ? 'Regenerate' : 'Generate Story'} secondary={!!story} />
          </div>
        </div>
        {loading.story && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted, marginBottom: 10 }}>
            <Spin /> Writing… <Timer running={loading.story} />
          </div>
        )}
        <TA value={story} onChange={setStory} placeholder="Select animals and setting, then Generate Story…" rows={18} />
        {story && (
          <div style={{ marginTop: 10 }}>
            <CopyBtn text={story} id="story" label="Copy Story" copied={copied} onCopy={onCopy} />
          </div>
        )}
        <QCBadge qc={storyQC} />
        <ErrBox msg={err} />
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   STEP 3 — AUDIO
───────────────────────────────────────────────────────────── */
function StepAudio({
  story, audioUrl, setAudioUrl, setWordTimings,
  audioDuration, setAudioDuration, setDamonStartTime,
  sound, setSound, loading, setLoading,
}) {
  const [err, setErr] = useState(null);
  const segs = parseSegments(story);

  const generate = async () => {
    if (!story) return;
    setErr(null); setLoading(l => ({ ...l, audio: true })); setAudioUrl(null);
    try {
      const { audioUrl: url, wordTimings: wt, audioDuration: dur, damonStartTime: dst } =
        await post('dialogue', { segments: segs });

      setAudioUrl(url);
      setWordTimings(wt);
      setDamonStartTime(Number(dst) || 0);

      // Measure real duration from the actual audio file — the alignment
      // timestamps from ElevenLabs can be shorter than the real audio
      const realDur = await getRealAudioDuration(url);
      setAudioDuration(Number((realDur || Number(dur) || 360).toFixed(2)));

    } catch (e) { setErr(e.message); }
    setLoading(l => ({ ...l, audio: false }));
  };

  if (!story) return (
    <div>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: C.text, marginBottom: 16 }}>Audio</h2>
      <Card><p style={{ color: C.muted, fontSize: 13 }}>Generate a story first.</p></Card>
    </div>
  );

  return (
    <div>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: C.text, marginBottom: 4 }}>Audio</h2>
      <p style={{ color: C.muted, fontSize: 13, marginBottom: 24, lineHeight: 1.7 }}>
        Nicole's opener + Damon's narration — merged, uploaded to Supabase automatically.
      </p>

      <Card>
        <Lbl sub="Plays quietly throughout the entire video">Ambient Sound</Lbl>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SOUNDS.map(s => <Chip key={s} label={s} active={sound === s} color={C.gold} onClick={() => setSound(s)} />)}
        </div>
      </Card>

      <Card>
        <Lbl sub={`${segs.length} segments · Nicole in pink · Damon in sage`}>Script Preview</Lbl>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 260, overflowY: 'auto', marginBottom: 16, paddingRight: 4 }}>
          {segs.map((seg, i) => {
            const isN = seg.speaker === 'nicole';
            return (
              <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: isN ? '#FDF0EE' : '#F0F7F2', borderLeft: `3px solid ${isN ? '#E8B4B0' : C.sage}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: isN ? '#A05555' : '#3D6B4A', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 2 }}>
                  {isN ? 'Nicole' : 'Damon'}
                </div>
                <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {seg.text}
                </div>
              </div>
            );
          })}
        </div>
        {loading.audio && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted, marginBottom: 12 }}>
            <Spin /> Generating audio… <Timer running={loading.audio} />
          </div>
        )}
        <Btn onClick={generate} loading={loading.audio}
          label={audioUrl ? 'Regenerate Audio' : 'Generate Merged Audio'} secondary={!!audioUrl} />
        <ErrBox msg={err} />
      </Card>

      {audioUrl && (
        <Card style={{ background: '#F0F7F2', border: `1px solid ${C.sage}44` }}>
          <Lbl>Preview</Lbl>
          <audio controls src={audioUrl} style={{ width: '100%', marginBottom: 8 }} />
          {audioDuration && (
            <div style={{ fontSize: 12, color: '#3D6B4A' }}>
              Duration: <strong>{fmtDur(audioDuration)}</strong> ({Math.round(Number(audioDuration))}s) · Uploaded to Supabase ✓
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   STEP 4 — ASSEMBLE
───────────────────────────────────────────────────────────── */
function StepAssemble({
  videoUrl, audioUrl, audioDuration, damonStartTime,
  sound, outputFormat, setOutputFormat, cropWatermark,
}) {
  const [renderStatus, setRenderStatus] = usePersist('renderStatus', 'idle');
  const [finalVideoUrl, setFinalVideoUrl] = usePersist('finalVideoUrl', null);
  const [renderErr, setRenderErr] = useState(null);
  const pollRef = useRef(null);

  const canRender = !!(videoUrl && audioUrl);
  const dur = Number(audioDuration);

  const render = async () => {
    setRenderErr(null); setRenderStatus('submitting'); setFinalVideoUrl(null);
    try {
      const { renderId } = await post('render', {
        videoUrl,
        audioUrl,
        audioDuration: dur,
        sound,
        outputFormat,
        damonStartTime: Number(damonStartTime) || 0,
        cropWatermark: !!cropWatermark,
      });
      setRenderStatus('rendering');
      const poll = async () => {
        try {
          const { status, url } = await get(`poll?id=${renderId}`);
          if (status === 'done') {
            setFinalVideoUrl(url); setRenderStatus('done'); clearInterval(pollRef.current);
          } else if (status === 'failed') {
            throw new Error('Shotstack render failed — check the Shotstack dashboard for details');
          }
        } catch (e) {
          setRenderErr(e.message); setRenderStatus('idle'); clearInterval(pollRef.current);
        }
      };
      pollRef.current = setInterval(poll, 10000);
      setTimeout(poll, 5000);
    } catch (e) {
      setRenderErr(e.message); setRenderStatus('idle');
    }
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  if (!audioUrl) return (
    <div>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: C.text, marginBottom: 16 }}>Assemble</h2>
      <Card><p style={{ color: C.muted, fontSize: 13 }}>Complete Visual and Audio steps first.</p></Card>
    </div>
  );

  return (
    <div>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: C.text, marginBottom: 4 }}>Assemble</h2>
      <p style={{ color: C.muted, fontSize: 13, marginBottom: 24, lineHeight: 1.7 }}>
        Shotstack assembles the final video — looped visuals, narration, piano, ambient sound.
      </p>

      <Card>
        <Lbl>Output Format</Lbl>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip label="Vertical 9:16 — TikTok / Reels" active={outputFormat === 'vertical'} color={C.sage} onClick={() => setOutputFormat('vertical')} />
          <Chip label="Horizontal 16:9 — YouTube" active={outputFormat === 'horizontal'} color={C.sage} onClick={() => setOutputFormat('horizontal')} />
        </div>
      </Card>

      <Card style={{ background: C.bg }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
          <div style={{ color: videoUrl ? C.sage : C.muted }}>{videoUrl ? '✓' : '○'} Looping video ready</div>
          <div style={{ color: audioUrl ? C.sage : C.muted }}>
            {audioUrl ? '✓' : '○'} Narration audio{dur ? ` (${fmtDur(dur)})` : ''}
          </div>
          <div style={{ color: C.sage }}>🎵 {sound} · ambient throughout</div>
          <div style={{ color: C.sage }}>🎹 Piano starts when Damon begins</div>
          <div style={{ color: C.sage }}>🔁 Hard cuts — seamless loop</div>
          {cropWatermark && <div style={{ color: C.sage }}>✂ Watermark crop active (20% zoom)</div>}
        </div>
      </Card>

      {renderStatus === 'rendering' && (
        <Card style={{ background: C.bg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#6B4F3A' }}>
            <Spin size={16} /> Rendering {fmtDur(dur)} of video… usually 3–5 minutes.
            <Timer running={true} />
          </div>
        </Card>
      )}

      {renderStatus === 'done' && finalVideoUrl && (
        <Card style={{ background: '#F0F7F2', border: `1px solid ${C.sage}44` }}>
          <div style={{ fontSize: 14, color: '#3D6B4A', fontWeight: 600, marginBottom: 12 }}>✓ Your Bedstory is ready</div>
          <a href={finalVideoUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', padding: '12px 24px', borderRadius: 8, background: C.sage, color: 'white', textDecoration: 'none', fontSize: 14, fontWeight: 600, boxShadow: '0 2px 8px #7A9E7E44', marginBottom: 12 }}>
            Download MP4 →
          </a>
          <div style={{ fontSize: 12, color: '#6B4F3A', lineHeight: 1.7 }}>
            Add word-highlight subtitles in TikTok or CapCut before posting.
          </div>
        </Card>
      )}

      <ErrBox msg={renderErr} />

      {renderStatus !== 'rendering' && (
        <Btn onClick={render} loading={renderStatus === 'submitting'} disabled={!canRender}
          label={renderStatus === 'done' ? 'Render Again' : 'Render Final Video'} />
      )}
      {!canRender && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
          {!videoUrl ? '← Generate a video in the Visual step first' : '← Generate audio in the Audio step first'}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   MAIN APP
───────────────────────────────────────────────────────────── */
export default function Bedstories() {
  const [step, setStep] = usePersist('step', 0);

  // Visual
  const [visualAnimal, setVisualAnimal] = usePersist('visualAnimal', '');
  const [visualSetting, setVisualSetting] = usePersist('visualSetting', '');
  const [imagePrompt, setImagePrompt] = usePersist('imagePrompt', '');
  const [imageQC, setImageQC] = usePersist('imageQC', null);
  const [imageUrl, setImageUrl] = usePersist('imageUrl', null);
  const [videoUrl, setVideoUrl] = usePersist('videoUrl', null);
  const [cropWatermark, setCropWatermark] = usePersist('cropWatermark', false);

  // Story
  const [storyAnimal, setStoryAnimal] = usePersist('storyAnimal', '');
  const [storySetting, setStorySetting] = usePersist('storySetting', '');
  const [storySeed, setStorySeed] = usePersist('storySeed', '');
  const [story, setStory] = usePersist('story', '');
  const [storyQC, setStoryQC] = usePersist('storyQC', null);

  // Audio
  const [audioUrl, setAudioUrl] = usePersist('audioUrl', null);
  const [wordTimings, setWordTimings] = usePersist('wordTimings', null);
  const [audioDuration, setAudioDuration] = usePersist('audioDuration', null);
  const [damonStartTime, setDamonStartTime] = usePersist('damonStartTime', 0);
  const [sound, setSound] = usePersist('sound', 'Rain');

  // Assemble
  const [outputFormat, setOutputFormat] = usePersist('outputFormat', 'vertical');

  const [loading, setLoading] = useState({});
  const [copied, setCopied] = useState({});

  const onCopy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(c => ({ ...c, [key]: true }));
      setTimeout(() => setCopied(c => ({ ...c, [key]: false })), 2000);
    } catch {}
  };

  const clearAll = () => {
    if (!confirm('Clear all saved progress and start fresh?')) return;
    Object.keys(localStorage).filter(k => k.startsWith('bs_')).forEach(k => localStorage.removeItem(k));
    window.location.reload();
  };

  const nav = ['Visual', 'Story', 'Audio', 'Assemble'];
  const icons = ['◈', '◉', '♫', '▶'];
  const done = [!!imageUrl, !!story, !!audioUrl, false];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: C.bg, fontFamily: 'Georgia, serif' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Sidebar ── */}
      <div style={{ width: 200, background: C.dark, flexShrink: 0, display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '28px 20px 20px', borderBottom: '1px solid #3D2A18' }}>
          <div style={{ fontFamily: 'Georgia,serif', color: '#F5EFE6', fontSize: 16, fontWeight: 600, marginBottom: 2 }}>Bedstories</div>
          <div style={{ fontSize: 10, color: '#6B4F3A', letterSpacing: '.12em', textTransform: 'uppercase' }}>Production Hub</div>
        </div>

        <div style={{ padding: '16px 0', flex: 1 }}>
          {nav.map((label, i) => {
            const active = step === i;
            const isDone = done[i] && !active;
            return (
              <button key={i} onClick={() => setStep(i)} style={{ width: '100%', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, background: active ? '#3D2A18' : 'transparent', border: 'none', cursor: 'pointer', borderLeft: active ? `3px solid ${C.accent}` : '3px solid transparent', textAlign: 'left' }}>
                <span style={{ fontSize: 13, color: isDone ? C.sage : active ? C.accent : '#6B4F3A' }}>{isDone ? '✓' : icons[i]}</span>
                <span style={{ fontSize: 12, color: active ? '#F5EFE6' : isDone ? '#9AB89A' : '#9A7A65' }}>{label}</span>
              </button>
            );
          })}
        </div>

        <div style={{ padding: '16px 20px', borderTop: '1px solid #3D2A18', fontSize: 11, lineHeight: 2.2 }}>
          {visualAnimal && <div style={{ color: '#9A7A65' }}>👁 {visualAnimal} · {visualSetting}</div>}
          {storyAnimal && <div style={{ color: '#9A7A65' }}>📖 {storyAnimal} · {storySetting}</div>}
          {audioUrl && audioDuration && (
            <div style={{ color: C.sage }}>✓ Audio {fmtDur(audioDuration)}</div>
          )}
          {videoUrl && <div style={{ color: C.sage }}>✓ Video ready</div>}
        </div>

        <button onClick={clearAll} style={{ margin: '0 20px 20px', padding: '8px', borderRadius: 8, border: '1px solid #3D2A18', background: 'transparent', color: '#6B4F3A', cursor: 'pointer', fontSize: 11, fontFamily: 'Georgia,serif' }}>
          Clear & start over
        </button>
      </div>

      {/* ── Main content ── */}
      <div style={{ flex: 1, padding: '40px 48px', maxWidth: 780 }}>

        {step === 0 && (
          <StepVisual
            visualAnimal={visualAnimal} setVisualAnimal={setVisualAnimal}
            visualSetting={visualSetting} setVisualSetting={setVisualSetting}
            imagePrompt={imagePrompt} setImagePrompt={setImagePrompt}
            imageQC={imageQC} setImageQC={setImageQC}
            imageUrl={imageUrl} setImageUrl={setImageUrl}
            videoUrl={videoUrl} setVideoUrl={setVideoUrl}
            cropWatermark={cropWatermark} setCropWatermark={setCropWatermark}
            loading={loading} setLoading={setLoading}
            copied={copied} onCopy={onCopy}
          />
        )}
        {step === 1 && (
          <StepStory
            storyAnimal={storyAnimal} setStoryAnimal={setStoryAnimal}
            storySetting={storySetting} setStorySetting={setStorySetting}
            storySeed={storySeed} setStorySeed={setStorySeed}
            story={story} setStory={setStory}
            storyQC={storyQC} setStoryQC={setStoryQC}
            loading={loading} setLoading={setLoading}
            copied={copied} onCopy={onCopy}
          />
        )}
        {step === 2 && (
          <StepAudio
            story={story}
            audioUrl={audioUrl} setAudioUrl={setAudioUrl}
            setWordTimings={setWordTimings}
            audioDuration={audioDuration} setAudioDuration={setAudioDuration}
            setDamonStartTime={setDamonStartTime}
            sound={sound} setSound={setSound}
            loading={loading} setLoading={setLoading}
          />
        )}
        {step === 3 && (
          <StepAssemble
            videoUrl={videoUrl} audioUrl={audioUrl}
            audioDuration={audioDuration} damonStartTime={damonStartTime}
            sound={sound} outputFormat={outputFormat} setOutputFormat={setOutputFormat}
            cropWatermark={cropWatermark}
            loading={loading} setLoading={setLoading}
          />
        )}

        {/* Bottom nav */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 32, paddingTop: 20, borderTop: `1px solid ${C.border}` }}>
          {step > 0
            ? <button onClick={() => setStep(s => s - 1)} style={{ fontSize: 13, color: C.muted, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 0', fontFamily: 'Georgia,serif' }}>← {nav[step - 1]}</button>
            : <div />}
          {step < nav.length - 1 && (
            <button onClick={() => setStep(s => s + 1)} style={{ fontSize: 13, color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 0', fontWeight: 500, fontFamily: 'Georgia,serif' }}>
              {nav[step + 1]} →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
