const SYSTEM = `Tum Rupeyantra ke AI assistant ho. Rupeyantra ek finance/paisa website hai.
Hinglish (Roman Hindi) mein saaf, dosti bhare aur chhote jawab do, jab tak user kisi aur bhasha mein na likhe.
Jawab mobile par aasaani se padhne layak rakho. EMI, SIP, budget, bachat jaise finance sawalon mein madad karo
aur calculation step-by-step samjhao, hisaab dobara check karke likho. Tum licensed financial advisor nahi ho,
isliye specific invest/trade karne ki confident salah mat do, sirf jaankari do aur zaroorat par
SEBI-registered advisor se milne ko kaho.
Agar user photo ya file bheje to use dhyaan se padho aur uske hisaab se jawab do.`;

const TIMEOUT = 25000;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_MEDIA_CHARS = 4000000;

async function fail(name, r) {
  let body = '';
  try { body = (await r.text()).slice(0, 200); } catch (e) {}
  throw new Error(`${name} ${r.status} ${body}`);
}

const plain = messages => messages.map(m => ({ role: m.role, content: m.content }));

async function askGroq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY.trim()}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      max_tokens: 1500,
      reasoning_effort: 'low',
      messages: [{ role: 'system', content: SYSTEM }, ...plain(messages)],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) await fail('Groq', r);
  const t = (await r.json()).choices?.[0]?.message?.content;
  if (!t) throw new Error('Groq khali jawab');
  return t;
}

async function geminiCall(model, messages, think) {
  const cfg = { maxOutputTokens: 2048 };
  if (think) cfg.thinkingConfig = { thinkingLevel: 'low' };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY.trim(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [
            { text: m.content },
            ...(m.attachments || []).map(a => ({
              inlineData: { mimeType: a.mime, data: a.data },
            })),
          ],
        })),
        generationConfig: cfg,
      }),
      signal: AbortSignal.timeout(17000),
    }
  );
  if (!r.ok) await fail('Gemini(' + model + ')', r);
  const d = await r.json();
  const t = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!t) throw new Error('Gemini(' + model + ') khali jawab');
  return t;
}

async function askGemini(messages) {
  // Pehle tez models, phir baaki. Ek fail ho to agla try hota hai.
  const attempts = [
    { model: process.env.GEMINI_MODEL || 'gemini-3.5-flash', think: true },
    { model: 'gemini-3.5-flash-lite', think: false },
    { model: 'gemini-3.8-flash', think: false },
  ];
  const errs = [];
  for (const a of attempts) {
    try {
      return await geminiCall(a.model, messages, a.think);
    } catch (e) {
      console.error('gemini attempt fail:', e.message);
      errs.push(e.message);
    }
  }
  throw new Error(errs.join(' | '));
}

async function askOpenRouter(messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`,
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
      max_tokens: 1000,
      messages: [{ role: 'system', content: SYSTEM }, ...plain(messages)],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) await fail('OpenRouter', r);
  const t = (await r.json()).choices?.[0]?.message?.content;
  if (!t) throw new Error('OpenRouter khali jawab');
  return t;
}

const ALL = [
  { name: 'groq', env: 'GROQ_API_KEY', run: askGroq },
  { name: 'gemini', env: 'GEMINI_API_KEY', run: askGemini },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', run: askOpenRouter },
];

module.exports = async (req, res) => {
  const keys = {};
  ALL.forEach(p => (keys[p.name] = !!(process.env[p.env] || '').trim()));

  // Browser mein /api/chat kholo to key status dikhega (key khud nahi dikhti)
  if (req.method === 'GET') return res.status(200).json({ keys });
  if (req.method !== 'POST') return res.status(405).json({ message: 'Sirf POST chalega' });

  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
  const clean = msgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => {
      const o = { role: m.role, content: m.content.slice(0, 20000) };
      if (m.role === 'user' && Array.isArray(m.attachments)) {
        const a = m.attachments
          .filter(x => x && MEDIA_TYPES.includes(x.mime) && typeof x.data === 'string')
          .slice(0, 3)
          .map(x => ({ mime: x.mime, data: x.data }));
        if (a.length) o.attachments = a;
      }
      return o;
    });

  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({ message: 'Galat request' });
  }

  const mediaSize = clean.reduce(
    (n, m) => n + (m.attachments || []).reduce((s, a) => s + a.data.length, 0),
    0
  );
  if (mediaSize > MAX_MEDIA_CHARS) {
    return res.status(413).json({ message: 'Photo/file bahut badi hai. Chhoti photo ya file bhejo.' });
  }
  const needsGemini = mediaSize > 0;

  // Photo aur PDF sirf Gemini samajhta hai. Text wale sawal kisi bhi provider se chalte hain.
  const providers = ALL.filter(p => keys[p.name] && (!needsGemini || p.name === 'gemini'));

  if (!providers.length) {
    return res.status(500).json({
      message: needsGemini
        ? 'Photo ya PDF ke liye GEMINI_API_KEY zaroori hai. Vercel mein add karo aur Redeploy karo.'
        : 'Koi API key nahi mili.\n\nVercel > Settings > Environment Variables mein ye daalo: ' +
          ALL.map(p => p.env).join(', ') +
          '\nPhir Redeploy karo.',
      keys,
    });
  }

  const errors = [];
  for (const p of providers) {
    try {
      const reply = await p.run(clean);
      return res.status(200).json({ reply, used: p.name });
    } catch (e) {
      console.error(`${p.name} fail:`, e.message);
      errors.push(`${p.name}: ${e.message}`);
    }
  }

  res.status(500).json({
    message: 'Saare providers fail hue:\n\n' + errors.join('\n\n'),
    keys,
  });
};
