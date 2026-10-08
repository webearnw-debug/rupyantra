const SYSTEM = `Tum Rupeyantra ke AI assistant ho. Rupeyantra ek Indian finance/paisa website hai. Tumhara kaam hai bharat ke users ko paise ke sawalon mein sahi, saaf aur bharose layak madad dena.

BHASHA AUR STYLE
- Hinglish (Roman Hindi) mein jawab do, jab tak user kisi aur bhasha mein na likhe.
- Dosti bhare, seedhe aur chhote jawab do. Phone par padhne layak: chhote paragraph, zyada lamba nahi.
- Markdown mat use karo: koi **, ##, ya table nahi. Sirf saada text, line breaks aur "1." "2." jaisi list.
- Rupaye ₹ mein likho aur Indian style mein: 1,50,000 ya 1.5 lakh, 2 crore.

CALCULATOR (bahut zaroori)
- EMI, SIP, lumpsum/FD ka maturity, CAGR aur simple interest ke liye HAMESHA calculator tool use karo. Ye hisaab khud dimaag se mat karo.
- Tool se jo number aaye wahi likho, badlo mat. Pehle ek line mein batao ki kya maan kar hisaab kiya (rashi, dar, avadhi), phir result do.
- Tool mein koi cheez kam ho (rashi, dar ya saal) to pehle user se poochho. Andaza mat lagao.
- Agar tool error de to user ko saaf batao ki kaun si jaankari galat ya kam hai.

SAHI HONE KE RULES
- Pehle samjho user kya poochh raha hai. Zaroori number na ho to ek chhota sawal poochho.
- SIP ya mutual fund ke return guarantee nahi hote. Aisa kuch dikhao to likho ki ye sirf andaza hai.
- Byaaj dar, tax slab, RBI/SEBI ke niyam, FD rate, sarkari scheme aksar badalte rehte hain. Agar pakka na pata ho to number mat banao. Seedha bolo "ye badalta rehta hai, bank ya official site par check karo".
- Jo nahi pata, saaf bolo ki nahi pata. Galat jawab dene se behtar hai ki "pakka nahi pata" bolo.

LIMIT
- Tum licensed financial advisor nahi ho. Kisi specific share, fund ya trade ko kharidne/bechne ki confident salah mat do. Sirf jaankari, tulna aur risk samjhao. Bade nivesh, loan ya tax ke faisle par SEBI-registered advisor ya CA se milne ko kaho.
- Finance ke alawa sawal par bhi chhota aur madadgaar jawab do, lekin finance par zyada dhyaan rakho.
- Agar user photo ya file bheje (bill, statement, loan paper), use dhyaan se padho. Jo clearly dikh raha hai wahi batao, andaza mat lagao. Saaf na dikhe to bolo.
- Kisi ka OTP, PIN, password, card number ya CVV kabhi mat maango aur user ko ye share karne se roko.`;

function sys() {
  const today = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric',
  });
  return SYSTEM + '\n\nAaj ki tareekh (India): ' + today + '.';
}

const TIMEOUT = 20000;
const GEMINI_TIMEOUT = 15000;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_MEDIA_CHARS = 4000000;

/* ---------------- Calculator tools (code hisaab karta hai, AI nahi) ---------------- */
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const r2 = n => Math.round(n * 100) / 100;
function num(v, name) {
  const x = Number(v);
  if (v === undefined || v === null || v === '' || !isFinite(x)) {
    throw new Error(name + ' missing ya galat hai');
  }
  return x;
}

const DEFS = [
  {
    name: 'calc_emi',
    description: 'Loan ki monthly EMI, total byaaj aur total payment nikalta hai (home, car, personal loan).',
    params: {
      principal: 'Loan ki rashi rupaye mein',
      annual_rate: 'Saalana byaaj dar, percent mein (jaise 8.5)',
      years: 'Loan ki avadhi saal mein (optional, agar months na do)',
      months: 'Loan ki avadhi mahine mein (optional)',
    },
    required: ['principal', 'annual_rate'],
    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const n = a.months != null && a.months !== '' ? num(a.months, 'months') : num(a.years, 'years') * 12;
      if (P <= 0 || n <= 0 || rate < 0 || rate > 100) throw new Error('rashi, dar ya avadhi galat hai');
      const r = rate / 1200;
      const emi = r === 0 ? P / n : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      return {
        monthly_emi: inr(emi), monthly_emi_exact: r2(emi), months: n,
        total_payment: inr(emi * n), total_interest: inr(emi * n - P),
      };
    },
  },
  {
    name: 'calc_sip',
    description: 'Monthly SIP ka future value (andaza), kul nivesh aur gain nikalta hai. Return guarantee nahi hota.',
    params: {
      monthly_amount: 'Har mahine ki SIP rashi rupaye mein',
      annual_return: 'Maane gaye saalana return, percent mein (jaise 12)',
      years: 'Kitne saal tak SIP chalegi',
    },
    required: ['monthly_amount', 'annual_return', 'years'],
    run(a) {
      const P = num(a.monthly_amount, 'monthly_amount');
      const rate = num(a.annual_return, 'annual_return');
      const years = num(a.years, 'years');
      if (P <= 0 || years <= 0 || rate < -50 || rate > 100) throw new Error('rashi, return ya saal galat hai');
      const n = years * 12, r = rate / 1200;
      const fv = r === 0 ? P * n : P * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
      return { total_invested: inr(P * n), future_value: inr(fv), estimated_gain: inr(fv - P * n) };
    },
  },
  {
    name: 'calc_lumpsum',
    description: 'Ek baar ke nivesh ya FD ka maturity amount nikalta hai (compound interest).',
    params: {
      principal: 'Nivesh ki rashi rupaye mein',
      annual_rate: 'Saalana dar, percent mein',
      years: 'Kitne saal',
      compounds_per_year: 'Saal mein kitni baar byaaj judta hai. Default 1. FD mein aksar 4 (quarterly).',
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const t = num(a.years, 'years');
      const m = a.compounds_per_year != null && a.compounds_per_year !== '' ? num(a.compounds_per_year, 'compounds_per_year') : 1;
      if (P <= 0 || t <= 0 || m <= 0 || rate < -50 || rate > 100) throw new Error('rashi, dar ya saal galat hai');
      const mat = P * Math.pow(1 + rate / 100 / m, m * t);
      return { maturity_amount: inr(mat), interest_earned: inr(mat - P) };
    },
  },
  {
    name: 'calc_cagr',
    description: 'CAGR (saalana chakravriddhi dar) nikalta hai.',
    params: {
      start_value: 'Shuruaati value rupaye mein',
      end_value: 'Antim value rupaye mein',
      years: 'Kitne saal mein',
    },
    required: ['start_value', 'end_value', 'years'],
    run(a) {
      const s = num(a.start_value, 'start_value');
      const e = num(a.end_value, 'end_value');
      const y = num(a.years, 'years');
      if (s <= 0 || e <= 0 || y <= 0) throw new Error('value ya saal galat hai');
      return { cagr_percent: r2((Math.pow(e / s, 1 / y) - 1) * 100) };
    },
  },
  {
    name: 'calc_simple_interest',
    description: 'Simple interest (saada byaaj) nikalta hai.',
    params: {
      principal: 'Rashi rupaye mein',
      annual_rate: 'Saalana dar, percent mein',
      years: 'Kitne saal',
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const t = num(a.years, 'years');
      if (P <= 0 || t <= 0 || rate < 0 || rate > 100) throw new Error('rashi, dar ya saal galat hai');
      const i = (P * rate * t) / 100;
      return { interest: inr(i), total_amount: inr(P + i) };
    },
  },
];

function schema(d) {
  const properties = {};
  Object.keys(d.params).forEach(k => (properties[k] = { type: 'number', description: d.params[k] }));
  return { type: 'object', properties, required: d.required };
}

function runTool(name, args) {
  const d = DEFS.find(x => x.name === name);
  if (!d) return { error: 'Ye tool nahi hai: ' + name };
  try {
    return d.run(args || {});
  } catch (e) {
    return { error: e.message };
  }
}

const OPENAI_TOOLS = DEFS.map(d => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: schema(d) },
}));
const GEMINI_TOOLS = [
  { functionDeclarations: DEFS.map(d => ({ name: d.name, description: d.description, parameters: schema(d) })) },
];

/* ---------------- Providers ---------------- */
async function fail(name, r) {
  let body = '';
  try { body = (await r.text()).slice(0, 200); } catch (e) {}
  throw new Error(`${name} ${r.status} ${body}`);
}

const plain = messages => messages.map(m => ({ role: m.role, content: m.content }));

// Groq aur OpenRouter dono OpenAI jaisa format use karte hain
async function openaiChat({ name, url, key, model, extra, messages }) {
  const convo = [{ role: 'system', content: sys() }, ...plain(messages)];
  let useTools = true;
  for (let i = 0; i < 5; i++) {
    const body = { model, messages: convo, ...extra };
    if (useTools) { body.tools = OPENAI_TOOLS; body.tool_choice = 'auto'; }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) {
      if (useTools && r.status === 400) { useTools = false; continue; }
      await fail(name, r);
    }
    const msg = (await r.json()).choices?.[0]?.message;
    if (!msg) throw new Error(name + ' khali jawab');
    if (msg.tool_calls && msg.tool_calls.length) {
      convo.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(runTool(tc.function.name, args)) });
      }
      continue;
    }
    if (!msg.content) throw new Error(name + ' khali jawab');
    return msg.content;
  }
  throw new Error(name + ' tool loop khatam nahi hua');
}

const askGroq = messages =>
  openaiChat({
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: process.env.GROQ_API_KEY.trim(),
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    extra: { max_tokens: 2500, reasoning_effort: 'medium', temperature: 0.3 },
    messages,
  });

const askOpenRouter = messages =>
  openaiChat({
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: process.env.OPENROUTER_API_KEY.trim(),
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
    extra: { max_tokens: 1500, temperature: 0.3 },
    messages,
  });

async function geminiCall(model, messages, think) {
  const label = 'Gemini(' + model + ')';
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      { text: m.content },
      ...(m.attachments || []).map(a => ({ inlineData: { mimeType: a.mime, data: a.data } })),
    ],
  }));
  let useTools = true;
  for (let i = 0; i < 5; i++) {
    const cfg = { maxOutputTokens: 2048 };
    if (think) cfg.thinkingConfig = { thinkingLevel: 'low' };
    const body = { systemInstruction: { parts: [{ text: sys() }] }, contents, generationConfig: cfg };
    if (useTools) body.tools = GEMINI_TOOLS;
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY.trim() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT),
      }
    );
    if (!r.ok) {
      if (useTools && r.status === 400) { useTools = false; continue; }
      await fail(label, r);
    }
    const d = await r.json();
    const parts = d.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter(p => p.functionCall);
    if (calls.length) {
      // model ka poora jawab (thought signature ke saath) wapas bhejna zaroori hai
      contents.push({ role: 'model', parts });
      contents.push({
        role: 'user',
        parts: calls.map(p => ({
          functionResponse: {
            name: p.functionCall.name,
            response: { result: runTool(p.functionCall.name, p.functionCall.args) },
          },
        })),
      });
      continue;
    }
    const t = parts.map(p => p.text || '').join('');
    if (!t) throw new Error(label + ' khali jawab');
    return t;
  }
  throw new Error(label + ' tool loop khatam nahi hua');
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

const ALL = [
  { name: 'groq', env: 'GROQ_API_KEY', run: askGroq },
  { name: 'gemini', env: 'GEMINI_API_KEY', run: askGemini },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', run: askOpenRouter },
];

/* ---------------- Spam se bachav (rate limit) ---------------- */
// Note: ye har server instance ki apni memory mein chalta hai, isliye
// basic bachav hai. Bahut bade hamle ke liye Vercel ka Firewall/Upstash use karo.
const hits = new Map();
const PER_MIN = 8;
const PER_HOUR = 60;

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600000);
  const lastMin = arr.filter(t => now - t < 60000).length;
  if (lastMin >= PER_MIN || arr.length >= PER_HOUR) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > 3600000) hits.delete(k);
    }
  }
  return false;
}

/* ---------------- Handler ---------------- */
async function handler(req, res) {
  const keys = {};
  ALL.forEach(p => (keys[p.name] = !!(process.env[p.env] || '').trim()));

  // Browser mein /api/chat kholo to key status dikhega (key khud nahi dikhti)
  if (req.method === 'GET') return res.status(200).json({ keys });
  if (req.method !== 'POST') return res.status(405).json({ message: 'Sirf POST chalega' });

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown';
  if (limited(ip)) {
    return res.status(429).json({
      message: 'Bahut zyada sawal ek saath aa gaye. Thodi der (1 minute) ruko aur phir poochho.',
    });
  }

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
}

module.exports = handler;
module.exports.runTool = runTool; // sirf testing ke liye
