const SYSTEM = `Tum Rupeyantra ke AI assistant ho. Rupeyantra ek finance/paisa website hai.
Hinglish (Roman Hindi) mein saaf, dosti bhare aur chhote jawab do, jab tak user kisi aur bhasha mein na likhe.
Jawab mobile par aasaani se padhne layak rakho. EMI, SIP, budget, bachat jaise finance sawalon mein madad karo
aur calculation step-by-step samjhao, hisaab dobara check karke likho. Tum licensed financial advisor nahi ho,
isliye specific invest/trade karne ki confident salah mat do, sirf jaankari do aur zaroorat par
SEBI-registered advisor se milne ko kaho.`;

const TIMEOUT = 15000;

async function fail(name, r) {
  let body = '';
  try { body = (await r.text()).slice(0, 200); } catch (e) {}
  throw new Error(`${name} ${r.status} ${body}`);
}

async function askGroq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY.trim()}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      max_tokens: 700,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) await fail('Groq', r);
  const t = (await r.json()).choices?.[0]?.message?.content;
  if (!t) throw new Error('Groq khali jawab');
  return t;
}

async function askGemini(messages) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    }
  );
  if (!r.ok) await fail('Gemini', r);
  const d = await r.json();
  const t = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
  if (!t) throw new Error('Gemini khali jawab');
  return t;
}

async function askOpenRouter(messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`,
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
      max_tokens: 700,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
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
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({ message: 'Galat request' });
  }

  const providers = ALL.filter(p => keys[p.name]);
  if (!providers.length) {
    const missing = ALL.map(p => p.env).join(', ');
    return res.status(500).json({
      message:
        'Koi API key nahi mili.\n\nVercel > Settings > Environment Variables mein ye daalo: ' +
        missing +
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
