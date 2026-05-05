import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// SDDE SYSTEMIC RISK MONITOR
// Mathematical foundation: Papers 1–4, Closed-Loop paper
// Live data: Yahoo Finance v8 (direct browser fetch, no API key required)
// NO signal generation · NO corridor logic · NO entry/exit logic
// ─────────────────────────────────────────────────────────────────────────────

// ── MATH SYMBOLS ─────────────────────────────────────────────────────────────
const M = {
  Delta:"Δ", lambda:"λ", mu:"μ", tau:"τ", gamma:"γ", alpha:"α", beta:"β",
  pm:"±", leq:"≤", arrow:"→", inf:"∞", R:"ℝ", L2:"L²", M2:"ℳ₂", oplus:"⊕",
  Lmax:"Λₘₐₓ", tauC:"τ꜀",
};

// ── MATH ENGINE ───────────────────────────────────────────────────────────────
function lambertW0(x) {
  if (x < -1 / Math.E) return NaN;
  if (x === 0) return 0;
  let w = x < 1 ? x : Math.log(x);
  for (let i = 0; i < 100; i++) {
    const ew = Math.exp(w), wew = w * ew;
    const d = (wew - x) / (ew * (w + 1) - ((w + 2) * (wew - x)) / (2 * w + 2));
    w -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return w;
}

const criticalDelay = (mu) => 1.0 / (Math.abs(mu) * Math.E);

function spectralAbscissa(mu, tau) {
  const tauC = criticalDelay(mu);
  if (tau <= 0 || tau >= tauC) return { a: 0, b: 0, valid: false };
  const arg = -Math.abs(mu) * tau * Math.exp(-Math.abs(mu) * tau);
  const w = lambertW0(arg);
  if (isNaN(w)) return { a: 0, b: 0, valid: false };
  const a = w / tau - Math.abs(mu);
  const bSq = Math.max(0, mu * mu - (a / tau + mu / tau) ** 2 * tau * tau);
  return { a: Math.min(a, 0), b: Math.sqrt(bSq), valid: true };
}

function spectralGap(mu, tau) {
  const { a, valid } = spectralAbscissa(mu, tau);
  return valid ? Math.max(-a, 0) : 0;
}

function cascadeStage(mu, tau) {
  const tauC = criticalDelay(mu);
  const proximity = tau / tauC;
  const gamma = spectralGap(mu, tau);
  const gammaMax = spectralGap(mu, 0.01);
  const betaProxy = gamma - 0.15 * proximity ** 2;
  if (proximity >= 0.97)                           return { stage:4, label:"Critical",   short:"D4", severity:1.0  };
  if (betaProxy <= 0)                              return { stage:3, label:"Decay Loss", short:"D3", severity:0.75 };
  if (gamma < 0.15 * gammaMax && proximity > 0.7) return { stage:2, label:"Stressed",   short:"D2", severity:0.5  };
  if (gamma < 0.35 * gammaMax)                     return { stage:1, label:"Elevated",   short:"D1", severity:0.25 };
  return                                                  { stage:0, label:"Stable",      short:"—",  severity:0   };
}

function estimateTau(returns, muEst, tauMin, tauMax) {
  if (!returns || returns.length < 5) return tauMin;
  const n = Math.min(returns.length, 60);
  const recent = returns.slice(-n);
  const mean = recent.reduce((s, x) => s + x, 0) / n;
  // Use multi-lag ACF to get a richer memory estimate
  let acfSum = 0, varr = 0;
  for (let i = 1; i < n; i++) varr += (recent[i] - mean) ** 2;
  const lags = [1, 2, 3, 5];
  for (const lag of lags) {
    let cov = 0;
    for (let i = lag; i < n; i++) cov += (recent[i]-mean)*(recent[i-lag]-mean);
    acfSum += Math.max(0, cov / (varr || 1)) / lags.length;
  }
  // Map [0, 1] ACF signal to [tauMin, tauMax], then cap at 0.88·τ_c
  const tauRaw = tauMin + acfSum * (tauMax - tauMin);
  return Math.min(Math.max(tauRaw, tauMin), tauMax, criticalDelay(muEst) * 0.88);
}

function estimateMu(returns) {
  // Estimate mean-reversion speed from autocorrelation half-life.
  // Daily equity returns have mean-reversion half-lives of 20-90 days.
  // μ = -log(2)/half_life ensures τ_c = 1/(|μ|·e) stays well above tauMax,
  // giving a meaningful and stable proximity metric in the subcritical regime.
  if (!returns || returns.length < 15) return -Math.LN2 / 40;
  const n = Math.min(returns.length, 60);
  const recent = returns.slice(-n);
  const mean = recent.reduce((s, x) => s + x, 0) / n;
  // Estimate ACF decay: half-life from lag-1 autocorrelation
  let cov = 0, varr = 0;
  for (let i = 1; i < n; i++) {
    cov  += (recent[i] - mean) * (recent[i-1] - mean);
    varr += (recent[i] - mean) ** 2;
  }
  const acf1 = varr > 0 ? cov / varr : 0;
  // ACF1 = e^{-1/half_life} → half_life = -1/log(ACF1) if ACF1 > 0
  // Clamp half-life to [20, 90] days for stability
  let halfLife = 40; // sensible default
  if (acf1 > 0.01 && acf1 < 0.99) {
    halfLife = Math.max(20, Math.min(90, -1 / Math.log(Math.abs(acf1))));
  }
  return -Math.LN2 / halfLife;
}

function pricesToReturns(closes) {
  const r = [];
  for (let i=1; i<closes.length; i++)
    if (closes[i] > 0 && closes[i-1] > 0) r.push(Math.log(closes[i] / closes[i-1]));
  return r;
}

function mockCloses(seed, n=90, start=100, vol=0.012, drift=-0.0001) {
  const rng = (s) => { const x = Math.sin(s)*43758.5453123; return x - Math.floor(x); };
  const p = [start];
  for (let i=1; i<n; i++) {
    const z = Math.sqrt(-2*Math.log(rng(seed+i*2.9)+1e-10)) * Math.cos(2*Math.PI*rng(seed+i*7.3));
    p.push(p[i-1] * (1 + vol*z + drift));
  }
  return p;
}

// ── ASSET CONFIG ──────────────────────────────────────────────────────────────
const ASSETS = [
  { ticker:"SPY",     name:"S&P 500 ETF",    class:"B", tauMin:10, tauMax:18, color:"#5B6BF8" },
  { ticker:"QQQ",     name:"Nasdaq 100 ETF", class:"A", tauMin:8,  tauMax:14, color:"#9B59F8" },
  { ticker:"TLT",     name:"20Y Treasury",   class:"C", tauMin:15, tauMax:28, color:"#26C6A0" },
  { ticker:"GLD",     name:"Gold ETF",       class:"C", tauMin:15, tauMax:25, color:"#F59E0B" },
  { ticker:"BTC-USD", name:"Bitcoin",        class:"D", tauMin:3,  tauMax:8,  color:"#F97316" },
];

const STAGE_META = [
  { label:"Stable",     bg:"#F0FDF4", text:"#16A34A", dot:"#22C55E", bar:"#22C55E" },
  { label:"Elevated",   bg:"#FFFBEB", text:"#D97706", dot:"#F59E0B", bar:"#F59E0B" },
  { label:"Stressed",   bg:"#FFF7ED", text:"#EA580C", dot:"#F97316", bar:"#F97316" },
  { label:"Decay Loss", bg:"#FEF2F2", text:"#DC2626", dot:"#EF4444", bar:"#EF4444" },
  { label:"Critical",   bg:"#FFF0F0", text:"#B91C1C", dot:"#DC2626", bar:"#DC2626" },
];

// ── LIVE DATA — Yahoo Finance v8 ──────────────────────────────────────────────
// No API key required. Uses Yahoo chart endpoint.
// Falls back to demo data if Yahoo blocks or is unavailable.

async function fetchYahooTicker(ticker) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

  for (const host of hosts) {
    try {
     const url = `/api/yahoo?ticker=${encodeURIComponent(ticker)}`;

     const res = await fetch(url);

      if (!res.ok) throw new Error(`Yahoo ${res.status}`);

      const data = await res.json();
      const result = data?.chart?.result?.[0];

      if (!result) throw new Error(`${ticker}: no result`);

      const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
      const closes = rawCloses.filter((v) => v != null && v > 0);

      if (closes.length < 10) {
        throw new Error(`${ticker}: not enough close data`);
      }

      const meta = result.meta ?? {};

      const livePrice =
        meta.regularMarketPrice ??
        closes[closes.length - 1];

      const prevClose =
        meta.chartPreviousClose ??
        closes[closes.length - 2] ??
        closes[closes.length - 1];

      // Replace the last historical close with the latest market price when available.
      const finalCloses = [...closes.slice(0, -1), livePrice];

      return {
        price: livePrice,
        prevClose,
        closes: finalCloses,
      };
    } catch (err) {
      console.warn(`[Yahoo ${host}] ${ticker}:`, err.message);
    }
  }

  throw new Error(`${ticker}: Yahoo failed on all hosts`);
}

async function fetchAllTickers(tickers) {
  const results = await Promise.allSettled(
    tickers.map((ticker) => fetchYahooTicker(ticker))
  );

  const out = {};
  let liveCount = 0;

  results.forEach((result, i) => {
    const ticker = tickers[i];

    if (result.status === "fulfilled") {
      out[ticker] = result.value;
      liveCount++;
    } else {
      console.warn(`[Yahoo] ${ticker}:`, result.reason?.message);
      out[ticker] = null;
    }
  });

  return { data: out, liveCount };
}

// ── CHARTS ────────────────────────────────────────────────────────────────────
function PriceChart({ prices, height=180, width=600 }) {
  if (!prices || prices.length < 2) {
    return (
      <div style={{ height, display:"flex", alignItems:"center", justifyContent:"center", color:"#CBD5E1", fontSize:13 }}>
        Loading chart…
      </div>
    );
  }
  const mn = Math.min(...prices), mx = Math.max(...prices);
  const range = mx - mn || mn * 0.01 || 1;
  const pad = { t:16, b:28, l:4, r:44 };
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
  const toX = (i) => pad.l + (i / (prices.length-1)) * W;
  const toY = (v) => pad.t + H - ((v-mn)/range) * H;
  const pts = prices.map((v,i) => `${toX(i)},${toY(v)}`).join(" ");
  const area = `M ${toX(0)},${toY(prices[0])} ` +
    prices.map((v,i) => `L ${toX(i)},${toY(v)}`).join(" ") +
    ` L ${toX(prices.length-1)},${pad.t+H} L ${toX(0)},${pad.t+H} Z`;
  const isUp = prices[prices.length-1] >= prices[0];
  const lc = isUp ? "#22C55E" : "#EF4444";
  const yLabels = [
    { v:mn,             y:toY(mn)           },
    { v:mn + range*0.5, y:toY(mn+range*0.5) },
    { v:mx,             y:toY(mx)           },
  ];
  const xIdxs = [0, Math.floor(prices.length*0.25), Math.floor(prices.length*0.5), Math.floor(prices.length*0.75), prices.length-1];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
      style={{ display:"block", overflow:"visible" }}>
      <defs>
        <linearGradient id="pcg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={lc} stopOpacity="0.18" />
          <stop offset="100%" stopColor={lc} stopOpacity="0"    />
        </linearGradient>
      </defs>
      {yLabels.map(({ v, y }, i) => (
        <g key={i}>
          <line x1={pad.l} y1={y} x2={pad.l+W} y2={y} stroke="#F1F5F9" strokeWidth="1" />
          <text x={pad.l+W+6} y={y+4} fontSize="9" fill="#94A3B8">
            {v > 999 ? v.toFixed(0) : v.toFixed(2)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#pcg)" />
      <polyline points={pts} fill="none" stroke={lc} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={toX(prices.length-1)} cy={toY(prices[prices.length-1])} r="4"
        fill={lc} stroke="white" strokeWidth="2" />
      {xIdxs.map((idx, i) => (
        <text key={i} x={toX(idx)} y={pad.t+H+18} fontSize="9" fill="#94A3B8" textAnchor="middle">
          {idx === prices.length-1 ? "Now" : `-${prices.length-1-idx}d`}
        </text>
      ))}
    </svg>
  );
}

function MiniChart({ data, color, height=40, width=200 }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data), range = mx - mn || 0.001;
  const pts = data.map((v,i) =>
    `${(i/(data.length-1))*width},${height-((v-mn)/range)*height}`
  ).join(" ");
  const area = `M 0,${height} ` +
    data.map((v,i) => `L ${(i/(data.length-1))*width},${height-((v-mn)/range)*height}`).join(" ") +
    ` L ${width},${height} Z`;
  const uid = color.replace("#","");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
      style={{ display:"block" }}>
      <defs>
        <linearGradient id={`mg${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0"   />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#mg${uid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── STABILITY RING ────────────────────────────────────────────────────────────
function StabilityRing({ proximity, stage, size=56 }) {
  const meta = STAGE_META[stage];
  const r = size/2 - 5, cx = size/2, cy = size/2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ display:"block", flexShrink:0 }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#F1F5F9" strokeWidth="4" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={meta.bar} strokeWidth="4"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - Math.min(proximity, 0.99))}
        strokeLinecap="round"
        style={{
          transformOrigin:`${cx}px ${cy}px`,
          transform:"rotate(-90deg)",
          transition:"stroke-dashoffset 0.6s ease, stroke 0.6s ease",
        }}
      />
      <text x={cx} y={cy+4} textAnchor="middle" fontSize="10" fontWeight="700"
        fill={meta.text} fontFamily="system-ui,sans-serif">
        {(proximity*100).toFixed(0)}%
      </text>
    </svg>
  );
}

// ── ASSET CARD ────────────────────────────────────────────────────────────────
function AssetCard({ asset, data, isSelected, onClick }) {
  if (!data) {
    return (
      <div onClick={onClick} style={{
        background:"white", borderRadius:16, padding:"16px 20px", cursor:"pointer",
        border:"1.5px solid #F1F5F9", opacity:0.5, display:"flex", alignItems:"center", gap:12,
      }}>
        <div style={{ width:40, height:40, borderRadius:12, background:"#F8FAFC", flexShrink:0 }} />
        <div>
          <div style={{ fontWeight:700, fontSize:15, color:"#0F172A" }}>{asset.ticker}</div>
          <div style={{ fontSize:12, color:"#94A3B8", marginTop:2 }}>Loading…</div>
        </div>
      </div>
    );
  }

  const { cascade, tau, tauC, priceNow, pricePrev, prices } = data;
  const meta = STAGE_META[cascade.stage];
  const pct = ((priceNow - pricePrev) / pricePrev) * 100;
  const isUp = pct >= 0;
  const proximity = Math.min(tau / tauC, 0.999);
  const sparkPrices = prices?.slice(-20) ?? [];

  return (
    <div onClick={onClick} style={{
      background:"white", borderRadius:16, padding:"16px 20px", cursor:"pointer",
      border: isSelected ? `1.5px solid ${asset.color}` : "1.5px solid #F1F5F9",
      boxShadow: isSelected ? `0 0 0 3px ${asset.color}20` : "0 1px 4px rgba(0,0,0,0.04)",
      transition:"all 0.2s",
    }}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{
            width:40, height:40, borderRadius:12, flexShrink:0,
            background:`${asset.color}15`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontWeight:800, fontSize:11, color:asset.color, letterSpacing:0.5,
          }}>
            {asset.ticker.replace("-USD","")}
          </div>
          <div>
            <div style={{ fontWeight:700, fontSize:14, color:"#0F172A", lineHeight:1.2 }}>
              {asset.ticker}
            </div>
            <div style={{ fontSize:11, color:"#94A3B8", marginTop:1 }}>{asset.name}</div>
          </div>
        </div>
        <div style={{
          padding:"3px 10px", borderRadius:20,
          background:meta.bg, color:meta.text,
          fontSize:11, fontWeight:600, border:`1px solid ${meta.bar}30`, whiteSpace:"nowrap",
        }}>
          {cascade.label}
        </div>
      </div>

      <div style={{ marginTop:14, display:"flex", alignItems:"baseline", gap:8 }}>
        <span style={{ fontSize:22, fontWeight:700, color:"#0F172A", letterSpacing:-0.5 }}>
          {priceNow > 1000 ? priceNow.toFixed(0) : priceNow.toFixed(2)}
        </span>
        <span style={{ fontSize:13, fontWeight:600, color: isUp ? "#16A34A" : "#DC2626" }}>
          {isUp ? "+" : ""}{pct.toFixed(2)}%
        </span>
      </div>

      {sparkPrices.length > 1 && (
        <div style={{ marginTop:8, height:32 }}>
          <MiniChart data={sparkPrices} color={isUp ? "#22C55E" : "#EF4444"} height={32} width={200} />
        </div>
      )}

      <div style={{ marginTop:10, display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ flex:1, background:"#F8FAFC", borderRadius:4, height:4 }}>
          <div style={{
            width:`${Math.min(proximity*100,100)}%`, height:"100%",
            background:meta.bar, borderRadius:4,
            transition:"width 0.5s, background 0.5s",
          }} />
        </div>
        <span style={{ fontSize:10, color:"#94A3B8", whiteSpace:"nowrap" }}>
          {M.tau}/{M.tauC} {(proximity*100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

// ── DETAIL PANEL ──────────────────────────────────────────────────────────────
function DetailPanel({ asset, data }) {
  const [range, setRange] = useState("3M");
  if (!data) return null;

  const { prices, cascade, gamma, tau, tauC, mu, priceNow, pricePrev, gammaHistory } = data;
  const meta = STAGE_META[cascade.stage];
  const pct = ((priceNow - pricePrev) / pricePrev) * 100;
  const isUp = pct >= 0;
  const proximity = Math.min(tau / tauC, 0.999);
  const rangeLens = { "1M":22, "3M":66, "6M":130 };
  const chartPrices = (prices || []).slice(-(rangeLens[range] || 66));

  const stats = [
    { label:`${M.gamma}(${M.tau}) Spectral Gap`, value:gamma.toFixed(5),    sub:`−Re(${M.lambda}±(${M.tau}))` },
    { label:`Delay ${M.tau}`,                    value:`${tau.toFixed(1)}d`, sub:`${M.tauC} = ${tauC.toFixed(1)}d` },
    { label:`Mean-Rev. ${M.mu}`,                 value:mu.toFixed(4),        sub:"AR(1) estimate" },
    { label:"Cascade Stage",                     value:`${cascade.short} / D${cascade.stage}`, sub:cascade.label },
  ];

  return (
    <div style={{
      background:"white", borderRadius:20, padding:"24px 28px",
      border:"1.5px solid #F1F5F9", boxShadow:"0 2px 8px rgba(0,0,0,0.04)",
    }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{
            width:44, height:44, borderRadius:13, flexShrink:0,
            background:`${asset.color}15`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontWeight:800, fontSize:12, color:asset.color,
          }}>
            {asset.ticker.replace("-USD","")}
          </div>
          <div>
            <div style={{ fontWeight:700, fontSize:18, color:"#0F172A" }}>{asset.ticker}</div>
            <div style={{ fontSize:12, color:"#94A3B8" }}>{asset.name}</div>
          </div>
        </div>
        <div style={{
          padding:"4px 14px", borderRadius:20,
          background:meta.bg, color:meta.text,
          fontSize:12, fontWeight:600, border:`1px solid ${meta.bar}30`,
        }}>
          {cascade.label}
        </div>
      </div>

      {/* Big price */}
      <div style={{ marginBottom:4 }}>
        <div style={{ fontSize:36, fontWeight:700, color:"#0F172A", letterSpacing:-1, lineHeight:1.1 }}>
          {priceNow > 1000 ? `$${priceNow.toFixed(0)}` : `$${priceNow.toFixed(2)}`}
        </div>
        <div style={{ fontSize:14, fontWeight:600, color:isUp ? "#16A34A" : "#DC2626", marginTop:2 }}>
          {isUp ? "+" : ""}{pct.toFixed(2)}% today
        </div>
      </div>

      {/* Range tabs */}
      <div style={{ display:"flex", gap:4, marginBottom:12, marginTop:16 }}>
        {["1M","3M","6M"].map(r => (
          <button key={r} onClick={() => setRange(r)} style={{
            padding:"4px 14px", borderRadius:20, border:"none", cursor:"pointer",
            background: range===r ? "#0F172A" : "transparent",
            color: range===r ? "white" : "#64748B",
            fontSize:12, fontWeight:600, transition:"all 0.15s",
          }}>{r}</button>
        ))}
      </div>

      {/* Price chart */}
      <div style={{ height:180, marginBottom:20 }}>
        <PriceChart prices={chartPrices} width={600} height={180} />
      </div>

      <div style={{ height:1, background:"#F8FAFC", margin:"0 -28px 20px" }} />

      {/* Spectral metrics */}
      <div style={{ marginBottom:12 }}>
        <div style={{
          fontSize:11, fontWeight:700, color:"#94A3B8",
          letterSpacing:1, textTransform:"uppercase", marginBottom:12,
        }}>
          Spectral Analysis
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          {stats.map(({ label, value, sub }) => (
            <div key={label} style={{ background:"#F8FAFC", borderRadius:12, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:"#94A3B8", marginBottom:4 }}>{label}</div>
              <div style={{ fontSize:17, fontWeight:700, color:"#0F172A", letterSpacing:-0.3 }}>{value}</div>
              <div style={{ fontSize:10, color:"#CBD5E1", marginTop:2 }}>{sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* γ(τ) history */}
      <div style={{ marginTop:16 }}>
        <div style={{
          fontSize:11, fontWeight:700, color:"#94A3B8",
          letterSpacing:1, textTransform:"uppercase", marginBottom:8,
        }}>
          {M.gamma}({M.tau}) Spectral Gap History
        </div>
        <div style={{ background:"#F8FAFC", borderRadius:12, padding:"12px", height:64 }}>
          <MiniChart data={gammaHistory || []} color={meta.bar} height={40} width={400} />
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
          <span style={{ fontSize:10, color:"#CBD5E1" }}>
            {M.gamma}′({M.tau}) {"<"} 0 — monotone degradation as {M.tau}↑
          </span>
          <span style={{ fontSize:10, color:"#CBD5E1" }}>
            {M.Delta}({M.lambda},{M.tau}) = {M.lambda}−{M.mu}(1−e^(−{M.lambda}{M.tau})) = 0
          </span>
        </div>
      </div>

      {/* Proximity ring */}
      <div style={{
        marginTop:20, display:"flex", alignItems:"center", gap:16,
        background:"#F8FAFC", borderRadius:12, padding:"14px 16px",
      }}>
        <StabilityRing proximity={proximity} stage={cascade.stage} size={56} />
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:"#0F172A" }}>
            {M.tau}/{M.tauC} = {(proximity*100).toFixed(1)}% to critical threshold
          </div>
          <div style={{ fontSize:11, color:"#94A3B8", marginTop:3 }}>
            {M.tau} = {tau.toFixed(1)}d &nbsp;·&nbsp;
            {M.tauC} = 1/(|{M.mu}|·e) = {tauC.toFixed(1)}d
          </div>
          <div style={{ marginTop:8, display:"flex", gap:8 }}>
            {[0,1,2,3,4].map(s => (
              <div key={s} style={{ display:"flex", alignItems:"center", gap:3 }}>
                <div style={{
                  width:6, height:6, borderRadius:"50%",
                  background: s <= cascade.stage ? STAGE_META[s].dot : "#E2E8F0",
                  boxShadow: s === cascade.stage ? `0 0 6px ${STAGE_META[s].dot}` : "none",
                }} />
                <span style={{
                  fontSize:9,
                  fontWeight: s === cascade.stage ? 700 : 400,
                  color: s === cascade.stage ? STAGE_META[s].text : "#CBD5E1",
                }}>D{s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SYSTEM OVERVIEW ───────────────────────────────────────────────────────────
function SystemOverview({ assetData, dataSource, liveCount, fetchTime, onRefresh, loading, loadingStage }) {
  const all = Object.values(assetData).filter(Boolean);
  const stages = all.map(d => d.cascade.stage);
  const maxStage = stages.length ? Math.max(...stages) : 0;
  const avgProx = all.length
    ? all.reduce((s, d) => s + d.tau/d.tauC, 0) / all.length
    : 0;
  const meta = STAGE_META[maxStage];
  const worstTicker = ASSETS[stages.indexOf(maxStage)]?.ticker ?? "—";

  return (
    <div style={{
      background:"white", borderRadius:20, padding:"24px 28px",
      border:"1.5px solid #F1F5F9", boxShadow:"0 2px 8px rgba(0,0,0,0.04)", marginBottom:16,
    }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
        <div>
          <div style={{
            fontSize:12, fontWeight:600, color:"#94A3B8",
            letterSpacing:0.5, textTransform:"uppercase",
          }}>
            Systemic Risk · {M.Lmax}(t)
          </div>
          <div style={{ display:"flex", alignItems:"baseline", gap:10, marginTop:4 }}>
            <span style={{ fontSize:32, fontWeight:700, color:"#0F172A", letterSpacing:-1 }}>
              {meta.label}
            </span>
            <span style={{ fontSize:13, color:"#94A3B8" }}>via {worstTicker}</span>
          </div>
          <div style={{ fontSize:12, color:meta.text, fontWeight:600, marginTop:2 }}>
            Avg {M.tau}/{M.tauC} across basket: {(avgProx*100).toFixed(1)}%
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{
              width:7, height:7, borderRadius:"50%",
              background: dataSource==="live" ? "#22C55E" : "#F59E0B",
              boxShadow: dataSource==="live" ? "0 0 8px #22C55E80" : "none",
            }} />
            <span style={{ fontSize:11, color:"#94A3B8" }}>
              {dataSource==="live"
                ? `Live · ${liveCount}/${ASSETS.length} tickers`
                : "Demo data"
              } · {fetchTime?.toLocaleTimeString() ?? "—"}
            </span>
          </div>
          <button onClick={onRefresh} disabled={loading} style={{
            padding:"6px 16px", borderRadius:20,
            border:"1.5px solid #E2E8F0", background:"white",
            fontSize:12, fontWeight:600, color:"#0F172A",
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.5 : 1,
            transition:"all 0.15s",
          }}>
            {loading ? (loadingStage || "Fetching…") : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* Stage chips */}
      {all.length > 0 && (
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
          {[0,1,2,3,4].map(s => {
            const count = stages.filter(x => x===s).length;
            const sm = STAGE_META[s];
            return (
              <div key={s} style={{
                padding:"4px 12px", borderRadius:20,
                background: count>0 ? sm.bg : "#F8FAFC",
                border:`1px solid ${count>0 ? sm.bar+"40" : "#F1F5F9"}`,
                fontSize:11, fontWeight:600,
                color: count>0 ? sm.text : "#CBD5E1",
              }}>
                {count} {sm.label}
              </div>
            );
          })}
        </div>
      )}

      {/* Segment health bar */}
      <div style={{ display:"flex", gap:3, height:4, borderRadius:4, overflow:"hidden" }}>
        {ASSETS.map(a => {
          const d = assetData[a.ticker];
          const sm = d ? STAGE_META[d.cascade.stage] : null;
          return (
            <div key={a.ticker} style={{
              flex:1, background: sm ? sm.bar : "#F1F5F9",
              transition:"background 0.5s", borderRadius:2,
            }} />
          );
        })}
      </div>
    </div>
  );
}

// ── FRAMEWORK CARD ────────────────────────────────────────────────────────────
function FrameworkCard() {
  const rows = [
    { k:"Char. Eq.",  v:`${M.Delta}(${M.lambda},${M.tau}) = ${M.lambda}−${M.mu}(1−e^(−${M.lambda}${M.tau}))` },
    { k:"Spec. Gap",  v:`${M.gamma}(${M.tau}) = −Re(${M.lambda}±(${M.tau}))` },
    { k:"Monotone",   v:`${M.gamma}′(${M.tau}) < 0 as ${M.tau}↑` },
    { k:"Critical",   v:`${M.tauC} = 1/(|${M.mu}|·e)` },
    { k:"Cascade",    v:`D1 ${M.arrow} D2 ${M.arrow} D3 ${M.arrow} D4` },
    { k:"System",     v:`${M.Lmax} = maxᵢ sᵢ(t)` },
    { k:"State Sp.",  v:`${M.M2} = ${M.R} ${M.oplus} ${M.L2}([−T,0])` },
    { k:"Hölder",     v:`${M.alpha}ₑff = 1/4  (closed-loop)` },
  ];
  return (
    <div style={{
      background:"white", borderRadius:16, padding:"16px 20px",
      border:"1.5px solid #F1F5F9", marginTop:4,
    }}>
      <div style={{
        fontSize:11, fontWeight:700, color:"#94A3B8",
        letterSpacing:1, textTransform:"uppercase", marginBottom:10,
      }}>
        SDDE Framework
      </div>
      {rows.map(({ k, v }) => (
        <div key={k} style={{
          display:"flex", justifyContent:"space-between", alignItems:"baseline",
          padding:"5px 0", borderBottom:"1px solid #F8FAFC",
        }}>
          <span style={{ fontSize:11, color:"#94A3B8", flexShrink:0, marginRight:8 }}>{k}</span>
          <span style={{ fontSize:11, color:"#334155", textAlign:"right", lineHeight:1.5 }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ── ROOT APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [assetData,    setAssetData]    = useState({});
  const [selected,     setSelected]     = useState("SPY");
  const [dataSource,   setDataSource]   = useState("demo");
  const [liveCount,    setLiveCount]    = useState(0);
  const [fetchTime,    setFetchTime]    = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [fetchError,   setFetchError]   = useState(null);
  const returnsRef = useRef({});
  const pricesRef  = useRef({});

  // ── compute SDDE metrics ──────────────────────────────────────────────────
  const computeMetrics = useCallback(() => {
    const newData = {};
    ASSETS.forEach(a => {
      const rets   = returnsRef.current[a.ticker];
      const prices = pricesRef.current[a.ticker];
      if (!rets || rets.length < 10) return;
      const mu      = estimateMu(rets.slice(-40));
      const tau     = estimateTau(rets.slice(-30), mu, a.tauMin, a.tauMax);
      const tauC    = criticalDelay(mu);
      const gamma   = spectralGap(mu, tau);
      const cascade = cascadeStage(mu, tau);
      const gh      = [...(assetData[a.ticker]?.gammaHistory ?? []).slice(-79), gamma];
      newData[a.ticker] = {
        returns: rets, prices,
        mu, tau, tauC, gamma, cascade,
        priceNow:     prices[prices.length-1],
        pricePrev:    prices[prices.length-2] ?? prices[prices.length-1],
        gammaHistory: gh,
      };
    });
    setAssetData(newData);
  }, [assetData]);

  // ── demo fallback ─────────────────────────────────────────────────────────
  const loadDemo = useCallback(() => {
    // Approximate prices as of April 2025
    const cfg = {
      SPY:      { seed:42,   start:536,   vol:0.009, drift:-0.0001 },
      QQQ:      { seed:137,  start:464,   vol:0.013, drift:-0.0002 },
      TLT:      { seed:271,  start:88,    vol:0.007, drift:0.0001  },
      GLD:      { seed:618,  start:312,   vol:0.008, drift:0.0001  },
      "BTC-USD":{ seed:1618, start:94000, vol:0.035, drift:-0.0005 },
    };
    ASSETS.forEach(a => {
      const { seed, start, vol, drift } = cfg[a.ticker];
      const closes = mockCloses(seed, 130, start, vol, drift);
      returnsRef.current[a.ticker] = pricesToReturns(closes);
      pricesRef.current[a.ticker]  = closes;
    });
    setDataSource("demo");
    setLiveCount(0);
    setFetchTime(new Date());
  }, []);

  // ── live fetch ────────────────────────────────────────────────────────────
  const loadLive = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setLoadingStage("Fetching from Yahoo Finance…");

    const { data, liveCount: count } = await fetchAllTickers(ASSETS.map(a => a.ticker));

    let anyLoaded = false;
    ASSETS.forEach(a => {
      const d = data[a.ticker];
      if (!d || !Array.isArray(d.closes) || d.closes.length < 5) return;
      const closes = d.closes.filter(p => p > 0);
      returnsRef.current[a.ticker] = pricesToReturns(closes);
      pricesRef.current[a.ticker]  = closes;
      anyLoaded = true;
    });

    if (anyLoaded) {
      setDataSource("live");
      setLiveCount(count);
      setFetchTime(new Date());
    } else {
      setFetchError("Yahoo Finance unavailable — showing demo data");
      loadDemo();
    }

    setLoading(false);
    setLoadingStage("");
  }, [loadDemo]);

  // init
  useEffect(() => {
    loadLive();
  }, [loadLive]);

  useEffect(() => {
    if (fetchTime && Object.keys(returnsRef.current).length > 0) {
      computeMetrics();
    }
  }, [fetchTime, computeMetrics]);

  // intraday tick (3s)
  useEffect(() => {
    const IVOL = { SPY:0.0007, QQQ:0.001, TLT:0.0005, GLD:0.0006, "BTC-USD":0.003 };
    const intv = setInterval(() => {
      ASSETS.forEach(a => {
        const ex = returnsRef.current[a.ticker];
        if (!ex || ex.length < 5) return;
        const vol = IVOL[a.ticker] ?? 0.001;
        const r = (Math.random() - 0.5) * 2 * Math.SQRT2 * vol;
        returnsRef.current[a.ticker] = [...ex.slice(-129), r];
        const prev = pricesRef.current[a.ticker]?.slice(-1)[0] ?? 100;
        pricesRef.current[a.ticker] = [
          ...(pricesRef.current[a.ticker] ?? []).slice(-129),
          prev * (1 + r),
        ];
      });
      computeMetrics();
    }, 3000);
    return () => clearInterval(intv);
  }, [computeMetrics]);

  const selectedAsset = ASSETS.find(a => a.ticker === selected);

  return (
    <div style={{
      minHeight:"100vh", background:"#F8FAFC",
      fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      paddingBottom:40,
    }}>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <div style={{
        background:"white", borderBottom:"1px solid #F1F5F9",
        padding:"0 28px", height:58,
        display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:20,
        boxShadow:"0 1px 3px rgba(0,0,0,0.04)",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{
            width:28, height:28, borderRadius:8,
            background:"linear-gradient(135deg,#5B6BF8,#9B59F8)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <span style={{ color:"white", fontWeight:800, fontSize:12 }}>S</span>
          </div>
          <span style={{ fontWeight:700, fontSize:15, color:"#0F172A", letterSpacing:-0.3 }}>
            SDDE Risk Monitor
          </span>
        </div>
        <div style={{ fontSize:11, color:"#94A3B8" }}>
          Spectral Stability · SDDE Framework
        </div>
      </div>

      {/* ── Loading banner ──────────────────────────────────────────────── */}
      {loading && loadingStage && (
        <div style={{
          background:"#EFF6FF", borderBottom:"1px solid #BFDBFE",
          padding:"8px 28px", fontSize:12, color:"#3B82F6",
          display:"flex", alignItems:"center", gap:8,
        }}>
          <span style={{ display:"inline-block", animation:"spin 1s linear infinite", fontSize:14 }}>⟳</span>
          {loadingStage}
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {!loading && fetchError && (
        <div style={{
          background:"#FFFBEB", borderBottom:"1px solid #FDE68A",
          padding:"8px 28px", fontSize:12, color:"#D97706",
          display:"flex", alignItems:"center", gap:6,
        }}>
          <span>⚠</span> {fetchError}
        </div>
      )}

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"24px 24px 0" }}>

        <SystemOverview
          assetData={assetData}
          dataSource={dataSource}
          liveCount={liveCount}
          fetchTime={fetchTime}
          onRefresh={loadLive}
          loading={loading}
          loadingStage={loadingStage}
        />

        <div style={{ display:"grid", gridTemplateColumns:"340px 1fr", gap:16, alignItems:"start" }}>

          {/* Asset list */}
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {ASSETS.map(a => (
              <AssetCard
                key={a.ticker}
                asset={a}
                data={assetData[a.ticker]}
                isSelected={selected === a.ticker}
                onClick={() => setSelected(a.ticker)}
              />
            ))}
            <FrameworkCard />
          </div>

          {/* Detail panel */}
          <div>
            {selectedAsset && (
              <DetailPanel
                asset={selectedAsset}
                data={assetData[selectedAsset.ticker]}
              />
            )}
          </div>

        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        button:hover:not(:disabled) { opacity: 0.75 !important; }
      `}</style>
    </div>
  );
}
