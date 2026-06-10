// ==UserScript==
// @name         Backoffice Analytics Pro
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Institutional post-trade analytics for the Straddly backoffice — equity, drawdown, expectancy, daily heatmap, cost drag, Monte Carlo, sizing. Shadow-DOM isolated + self-healing.
// @author       Ansh
// @match        https://backoffices.pro/*
// @match        https://*.backoffices.pro/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/backoffice-pro.user.js
// @downloadURL  https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/backoffice-pro.user.js
// ==/UserScript==

/*
  v1.0 — reads the backoffice trade journal + ledger (passively intercepted) and turns it into a
  proper performance dashboard. No data leaves the browser. Same robustness as the live overlay
  (Shadow DOM, self-healing watchdog, error-guarded).
  Endpoints used: /api/user/getPositions (trades), /api/user/ledger (daily P&L + flows), /api/user/getuserdetails.
*/
(function () {
  'use strict';

  const UI_REFRESH_MS = 4000, WATCHDOG_MS = 2500, MC_PATHS = 400, MC_HORIZON = 60;
  const C = {
    bg:'#0d1117', panel:'#11151b', card:'#161b22', line:'#1f2730', line2:'#272f3a',
    text:'#e6eaf0', muted:'#7e8794', sub:'#9aa3af',
    accent:'#34d399', accent2:'#10b981', up:'#34d399', dn:'#f87171', warn:'#fbbf24', blue:'#60a5fa', violet:'#a78bfa',
    ce:'#38bdf8', pe:'#f87171', sd:'#a78bfa',
  };

  // ══ STORE ════════════════════════════════════════════════════════════════════
  const Store = { trades: [], ledger: [], user: null, lastUpdate: 0, _l: [], onUpdate(f){ this._l.push(f); }, _emit(){ this.lastUpdate = Date.now(); this._l.forEach(f => { try { f(); } catch (e) {} }); } };
  window.BOAPI = Store;

  function ingest(url, body){
    if (!url || !body) return; let j; try { j = JSON.parse(body); } catch (e) { return; }
    try {
      if (/\/user\/getPositions/i.test(url) && Array.isArray(j)) { if (j.length) { Store.trades = j; Store._emit(); } return; }
      if (/\/user\/ledger/i.test(url) && Array.isArray(j)) { Store.ledger = j; Store._emit(); return; }
      if (/\/user\/getuserdetails/i.test(url) && j && j.id) { Store.user = j; Store._emit(); return; }
    } catch (e) {}
  }
  // intercept (passive)
  const oF = window.fetch;
  if (oF) window.fetch = function (...a){ const url = (a[0] && a[0].url) || a[0]; const p = oF.apply(this, a); try { if (typeof url === 'string') p.then(r => r.clone().text().then(t => ingest(url, t)).catch(()=>{})).catch(()=>{}); } catch (e) {} return p; };
  const oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u){ this.__u = String(u); return oO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (){ const u = this.__u; if (u) this.addEventListener('load', () => { try { ingest(u, this.responseText); } catch (e) {} }); return oS.apply(this, arguments); };

  // ══ PARSING + ANALYTICS ══════════════════════════════════════════════════════
  function parseSym(s){
    if (!s) return {}; s = s.trim();
    let m = s.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})(\d+)(CE|PE|SD)$/);
    if (m) return { underlying: m[1], expiry: new Date(2000 + +m[2], +m[3] - 1, +m[4]), strike: +m[5], type: m[6] };
    m = s.match(/^(.+?)\s+(\d{4})(\d{2})(\d{2})\s+(\d+)(CE|PE|SD)$/);
    if (m) return { underlying: m[1].replace(/\s+/g, ''), expiry: new Date(+m[2], +m[3] - 1, +m[4]), strike: +m[5], type: m[6] };
    return {};
  }
  const sum = (a, k) => a.reduce((s, x) => s + (k ? x[k] : x) || 0, 0);
  function trades(){
    return Store.trades.map(t => {
      const ps = parseSym(t.symbol), cost = (t.brokerage || 0) + (t.expense || 0), net = t.pandL || 0;
      const close = t.updatedOn ? new Date(t.updatedOn) : null, exp = ps.expiry || (t.expiry ? new Date(t.expiry) : null);
      return { sym: t.symbol, type: ps.type || '?', underlying: ps.underlying || '?', strike: ps.strike || 0, net, cost, gross: net + cost, qty: t.sellQuantity || t.quantity || 0, close, exp, dte0: !!(close && exp && close.toDateString() === exp.toDateString()) };
    });
  }
  function stats(){
    const T = trades(), wins = T.filter(t => t.net > 0), losses = T.filter(t => t.net < 0);
    const net = sum(T, 'net'), cost = sum(T, 'cost'), gp = sum(wins, 'net'), gl = Math.abs(sum(losses, 'net'));
    return { n: T.length, net, gross: net + cost, cost, wins: wins.length, losses: losses.length,
      winRate: T.length ? wins.length / T.length : 0, avgWin: wins.length ? gp / wins.length : 0, avgLoss: losses.length ? gl / losses.length : 0,
      pf: gl ? gp / gl : (gp > 0 ? Infinity : 0), exp: T.length ? net / T.length : 0,
      payoff: (wins.length && losses.length) ? (gp / wins.length) / (gl / losses.length) : 0, gp, gl };
  }
  function daily(){
    // primary: derive daily net P&L from trades grouped by close date (the Reports page loads getPositions, not ledger)
    const T = trades();
    if (T.length){
      const m = {};
      T.forEach(t => { if (!t.close || isNaN(t.close)) return; const k = t.close.getFullYear() + '-' + t.close.getMonth() + '-' + t.close.getDate(); (m[k] = m[k] || { d: t.close, v: 0 }).v += t.net; });
      const arr = Object.values(m).map(o => ({ date: o.d, v: o.v })).sort((a, b) => a.date - b.date);
      if (arr.length) return arr;
    }
    // fallback: ledger 'trade' entries
    return Store.ledger.filter(l => l.remarks === 'trade').map(l => ({ date: new Date(l.createdOn), v: l.amount || 0 })).sort((a, b) => a.date - b.date);
  }
  function flows(){ return Store.ledger.filter(l => l.particular === 'payin' || l.particular === 'payout'); }
  function equity(){ const d = daily(); let c = 0; return d.map(x => ({ date: x.date, v: (c += x.v) })); }
  function drawdown(){ const e = equity(); let pk = 0; return e.map(p => { pk = Math.max(pk, p.v); return { date: p.date, dd: p.v - pk }; }); }
  function dailyStats(){
    const d = daily(); if (!d.length) return null;
    const wins = d.filter(x => x.v > 0), losses = d.filter(x => x.v < 0);
    let curW = 0, curL = 0, maxW = 0, maxL = 0;
    d.forEach(x => { if (x.v > 0){ curW++; curL = 0; } else if (x.v < 0){ curL++; curW = 0; } else { curW = curL = 0; } maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL); });
    const dd = drawdown(), maxDD = Math.min(0, ...dd.map(x => x.dd));
    return { days: d.length, green: wins.length, red: losses.length, dayWin: d.length ? wins.length / d.length : 0,
      avgWin: wins.length ? sum(wins, 'v') / wins.length : 0, avgLoss: losses.length ? sum(losses, 'v') / losses.length : 0,
      best: Math.max(0, ...d.map(x => x.v)), worst: Math.min(0, ...d.map(x => x.v)), maxW, maxL, maxDD, net: sum(d, 'v') };
  }
  function groupBy(T, fn){ const g = {}; T.forEach(t => { const k = fn(t); (g[k] = g[k] || []).push(t); }); return g; }
  function kelly(){ const s = stats(); if (!s.payoff || !s.winRate) return { f: 0, half: 0 }; const f = s.winRate - (1 - s.winRate) / s.payoff; return { f: Math.max(0, f), half: Math.max(0, f / 2) }; }
  // bootstrap forward projection from daily P&L
  function monteCarlo(){
    const d = daily().map(x => x.v); if (d.length < 5) return null;
    const paths = [];
    for (let p = 0; p < MC_PATHS; p++){ let c = 0; const path = []; for (let i = 0; i < MC_HORIZON; i++){ c += d[(Math.random() * d.length) | 0]; path.push(c); } paths.push(path); }
    const pct = q => { const last = paths.map(p => p[MC_HORIZON - 1]).sort((a, b) => a - b); return last[Math.min(last.length - 1, Math.floor(q * last.length))]; };
    const band = q => Array.from({ length: MC_HORIZON }, (_, i) => { const col = paths.map(p => p[i]).sort((a, b) => a - b); return col[Math.min(col.length - 1, Math.floor(q * col.length))]; });
    const finals = paths.map(p => p[MC_HORIZON - 1]);
    return { p05: pct(0.05), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p95: pct(0.95), b05: band(0.05), b50: band(0.5), b95: band(0.95), pLoss: finals.filter(x => x < 0).length / finals.length };
  }
  // risk-adjusted + tail metrics from the daily P&L series
  function riskStats(){
    const d = daily().map(x => x.v), n = d.length; if (!n) return null;
    const net = d.reduce((a, b) => a + b, 0), mean = net / n;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const down = Math.sqrt(d.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / n);
    const dd = drawdown(), maxDD = Math.min(0, ...dd.map(x => x.dd));
    const cap = (Store.user && (Store.user.marginAllowed || Store.user.walletBalance)) || 0, ann = Math.sqrt(252);
    const sorted = [...d].sort((a, b) => a - b), k5 = Math.max(1, Math.floor(n * 0.05));
    const cvar = sorted.slice(0, k5).reduce((a, b) => a + b, 0) / k5;
    const worst5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0), grossPos = d.filter(x => x > 0).reduce((a, b) => a + b, 0);
    const L = d.filter(x => x < 0);
    return { n, net, maxDD, cap,
      sharpe: sd ? mean / sd * ann : 0, sortino: down ? mean / down * ann : 0, calmar: maxDD ? net / Math.abs(maxDD) : 0,
      roc: cap ? net / cap : 0,
      skew: sd ? d.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n : 0,
      kurt: sd ? d.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n - 3 : 0,
      cvar, worst5Pct: grossPos ? Math.abs(worst5) / grossPos : 0,
      worstDay: Math.min(0, ...d), avgLossDay: L.length ? L.reduce((a, b) => a + b, 0) / L.length : 0 };
  }
  // premium capture (decay-vs-move proxy): premium sold vs paid to close
  function premiumCapture(){
    let sold = 0, bought = 0;
    Store.trades.forEach(t => { sold += (t.sellAvg || 0) * (t.sellQuantity || 0); bought += (t.buyAvg || 0) * (t.buyQuantity || 0); });
    return { sold, bought, net: sold - bought, capture: sold ? (sold - bought) / sold : 0 };
  }
  // rolling per-trade expectancy (edge-decay detector)
  function rollingExpectancy(){
    const T = trades().filter(t => t.close).sort((a, b) => a.close - b.close).map(t => t.net);
    const W = Math.max(10, Math.min(30, Math.floor(T.length / 8) || 10)), out = [];
    for (let i = W - 1; i < T.length; i++){ let s = 0; for (let j = i - W + 1; j <= i; j++) s += T[j]; out.push(s / W); }
    return { series: out, W };
  }

  // ══ FORMAT ═══════════════════════════════════════════════════════════════════
  const money = v => (v >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN');
  const moneyK = v => { const a = Math.abs(v), s = v < 0 ? '−' : '+'; return s + '₹' + (a >= 1e5 ? (a / 1e5).toFixed(1) + 'L' : a >= 1000 ? (a / 1000).toFixed(1) + 'K' : Math.round(a)); };
  const axK = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return s + '₹' + (a >= 1e5 ? (a / 1e5).toFixed(1) + 'L' : a >= 1000 ? Math.round(a / 1000) + 'K' : Math.round(a)); };
  const pct = v => (v * 100).toFixed(1) + '%';
  const col = v => v >= 0 ? C.up : C.dn;

  // ══ SHADOW PANEL ═════════════════════════════════════════════════════════════
  let SR = null;
  const $ = s => SR ? SR.querySelector(s) : null, $$ = s => SR ? [].slice.call(SR.querySelectorAll(s)) : [], $id = i => $('#' + i);
  function fitCanvas(id){ const cv = $id(id); if (!cv) return null; const w = Math.round(cv.getBoundingClientRect().width) || 360; cv.width = Math.max(w, 220); return cv; }
  function smooth(ctx, p){ if (p.length < 3){ for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); return; } for (let i = 1; i < p.length - 1; i++){ const xc = (p[i].x + p[i + 1].x) / 2, yc = (p[i].y + p[i + 1].y) / 2; ctx.quadraticCurveTo(p[i].x, p[i].y, xc, yc); } const n = p.length - 1; ctx.quadraticCurveTo(p[n].x, p[n].y, p[n].x, p[n].y); }
  // hover crosshair + tooltip. A draw fn sets cv._hit=[{x,top,color,lines:[{t,c}]}] and cv._plot={T,B}; then calls crosshair().
  function crosshair(cv, ctx){
    if (cv._cur == null || !cv._hit || !cv._hit.length) return;
    const pl = cv._plot || { T: 0, B: cv.height };
    let best = cv._hit[0], bd = Infinity;
    for (const h of cv._hit){ const d = Math.abs(h.x - cv._cur); if (d < bd){ bd = d; best = h; } }
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.30)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(best.x, pl.T); ctx.lineTo(best.x, pl.B); ctx.stroke(); ctx.setLineDash([]);
    if (best.top != null){ ctx.beginPath(); ctx.arc(best.x, best.top, 3.5, 0, 7); ctx.fillStyle = best.color || C.accent; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
    const lines = best.lines || []; ctx.font = '10px ui-sans-serif,system-ui'; ctx.textAlign = 'left';
    const tw = Math.max(44, ...lines.map(l => ctx.measureText(l.t).width)) + 14, th = lines.length * 14 + 8;
    let tx = best.x + 9; if (tx + tw > cv.width - 2) tx = best.x - tw - 9; tx = Math.max(2, tx);
    const ty = pl.T + 2;
    ctx.fillStyle = 'rgba(8,11,16,.96)'; ctx.fillRect(tx, ty, tw, th);
    ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.strokeRect(tx, ty, tw, th);
    lines.forEach((l, i) => { ctx.fillStyle = l.c || C.text; ctx.fillText(l.t, tx + 7, ty + 14 + i * 14); });
    ctx.restore();
  }
  function attachHover(id, fn){
    const cv = $id(id); if (!cv || cv.__hov) return; cv.__hov = true; cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); cv._cur = (e.clientX - r.left) * (cv.width / r.width); cv._curY = (e.clientY - r.top) * (cv.height / r.height); try { fn(); } catch (_) {} });
    cv.addEventListener('mouseleave', () => { cv._cur = null; cv._curY = null; try { fn(); } catch (_) {} });
  }
  // reusable tooltip box at (x,y) — flips to stay on-canvas
  function drawTip(ctx, cv, x, y, lines){
    ctx.save(); ctx.font = '10px ui-sans-serif,system-ui'; ctx.textAlign = 'left';
    const tw = Math.max(44, ...lines.map(l => ctx.measureText(l.t).width)) + 14, th = lines.length * 14 + 8;
    let tx = x; if (tx + tw > cv.width - 2) tx = x - tw - 12; tx = Math.max(2, tx);
    let ty = y; if (ty + th > cv.height - 2) ty = cv.height - th - 2; ty = Math.max(2, ty);
    ctx.fillStyle = 'rgba(8,11,16,.96)'; ctx.fillRect(tx, ty, tw, th); ctx.strokeStyle = C.line2; ctx.lineWidth = 1; ctx.strokeRect(tx, ty, tw, th);
    lines.forEach((l, i) => { ctx.fillStyle = l.c || C.text; ctx.fillText(l.t, tx + 7, ty + 14 + i * 14); });
    ctx.restore();
  }

  function buildPanel(){
    if (document.getElementById('boa-host')) return;
    const host = document.createElement('div'); host.id = 'boa-host'; host.style.cssText = 'all:initial;';
    SR = host.attachShadow({ mode: 'open' }); window._BSR = SR;
    const st = document.createElement('style');
    st.textContent = `
      :host{all:initial;}
      *{box-sizing:border-box;margin:0;padding:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;}
      #boa{position:fixed;top:54px;left:16px;z-index:2147483646;width:392px;min-width:320px;max-height:92vh;background:${C.panel};border:1px solid ${C.line};border-radius:18px;overflow:hidden;display:flex;flex-direction:column;color:${C.text};box-shadow:0 24px 60px -24px rgba(0,0,0,.78);resize:both;}
      .top{display:flex;align-items:center;justify-content:space-between;padding:12px 15px;border-bottom:1px solid ${C.line};cursor:move;user-select:none;flex-shrink:0;}
      .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:13px;}
      .mk{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,${C.accent},${C.accent2});display:grid;place-items:center;color:#04140d;font-weight:800;font-size:12px;}
      .tr{display:flex;align-items:center;gap:10px;}
      .rng{font-size:10px;color:${C.muted};}
      .ic{background:transparent;border:none;color:${C.muted};font-size:15px;cursor:pointer;padding:0 2px;}.ic:hover{color:${C.text};}
      .body{overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:${C.line2} transparent;}
      .body::-webkit-scrollbar{width:6px;}.body::-webkit-scrollbar-thumb{background:${C.line2};border-radius:3px;}
      .hero{padding:15px 16px 8px;}
      .hk{font-size:11px;color:${C.muted};letter-spacing:.08em;text-transform:uppercase;}
      .hv{font-size:32px;font-weight:760;letter-spacing:-.02em;margin-top:3px;line-height:1;}
      .hsub{display:flex;gap:13px;margin-top:9px;font-size:11.5px;color:${C.sub};flex-wrap:wrap;}.hsub b{color:${C.text};}
      .tabbar{display:flex;gap:3px;padding:8px 12px;border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};background:${C.bg};overflow-x:auto;scrollbar-width:none;flex-shrink:0;}
      .tabbar::-webkit-scrollbar{display:none;}
      .tab{flex:0 0 auto;background:transparent;border:none;color:${C.muted};font-size:11.5px;font-weight:600;padding:7px 11px;border-radius:9px;cursor:pointer;white-space:nowrap;}
      .tab:hover{color:${C.text};background:${C.card};}.tab.active{color:#04140d;background:${C.accent};}
      .pane{padding:14px 16px 18px;}
      canvas{display:block;width:100%;background:transparent;border-radius:10px;}
      .cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
      .cd{background:${C.card};border-radius:11px;padding:9px 11px;}
      .cl{font-size:10px;color:${C.muted};}.cv{font-size:17px;font-weight:700;margin-top:2px;}.cs{font-size:9.5px;color:${C.muted};margin-top:1px;}
      .kv{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid ${C.line};}
      .kv:last-child{border-bottom:none;}.kv .k{color:${C.muted};}
      .sh{font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.1em;margin:14px 0 8px;}
      .sh:first-child{margin-top:0;}
      .bar{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:6px;}
      .bar .bn{width:88px;color:${C.sub};flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .bar .bt{flex:1;height:14px;background:${C.card};border-radius:4px;position:relative;overflow:hidden;}
      .bar .bt i{position:absolute;top:0;height:100%;border-radius:4px;}
      .bar .bv{width:66px;text-align:right;font-weight:600;flex-shrink:0;}
      .foot{display:flex;justify-content:space-between;align-items:center;padding:7px 14px;border-top:1px solid ${C.line};font-size:10px;color:${C.muted};flex-shrink:0;}
      .foot a{color:${C.accent};text-decoration:none;}
      .empty{color:${C.muted};font-size:12px;text-align:center;padding:24px 0;}
    `;
    SR.appendChild(st);
    const panel = document.createElement('div'); panel.id = 'boa';
    panel.innerHTML = `
      <div class="top" id="boa-top"><div class="brand"><span class="mk">S</span> Backoffice Analytics</div>
        <div class="tr"><span class="rng" id="boa-rng">—</span><button class="ic" id="boa-min">—</button><button class="ic" id="boa-close">✕</button></div></div>
      <div class="body" id="boa-body">
        <div class="hero"><div class="hk">Net P&amp;L</div><div class="hv" id="boa-net">—</div>
          <div class="hsub"><span>Gross <b id="boa-gross">—</b></span><span>Costs <b id="boa-cost">—</b></span><span>Win <b id="boa-wr">—</b></span><span><b id="boa-n">—</b> trades</span></div></div>
        <div class="tabbar" id="boa-tabs">
          <button class="tab active" data-t="overview">Overview</button>
          <button class="tab" data-t="equity">Equity</button>
          <button class="tab" data-t="daily">Daily</button>
          <button class="tab" data-t="trades">Trades</button>
          <button class="tab" data-t="edge">Edge</button>
          <button class="tab" data-t="costs">Costs</button>
          <button class="tab" data-t="mc">Monte Carlo</button>
          <button class="tab" data-t="size">Sizing</button>
        </div>
        <div class="pane" id="boa-pane"></div>
      </div>
      <div class="foot"><span id="boa-status">reading journal…</span><a id="boa-fb" href="mailto:anshlala8000@gmail.com?subject=Backoffice%20Analytics%20feedback">✉ Feedback</a></div>`;
    SR.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    $$('#boa-tabs .tab').forEach(t => t.addEventListener('click', () => { try { render(t.dataset.t); } catch (e) {} }));
    render('overview');
    let mini = false; $id('boa-min').onclick = () => { mini = !mini; $id('boa-body').style.display = mini ? 'none' : ''; };
    $id('boa-close').onclick = () => { host.remove(); SR = null; };
    const top = $id('boa-top'); let drag = false, dx = 0, dy = 0;
    top.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; });
    document.addEventListener('mousemove', e => { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; });
    document.addEventListener('mouseup', () => drag = false);
  }

  // ══ RENDER ═══════════════════════════════════════════════════════════════════
  function render(tab){
    const pane = $id('boa-pane'); if (!pane) return; window._boaTab = tab;
    $$('#boa-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.t === tab));
    const haveT = Store.trades.length, haveD = daily().length;
    try {
      if (tab === 'overview') pane.innerHTML = ovHTML();
      else if (tab === 'equity'){ pane.innerHTML = `<canvas id="boa-eq" height="200"></canvas><div class="sh" style="margin-top:14px;">Drawdown</div><canvas id="boa-dd" height="120"></canvas>`; drawEquity(); drawDD(); attachHover('boa-eq', drawEquity); attachHover('boa-dd', drawDD); }
      else if (tab === 'daily'){ pane.innerHTML = `<div class="sh">Daily P&amp;L</div><canvas id="boa-daily" height="150"></canvas><div class="sh">Calendar</div><canvas id="boa-cal" height="120"></canvas><div class="sh">Monthly</div><canvas id="boa-mon" height="120"></canvas>`; drawDaily(); drawCal(); drawMonthly(); attachHover('boa-daily', drawDaily); attachHover('boa-cal', drawCal); attachHover('boa-mon', drawMonthly); }
      else if (tab === 'trades'){ pane.innerHTML = tradesHTML(); drawHist(); }
      else if (tab === 'edge'){ pane.innerHTML = edgeHTML(); drawRoll(); attachHover('boa-roll', drawRoll); }
      else if (tab === 'costs') pane.innerHTML = costsHTML();
      else if (tab === 'mc'){ pane.innerHTML = `<div class="sh">${MC_HORIZON}-day forward projection <span style="text-transform:none;font-weight:400;">· bootstrap of your daily P&L</span></div><canvas id="boa-mc" height="190"></canvas><div id="boa-mcstats"></div>`; drawMC(); }
      else if (tab === 'size') pane.innerHTML = sizeHTML();
      if (!haveT && !haveD && ['overview','trades','costs','size','edge'].includes(tab)) pane.innerHTML = `<div class="empty">Loading your journal…<br><span style="font-size:11px;">set a wide date range on the Reports page</span></div>`;
    } catch (e) { pane.innerHTML = `<div class="empty">…</div>`; }
  }

  function ovHTML(){
    const s = stats(), ds = dailyStats(); if (!s.n) return `<div class="empty">Loading your journal…<br><span style="font-size:11px;">set a wide date range on the Reports page</span></div>`;
    const pfTxt = s.pf === Infinity ? '∞' : s.pf.toFixed(2);
    return `
      <div class="cards">
        <div class="cd"><div class="cl">Win rate</div><div class="cv" style="color:${s.winRate >= .5 ? C.up : C.warn}">${pct(s.winRate)}</div><div class="cs">${s.wins}W / ${s.losses}L</div></div>
        <div class="cd"><div class="cl">Profit factor</div><div class="cv" style="color:${s.pf >= 1.3 ? C.up : s.pf >= 1 ? C.warn : C.dn}">${pfTxt}</div><div class="cs">gross ₹${Math.round(s.gp / 1000)}K / ₹${Math.round(s.gl / 1000)}K</div></div>
        <div class="cd"><div class="cl">Expectancy / trade</div><div class="cv" style="color:${col(s.exp)}">${money(s.exp)}</div><div class="cs">avg of ${s.n} trades</div></div>
        <div class="cd"><div class="cl">Payoff (W:L)</div><div class="cv">${s.payoff.toFixed(2)}</div><div class="cs">₹${Math.round(s.avgWin)} : ₹${Math.round(s.avgLoss)}</div></div>
      </div>
      ${(function(){ const r = riskStats(); if (!r) return ''; const cc = v => v >= 0 ? C.up : C.dn; return `<div class="sh">Risk-adjusted</div>
        <div class="kv"><span class="k">R / MaxDD (Calmar)</span><span style="color:${cc(r.calmar)}">${r.calmar.toFixed(2)}</span></div>
        <div class="kv"><span class="k">Sortino (ann.)</span><span style="color:${cc(r.sortino)}">${r.sortino.toFixed(2)}</span></div>
        <div class="kv"><span class="k">Sharpe (ann.)</span><span style="color:${cc(r.sharpe)}">${r.sharpe.toFixed(2)}</span></div>
        <div class="kv"><span class="k">Return on capital</span><span style="color:${cc(r.roc)}">${pct(r.roc)}${r.cap ? '' : ' <span style="color:' + C.muted + '">(no cap data)</span>'}</span></div>`; })()}
      <div class="sh">Account</div>
      <canvas id="boa-spark" height="60"></canvas>
      ${ds ? `<div class="kv"><span class="k">Trading days</span><span>${ds.days} · ${pct(ds.dayWin)} green</span></div>
      <div class="kv"><span class="k">Best / worst day</span><span><span style="color:${C.up}">${money(ds.best)}</span> / <span style="color:${C.dn}">${money(ds.worst)}</span></span></div>
      <div class="kv"><span class="k">Win / loss streak</span><span>${ds.maxW} / ${ds.maxL} days</span></div>
      <div class="kv"><span class="k">Max drawdown</span><span style="color:${C.dn}">${money(ds.maxDD)}</span></div>` : ''}
      <div class="kv"><span class="k">Total costs paid</span><span style="color:${C.dn}">${money(-s.cost)}</span></div>`;
  }
  function tradesHTML(){
    const T = trades(); if (!T.length) return `<div class="empty">Loading…</div>`;
    const mk = (title, groups) => { const rows = Object.keys(groups).map(k => ({ k, net: sum(groups[k], 'net'), n: groups[k].length })).sort((a, b) => b.net - a.net); const mx = Math.max(1, ...rows.map(r => Math.abs(r.net))); return `<div class="sh">${title}</div>` + rows.map(r => { const w = Math.abs(r.net) / mx * 50, c = col(r.net); return `<div class="bar"><span class="bn">${r.k} <span style="color:${C.muted}">·${r.n}</span></span><div class="bt"><i style="left:${r.net >= 0 ? '50%' : (50 - w) + '%'};width:${w}%;background:${c}"></i></div><span class="bv" style="color:${c}">${moneyK(r.net)}</span></div>`; }).join(''); };
    return mk('By instrument type', groupBy(T, t => t.type)) +
      mk('Expiry-day vs swing', groupBy(T, t => t.dte0 ? '0DTE (expiry)' : 'carried')) +
      mk('By weekday', groupBy(T.filter(t => t.close), t => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.close.getDay()])) +
      `<div class="sh">P&amp;L distribution</div><canvas id="boa-hist" height="120"></canvas>`;
  }
  function costsHTML(){
    const s = stats(), brok = sum(Store.trades.map(t => ({ v: t.brokerage || 0 })), 'v'), exp = sum(Store.trades.map(t => ({ v: t.expense || 0 })), 'v');
    const dragGross = s.gross ? s.cost / Math.abs(s.gross) : 0, perTrade = s.n ? s.cost / s.n : 0;
    return `
      <div class="cards">
        <div class="cd"><div class="cl">Total costs</div><div class="cv" style="color:${C.dn}">${money(-s.cost)}</div><div class="cs">${s.n} trades</div></div>
        <div class="cd"><div class="cl">Cost drag</div><div class="cv" style="color:${dragGross > .3 ? C.dn : C.warn}">${pct(dragGross)}</div><div class="cs">of gross P&L</div></div>
      </div>
      <div class="sh">Breakdown</div>
      <div class="kv"><span class="k">Brokerage</span><span>${money(-brok)}</span></div>
      <div class="kv"><span class="k">Exchange / taxes (expense)</span><span>${money(-exp)}</span></div>
      <div class="kv"><span class="k">Avg cost / trade</span><span>${money(-perTrade)}</span></div>
      <div class="kv"><span class="k">Gross P&L (pre-cost)</span><span style="color:${col(s.gross)}">${money(s.gross)}</span></div>
      <div class="kv"><span class="k">Net P&L (post-cost)</span><span style="color:${col(s.net)}">${money(s.net)}</span></div>
      <div class="sh">Reality check</div>
      <div style="font-size:11.5px;color:${C.sub};line-height:1.5;">Fees ate <b style="color:${C.dn}">${pct(dragGross)}</b> of your gross edge. ${dragGross > .35 ? 'That\'s a heavy drag — fewer, bigger trades keep more.' : 'Reasonable for an active book.'}</div>`;
  }
  function sizeHTML(){
    const s = stats(), k = kelly(), ds = dailyStats(), cap = (Store.user && Store.user.marginAllowed) || 0;
    return `
      <div class="cards">
        <div class="cd"><div class="cl">Kelly fraction</div><div class="cv" style="color:${C.accent}">${pct(k.f)}</div><div class="cs">of capital at risk</div></div>
        <div class="cd"><div class="cl">Half-Kelly (safer)</div><div class="cv">${pct(k.half)}</div><div class="cs">recommended</div></div>
      </div>
      <div class="sh">From your edge</div>
      <div class="kv"><span class="k">Win rate</span><span>${pct(s.winRate)}</span></div>
      <div class="kv"><span class="k">Payoff ratio</span><span>${s.payoff.toFixed(2)}</span></div>
      <div class="kv"><span class="k">Expectancy / trade</span><span style="color:${col(s.exp)}">${money(s.exp)}</span></div>
      ${cap ? `<div class="kv"><span class="k">Half-Kelly risk budget</span><span>${money(k.half * cap)}</span></div>` : ''}
      ${ds ? `<div class="kv"><span class="k">Your avg loss day</span><span style="color:${C.dn}">${money(ds.avgLoss)}</span></div>
      <div class="kv"><span class="k">Worst day seen</span><span style="color:${C.dn}">${money(ds.worst)}</span></div>` : ''}
      <div class="sh">Note</div>
      <div style="font-size:11.5px;color:${C.sub};line-height:1.5;">Kelly assumes your past edge repeats. Short-vol books have fat tails — <b>half-Kelly or less</b> is sane. This is a guide, not advice.</div>`;
  }
  function edgeHTML(){
    const r = riskStats(), pc = premiumCapture(); if (!Store.trades.length || !r) return `<div class="empty">Loading…</div>`;
    const paidW = pc.sold ? Math.min(100, pc.bought / pc.sold * 100) : 0;
    const wvA = r.avgLossDay ? r.worstDay / r.avgLossDay : 0;
    return `
      <div class="sh">Rolling expectancy <span style="text-transform:none;font-weight:400;">· per-trade — is the edge holding?</span></div>
      <canvas id="boa-roll" height="130"></canvas>
      <div class="sh">Tail risk · daily</div>
      <div class="kv"><span class="k">Skew</span><span style="color:${r.skew < 0 ? C.dn : C.up}">${r.skew.toFixed(2)} ${r.skew < -0.3 ? '· fat left tail' : ''}</span></div>
      <div class="kv"><span class="k">Excess kurtosis</span><span style="color:${r.kurt > 1 ? C.warn : C.text}">${r.kurt.toFixed(2)} ${r.kurt > 1 ? '· fat tails' : ''}</span></div>
      <div class="kv"><span class="k">CVaR 5% (avg worst days)</span><span style="color:${C.dn}">${money(r.cvar)}</span></div>
      <div class="kv"><span class="k">Worst 5 days erased</span><span style="color:${C.dn}">${pct(r.worst5Pct)} of green-day gains</span></div>
      <div class="kv"><span class="k">Worst day vs avg loss</span><span style="color:${wvA < -2 ? C.dn : C.text}">${wvA.toFixed(1)}×</span></div>
      <div class="sh">Premium capture <span style="text-transform:none;font-weight:400;">· decay-vs-move proxy</span></div>
      <div class="cards">
        <div class="cd"><div class="cl">Capture rate</div><div class="cv" style="color:${pc.capture >= 0 ? C.up : C.dn}">${pct(pc.capture)}</div><div class="cs">kept of premium sold</div></div>
        <div class="cd"><div class="cl">Net (pre-cost)</div><div class="cv" style="color:${col(pc.net)}">${money(pc.net)}</div><div class="cs">sold − bought back</div></div>
      </div>
      <div class="bar" style="margin-top:10px;"><span class="bn">Collected ≈ θ</span><div class="bt"><i style="left:0;width:100%;background:${C.up}"></i></div><span class="bv" style="color:${C.up}">${moneyK(pc.sold)}</span></div>
      <div class="bar"><span class="bn">Paid ≈ move</span><div class="bt"><i style="left:0;width:${paidW}%;background:${C.dn}"></i></div><span class="bv" style="color:${C.dn}">${moneyK(-pc.bought)}</span></div>
      <div class="note">Proxy, not true greek attribution — that needs the spot+IV path (not in the journal). "Collected" ≈ theta you sold; "paid" ≈ what you gave back to the move. For real θ/Δ/Γ/vega, join trades to spot/IV in your research pipeline.</div>`;
  }

  // ══ CHARTS ═══════════════════════════════════════════════════════════════════
  function lineChart(id, series, opts){
    const cv = fitCanvas(id); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    if (!series || series.length < 2){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('not enough data', W / 2, H / 2); return; }
    const L = opts.L || 50, R = 10, T = 10, B = opts.B || 8, CW = W - L - R, CH = H - T - B;
    const vals = series.map(p => p.v), mn = Math.min(0, ...vals), mx = Math.max(0, ...vals), sp = (mx - mn) || 1;
    const X = i => L + (i / (series.length - 1)) * CW, Y = v => T + CH - ((v - mn) / sp) * CH, bY = Y(0);
    for (let i = 0; i <= 3; i++){ const v = mn + (i / 3) * sp, y = Y(v); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'right'; ctx.fillText(axK(v), L - 5, y + 3); }
    const pts = series.map((p, i) => ({ x: X(i), y: Y(p.v) })), last = series[series.length - 1].v, c = opts.color || (last >= 0 ? C.up : C.dn);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smooth(ctx, pts); ctx.lineTo(pts[pts.length - 1].x, bY); ctx.lineTo(pts[0].x, bY); ctx.closePath();
    const g = ctx.createLinearGradient(0, T, 0, T + CH); g.addColorStop(0, (last >= 0 ? 'rgba(52,211,153,' : 'rgba(248,113,113,') + '.26)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smooth(ctx, pts); ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    if (opts.label){ ctx.fillStyle = c; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'right'; ctx.fillText(money(last), W - R, T + 11); }
    cv._plot = { T, B: T + CH };
    cv._hit = pts.map((p, i) => ({ x: p.x, top: p.y, color: c, lines: [{ t: series[i].date ? new Date(series[i].date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ('#' + (i + 1)), c: C.muted }, { t: money(series[i].v), c: series[i].v >= 0 ? C.up : C.dn }] }));
    crosshair(cv, ctx);
  }
  window._drawSpark = () => lineChart('boa-spark', equity(), { L: 38, label: false });
  function drawEquity(){ lineChart('boa-eq', equity(), { L: 50, label: true }); }
  function drawDD(){ const cv = fitCanvas('boa-dd'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H); const dd = drawdown(); if (dd.length < 2){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('—', W / 2, H / 2); return; } const L = 50, R = 10, T = 8, B = 8, CW = W - L - R, CH = H - T - B; const mn = Math.min(-1, ...dd.map(x => x.dd)); const X = i => L + (i / (dd.length - 1)) * CW, Y = v => T + ((v) / mn) * CH; for (let i = 0; i <= 2; i++){ const v = (i / 2) * mn, y = Y(v); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'right'; ctx.fillText(axK(v), L - 5, y + 3); } const pts = dd.map((p, i) => ({ x: X(i), y: Y(p.dd) })); ctx.beginPath(); ctx.moveTo(pts[0].x, T); pts.forEach(p => ctx.lineTo(p.x, p.y)); ctx.lineTo(pts[pts.length - 1].x, T); ctx.closePath(); ctx.fillStyle = 'rgba(248,113,113,.22)'; ctx.fill(); ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.strokeStyle = C.dn; ctx.lineWidth = 1.5; ctx.stroke(); cv._plot = { T, B: T + CH }; cv._hit = dd.map((p, i) => ({ x: X(i), top: Y(p.dd), color: C.dn, lines: [{ t: p.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), c: C.muted }, { t: money(p.dd), c: C.dn }] })); crosshair(cv, ctx); }
  function drawDaily(){ const cv = fitCanvas('boa-daily'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H); const d = daily(); if (!d.length){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('no daily data', W / 2, H / 2); return; } const L = 46, R = 8, T = 8, B = 8, CW = W - L - R, CH = H - T - B; const mx = Math.max(1, ...d.map(x => Math.abs(x.v))), Y = v => T + CH / 2 - (v / mx) * (CH / 2 * 0.95), bw = Math.max(1, CW / d.length - 1); ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(W - R, Y(0)); ctx.stroke(); for (let i = 0; i <= 2; i++){ const v = mx * (1 - i); [v, -v].forEach(vv => { const y = Y(vv); ctx.fillStyle = C.muted; ctx.font = '8px system-ui'; ctx.textAlign = 'right'; if (i < 2) ctx.fillText(axK(vv), L - 4, y + 3); }); } const hit = []; d.forEach((x, i) => { const px = L + (i / d.length) * CW, y0 = Y(0), y1 = Y(x.v); ctx.fillStyle = x.v >= 0 ? C.up : C.dn; ctx.fillRect(px, Math.min(y0, y1), bw, Math.abs(y1 - y0) || 1); hit.push({ x: px + bw / 2, top: y1, color: x.v >= 0 ? C.up : C.dn, lines: [{ t: x.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), c: C.muted }, { t: money(x.v), c: x.v >= 0 ? C.up : C.dn }] }); }); cv._plot = { T, B: T + CH }; cv._hit = hit; crosshair(cv, ctx); }
  function drawCal(){
    const cv = fitCanvas('boa-cal'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const d = daily(); if (!d.length) return;
    const map = {}; d.forEach(x => map[x.date.toDateString()] = x.v);
    const start = d[0].date, end = d[d.length - 1].date;
    const day0 = new Date(start); day0.setDate(day0.getDate() - ((day0.getDay() + 6) % 7));
    const weeks = Math.ceil((end - day0) / (7 * 864e5)) + 1;
    const cell = Math.max(3, Math.min(11, (W - 24) / weeks - 1)), gap = 1, top = 6, leftPad = 22;
    const mx = Math.max(1, ...d.map(x => Math.abs(x.v))), cells = [];
    ['M', '', 'W', '', 'F'].forEach((lbl, r) => { if (lbl){ ctx.fillStyle = C.muted; ctx.font = '8px system-ui'; ctx.textAlign = 'left'; ctx.fillText(lbl, 0, top + r * (cell + gap) + cell); } });
    for (let w = 0; w < weeks; w++) for (let r = 0; r < 5; r++){
      const dt = new Date(day0); dt.setDate(dt.getDate() + w * 7 + r); if (dt < start || dt > end) continue;
      const v = map[dt.toDateString()]; let fill = '#1a2027';
      if (v != null){ const i = Math.min(1, Math.abs(v) / mx); fill = v >= 0 ? `rgba(52,211,153,${(0.2 + i * 0.8).toFixed(2)})` : `rgba(248,113,113,${(0.2 + i * 0.8).toFixed(2)})`; }
      const x = leftPad + w * (cell + gap), y = top + r * (cell + gap);
      ctx.fillStyle = fill; ctx.fillRect(x, y, cell, cell);
      cells.push({ x, y, s: cell, date: new Date(dt), v });
    }
    cv._cells = cells;
    if (cv._cur != null && cv._curY != null && cells.length){
      let h = null, bd = Infinity; for (const c of cells){ const cx = c.x + c.s / 2, cy = c.y + c.s / 2, dd = (cx - cv._cur) ** 2 + (cy - cv._curY) ** 2; if (dd < bd){ bd = dd; h = c; } }
      if (h && bd < (cell + gap) * (cell + gap) * 2.2){
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(h.x - 0.5, h.y - 0.5, h.s + 1, h.s + 1);
        drawTip(ctx, cv, h.x + h.s + 5, h.y, [{ t: h.date.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }), c: C.muted }, { t: h.v != null ? money(h.v) : 'no trades', c: h.v == null ? C.muted : (h.v >= 0 ? C.up : C.dn) }]);
      }
    }
  }
  function drawMonthly(){ const cv = fitCanvas('boa-mon'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H); const d = daily(); if (!d.length) return; const m = {}; d.forEach(x => { const k = x.date.getFullYear() + '-' + (x.date.getMonth() + 1); m[k] = (m[k] || { v: 0, lbl: x.date.toLocaleDateString('en-IN', { month: 'short' }) }); m[k].v += x.v; }); const arr = Object.values(m), L = 8, R = 8, T = 8, B = 16, CW = W - L - R, CH = H - T - B; const mx = Math.max(1, ...arr.map(x => Math.abs(x.v))), Y = v => T + CH / 2 - (v / mx) * (CH / 2 * 0.9), bw = Math.max(4, CW / arr.length - 4); ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(W - R, Y(0)); ctx.stroke(); const hit = []; arr.forEach((x, i) => { const px = L + i * (CW / arr.length) + 2, y0 = Y(0), y1 = Y(x.v); ctx.fillStyle = x.v >= 0 ? C.up : C.dn; ctx.fillRect(px, Math.min(y0, y1), bw, Math.abs(y1 - y0) || 1); ctx.fillStyle = C.muted; ctx.font = '8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(x.lbl, px + bw / 2, H - 4); hit.push({ x: px + bw / 2, top: y1, color: x.v >= 0 ? C.up : C.dn, lines: [{ t: x.lbl, c: C.muted }, { t: money(x.v), c: x.v >= 0 ? C.up : C.dn }] }); }); cv._plot = { T, B: T + CH }; cv._hit = hit; crosshair(cv, ctx); }
  function drawHist(){ const cv = fitCanvas('boa-hist'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H); const T = trades().map(t => t.net); if (T.length < 3) return; const mn = Math.min(...T), mx = Math.max(...T), NB = 21, bw = (mx - mn) / NB || 1, bins = new Array(NB).fill(0); T.forEach(v => { bins[Math.min(NB - 1, Math.floor((v - mn) / bw))]++; }); const L = 8, R = 8, Tp = 8, B = 8, CW = W - L - R, CH = H - Tp - B, mxc = Math.max(...bins), zx = L + ((0 - mn) / (mx - mn)) * CW; ctx.strokeStyle = C.line2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(zx, Tp); ctx.lineTo(zx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); bins.forEach((c, i) => { const x = L + (i / NB) * CW, h = (c / mxc) * CH, mid = mn + (i + 0.5) * bw; ctx.fillStyle = mid >= 0 ? C.up : C.dn; ctx.fillRect(x, Tp + CH - h, CW / NB - 1, h); }); }
  function drawMC(){ const cv = fitCanvas('boa-mc'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H); const mc = monteCarlo(); const se = $id('boa-mcstats'); if (!mc){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('need more trading days', W / 2, H / 2); if (se) se.innerHTML = ''; return; } const L = 50, R = 10, T = 10, B = 14, CW = W - L - R, CH = H - T - B; const all = [...mc.b05, ...mc.b95, 0], mn = Math.min(...all), mx = Math.max(...all), sp = (mx - mn) || 1; const X = i => L + (i / (MC_HORIZON - 1)) * CW, Y = v => T + CH - ((v - mn) / sp) * CH; for (let i = 0; i <= 3; i++){ const v = mn + (i / 3) * sp, y = Y(v); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'right'; ctx.fillText(axK(v), L - 5, y + 3); } ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(W - R, Y(0)); ctx.stroke(); ctx.beginPath(); mc.b95.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); for (let i = MC_HORIZON - 1; i >= 0; i--) ctx.lineTo(X(i), Y(mc.b05[i])); ctx.closePath(); ctx.fillStyle = 'rgba(96,165,250,.14)'; ctx.fill(); ctx.beginPath(); mc.b50.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.strokeStyle = C.blue; ctx.lineWidth = 2; ctx.stroke(); if (se) se.innerHTML = `<div class="kv"><span class="k">Median (${MC_HORIZON}d)</span><span style="color:${col(mc.p50)}">${money(mc.p50)}</span></div><div class="kv"><span class="k">Best case (p95)</span><span style="color:${C.up}">${money(mc.p95)}</span></div><div class="kv"><span class="k">Worst case (p5)</span><span style="color:${C.dn}">${money(mc.p05)}</span></div><div class="kv"><span class="k">Chance of a losing ${MC_HORIZON}d</span><span style="color:${mc.pLoss > .3 ? C.dn : C.warn}">${pct(mc.pLoss)}</span></div>`; }

  function drawRoll(){
    const cv = fitCanvas('boa-roll'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const r = rollingExpectancy(), s = r.series;
    if (s.length < 2){ ctx.fillStyle = C.muted; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('need more trades', W / 2, H / 2); return; }
    const L = 46, R = 10, T = 10, B = 8, CW = W - L - R, CH = H - T - B;
    const mn = Math.min(0, ...s), mx = Math.max(0, ...s), sp = (mx - mn) || 1;
    const X = i => L + (i / (s.length - 1)) * CW, Y = v => T + CH - ((v - mn) / sp) * CH, bY = Y(0);
    for (let i = 0; i <= 3; i++){ const v = mn + (i / 3) * sp, y = Y(v); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.font = '9px system-ui'; ctx.textAlign = 'right'; ctx.fillText(axK(v), L - 5, y + 3); }
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(L, bY); ctx.lineTo(W - R, bY); ctx.stroke(); ctx.setLineDash([]);
    const pts = s.map((v, i) => ({ x: X(i), y: Y(v) })), last = s[s.length - 1], c = last >= 0 ? C.up : C.dn;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smooth(ctx, pts); ctx.lineTo(pts[pts.length - 1].x, bY); ctx.lineTo(pts[0].x, bY); ctx.closePath();
    const g = ctx.createLinearGradient(0, T, 0, T + CH); g.addColorStop(0, (last >= 0 ? 'rgba(52,211,153,' : 'rgba(248,113,113,') + '.24)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); smooth(ctx, pts); ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = c; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'right'; ctx.fillText(money(last) + '/trade', W - R, T + 10);
    cv._plot = { T, B: T + CH }; cv._hit = pts.map((p, i) => ({ x: p.x, top: p.y, color: s[i] >= 0 ? C.up : C.dn, lines: [{ t: 'trade #' + (i + r.W), c: C.muted }, { t: money(s[i]) + '/trade', c: s[i] >= 0 ? C.up : C.dn }] })); crosshair(cv, ctx);
  }

  // ══ REFRESH ══════════════════════════════════════════════════════════════════
  function refresh(){
    if (!SR || !$id('boa')) return;
    const set = (id, v, c) => { const e = $id(id); if (!e) return; e.textContent = v; if (c) e.style.color = c; };
    const s = stats();
    set('boa-net', s.n ? money(s.net) : '—', col(s.net)); set('boa-gross', money(s.gross), col(s.gross)); set('boa-cost', money(-s.cost), C.dn);
    set('boa-wr', s.n ? pct(s.winRate) : '—'); set('boa-n', s.n || '—');
    const d = daily(); const rng = $id('boa-rng'); if (rng && d.length) rng.textContent = d[0].date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) + ' → ' + d[d.length - 1].date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    const stt = $id('boa-status'); if (stt) stt.textContent = (Store.trades.length || d.length) ? `${Store.trades.length} trades · ${d.length} days` : 'reading journal…';
    // refresh active visual tab
    const t = window._boaTab;
    try { if (t === 'overview') window._drawSpark(); else if (t === 'equity'){ drawEquity(); drawDD(); } else if (t === 'daily'){ drawDaily(); drawCal(); drawMonthly(); } else if (t === 'trades') drawHist(); else if (t === 'edge') drawRoll(); else if (t === 'mc') drawMC(); } catch (e) {}
    // if overview is showing and data just arrived, re-render its HTML (stats cards)
    if (t === 'overview' && s.n && $id('boa-pane') && /Loading/.test($id('boa-pane').innerHTML)) render('overview');
    else if (t === 'overview') { /* keep, spark redrawn */ }
  }
  // re-render current tab fully when new data lands (so HTML tabs update)
  Store.onUpdate(() => { try { if (window._boaTab) render(window._boaTab); refresh(); } catch (e) {} });

  // ══ BOOT + WATCHDOG ══════════════════════════════════════════════════════════
  function boot(){
    buildPanel();
    setInterval(() => { try { refresh(); } catch (e) {} }, UI_REFRESH_MS);
    setInterval(() => { try { if (!document.getElementById('boa-host')){ SR = null; buildPanel(); render(window._boaTab || 'overview'); refresh(); } } catch (e) {} }, WATCHDOG_MS);
    setTimeout(() => { try { refresh(); } catch (e) {} }, 700);
    let tm; window.addEventListener('resize', () => { clearTimeout(tm); tm = setTimeout(() => { try { render(window._boaTab || 'overview'); } catch (e) {} }, 200); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
