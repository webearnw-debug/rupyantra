const SYSTEM = `Tum Rupeyantra ke AI assistant ho. Rupeyantra ek finance/paisa website hai.
Hinglish (Roman Hindi) mein saaf, dosti bhare aur chhote jawab do, jab tak user kisi aur bhasha mein na likhe.
Jawab mobile par aasaani se padhne layak rakho. EMI, SIP, budget, bachat jaise finance sawalon mein madad karo
aur calculation step-by-step samjhao, hisaab dobara check karke likho. Tum licensed financial advisor nahi ho,
isliye specific invest/trade karne ki confident salah mat do, sirf jaankari do aur zaroorat par
SEBI-registered advisor se milne ko kaho.`;

const TIMEOUT = 8000;

async function askGroq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      max_tokens: 700,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error('Groq ' + r.status);
  return (await r.json()).choices[0].message.content;
}

async function askGemini(messages) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 700 },
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error('Gemini ' + r.status);
  const d = await r.json();
  const t = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
  if (!t) throw new Error('Gemini empty');
  return t;
}

async function askOpenRouter(messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
      max_tokens: 700,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error('OpenRouter ' + r.status);
  const t = (await r.json()).choices?.[0]?.message?.content;
  if (!t) throw new Error('OpenRouter empty');
  return t;
}

module.exports = async (req, res) => {  if (req.method === 'GET' && req.query?.debug === '1') {
    const test = [{ role: 'user', content: 'hi' }];
    const out = {
      keys: {
        groq: !!process.env.GROQ_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY,
        openrouter: !!process.env.OPENROUTER_API_KEY,
      },
    };
    for (const [n, f] of [['groq', askGroq], ['gemini', askGemini], ['openrouter', askOpenRouter]]) {
      try { await f(test); out[n] = 'ok'; } catch (e) { out[n] = e.message; }
    }
    return res.status(200).json(out);
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
  const clean = msgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Bad request' });
  }

  const providers = [
    { name: 'groq', on: !!process.env.GROQ_API_KEY, run: askGroq },
    { name: 'gemini', on: !!process.env.GEMINI_API_KEY, run: askGemini },
    { name: 'openrouter', on: !!process.env.OPENROUTER_API_KEY, run: askOpenRouter },
  ].filter(p => p.on);

  if (!providers.length) return res.status(500).json({ error: 'No API key set' });

  for (const p of providers) {
    try {
      return res.status(200).json({ reply: await p.run(clean) });
    } catch (e) {
      console.error(`${p.name} fail:`, e.message);
    }
  }
  res.status(500).json({ error: 'AI error' });
};
