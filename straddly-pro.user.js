// ==UserScript==
// @name         Straddly Pro Overlay
// @namespace    http://tampermonkey.net/
// @version      9.1
// @description  Institutional-style position dashboard for Straddly — live P&L, greeks, risk, payoff, attribution, strategy book, slippage. Shadow-DOM isolated + self-healing.
// @author       Ansh
// @match        https://new.straddly.com/*
// @match        https://*.straddly.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/straddly-pro.user.js
// @downloadURL  https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/straddly-pro.user.js
// ==/UserScript==

/*
  v9.0 — ROBUSTNESS PASS + desk tools.
  - UI rendered inside a Shadow DOM → the site's CSS can't bleed in / break layout, ours can't leak out.
  - Self-healing watchdog rebuilds the panel if the SPA ever removes it.
  - Every interval/handler wrapped in try/catch; self-poll backs off on repeated failure (passive intercept still feeds data).
  - Data engine unchanged: intercept fetch/XHR, self-poll via captured auth token, compute MTM locally.
  - New: P&L attribution (θ/Δ/Γ/vega/residual), strategy grouping (Book tab), slippage log (from order inputPrice vs fill).
  - To share: set @updateURL/@downloadURL above to your hosted raw URL (see SHARE.md).
*/
(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const POLL_MS = 3000, UI_REFRESH_MS = 1500, WATCHDOG_MS = 2500;
  const DEFAULT_ALLOWED_MARGIN = 114113.08, DEFAULT_BROKERAGE = 8;
  const STT_RATE = 0.001, EXCHANGE_RATE = 0.00053, SEBI_RATE = 10 / 1e7, STAMP_RATE = 0.00003, GST_RATE = 0.18;
  const HIST_GAP = 15000;
  const FEEDBACK_EMAIL = 'anshlala8000@gmail.com'; // testers click "Feedback" → mailto this
  const C = {
    bg:'#0d1117', panel:'#11151b', card:'#161b22', line:'#1f2730', line2:'#272f3a',
    text:'#e6eaf0', muted:'#7e8794', sub:'#9aa3af',
    accent:'#34d399', accent2:'#10b981', up:'#34d399', dn:'#f87171', warn:'#fbbf24',
    ce:'#38bdf8', pe:'#f87171', sd:'#a78bfa',
  };

  // ══ STORE ═════════════════════════════════════════════════════════════════════
  const Store = {
    positions: [], orders: [], ltpById: {}, ltpBySym: {}, chain: {}, margin: null, user: null,
    spot: 0, lastUpdate: 0, req: { positions: null, touchline: null }, _listeners: [],
    onUpdate(fn){ this._listeners.push(fn); },
    _emit(){ this.lastUpdate = Date.now(); this._listeners.forEach(f => { try { f(); } catch (e) {} }); },
  };
  window.SAPI = Store;

  function parseSymbol(sym){
    if (!sym) return null;
    const m = sym.match(/^([A-Z]+?)(\d{2})(\d{2})(\d{2})(\d+)(CE|PE|SD)$/);
    if (!m) return null;
    const [, u, yy, mm, dd, k, t] = m;
    return { underlying: u, expiry: new Date(2000 + (+yy), (+mm) - 1, +dd, 15, 30, 0), strike: parseInt(k, 10), type: t };
  }

  function ingest(url, body){
    if (!url || !body) return;
    let j; try { j = JSON.parse(body); } catch (e) { return; }
    const d = j && j.data !== undefined ? j.data : j;
    try {
      if (/\/Position\/Get-PositionsByUserId/i.test(url) && Array.isArray(d)) { Store.positions = d; recomputeSpot(); Store._emit(); return; }
      if (/\/Orders\/Get-OrdersByID/i.test(url) && Array.isArray(d)) { Store.orders = d; Store._emit(); return; }
      if (/\/Touchline\/Get-Touchlines/i.test(url) && Array.isArray(d)) { d.forEach(q => { if (q.symbolId != null) Store.ltpById[q.symbolId] = q.ltp; if (q.symbol) Store.ltpBySym[q.symbol] = q.ltp; }); recomputeSpot(); Store._emit(); return; }
      if (/\/Orders\/Get-MarginusedByID/i.test(url) && Array.isArray(d) && d.length) { Store.margin = d[0]; Store._emit(); return; }
      if (/user\/getuserdetails/i.test(url) && d && d.id) { Store.user = d; Store._emit(); return; }
      if (/\/Watchlist\/Get-Watchlist/i.test(url) && Array.isArray(d)) { d.forEach(c => { if (c.symbol) Store.chain[c.symbol] = { strike: c.strike, type: c.optionType, lotSize: c.lotSize, symbolId: c.symbolId, underlying: c.underlying, expiry: c.expiryDate }; }); Store._emit(); return; }
    } catch (e) {}
  }

  function detectUnderlying(){
    for (const p of Store.positions){ const s = parseSymbol(p.symbol); if (s) return s.underlying; }
    for (const k in Store.chain){ if (Store.chain[k].underlying) return Store.chain[k].underlying.replace(/\s+/g, ''); }
    return 'NIFTY';
  }
  function lotForUnderlying(){
    const u = detectUnderlying();
    for (const k in Store.chain){ const c = Store.chain[k]; if (c.lotSize && c.underlying && c.underlying.replace(/\s+/g, '') === u) return c.lotSize; }
    return 65;
  }
  function paritySpot(under){
    const byK = {};
    for (const sym in Store.ltpBySym){ const p = parseSymbol(sym), l = Store.ltpBySym[sym]; if (!p || p.type === 'SD' || !(l > 0)) continue; if (under && p.underlying !== under) continue; const o = byK[p.strike] = byK[p.strike] || { exp: p.expiry }; o[p.type] = l; }
    const rows = []; for (const k in byK){ const r = byK[k]; if (r.CE > 0 && r.PE > 0) rows.push({ k: +k, diff: Math.abs(r.CE - r.PE), cp: r.CE - r.PE, exp: r.exp }); }
    if (!rows.length) return 0;
    rows.sort((a, b) => a.diff - b.diff);
    const top = rows.slice(0, 3), r = 0.065, now = Date.now();
    let s = 0; top.forEach(x => { const T = Math.max((x.exp - now) / (365 * 864e5), 1e-5); s += x.k * Math.exp(-r * T) + x.cp; });
    return s / top.length;
  }
  const _idx = { under: null, valEl: null, last: 0 };
  function indexSpotDOM(under){
    const numIn = el => { const m = (el && el.textContent || '').trim().match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,6}(?:\.\d+)?)/); if (!m) return 0; const v = parseFloat(m[1].replace(/,/g, '')); return (v > 1000 && v < 200000) ? v : 0; };
    try {
      if (_idx.under === under && _idx.valEl && document.contains(_idx.valEl)){ const v = numIn(_idx.valEl); if (v) return v; }
      if (Date.now() - _idx.last < 1500) return 0;
      _idx.last = Date.now();
      const wants = under === 'BANKNIFTY' ? ['BANKNIFTY', 'BANK NIFTY', 'NIFTY BANK'] : [under];
      const leaves = document.querySelectorAll('span,div,b,strong,p,h1,h2,h3,td,th');
      for (let i = 0; i < leaves.length; i++){ const el = leaves[i]; if (el.childElementCount !== 0) continue; if (wants.indexOf(el.textContent.trim().toUpperCase()) < 0) continue; const probes = [el.nextElementSibling, el.previousElementSibling].concat(el.parentElement ? Array.from(el.parentElement.children) : []); for (const c of probes){ if (!c || c === el) continue; const v = numIn(c); if (v){ _idx.under = under; _idx.valEl = c; return v; } } }
    } catch (e) {}
    return 0;
  }
  function recomputeSpot(){
    try {
      const under = detectUnderlying(), par = paritySpot(under), dom = indexSpotDOM(under);
      if (dom > 0 && (!par || Math.abs(dom - par) / par < 0.05)) { Store.spot = dom; return; }
      if (par > 0) { Store.spot = par; return; }
      if (dom > 0) { Store.spot = dom; return; }
      const m = (document.body ? document.body.innerText : '').match(/\b(\d{2},\d{3}(?:\.\d{1,2})?)\b/); if (m) Store.spot = parseFloat(m[1].replace(/,/g, ''));
    } catch (e) {}
  }
  window._recomputeSpot = recomputeSpot;

  // ══ INTERCEPTOR ══════════════════════════════════════════════════════════════
  const origFetch = window.fetch;
  const TOUCH_RE = /\/Touchline\/Get-Touchlines/i, POS_RE = /\/Position\/Get-PositionsByUserId/i;
  const pickAuth = h => { const o = {}; if (!h) return o; const g = k => (h.get ? h.get(k) : h[k] || h[k.toLowerCase()]); ['authorization','content-type','accept'].forEach(k => { const v = g(k); if (v) o[k] = v; }); return o; };
  if (origFetch) {
    window.fetch = function (...a){
      const url = (a[0] && a[0].url) || a[0], init = a[1] || {}, hd = pickAuth(init.headers || (a[0] && a[0].headers));
      const p = origFetch.apply(this, a);
      try { if (typeof url === 'string'){ if (POS_RE.test(url) && hd.authorization) Store.req.positions = { url, method: init.method || 'GET', headers: hd }; if (TOUCH_RE.test(url) && hd.authorization) Store.req.touchline = { url, method: 'POST', headers: hd, body: init.body }; p.then(r => r.clone().text().then(t => ingest(url, t)).catch(()=>{})).catch(()=>{}); } } catch (e) {}
      return p;
    };
  }
  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send, oHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u){ this.__s = { method: m, url: String(u), headers: {} }; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v){ if (this.__s) this.__s.headers[k.toLowerCase()] = v; return oHdr.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body){
    const d = this.__s;
    if (d) { const auth = {}; ['authorization','content-type','accept'].forEach(k => { if (d.headers[k]) auth[k] = d.headers[k]; }); if (POS_RE.test(d.url) && auth.authorization) Store.req.positions = { url: d.url, method: d.method || 'GET', headers: auth }; if (TOUCH_RE.test(d.url) && auth.authorization) Store.req.touchline = { url: d.url, method: 'POST', headers: auth, body }; this.addEventListener('load', () => { try { ingest(d.url, this.responseText); } catch (e) {} }); }
    return oSend.apply(this, arguments);
  };
  let pollFails = 0;
  function poll(){
    if (pollFails > 6) { if (pollFails++ % 10 !== 0) return; } // backoff: after repeated fails, only retry occasionally
    const r = Store.req; const ok = () => { pollFails = 0; };
    try {
      if (r.positions && origFetch) origFetch(r.positions.url, { method: r.positions.method, headers: r.positions.headers, credentials: 'include' }).then(x => { ok(); return x.text(); }).then(t => ingest(r.positions.url, t)).catch(() => { pollFails++; });
      if (r.touchline && origFetch) {
        // position legs FIRST (always quoted, even in a large book), then fill with chain symbols up to the cap
        const posSyms = [];
        Store.positions.forEach(p => { if (p.status !== 'OPEN' || !p.symbol) return; posSyms.push(p.symbol); if (p.optionType === 'SD'){ posSyms.push(p.symbol.replace(/SD$/, 'CE')); posSyms.push(p.symbol.replace(/SD$/, 'PE')); } });
        let chainSyms = []; try { chainSyms = JSON.parse(r.touchline.body || '[]'); } catch (e) {}
        const seen = {}, syms = []; posSyms.concat(chainSyms).forEach(s => { if (s && !seen[s]){ seen[s] = 1; syms.push(s); } });
        if (syms.length) origFetch(r.touchline.url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, r.touchline.headers), body: JSON.stringify(syms.slice(0, 200)), credentials: 'include' }).then(x => { ok(); return x.text(); }).then(t => ingest(r.touchline.url, t)).catch(() => { pollFails++; });
      }
    } catch (e) {}
  }

  // ══ SELECTORS ════════════════════════════════════════════════════════════════
  function liveLtp(p){ if (p.symbolId != null && Store.ltpById[p.symbolId] != null) return Store.ltpById[p.symbolId]; if (p.symbol && Store.ltpBySym[p.symbol] != null) return Store.ltpBySym[p.symbol]; return p.ltp || 0; }
  function posAvg(p){ if (p.bepPrice > 0) return p.bepPrice; if (p.quantity < 0) return p.avgSellPrice; if (p.quantity > 0) return p.avgBuyPrice; return p.avgSellPrice || p.avgBuyPrice || 0; }
  window.parseOpenPos = function (){
    return Store.positions.filter(p => p.status === 'OPEN' && p.quantity !== 0).map(p => {
      const avg = posAvg(p); let ltp = liveLtp(p);
      if (p.optionType === 'SD'){ const base = p.symbol ? p.symbol.replace(/SD$/, '') : ''; const ce = Store.ltpBySym[base + 'CE'], pe = Store.ltpBySym[base + 'PE']; if (ce != null && pe != null) ltp = ce + pe; }
      let expiry = p.expiryDate ? new Date(p.expiryDate) : (parseSymbol(p.symbol) || {}).expiry;
      if (expiry instanceof Date && !isNaN(expiry)) expiry.setHours(15, 30, 0, 0);
      return { instr: p.symbol, symbol: p.symbol, symbolId: p.symbolId, qty: p.quantity, avg, ltp, pnl: (ltp - avg) * p.quantity, strike: p.strikePrice || (parseSymbol(p.symbol) || {}).strike || 0, type: p.optionType, expiry };
    });
  };
  function expandLegs(rows){
    const out = [];
    rows.forEach(p => {
      if (p.type !== 'SD'){ out.push(p); return; }
      const ceSym = p.symbol ? p.symbol.replace(/SD$/, 'CE') : null, peSym = p.symbol ? p.symbol.replace(/SD$/, 'PE') : null;
      const ceLtp = ceSym && Store.ltpBySym[ceSym] != null ? Store.ltpBySym[ceSym] : null, peLtp = peSym && Store.ltpBySym[peSym] != null ? Store.ltpBySym[peSym] : null;
      const have = ceLtp != null && peLtp != null && (ceLtp + peLtp) > 0, cL = have ? ceLtp : p.ltp / 2, pL = have ? peLtp : p.ltp / 2, sum = cL + pL || 1, cA = p.avg * cL / sum, pA = p.avg - cA;
      out.push(Object.assign({}, p, { type: 'CE', symbol: ceSym, ltp: cL, avg: cA, pnl: (cL - cA) * p.qty, straddle: true }));
      out.push(Object.assign({}, p, { type: 'PE', symbol: peSym, ltp: pL, avg: pA, pnl: (pL - pA) * p.qty, straddle: true }));
    });
    return out;
  }
  window._bsLegs = () => expandLegs(window.parseOpenPos());
  window._breakevens = function (legsIn){
    const legs = legsIn || window._bsLegs(), spot = window.getSpot();
    if (!legs.length || !spot) return null;
    const ks = legs.map(l => l.strike), lo = Math.min(...ks, spot) * 0.9, hi = Math.max(...ks, spot) * 1.1, N = 800;
    const E = s => legs.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s); return a + (it - l.avg) * l.qty; }, 0);
    const cr = []; let prev = E(lo), ps = lo;
    for (let i = 1; i <= N; i++){ const s = lo + (i / N) * (hi - lo), v = E(s); if ((prev >= 0) !== (v >= 0)) cr.push(ps + (-prev / (v - prev)) * (s - ps)); prev = v; ps = s; }
    return cr.length ? { list: cr, lower: Math.min(...cr), upper: Math.max(...cr) } : null;
  };
  window.getSpot = () => Store.spot || 0;
  window.getOpenMTM = () => window.parseOpenPos().reduce((s, p) => s + p.pnl, 0);
  window.getClosedMTM = () => Store.positions.filter(p => p.status !== 'OPEN').reduce((s, p) => s + (p.realisedPnl || 0), 0);
  window.getMTM = () => window.getOpenMTM() + window.getClosedMTM();
  function brokeragePerLot(side){ try { const pl = (Store.user.brokeragePlans || []).find(p => /option/i.test(p.strategy)); if (pl) return side === 'SELL' ? pl.sellBrokerage : pl.buyBrokerage; } catch (e) {} return DEFAULT_BROKERAGE; }
  window.calcExecCharges = function (){
    const orders = Store.orders.filter(o => o.status === 'executed' && o.quantity > 0 && o.price > 0);
    let total=0,brok=0,stt=0,exch=0,stamp=0,gst=0;
    orders.forEach(o => { const side=(o.operationType||'').toUpperCase(); const lots=o.quantity/(o.lotSize||65), turn=o.quantity*o.price; const b=lots*brokeragePerLot(side); const s=side==='SELL'?turn*STT_RATE:0; const e=turn*EXCHANGE_RATE, se=turn*SEBI_RATE; const st=side==='BUY'?turn*STAMP_RATE:0; const g=(b+e+se)*GST_RATE; total+=b+s+e+se+st+g; brok+=b; stt+=s; exch+=e+se; stamp+=st; gst+=g; });
    return { total, count: orders.length, brok, stt, exch, stamp, gst };
  };
  // slippage from executed orders: inputPrice (intended) vs price (fill); +ve = adverse
  window.slippage = function (){
    const ex = Store.orders.filter(o => o.status === 'executed' && o.price > 0 && o.inputPrice > 0 && o.quantity > 0);
    let totalRs = 0, totalLots = 0; const rows = ex.map(o => { const side = (o.operationType || '').toUpperCase(); const pts = side === 'SELL' ? (o.inputPrice - o.price) : (o.price - o.inputPrice); const rs = pts * o.quantity, lots = o.quantity / (o.lotSize || 65); totalRs += rs; totalLots += lots; return { sym: o.symbol, side, inp: o.inputPrice, fill: o.price, qty: o.quantity, pts, rs }; });
    return { rows, totalRs, perLot: totalLots ? totalRs / totalLots : 0, count: ex.length };
  };
  const allowedMargin = () => (Store.user && Store.user.marginAllowed) || (Store.margin && Store.margin.allowedMargin) || DEFAULT_ALLOWED_MARGIN;
  const marginUsed = () => (Store.margin && Store.margin.totalMarginUsed) || 0;

  // ══ BLACK-SCHOLES ════════════════════════════════════════════════════════════
  window.BS = {
    norm(x){const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;const s=x<0?-1:1;x=Math.abs(x)/Math.sqrt(2);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return .5*(1+s*y);},
    d1(S,K,T,r,v){return(Math.log(S/K)+(r+.5*v*v)*T)/(v*Math.sqrt(T));},
    price(S,K,T,r,v,t){if(T<=0)return t==='CE'?Math.max(0,S-K):Math.max(0,K-S);const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T);return t==='CE'?S*this.norm(d1)-K*Math.exp(-r*T)*this.norm(d2):K*Math.exp(-r*T)*this.norm(-d2)-S*this.norm(-d1);},
    iv(S,K,T,r,mkt,t){if(T<=0||mkt<=0)return 0;let v=.3;for(let i=0;i<100;i++){const p=this.price(S,K,T,r,v,t),d1=this.d1(S,K,T,r,v),vega=S*Math.sqrt(T)*Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),diff=p-mkt;if(Math.abs(diff)<.001)break;if(vega<1e-10)break;v-=diff/vega;if(v<.001)v=.001;if(v>5)v=5;}return v;},
    greeks(S,K,T,r,v,t,qty){if(T<=0||v<=0)return{delta:0,gamma:0,theta:0,vega:0};const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T),nd1=Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),sg=qty<0?-1:1,aq=Math.abs(qty);const delta=t==='CE'?this.norm(d1):this.norm(d1)-1;const gamma=nd1/(S*v*Math.sqrt(T));const theta=t==='CE'?(-S*nd1*v/(2*Math.sqrt(T))-r*K*Math.exp(-r*T)*this.norm(d2))/365:(-S*nd1*v/(2*Math.sqrt(T))+r*K*Math.exp(-r*T)*this.norm(-d2))/365;const vega=S*nd1*Math.sqrt(T)/100;return{delta:sg*delta*aq,gamma:sg*gamma*aq,theta:sg*theta*aq,vega:sg*vega*aq};}
  };
  window._getPosCtx = function (pos, spot){
    const now = new Date(); let dte = 7;
    if (pos.length && pos[0].expiry instanceof Date && !isNaN(pos[0].expiry)) dte = Math.max(0.001, (pos[0].expiry - now) / 864e5);
    const T = Math.max(dte / 365, 0.0001), r = 0.065;
    const legIVs = pos.map(p => window.BS.iv(spot, p.strike, T, r, p.ltp || p.avg, p.type) || 0.15);
    return { T, r, dte, legIVs };
  };
  window._bsPnl = function (pos, s2, T, r, legIVs, ivD){ ivD = ivD || 0; return pos.reduce((s, p, j) => { const iv = Math.max(0.01, (legIVs[j] || 0.15) + ivD); return s + (p.avg - window.BS.price(s2, p.strike, T, r, iv, p.type)) * Math.abs(p.qty); }, 0); };
  window._netGreeks = function (pos, spot){
    const ctx = window._getPosCtx(pos, spot); let nD=0,nG=0,nT=0,nV=0; const legs=[];
    pos.forEach((p,j)=>{ const iv=ctx.legIVs[j]||0.15; const g=window.BS.greeks(spot,p.strike,ctx.T,ctx.r,iv,p.type,p.qty); nD+=g.delta;nG+=g.gamma;nT+=g.theta;nV+=g.vega; legs.push({name:p.strike+' '+p.type, iv, ivEntry: window.BS.iv(spot,p.strike,ctx.T,ctx.r,p.avg,p.type)||0.15}); });
    return Object.assign({ nD, nG, nT, nV, legs }, ctx);
  };

  // ══ P&L ATTRIBUTION (incremental, re-baselines on structural change) ═════════
  const ATT = { prev: null, sig: null, base: 0, theta: 0, delta: 0, gamma: 0, vega: 0 };
  function updateAttribution(legs, spot, openMTM){
    if (!legs.length || !spot){ ATT.prev = null; ATT.sig = null; return; }
    const G = window._netGreeks(legs, spot), ivAvg = G.legs.reduce((s, l) => s + l.iv, 0) / (G.legs.length || 1), now = Date.now();
    const sig = legs.map(l => l.symbol + ':' + l.qty).join('|');
    if (!ATT.prev || ATT.sig !== sig){ ATT.prev = { spot, iv: ivAvg, t: now, nD: G.nD, nG: G.nG, nT: G.nT, nV: G.nV }; ATT.sig = sig; ATT.base = openMTM; ATT.theta = ATT.delta = ATT.gamma = ATT.vega = 0; return; }
    const dS = spot - ATT.prev.spot, dt = (now - ATT.prev.t) / 864e5, dIV = (ivAvg - ATT.prev.iv) * 100;
    ATT.delta += ATT.prev.nD * dS; ATT.gamma += 0.5 * ATT.prev.nG * dS * dS; ATT.theta += ATT.prev.nT * dt; ATT.vega += ATT.prev.nV * dIV;
    ATT.prev = { spot, iv: ivAvg, t: now, nD: G.nD, nG: G.nG, nT: G.nT, nV: G.nV };
  }
  window._attribution = function (openMTM){
    const explained = ATT.theta + ATT.delta + ATT.gamma + ATT.vega, since = (openMTM != null ? openMTM : window.getOpenMTM()) - ATT.base;
    return { theta: ATT.theta, delta: ATT.delta, gamma: ATT.gamma, vega: ATT.vega, other: since - explained, since };
  };

  // ══ STRATEGY GROUPING ════════════════════════════════════════════════════════
  window.strategies = function (){
    const legs = window.parseOpenPos(), groups = {};
    legs.forEach(p => { const u = (parseSymbol(p.symbol) || {}).underlying || '?', e = p.expiry ? p.expiry.toDateString() : '?'; (groups[u + '|' + e] = groups[u + '|' + e] || []).push(p); });
    const spot = window.getSpot();
    return Object.keys(groups).map(k => {
      const g = groups[k], und = k.split('|')[0], ce = g.filter(x => x.type === 'CE'), pe = g.filter(x => x.type === 'PE'), sd = g.filter(x => x.type === 'SD');
      let name = 'Custom (' + g.length + ' legs)';
      if (sd.length && g.length === sd.length) name = sd.length > 1 ? 'Straddles' : 'Straddle';
      else if (ce.length === 1 && pe.length === 1 && g.length === 2) name = ce[0].strike === pe[0].strike ? 'Straddle' : 'Strangle';
      else if (g.length === 1) name = g[0].type === 'CE' ? 'Call' : g[0].type === 'PE' ? 'Put' : 'Straddle';
      const bl = expandLegs(g), G = spot ? window._netGreeks(bl, spot) : { nD: 0, nT: 0, nV: 0 }, be = spot ? window._breakevens(bl) : null;
      return { name, und, exp: g[0].expiry, legs: g, mtm: g.reduce((s, x) => s + x.pnl, 0), nD: G.nD, nT: G.nT, nV: G.nV, be };
    });
  };

  // ══ HISTORY ══════════════════════════════════════════════════════════════════
  window._splyHistory = [];
  function sameDay(t){ const d = new Date(t), n = new Date(); return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear(); }
  function pushH(v, d){
    const now = Date.now();
    if (window._splyHistory.length && !sameDay(window._splyHistory[0].t)) window._splyHistory = window._splyHistory.filter(p => sameDay(p.t));
    const H = window._splyHistory, last = H[H.length - 1];
    if (last && now - last.t < HIST_GAP){ last.v = v; if (d != null) last.d = d; } else H.push({ t: now, v, d: (d == null ? null : d) });
    if (H.length > 3000) H.shift();
    try { localStorage.setItem('sply_h', JSON.stringify(H)); } catch (e) {}
  }

  // ══ FORMAT HELPERS ═══════════════════════════════════════════════════════════
  const money = v => (v >= 0 ? '+' : '−') + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const moneyK = v => (v >= 0 ? '+' : '−') + '₹' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'K' : Math.round(Math.abs(v)));
  const pnlCol = v => v >= 0 ? C.up : C.dn;

  // ══ SHADOW-DOM PANEL ═════════════════════════════════════════════════════════
  let SR = null; // shadow root
  const $  = sel => SR ? SR.querySelector(sel) : null;
  const $$ = sel => SR ? Array.prototype.slice.call(SR.querySelectorAll(sel)) : [];
  const $id = id => $('#' + id);

  function buildPanel(){
    if (document.getElementById('sply-host')) return;
    const host = document.createElement('div');
    host.id = 'sply-host';
    host.style.cssText = 'all:initial;';
    SR = host.attachShadow({ mode: 'open' });
    window._SR = SR;

    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial;}
      *{box-sizing:border-box;margin:0;padding:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;}
      #sply{position:fixed;top:56px;left:14px;z-index:2147483646;width:376px;min-width:300px;min-height:200px;max-height:92vh;
        background:${C.panel};border:1px solid ${C.line};border-radius:18px;overflow:hidden;display:flex;flex-direction:column;color:${C.text};
        box-shadow:0 24px 60px -24px rgba(0,0,0,.75);resize:both;}
      .top{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid ${C.line};cursor:move;user-select:none;flex-shrink:0;}
      .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:13px;}
      .mk{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,${C.accent},${C.accent2});display:grid;place-items:center;font-size:12px;color:#04140d;font-weight:800;}
      .tr{display:flex;align-items:center;gap:10px;}
      .live{display:flex;align-items:center;gap:6px;font-size:11px;color:${C.muted};}
      .live .d{width:7px;height:7px;border-radius:50%;background:${C.dn};transition:.3s;}
      .live.on .d{background:${C.accent};box-shadow:0 0 0 3px rgba(52,211,153,.18);}
      .live.on{color:${C.accent};}
      .ic{background:transparent;border:none;color:${C.muted};font-size:15px;cursor:pointer;padding:0 2px;line-height:1;}
      .ic:hover{color:${C.text};}
      .body{overflow-y:auto;overflow-x:hidden;flex:1;scrollbar-width:thin;scrollbar-color:${C.line2} transparent;}
      .body::-webkit-scrollbar{width:6px;}.body::-webkit-scrollbar-thumb{background:${C.line2};border-radius:3px;}
      .hero{padding:16px 16px 6px;}
      .hero .k{font-size:11px;color:${C.muted};letter-spacing:.08em;text-transform:uppercase;}
      .hero .v{font-size:33px;font-weight:760;letter-spacing:-.02em;margin-top:2px;line-height:1;}
      .hero .sub{display:flex;gap:14px;margin-top:9px;font-size:12px;color:${C.sub};flex-wrap:wrap;}
      .hero .sub b{font-weight:600;}
      .spark{padding:4px 8px 10px;}
      .sec{padding:13px 16px;border-top:1px solid ${C.line};}
      .sec h4{font-size:10.5px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin-bottom:9px;display:flex;justify-content:space-between;align-items:center;}
      .pos{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:11px;background:${C.card};margin-bottom:7px;}
      .pos:last-child{margin-bottom:0;}
      .ph{display:flex;align-items:center;gap:9px;min-width:0;}
      .chip{font-size:10px;font-weight:700;padding:3px 7px;border-radius:7px;flex-shrink:0;}
      .chip.pe{background:rgba(239,68,68,.14);color:${C.pe};}.chip.ce{background:rgba(56,189,248,.14);color:${C.ce};}.chip.sd{background:rgba(167,139,250,.16);color:${C.sd};}
      .pm{font-size:11.5px;color:${C.sub};white-space:nowrap;}
      .pl{font-weight:700;font-size:13px;text-align:right;}
      .grk{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
      .grk>div{background:${C.card};border-radius:11px;padding:9px 6px;text-align:center;}
      .gl{font-size:10px;color:${C.muted};}.gv{font-size:15px;font-weight:700;margin-top:3px;}
      .mbar{height:6px;border-radius:999px;background:${C.line};overflow:hidden;margin-top:9px;}
      .mbar i{display:block;height:100%;background:linear-gradient(90deg,${C.warn},${C.dn});transition:width .4s;}
      .mrow{display:flex;justify-content:space-between;font-size:11px;color:${C.muted};margin-top:6px;}
      .berow{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:${C.sub};margin-top:9px;padding-top:9px;border-top:1px dashed ${C.line};}
      .berow b{color:${C.text};font-weight:600;}
      .tsl{padding-top:6px;padding-bottom:11px;}
      .tsl-top{display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:6px;}
      .tsl-end{color:${C.muted};}.tsl-mid{font-weight:700;}
      .tsl-track{position:relative;height:7px;border-radius:999px;background:linear-gradient(90deg,rgba(248,113,113,.55),${C.line2} 40%,${C.line2} 56%,rgba(52,211,153,.55));}
      .tsl-track span{position:absolute;top:-3px;width:3px;height:13px;border-radius:2px;background:#fff;transform:translateX(-50%);box-shadow:0 0 6px rgba(0,0,0,.7);}
      canvas{display:block;width:100%;background:transparent;border-radius:10px;}
      .kv{display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid ${C.line};}
      .kv:last-child{border-bottom:none;}.kv .kk{color:${C.muted};}
      table{width:100%;border-collapse:collapse;font-size:11px;}
      .stress th{color:${C.muted};font-weight:500;padding:5px 4px;text-align:right;border-bottom:1px solid ${C.line};font-size:9.5px;}
      .stress th:first-child,.stress td:first-child{text-align:left;}
      .stress td{padding:4px;text-align:right;border-bottom:1px solid rgba(255,255,255,.03);}
      .stress .now{background:rgba(52,211,153,.06);}
      .meters{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
      .meter{background:${C.card};border-radius:11px;padding:9px 11px;}
      .meter .ml{font-size:10px;color:${C.muted};}.meter .mvv{font-size:16px;font-weight:700;margin-top:2px;}
      .attr{margin-top:12px;}
      .attr .ar{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:5px;}
      .attr .ar .an{width:48px;color:${C.muted};flex-shrink:0;}
      .attr .ar .abar{flex:1;height:8px;background:${C.line};border-radius:4px;overflow:hidden;position:relative;}
      .attr .ar .abar i{position:absolute;top:0;height:100%;border-radius:4px;}
      .attr .ar .av{width:64px;text-align:right;font-weight:600;flex-shrink:0;}
      .grp{background:${C.card};border-radius:12px;padding:10px 12px;margin-bottom:9px;}
      .grp-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;}
      .grp-nm{font-weight:700;font-size:12px;}
      .grp-ex{font-size:10px;color:${C.muted};}
      .grp-g{display:flex;gap:12px;font-size:10.5px;color:${C.muted};margin-top:7px;border-top:1px solid ${C.line};padding-top:7px;}
      .grp-g b{color:${C.text};}
      input,select,textarea{background:${C.card};border:1px solid ${C.line2};color:${C.text};border-radius:9px;padding:7px 9px;font-size:12px;outline:none;width:100%;}
      input:focus,select:focus,textarea:focus{border-color:${C.accent};}
      .frow{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
      .frow label{font-size:11px;color:${C.muted};width:52px;flex-shrink:0;}
      .btns{display:flex;gap:8px;margin-top:4px;}
      .btns button{flex:1;padding:9px;border:none;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;}
      .bsell{background:rgba(239,68,68,.16);color:${C.dn};}.bsell:hover{background:rgba(239,68,68,.26);}
      .bbuy{background:rgba(52,211,153,.16);color:${C.accent};}.bbuy:hover{background:rgba(52,211,153,.26);}
      .note{font-size:11px;color:${C.muted};margin-top:8px;line-height:1.45;}
      .tabbar{display:flex;gap:3px;padding:8px 12px;border-top:1px solid ${C.line};background:${C.bg};overflow-x:auto;scrollbar-width:none;flex-shrink:0;}
      .tabbar::-webkit-scrollbar{display:none;}
      .tab{flex:0 0 auto;background:transparent;border:none;color:${C.muted};font-size:11.5px;font-weight:600;padding:7px 12px;border-radius:9px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s;}
      .tab:hover{color:${C.text};background:${C.card};}
      .tab.active{color:#04140d;background:${C.accent};box-shadow:0 2px 10px -2px rgba(52,211,153,.5);}
      .tabpanel{padding:14px 16px 18px;min-height:120px;}
      .pl-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:8px;}
      .pl-sub{display:flex;gap:12px;font-size:11px;color:${C.muted};flex-wrap:wrap;}.pl-sub b{font-weight:600;}
      .pl-big{font-size:18px;font-weight:760;white-space:nowrap;}
      .pl-legend{display:flex;gap:16px;justify-content:center;font-size:10px;color:${C.muted};margin-top:9px;}
      .pl-legend i{display:inline-block;width:15px;height:0;vertical-align:middle;margin-right:5px;}
      .lg-mtm{border-top:2px solid ${C.accent};}.lg-d{border-top:2px dashed rgba(255,255,255,.6);}
      .foot{display:flex;justify-content:space-between;align-items:center;padding:7px 14px;border-top:1px solid ${C.line};font-size:10px;color:${C.muted};flex-shrink:0;}
      .foot a{color:${C.accent};text-decoration:none;}
    `;
    SR.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'sply';
    panel.innerHTML = `
      <div class="top" id="sply-top">
        <div class="brand"><span class="mk">S</span> Straddly Pro</div>
        <div class="tr"><span class="live" id="sply-live"><span class="d"></span> <span id="sply-livetxt">connecting</span></span>
          <button class="ic" id="sply-min" title="Minimize">—</button><button class="ic" id="sply-close" title="Close">✕</button></div>
      </div>
      <div class="body" id="sply-body">
        <div class="hero">
          <div class="k">Total MTM</div><div class="v" id="h-mtm">—</div>
          <div class="sub"><span>Open <b id="h-open">—</b></span><span>Closed <b id="h-closed">—</b></span><span>NIFTY <b id="h-spot" style="color:${C.text}">—</b></span><span id="h-dte" style="color:${C.muted}"></span></div>
        </div>
        <div class="spark"><canvas id="c-spark" height="48"></canvas></div>
        <div class="sec tsl"><div class="tsl-top"><span class="tsl-end" id="tsl-l">SL —</span><span class="tsl-mid" id="tsl-m">—</span><span class="tsl-end" id="tsl-r">Target —</span></div><div class="tsl-track"><span id="tsl-mark" style="left:50%"></span></div></div>
        <div class="sec"><h4><span>Open positions</span><span id="p-count">0</span></h4><div id="p-list"></div></div>
        <div class="sec"><h4>Greeks</h4>
          <div class="grk"><div><div class="gl">Δ Delta</div><div class="gv" id="g-d">—</div></div><div><div class="gl">Γ Gamma</div><div class="gv" id="g-g">—</div></div><div><div class="gl">Θ /hr</div><div class="gv" id="g-t">—</div></div><div><div class="gl">Vega</div><div class="gv" id="g-v">—</div></div></div>
          <div class="mbar"><i id="m-bar" style="width:0%"></i></div>
          <div class="mrow"><span id="m-pct">Margin —</span><span id="m-amt">—</span></div>
          <div class="berow" id="be-row"><span>Breakeven</span><span style="color:${C.muted}">—</span></div>
        </div>
        <div class="tabbar" id="sply-tabs">
          <button class="tab active" data-tab="payoff">◳ Payoff</button>
          <button class="tab" data-tab="risk">⚠ Risk</button>
          <button class="tab" data-tab="curve">📈 P&amp;L</button>
          <button class="tab" data-tab="book">📚 Book</button>
          <button class="tab" data-tab="charges">₹ Costs</button>
          <button class="tab" data-tab="exec">⊕ Order</button>
          <button class="tab" data-tab="notes">📝 Notes</button>
        </div>
        <div class="tabpanel" id="sply-tabpanel"></div>
      </div>
      <div class="foot"><span id="sply-status">passive + poll</span><a id="sply-feedback" href="mailto:${FEEDBACK_EMAIL}?subject=Straddly%20Pro%20feedback">✉ Send feedback</a></div>`;
    SR.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    $$('#sply-tabs .tab').forEach(t => t.addEventListener('click', () => { try { renderTab(t.dataset.tab); } catch (e) {} }));
    renderTab('payoff');

    let mini = false;
    $id('sply-min').onclick = () => { mini = !mini; $id('sply-body').style.display = mini ? 'none' : ''; };
    $id('sply-close').onclick = () => { host.remove(); SR = null; };
    const top = $id('sply-top'); let drag = false, dx = 0, dy = 0;
    top.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; });
    document.addEventListener('mousemove', e => { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; });
    document.addEventListener('mouseup', () => drag = false);
  }

  // ══ TABS ═════════════════════════════════════════════════════════════════════
  function sectionHTML(id){
    if (id === 'payoff') return `<canvas id="c-payoff" height="210"></canvas>`;
    if (id === 'curve') return `
      <div class="pl-head"><div class="pl-sub"><span>Open <b id="cv-open">—</b></span><span>Closed <b id="cv-closed">—</b></span><span>Points <b id="cv-pts">—</b></span></div><div class="pl-big" id="cv-total">—</div></div>
      <canvas id="c-curve" height="190"></canvas>
      <div class="pl-legend"><span><i class="lg-mtm"></i>MTM P&amp;L</span><span><i class="lg-d"></i>Net Δ delta</span></div>
      <h4 style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin:14px 0 8px;">P&amp;L attribution <span style="font-weight:400;text-transform:none;">· current structure</span></h4>
      <div class="attr" id="attr-body"></div>`;
    if (id === 'risk') return `<div id="risk-body"></div>`;
    if (id === 'book') return `<div id="book-body"></div>`;
    if (id === 'charges') return `<div id="charges-body"></div>`;
    if (id === 'exec') return `
      <div class="frow"><label>Type</label><select id="o-type"><option value="strangle">Strangle</option><option value="straddle">Straddle</option><option value="ce">CE only</option><option value="pe">PE only</option></select></div>
      <div class="frow"><label>CE strike</label><input id="o-ce" type="number" step="50"/></div>
      <div class="frow"><label>PE strike</label><input id="o-pe" type="number" step="50"/></div>
      <div class="frow"><label>Lots</label><input id="o-lots" type="number" min="1" value="2"/></div>
      <div class="btns"><button class="bsell" id="o-sell">▼ Sell</button><button class="bbuy" id="o-buy">▲ Buy</button></div>
      <div class="note" id="o-log"></div>
      <div class="note">Preview only — shows est. cost &amp; lots. One-click API placement stays off until a Place-Order request is captured (safety).</div>`;
    if (id === 'notes') return `<textarea id="sply-notes" rows="7" placeholder="setup, levels, reminders…"></textarea>`;
    return '';
  }
  function renderTab(id){
    const tp = $id('sply-tabpanel'); if (!tp) return;
    window._splyTab = id;
    $$('#sply-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    tp.innerHTML = sectionHTML(id);
    try {
      if (id === 'notes'){ const n = $id('sply-notes'); if (n){ n.value = localStorage.getItem('sply_notes') || ''; n.oninput = () => { try { localStorage.setItem('sply_notes', n.value); } catch (e) {} }; } }
      else if (id === 'exec'){ const s = $id('o-sell'), b = $id('o-buy'); if (s) s.onclick = () => window.runExecute('SELL'); if (b) b.onclick = () => window.runExecute('BUY'); }
      else drawSection(id);
    } catch (e) {}
  }
  function drawSection(id){
    try {
      if (id === 'payoff') window.drawPayoff();
      else if (id === 'curve') window.drawCurve();
      else if (id === 'risk') window.drawRisk();
      else if (id === 'book') window.drawBook();
      else if (id === 'charges') window.drawCharges();
    } catch (e) {}
  }
  function fitCanvas(id){ const cv = $id(id); if (!cv) return null; const w = Math.round(cv.getBoundingClientRect().width) || (cv.parentElement && cv.parentElement.clientWidth) || 340; cv.width = Math.max(w, 200); return cv; }
  function smoothPath(ctx, pts){ if (pts.length < 3){ for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); return; } for (let i = 1; i < pts.length - 1; i++){ const xc = (pts[i].x + pts[i + 1].x) / 2, yc = (pts[i].y + pts[i + 1].y) / 2; ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc); } const n = pts.length - 1; ctx.quadraticCurveTo(pts[n].x, pts[n].y, pts[n].x, pts[n].y); }

  // ══ SPARK ════════════════════════════════════════════════════════════════════
  window.drawSpark = function (){
    const cv = fitCanvas('c-spark'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const h = window._splyHistory; if (h.length < 2) return;
    const vals = h.map(p => p.v), mn = Math.min(...vals, 0), mx = Math.max(...vals, 0), sp = (mx - mn) || 1;
    const x = i => (i / (h.length - 1)) * W, y = v => H - 4 - ((v - mn) / sp) * (H - 8), up = vals[vals.length - 1] >= 0, col = up ? C.accent : C.dn, pts = h.map((p, i) => ({ x: x(i), y: y(p.v) }));
    const yz = y(0); ctx.strokeStyle = 'rgba(126,135,148,.25)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, yz); ctx.lineTo(W, yz); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smoothPath(ctx, pts); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, (up ? 'rgba(52,211,153,' : 'rgba(248,113,113,') + '.28)'); g.addColorStop(1, (up ? 'rgba(52,211,153,' : 'rgba(248,113,113,') + '0)'); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smoothPath(ctx, pts); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    const last = pts[pts.length - 1]; ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, 7); ctx.fillStyle = col; ctx.fill();
  };

  // ══ P&L CURVE (sign-coloured MTM + dashed delta) ═════════════════════════════
  window.drawCurve = function (){
    const setT = (id, v, c) => { const e = $id(id); if (e){ e.textContent = v; if (c) e.style.color = c; } };
    const open = window.getOpenMTM(), closed = window.getClosedMTM(), tot = open + closed;
    setT('cv-open', money(open), pnlCol(open)); setT('cv-closed', money(closed), pnlCol(closed)); setT('cv-pts', window._splyHistory.length); setT('cv-total', money(tot), pnlCol(tot));
    const cv = fitCanvas('c-curve');
    if (cv){
      const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
      const h = window._splyHistory, L = 54, R = 12, T = 12, B = 22, CW = W - L - R, CH = H - T - B;
      const now = new Date(), mO = new Date(now); mO.setHours(9, 15, 0, 0); const mC = new Date(now); mC.setHours(15, 30, 0, 0); const dur = mC - mO;
      const toX = t => L + Math.max(0, Math.min(1, (t - mO) / dur)) * CW;
      const axf = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return s + '₹' + (a >= 1e5 ? (a / 1e5).toFixed(1) + 'L' : a >= 1000 ? (a / 1000).toFixed(0) + 'K' : Math.round(a)); };
      if (h.length < 2){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('collecting P&L…', W / 2, H / 2); }
      else {
        const vals = h.map(p => p.v), mn = Math.min(0, ...vals), mx = Math.max(0, ...vals), sp = Math.max(mx - mn, 1000), yMin = mn - sp * 0.14, yMax = mx + sp * 0.14, toY = v => T + CH - ((v - yMin) / (yMax - yMin)) * CH, bY = toY(0);
        ctx.lineWidth = 1; ctx.font = '9px ui-sans-serif,system-ui';
        for (let i = 0; i <= 4; i++){ const v = yMin + (i / 4) * (yMax - yMin), y = toY(v); ctx.strokeStyle = C.line; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(axf(v), L - 6, y + 3); }
        for (let hh = 10; hh <= 15; hh++){ const dd = new Date(now); dd.setHours(hh, 0, 0, 0); const x = toX(dd.getTime()); if (x > L + 2 && x < W - R - 2){ ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + CH); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(((hh - 1) % 12 + 1) + (hh < 12 ? 'a' : 'p'), x, H - 6); } }
        ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(L, bY); ctx.lineTo(W - R, bY); ctx.stroke(); ctx.setLineDash([]);
        const dv = h.filter(p => p.d != null).map(p => p.d);
        if (dv.length > 1){ const dm = Math.max(1, ...dv.map(Math.abs)), dY = d => T + CH / 2 - (d / dm) * (CH / 2 * 0.9); ctx.beginPath(); let st = false; h.forEach(p => { if (p.d == null) return; const x = toX(p.t), y = dY(p.d); st ? ctx.lineTo(x, y) : ctx.moveTo(x, y); st = true; }); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]); ctx.lineJoin = 'round'; ctx.stroke(); ctx.setLineDash([]); }
        const pts = h.map(p => ({ x: toX(p.t), y: toY(p.v), v: p.v }));
        const side = (yTop, yBot, col, g0, g1) => { if (yBot - yTop <= 0.5) return; ctx.save(); ctx.beginPath(); ctx.rect(L, yTop, CW, yBot - yTop); ctx.clip(); ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smoothPath(ctx, pts); ctx.lineTo(pts[pts.length - 1].x, bY); ctx.lineTo(pts[0].x, bY); ctx.closePath(); const g = ctx.createLinearGradient(0, yTop, 0, yBot); g.addColorStop(0, g0); g.addColorStop(1, g1); ctx.fillStyle = g; ctx.fill(); ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smoothPath(ctx, pts); ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore(); };
        side(T, bY, C.up, 'rgba(52,211,153,.30)', 'rgba(52,211,153,0)'); side(bY, T + CH, C.dn, 'rgba(248,113,113,0)', 'rgba(248,113,113,.30)');
        const last = pts[pts.length - 1], col = last.v >= 0 ? C.up : C.dn; ctx.globalAlpha = .28; ctx.beginPath(); ctx.arc(last.x, last.y, 7, 0, 7); ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(last.x, last.y, 3.5, 0, 7); ctx.fillStyle = col; ctx.fill(); ctx.fillStyle = col; ctx.font = 'bold 11px ui-sans-serif,system-ui'; ctx.textAlign = 'right'; ctx.fillText(money(last.v), W - R, Math.max(last.y - 9, T + 11));
      }
    }
    // attribution rows
    const ab = $id('attr-body');
    if (ab){
      const a = window._attribution(open), rows = [['Theta', a.theta], ['Delta', a.delta], ['Gamma', a.gamma], ['Vega', a.vega], ['Other', a.other]];
      const mxA = Math.max(1, ...rows.map(r => Math.abs(r[1])));
      ab.innerHTML = rows.map(([n, v]) => { const w = Math.min(100, Math.abs(v) / mxA * 100), c = v >= 0 ? C.up : C.dn, left = v >= 0 ? '50%' : (50 - w / 2) + '%'; return `<div class="ar"><span class="an">${n}</span><div class="abar"><i style="left:${v >= 0 ? '50%' : (50 - w / 2) + '%'};width:${w / 2}%;background:${c}"></i></div><span class="av" style="color:${c}">${money(v)}</span></div>`; }).join('') + `<div style="font-size:9px;color:${C.muted};margin-top:4px;">since last position change · explains ${money(a.since)}</div>`;
    }
  };

  // ══ PAYOFF ═══════════════════════════════════════════════════════════════════
  window.drawPayoff = function (){
    const cv = fitCanvas('c-payoff'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const pos = window._bsLegs(), spot = window.getSpot();
    if (!pos.length || !spot){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('no open positions', W / 2, H / 2); return; }
    const { T, r, dte, legIVs } = window._getPosCtx(pos, spot);
    const ks = pos.map(p => p.strike), pad = Math.max(spot * 0.03, 500), lo = Math.min(...ks, spot) - pad, hi = Math.max(...ks, spot) + pad, N = 200, pN = [], pE = [];
    for (let i = 0; i <= N; i++){ const s = lo + (i / N) * (hi - lo); pN.push({ s, p: window._bsPnl(pos, s, T, r, legIVs, 0) }); let e = 0; pos.forEach(q => { const it = q.type === 'CE' ? Math.max(0, s - q.strike) : Math.max(0, q.strike - s); e += (q.avg - it) * Math.abs(q.qty); }); pE.push({ s, p: e }); }
    const all = [...pN.map(p => p.p), ...pE.map(p => p.p)], mx = Math.max(...all), mn = Math.min(...all), sp = (mx - mn) || 1000, yMin = mn - sp * 0.1, yMax = mx + sp * 0.1, L = 44, R = 8, Tp = 10, B = 22, CW = W - L - R, CH = H - Tp - B;
    const X = s => L + ((s - lo) / (hi - lo)) * CW, Y = v => Tp + CH - ((v - yMin) / (yMax - yMin)) * CH;
    for (let i = 0; i <= 3; i++){ const v = yMin + (i / 3) * (yMax - yMin), y = Y(v); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L - 4, y + 3); }
    const z = Y(0); ctx.strokeStyle = C.line2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(L, z); ctx.lineTo(W - R, z); ctx.stroke(); ctx.setLineDash([]);
    const be = window._breakevens(pos);
    if (be && be.lower >= lo && be.upper <= hi){ const xl = X(be.lower), xu = X(be.upper); ctx.fillStyle = 'rgba(52,211,153,.07)'; ctx.fillRect(xl, Tp, xu - xl, CH); [be.lower, be.upper].forEach(v => { const bx = X(v); ctx.strokeStyle = 'rgba(251,191,36,.45)'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(bx, Tp); ctx.lineTo(bx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.warn; ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.fillText(Math.round(v), bx, H - 4); }); }
    const sx = X(spot); ctx.strokeStyle = C.accent; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(sx, Tp); ctx.lineTo(sx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.accent; ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('spot', sx, H - 4);
    ctx.beginPath(); pE.forEach((p, i) => i === 0 ? ctx.moveTo(X(p.s), Y(p.p)) : ctx.lineTo(X(p.s), Y(p.p))); ctx.strokeStyle = C.line2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    const at = pN.reduce((b, p) => Math.abs(p.s - spot) < Math.abs(b.s - spot) ? p : b), bY = yMin < 0 && yMax > 0 ? Y(0) : Tp + CH;
    const g = ctx.createLinearGradient(0, Tp, 0, Tp + CH); if (at.p >= 0){ g.addColorStop(0, 'rgba(52,211,153,.16)'); g.addColorStop(1, 'rgba(52,211,153,0)'); } else { g.addColorStop(0, 'rgba(248,113,113,0)'); g.addColorStop(1, 'rgba(248,113,113,.16)'); }
    ctx.beginPath(); pN.forEach((p, i) => i === 0 ? ctx.moveTo(X(p.s), Y(p.p)) : ctx.lineTo(X(p.s), Y(p.p))); ctx.lineTo(X(pN[N].s), bY); ctx.lineTo(X(pN[0].s), bY); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); pN.forEach((p, i) => i === 0 ? ctx.moveTo(X(p.s), Y(p.p)) : ctx.lineTo(X(p.s), Y(p.p))); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.beginPath(); ctx.arc(X(at.s), Y(at.p), 3.5, 0, 7); ctx.fillStyle = at.p >= 0 ? C.up : C.dn; ctx.fill();
    const ds = dte >= 1 ? dte.toFixed(1) + 'd' : (dte * 24).toFixed(1) + 'h'; ctx.fillStyle = C.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.fillText('DTE ' + ds, L + 2, Tp + 10);
  };

  // ══ RISK ═════════════════════════════════════════════════════════════════════
  window.drawRisk = function (){
    const el = $id('risk-body'); if (!el) return;
    const pos = window._bsLegs(), spot = window.getSpot(), mtm = window.getOpenMTM();
    if (!pos.length || !spot){ el.innerHTML = '<div style="color:' + C.muted + ';font-size:12px;text-align:center;padding:16px;">no open positions</div>'; return; }
    const G = window._netGreeks(pos, spot), { T, r, dte, legs } = G, thetaRs = G.nT, allowed = allowedMargin(), used = marginUsed(), mPct = Math.min(100, (used / allowed) * 100);
    const ds = dte >= 1 ? dte.toFixed(1) + 'd' : (dte * 24).toFixed(1) + 'h';
    const stress = [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03].map(sh => ({ l: sh === 0 ? 'now' : (sh > 0 ? '+' : '') + Math.round(sh * 100) + '%', s: Math.round(spot * (1 + sh)), p: window._bsPnl(pos, spot * (1 + sh), T, r, G.legIVs, 0), pi: window._bsPnl(pos, spot * (1 + sh), T, r, G.legIVs, 0.05), now: sh === 0 }));
    const cc = v => v >= 0 ? C.up : C.dn, maxLoss = Math.min(0, ...stress.map(s => s.p)), decayLeft = pos.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot); return a + (l.ltp - it) * (-l.qty); }, 0), thetaHr = Math.abs(thetaRs) / 6.25;
    el.innerHTML = `
      <div class="meters">
        <div class="meter"><div class="ml">Margin used</div><div class="mvv" style="color:${mPct > 80 ? C.dn : mPct > 60 ? C.warn : C.up}">${mPct.toFixed(0)}%</div><div style="font-size:10px;color:${C.muted};margin-top:2px;">₹${(used / 1000).toFixed(0)}K / ₹${(allowed / 1000).toFixed(0)}K</div></div>
        <div class="meter"><div class="ml">Max loss (±3%)</div><div class="mvv" style="color:${C.dn}">${money(maxLoss)}</div><div style="font-size:10px;color:${C.muted};margin-top:2px;">worst in stress range</div></div>
        <div class="meter"><div class="ml">Decay left</div><div class="mvv" style="color:${decayLeft >= 0 ? C.up : C.dn}">${money(decayLeft)}</div><div style="font-size:10px;color:${C.muted};margin-top:2px;">θ ₹${thetaHr.toFixed(0)}/hr · if pinned</div></div>
        <div class="meter"><div class="ml">MTM vs Θ/day</div><div class="mvv" style="color:${cc(mtm)}">${thetaRs !== 0 ? (mtm / Math.abs(thetaRs)).toFixed(2) + '×' : '—'}</div><div style="font-size:10px;color:${C.muted};margin-top:2px;">${money(mtm)} today</div></div>
      </div>
      <h4 style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin:4px 0 7px;">IV per leg · DTE ${ds}</h4>
      ${legs.map(l => `<div class="kv"><span class="kk">${l.name}</span><span>${(l.iv * 100).toFixed(1)}% <span style="color:${C.muted}">entry ${(l.ivEntry * 100).toFixed(1)}%</span></span></div>`).join('')}
      <h4 style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin:12px 0 4px;">Spot stress (BS-priced)</h4>
      <table class="stress"><thead><tr><th>Move</th><th>Spot</th><th>P&amp;L</th><th>+5% IV</th><th>vs Θ</th></tr></thead><tbody>
      ${stress.map(s => `<tr class="${s.now ? 'now' : ''}"><td>${s.l}</td><td style="color:${C.sub}">${s.s.toLocaleString('en-IN')}</td><td style="color:${cc(s.p)}">${money(s.p)}</td><td style="color:${cc(s.pi)}">${money(s.pi)}</td><td style="color:${cc(s.p)}">${thetaRs !== 0 ? (s.p / Math.abs(thetaRs)).toFixed(1) + '×' : '—'}</td></tr>`).join('')}
      </tbody></table>`;
  };

  // ══ BOOK (strategy groups) ═══════════════════════════════════════════════════
  window.drawBook = function (){
    const el = $id('book-body'); if (!el) return;
    const groups = window.strategies();
    if (!groups.length){ el.innerHTML = '<div style="color:' + C.muted + ';font-size:12px;text-align:center;padding:16px;">no open positions</div>'; return; }
    el.innerHTML = groups.map(g => {
      const expTxt = g.exp instanceof Date && !isNaN(g.exp) ? g.exp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
      const legs = g.legs.map(l => `<div class="pos" style="margin-bottom:5px;"><div class="ph"><span class="chip ${(l.type || '').toLowerCase()}">${l.type}</span><b>${l.strike}</b><span class="pm">${l.qty} @ ${l.avg.toFixed(2)} → ${l.ltp.toFixed(2)}</span></div><div class="pl" style="color:${pnlCol(l.pnl)}">${money(l.pnl)}</div></div>`).join('');
      const beTxt = g.be ? Math.round(g.be.lower).toLocaleString('en-IN') + '–' + Math.round(g.be.upper).toLocaleString('en-IN') : '—';
      return `<div class="grp">
        <div class="grp-h"><div><span class="grp-nm">${g.und} ${g.name}</span> <span class="grp-ex">${expTxt}</span></div><div class="pl" style="color:${pnlCol(g.mtm)}">${money(g.mtm)}</div></div>
        ${legs}
        <div class="grp-g"><span>Δ <b style="color:${pnlCol(g.nD)}">${g.nD.toFixed(1)}</b></span><span>Θ/d <b style="color:${C.up}">₹${Math.abs(g.nT).toFixed(0)}</b></span><span>Vega <b style="color:${C.dn}">${g.nV.toFixed(0)}</b></span><span>BE <b>${beTxt}</b></span></div>
      </div>`;
    }).join('');
  };

  // ══ COSTS (charges + slippage) ═══════════════════════════════════════════════
  window.drawCharges = function (){
    const el = $id('charges-body'); if (!el) return;
    const ec = window.calcExecCharges(), sl = window.slippage();
    const slipRows = sl.rows.slice(-6).reverse().map(r => `<div class="kv"><span class="kk">${(parseSymbol(r.sym) || {}).strike || r.sym} ${r.side === 'SELL' ? '▼' : '▲'}</span><span>${r.inp.toFixed(2)}→${r.fill.toFixed(2)} <span style="color:${r.rs > 0 ? C.dn : C.up}">${(r.rs >= 0 ? '−₹' : '+₹') + Math.abs(r.rs).toFixed(0)}</span></span></div>`).join('');
    el.innerHTML = `
      <h4 style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px;">Transaction charges (today)</h4>
      <div class="kv"><span class="kk">Total charges</span><span style="color:${C.dn}">₹${ec.total.toFixed(2)}</span></div>
      <div class="kv"><span class="kk">Executed trades</span><span>${ec.count}</span></div>
      <div class="kv"><span class="kk">Brokerage</span><span>₹${ec.brok.toFixed(2)}</span></div>
      <div class="kv"><span class="kk">STT</span><span>₹${ec.stt.toFixed(2)}</span></div>
      <div class="kv"><span class="kk">Exchange + SEBI</span><span>₹${ec.exch.toFixed(2)}</span></div>
      <div class="kv"><span class="kk">Stamp + GST</span><span>₹${(ec.stamp + ec.gst).toFixed(2)}</span></div>
      <h4 style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin:14px 0 7px;">Slippage <span style="font-weight:400;text-transform:none;">· fill vs intended</span></h4>
      <div class="kv"><span class="kk">Total slippage</span><span style="color:${sl.totalRs > 0 ? C.dn : C.up}">${(sl.totalRs >= 0 ? '−₹' : '+₹') + Math.abs(sl.totalRs).toFixed(0)} ${sl.totalRs > 0 ? '(cost)' : '(gain)'}</span></div>
      <div class="kv"><span class="kk">Per lot</span><span style="color:${sl.perLot > 0 ? C.dn : C.up}">${(sl.perLot >= 0 ? '−₹' : '+₹') + Math.abs(sl.perLot).toFixed(1)}</span></div>
      <div class="kv"><span class="kk">Fills tracked</span><span>${sl.count}</span></div>
      ${slipRows || '<div style="font-size:11px;color:' + C.muted + ';padding:4px 0;">no fills yet</div>'}`;
  };

  // ══ EXEC (preview) ═══════════════════════════════════════════════════════════
  window.runExecute = function (side){
    const type = $id('o-type').value, ce = parseInt($id('o-ce').value), pe = parseInt($id('o-pe').value), lots = parseInt($id('o-lots').value) || 1, legs = [];
    if (type === 'strangle'){ legs.push([ce, 'CE']); legs.push([pe, 'PE']); } else if (type === 'straddle'){ legs.push([ce, 'CE']); legs.push([ce, 'PE']); } else if (type === 'ce') legs.push([ce, 'CE']); else legs.push([pe, 'PE']);
    const lot = lotForUnderlying(), brk = legs.length * lots * brokeragePerLot(side), el = $id('o-log');
    if (el) el.innerHTML = `<span style="color:${side === 'SELL' ? C.dn : C.accent}">${side}</span> ${lots}L → ${legs.map(l => l[0] + l[1]).join(' + ')}<br>est. brokerage ≈ ₹${brk.toFixed(0)} · ${lots * lot} qty/leg`;
  };

  // ══ REFRESH ══════════════════════════════════════════════════════════════════
  window.refreshAll = function (){
    if (!SR || !$id('sply')) return;
    const set = (id, v, c) => { const e = $id(id); if (!e) return; e.textContent = v; if (c) e.style.color = c; };
    const open = window.getOpenMTM(), closed = window.getClosedMTM(), tot = open + closed, spot = window.getSpot();
    set('h-mtm', money(tot), pnlCol(tot)); set('h-open', money(open), pnlCol(open)); set('h-closed', money(closed), pnlCol(closed));
    set('h-spot', spot ? spot.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—');
    const pos = window.parseOpenPos();
    if (pos.length){ const { dte } = window._getPosCtx(pos, spot || 1); set('h-dte', dte < 1 ? (dte * 24).toFixed(1) + 'h to expiry' : dte.toFixed(1) + 'd to expiry'); } else set('h-dte', '');
    set('p-count', pos.length);
    const pl = $id('p-list');
    if (pl) pl.innerHTML = pos.length ? pos.map(p => `<div class="pos"><div class="ph"><span class="chip ${p.type.toLowerCase()}">${p.type}</span><b>${p.strike}</b><span class="pm">${p.qty} @ ${p.avg.toFixed(2)} → ${p.ltp.toFixed(2)}</span></div><div class="pl" style="color:${pnlCol(p.pnl)}">${money(p.pnl)}</div></div>`).join('') : `<div style="color:${C.muted};font-size:12px;padding:4px 0;">no open positions</div>`;
    const legs = window._bsLegs(); let netD = null;
    if (legs.length && spot){ const G = window._netGreeks(legs, spot); netD = G.nD; set('g-d', G.nD.toFixed(1), pnlCol(G.nD)); set('g-g', G.nG.toFixed(3), C.dn); set('g-t', '₹' + Math.abs(G.nT / 6.25).toFixed(0), C.up); set('g-v', G.nV.toFixed(0), C.dn); }
    else ['g-d', 'g-g', 'g-t', 'g-v'].forEach(id => set(id, '—', C.muted));
    const allowed = allowedMargin(), used = marginUsed(), pct = Math.min(100, allowed ? used / allowed * 100 : 0), mb = $id('m-bar');
    if (mb){ mb.style.width = pct + '%'; mb.style.background = pct > 90 ? C.dn : `linear-gradient(90deg,${C.warn},${C.dn})`; }
    set('m-pct', 'Margin ' + pct.toFixed(0) + '%');
    const avail = (Store.margin && Store.margin.availableMargin != null) ? Store.margin.availableMargin : (allowed - used);
    set('m-amt', '₹' + Math.round(used).toLocaleString('en-IN') + ' / ₹' + Math.round(allowed).toLocaleString('en-IN'), avail < 0 ? C.dn : C.muted);
    // target / SL
    try { const t = Store.user && Store.user.target, tl = $id('tsl-l'), tm = $id('tsl-m'), tr = $id('tsl-r'), mk = $id('tsl-mark');
      if (tl){ if (!t){ tl.textContent = 'SL —'; tr.textContent = 'Target —'; tm.textContent = money(tot); tm.style.color = pnlCol(tot); } else { const tgt = (t.profit || 0) / 100 * allowed, slv = (t.sl || 0) / 100 * allowed; tl.textContent = 'SL ' + money(slv); tr.textContent = 'Target ' + money(tgt); tm.textContent = money(tot); tm.style.color = pnlCol(tot); let f = (tot - slv) / ((tgt - slv) || 1); f = Math.max(0, Math.min(1, f)); if (mk) mk.style.left = (f * 100) + '%'; } } } catch (e) {}
    // breakeven strip
    try { const be = $id('be-row'), b = window._breakevens();
      if (be){ if (!b) be.innerHTML = '<span>Breakeven</span><span style="color:' + C.muted + '">—</span>'; else { const inside = spot >= b.lower && spot <= b.upper, near = Math.min(Math.abs(b.upper - spot), Math.abs(spot - b.lower)); be.innerHTML = '<span>Safe zone <b>' + Math.round(b.lower).toLocaleString('en-IN') + '–' + Math.round(b.upper).toLocaleString('en-IN') + '</b></span><span style="color:' + (inside ? C.up : C.dn) + '">' + (inside ? near.toFixed(0) + ' pt to edge' : 'OUTSIDE') + '</span>'; } } } catch (e) {}
    // live dot
    const lv = $id('sply-live'); if (lv){ const on = Date.now() - Store.lastUpdate < 8000; lv.classList.toggle('on', on); set('sply-livetxt', on ? 'live' : (Store.lastUpdate ? 'stale' : 'connecting')); }
    const st = $id('sply-status'); if (st) st.textContent = pollFails > 6 ? 'passive only (poll paused)' : 'passive + poll';
    updateAttribution(legs, spot, open);
    if (pos.length || tot) pushH(tot, netD);
    window.drawSpark();
    if (['payoff', 'curve', 'risk', 'book', 'charges'].includes(window._splyTab)) drawSection(window._splyTab);
  };

  // ══ BOOT + WATCHDOG ══════════════════════════════════════════════════════════
  function boot(){
    try { const s = localStorage.getItem('sply_h'); if (s) window._splyHistory = JSON.parse(s).filter(p => sameDay(p.t)); } catch (e) {}
    buildPanel();
    Store.onUpdate(() => { try { window.refreshAll(); } catch (e) {} });
    setInterval(() => { try { poll(); } catch (e) {} }, POLL_MS);
    setInterval(() => { try { window.refreshAll(); } catch (e) {} }, UI_REFRESH_MS);
    setInterval(() => { try { if (!document.getElementById('sply-host')){ SR = null; buildPanel(); renderTab(window._splyTab || 'payoff'); window.refreshAll(); } } catch (e) {} }, WATCHDOG_MS); // self-heal
    setTimeout(() => { try { poll(); window.refreshAll(); } catch (e) {} }, 600);
    let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { try { window.refreshAll(); } catch (e) {} }, 200); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
