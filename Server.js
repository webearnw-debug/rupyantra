// Rupeyantra AI backend. API key sirf yahan (.env) mein rehti hai, kabhi frontend mein nahi.
require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '50kb' }));
const SITE = process.env.SITE_URL || 'https://YOUR-DOMAIN.com';
app.use(express.static('public', { maxAge: '1h' }));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE}/</loc></url>\n  <url><loc>${SITE}/ai</loc></url>\n</urlset>\n`));
app.get('/ai', (req, res) => res.sendFile(__dirname + '/public/ai.html'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `Tum Rupeyantra ke AI assistant ho. Rupeyantra ek finance/paisa website hai.
Hinglish (Roman Hindi) mein saaf, dosti bhare aur chhote jawab do, jab tak user kisi aur bhasha mein na likhe.
Jawab mobile par aasaani se padhne layak rakho. EMI, SIP, budget, bachat jaise finance sawalon mein madad karo
aur calculation step-by-step samjhao. Tum licensed financial advisor nahi ho, isliye specific invest/trade karne
ki confident salah mat do, sirf jaankari do aur zaroorat par SEBI-registered advisor se milne ko kaho.`;

// Simple rate limit: har IP se 20 requests / minute
const hits = new Map();
setInterval(() => hits.clear(), 60_000);

app.post('/api/chat', async (req, res) => {
  const ip = req.ip;
  hits.set(ip, (hits.get(ip) || 0) + 1);
  if (hits.get(ip) > 20) return res.status(429).json({ error: 'Too many requests' });

  const msgs = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [];
  const clean = msgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Bad request' });
  }

  // Hisaab / calculation wale sawal par AI pehle soch kar jawab deta hai (extended thinking)
  const last = clean[clean.length - 1].content.toLowerCase();
  const needsThinking = /\d|emi|sip|hisaab|calculat|nikal|kitna|kitni|byaaj|interest|return|loan|percent|%/.test(last);

  const base = { model: 'claude-sonnet-5-5', system: SYSTEM, messages: clean };
  const textOf = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  try {
    let r;
    if (needsThinking) {
      try {
        r = await client.messages.create({
          ...base,
          max_tokens: 3000,
          thinking: { type: 'enabled', budget_tokens: 1500 },
        });
      } catch (e) {
        // Agar thinking option kaam na kare to bina thinking ke jawab do
        console.error('thinking fallback:', e.message);
        r = await client.messages.create({ ...base, max_tokens: 700 });
      }
    } else {
      r = await client.messages.create({ ...base, max_tokens: 700 });
    }
    res.json({ reply: textOf(r) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'AI error' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Rupeyantra AI chal raha hai'));
