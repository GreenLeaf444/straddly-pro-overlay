// ==UserScript==
// @name         Straddly Payoff & Risk (mini)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Minimal overlay for the Straddly CloudFront trade page — payoff + greeks + risk, embedded natively. Reads positions from the page + self-fetches touchline for spot.
// @author       Ansh
// @match        https://dwbjchneyogha.cloudfront.net/*
// @match        https://*.straddly.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/straddly-payoff.user.js
// @downloadURL  https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/straddly-payoff.user.js
// ==/UserScript==

/*
  Lean sibling of the full Straddly Pro overlay — same battle-tested data engine (intercept the
  portal's API, self-poll via captured token, compute locally), but the UI is ONE panel:
  payoff diagram + net greeks + a few risk numbers. Nothing leaves the browser.
*/
(function () {
  'use strict';
  const POLL_MS = 3000, UI_REFRESH_MS = 1500, WATCHDOG_MS = 2500, DEFAULT_ALLOWED_MARGIN = 114113.08;
  // "TradingAlgo" vibe — near-black, bright terminal green, orange-red, mono numbers
  const C = { bg:'#050607', panel:'#0a0b0d', card:'#101216', line:'#191c21', line2:'#24282e', text:'#e9edf0', muted:'#697079', sub:'#9aa3af', accent:'#4ade80', accent2:'#22c55e', up:'#4ade80', dn:'#ff5a52', warn:'#fbbf24', ce:'#38bdf8', pe:'#ff5a52', sd:'#a78bfa' };
  const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

  // ══ STORE ═══════════════════════════════════════════════════════════════════
  const Store = { positions: [], ltpById: {}, ltpBySym: {}, chain: {}, margin: null, user: null, spot: 0, lastUpdate: 0, auth: '', dbg: '', _l: [], onUpdate(f){ this._l.push(f); }, _emit(){ this.lastUpdate = Date.now(); this._l.forEach(f => { try { f(); } catch (e) {} }); } };
  window.SPAY = Store;
  function parseSymbol(s){ if (!s) return null; const m = s.match(/^([A-Z]+?)(\d{2})(\d{2})(\d{2})(\d+)(CE|PE|SD)$/); if (!m) return null; return { underlying: m[1], expiry: new Date(2000 + +m[2], +m[3] - 1, +m[4], 15, 30, 0), strike: +m[5], type: m[6] }; }
  // CloudFront build: same-origin /api/data/touchline (live quotes) + getuserdetails. Positions come via socket → we DOM-scrape them.
  function ingest(url, body){ if (!url || !body) return; let j; try { j = JSON.parse(body); } catch (e) { return; } const d = j && j.data !== undefined ? j.data : j; try {
    if (/\/(data\/)?[Tt]ouchline/i.test(url) && Array.isArray(d)) { d.forEach(q => { if (q && q.symbol){ if (q.symbolId != null) Store.ltpById[q.symbolId] = q.ltp; Store.ltpBySym[q.symbol] = q.ltp; } }); recomputeSpot(); Store._emit(); return; }
    if (/user\/getuserdetails/i.test(url) && d && d.id) { Store.user = d; Store._emit(); return; }
    if (/\/(Orders\/Get-MarginusedByID|user\/getMargin)/i.test(url) && Array.isArray(d) && d.length) { Store.margin = d[0]; Store._emit(); return; }
  } catch (e) {} }
  const IDX = { NIFTY: 'NIFTY', BANKNIFTY: 'NIFTY BANK', SENSEX: 'SENSEX' };
  function detectUnderlying(){ for (const p of Store.positions){ const s = parseSymbol(p.symbol); if (s) return s.underlying; } return 'NIFTY'; }
  function paritySpot(under){ const byK = {}; for (const sym in Store.ltpBySym){ const p = parseSymbol(sym), l = Store.ltpBySym[sym]; if (!p || p.type === 'SD' || !(l > 0)) continue; if (under && p.underlying !== under) continue; const o = byK[p.strike] = byK[p.strike] || { exp: p.expiry }; o[p.type] = l; } const rows = []; for (const k in byK){ const r = byK[k]; if (r.CE > 0 && r.PE > 0) rows.push({ k: +k, diff: Math.abs(r.CE - r.PE), cp: r.CE - r.PE, exp: r.exp }); } if (!rows.length) return 0; rows.sort((a, b) => a.diff - b.diff); const top = rows.slice(0, 3), rr = 0.065, now = Date.now(); let s = 0; top.forEach(x => { const T = Math.max((x.exp - now) / (365 * 864e5), 1e-5); s += x.k * Math.exp(-rr * T) + x.cp; }); return s / top.length; }
  const _idx = { under: null, valEl: null, last: 0 };
  function indexSpotDOM(under){ const numIn = el => { const m = (el && el.textContent || '').trim().match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,6}(?:\.\d+)?)/); if (!m) return 0; const v = parseFloat(m[1].replace(/,/g, '')); return (v > 1000 && v < 200000) ? v : 0; }; try { if (_idx.under === under && _idx.valEl && document.contains(_idx.valEl)){ const v = numIn(_idx.valEl); if (v) return v; } if (Date.now() - _idx.last < 1500) return 0; _idx.last = Date.now(); const wants = under === 'BANKNIFTY' ? ['BANKNIFTY','BANK NIFTY','NIFTY BANK'] : [under, 'SPOT']; const leaves = document.querySelectorAll('span,div,b,strong,td,th,p'); for (let i = 0; i < leaves.length; i++){ const el = leaves[i]; if (el.childElementCount !== 0) continue; const t = el.textContent.trim().toUpperCase().replace(':', ''); if (wants.indexOf(t) < 0) continue; const probes = [el.nextElementSibling, el.previousElementSibling].concat(el.parentElement ? Array.from(el.parentElement.children) : []); for (const c of probes){ if (!c || c === el) continue; const v = numIn(c); if (v){ _idx.under = under; _idx.valEl = c; return v; } } } } catch (e) {} return 0; }
  function recomputeSpot(){ try { const under = detectUnderlying(); const idx = Store.ltpBySym[IDX[under] || under]; if (idx > 0){ Store.spot = idx; return; } const par = paritySpot(under); if (par > 0){ Store.spot = par; return; } const dom = indexSpotDOM(under); if (dom > 0){ Store.spot = dom; return; } const m = (document.body ? document.body.innerText : '').match(/\b(\d{2},\d{3}(?:\.\d{1,2})?)\b/); if (m) Store.spot = parseFloat(m[1].replace(/,/g, '')); } catch (e) {} }
  // ── scrape open positions from the page table (CloudFront build streams positions via socket, not REST) ──
  const MON = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  const INSTR_RE = /(NIFTY BANK|BANKNIFTY|SENSEX|NIFTY)\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{4,6})\s*(CE|PE|SD)/i;
  function scrapePositions(){
    const rows = [...document.querySelectorAll('tr, mat-row, [role="row"]')], out = []; const yr = new Date().getFullYear();
    rows.forEach(tr => {
      const cells = [...tr.querySelectorAll('td, mat-cell, [role="cell"], th')]; if (cells.length < 4) return;
      let ii = -1, m = null; for (let i = 0; i < cells.length; i++){ const mm = cells[i].textContent.match(INSTR_RE); if (mm){ ii = i; m = mm; break; } }
      if (ii < 0) return;
      const dayM = cells[ii].textContent.match(/\b(\d{1,2})\s+[A-Za-z]{3}\b/); const day = dayM ? ('0' + dayM[1]).slice(-2) : '01';
      const nums = cells.slice(ii + 1).map(c => { const t = c.textContent.replace(/[₹,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; }).filter(v => v !== null);
      if (nums.length < 3) return;
      const qty = Math.round(nums[0]); if (!qty) return;
      const avg = nums[1], ltp = nums[2], pnl = nums[nums.length - 1];
      const und = m[1].toUpperCase().replace('NIFTY BANK', 'BANKNIFTY').replace(/\s+/g, ''), mo = MON[m[2].toUpperCase()], strike = +m[3], type = m[4].toUpperCase();
      const sym = und + (yr % 100) + mo + day + strike + type;
      out.push({ status: 'OPEN', symbol: sym, symbolId: null, optionType: type, strikePrice: strike, quantity: qty, avgSellPrice: qty < 0 ? avg : 0, avgBuyPrice: qty > 0 ? avg : 0, bepPrice: avg, ltp: ltp, _pnl: pnl, expiryDate: new Date(yr, +mo - 1, +day, 15, 30, 0).toISOString() });
    });
    // de-dupe by symbol (a straddle may appear twice)
    const seen = {}, uniq = []; out.forEach(p => { if (!seen[p.symbol]){ seen[p.symbol] = 1; uniq.push(p); } });
    if (uniq.length){ Store.positions = uniq; Store.lastUpdate = Date.now(); recomputeSpot(); }
    Store.dbg = 'pos ' + uniq.length + (Store.spot ? ' · spot ' + Math.round(Store.spot) : ' · spot ?') + (Store.auth ? ' · auth✓' : ' · auth✗');
    return uniq.length;
  }
  // self-fetch the new touchline for the index (spot) + position symbols (fresh ltp), using captured auth
  function selfTouch(){
    if (!Store.auth || !origFetch) return; const under = detectUnderlying(); const syms = [IDX[under] || under]; Store.positions.forEach(p => { if (p.symbol && syms.indexOf(p.symbol) < 0) syms.push(p.symbol); });
    origFetch(location.origin + '/api/data/touchline', { method: 'POST', headers: { authorization: Store.auth, 'content-type': 'application/json' }, body: JSON.stringify(syms), credentials: 'include' }).then(x => x.text()).then(t => ingest(location.origin + '/api/data/touchline', t)).catch(() => {});
  }

  // ══ INTERCEPTOR ═════════════════════════════════════════════════════════════
  const origFetch = window.fetch;
  const captureAuth = h => { if (!h) return; try { const g = k => (h.get ? h.get(k) : h[k] || h[k.toLowerCase()]); const a = g('authorization'); if (a) Store.auth = a; } catch (e) {} };
  if (origFetch) window.fetch = function (...a){ const url = (a[0] && a[0].url) || a[0], init = a[1] || {}; try { if (typeof url === 'string' && /\/api\//.test(url)) captureAuth(init.headers || (a[0] && a[0].headers)); } catch (e) {} const p = origFetch.apply(this, a); try { if (typeof url === 'string') p.then(r => r.clone().text().then(t => ingest(url, t)).catch(()=>{})).catch(()=>{}); } catch (e) {} return p; };
  const oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send, oH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u){ this.__s = { url: String(u) }; return oO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v){ if (/^authorization$/i.test(k) && v) Store.auth = v; return oH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body){ const d = this.__s; if (d) this.addEventListener('load', () => { try { ingest(d.url, this.responseText); } catch (e) {} }); return oS.apply(this, arguments); };
  function poll(){ try { scrapePositions(); selfTouch(); } catch (e) {} }

  // ══ SELECTORS + BS ══════════════════════════════════════════════════════════
  function liveLtp(p){ if (p.symbolId != null && Store.ltpById[p.symbolId] != null) return Store.ltpById[p.symbolId]; if (p.symbol && Store.ltpBySym[p.symbol] != null) return Store.ltpBySym[p.symbol]; return p.ltp || 0; }
  function posAvg(p){ if (p.bepPrice > 0) return p.bepPrice; if (p.quantity < 0) return p.avgSellPrice; if (p.quantity > 0) return p.avgBuyPrice; return p.avgSellPrice || p.avgBuyPrice || 0; }
  window.parseOpenPos = function (){ return Store.positions.filter(p => p.status === 'OPEN' && p.quantity !== 0).map(p => { const avg = posAvg(p); let ltp = liveLtp(p); if (p.optionType === 'SD'){ const b = p.symbol ? p.symbol.replace(/SD$/, '') : ''; const ce = Store.ltpBySym[b + 'CE'], pe = Store.ltpBySym[b + 'PE']; if (ce != null && pe != null) ltp = ce + pe; } let exp = p.expiryDate ? new Date(p.expiryDate) : (parseSymbol(p.symbol) || {}).expiry; if (exp instanceof Date && !isNaN(exp)) exp.setHours(15, 30, 0, 0); return { symbol: p.symbol, symbolId: p.symbolId, qty: p.quantity, avg, ltp, pnl: (ltp - avg) * p.quantity, strike: p.strikePrice || (parseSymbol(p.symbol) || {}).strike || 0, type: p.optionType, expiry: exp }; }); };
  function expandLegs(rows){ const out = []; rows.forEach(p => { if (p.type !== 'SD'){ out.push(p); return; } const ceSym = p.symbol.replace(/SD$/, 'CE'), peSym = p.symbol.replace(/SD$/, 'PE'); const cL = Store.ltpBySym[ceSym], pL = Store.ltpBySym[peSym]; const have = cL != null && pL != null && (cL + pL) > 0, c = have ? cL : p.ltp / 2, pp = have ? pL : p.ltp / 2, sum = c + pp || 1, cA = p.avg * c / sum; out.push(Object.assign({}, p, { type: 'CE', ltp: c, avg: cA, pnl: (c - cA) * p.qty })); out.push(Object.assign({}, p, { type: 'PE', ltp: pp, avg: p.avg - cA, pnl: (pp - (p.avg - cA)) * p.qty })); }); return out; }
  window._bsLegs = () => expandLegs(window.parseOpenPos());
  window.getSpot = () => Store.spot || 0;
  window.getOpenMTM = () => window.parseOpenPos().reduce((s, p) => s + p.pnl, 0);
  const allowedMargin = () => (Store.user && Store.user.marginAllowed) || (Store.margin && Store.margin.allowedMargin) || DEFAULT_ALLOWED_MARGIN;
  const marginUsed = () => (Store.margin && Store.margin.totalMarginUsed) || 0;
  window.BS = { norm(x){const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;const s=x<0?-1:1;x=Math.abs(x)/Math.sqrt(2);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return .5*(1+s*y);}, d1(S,K,T,r,v){return(Math.log(S/K)+(r+.5*v*v)*T)/(v*Math.sqrt(T));}, price(S,K,T,r,v,t){if(T<=0)return t==='CE'?Math.max(0,S-K):Math.max(0,K-S);const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T);return t==='CE'?S*this.norm(d1)-K*Math.exp(-r*T)*this.norm(d2):K*Math.exp(-r*T)*this.norm(-d2)-S*this.norm(-d1);}, iv(S,K,T,r,mkt,t){if(T<=0||mkt<=0)return 0;let v=.3;for(let i=0;i<100;i++){const p=this.price(S,K,T,r,v,t),d1=this.d1(S,K,T,r,v),vega=S*Math.sqrt(T)*Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),diff=p-mkt;if(Math.abs(diff)<.001)break;if(vega<1e-10)break;v-=diff/vega;if(v<.001)v=.001;if(v>5)v=5;}return v;}, greeks(S,K,T,r,v,t,qty){if(T<=0||v<=0)return{delta:0,gamma:0,theta:0,vega:0};const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T),nd1=Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),sg=qty<0?-1:1,aq=Math.abs(qty);const delta=t==='CE'?this.norm(d1):this.norm(d1)-1;const gamma=nd1/(S*v*Math.sqrt(T));const theta=t==='CE'?(-S*nd1*v/(2*Math.sqrt(T))-r*K*Math.exp(-r*T)*this.norm(d2))/365:(-S*nd1*v/(2*Math.sqrt(T))+r*K*Math.exp(-r*T)*this.norm(-d2))/365;const vega=S*nd1*Math.sqrt(T)/100;return{delta:sg*delta*aq,gamma:sg*gamma*aq,theta:sg*theta*aq,vega:sg*vega*aq};} };
  window._getPosCtx = function (pos, spot){ const now = new Date(); let dte = 7; if (pos.length && pos[0].expiry instanceof Date && !isNaN(pos[0].expiry)) dte = Math.max(0.001, (pos[0].expiry - now) / 864e5); const T = Math.max(dte / 365, 0.0001), r = 0.065; const legIVs = pos.map(p => window.BS.iv(spot, p.strike, T, r, p.ltp || p.avg, p.type) || 0.15); return { T, r, dte, legIVs }; };
  window._bsPnl = function (pos, s2, T, r, legIVs, ivD){ ivD = ivD || 0; return pos.reduce((s, p, j) => { const iv = Math.max(0.01, (legIVs[j] || 0.15) + ivD); return s + (p.avg - window.BS.price(s2, p.strike, T, r, iv, p.type)) * Math.abs(p.qty); }, 0); };
  window._netGreeks = function (pos, spot){ const ctx = window._getPosCtx(pos, spot); let nD=0,nG=0,nT=0,nV=0; pos.forEach((p,j)=>{ const g=window.BS.greeks(spot,p.strike,ctx.T,ctx.r,ctx.legIVs[j]||0.15,p.type,p.qty); nD+=g.delta;nG+=g.gamma;nT+=g.theta;nV+=g.vega; }); return Object.assign({ nD, nG, nT, nV }, ctx); };
  window._breakevens = function (legs){ legs = legs || window._bsLegs(); const spot = window.getSpot(); if (!legs.length || !spot) return null; const ks = legs.map(l => l.strike), lo = Math.min(...ks, spot) * 0.9, hi = Math.max(...ks, spot) * 1.1, N = 800; const E = s => legs.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s); return a + (it - l.avg) * l.qty; }, 0); const cr = []; let prev = E(lo), ps = lo; for (let i = 1; i <= N; i++){ const s = lo + (i / N) * (hi - lo), v = E(s); if ((prev >= 0) !== (v >= 0)) cr.push(ps + (-prev / (v - prev)) * (s - ps)); prev = v; ps = s; } return cr.length ? { lower: Math.min(...cr), upper: Math.max(...cr) } : null; };

  const money = v => (v >= 0 ? '+' : '−') + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const moneyK = v => (v >= 0 ? '+' : '−') + '₹' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'K' : Math.round(Math.abs(v)));
  const col = v => v >= 0 ? C.up : C.dn;

  // ══ SHADOW PANEL ════════════════════════════════════════════════════════════
  let SR = null; const $ = s => SR ? SR.querySelector(s) : null, $id = i => $('#' + i);
  function fitCanvas(id){ const cv = $id(id); if (!cv) return null; const w = Math.round(cv.getBoundingClientRect().width) || 420; cv.width = Math.max(w, 260); return cv; }
  function buildPanel(){
    if (document.getElementById('spay-host')) return;
    const host = document.createElement('div'); host.id = 'spay-host'; host.style.cssText = 'all:initial;';
    SR = host.attachShadow({ mode: 'open' }); window._SPR = SR;
    const st = document.createElement('style'); st.textContent = `
      :host{all:initial;} *{box-sizing:border-box;margin:0;padding:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;}
      /* embedded in the page flow (below the positions tables) when an anchor is found; else fixed fallback */
      :host(.embed){display:block;width:100%;}
      #spay{position:fixed;top:120px;left:430px;z-index:2147483646;width:500px;background:${C.panel};border:1px solid ${C.line};border-radius:16px;overflow:hidden;color:${C.text};box-shadow:0 24px 60px -24px rgba(0,0,0,.75);}
      :host(.embed) #spay{position:static;width:100%;max-width:620px;margin:14px 0;box-shadow:0 10px 30px -18px rgba(0,0,0,.55);}
      .dbg{font-family:${MONO};font-size:9px;color:${C.muted};margin-left:auto;}
      .top{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid ${C.line};user-select:none;}
      .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:12.5px;}
      .mk{width:20px;height:20px;border-radius:6px;background:linear-gradient(135deg,${C.accent},${C.accent2});display:grid;place-items:center;color:#04140d;font-weight:800;font-size:11px;}
      .live{display:flex;align-items:center;gap:6px;font-size:11px;color:${C.muted};}
      .live .d{width:7px;height:7px;border-radius:50%;background:${C.dn};transition:.3s;}
      .live.on .d{background:${C.accent};box-shadow:0 0 0 3px rgba(52,211,153,.18);}.live.on{color:${C.accent};}
      .ic{background:transparent;border:none;color:${C.muted};font-size:15px;cursor:pointer;padding:0 3px;}.ic:hover{color:${C.text};}
      .sub{display:flex;gap:12px;padding:9px 14px 4px;font-size:12px;color:${C.sub};}.sub b{color:${C.text};}
      .wrap{padding:6px 12px 12px;}
      canvas{display:block;width:100%;background:transparent;border-radius:10px;}
      .grk{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:10px;}
      .grk>div{background:${C.card};border-radius:10px;padding:8px 5px;text-align:center;}
      .gl{font-size:10px;color:${C.muted};}.gv{font-size:15px;font-weight:700;margin-top:2px;}
      .risk{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;}
      .rc{background:${C.card};border-radius:10px;padding:8px 10px;}
      .rl{font-size:10px;color:${C.muted};}.rv{font-size:14px;font-weight:700;margin-top:2px;}.rs{font-size:9.5px;color:${C.muted};margin-top:1px;}
      .empty{color:${C.muted};font-size:12px;text-align:center;padding:26px 0;}
      .gv,.rv,#spay-mtm,#spay-spot,#spay-dte{font-family:${MONO};}
      .brand{letter-spacing:.02em;}
    `;
    SR.appendChild(st);
    const panel = document.createElement('div'); panel.id = 'spay';
    panel.innerHTML = `
      <div class="top" id="spay-top"><div class="brand"><span class="mk">S</span> Payoff &amp; Risk</div>
        <div style="display:flex;align-items:center;gap:10px;"><span class="live" id="spay-live"><span class="d"></span><span id="spay-lt">connecting</span></span><button class="ic" id="spay-min">—</button><button class="ic" id="spay-close">✕</button></div></div>
      <div class="sub"><span id="spay-spot">NIFTY —</span><span id="spay-dte"></span><span>MTM <b id="spay-mtm">—</b></span><span class="dbg" id="spay-dbg"></span></div>
      <div class="wrap"><canvas id="spay-cv" height="230"></canvas>
        <div class="grk"><div><div class="gl">Δ Delta</div><div class="gv" id="g-d">—</div></div><div><div class="gl">Γ Gamma</div><div class="gv" id="g-g">—</div></div><div><div class="gl">Θ /hr</div><div class="gv" id="g-t">—</div></div><div><div class="gl">Vega</div><div class="gv" id="g-v">—</div></div></div>
        <div class="risk"><div class="rc"><div class="rl">Max loss (±3%)</div><div class="rv" id="r-ml" style="color:${C.dn}">—</div><div class="rs">worst in stress range</div></div>
          <div class="rc"><div class="rl">Breakevens</div><div class="rv" id="r-be">—</div><div class="rs" id="r-bes">safe zone</div></div>
          <div class="rc"><div class="rl">Margin used</div><div class="rv" id="r-mg">—</div><div class="rs" id="r-mgs"></div></div>
          <div class="rc"><div class="rl">Decay left</div><div class="rv" id="r-dl" style="color:${C.up}">—</div><div class="rs">θ if pinned here</div></div></div>
      </div>`;
    SR.appendChild(panel);
    // embed into the page's own layout (below the positions tables) so it reads like a native section; else fixed fallback
    const anchor = findAnchor();
    if (anchor && anchor.parentElement){ host.classList.add('embed'); anchor.parentElement.insertBefore(host, anchor.nextSibling); }
    else (document.body || document.documentElement).appendChild(host);
    let mini = false; $id('spay-min').onclick = () => { mini = !mini; $id('spay-cv').parentElement.style.display = mini ? 'none' : ''; };
    $id('spay-close').onclick = () => { host.remove(); SR = null; };
  }
  // find the container that holds the positions tables, to insert our panel right after it
  function findAnchor(){
    try {
      let el = [...document.querySelectorAll('div,section,mat-card')].find(e => /Closed Positions/i.test(e.textContent) && e.textContent.length < 1200 && e.childElementCount >= 1);
      if (!el) el = [...document.querySelectorAll('div,section')].find(e => /Total MTM/i.test(e.textContent) && e.textContent.length < 1500);
      if (!el) return null;
      let a = el; for (let i = 0; i < 3 && a.parentElement && a.parentElement.tagName !== 'BODY'; i++) a = a.parentElement;
      return a;
    } catch (e) { return null; }
  }

  // ══ PAYOFF CHART ════════════════════════════════════════════════════════════
  function smooth(ctx, p){ for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); }
  window.drawPayoff = function (){
    const cv = fitCanvas('spay-cv'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const pos = window._bsLegs(), spot = window.getSpot();
    if (!pos.length || !spot){ ctx.fillStyle = C.muted; ctx.font = '12px ' + MONO; ctx.textAlign = 'center'; ctx.fillText('no open positions', W / 2, H / 2); return; }
    const { T, r, dte, legIVs } = window._getPosCtx(pos, spot);
    const ks = pos.map(p => p.strike), pad = Math.max(spot * 0.03, 500), lo = Math.min(...ks, spot) - pad, hi = Math.max(...ks, spot) + pad, N = 220, pN = [];
    for (let i = 0; i <= N; i++){ const s = lo + (i / N) * (hi - lo); pN.push({ s, p: window._bsPnl(pos, s, T, r, legIVs, 0) }); }
    const mx = Math.max(...pN.map(p => p.p)), mn = Math.min(...pN.map(p => p.p)), sp = (mx - mn) || 1000, yMin = mn - sp * 0.12, yMax = mx + sp * 0.12;
    const L = 50, R = 12, Tp = 12, B = 24, CW = W - L - R, CH = H - Tp - B, X = s => L + ((s - lo) / (hi - lo)) * CW, Y = v => Tp + CH - ((v - yMin) / (yMax - yMin)) * CH;
    ctx.font = '9px ' + MONO;
    for (let i = 0; i <= 5; i++){ const v = yMin + (i / 5) * (yMax - yMin), y = Y(v); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L - 5, y + 3); }
    for (let i = 0; i <= 5; i++){ const s = lo + (i / 5) * (hi - lo), x = X(s); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + CH); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(Math.round(s).toLocaleString('en-IN'), x, H - 7); }
    const z = Y(0); ctx.strokeStyle = C.line2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(L, z); ctx.lineTo(W - R, z); ctx.stroke(); ctx.setLineDash([]);
    const be = window._breakevens(pos);
    if (be){ [be.lower, be.upper].forEach(v => { if (v < lo || v > hi) return; const bx = X(v); ctx.strokeStyle = 'rgba(251,191,36,.4)'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(bx, Tp); ctx.lineTo(bx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.warn; ctx.textAlign = 'center'; ctx.fillText(Math.round(v), bx, Tp + 10); }); }
    const sx = X(spot); ctx.strokeStyle = 'rgba(74,222,128,.45)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(sx, Tp); ctx.lineTo(sx, Tp + CH); ctx.stroke(); ctx.setLineDash([]);
    // ── node-dot payoff: green above 0, red below (the "TradingAlgo" vibe) ──
    const stepN = Math.max(1, Math.round(N / 54)); let prev = null;
    for (let i = 0; i <= N; i += stepN){ const p = pN[i], x = X(p.s), y = Y(p.p), c = p.p >= 0 ? C.up : C.dn; if (prev){ ctx.strokeStyle = prev.c; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke(); } prev = { x, y, c }; }
    for (let i = 0; i <= N; i += stepN){ const p = pN[i]; ctx.beginPath(); ctx.arc(X(p.s), Y(p.p), 2.5, 0, 7); ctx.fillStyle = p.p >= 0 ? C.up : C.dn; ctx.fill(); }
    const at = pN.reduce((b, p) => Math.abs(p.s - spot) < Math.abs(b.s - spot) ? p : b);
    ctx.beginPath(); ctx.arc(X(at.s), Y(at.p), 4.2, 0, 7); ctx.fillStyle = at.p >= 0 ? C.up : C.dn; ctx.fill(); ctx.strokeStyle = C.bg; ctx.lineWidth = 1.5; ctx.stroke();
    const ds = dte >= 1 ? dte.toFixed(1) + 'd' : (dte * 24).toFixed(1) + 'h'; ctx.fillStyle = C.muted; ctx.font = '9px ' + MONO; ctx.textAlign = 'left'; ctx.fillText('DTE ' + ds, L + 2, Tp + 10);
    // hover crosshair
    if (cv._cur != null){ const sX = lo + ((cv._cur - L) / CW) * (hi - lo); const nb = pN.reduce((b, p) => Math.abs(p.s - sX) < Math.abs(b.s - sX) ? p : b, pN[0]); const cx = X(nb.s); ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(cx, Tp); ctx.lineTo(cx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(cx, Y(nb.p), 3, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); const lbl = Math.round(nb.s).toLocaleString('en-IN') + '  ' + money(nb.p); ctx.font = '10px ' + MONO; const tw = ctx.measureText(lbl).width + 14; let tx = cx + 8; if (tx + tw > W - 2) tx = cx - tw - 8; tx = Math.max(2, tx); ctx.fillStyle = 'rgba(5,6,7,.96)'; ctx.fillRect(tx, Tp + 2, tw, 18); ctx.strokeStyle = C.line2; ctx.strokeRect(tx, Tp + 2, tw, 18); ctx.fillStyle = nb.p >= 0 ? C.up : C.dn; ctx.textAlign = 'left'; ctx.fillText(lbl, tx + 7, Tp + 15); }
  };

  // ══ REFRESH ═════════════════════════════════════════════════════════════════
  window.refreshAll = function (){
    if (!SR || !$id('spay')) return;
    const set = (id, v, c) => { const e = $id(id); if (!e) return; e.textContent = v; if (c) e.style.color = c; };
    const pos = window._bsLegs(), spot = window.getSpot(), mtm = window.getOpenMTM();
    set('spay-spot', (detectUnderlying() || 'NIFTY') + ' ' + (spot ? spot.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'));
    set('spay-mtm', pos.length ? money(mtm) : '—', col(mtm));
    if (pos.length && spot){ const { T, r, dte, legIVs } = window._getPosCtx(pos, spot); set('spay-dte', dte < 1 ? (dte * 24).toFixed(1) + 'h to expiry' : dte.toFixed(1) + 'd to expiry');
      const G = window._netGreeks(pos, spot); set('g-d', G.nD.toFixed(1), col(G.nD)); set('g-g', G.nG.toFixed(3), C.dn); set('g-t', '₹' + Math.abs(G.nT / 6.25).toFixed(0), C.up); set('g-v', G.nV.toFixed(0), C.dn);
      const stress = [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03].map(s => window._bsPnl(pos, spot * (1 + s), T, r, legIVs, 0)); set('r-ml', money(Math.min(0, ...stress)), C.dn);
      const be = window._breakevens(pos); if (be){ const inside = spot >= be.lower && spot <= be.upper, near = Math.min(Math.abs(be.upper - spot), Math.abs(spot - be.lower)); set('r-be', Math.round(be.lower).toLocaleString('en-IN') + '–' + Math.round(be.upper).toLocaleString('en-IN')); set('r-bes', inside ? near.toFixed(0) + ' pt to edge' : 'OUTSIDE', inside ? C.muted : C.dn); } else { set('r-be', '—'); set('r-bes', ''); }
      const decay = pos.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot); return a + (l.ltp - it) * (-l.qty); }, 0); set('r-dl', money(decay), decay >= 0 ? C.up : C.dn);
    } else { ['g-d','g-g','g-t','g-v','r-ml','r-be','r-dl'].forEach(id => set(id, '—', C.muted)); set('spay-dte', ''); }
    const allowed = allowedMargin(), used = marginUsed(), pctm = Math.min(100, allowed ? used / allowed * 100 : 0);
    set('r-mg', pctm.toFixed(0) + '%', pctm > 80 ? C.dn : pctm > 60 ? C.warn : C.up); set('r-mgs', '₹' + Math.round(used / 1000) + 'K / ₹' + Math.round(allowed / 1000) + 'K');
    const lv = $id('spay-live'); if (lv){ const on = Date.now() - Store.lastUpdate < 8000; lv.classList.toggle('on', on); set('spay-lt', on ? 'live' : (Store.lastUpdate ? 'stale' : 'connecting')); }
    set('spay-dbg', Store.dbg || '');
    window.drawPayoff();
  };

  // ══ BOOT + WATCHDOG ═════════════════════════════════════════════════════════
  function boot(){
    buildPanel(); Store.onUpdate(() => { try { window.refreshAll(); } catch (e) {} });
    setInterval(() => { try { poll(); } catch (e) {} }, POLL_MS);
    setInterval(() => { try { window.refreshAll(); } catch (e) {} }, UI_REFRESH_MS);
    setInterval(() => { try {
      const host = document.getElementById('spay-host');
      if (!host){ SR = null; buildPanel(); window.refreshAll(); return; }
      // relocate into the content area once the Positions tab (its anchor) is present
      if (!host.classList.contains('embed')){ const a = findAnchor(); if (a && a.parentElement){ host.classList.add('embed'); a.parentElement.insertBefore(host, a.nextSibling); } }
    } catch (e) {} }, WATCHDOG_MS);
    setTimeout(() => { const cv = $id('spay-cv'); if (cv && !cv.__h){ cv.__h = 1; cv.style.cursor = 'crosshair'; cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); cv._cur = (e.clientX - r.left) * (cv.width / r.width); try { window.drawPayoff(); } catch (_) {} }); cv.addEventListener('mouseleave', () => { cv._cur = null; try { window.drawPayoff(); } catch (_) {} }); } poll(); window.refreshAll(); }, 700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
