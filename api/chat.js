
const SYSTEM = `Tum Rupeyantra ke AI assistant ho. Rupeyantra ek Indian finance/paisa website hai. Tumhara kaam hai Bharat ke users ko paise ke sawalon mein sahi, saaf aur bharose layak madad dena.

BHASHA AUR STYLE
- Hinglish (Roman Hindi) mein jawab do, jab tak user kisi aur bhasha mein na likhe.
- Dosti bhare, seedhe aur chhote jawab do. Phone par padhne layak jawab do.
- Markdown mat use karo. Sirf saada text, line breaks aur 1. 2. jaisi list.
- Rupaye ₹ mein aur Indian number format mein likho: 1,50,000 ya 1.5 lakh, 2 crore.

CALCULATOR RULES
- EMI, SIP, lumpsum/FD maturity, CAGR aur simple interest ke liye HAMESHA calculator tool use karo.
- In calculations ko apne aap dimaag se mat karo.
- Hisaab se pehle zaroori inputs check karo. Koi zaroori input missing ho to user se poochho.
- Tool error de to number khud se mat banao. User ko saaf batao ki input ya calculation mein problem hai.
- Tool ka result jaisa mila hai, usi ke mutabik batao.
- Pehle ek line mein assumptions batao, phir result do.
- SIP/mutual fund returns sirf andaze hain, guaranteed nahi.

SAHI HONE KE RULES
- Byaaj dar, tax slab, RBI/SEBI ke niyam aur FD/sarkari scheme ke rates badal sakte hain. Pakka pata na ho to number mat banao.
- Jo nahi pata, saaf bolo ki pakka nahi pata.
- Photo/file mein jo saaf dikh raha hai sirf wahi batao.
- OTP, PIN, password, card number ya CVV kabhi mat maango.

FINANCIAL LIMITS
- Tum licensed financial advisor nahi ho.
- Kisi specific share, fund ya trade ko kharidne/bechne ki confident salah mat do.
- Jaankari, comparison aur risk samjhao.
- Bade nivesh, loan ya tax decisions ke liye SEBI-registered advisor ya CA se salah lene ko kaho.
- Finance ke alawa sawalon ka bhi chhota aur madadgaar jawab do.`;

function sys() {
  const today = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return SYSTEM + '\n\nAaj ki tareekh (India): ' + today + '.';
}

const TIMEOUT = 20000;
const GEMINI_TIMEOUT = 15000;
const MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];
const MAX_MEDIA_CHARS = 4000000;

/* ---------------- Calculator tools ---------------- */

const inr = n =>
  '₹' + Math.round(n).toLocaleString('en-IN');

const r2 = n =>
  Math.round(n * 100) / 100;

function num(v, name) {
  const x = Number(v);

  if (
    v === undefined ||
    v === null ||
    v === '' ||
    !Number.isFinite(x)
  ) {
    throw new Error(name + ' missing ya galat hai');
  }

  return x;
}

const DEFS = [
  {
    name: 'calc_emi',
    description:
      'Loan ki monthly EMI, total interest aur total payment calculate karta hai.',
    params: {
      principal: 'Loan ki rashi rupaye mein',
      annual_rate: 'Saalana byaaj dar percent mein',
      years: 'Loan ki avadhi saal mein. Zaroori hai.',
      months: 'Loan ki avadhi mahine mein. Diya ho to years se pehle use hoga.',
    },
    required: ['principal', 'annual_rate', 'years'],

    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');

      const n =
        a.months !== undefined &&
        a.months !== null &&
        a.months !== ''
          ? num(a.months, 'months')
          : num(a.years, 'years') * 12;

      if (
        P <= 0 ||
        n <= 0 ||
        rate < 0 ||
        rate > 100 ||
        !Number.isFinite(n)
      ) {
        throw new Error('Rashi, dar ya avadhi galat hai');
      }

      const r = rate / 1200;

      const emi =
        r === 0
          ? P / n
          : (P * r * Math.pow(1 + r, n)) /
            (Math.pow(1 + r, n) - 1);

      return {
        monthly_emi: inr(emi),
        monthly_emi_exact: r2(emi),
        months: n,
        total_payment: inr(emi * n),
        total_interest: inr(emi * n - P),
      };
    },
  },

  {
    name: 'calc_sip',
    description:
      'Monthly SIP ka estimated future value, total invested amount aur estimated gain calculate karta hai. Returns guaranteed nahi hain.',
    params: {
      monthly_amount: 'Har mahine ki SIP rashi rupaye mein',
      annual_return: 'Maana gaya saalana return percent mein',
      years: 'Kitne saal tak SIP chalegi',
    },
    required: ['monthly_amount', 'annual_return', 'years'],

    run(a) {
      const P = num(a.monthly_amount, 'monthly_amount');
      const rate = num(a.annual_return, 'annual_return');
      const years = num(a.years, 'years');

      if (
        P <= 0 ||
        years <= 0 ||
        rate < -50 ||
        rate > 100
      ) {
        throw new Error('Rashi, return ya saal galat hai');
      }

      const n = years * 12;
      const r = rate / 1200;

      const fv =
        r === 0
          ? P * n
          : P * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);

      return {
        total_invested: inr(P * n),
        future_value: inr(fv),
        estimated_gain: inr(fv - P * n),
        disclaimer: 'Yeh estimate hai, guaranteed return nahi.',
      };
    },
  },

  {
    name: 'calc_lumpsum',
    description:
      'Ek baar ke nivesh ya FD ka compound-interest maturity amount calculate karta hai.',
    params: {
      principal: 'Nivesh ki rashi rupaye mein',
      annual_rate: 'Saalana dar percent mein',
      years: 'Kitne saal',
      compounds_per_year:
        'Saal mein kitni baar interest compound hota hai. Default 4, yani quarterly.',
    },
    required: ['principal', 'annual_rate', 'years'],

    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const t = num(a.years, 'years');

      const m =
        a.compounds_per_year !== undefined &&
        a.compounds_per_year !== null &&
        a.compounds_per_year !== ''
          ? num(a.compounds_per_year, 'compounds_per_year')
          : 4;

      if (
        P <= 0 ||
        t <= 0 ||
        m <= 0 ||
        !Number.isInteger(m) ||
        rate < -50 ||
        rate > 100
      ) {
        throw new Error('Rashi, dar, avadhi ya compounding frequency galat hai');
      }

      const mat = P * Math.pow(1 + rate / 100 / m, m * t);

      return {
        maturity_amount: inr(mat),
        interest_earned: inr(mat - P),
        compounding_per_year: m,
      };
    },
  },

  {
    name: 'calc_cagr',
    description:
      'Investment ki starting aur ending value se annual CAGR calculate karta hai.',
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

      if (s <= 0 || e <= 0 || y <= 0) {
        throw new Error('Value ya saal galat hai');
      }

      return {
        cagr_percent: r2((Math.pow(e / s, 1 / y) - 1) * 100),
      };
    },
  },

  {
    name: 'calc_simple_interest',
    description:
      'Principal, annual interest rate aur years se simple interest calculate karta hai.',
    params: {
      principal: 'Rashi rupaye mein',
      annual_rate: 'Saalana dar percent mein',
      years: 'Kitne saal',
    },
    required: ['principal', 'annual_rate', 'years'],

    run(a) {
      const P = num(a.principal, 'principal');
      const rate = num(a.annual_rate, 'annual_rate');
      const t = num(a.years, 'years');

      if (
        P <= 0 ||
        t <= 0 ||
        rate < 0 ||
        rate > 100
      ) {
        throw new Error('Rashi, dar ya saal galat hai');
      }

      const interest = (P * rate * t) / 100;

      return {
        interest: inr(interest),
        total_amount: inr(P + interest),
      };
    },
  },
];

function schema(d) {
  const properties = {};

  for (const [key, description] of Object.entries(d.params)) {
    properties[key] = {
      type: 'number',
      description,
    };
  }

  return {
    type: 'object',
    properties,
    required: d.required,
  };
}

function runTool(name, args) {
  const d = DEFS.find(x => x.name === name);

  if (!d) {
    return { error: 'Unknown calculator tool: ' + name };
  }

  try {
    return d.run(args || {});
  } catch (e) {
    return { error: e.message || 'Calculation error' };
  }
}

const OPENAI_TOOLS = DEFS.map(d => ({
  type: 'function',
  function: {
    name: d.name,
    description: d.description,
    parameters: schema(d),
  },
}));

const GEMINI_TOOLS = [
  {
    functionDeclarations: DEFS.map(d => ({
      name: d.name,
      description: d.description,
      parameters: schema(d),
    })),
  },
];

/* ---------------- Shared helpers ---------------- */

async function fail(name, response) {
  let body = '';

  try {
    body = (await response.text()).slice(0, 300);
  } catch (_) {}

  throw new Error(`${name} ${response.status} ${body}`);
}

const plain = messages =>
  messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

/* ---------------- OpenAI-compatible providers ---------------- */

async function openaiChat({
  name,
  url,
  key,
  model,
  extra,
  messages,
}) {
  if (!key) {
    throw new Error(name + ' API key missing');
  }

  const convo = [
    { role: 'system', content: sys() },
    ...plain(messages),
  ];

  for (let i = 0; i < 5; i++) {
    const body = {
      model,
      messages: convo,
      ...extra,
      tools: OPENAI_TOOLS,
      tool_choice: 'auto',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!response.ok) {
      await fail(name, response);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message;

    if (!msg) {
      throw new Error(name + ' se khali jawab mila');
    }

    if (msg.tool_calls?.length) {
      convo.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        let args;

        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch (_) {
          args = {};
        }

        const result = runTool(tc.function.name, args);

        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }

      continue;
    }

    if (typeof msg.content !== 'string' || !msg.content.trim()) {
      throw new Error(name + ' se khali jawab mila');
    }

    return msg.content;
  }

  throw new Error(name + ' ka tool-call limit poora ho gaya');
}

const askGroq = messages =>
  openaiChat({
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: (process.env.GROQ_API_KEY || '').trim(),
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    extra: {
      max_tokens: 2500,
      temperature: 0.3,
    },
    messages,
  });

const askOpenRouter = messages =>
  openaiChat({
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: (process.env.OPENROUTER_API_KEY || '').trim(),
    model:
      process.env.OPENROUTER_MODEL ||
      'meta-llama/llama-3.3-70b-instruct',
    extra: {
      max_tokens: 1500,
      temperature: 0.3,
    },
    messages,
  });

/* ---------------- Gemini ---------------- */

async function geminiCall(model, messages, think) {
  const label = 'Gemini(' + model + ')';
  const key = (process.env.GEMINI_API_KEY || '').trim();

  if (!key) {
    throw new Error('GEMINI_API_KEY missing');
  }

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      { text: m.content },
      ...(m.attachments || []).map(a => ({
        inlineData: {
          mimeType: a.mime,
          data: a.data,
        },
      })),
    ],
  }));

  for (let i = 0; i < 5; i++) {
    const generationConfig = {
      maxOutputTokens: 2048,
    };

    if (think) {
      generationConfig.thinkingConfig = {
        thinkingLevel: 'low',
      };
    }

    const body = {
      systemInstruction: {
        parts: [{ text: sys() }],
      },
      contents,
      generationConfig,
      tools: GEMINI_TOOLS,
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT),
      }
    );

    if (!response.ok) {
      await fail(label, response);
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter(p => p.functionCall);

    if (calls.length) {
      // Original model parts ko preserve karna zaroori hai.
      contents.push({
        role: 'model',
        parts,
      });

      contents.push({
        role: 'user',
        parts: calls.map(p => ({
          functionResponse: {
            name: p.functionCall.name,
            response: {
              result: runTool(
                p.functionCall.name,
                p.functionCall.args || {}
              ),
            },
          },
        })),
      });

      continue;
    }

    const answer = parts
      .map(p => p.text || '')
      .join('')
      .trim();

    if (!answer) {
      throw new Error(label + ' se khali jawab mila');
    }

    return answer;
  }

  throw new Error(label + ' ka tool-call limit poora ho gaya');
}

async function askGemini(messages) {
  const attempts = [
    {
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      think: true,
    },
    {
      model: 'gemini-3.5-flash-lite',
      think: false,
    },
    {
      model: 'gemini-3.7-flash',
      think: false,
    },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      return await geminiCall(
        attempt.model,
        messages,
        attempt.think
      );
    } catch (e) {
      console.error('Gemini attempt failed:', e.message);
      errors.push(e.message);
    }
  }

  throw new Error(errors.join(' | '));
}

/* ---------------- Providers ---------------- */

const ALL = [
  {
    name: 'groq',
    env: 'GROQ_API_KEY',
    run: askGroq,
  },
  {
    name: 'gemini',
    env: 'GEMINI_API_KEY',
    run: askGemini,
  },
  {
    name: 'openrouter',
    env: 'OPENROUTER_API_KEY',
    run: askOpenRouter,
  },
];

/* ---------------- Basic rate limiting ---------------- */

// Ye per-server-instance rate limit hai.
// Multiple instances par shared limit ke liye Redis/Upstash ya
// Vercel Firewall ka istemal karo.

const hits = new Map();
const PER_MIN = 8;
const PER_HOUR = 60;

function limited(ip) {
  const now = Date.now();

  const arr = (hits.get(ip) || []).filter(
    t => now - t < 3600000
  );

  const lastMin = arr.filter(
    t => now - t < 60000
  ).length;

  if (lastMin >= PER_MIN || arr.length >= PER_HOUR) {
    hits.set(ip, arr);
    return true;
  }

  arr.push(now);
  hits.set(ip, arr);

  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (
        !times.length ||
        now - times[times.length - 1] > 3600000
      ) {
        hits.delete(key);
      }
    }
  }

  return false;
}

/* ---------------- Handler ---------------- */

async function handler(req, res) {
  const keys = {};

  for (const provider of ALL) {
    keys[provider.name] = Boolean(
      (process.env[provider.env] || '').trim()
    );
  }

  // Sirf key status batata hai, key value kabhi nahi.
  if (req.method === 'GET') {
    return res.status(200).json({ keys });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');

    return res.status(405).json({
      message: 'Sirf GET aur POST requests allowed hain.',
    });
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : '') ||
    req.socket?.remoteAddress ||
    'unknown';

  if (limited(ip)) {
    return res.status(429).json({
      message:
        'Bahut zyada sawal aa gaye hain. Thodi der ruk kar dobara try karo.',
    });
  }

  const incoming = Array.isArray(req.body?.messages)
    ? req.body.messages.slice(-20)
    : [];

  const clean = incoming
    .filter(
      m =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    )
    .map(m => {
      const out = {
        role: m.role,
        content: m.content.slice(0, 20000),
      };

      if (m.role === 'user' && Array.isArray(m.attachments)) {
        const attachments = m.attachments
          .filter(
            a =>
              a &&
              MEDIA_TYPES.includes(a.mime) &&
              typeof a.data === 'string' &&
              a.data.length > 0
          )
          .slice(0, 3)
          .map(a => ({
            mime: a.mime,
            data: a.data,
          }));

        if (attachments.length) {
          out.attachments = attachments;
        }
      }

      return out;
    });

  if (
    !clean.length ||
    clean[clean.length - 1].role !== 'user'
  ) {
    return res.status(400).json({
      message: 'Request galat hai. Dobara try karo.',
    });
  }

  const mediaSize = clean.reduce(
    (total, message) =>
      total +
      (message.attachments || []).reduce(
        (sum, attachment) => sum + attachment.data.length,
        0
      ),
    0
  );

  if (mediaSize > MAX_MEDIA_CHARS) {
    return res.status(413).json({
      message:
        'Photo ya PDF bahut badi hai. Chhoti file bhej kar try karo.',
    });
  }

  const needsGemini = mediaSize > 0;

  // Photo/PDF ke liye Gemini required hai.
  // Text-only sawalon mein available providers fallback kar sakte hain.
  const providers = ALL.filter(
    provider =>
      keys[provider.name] &&
      (!needsGemini || provider.name === 'gemini')
  );

  if (!providers.length) {
    return res.status(500).json({
      message: needsGemini
        ? 'Photo/PDF ke liye GEMINI_API_KEY missing hai. Vercel Environment Variables mein add karke redeploy karo.'
        : 'Koi API key nahi mili. Vercel > Settings > Environment Variables mein GROQ_API_KEY, GEMINI_API_KEY ya OPENROUTER_API_KEY add karo, phir redeploy karo.',
      keys,
    });
  }

  const errors = [];

  for (const provider of providers) {
    try {
      const reply = await provider.run(clean);

      return res.status(200).json({
        reply,
        used: provider.name,
      });
    } catch (e) {
      console.error(
        `${provider.name} failed:`,
        e.message
      );

      errors.push(
        `${provider.name}: ${e.message}`
      );
    }
  }

  return res.status(500).json({
    message:
      'Saare AI providers fail ho gaye. API keys, model names aur provider limits check karo.',
    details: errors,
    keys,
  });
}

module.exports = handler;
module.exports.runTool = runTool;
