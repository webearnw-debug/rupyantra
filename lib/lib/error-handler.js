'use strict';

/*
 * Rupeyantra AI - Error Handler (lib/error-handler.js)
 *
 * Koi external dependency nahi (sirf Node ka built-in `crypto`).
 *
 * 15 upgrades kahan hain:
 *  1  Smart error detection ........ classifyError()
 *  2  Friendly messages ............ friendlyMessage()
 *  3  Timeout handling ............. withTimeout()
 *  4  Smart retry .................. retry(), createCircuitBreaker()
 *  5  Rate-limit protection ........ extractRetryAfterMs(), parseRetryAfter(), toHttpResponse()
 *  6  Invalid input handling ....... validateFinanceInput(), assertValidInput()
 *  7  Sensitive data protection .... sanitize(), redactObject()
 *  8  Structured error reports ..... buildReport(), logError(), getRecentReports()
 *  9  Network failure handling ..... classifyError() (ECONNRESET, DNS, fetch failed ...)
 * 10  Server error handling ........ classifyError() (500/502/503/504/529 ...)
 * 11  Authentication detection ..... classifyError() (401/403, invalid/missing API key)
 * 12  Calculation protection ....... ensureFinite(), safeDivide(), assertFiniteResult(),
 *                                    checkFinancialResult(), guardToolResult()
 * 13  Safe fallback response ....... safeFallbackResponse()
 * 14  Severity levels .............. SEVERITY, compareSeverity(), shouldAlert()
 * 15  Error testing system ......... selfTest()   ->   node lib/error-handler.js --test
 *
 * chat.js mein use karne ka tareeka (chhota example):
 *
 *   const eh = require('../lib/error-handler');
 *   module.exports = eh.wrapHandler(handler, { debug: process.env.DEBUG_ERRORS === '1' });
 *
 *   // provider call par:
 *   const r = await eh.retry(
 *     () => eh.withTimeout(signal => fetch(url, { ...init, signal }), 15000, 'Groq'),
 *     { retries: 1, deadlineAt: deadline, ctx: { provider: 'groq' } }
 *   );
 *
 * Rule: user ko kabhi raw error, stack, API key ya provider ka response nahi dikhta.
 * Sab kuch sanitize hota hai; request ID se hi baad mein logs mein dhoondhiye.
 */

const crypto = require('node:crypto');

/* ========================================================================== */
/* 1. Types, severity, defaults                                               */
/* ========================================================================== */

const ERROR_TYPES = Object.freeze({
  VALIDATION: 'validation',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  SERVER: 'server',
  API: 'api',
  AUTH: 'auth',
  CODE: 'code',
  CALCULATION: 'calculation',
  UNKNOWN: 'unknown'
});

const SEVERITY = Object.freeze({
  MINOR: 'minor',
  WARNING: 'warning',
  CRITICAL: 'critical'
});

const SEVERITY_RANK = Object.freeze({ minor: 1, warning: 2, critical: 3 });

// status = user ko bheja jaane wala HTTP status (provider ka asli status nahi)
const TYPE_DEFAULTS = Object.freeze({
  validation: { severity: 'minor', status: 400, retryable: false },
  rate_limit: { severity: 'warning', status: 429, retryable: true },
  timeout: { severity: 'warning', status: 504, retryable: true },
  network: { severity: 'warning', status: 502, retryable: true },
  server: { severity: 'warning', status: 503, retryable: true },
  api: { severity: 'warning', status: 502, retryable: false },
  auth: { severity: 'critical', status: 503, retryable: false },
  code: { severity: 'critical', status: 500, retryable: false },
  calculation: { severity: 'critical', status: 500, retryable: false },
  unknown: { severity: 'warning', status: 500, retryable: false }
});

const MAX_RETRY_AFTER_MS = 3600000; // 1 ghanta
const DEFAULT_RATE_LIMIT_WAIT = Object.freeze({ user: 60, provider: 30 }); // seconds

class AppError extends Error {
  constructor(opts = {}) {
    super(typeof opts.message === 'string' && opts.message ? opts.message : 'Error');
    this.name = 'AppError';
    this.type = opts.type || ERROR_TYPES.UNKNOWN;
    this.status = opts.status;
    this.severity = opts.severity;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.scope = opts.scope; // rate_limit: 'user' ya 'provider'
    this.code = opts.code;
    this.details = opts.details; // validation: [{field, message}] (user ko dikhaya ja sakta hai)
    if (opts.cause) this.cause = opts.cause; // sirf internal; kabhi response mein nahi jaata
  }
}

const SEVERITY_ORDER = (a, b) => (SEVERITY_RANK[a] || 0) - (SEVERITY_RANK[b] || 0);
const compareSeverity = SEVERITY_ORDER;
const shouldAlert = severity => severity === SEVERITY.CRITICAL;

/* ========================================================================== */
/* 2. Sensitive data protection                                               */
/* ========================================================================== */

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)/i;
const SENSITIVE_KEY = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session|otp|\bpin\b|cvv|cvc|card|aadhaa?r|ifsc|private|credential|attachments?|base64|^data$|^pan$|^pan[-_]?(no|number)$|^account)/i;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Environment mein jo secrets set hain (API keys etc.) unki exact value
function envSecretValues() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_NAME.test(k) && typeof v === 'string' && v.trim().length >= 8) out.push(v.trim());
  }
  return out.sort((a, b) => b.length - a.length);
}

const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [
    /\b(authorization|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|pwd|token)(["']?\s*[:=]\s*["']?)([^\s"',;&}]{3,})/gi,
    (m, k, sep) => k + sep + '[REDACTED]'
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT]'],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,})/g,
    '[API_KEY]'
  ],
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]{20,}/gi, '[DATA]'],
  [/[A-Za-z0-9+\/]{200,}={0,2}/g, '[DATA]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]'],
  [/\b(otp|cvv|cvc|pin)\b(\s*(?:is|=|:|hai)?\s*)\d{3,8}\b/gi, (m, k, sep) => k + sep + '[REDACTED]'],
  [/(?<![\d,.])\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g, '[ID]']
];

const CARD_RE = /(?<![\d₹.,])(?:\d[ -]?){12,18}\d(?![\d,.])/g;
const PHONE_RE = /(?<![\d₹.,])(?:\+?91[\s-]?)?[6-9]\d{9}(?![\d,.])/g;

// Kisi bhi text se secrets/private details hata deta hai. Amounts (50,00,000) ko nahi chhedta.
function sanitize(input, opts = {}) {
  const maxLen = Number.isInteger(opts.maxLen) ? opts.maxLen : 500;
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : safeToString(input);

  for (const secret of envSecretValues()) {
    s = s.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  s = s.replace(CARD_RE, m => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[CARD]' : m;
  });
  s = s.replace(PHONE_RE, '[PHONE]');

  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function safeToString(v) {
  try {
    if (v instanceof Error) return v.message || String(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  } catch (_) {
    return '[unprintable]';
  }
}

// Object/log payload ko deep-sanitize karta hai (password, token, attachments, card, ...)
function redactObject(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitize(value, { maxLen: 300 });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '[unsupported]';
  if (depth >= 6) return '[too deep]';
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, { maxLen: 300 }) };
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 20).map(v => redactObject(v, depth + 1, seen));

  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactObject(v, depth + 1, seen);
  }
  return out;
}

/* ========================================================================== */
/* 3. Detection helpers (code / api / network / server / auth / rate limit)   */
/* ========================================================================== */

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_TIMEOUT'
]);

const AUTH_MESSAGE = /(?:invalid|incorrect|missing|expired|revoked|bad|wrong)\s+(?:api[\s_-]?key|token|credentials?|authori[sz]ation)|api[\s_-]?key\s+(?:not\s+valid|missing|invalid|expired)|unauthori[sz]ed|forbidden|permission[_\s]denied|authentication|not\s+authenticated/i;
const RATE_MESSAGE = /rate[\s-]?limit|too many requests|quota|resource[_\s]exhausted|requests? per (?:minute|day|second)/i;
const QUOTA_HARD = /quota|billing|daily|per day|exceeded your current/i;
const TIMEOUT_MESSAGE = /time(?:d)?[\s-]?out|deadline exceeded|time budget/i;
const NETWORK_MESSAGE = /fetch failed|network error|network request failed|socket hang up|connection (?:reset|refused|closed|lost)|unreachable|getaddrinfo|\bECONN\w*|\bENOTFOUND\b|\bEAI_AGAIN\b|offline/i;
const CALC_MESSAGE = /\bNaN\b|\bInfinity\b|divi(?:de|sion) by zero|calculate nahi|calculation (?:error|nahi)|result bharosemand/i;
const VALIDATION_MESSAGE = /missing hai|galat hai|allowed range|dena zaroori|nahi ho sakta|invalid input|validation|must be (?:a )?(?:positive|number)|payload too large|request entity too large/i;

function toErrorLike(input) {
  if (input instanceof Error) return input;
  if (typeof input === 'string') return new Error(input);
  if (input && typeof input === 'object') {
    const e = new Error(typeof input.message === 'string' ? input.message : 'Unknown error');
    for (const k of ['name', 'code', 'status', 'statusCode', 'headers', 'response', 'retryAfterMs', 'retryAfter', 'cause', 'details']) {
      if (input[k] !== undefined) {
        try { e[k] = input[k]; } catch (_) { /* read-only */ }
      }
    }
    return e;
  }
  return new Error(input === undefined || input === null ? 'Unknown error' : String(input));
}

function causeChain(err) {
  const chain = [];
  let cur = err;
  for (let i = 0; cur && typeof cur === 'object' && i < 5; i++) {
    chain.push(cur);
    if (Array.isArray(cur.errors)) cur.errors.slice(0, 3).forEach(x => x && typeof x === 'object' && chain.push(x));
    cur = cur.cause;
  }
  return chain;
}

function codesOf(err) {
  return causeChain(err).map(e => (typeof e.code === 'string' ? e.code : null)).filter(Boolean);
}

function statusOf(err) {
  for (const e of causeChain(err)) {
    for (const c of [e.status, e.statusCode, e.response && e.response.status]) {
      const n = Number(c);
      if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
    }
  }
  const msg = String(err.message || '');
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i) || msg.match(/\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i);
  return m ? Number(m[1]) : null;
}

/* ---------- retry-after (rate-limit delay) ---------- */

const UNIT_MS = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000 };

function unitToMs(num, unit) {
  const f = unit ? UNIT_MS[String(unit).toLowerCase()] : 1000;
  return Math.round(parseFloat(num) * (f || 1000));
}

function headerGet(h, name) {
  if (!h) return null;
  if (typeof h.get === 'function') {
    try { return h.get(name); } catch (_) { return null; }
  }
  if (typeof h === 'object') {
    const k = Object.keys(h).find(x => x.toLowerCase() === name);
    return k ? h[k] : null;
  }
  return null;
}

// Retry-After header: seconds ("12") ya HTTP date. Milliseconds mein, ya null.
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(parseFloat(s) * 1000));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, t - now));
}

function extractRetryAfterMs(input) {
  const err = toErrorLike(input);
  const cap = n => (Number.isFinite(n) && n >= 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.round(n)) : null);

  for (const e of causeChain(err)) {
    if (typeof e.retryAfterMs === 'number') return cap(e.retryAfterMs);
    if (e.retryAfter !== undefined && e.retryAfter !== null) {
      const ms = parseRetryAfter(e.retryAfter);
      if (ms !== null) return ms;
    }
    for (const h of [e.headers, e.response && e.response.headers]) {
      const msHeader = headerGet(h, 'retry-after-ms');
      if (msHeader !== null && msHeader !== undefined && Number.isFinite(Number(msHeader))) return cap(Number(msHeader));
      const ms = parseRetryAfter(headerGet(h, 'retry-after'));
      if (ms !== null) return ms;
    }
  }

  const msg = String(err.message || '');
  let m = msg.match(/(\d+)m(\d+(?:\.\d+)?)s\b/i); // "6m12.5s"
  if (m) return cap(Number(m[1]) * 60000 + parseFloat(m[2]) * 1000);
  m = msg.match(/retry[\s_-]*after[\s"':=]*?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|s|m)?\b/i);
  if (m) return cap(unitToMs(m[1], m[2]));
  m = msg.match(/retryDelay["'\s:=]*?(\d+(?:\.\d+)?)\s*(ms|s|m)?/i);
  if (m) return cap(unitToMs(m[1], m[2]));
  m = msg.match(/(?:try|retry) again in\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|s|m)\b/i);
  if (m) return cap(unitToMs(m[1], m[2]));
  return null;
}

/* ========================================================================== */
/* 4. classifyError  (upgrades 1, 9, 10, 11 + rate limit / timeout)           */
/* ========================================================================== */

function makeInfo(type, rawErr, extra = {}) {
  const d = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.unknown;
  return {
    kind: 'error_info',
    type,
    severity: extra.severity || d.severity,
    status: extra.status || d.status,
    upstreamStatus: extra.upstreamStatus || null,
    retryable: extra.retryable !== undefined ? extra.retryable : d.retryable,
    retryAfterMs: extra.retryAfterMs !== undefined ? extra.retryAfterMs : null,
    scope: extra.scope || null,
    code: extra.code || null,
    details: extra.details || null,
    message: sanitize(rawErr && rawErr.message ? rawErr.message : safeToString(rawErr), { maxLen: 300 })
  };
}

function fromAppError(err) {
  const type = Object.values(ERROR_TYPES).includes(err.type) ? err.type : ERROR_TYPES.UNKNOWN;
  const d = TYPE_DEFAULTS[type];
  const scope = err.scope || (type === 'rate_limit' ? 'provider' : null);
  let status = Number.isInteger(err.status) ? err.status : d.status;
  if (type === 'rate_limit' && !Number.isInteger(err.status)) status = scope === 'user' ? 429 : 503;
  return makeInfo(type, err, {
    severity: err.severity || d.severity,
    status,
    retryable: typeof err.retryable === 'boolean' ? err.retryable : d.retryable,
    retryAfterMs: typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null,
    scope,
    code: err.code,
    details: Array.isArray(err.details) ? err.details : null
  });
}

function rateLimitInfo(err, ctx, upstreamStatus) {
  const scope = ctx.scope === 'user' ? 'user' : 'provider';
  const retryAfterMs = extractRetryAfterMs(err);
  const msg = String(err.message || '');
  // "daily quota / billing" jaisi sakht limit: turant retry ka fayda nahi
  const hardQuota = retryAfterMs === null && QUOTA_HARD.test(msg);
  return makeInfo('rate_limit', err, {
    status: scope === 'user' ? 429 : 503,
    upstreamStatus,
    retryable: !hardQuota,
    retryAfterMs,
    scope,
    code: hardQuota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED'
  });
}

function serverInfo(err, status) {
  const retryable = [500, 502, 503, 529].includes(status) || (status >= 520 && status <= 526 && status !== 522 && status !== 524);
  return makeInfo('server', err, {
    upstreamStatus: status,
    status: retryable ? 503 : 502,
    retryable,
    severity: retryable ? 'warning' : 'critical',
    retryAfterMs: extractRetryAfterMs(err)
  });
}

// Koi bhi error (Error, string, object, provider ka HTTP error) => {type, severity, status, retryable, ...}
function classifyError(input, ctx = {}) {
  const err = toErrorLike(input);
  if (err instanceof AppError) return fromAppError(err);

  const msg = String(err.message || '');
  const name = String(err.name || '');
  const codes = codesOf(err);
  const status = statusOf(err);

  // Pehle hamare apne (engine) errors: calculation / validation
  if (name === 'CalculationError' || CALC_MESSAGE.test(msg)) return makeInfo('calculation', err);
  if (name === 'ValidationError' || (status === null && VALIDATION_MESSAGE.test(msg))) {
    return makeInfo('validation', err, { details: Array.isArray(err.details) ? err.details : null });
  }

  // HTTP status (provider response)
  if (status !== null) {
    if (status === 401 || status === 403) return makeInfo('auth', err, { upstreamStatus: status, code: 'AUTH_FAILED' });
    // 402 = credits/billing khatam: account ki dikkat hai, user ke bas ki nahi (critical)
    if (status === 402) return makeInfo('auth', err, { upstreamStatus: status, code: 'BILLING' });
    if (status === 429) return rateLimitInfo(err, ctx, status);
    if (status === 408 || status === 504 || status === 522 || status === 524) {
      return makeInfo('timeout', err, { upstreamStatus: status });
    }
    if (status === 413) return makeInfo('validation', err, { status: 413, upstreamStatus: status, code: 'PAYLOAD_TOO_LARGE' });
    if (status === 400 && AUTH_MESSAGE.test(msg)) return makeInfo('auth', err, { upstreamStatus: status, code: 'AUTH_FAILED' });
    if (status === 400 && RATE_MESSAGE.test(msg)) return rateLimitInfo(err, ctx, status);
    if (status >= 500) return serverInfo(err, status);
    if (status >= 400) return makeInfo('api', err, { upstreamStatus: status, code: 'API_REJECTED' });
  }

  // Network / timeout (Node error codes, fetch failed)
  if (codes.some(c => NETWORK_CODES.has(c))) return makeInfo('network', err, { code: codes.find(c => NETWORK_CODES.has(c)) });
  if (codes.some(c => TIMEOUT_CODES.has(c)) || name === 'TimeoutError' || name === 'AbortError') {
    return makeInfo('timeout', err, { code: codes.find(c => TIMEOUT_CODES.has(c)) || name.toUpperCase() });
  }

  // Message based detection
  if (AUTH_MESSAGE.test(msg)) return makeInfo('auth', err, { code: 'AUTH_FAILED' });
  if (RATE_MESSAGE.test(msg)) return rateLimitInfo(err, ctx, null);
  if (TIMEOUT_MESSAGE.test(msg)) return makeInfo('timeout', err);
  if (NETWORK_MESSAGE.test(msg)) return makeInfo('network', err);

  // Provider ne unreadable (HTML/ adhura JSON) jawab diya
  if (name === 'SyntaxError' && /JSON|Unexpected (?:token|end)/i.test(msg) && ctx.source === 'provider') {
    return makeInfo('api', err, { code: 'BAD_RESPONSE', retryable: true });
  }

  // Hamare apne code ke bugs
  if (/^(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)$/.test(name)) {
    return makeInfo('code', err, { code: name.toUpperCase() });
  }

  return makeInfo('unknown', err);
}

/* ========================================================================== */
/* 5. Friendly messages (Hinglish)                                            */
/* ========================================================================== */

const secondsOf = ms => Math.max(1, Math.min(3600, Math.ceil(ms / 1000)));

function friendlyMessage(infoOrError, opts = {}) {
  const info = infoOrError && infoOrError.kind === 'error_info' ? infoOrError : classifyError(infoOrError, opts);
  const wait = info.retryAfterMs !== null && info.retryAfterMs !== undefined
    ? secondsOf(info.retryAfterMs)
    : DEFAULT_RATE_LIMIT_WAIT[info.scope === 'user' ? 'user' : 'provider'];

  switch (info.type) {
    case 'validation':
      if (info.details && info.details.length) {
        return info.details.slice(0, 3).map(d => d.message).join('. ') + '. Kripya sahi value daalkar dobara try karein.';
      }
      return 'Aapne jo value di hai wo sahi nahi lagti. Amount, interest rate aur avadhi check karke dobara try karein.';
    case 'rate_limit':
      if (info.code === 'QUOTA_EXHAUSTED') {
        return 'Abhi service ki limit poori ho gayi hai. Kuch der baad dobara try karein.';
      }
      return info.scope === 'user'
        ? 'Aapne thode samay mein bahut sawal bhej diye hain. ' + wait + ' second ruk kar dobara try karein.'
        : 'Abhi bahut zyada log use kar rahe hain. ' + wait + ' second baad dobara try karein.';
    case 'timeout':
      return 'Jawab dene mein zyada der lag gayi. Thodi der baad dobara try karein.';
    case 'network':
      return 'Internet ya server se connection nahi ho paya. Connection check karke dobara try karein.';
    case 'server':
      return 'Server par abhi dikkat hai. Thodi der baad dobara try karein.';
    case 'api':
      return 'Assistant abhi jawab nahi de pa raha. Thodi der baad dobara try karein.';
    case 'auth':
      return 'Service abhi available nahi hai. Hum ise theek kar rahe hain, thodi der baad try karein.';
    case 'code':
      return 'Kuch gadbad ho gayi. Hum ise theek kar rahe hain. Dobara try karein.';
    case 'calculation':
      return 'Is calculation ka result bharosemand nahi tha, isliye main number nahi dikha raha. Inputs check karke dobara poochho.';
    default:
      return 'Kuch galat ho gaya. Dobara try karein.';
  }
}

/* ========================================================================== */
/* 6. Timeout (upgrade 3) + Retry + Circuit breaker (upgrade 4)               */
/* ========================================================================== */

// task: Promise ya function(signal) => Promise. Der hone par AppError(type: timeout) aur signal abort.
function withTimeout(task, ms, label = 'request') {
  const limit = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 120000) : 15000;
  const controller = new AbortController();
  let timer;

  let work;
  try {
    work = typeof task === 'function' ? Promise.resolve(task(controller.signal)) : Promise.resolve(task);
  } catch (e) {
    work = Promise.reject(e);
  }

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppError({
        type: ERROR_TYPES.TIMEOUT,
        message: sanitize(label, { maxLen: 60 }) + ' timeout (' + limit + 'ms)',
        code: 'TIMEOUT'
      }));
    }, limit);
  });

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Math.floor(Number(n)) : lo));

// Sirf temporary errors par, limited baar, backoff + jitter ke saath. Baaki turant throw.
async function retry(fn, opts = {}) {
  const o = {
    retries: 2,
    baseDelayMs: 400,
    maxDelayMs: 4000,
    factor: 2,
    jitter: 0.25,
    maxRetryAfterMs: 5000, // isse lamba Retry-After aaye to wait nahi, seedha error
    minRemainingMs: 1500,
    ...opts
  };
  const retries = clampInt(o.retries, 0, 3); // hard cap: baar-baar request nahi
  const sleep = typeof o.sleep === 'function' ? o.sleep : defaultSleep;
  const random = typeof o.random === 'function' ? o.random : Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const info = classifyError(e, o.ctx || {});
      if (e && typeof e === 'object') {
        try { e.errorInfo = info; } catch (_) { /* frozen */ }
      }

      const allowed = typeof o.shouldRetry === 'function' ? o.shouldRetry(info, attempt, e) : info.retryable;
      if (!allowed || attempt >= retries) throw e;

      let delay;
      if (info.retryAfterMs !== null && info.retryAfterMs !== undefined) {
        if (info.retryAfterMs > o.maxRetryAfterMs) throw e;
        delay = info.retryAfterMs;
      } else {
        const base = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(o.factor, attempt));
        delay = Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * o.jitter)));
      }

      if (o.deadlineAt && o.deadlineAt - Date.now() - delay < o.minRemainingMs) throw e;

      if (typeof o.onRetry === 'function') {
        try { o.onRetry({ attempt: attempt + 1, delayMs: delay, type: info.type }); } catch (_) { /* ignore */ }
      }
      await sleep(delay);
    }
  }
}

// Lagataar fail hone wale provider ko kuch der ke liye band kar deta hai (baar-baar request se bachne ke liye)
function createCircuitBreaker(opts = {}) {
  const threshold = clampInt(opts.failureThreshold === undefined ? 5 : opts.failureThreshold, 1, 100);
  const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 30000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const state = new Map();
  const COUNTED = new Set(['network', 'timeout', 'server', 'rate_limit']);

  const isOpen = key => {
    const s = state.get(key);
    return Boolean(s && s.openedAt && now() - s.openedAt < cooldownMs);
  };

  return {
    isOpen,
    reset: key => state.delete(key),
    async exec(key, fn) {
      if (isOpen(key)) {
        const s = state.get(key);
        throw new AppError({
          type: ERROR_TYPES.SERVER,
          message: 'provider temporarily paused',
          code: 'CIRCUIT_OPEN',
          retryable: false,
          retryAfterMs: Math.max(0, cooldownMs - (now() - s.openedAt))
        });
      }
      try {
        const result = await fn();
        state.delete(key);
        return result;
      } catch (e) {
        if (COUNTED.has(classifyError(e).type)) {
          const s = state.get(key) || { failures: 0, openedAt: 0 };
          s.failures++;
          if (s.failures >= threshold) s.openedAt = now();
          state.set(key, s);
        }
        throw e;
      }
    }
  };
}

/* ========================================================================== */
/* 7. Invalid input handling (upgrade 6)                                      */
/* ========================================================================== */

const INPUT_LIMITS = Object.freeze({ maxAmount: 1e12, maxYears: 100, maxMonths: 1200, maxRate: 100 });
// NOTE: limits lib/finance-engine.js ke LIMITS ke barabar rakhein.

const FIELD_RULES = {
  principal: ['Loan/investment amount', 'amount'],
  monthly_amount: ['Monthly SIP amount', 'amount'],
  amount: ['Amount', 'amount'],
  current_amount: ['Aaj ki amount', 'amount'],
  start_value: ['Shuruaati value', 'amount'],
  end_value: ['Ant ki value', 'amount'],
  goal_amount: ['Goal amount', 'amount'],
  monthly_income: ['Income', 'amount'],
  monthly_expenses: ['Kharcha', 'amount0'],
  current_savings: ['Bachat', 'amount0'],
  annual_rate: ['Interest rate', 'rate', 0, 100],
  alt_annual_rate: ['Doosra interest rate', 'rate', 0, 100],
  gst_rate: ['GST rate', 'rate', 0, 100],
  annual_return: ['Expected return', 'rate', -50, 100],
  conservative_return: ['Conservative return', 'rate', -50, 100],
  moderate_return: ['Moderate return', 'rate', -50, 100],
  high_return: ['High return', 'rate', -50, 100],
  annual_inflation: ['Inflation rate', 'rate', -20, 100],
  years: ['Avadhi', 'years'],
  alt_years: ['Doosri avadhi', 'years'],
  months: ['Avadhi (mahine)', 'months'],
  compounds_per_year: ['Compounding', 'int', 1, 365],
  inclusive: ['GST included/extra', 'flag']
};

// "₹50,00,000", "5,000", true/false => number; galat ho to NaN
function parseInputNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return NaN;
  const cleaned = value.replace(/[₹,\s]/g, '').replace(/^(true|yes)$/i, '1').replace(/^(false|no)$/i, '0');
  return cleaned === '' ? NaN : Number(cleaned);
}

const present = v => v !== undefined && v !== null && v !== '';

function checkField(field, raw) {
  const [label, kind, min, max] = FIELD_RULES[field];
  const v = parseInputNumber(raw);
  const bad = message => ({ field, code: 'INVALID', message });

  if (!Number.isFinite(v)) return { error: bad(label + ' ek sahi number hona chahiye') };

  switch (kind) {
    case 'amount':
      if (v < 0) return { error: bad(label + ' negative nahi ho sakti') };
      if (v === 0) return { error: bad(label + ' 0 se zyada honi chahiye') };
      if (v > INPUT_LIMITS.maxAmount) return { error: bad(label + ' bahut badi hai (max ₹1 lakh crore)') };
      return { value: v };
    case 'amount0':
      if (v < 0) return { error: bad(label + ' negative nahi ho sakta') };
      if (v > INPUT_LIMITS.maxAmount) return { error: bad(label + ' bahut bada hai (max ₹1 lakh crore)') };
      return { value: v };
    case 'rate':
      if (min >= 0 && v < 0) return { error: bad(label + ' negative nahi ho sakta') };
      if (v < min || v > max) return { error: bad(label + ' ' + min + '% se ' + max + '% ke beech honi chahiye') };
      return { value: v };
    case 'years':
      if (v <= 0) return { error: bad(label + ' 0 se zyada honi chahiye') };
      if (v > INPUT_LIMITS.maxYears) return { error: bad(label + ' 100 saal se zyada nahi ho sakti') };
      return { value: v };
    case 'months':
      if (v < 1) return { error: bad(label + ' kam se kam 1 mahina honi chahiye') };
      if (v > INPUT_LIMITS.maxMonths) return { error: bad(label + ' 1200 mahine (100 saal) se zyada nahi ho sakti') };
      return { value: v };
    case 'int':
      if (!Number.isInteger(v) || v < min || v > max) return { error: bad(label + ' ' + min + ' se ' + max + ' ke beech poora number hona chahiye') };
      return { value: v };
    case 'flag':
      if (v !== 0 && v !== 1) return { error: bad(label + ' sirf 0 ya 1 ho sakta hai') };
      return { value: v };
    default:
      return { value: v };
  }
}

// Sirf maujood fields check hote hain; `required` mein jo naam do wo na hon to "dena zaroori" error.
function validateFinanceInput(input, opts = {}) {
  const errors = [];
  const values = {};

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '_input', code: 'INVALID', message: 'Input sahi format mein nahi hai' }], values };
  }

  for (const field of Object.keys(FIELD_RULES)) {
    if (!present(input[field])) continue;
    const r = checkField(field, input[field]);
    if (r.error) errors.push(r.error); else values[field] = r.value;
  }

  for (const field of opts.required || []) {
    if (FIELD_RULES[field] && !present(input[field])) {
      errors.push({ field, code: 'MISSING', message: FIELD_RULES[field][0] + ' dena zaroori hai' });
    }
  }

  return { ok: errors.length === 0, errors, values };
}

function assertValidInput(input, opts = {}) {
  const r = validateFinanceInput(input, opts);
  if (r.ok) return r.values;
  throw new AppError({
    type: ERROR_TYPES.VALIDATION,
    message: r.errors.map(e => e.message).join('; '),
    code: 'INVALID_INPUT',
    details: r.errors.map(e => ({ field: e.field, message: e.message }))
  });
}

/* ========================================================================== */
/* 8. Calculation protection (upgrade 12)                                     */
/* ========================================================================== */

function calcError(message, details) {
  return new AppError({ type: ERROR_TYPES.CALCULATION, message, code: 'CALC_INVALID', details });
}

function ensureFinite(n, label = 'value') {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw calcError(label + ' calculate nahi ho paya (NaN/Infinity)');
  }
  return n;
}

function safeDivide(a, b, label = 'division') {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    throw calcError(label + ': division by zero ya invalid number');
  }
  return ensureFinite(a / b, label);
}

const BAD_TEXT = /\bNaN\b|\bInfinity\b|\bundefined\b|\bnull\b|∞/;

// Result ke andar kahin bhi NaN/Infinity ya "₹NaN" jaisa text ho to path list deta hai
function findBadNumbers(x, path = 'result', out = [], depth = 0) {
  if (depth > 6 || out.length > 20) return out;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) out.push(path);
  } else if (typeof x === 'string') {
    if (BAD_TEXT.test(x)) out.push(path);
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => findBadNumbers(v, path + '[' + i + ']', out, depth + 1));
  } else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) findBadNumbers(v, path + '.' + k, out, depth + 1);
  }
  return out;
}

function assertFiniteResult(result, label = 'result') {
  const bad = findBadNumbers(result, label);
  if (bad.length) throw calcError(label + ' mein invalid number mila: ' + bad.slice(0, 3).join(', '));
  return result;
}

// "₹1,23,456" / "-₹5,000" => number, warna NaN
function parseINR(str) {
  if (typeof str === 'number') return str;
  if (typeof str !== 'string') return NaN;
  const m = str.trim().match(/^(-?)\s*₹?\s*(-?)([\d,]+(?:\.\d+)?)$/);
  if (!m) return NaN;
  const n = Number(m[3].replace(/,/g, ''));
  return m[1] === '-' || m[2] === '-' ? -n : n;
}

const NEGATIVE_OK = /surplus|vs_base|gain|earned|extra_cost/i;

// Tool ke result ki wazan-daar jaanch (negative EMI, maturity < principal jaisi galtiyan)
function checkFinancialResult(toolName, args, result) {
  const problems = [];
  const a = args && typeof args === 'object' ? args : {};

  if (!result || typeof result !== 'object') return { ok: false, problems: ['result khali ya galat format'] };
  problems.push(...findBadNumbers(result).map(p => p + ' invalid (NaN/Infinity)'));

  (function walk(x, key, depth) {
    if (depth > 5) return;
    if (typeof x === 'string') {
      if (/^-\s*₹/.test(x.trim()) && !NEGATIVE_OK.test(key)) problems.push(key + ' negative aaya');
    } else if (Array.isArray(x)) {
      x.forEach(v => walk(v, key, depth + 1));
    } else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) walk(v, k, depth + 1);
    }
  })(result, 'result', 0);

  const P = parseInputNumber(a.principal);
  const rate = parseInputNumber(a.annual_rate !== undefined ? a.annual_rate : a.annual_return);

  switch (toolName) {
    case 'calc_emi': {
      const emi = parseINR(result.monthly_emi);
      const total = parseINR(result.total_payment);
      if (Number.isFinite(emi) && emi <= 0) problems.push('monthly_emi 0 ya negative');
      if (Number.isFinite(total) && Number.isFinite(P) && rate >= 0 && total < P * 0.999) problems.push('total_payment loan se kam');
      break;
    }
    case 'calc_sip': {
      const fv = parseINR(result.future_value);
      const inv = parseINR(result.total_invested);
      if (Number.isFinite(fv) && Number.isFinite(inv) && rate >= 0 && fv < inv * 0.999) problems.push('future_value invest se kam');
      break;
    }
    case 'calc_lumpsum': {
      const mat = parseINR(result.maturity_amount);
      if (Number.isFinite(mat) && Number.isFinite(P) && rate >= 0 && mat < P * 0.999) problems.push('maturity amount principal se kam');
      break;
    }
    case 'calc_gst': {
      const base = parseINR(result.base_amount);
      const total = parseINR(result.total_amount);
      if (Number.isFinite(base) && Number.isFinite(total) && parseInputNumber(a.gst_rate) >= 0 && total < base - 0.01) problems.push('total base se kam');
      break;
    }
    default:
  }

  return { ok: problems.length === 0, problems };
}

// finance-engine ke runTool() ke result ko guard karta hai
function guardToolResult(toolName, args, result) {
  if (result && typeof result === 'object' && result.error) {
    const info = classifyError(new Error(String(result.error)));
    const type = info.type === 'calculation' ? ERROR_TYPES.CALCULATION : ERROR_TYPES.VALIDATION;
    return {
      ok: false,
      error: new AppError({
        type,
        message: String(result.error),
        code: type === ERROR_TYPES.CALCULATION ? 'CALC_INVALID' : 'INVALID_INPUT',
        details: type === ERROR_TYPES.VALIDATION ? [{ field: toolName, message: String(result.error) }] : undefined
      })
    };
  }
  const check = checkFinancialResult(toolName, args, result);
  if (!check.ok) {
    return { ok: false, error: calcError('Result jaanch mein fail hua: ' + check.problems.slice(0, 3).join('; ')) };
  }
  return { ok: true, result };
}

/* ========================================================================== */
/* 9. Structured reports + logging (upgrade 8)                                */
/* ========================================================================== */

const stats = { total: 0, byType: {}, bySeverity: {}, lastCriticalAt: null };
const recent = [];
const RECENT_MAX = 50;

function createRequestId() {
  return 'req_' + crypto.randomBytes(6).toString('hex');
}

function requestIdFrom(req) {
  const h = (req && req.headers) || {};
  const incoming = h['x-request-id'] || h['x-vercel-id'];
  return typeof incoming === 'string' && /^[\w:.-]{6,80}$/.test(incoming) ? incoming : createRequestId();
}

const safeTag = v => (typeof v === 'string' && /^[\w .:()/-]{1,60}$/.test(v) ? v : null);
const safeInt = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.round(Number(v))) : null);

// Sirf whitelisted fields: koi user message, input, header ya body kabhi report mein nahi jaata
function buildReport(info, ctx = {}) {
  return {
    id: typeof ctx.requestId === 'string' && /^[\w:.-]{6,80}$/.test(ctx.requestId) ? ctx.requestId : createRequestId(),
    time: new Date().toISOString(),
    type: info.type,
    severity: info.severity,
    code: info.code || null,
    status: info.status,
    upstreamStatus: info.upstreamStatus || null,
    retryable: info.retryable,
    scope: info.scope || null,
    where: safeTag(ctx.where),
    provider: safeTag(ctx.provider),
    attempt: safeInt(ctx.attempt),
    durationMs: safeInt(ctx.durationMs),
    message: info.message
  };
}

function record(report) {
  stats.total++;
  stats.byType[report.type] = (stats.byType[report.type] || 0) + 1;
  stats.bySeverity[report.severity] = (stats.bySeverity[report.severity] || 0) + 1;
  if (shouldAlert(report.severity)) stats.lastCriticalAt = report.time;
  recent.push(report);
  if (recent.length > RECENT_MAX) recent.shift();
}

// Error ko classify + sanitize + record + log karta hai. Kabhi throw nahi karta.
function logError(err, ctx = {}, opts = {}) {
  try {
    const info = classifyError(err, ctx);
    const report = buildReport(info, ctx);
    if (opts.debug) {
      const stack = err && err.stack ? sanitize(String(err.stack).split('\n').slice(0, 6).join('\n'), { maxLen: 800 }) : null;
      if (stack) report.stack = stack;
    }
    record(report);

    const logger = opts.logger || console;
    const level = report.severity === SEVERITY.CRITICAL ? 'error' : report.severity === SEVERITY.WARNING ? 'warn' : 'info';
    if (logger && typeof logger[level] === 'function') {
      try { logger[level](JSON.stringify({ event: 'error_report', ...report })); } catch (_) { /* logger fail */ }
    }
    return report;
  } catch (_) {
    return { id: createRequestId(), time: new Date().toISOString(), type: 'unknown', severity: 'warning', message: 'logging failed' };
  }
}

const getRecentReports = (n = 20) => recent.slice(-clampInt(n, 1, RECENT_MAX)).map(r => ({ ...r }));
const getStats = () => JSON.parse(JSON.stringify(stats));
function resetErrorState() {
  recent.length = 0;
  stats.total = 0;
  stats.byType = {};
  stats.bySeverity = {};
  stats.lastCriticalAt = null;
}

/* ========================================================================== */
/* 10. Safe fallback + HTTP response + handler wrapper (upgrade 13)           */
/* ========================================================================== */

const NO_FAKE_NOTE = 'Is dauran maine koi number ya calculation nahi banaya.';

// AI/provider fail ho to controlled jawab: koi banawati number ya calculation nahi.
function safeFallbackResponse(errOrInfo, ctx = {}) {
  const info = errOrInfo && errOrInfo.kind === 'error_info' ? errOrInfo : classifyError(errOrInfo, ctx);
  const base = friendlyMessage(info);
  const addNote = !['validation', 'rate_limit'].includes(info.type);
  const retryAfterSeconds = info.retryable || info.type === 'rate_limit'
    ? (info.retryAfterMs !== null && info.retryAfterMs !== undefined ? secondsOf(info.retryAfterMs) : null)
    : null;

  return {
    reply: addNote ? base + ' ' + NO_FAKE_NOTE : base,
    fallback: true,
    generated: false, // koi AI/fake figure nahi
    type: info.type,
    severity: info.severity,
    retryable: info.retryable,
    retryAfterSeconds,
    requestId: typeof ctx.requestId === 'string' ? ctx.requestId : null
  };
}

// Error => { status, headers, body, report }. Body mein kabhi internal detail/secret nahi.
function toHttpResponse(err, ctx = {}) {
  const info = classifyError(err, ctx);
  const requestId = typeof ctx.requestId === 'string' && /^[\w:.-]{6,80}$/.test(ctx.requestId) ? ctx.requestId : createRequestId();
  const report = buildReport(info, { ...ctx, requestId });

  const needsWait = info.type === 'rate_limit' && info.code !== 'QUOTA_EXHAUSTED';
  const waitMs = info.retryAfterMs !== null && info.retryAfterMs !== undefined
    ? info.retryAfterMs
    : needsWait ? DEFAULT_RATE_LIMIT_WAIT[info.scope === 'user' ? 'user' : 'provider'] * 1000 : null;

  const body = {
    message: friendlyMessage(info),
    requestId,
    retryable: info.retryable
  };
  if (waitMs !== null && (info.retryable || needsWait)) body.retryAfterSeconds = secondsOf(waitMs);
  if (info.type === 'validation' && info.details && info.details.length) {
    body.details = info.details.slice(0, 5).map(d => ({ field: safeTag(d.field), message: sanitize(d.message, { maxLen: 160 }) }));
  }
  if (ctx.debug) body.debug = { type: info.type, severity: info.severity, detail: info.message };

  const headers = { 'X-Request-Id': requestId };
  if (body.retryAfterSeconds) headers['Retry-After'] = String(body.retryAfterSeconds);

  return { status: info.status, headers, body, report, info };
}

// Handler ko wrap karta hai: koi bhi throw => sanitized JSON error + request ID + structured log
function wrapHandler(handler, opts = {}) {
  return async function wrappedHandler(req, res) {
    const requestId = requestIdFrom(req);
    const started = Date.now();
    try {
      if (res && typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
      return await handler(req, res, { requestId });
    } catch (err) {
      const ctx = { requestId, where: opts.where || 'handler', durationMs: Date.now() - started, debug: Boolean(opts.debug) };
      const out = toHttpResponse(err, ctx);
      logError(err, ctx, { logger: opts.logger, debug: opts.debug });
      if (typeof opts.onReport === 'function') {
        try { opts.onReport(out.report); } catch (_) { /* ignore */ }
      }
      if (!res || res.headersSent) return undefined;
      for (const [k, v] of Object.entries(out.headers)) {
        if (typeof res.setHeader === 'function') res.setHeader(k, v);
      }
      return res.status(out.status).json(out.body);
    }
  };
}

/* ========================================================================== */
/* 11. Error testing system (upgrade 15)                                      */
/* ========================================================================== */

const TESTS = [];
const t = (name, fn) => TESTS.push({ name, fn });
const A = require('node:assert/strict');

const mkErr = (message, props = {}) => Object.assign(new Error(message), props);
const noSleep = () => Promise.resolve();
const FAKE_GROQ = 'gsk_' + 'a1B2c3D4'.repeat(4);
const FAKE_GEMINI = 'AIza' + 'Xy9Zw8Vu7Ts6Rq5Po4'.repeat(2);
const FAKE_OR = 'sk-or-v1-' + 'f0e1d2c3b4a59687'.repeat(2);

// 1. detection
t('detect: code error (TypeError) => code/critical', () => {
  const i = classifyError(new TypeError('x is not a function'));
  A.equal(i.type, 'code'); A.equal(i.severity, 'critical'); A.equal(i.retryable, false);
});
t('detect: provider 400 => api, no retry', () => {
  const i = classifyError(new Error('Groq HTTP 400: bad request'));
  A.equal(i.type, 'api'); A.equal(i.retryable, false); A.equal(i.upstreamStatus, 400);
});
t('detect: calculation error messages', () => {
  A.equal(classifyError(new Error('Amount calculate nahi ho paya.')).type, 'calculation');
  A.equal(classifyError(new Error('result is NaN')).type, 'calculation');
  A.equal(classifyError(new Error('division by zero')).type, 'calculation');
});
t('detect: engine validation messages => validation/minor', () => {
  const i = classifyError(new Error('principal missing hai'));
  A.equal(i.type, 'validation'); A.equal(i.severity, 'minor'); A.equal(i.status, 400);
});
t('detect: unknown error stays unknown', () => A.equal(classifyError('kuch ajeeb').type, 'unknown'));

// 10. server errors
t('server: 500/502/503/529 retryable server; 504 timeout; 501 non-retryable critical', () => {
  for (const s of [500, 502, 503, 529]) {
    const i = classifyError(new Error('Groq HTTP ' + s + ': x'));
    A.equal(i.type, 'server', 'status ' + s); A.equal(i.retryable, true);
  }
  const g = classifyError(new Error('Gemini HTTP 504: gateway'));
  A.equal(g.type, 'timeout'); A.equal(g.retryable, true);
  const n = classifyError(mkErr('x', { status: 501 }));
  A.equal(n.type, 'server'); A.equal(n.retryable, false); A.equal(n.severity, 'critical');
});

// 9. network
t('network: fetch failed + cause ECONNRESET, ENOTFOUND, socket hang up', () => {
  const e1 = Object.assign(new TypeError('fetch failed'), { cause: mkErr('read ECONNRESET', { code: 'ECONNRESET' }) });
  A.equal(classifyError(e1).type, 'network');
  A.equal(classifyError(mkErr('getaddrinfo ENOTFOUND api.x.com', { code: 'ENOTFOUND' })).type, 'network');
  A.equal(classifyError(new Error('socket hang up')).type, 'network');
  A.equal(classifyError(new TypeError('fetch failed')).type, 'network');
  A.equal(classifyError(mkErr('x', { code: 'UND_ERR_CONNECT_TIMEOUT' })).type, 'network');
  A.equal(classifyError(e1).retryable, true);
});

// 3. timeout detection
t('timeout: TimeoutError name, ETIMEDOUT code, message', () => {
  const te = new Error('The operation was aborted due to timeout'); te.name = 'TimeoutError';
  A.equal(classifyError(te).type, 'timeout');
  A.equal(classifyError(mkErr('x', { code: 'ETIMEDOUT' })).type, 'timeout');
  A.equal(classifyError(new Error('Groq timeout')).type, 'timeout');
});

// 5. rate limit
t('rate limit: Retry-After header (object + Headers), message formats', () => {
  A.equal(extractRetryAfterMs(mkErr('x', { headers: { 'Retry-After': '12' } })), 12000);
  A.equal(extractRetryAfterMs(mkErr('x', { headers: new Headers({ 'retry-after': '3' }) })), 3000);
  A.equal(extractRetryAfterMs(new Error('Please try again in 7.5s.')), 7500);
  A.equal(extractRetryAfterMs(new Error('{"retryDelay": "23s"}')), 23000);
  A.equal(extractRetryAfterMs(new Error('rate limit, try again in 6m12.5s')), 372500);
  A.equal(extractRetryAfterMs(new Error('no hint here')), null);
  A.equal(parseRetryAfter('abc'), null);
  A.ok(parseRetryAfter(new Date(Date.now() + 10000).toUTCString()) <= 10000);
});
t('rate limit: 429 classification, scope, status, hard quota', () => {
  const p = classifyError(mkErr('Groq HTTP 429: slow down', { headers: { 'retry-after': '5' } }));
  A.equal(p.type, 'rate_limit'); A.equal(p.scope, 'provider'); A.equal(p.status, 503); A.equal(p.retryAfterMs, 5000);
  const u = classifyError(new Error('Too many requests'), { scope: 'user' });
  A.equal(u.type, 'rate_limit'); A.equal(u.status, 429);
  const q = classifyError(new Error('Gemini HTTP 429: You exceeded your current quota, check billing'));
  A.equal(q.code, 'QUOTA_EXHAUSTED'); A.equal(q.retryable, false);
});

// 11. auth
t('auth: 401/403, invalid key on 400, missing key => critical, no retry', () => {
  A.equal(classifyError(new Error('OpenRouter HTTP 402: insufficient credits')).code, 'BILLING');
  for (const e of [
    new Error('Groq HTTP 401: Invalid API Key'),
    new Error('Gemini HTTP 403: PERMISSION_DENIED'),
    new Error('Gemini HTTP 400: API key not valid. Please pass a valid API key.'),
    new Error('GEMINI_API_KEY missing'),
    new Error('Groq API key missing'),
    new Error('Missing authorization header')
  ]) {
    const i = classifyError(e);
    A.equal(i.type, 'auth', e.message); A.equal(i.severity, 'critical'); A.equal(i.retryable, false);
  }
});

// 2. friendly messages
t('friendly: koi technical shabd/secret user message mein nahi', () => {
  const errs = [
    new TypeError('Cannot read properties of undefined'), new Error('Groq HTTP 500: ' + FAKE_GROQ),
    new Error('GEMINI_API_KEY missing'), Object.assign(new TypeError('fetch failed'), { cause: mkErr('ECONNRESET', { code: 'ECONNRESET' }) }),
    new Error('Groq timeout'), new Error('Groq HTTP 429'), new Error('NaN result')
  ];
  for (const e of errs) {
    const m = friendlyMessage(e);
    A.ok(m.length > 20);
    A.ok(!/HTTP|ECONN|TypeError|undefined|stack|API_KEY|gsk_|NaN/i.test(m), m);
  }
  A.match(friendlyMessage(new Error('x HTTP 429'), { scope: 'user' }), /ruk kar/);
});

// 6. invalid input
t('input: negative loan, bad rate, NaN, zero/huge duration rejected', () => {
  const bad = [
    { principal: -500000 }, { principal: 0 }, { principal: 1e13 }, { principal: 'abc' }, { principal: NaN },
    { annual_rate: -1 }, { annual_rate: 150 }, { annual_rate: Infinity }, { years: 0 }, { years: -2 }, { years: 101 },
    { months: 1201 }, { months: 0 }, { compounds_per_year: 2.5 }, { inclusive: 2 }, { monthly_expenses: -1 }
  ];
  for (const b of bad) A.equal(validateFinanceInput(b).ok, false, JSON.stringify(b));
});
t('input: valid values, strings with ₹ and commas, required fields', () => {
  const ok = validateFinanceInput({ principal: '₹50,00,000', annual_rate: '8.5', years: 20, inclusive: true });
  A.equal(ok.ok, true); A.equal(ok.values.principal, 5000000); A.equal(ok.values.inclusive, 1);
  const miss = validateFinanceInput({ principal: 1000 }, { required: ['principal', 'annual_rate'] });
  A.equal(miss.ok, false); A.equal(miss.errors[0].field, 'annual_rate');
  A.equal(validateFinanceInput(null).ok, false);
  A.equal(validateFinanceInput({ annual_return: -10 }).ok, true);
  A.equal(validateFinanceInput({ annual_rate: 0 }).ok, true);
});
t('input: assertValidInput throws friendly validation AppError with details', () => {
  try { assertValidInput({ principal: -1, annual_rate: 150 }); A.fail('should throw'); } catch (e) {
    A.equal(e.type, 'validation'); A.equal(e.details.length, 2);
    A.match(friendlyMessage(e), /negative nahi ho sakti/);
    A.equal(toHttpResponse(e).status, 400);
  }
});

// 3. timeout handling
t('timeout: withTimeout rejects slow task, aborts signal, passes fast task', async () => {
  let aborted = false;
  await A.rejects(
    withTimeout(signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }), 25, 'Groq'),
    e => e.type === 'timeout' && classifyError(e).retryable === true
  );
  A.equal(aborted, true);
  A.equal(await withTimeout(Promise.resolve(42), 500), 42);
  await A.rejects(withTimeout(() => { throw new Error('sync boom'); }, 100), /sync boom/);
});

// 4. retry
t('retry: temporary error retried then succeeds (no real sleep)', async () => {
  let calls = 0;
  const delays = [];
  const r = await retry(async () => { calls++; if (calls < 3) throw new Error('Groq HTTP 503: busy'); return 'ok'; },
    { retries: 2, sleep: ms => { delays.push(ms); return Promise.resolve(); }, random: () => 0.5 });
  A.equal(r, 'ok'); A.equal(calls, 3); A.equal(delays.length, 2);
});
t('retry: non-retryable (400, 401, validation) fail immediately', async () => {
  for (const msg of ['Groq HTTP 400: bad', 'Groq HTTP 401: nope', 'principal missing hai']) {
    let calls = 0;
    await A.rejects(retry(async () => { calls++; throw new Error(msg); }, { sleep: noSleep }));
    A.equal(calls, 1, msg);
  }
});
t('retry: hard cap (retries:50 => max 4 calls)', async () => {
  let calls = 0;
  await A.rejects(retry(async () => { calls++; throw new Error('Groq HTTP 500'); }, { retries: 50, sleep: noSleep }));
  A.equal(calls, 4);
});
t('retry: deadline and long Retry-After stop retrying', async () => {
  let calls = 0;
  await A.rejects(retry(async () => { calls++; throw new Error('Groq HTTP 500'); }, { retries: 3, sleep: noSleep, deadlineAt: Date.now() + 500 }));
  A.equal(calls, 1);
  calls = 0;
  let slept = 0;
  await A.rejects(retry(async () => { calls++; throw mkErr('Groq HTTP 429', { headers: { 'retry-after': '60' } }); },
    { sleep: ms => { slept += ms; return Promise.resolve(); } }));
  A.equal(calls, 1); A.equal(slept, 0);
});
t('retry: short Retry-After is honoured (no jitter below it)', async () => {
  let calls = 0; const delays = [];
  await retry(async () => { calls++; if (calls === 1) throw mkErr('x HTTP 429', { headers: { 'retry-after': '2' } }); return 1; },
    { sleep: ms => { delays.push(ms); return Promise.resolve(); } });
  A.deepEqual(delays, [2000]);
});
t('circuit breaker: opens after failures, recovers after cooldown, ignores validation', async () => {
  let clock = 1000;
  const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => clock });
  const fail = () => cb.exec('groq', async () => { throw new Error('Groq HTTP 503'); });
  await A.rejects(fail()); await A.rejects(fail());
  A.equal(cb.isOpen('groq'), true);
  await A.rejects(fail(), e => e.code === 'CIRCUIT_OPEN' && classifyError(e).retryable === false);
  clock += 150;
  A.equal(await cb.exec('groq', async () => 'back'), 'back');
  A.equal(cb.isOpen('groq'), false);
  for (let i = 0; i < 5; i++) await A.rejects(cb.exec('v', async () => { throw new Error('principal missing hai'); }));
  A.equal(cb.isOpen('v'), false);
});

// 7. sensitive data
t('sanitize: keys, bearer, JWT, card, email, phone, PAN, OTP hata deta hai; amounts safe', () => {
  const dirty = [
    'key=' + FAKE_GROQ, 'x-goog-api-key: ' + FAKE_GEMINI, 'Authorization: Bearer ' + FAKE_OR,
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'card 4111 1111 1111 1111', 'mail user@example.com', 'phone 9876543210', 'PAN ABCDE1234F', 'otp 482913',
    '{"password":"hunter2-secret"}', 'aadhaar 1234 5678 9012'
  ].join(' | ');
  const clean = sanitize(dirty, { maxLen: 2000 });
  for (const leak of [FAKE_GROQ, FAKE_GEMINI, FAKE_OR, 'eyJhbGci', '4111 1111', 'user@example.com', '9876543210', 'ABCDE1234F', '482913', 'hunter2', '1234 5678 9012']) {
    A.ok(!clean.includes(leak), 'leak: ' + leak);
  }
  const safe = sanitize('EMI ₹43,391 aur loan ₹50,00,000, amount ₹9876543210, max_tokens: 1200', { maxLen: 2000 });
  A.match(safe, /₹43,391/); A.match(safe, /₹50,00,000/); A.match(safe, /₹9876543210/); A.match(safe, /max_tokens: 1200/);
});
t('sanitize: environment ke secret values exact match se hat jaate hain', () => {
  const name = 'RUPEYANTRA_TEST_SECRET_KEY';
  process.env[name] = 'plain-looking-secret-value-123';
  try {
    A.ok(!sanitize('boom plain-looking-secret-value-123 boom').includes('plain-looking'));
  } finally {
    delete process.env[name];
  }
});
t('redactObject: password, headers, attachments, card nested hat jaate hain', () => {
  const o = redactObject({
    user: 'Ravi', password: 'p@ss', headers: { authorization: 'Bearer abcdefghij', 'x-api-key': FAKE_GROQ },
    messages: [{ role: 'user', content: 'hi', attachments: [{ mime: 'image/png', data: 'A'.repeat(500) }] }],
    note: 'mail me at a@b.com', cardNumber: '4111111111111111', amount: 5000
  });
  const s = JSON.stringify(o);
  for (const leak of ['p@ss', 'abcdefghij', FAKE_GROQ, 'AAAAAAAAAA', 'a@b.com', '4111111111111111']) A.ok(!s.includes(leak), leak);
  A.equal(o.amount, 5000); A.equal(o.user, 'Ravi');
  const circ = {}; circ.self = circ;
  A.equal(redactObject(circ).self, '[circular]');
});

// 8. structured reports
t('report: structure, request id, only whitelisted fields, no secrets', () => {
  resetErrorState();
  const lines = [];
  const logger = { info: x => lines.push(['info', x]), warn: x => lines.push(['warn', x]), error: x => lines.push(['error', x]) };
  const r = logError(new Error('Groq HTTP 500: token=' + FAKE_GROQ), {
    requestId: 'req_abc123def', where: 'chat', provider: 'groq', attempt: 2, durationMs: 1234,
    userMessage: 'meri income 50000 hai', body: { secret: 'x' }
  }, { logger });
  A.equal(r.id, 'req_abc123def'); A.equal(r.type, 'server'); A.equal(r.severity, 'warning');
  A.ok(!Number.isNaN(Date.parse(r.time)));
  A.ok(!JSON.stringify(r).includes(FAKE_GROQ)); A.ok(!JSON.stringify(r).includes('income')); A.ok(!('userMessage' in r));
  A.equal(lines[0][0], 'warn'); A.ok(!lines[0][1].includes(FAKE_GROQ));
  A.match(createRequestId(), /^req_[0-9a-f]{12}$/);
  A.equal(requestIdFrom({ headers: { 'x-request-id': 'bad id!' } }).startsWith('req_'), true);
  A.equal(getStats().total, 1); A.equal(getRecentReports(5).length, 1);
});
t('logError never throws (broken logger, weird inputs)', () => {
  A.doesNotThrow(() => logError(undefined, {}, { logger: { warn() { throw new Error('logger down'); } } }));
  A.doesNotThrow(() => logError({ weird: Symbol('x') }, { where: {} }, { logger: {} }));
  A.doesNotThrow(() => logError(null, {}, { logger: {} }));
});

// 12. calculation protection
t('calculation: NaN/Infinity/division by zero guards', () => {
  A.throws(() => ensureFinite(NaN, 'emi'), e => e.type === 'calculation');
  A.throws(() => ensureFinite(Infinity), e => e.type === 'calculation');
  A.throws(() => safeDivide(1, 0), e => e.type === 'calculation');
  A.equal(safeDivide(10, 4), 2.5);
  A.throws(() => assertFiniteResult({ a: { b: [1, NaN] } }), /invalid number/);
  A.throws(() => assertFiniteResult({ emi: '₹NaN' }));
  A.deepEqual(assertFiniteResult({ ok: 1, s: '₹5' }), { ok: 1, s: '₹5' });
});
t('calculation: guardToolResult catches bad financial results', () => {
  A.equal(guardToolResult('calc_emi', { principal: 100000, annual_rate: 9, years: 5 }, { monthly_emi: '₹2,076', total_payment: '₹1,24,534' }).ok, true);
  A.equal(guardToolResult('calc_emi', { principal: 100000, annual_rate: 9, years: 5 }, { monthly_emi: '-₹2,076', total_payment: '₹1,24,534' }).ok, false);
  A.equal(guardToolResult('calc_emi', { principal: 100000, annual_rate: 9 }, { monthly_emi: '₹1', total_payment: '₹5,000' }).ok, false);
  A.equal(guardToolResult('calc_sip', { annual_return: 12 }, { total_invested: '₹6,00,000', future_value: '₹1,000' }).ok, false);
  A.equal(guardToolResult('calc_sip', { annual_return: -5 }, { total_invested: '₹6,00,000', future_value: '₹5,00,000', estimated_gain: '-₹1,00,000' }).ok, true);
  A.equal(guardToolResult('calc_lumpsum', { principal: 1000, annual_rate: 8 }, { maturity_amount: '₹900' }).ok, false);
  A.equal(guardToolResult('calc_gst', { gst_rate: 18 }, { base_amount: '₹100', total_amount: '₹50' }).ok, false);
  A.equal(guardToolResult('calc_cagr', {}, { cagr_percent: NaN }).ok, false);
  A.equal(guardToolResult('calc_emi', {}, null).ok, false);
  const v = guardToolResult('calc_emi', {}, { error: 'principal missing hai' });
  A.equal(v.ok, false); A.equal(v.error.type, 'validation');
  const c = guardToolResult('calc_emi', {}, { error: 'Amount calculate nahi ho paya.' });
  A.equal(c.error.type, 'calculation');
});

// 13. safe fallback
t('fallback: controlled message, koi number nahi, generated=false', () => {
  for (const e of [new Error('Groq HTTP 500'), new Error('Groq timeout'), new Error('GEMINI_API_KEY missing'), new TypeError('boom'), new Error('NaN')]) {
    const f = safeFallbackResponse(e, { requestId: 'req_test1234' });
    A.equal(f.fallback, true); A.equal(f.generated, false);
    A.ok(!/\d/.test(f.reply), f.reply);
    A.match(f.reply, /nahi banaya/);
    A.equal(f.requestId, 'req_test1234');
  }
  const rl = safeFallbackResponse(mkErr('x HTTP 429', { headers: { 'retry-after': '9' } }));
  A.equal(rl.retryable, true); A.equal(rl.retryAfterSeconds, 9);
});

// 14. severity
t('severity: minor/warning/critical priority', () => {
  const sev = x => classifyError(x).severity;
  A.equal(sev(new Error('principal missing hai')), 'minor');
  A.equal(sev(new Error('Groq HTTP 503')), 'warning');
  A.equal(sev(new Error('Groq timeout')), 'warning');
  A.equal(sev(new Error('Groq HTTP 429')), 'warning');
  A.equal(sev(new Error('Groq HTTP 401')), 'critical');
  A.equal(sev(new TypeError('x')), 'critical');
  A.equal(sev(new Error('NaN')), 'critical');
  A.ok(compareSeverity('critical', 'warning') > 0 && compareSeverity('minor', 'warning') < 0);
  A.equal(shouldAlert('critical'), true); A.equal(shouldAlert('warning'), false);
});

// HTTP response + wrapper
t('http: status mapping, Retry-After header, zero leakage of internals', () => {
  const secretErr = new Error('Groq HTTP 500: Authorization: Bearer ' + FAKE_OR + ' stack at /var/task/api/chat.js');
  const r = toHttpResponse(secretErr, { requestId: 'req_leak0001' });
  const s = JSON.stringify(r.body);
  A.equal(r.status, 503);
  A.ok(!s.includes(FAKE_OR) && !s.includes('/var/task') && !s.includes('Groq'));
  A.deepEqual(Object.keys(r.body).sort(), ['message', 'requestId', 'retryable']);
  const rl = toHttpResponse(mkErr('slow HTTP 429', { headers: { 'retry-after': '7' } }));
  A.equal(rl.status, 503); A.equal(rl.headers['Retry-After'], '7'); A.equal(rl.body.retryAfterSeconds, 7);
  const ur = toHttpResponse(new Error('x'), { scope: 'user' });
  A.equal(ur.status, 500);
  const user = toHttpResponse(new Error('too many requests'), { scope: 'user' });
  A.equal(user.status, 429); A.ok(user.headers['Retry-After']);
  A.equal(toHttpResponse(new Error('GEMINI_API_KEY missing')).status, 503);
  A.equal(toHttpResponse(new Error('Groq HTTP 504')).status, 504);
  A.equal(toHttpResponse(new Error('Groq HTTP 413: too big')).status, 413);
  const dbg = toHttpResponse(new Error('token=' + FAKE_GROQ), { debug: true });
  A.ok(dbg.body.debug && !JSON.stringify(dbg.body).includes(FAKE_GROQ));
});
t('wrapHandler: throw => sanitized JSON + request id; no double send', async () => {
  const res = { headers: {}, headersSent: false, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
  const logs = [];
  const h = wrapHandler(async () => { throw new TypeError('secret ' + FAKE_GROQ); }, { logger: { error: x => logs.push(x) } });
  await h({ headers: {} }, res);
  A.equal(res.code, 500); A.ok(res.body.requestId.startsWith('req_')); A.equal(res.headers['X-Request-Id'], res.body.requestId);
  A.ok(!JSON.stringify(res.body).includes(FAKE_GROQ)); A.ok(!logs.join('').includes(FAKE_GROQ));
  const sent = { headersSent: true, setHeader() {}, status() { throw new Error('should not send'); } };
  await A.doesNotReject(wrapHandler(async () => { throw new Error('late'); }, { logger: {} })({ headers: {} }, sent));
  const okRes = await wrapHandler(async () => 'fine')({ headers: {} }, { setHeader() {} });
  A.equal(okRes, 'fine');
});

// end-to-end: provider failure flow
t('flow: API failure => retry => fallback response (no fake numbers)', async () => {
  let calls = 0;
  try {
    await retry(() => withTimeout(async () => { calls++; throw mkErr('Groq HTTP 502: bad gateway'); }, 100, 'Groq'), { retries: 1, sleep: noSleep });
    A.fail('should fail');
  } catch (e) {
    A.equal(calls, 2);
    const f = safeFallbackResponse(e, { requestId: 'req_flow00001' });
    A.equal(f.generated, false); A.ok(!/\d/.test(f.reply));
  }
});

async function selfTest(opts = {}) {
  const results = [];
  const log = opts.silent ? () => {} : console.log;
  const savedStats = JSON.stringify(stats);
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      results.push({ name, ok: true });
      log('  ✓ ' + name);
    } catch (e) {
      results.push({ name, ok: false, error: sanitize(e && e.message ? e.message : String(e), { maxLen: 300 }) });
      log('  ✗ ' + name + '\n      ' + (e && e.message ? String(e.message).split('\n')[0] : e));
    }
  }
  resetErrorState();
  Object.assign(stats, JSON.parse(savedStats));
  const failed = results.filter(r => !r.ok);
  return { total: results.length, passed: results.length - failed.length, failed: failed.length, failures: failed, results };
}

/* ========================================================================== */

module.exports = {
  // types & severity
  ERROR_TYPES, SEVERITY, TYPE_DEFAULTS, AppError, compareSeverity, shouldAlert,
  // detection + messages
  classifyError, friendlyMessage, extractRetryAfterMs, parseRetryAfter,
  // timeout / retry
  withTimeout, retry, createCircuitBreaker,
  // input + calculation guards
  validateFinanceInput, assertValidInput, ensureFinite, safeDivide, assertFiniteResult,
  checkFinancialResult, guardToolResult, parseINR,
  // privacy + reports
  sanitize, redactObject, createRequestId, requestIdFrom, buildReport, logError,
  getRecentReports, getStats, resetErrorState,
  // responses
  safeFallbackResponse, toHttpResponse, wrapHandler,
  // testing
  selfTest
};

if (require.main === module) {
  const asJson = process.argv.includes('--json');
  if (!asJson) console.log('Rupeyantra error-handler self test\n');
  selfTest({ silent: asJson }).then(r => {
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else console.log('\n' + r.passed + '/' + r.total + ' tests pass' + (r.failed ? ', ' + r.failed + ' FAIL' : ''));
    process.exit(r.failed ? 1 : 0);
  });
}
