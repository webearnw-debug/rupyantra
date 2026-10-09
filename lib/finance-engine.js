
'use strict';

/*
 * Rupeyantra Finance Intelligence Engine
 * Safe standalone module.
 *
 * Is version mein existing api/chat.js ko change nahi kiya gaya.
 * Ye functions tab active honge jab backend inhe import karke call karega.
 */

const LIMITS = Object.freeze({
  maxAmount: 1e12,
  maxYears: 100,
  maxAnnualRate: 100
});

function toNumber(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    throw new Error(fieldName + ' dena zaroori hai.');
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    throw new Error(fieldName + ' valid number hona chahiye.');
  }

  return n;
}

function formatINR(value) {
  if (!Number.isFinite(value)) {
    throw new Error('Amount calculate nahi ho paya.');
  }

  return '₹' + value.toLocaleString('en-IN', {
    maximumFractionDigits: 2
  });
}

function validateAmount(value, name = 'Amount') {
  const n = toNumber(value, name);

  if (n <= 0 || n > LIMITS.maxAmount) {
    throw new Error(name + ' allowed range mein nahi hai.');
  }

  return n;
}

function validateYears(value) {
  const n = toNumber(value, 'Duration');

  if (n <= 0 || n > LIMITS.maxYears) {
    throw new Error('Duration 0 se zyada aur 100 saal tak honi chahiye.');
  }

  return n;
}

function detectFinanceIntent(message) {
  const text = String(message || '').toLowerCase();

  const patterns = [
    {
      intent: 'emi',
      words: /\b(emi|loan installment|home loan|car loan|personal loan)\b/
    },
    {
      intent: 'sip',
      words: /\b(sip|systematic investment|monthly investment)\b/
    },
    {
      intent: 'fd_lumpsum',
      words: /\b(fd|fixed deposit|lumpsum|lump sum|maturity amount)\b/
    },
    {
      intent: 'cagr',
      words: /\b(cagr|annual growth rate|compound annual growth)\b/
    },
    {
      intent: 'simple_interest',
      words: /\b(simple interest|saadhaaran byaaj|sadharan byaj)\b/
    },
    {
      intent: 'gst',
      words: /\b(gst|goods and services tax)\b/
    },
    {
      intent: 'inflation',
      words: /\b(inflation|mehngai|महंगाई)\b/
    },
    {
      intent: 'budget',
      words: /\b(budget|monthly expenses|kharcha|bachat|saving plan)\b/
    }
  ];

  const match = patterns.find(item => item.words.test(text));

  return match ? match.intent : 'general';
}

function calculateEMI({ principal, annual_rate, months, years }) {
  const P = validateAmount(principal, 'Loan amount');
  const rate = toNumber(annual_rate, 'Annual interest rate');

  const n = months !== undefined && months !== null && months !== ''
    ? toNumber(months, 'Months')
    : validateYears(years) * 12;

  if (rate < 0 || rate > LIMITS.maxAnnualRate ||
      n <= 0 || n > 1200) {
    throw new Error('Interest rate ya loan duration valid nahi hai.');
  }

  const r = rate / 1200;
  const emi = r === 0
    ? P / n
    : P * r * Math.pow(1 + r, n) /
      (Math.pow(1 + r, n) - 1);

  return {
    monthly_emi: formatINR(emi),
    total_payment: formatINR(emi * n),
    total_interest: formatINR(emi * n - P),
    months: n
  };
}

function calculateSIP({ monthly_amount, annual_return, years }) {
  const monthly = validateAmount(monthly_amount, 'Monthly SIP');
  const rate = toNumber(annual_return, 'Assumed annual return');
  const duration = validateYears(years);

  if (rate < -50 || rate > LIMITS.maxAnnualRate) {
    throw new Error('Assumed return valid range mein nahi hai.');
  }

  const n = Math.round(duration * 12);
  const r = rate / 1200;

  const invested = monthly * n;
  const future = r === 0
    ? invested
    : monthly * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);

  return {
    total_invested: formatINR(invested),
    estimated_future_value: formatINR(future),
    estimated_gain: formatINR(future - invested),
    disclaimer: 'Ye assumption-based estimate hai. Market returns guaranteed nahi hain.'
  };
}

function getFinanceDisclaimer(intent) {
  if (intent === 'sip') {
    return 'SIP returns market par depend karte hain; koi return guaranteed nahi hai.';
  }

  if (intent === 'fd_lumpsum') {
    return 'Actual maturity bank/NBFC ke rate, compounding aur tax rules par depend kar sakti hai.';
  }

  if (intent === 'emi') {
    return 'Actual EMI lender ke rate, fees aur loan terms ke hisaab se alag ho sakti hai.';
  }

  return 'Yeh general financial information hai, personal financial advice nahi.';
}

function analyzeMessage(message) {
  const intent = detectFinanceIntent(message);

  return {
    intent,
    needsCalculator: [
      'emi',
      'sip',
      'fd_lumpsum',
      'cagr',
      'simple_interest',
      'gst',
      'inflation'
    ].includes(intent),
    disclaimer: getFinanceDisclaimer(intent)
  };
}

module.exports = {
  detectFinanceIntent,
  analyzeMessage,
  formatINR,
  validateAmount,
  validateYears,
  calculateEMI,
  calculateSIP,
  getFinanceDisclaimer
};
