<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rupyantra — Loan &amp; Investment Calculators</title>
<meta name="description" content="Free EMI and SIP calculators, live market data, and an AI finance assistant.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,500&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #F0F1EA;
    --bg-alt: #E7E9DF;
    --ink: #16261F;
    --ink-soft: #4A574C;
    --brand: #1F5C43;
    --brand-deep: #15402F;
    --accent: #C9762E;
    --accent-ink: #97551C;
    --line: #C7CBBD;
    --white: #FFFFFF;
    --radius: 4px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: 'Public Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, .display {
    font-family: 'Fraunces', Georgia, serif;
    font-weight: 500;
    line-height: 1.15;
    margin: 0;
  }
  .num { font-variant-numeric: tabular-nums; }
  a { color: inherit; }
  a:focus-visible, button:focus-visible, input:focus-visible {
    outline: 2px solid var(--brand); outline-offset: 2px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

  header {
    border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: var(--bg);
    z-index: 10;
  }
  .header-inner {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px; flex-wrap: wrap; gap: 12px;
  }
  .wordmark {
    font-family: 'Fraunces', serif; font-size: 1.3rem; font-weight: 600;
    letter-spacing: -0.01em; text-decoration: none; color: var(--ink);
  }
  .wordmark span { color: var(--brand); }
  nav { display: flex; gap: 28px; }
  nav a { text-decoration: none; font-size: 0.95rem; font-weight: 500; color: var(--ink-soft); position: relative; padding-bottom: 2px; }
  nav a:hover { color: var(--brand); }
  nav a::after { content: ''; position: absolute; left: 0; bottom: -2px; width: 0; height: 1.5px; background: var(--brand); transition: width .25s ease; }
  nav a:hover::after { width: 100%; }
  header { transition: box-shadow .25s ease; }
  header.scrolled { box-shadow: 0 2px 14px rgba(21,64,47,0.08); }

  .hero { padding: 72px 0 64px; border-bottom: 1px solid var(--line); }
  .hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: start; }
  .hero h1 { font-size: clamp(2.1rem, 4vw, 3rem); max-width: 11ch; }
  .hero p.lede { margin-top: 20px; max-width: 42ch; color: var(--ink-soft); font-size: 1.05rem; }

  .calc { background: var(--white); border: 1px solid var(--line); border-radius: var(--radius); padding: 28px; }
  .calc h3 { font-size: 1.1rem; margin-bottom: 4px; }
  .calc .sub { color: var(--ink-soft); font-size: 0.88rem; margin-bottom: 22px; }
  .field { margin-bottom: 18px; }
  .field label {
    display: flex; justify-content: space-between; font-size: 0.85rem;
    font-weight: 600; margin-bottom: 8px; color: var(--ink);
  }
  .field label .val { color: var(--brand); }
  input[type=range] { width: 100%; accent-color: var(--brand); height: 4px; }

  .result { margin-top: 24px; padding-top: 22px; border-top: 1px dashed var(--line); }
  .result .label { font-size: 0.8rem; color: var(--ink-soft); margin-bottom: 2px; }
  .result .big { font-family: 'Fraunces', serif; font-size: 2rem; color: var(--brand-deep); }
  .breakdown { display: flex; gap: 18px; margin-top: 16px; font-size: 0.85rem; flex-wrap: wrap; }
  .breakdown .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 14px; background: var(--bg-alt); }
  .bar-principal { background: var(--brand); transition: width .5s cubic-bezier(.4,0,.2,1); }
  .bar-interest { background: var(--accent); transition: width .5s cubic-bezier(.4,0,.2,1); }
  .result .big.pulse { animation: resultPulse .4s ease; }
  @keyframes resultPulse { 0% { transform: scale(1); } 45% { transform: scale(1.05); color: var(--accent-ink); } 100% { transform: scale(1); } }

  section.block { padding: 64px 0; border-bottom: 1px solid var(--line); }
  .block-head { max-width: 52ch; margin-bottom: 40px; }
  .block-head h2 { font-size: clamp(1.6rem, 3vw, 2.1rem); }
  .block-head p { color: var(--ink-soft); margin-top: 12px; }

  .ledger { border-top: 1px solid var(--line); }
  .ledger-row { display: flex; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--line); font-size: 0.95rem; }
  .ledger-row .name { font-weight: 600; }
  .ledger-row .tag { color: var(--ink-soft); font-size: 0.85rem; }

  .chat-mock { border: 1px solid var(--line); border-radius: var(--radius); background: var(--white); padding: 24px; max-width: 520px; }
  .bubble { background: var(--bg-alt); padding: 12px 16px; border-radius: 10px; margin-bottom: 12px; font-size: 0.92rem; max-width: 85%; }
  .bubble.me { background: var(--brand); color: var(--white); margin-left: auto; }
  .soon-badge {
    display: inline-block; font-size: 0.75rem; font-weight: 600; color: var(--accent-ink);
    border: 1px solid var(--accent-ink); padding: 3px 9px; border-radius: 20px; margin-bottom: 14px;
    animation: badgePulse 2.4s ease-in-out infinite;
  }
  @keyframes badgePulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(151,85,28,0.22); } 50% { box-shadow: 0 0 0 6px rgba(151,85,28,0); } }
  .reveal { opacity: 0; transform: translateY(18px); transition: opacity .6s ease, transform .6s ease; }
  .reveal.in-view { opacity: 1; transform: translateY(0); }
  input[type=range]::-webkit-slider-thumb { transition: transform .15s ease; }
  input[type=range]:active::-webkit-slider-thumb { transform: scale(1.3); }
  input[type=range]::-moz-range-thumb { transition: transform .15s ease; }
  input[type=range]:active::-moz-range-thumb { transform: scale(1.3); }
  .typing-dots { display: inline-flex; gap: 4px; padding: 4px 0; }
  .typing-dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-soft); animation: typingBounce 1.2s infinite ease-in-out; }
  .typing-dots span:nth-child(2) { animation-delay: .15s; }
  .typing-dots span:nth-child(3) { animation-delay: .3s; }
  @keyframes typingBounce { 0%,60%,100% { transform: translateY(0); opacity:.5; } 30% { transform: translateY(-5px); opacity:1; } }

  footer { padding: 40px 0 60px; }
  .footer-grid { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 20px; align-items: center; }
  footer nav { flex-wrap: wrap; gap: 20px; }
  footer .note { color: var(--ink-soft); font-size: 0.82rem; margin-top: 24px; max-width: 60ch; }

  @media (max-width: 780px) {
    .hero { padding: 48px 0; }
    .hero-grid { grid-template-columns: 1fr; gap: 40px; }
    nav { width: 100%; justify-content: space-between; gap: 14px; font-size: 0.88rem; }
    .calc { padding: 20px; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .reveal { opacity: 1; transform: none; transition: none; }
    .soon-badge { animation: none; }
    .bar-principal, .bar-interest { transition: none; }
    .typing-dots span { animation: none; opacity: .6; }
  }
</style>
</head>
<body>

<header>
  <div class="header-inner wrap">
    <a href="#" class="wordmark">Rupy<span>antra</span></a>
    <nav>
      <a href="#calculators">Calculators</a>
      <a href="#market">Market Data</a>
      <a href="#assistant">Ask AI</a>
      <a href="habits.html">Discipline</a>
      <a href="#about">About</a>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="wrap hero-grid">
    <div class="reveal">
      <h1>Know the real cost before you sign a loan.</h1>
      <p class="lede">Move the sliders and watch your monthly instalment, total interest, and payoff numbers update instantly — no spreadsheet required.</p>
    </div>
    <div class="calc reveal" id="emi-calc" style="transition-delay:.1s;">
      <h3>Loan EMI</h3>
      <div class="sub">For home, car, personal or education loans</div>

      <div class="field">
        <label>Loan amount <span class="val num" id="emiAmountVal">₹10,00,000</span></label>
        <input type="range" id="emiAmount" min="50000" max="10000000" step="10000" value="1000000" aria-label="Loan amount">
      </div>
      <div class="field">
        <label>Interest rate (annual) <span class="val num" id="emiRateVal">9.0%</span></label>
        <input type="range" id="emiRate" min="4" max="20" step="0.1" value="9" aria-label="Interest rate">
      </div>
      <div class="field">
        <label>Tenure <span class="val num" id="emiTenureVal">5 years</span></label>
        <input type="range" id="emiTenure" min="1" max="30" step="1" value="5" aria-label="Loan tenure in years">
      </div>

      <div class="result">
        <div class="label">Monthly EMI</div>
        <div class="big num" id="emiResult">₹0</div>
        <div class="bar"><div class="bar-principal" id="barPrincipal" style="width:60%"></div><div class="bar-interest" id="barInterest" style="width:40%"></div></div>
        <div class="breakdown">
          <div><span class="dot" style="background:var(--brand)"></span>Principal: <span class="num" id="emiPrincipalOut">₹0</span></div>
          <div><span class="dot" style="background:var(--accent)"></span>Total interest: <span class="num" id="emiInterestOut">₹0</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="block" id="calculators">
  <div class="wrap">
    <div class="block-head reveal">
      <h2>See what small, regular investing adds up to.</h2>
      <p>A monthly SIP compounds over time. Adjust the amount, expected return, and duration to see it grow.</p>
    </div>

    <div class="calc reveal" id="sip-calc" style="max-width:560px;transition-delay:.1s;">
      <div class="field">
        <label>Monthly investment <span class="val num" id="sipAmountVal">₹5,000</span></label>
        <input type="range" id="sipAmount" min="500" max="100000" step="500" value="5000" aria-label="Monthly SIP amount">
      </div>
      <div class="field">
        <label>Expected annual return <span class="val num" id="sipRateVal">12.0%</span></label>
        <input type="range" id="sipRate" min="1" max="25" step="0.5" value="12" aria-label="Expected annual return">
      </div>
      <div class="field">
        <label>Duration <span class="val num" id="sipYearsVal">10 years</span></label>
        <input type="range" id="sipYears" min="1" max="40" step="1" value="10" aria-label="Investment duration in years">
      </div>

      <div class="result">
        <div class="label">Maturity value</div>
        <div class="big num" id="sipResult">₹0</div>
        <div class="bar"><div class="bar-principal" id="sipBarInvested" style="width:60%"></div><div class="bar-interest" id="sipBarGains" style="width:40%"></div></div>
        <div class="breakdown">
          <div><span class="dot" style="background:var(--brand)"></span>Invested: <span class="num" id="sipInvestedOut">₹0</span></div>
          <div><span class="dot" style="background:var(--accent)"></span>Est. gains: <span class="num" id="sipGainsOut">₹0</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="block" id="market">
  <div class="wrap">
    <div class="block-head reveal">
      <span class="soon-badge">Coming soon</span>
      <h2>Live market data, at a glance.</h2>
      <p>Sensex, Nifty, gold, and exchange rates — updating in real time.</p>
    </div>
    <div class="ledger">
      <div class="ledger-row reveal" style="transition-delay:.05s;"><span class="name">Sensex</span><span class="tag">—</span></div>
      <div class="ledger-row reveal" style="transition-delay:.1s;"><span class="name">Nifty 50</span><span class="tag">—</span></div>
      <div class="ledger-row reveal" style="transition-delay:.15s;"><span class="name">Gold (10g)</span><span class="tag">—</span></div>
      <div class="ledger-row reveal" style="transition-delay:.2s;"><span class="name">USD / INR</span><span class="tag">—</span></div>
    </div>
  </div>
</section>

<section class="block" id="assistant" style="border-bottom:none;">
  <div class="wrap">
    <div class="block-head reveal">
      <span class="soon-badge">Coming soon</span>
      <h2>Ask a question, get a straight answer.</h2>
      <p>An assistant trained on the numbers on this page — no jargon, no sales pitch.</p>
    </div>
    <div class="chat-mock reveal" style="transition-delay:.1s;">
      <div class="bubble me">Which is better, prepaying my home loan or investing the extra in a SIP?</div>
      <div class="bubble" id="typingBubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>
    </div>
  </div>
</section>

<footer id="about">
  <div class="wrap reveal">
    <div class="footer-grid">
      <span class="wordmark" style="font-size:1.1rem;">Rupy<span>antra</span></span>
      <nav>
        <a href="#">Contact</a>
        <a href="#">Privacy Policy</a>
      </nav>
    </div>
    <p class="note">Rupyantra provides educational calculators, not personalised financial advice. Figures are estimates — confirm exact terms with your lender or advisor before making a decision.</p>
  </div>
</footer>

<script>
window.addEventListener('scroll', () => {
  document.querySelector('header').classList.toggle('scrolled', window.scrollY > 10);
});

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

const typingBubble = document.getElementById('typingBubble');
if (typingBubble) {
  const chatObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          typingBubble.innerHTML = "Depends on your loan's interest rate versus your expected SIP return — I'll walk you through the comparison once I'm live.";
        }, 900);
        chatObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.4 });
  chatObserver.observe(typingBubble);
}

function formatINR(num) {
  num = Math.round(num);
  return '₹' + num.toLocaleString('en-IN');
}

const emiAmount = document.getElementById('emiAmount');
const emiRate = document.getElementById('emiRate');
const emiTenure = document.getElementById('emiTenure');

function calcEMI() {
  const P = parseFloat(emiAmount.value);
  const annualRate = parseFloat(emiRate.value);
  const years = parseFloat(emiTenure.value);
  const r = annualRate / 12 / 100;
  const n = years * 12;

  document.getElementById('emiAmountVal').textContent = formatINR(P);
  document.getElementById('emiRateVal').textContent = annualRate.toFixed(1) + '%';
  document.getElementById('emiTenureVal').textContent = years + (years == 1 ? ' year' : ' years');

  let emi = (r === 0) ? (P / n) : (P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
  const totalPayment = emi * n;
  const totalInterest = totalPayment - P;

  document.getElementById('emiResult').textContent = formatINR(emi) + ' / month';
  document.getElementById('emiPrincipalOut').textContent = formatINR(P);
  document.getElementById('emiInterestOut').textContent = formatINR(totalInterest);

  const principalPct = (P / totalPayment) * 100;
  document.getElementById('barPrincipal').style.width = principalPct + '%';
  document.getElementById('barInterest').style.width = (100 - principalPct) + '%';
}
function pulseResult(id) {
  const el = document.getElementById(id);
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}
[emiAmount, emiRate, emiTenure].forEach(el => {
  el.addEventListener('input', calcEMI);
  el.addEventListener('change', () => pulseResult('emiResult'));
});
calcEMI();

const sipAmount = document.getElementById('sipAmount');
const sipRate = document.getElementById('sipRate');
const sipYears = document.getElementById('sipYears');

function calcSIP() {
  const P = parseFloat(sipAmount.value);
  const annualRate = parseFloat(sipRate.value);
  const years = parseFloat(sipYears.value);
  const i = annualRate / 12 / 100;
  const n = years * 12;

  document.getElementById('sipAmountVal').textContent = formatINR(P);
  document.getElementById('sipRateVal').textContent = annualRate.toFixed(1) + '%';
  document.getElementById('sipYearsVal').textContent = years + (years == 1 ? ' year' : ' years');

  let fv = (i === 0) ? (P * n) : (P * ((Math.pow(1 + i, n) - 1) / i) * (1 + i));
  const invested = P * n;
  const gains = fv - invested;

  document.getElementById('sipResult').textContent = formatINR(fv);
  document.getElementById('sipInvestedOut').textContent = formatINR(invested);
  document.getElementById('sipGainsOut').textContent = formatINR(gains);

  const investedPct = (invested / fv) * 100;
  document.getElementById('sipBarInvested').style.width = investedPct + '%';
  document.getElementById('sipBarGains').style.width = (100 - investedPct) + '%';
}
[sipAmount, sipRate, sipYears].forEach(el => {
  el.addEventListener('input', calcSIP);
  el.addEventListener('change', () => pulseResult('sipResult'));
});
calcSIP();
</script>

</body>
</html>
