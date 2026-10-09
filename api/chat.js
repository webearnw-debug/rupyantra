const SYSTEM = `Tum Rupeyantra ke AI assistant ho, Indian finance website ke liye.
Default Hinglish (Roman Hindi) mein chhote, seedhe jawab do. User doosri bhasha use kare to usi mein jawab do. Markdown/table mat use karo. Rupaye ₹ aur Indian number format use karo.
EMI, SIP, FD/lumpsum, CAGR, simple interest, GST aur inflation ke liye calculator tool HAMESHA use karo. Zaroori input missing ho to poochho. Tool error ho to result invent mat karo. SIP/market returns guarantee nahi hain.
Photo ya PDF mile to usmein jo saaf dikhe wahi samjhao; kuch dikhe nahi to saaf bolo, andaza mat lagao.
Badalte interest rates, tax rules, RBI/SEBI rules ya government scheme details bina verified source ke mat banao. Tum licensed financial advisor nahi ho; specific share/fund ko buy/sell karne ki confident salah mat do. OTP, PIN, password, card number ya CVV kabhi mat maango.`;

function sys() {
  return SYSTEM + '\n\nAaj ki tareekh (India): ' +
    new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }) + '.';
}

const TIMEOUT = 15000;
const GEMINI_TIMEOUT = 15000;
const TOTAL_BUDGET = 45000; // vercel.json maxDuration (60s) se kam
const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 12000;
const MAX_ATTACHMENTS = 3;
const MAX_MEDIA_CHARS = 3500000; // base64 chars (total)
const MAX_REQUEST_CHARS = 4200000; // Vercel body limit 4.5 MB hai
const MAX_OUTPUT_TOKENS = 1200;
const GEMINI_OUTPUT_TOKENS = 2000;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const r2 = n => Math.round(n * 100) / 100;

function num(v, name) {
  if (v === undefined || v === null || v === '') {
    throw new Error(name + ' missing hai');
  }
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(name + ' galat hai');
  return x;
}

const DEFS = [
  {
    name: 'calc_emi',
    description: 'Loan ki EMI, total interest aur total payment calculate karta hai.',
    params: {
      principal: 'Loan amount rupaye mein',
      annual_rate: 'Annual interest rate percent mein',
      years: 'Loan term years mein; months na diya ho to zaroori',
      months: 'Loan term months mein; years ke badle use ho sakta hai'
    },
    required: ['principal', 'annual_rate'],
    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const n = a.months !== undefined && a.months !== null && a.months !== ''
        ? num(a.months, 'months')
        : num(a.years, 'years') * 12;

      if (P <= 0 || n <= 0 || n > 1200 || rate < 0 || rate > 100) {
        throw new Error('Rashi, dar ya avadhi galat hai');
      }

      const r = rate / 1200;
      const emi = r === 0
        ? P / n
        : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);

      return {
        monthly_emi: inr(emi),
        monthly_emi_exact: r2(emi),
        months: n,
        total_payment: inr(emi * n),
        total_interest: inr(emi * n - P)
      };
    }
  },
  {
    name: 'calc_sip',
    description: 'Monthly SIP ka estimated future value, invested amount aur gain. Returns guaranteed nahi.',
    params: {
      monthly_amount: 'Monthly SIP amount',
      annual_return: 'Assumed annual return percent',
      years: 'SIP duration years mein'
    },
    required: ['monthly_amount', 'annual_return', 'years'],
    run(a) {
      const P = num(a.monthly_amount, 'monthly_amount');
      const rate = num(a.annual_return, 'annual_return');
      const years = num(a.years, 'years');

      if (P <= 0 || years <= 0 || years > 100 || rate < -50 || rate > 100) {
        throw new Error('Rashi, return ya avadhi galat hai');
      }

      const n = years * 12;
      const r = rate / 1200;
      const fv = r === 0
        ? P * n
        : P * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);

      return {
        total_invested: inr(P * n),
        future_value: inr(fv),
        estimated_gain: inr(fv - P * n),
        note: 'Estimate hai; market returns guaranteed nahi.'
      };
    }
  },
  {
    name: 'calc_lumpsum',
    description: 'Lumpsum/FD compound-interest maturity calculate karta hai.',
    params: {
      principal: 'Investment amount',
      annual_rate: 'Annual interest rate percent',
      years: 'Duration years mein',
      compounds_per_year: 'Compounding per year; default 4 (quarterly)'
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const t = num(a.years, 'years');
      const m = a.compounds_per_year == null || a.compounds_per_year === ''
        ? 4
        : num(a.compounds_per_year, 'compounds_per_year');

      if (P <= 0 || t <= 0 || t > 100 || m <= 0 || m > 365 ||
          !Number.isInteger(m) || rate < -50 || rate > 100) {
        throw new Error('Rashi, dar, duration ya compounding galat hai');
      }

      const maturity = P * Math.pow(1 + rate / 100 / m, m * t);
      return {
        maturity_amount: inr(maturity),
        interest_earned: inr(maturity - P),
        compounds_per_year: m
      };
    }
  },
  {
    name: 'calc_cagr',
    description: 'Starting aur ending value se annual CAGR calculate karta hai.',
    params: {
      start_value: 'Starting value',
      end_value: 'Ending value',
      years: 'Duration years mein'
    },
    required: ['start_value', 'end_value', 'years'],
    run(a) {
      const s = num(a.start_value, 'start_value');
      const e = num(a.end_value, 'end_value');
      const y = num(a.years, 'years');

      if (s <= 0 || e <= 0 || y <= 0 || y > 100) {
        throw new Error('Value ya duration galat hai');
      }

      return { cagr_percent: r2((Math.pow(e / s, 1 / y) - 1) * 100) };
    }
  },
  {
    name: 'calc_simple_interest',
    description: 'Simple interest aur total amount calculate karta hai.',
    params: {
      principal: 'Principal amount',
      annual_rate: 'Annual interest rate percent',
      years: 'Duration years mein'
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const t = num(a.years, 'years');

      if (P <= 0 || t <= 0 || t > 100 || rate < 0 || rate > 100) {
        throw new Error('Rashi, dar ya duration galat hai');
      }

      const interest = P * rate * t / 100;
      return { interest: inr(interest), total_amount: inr(P + interest) };
    }
  },
  {
    name: 'calc_gst',
    description: 'GST amount aur total bill calculate karta hai. inclusive=1 jab GST amount mein included ho, otherwise 0.',
    params: {
      amount: 'Amount rupaye mein',
      gst_rate: 'GST rate percent mein',
      inclusive: '1 if GST included, otherwise 0'
    },
    required: ['amount', 'gst_rate', 'inclusive'],
    run(a) {
      const amount = num(a.amount, 'amount');
      const rate = num(a.gst_rate, 'gst_rate');
      const inc = num(a.inclusive, 'inclusive');

      if (amount < 0 || rate < 0 || rate > 100 || ![0, 1].includes(inc)) {
        throw new Error('Amount, GST rate ya inclusive value galat hai');
      }

      if (inc === 1) {
        const base = amount / (1 + rate / 100);
        return {
          base_amount: inr(base),
          gst_amount: inr(amount - base),
          total_amount: inr(amount),
          mode: 'GST included'
        };
      }

      const gst = amount * rate / 100;
      return {
        base_amount: inr(amount),
        gst_amount: inr(gst),
        total_amount: inr(amount + gst),
        mode: 'GST extra'
      };
    }
  },
  {
    name: 'calc_inflation',
    description: 'Assumed inflation se future cost estimate karta hai; future inflation guaranteed nahi.',
    params: {
      current_amount: 'Aaj ki amount rupaye mein',
      annual_inflation: 'Assumed annual inflation percent',
      years: 'Duration years mein'
    },
    required: ['current_amount', 'annual_inflation', 'years'],
    run(a) {
      const amount = num(a.current_amount, 'current_amount');
      const rate = num(a.annual_inflation, 'annual_inflation');
      const years = num(a.years, 'years');

      if (amount <= 0 || rate < -20 || rate > 100 || years <= 0 || years > 100) {
        throw new Error('Amount, inflation ya duration galat hai');
      }

      const future = amount * Math.pow(1 + rate / 100, years);
      return {
        future_cost_estimate: inr(future),
        extra_cost_estimate: inr(future - amount),
        note: 'Assumption-based estimate hai.'
      };
    }
  }
];

function schema(d, gemini = false) {
  const properties = {};
  for (const [k, description] of Object.entries(d.params)) {
    properties[k] = { type: gemini ? 'NUMBER' : 'number', description };
  }
  return gemini
    ? { type: 'OBJECT', properties, required: d.required }
    : { type: 'object', properties, required: d.required };
}

function runTool(name, args) {
  const d = DEFS.find(x => x.name === name);
  if (!d) return { error: 'Unknown tool: ' + name };
  try {
    return d.run(args || {});
  } catch (e) {
    return { error: e.message || 'Calculation error' };
  }
}

const OPENAI_TOOLS = DEFS.map(d => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: schema(d) }
}));

const GEMINI_TOOLS = [{
  functionDeclarations: DEFS.map(d => ({
    name: d.name,
    description: d.description,
    parameters: schema(d, true)
  }))
}];

async function fail(name, response) {
  let body = '';
  try {
    body = (await response.text()).slice(0, 300);
  } catch (_) {}
  throw new Error(`${name} HTTP ${response.status}: ${body}`);
}

/* Groq / OpenRouter (OpenAI-compatible) */
function toOpenAI(m) {
  const imgs = (m.attachments || []).filter(a => a.mime.startsWith('image/'));
  if (!imgs.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content },
      ...imgs.map(a => ({
        type: 'image_url',
        image_url: { url: `data:${a.mime};base64,${a.data}` }
      }))
    ]
  };
}

async function openaiChat({ name, url, key, model, messages }) {
  if (!key) throw new Error(name + ' API key missing');

  const convo = [{ role: 'system', content: sys() }, ...messages.map(toOpenAI)];

  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: convo,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        tools: OPENAI_TOOLS,
        tool_choice: 'auto'
      }),
      signal: AbortSignal.timeout(TIMEOUT)
    });

    if (!r.ok) await fail(name, r);

    const msg = (await r.json()).choices?.[0]?.message;
    if (!msg) throw new Error(name + ' se khali jawab mila');

    if (msg.tool_calls?.length) {
      convo.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls
      });

      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch (_) {}

        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(runTool(tc.function?.name, args))
        });
      }
      continue;
    }

    if (typeof msg.content !== 'string' || !msg.content.trim()) {
      throw new Error(name + ' se khali jawab mila');
    }

    return msg.content.trim();
  }

  throw new Error(name + ' tool-call limit poora ho gaya');
}

const askGroq = messages => openaiChat({
  name: 'Groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  key: (process.env.GROQ_API_KEY || '').trim(),
  model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  messages
});

const askOpenRouter = messages => openaiChat({
  name: 'OpenRouter',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  key: (process.env.OPENROUTER_API_KEY || '').trim(),
  model: messages.some(m => m.attachments?.length)
    ? (process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash')
    : (process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct'),
  messages
});

/* Gemini */
async function geminiCall(model, messages) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY missing');

  const contents = messages.map(m => {
    const parts = [];
    if (m.content && m.content.trim()) parts.push({ text: m.content });
    for (const a of m.attachments || []) {
      parts.push({ inlineData: { mimeType: a.mime, data: a.data } });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  // Gemini 2.5 mein thinking tokens bhi maxOutputTokens mein ginte hain.
  // Isliye thinking band: warna photo par jawab khali aa sakta hai.
  const generationConfig = {
    maxOutputTokens: GEMINI_OUTPUT_TOKENS,
    temperature: 0.2
  };
  if (!/pro/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  for (let i = 0; i < 5; i++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys() }] },
          contents,
          generationConfig,
          tools: GEMINI_TOOLS
        }),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT)
      }
    );

    if (!r.ok) await fail('Gemini(' + model + ')', r);

    const data = await r.json();
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const calls = parts.filter(p => p.functionCall);

    if (calls.length) {
      contents.push({ role: 'model', parts });
      contents.push({
        role: 'user',
        parts: calls.map(p => ({
          functionResponse: {
            name: p.functionCall.name,
            response: {
              result: runTool(p.functionCall.name, p.functionCall.args || {})
            }
          }
        }))
      });
      continue;
    }

    const answer = parts
      .filter(p => !p.thought)
      .map(p => p.text || '')
      .join('')
      .trim();

    if (!answer) {
      const why = data.promptFeedback?.blockReason || cand?.finishReason || 'unknown';
      throw new Error('Gemini(' + model + ') se khali jawab mila (' + why + ')');
    }
    return answer;
  }

  throw new Error('Gemini tool-call limit poora ho gaya');
}

async function askGemini(messages) {
  const models = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ])];

  const errors = [];

  for (const model of models) {
    try {
      return await geminiCall(model, messages);
    } catch (e) {
      console.error('Gemini attempt failed:', e.message);
      errors.push(e.message);
    }
  }

  throw new Error(errors.join(' | '));
}

// media: false = sirf text, 'image' = photo chalegi (PDF nahi), 'all' = photo + PDF
const ALL = [
  { name: 'groq', env: 'GROQ_API_KEY', media: false, run: askGroq },
  { name: 'gemini', env: 'GEMINI_API_KEY', media: 'all', run: askGemini },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', media: 'image', run: askOpenRouter }
];

/* Basic per-instance rate limit.
   Production scale par Upstash/Redis ya firewall use karo. */
const hits = new Map();
const PER_MIN = 10;
const PER_HOUR = 60;

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600000);
  const lastMinute = arr.filter(t => now - t < 60000).length;

  if (lastMinute >= PER_MIN || arr.length >= PER_HOUR) {
    hits.set(ip, arr);
    return true;
  }

  arr.push(now);
  hits.set(ip, arr);

  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] > 3600000) {
        hits.delete(k);
      }
    }
  }

  return false;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const keys = {};
  for (const p of ALL) {
    keys[p.name] = Boolean((process.env[p.env] || '').trim());
  }

  if (req.method === 'GET') {
    return res.status(200).json({ keys });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ message: 'Sirf GET aur POST allowed hain.' });
  }

  let requestBytes;
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
  } catch (_) {
    requestBytes = MAX_REQUEST_CHARS + 1;
  }

  if (requestBytes > MAX_REQUEST_CHARS) {
    return res.status(413).json({
      message: 'Request bahut badi hai. Chhota message ya file bhejo.'
    });
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    (typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : '') ||
    req.socket?.remoteAddress ||
    'unknown';

  if (limited(ip)) {
    return res.status(429).json({
      message: 'Bahut zyada sawal aa gaye hain. Ek minute ruk kar try karo.'
    });
  }

  const incoming = Array.isArray(req.body?.messages)
    ? req.body.messages.slice(-MAX_MESSAGES)
    : [];

  const clean = incoming
    .filter(m =>
      m &&
      ['user', 'assistant'].includes(m.role) &&
      typeof m.content === 'string'
    )
    .map(m => {
      const out = { role: m.role, content: m.content.slice(0, MAX_CONTENT_CHARS) };

      if (m.role === 'user' && Array.isArray(m.attachments)) {
        const attachments = m.attachments
          .filter(a =>
            a &&
            MEDIA_TYPES.includes(a.mime) &&
            typeof a.data === 'string' &&
            a.data.length > 0 &&
            a.data.length <= MAX_MEDIA_CHARS &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(a.data)
          )
          .slice(0, MAX_ATTACHMENTS)
          .map(a => ({ mime: a.mime, data: a.data }));

        if (attachments.length) out.attachments = attachments;
      }

      return out;
    })
    .filter(m => m.content.trim() || m.attachments);

  // Conversation hamesha user message se shuru ho
  while (clean.length && clean[0].role === 'assistant') clean.shift();

  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({
      message: 'Request galat hai. Naya sawal bhejo.'
    });
  }

  // Photo/PDF sirf sabse naye message ki jaati hai; purani history se hata do.
  // (Warna har baar purani photo dobara jaati hai aur sab fail hone lagta hai.)
  const last = clean.length - 1;
  clean.forEach((m, i) => {
    if (i !== last && m.attachments) {
      delete m.attachments;
      if (!m.content.trim()) m.content = '[Pehle ek photo/file bheji gayi thi]';
    }
  });

  // Sirf photo bheji ho (text nahi) to Gemini khali text part reject karta hai
  if (!clean[last].content.trim()) {
    clean[last].content = 'Is attachment ko dekho aur batao isme kya hai.';
  }

  const media = clean[last].attachments || [];
  const mediaSize = media.reduce((s, a) => s + a.data.length, 0);

  if (mediaSize > MAX_MEDIA_CHARS) {
    return res.status(413).json({
      message: 'Photo/PDF bahut badi hai. Chhoti file bhejo.'
    });
  }

  const hasMedia = media.length > 0;
  const hasPdf = media.some(a => a.mime === 'application/pdf');

  const providers = ALL.filter(p =>
    keys[p.name] &&
    (!hasMedia ||
      p.media === 'all' ||
      (p.media === 'image' && !hasPdf))
  );

  if (!providers.length) {
    return res.status(500).json({
      message: hasMedia
        ? 'Photo/PDF ke liye GEMINI_API_KEY (ya photo ke liye OPENROUTER_API_KEY) chahiye. Vercel Environment Variables mein add karke redeploy karo.'
        : 'Koi AI API key nahi mili. Vercel Environment Variables mein kam se kam ek provider ki key add karo.',
      keys
    });
  }

  const errors = [];
  const started = Date.now();

  for (const p of providers) {
    if (Date.now() - started > TOTAL_BUDGET) {
      errors.push(p.name + ': time limit se skip');
      continue;
    }
    try {
      const reply = await p.run(clean);
      return res.status(200).json({ reply, used: p.name });
    } catch (e) {
      console.error(p.name + ' failed:', e.message);
      errors.push(p.name + ': ' + e.message);
    }
  }

  return res.status(502).json({
    message: 'Saare AI providers fail ho gaye. Thodi der baad dobara try karo.',
    details: errors,
    keys
  });
}

module.exports = handler;
module.exports.runTool = runTool;
