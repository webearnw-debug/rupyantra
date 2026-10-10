'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/finance-engine');
const handler = require('../api/chat');
const { post, answerWith, limited, sanitize } = handler.__test;

const realFetch = global.fetch;
const KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEBUG_ERRORS'];
const savedEnv = {};
KEYS.forEach(k => { savedEnv[k] = process.env[k]; });

function reset() {
  global.fetch = realFetch;
  KEYS.forEach(k => {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  });
}

const okRes = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const badRes = (status, text = '') => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}), text: async () => text });

function mockRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

let ipCounter = 0;
const req = (messages, extra = {}) => ({
  method: 'POST',
  headers: { 'x-forwarded-for': '10.0.0.' + (++ipCounter) },
  body: { messages },
  ...extra
});

/* ---------- sanitize ---------- */

test('sanitize: leading assistant dropped, old attachments removed, default text added', () => {
  const att = { mime: 'image/png', data: 'AAAA' };
  const out = sanitize([
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'pehla', attachments: [att] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '', attachments: [att] }
  ]);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].attachments, undefined);
  assert.ok(out[out.length - 1].attachments.length === 1);
  assert.ok(out[out.length - 1].content.length > 0);
});

test('sanitize: invalid mime, bad base64 and junk messages are dropped', () => {
  const out = sanitize([
    null,
    { role: 'system', content: 'x' },
    { role: 'user', content: 'hi', attachments: [{ mime: 'text/html', data: 'AAAA' }, { mime: 'image/png', data: 'not base64!' }] }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].attachments, undefined);
});

/* ---------- post: retry / timeout ---------- */

test('post: retries once on 503 and then succeeds', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => (++n === 1 ? badRes(503) : okRes({ ok: 1 }));
  const r = await post('T', 'http://x', {}, {}, Date.now() + 10000);
  assert.equal(r.ok, true);
  assert.equal(n, 2);
});

test('post: no retry on 400', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return badRes(400, 'bad'); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000), /HTTP 400/);
  assert.equal(n, 1);
});

test('post: gives up after retries on persistent 500', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return badRes(500); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000), /HTTP 500/);
  assert.equal(n, 2);
});

test('post: timeout is reported as timeout', async t => {
  t.after(reset);
  global.fetch = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000), /timeout/);
});

test('post: expired deadline fails fast without calling fetch', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return okRes({}); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 100));
  assert.equal(n, 0);
});

/* ---------- rate limit ---------- */

test('limited: 11th request in a minute from one IP is blocked', () => {
  const ip = 'rl-test-ip';
  for (let i = 0; i < 10; i++) assert.equal(limited(ip), false);
  assert.equal(limited(ip), true);
  assert.equal(limited('another-ip'), false);
});

/* ---------- answerWith: verification + tool enforcement ---------- */

const EMI_ARGS = { principal: 5000000, annual_rate: 8.5, years: 20 };
const EMI_MSG = [{ role: 'user', content: '50 lakh ka home loan 8.5% par 20 saal ke liye EMI kitni hogi?' }];
const emiCall = () => ({ name: 'calc_emi', args: EMI_ARGS, result: engine.runTool('calc_emi', EMI_ARGS) });
const envFor = messages => ({ ctx: engine.buildContext(messages), verification: undefined, hasMedia: false, deadline: Date.now() + 40000 });

test('answerWith: correct reply passes', async () => {
  const call = emiCall();
  const provider = { run: async () => ({ text: 'Aapki EMI ' + call.result.monthly_emi + ' hogi.', calls: [call] }) };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.equal(out.checked, true);
  assert.ok(!out.fallback);
});

test('answerWith: fabricated number is replaced by calculator fallback', async () => {
  const call = emiCall();
  let runs = 0;
  const provider = { run: async () => { runs++; return { text: 'Aapki EMI ₹99,999 hogi.', calls: [call] }; } };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.equal(out.fallback, true);
  assert.ok(out.text.includes(call.result.monthly_emi));
  assert.ok(!out.text.includes('99,999'));
  assert.equal(runs, 2); // ek correction retry
});

test('answerWith: forces the tool when model skipped it', async () => {
  const call = emiCall();
  const seen = [];
  const provider = {
    run: async (m, opts) => {
      seen.push(!!opts.force);
      return opts.force
        ? { text: 'EMI ' + call.result.monthly_emi, calls: [call] }
        : { text: 'EMI lagbhag ₹45,000 hogi', calls: [] };
    }
  };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.deepEqual(seen.slice(0, 2), [false, true]);
  assert.ok(!out.fallback);
});

test('answerWith: unverified rate topic never returns a made-up number', async () => {
  const msgs = [{ role: 'user', content: 'repo rate kya hai' }];
  const env = { ...envFor(msgs), verification: { status: 'unverified' } };
  const provider = { run: async () => ({ text: 'Repo rate 6.5% hai.', calls: [] }) };
  const out = await answerWith(provider, msgs, env);
  assert.equal(out.fallback, true);
  assert.match(out.text, /verify nahi/);
  assert.ok(!/6\.5/.test(out.text));
});

test('answerWith: no retry when time budget is almost over', async () => {
  const call = emiCall();
  let runs = 0;
  const provider = { run: async () => { runs++; return { text: 'EMI ₹99,999', calls: [call] }; } };
  const env = { ...envFor(EMI_MSG), deadline: Date.now() + 3000 };
  const out = await answerWith(provider, EMI_MSG, env);
  assert.equal(runs, 1);
  assert.equal(out.fallback, true);
});

/* ---------- handler ---------- */

test('handler: GET health check and bad method', async () => {
  const g = mockRes();
  await handler({ method: 'GET', headers: {} }, g);
  assert.equal(g.code, 200);
  const d = mockRes();
  await handler({ method: 'DELETE', headers: {} }, d);
  assert.equal(d.code, 405);
});

test('handler: no API keys => simple 503', async t => {
  t.after(reset);
  KEYS.forEach(k => delete process.env[k]);
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'hi' }]), res);
  assert.equal(res.code, 503);
  assert.ok(res.body.message);
});

test('handler: empty or assistant-last conversation => 400', async t => {
  t.after(reset);
  process.env.GROQ_API_KEY = 'x';
  const res = mockRes();
  await handler(req([]), res);
  assert.equal(res.code, 400);
});

test('handler: provider failure returns simple error, no internal details', async t => {
  t.after(reset);
  delete process.env.DEBUG_ERRORS;
  process.env.GROQ_API_KEY = 'x';
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  global.fetch = async () => badRes(400, 'SECRET-INTERNAL-DETAIL');
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 502);
  assert.ok(!JSON.stringify(res.body).includes('SECRET'));
  assert.equal(res.body.debug, undefined);
});

test('handler: DEBUG_ERRORS=1 exposes provider errors', async t => {
  t.after(reset);
  process.env.DEBUG_ERRORS = '1';
  process.env.GROQ_API_KEY = 'x';
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  global.fetch = async () => badRes(400, 'detail');
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.ok(Array.isArray(res.body.debug));
});

test('handler: falls back to next provider when the first one fails', async t => {
  t.after(reset);
  delete process.env.DEBUG_ERRORS;
  process.env.GROQ_API_KEY = 'x';
  process.env.GEMINI_API_KEY = 'y';
  delete process.env.OPENROUTER_API_KEY;
  global.fetch = async url => String(url).includes('groq')
    ? badRes(400, 'groq down')
    : okRes({ candidates: [{ content: { parts: [{ text: 'Namaste ji' }] } }] });
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
});

test('handler: PDF is never sent to a text-only provider', async t => {
  t.after(reset);
  process.env.GROQ_API_KEY = 'x';
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let called = false;
  global.fetch = async () => { called = true; return okRes({}); };
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'ye dekho', attachments: [{ mime: 'application/pdf', data: 'AAAA' }] }]), res);
  assert.equal(res.code, 503);
  assert.equal(called, false);
});

test('handler: oversized request => 413', async () => {
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'x'.repeat(4300000) }]), res);
  assert.equal(res.code, 413);
});

test('handler: rate limited IP gets 429', async t => {
  t.after(reset);
  process.env.GROQ_API_KEY = 'x';
  global.fetch = async () => badRes(400);
  const ip = '99.99.99.99';
  let last;
  for (let i = 0; i < 11; i++) {
    last = mockRes();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: { messages: [{ role: 'user', content: 'hi' }] } }, last);
  }
  assert.equal(last.code, 429);
});
