// ==UserScript==
// @name         Straddly Payoff & Risk (mini)
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Minimal overlay for the Straddly CloudFront trade page — payoff + greeks + risk. Pops out into its own window for a second monitor. Reads positions from the page + self-fetches touchline for spot.
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
  const POLL_MS = 2000, UI_REFRESH_MS = 700, WATCHDOG_MS = 2500, SYNC_MS = 60, DEFAULT_ALLOWED_MARGIN = 114113.08;
  // "TradingAlgo" vibe — near-black, bright terminal green, orange-red, mono numbers
  const C = { bg:'#050607', panel:'#0a0b0d', card:'#101216', line:'#191c21', line2:'#24282e', text:'#e9edf0', muted:'#697079', sub:'#9aa3af', accent:'#4ade80', accent2:'#22c55e', up:'#4ade80', dn:'#ff5a52', warn:'#fbbf24', ce:'#38bdf8', pe:'#ff5a52', sd:'#a78bfa' };
  const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

  // ══ STORE ═══════════════════════════════════════════════════════════════════
  const Store = { positions: [], ltpById: {}, ltpBySym: {}, chain: {}, margin: null, user: null, spot: 0, spots: {}, book: '', hist: {}, histDay: '', realised: {}, prevLegs: {}, posVisible: false, lastUpdate: 0, auth: '', dbg: '', _l: [], onUpdate(f){ this._l.push(f); }, _emit(){ this.lastUpdate = Date.now(); this._l.forEach(f => { try { f(); } catch (e) {} }); } };
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
  // ── multi-book: a screen can hold NIFTY + BANKNIFTY + SENSEX at once. Each needs its OWN spot and its OWN payoff. ──
  function underlyings(){ const u = []; Store.positions.forEach(p => { const x = parseSymbol(p.symbol); if (x && u.indexOf(x.underlying) < 0) u.push(x.underlying); }); return u; }
  function activeBook(){ const u = underlyings(); if (!u.length) return 'NIFTY'; if (Store.book && u.indexOf(Store.book) >= 0) return Store.book; const cnt = {}; Store.positions.forEach(p => { const x = parseSymbol(p.symbol); if (x) cnt[x.underlying] = (cnt[x.underlying] || 0) + 1; }); return u.slice().sort((a, b) => cnt[b] - cnt[a])[0]; }
  function spotFor(under){ const idx = Store.ltpBySym[IDX[under] || under]; if (idx > 0) return idx; const par = paritySpot(under); if (par > 0) return par; const dom = indexSpotDOM(under); if (dom > 0) return dom; return 0; }
  function recomputeSpot(){ try { underlyings().forEach(u => { const v = spotFor(u); if (v > 0) Store.spots[u] = v; }); const b = activeBook(); const v = Store.spots[b] || spotFor(b); if (v > 0){ Store.spots[b] = v; Store.spot = v; } } catch (e) {} }
  // ── scrape open positions from the page table (CloudFront build streams positions via socket, not REST) ──
  const MON = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  const INSTR_RE = /(NIFTY BANK|BANKNIFTY|SENSEX|NIFTY)\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{4,6})\s*(CE|PE|SD)/i;
  // MutationObserver beats polling on two counts: it fires the moment the portal writes a new LTP/P&L,
  // and it keeps firing when the portal tab is in the BACKGROUND (timers there get throttled to ~1s by Chrome).
  const OBS = { tables: [], mo: null, last: 0, dirty: false, hits: 0, syncs: 0 }; window.__SPAY_OBS = OBS;
  function syncNow(){ OBS.syncs++; OBS.last = Date.now(); OBS.dirty = false; try { scrapePositions(); window.refreshAll(); } catch (e) {} }
  function onPortalMutate(){
    OBS.hits++;
    const gap = Date.now() - OBS.last;
    if (gap >= SYNC_MS){ syncNow(); return; }          // run inline — never wait on a throttled timer
    if (OBS.dirty) return; OBS.dirty = true;
    const w = (POP && !POP.closed) ? POP : window;      // a visible pop-out isn't throttled; the hidden opener is
    w.setTimeout(() => { if (OBS.dirty) syncNow(); }, SYNC_MS - gap);
  }
  function watchTables(tables){
    if (!tables.length) return;
    const same = tables.length === OBS.tables.length && tables.every((t, i) => OBS.tables[i] === t && document.contains(t));
    if (same) return;
    if (OBS.mo) OBS.mo.disconnect();
    OBS.mo = new MutationObserver(onPortalMutate);
    tables.forEach(t => { try { OBS.mo.observe(t, { subtree: true, childList: true, characterData: true }); } catch (e) {} });
    OBS.tables = tables.slice();
  }
  function scrapePositions(full){
    const live = OBS.tables.length && OBS.tables.every(t => document.contains(t));
    const scope = (!full && live) ? OBS.tables : [document];   // scoped re-reads are cheap enough to run per tick
    const rows = []; scope.forEach(sc => { rows.push(...sc.querySelectorAll('tr, mat-row, [role="row"]')); });
    const out = [], rects = [], tables = []; const yr = new Date().getFullYear();
    rows.forEach(tr => {
      const cells = [...tr.querySelectorAll('td, mat-cell, [role="cell"], th')]; if (cells.length < 4) return;
      let ii = -1, m = null; for (let i = 0; i < cells.length; i++){ const mm = cells[i].textContent.match(INSTR_RE); if (mm){ ii = i; m = mm; break; } }
      if (ii < 0) return;
      const rr = tr.getBoundingClientRect(); if (rr.width > 100 && rr.height > 4) rects.push(rr);
      const tbl = (tr.closest && tr.closest('table, mat-table, [role="table"]')) || tr.parentElement; if (tbl && tables.indexOf(tbl) < 0) tables.push(tbl);
      const dayM = cells[ii].textContent.match(/\b(\d{1,2})\s+[A-Za-z]{3}\b/); const day = dayM ? ('0' + dayM[1]).slice(-2) : '01';
      const nums = cells.slice(ii + 1).map(c => { const t = c.textContent.replace(/[₹,\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; }).filter(v => v !== null);
      if (nums.length < 3) return;
      const qty = Math.round(nums[0]); if (!qty) return;
      const avg = nums[1], ltp = nums[2], pnl = nums[nums.length - 1];
      const und = m[1].toUpperCase().replace('NIFTY BANK', 'BANKNIFTY').replace(/\s+/g, ''), mo = MON[m[2].toUpperCase()], strike = +m[3], type = m[4].toUpperCase();
      const sym = und + (yr % 100) + mo + day + strike + type;
      out.push({ status: 'OPEN', symbol: sym, symbolId: null, optionType: type, strikePrice: strike, quantity: qty, avgSellPrice: qty < 0 ? avg : 0, avgBuyPrice: qty > 0 ? avg : 0, bepPrice: avg, ltp: ltp, _pnl: pnl, _scraped: true, expiryDate: new Date(yr, +mo - 1, +day, 15, 30, 0).toISOString() });
    });
    // de-dupe by symbol (a straddle may appear twice)
    const seen = {}, uniq = []; out.forEach(p => { if (!seen[p.symbol]){ seen[p.symbol] = 1; uniq.push(p); } });
    const onPosView = /Total MTM|Open Positions/i.test(document.body ? document.body.innerText : '');
    if (rects.length){ // anchor below the WHOLE positions block (open + closed tables) so we never cover it
      const sx = window.scrollX || window.pageXOffset || 0, sy = window.scrollY || window.pageYOffset || 0;
      const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
      let bottom = Math.max(...rects.map(r => r.bottom));
      try { for (let pass = 0; pass < 2; pass++) document.querySelectorAll('table, mat-table, [role="table"]').forEach(t => {
        const r = t.getBoundingClientRect();
        if (r.width > 200 && r.right > left - 60 && r.left < right + 60 && r.bottom > bottom && r.top < bottom + 900) bottom = r.bottom;
      }); } catch (e) {}
      Store.anchor = { left: left + sx, top: bottom + sy, width: right - left, at: Date.now() };
    }
    Store.posVisible = uniq.length > 0;
    if (uniq.length){ Store.positions = uniq; Store.lastUpdate = Date.now(); recomputeSpot(); }
    else if (onPosView){ Store.positions = []; } // on the positions view with none open → genuinely flat
    // never diff while the table is simply absent (Orders/Baskets) — that would bank every leg as "exited"
    if (Store.posVisible || onPosView) reconcileRealised();
    // else: on another tab → keep last known positions (don't blank)
    watchTables(tables);
    Store.lastScrape = Date.now();
    const qn = Store.positions.filter(p => Store.ltpBySym[p.symbol] > 0).length;
    Store.dbg = 'pos ' + Store.positions.length + (Store.posVisible ? '' : ' · q' + qn + '/' + Store.positions.length) + (Store.spot ? ' · spot ' + Math.round(Store.spot) : ' · spot ?') + (Store.auth ? ' · auth✓' : ' · auth✗');
    return Store.positions.length;
  }
  // When a leg is exited its open P&L vanishes from the book — bank it, so the day curve stays continuous
  // instead of dropping a step. Only ever runs on a genuine Positions-tab read (see posVisible).
  function reconcileRealised(){
    const cur = {};
    window.parseOpenPos().forEach(p => { (cur[p.under] = cur[p.under] || {})[p.symbol] = { qty: p.qty, pnl: p.pnl }; });
    const books = {}; Object.keys(Store.prevLegs).forEach(b => { books[b] = 1; }); Object.keys(cur).forEach(b => { books[b] = 1; });
    Object.keys(books).forEach(b => {
      const prev = Store.prevLegs[b] || {}, now = cur[b] || {};
      Object.keys(prev).forEach(sym => {
        const o = prev[sym], nw = now[sym];
        if (!nw){ Store.realised[b] = (Store.realised[b] || 0) + o.pnl; return; }            // fully exited
        const shut = Math.abs(o.qty) - Math.abs(nw.qty);
        if (shut > 0 && Math.abs(o.qty) > 0) Store.realised[b] = (Store.realised[b] || 0) + o.pnl * (shut / Math.abs(o.qty)); // partial
      });
    });
    Store.prevLegs = cur;
  }
  // self-fetch the new touchline for the index (spot) + position symbols (fresh ltp), using captured auth
  function selfTouch(){
    if (!Store.auth || !origFetch) return; const us = underlyings(); if (!us.length) us.push('NIFTY'); const syms = us.map(u => IDX[u] || u); Store.positions.forEach(p => { if (p.symbol && syms.indexOf(p.symbol) < 0) syms.push(p.symbol); });
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
  function poll(){ try { scrapePositions(true); selfTouch(); } catch (e) {} } // full re-scan + fresh spot; the observer covers everything between

  // ══ MTM / DELTA HISTORY ═════════════════════════════════════════════════════
  // Can't be reconstructed after the fact, so we sample as we go and keep the day in localStorage.
  const HIST_KEY = 'spay_hist_v2', HIST_MS = 3000, HIST_SAVE_MS = 15000, HIST_MAX = 8000;
  function dayKey(){ const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function histLoad(){
    try { const raw = localStorage.getItem(HIST_KEY); if (!raw) return; const j = JSON.parse(raw);
      if (j && j.day === dayKey() && j.h){ Store.hist = j.h; Store.histDay = j.day; Store.realised = j.r || {}; }
      else localStorage.removeItem(HIST_KEY); // new session day → start clean
    } catch (e) {}
  }
  let _lastSave = 0;
  function histSave(force){
    if (!force && Date.now() - _lastSave < HIST_SAVE_MS) return; _lastSave = Date.now();
    try { localStorage.setItem(HIST_KEY, JSON.stringify({ day: Store.histDay || dayKey(), h: Store.hist, r: Store.realised })); } catch (e) {}
  }
  function histPush(book, mtm, delta){
    if (!book || !isFinite(mtm) || !isFinite(delta)) return;
    const day = dayKey(); if (Store.histDay !== day){ Store.hist = {}; Store.histDay = day; Store.realised = {}; Store.prevLegs = {}; }
    const a = Store.hist[book] || (Store.hist[book] = []), now = Date.now();
    const last = a[a.length - 1]; if (last && now - last[0] * 1000 < HIST_MS) return;
    a.push([Math.round(now / 1000), Math.round(mtm), +delta.toFixed(1), Math.round(Store.realised[book] || 0)]);
    if (a.length > HIST_MAX) a.splice(0, a.length - HIST_MAX);
    histSave(false);
  }
  const hhmm = t => { const d = new Date(t * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };

  // ══ SELECTORS + BS ══════════════════════════════════════════════════════════
  // On the Positions tab, mirror the portal's own LTP column exactly. On Orders/Baskets that table is GONE and its
  // last values are frozen — so prefer the quote from our own touchline poll, which keeps running regardless of tab.
  function liveLtp(p){
    if (Store.posVisible && p._scraped && p.ltp > 0) return p.ltp;
    if (p.symbol && Store.ltpBySym[p.symbol] > 0) return Store.ltpBySym[p.symbol];
    if (p.symbolId != null && Store.ltpById[p.symbolId] != null) return Store.ltpById[p.symbolId];
    return p.ltp || 0;
  }
  function posAvg(p){ if (p.bepPrice > 0) return p.bepPrice; if (p.quantity < 0) return p.avgSellPrice; if (p.quantity > 0) return p.avgBuyPrice; return p.avgSellPrice || p.avgBuyPrice || 0; }
  window.parseOpenPos = function (){ return Store.positions.filter(p => p.status === 'OPEN' && p.quantity !== 0).map(p => { const avg = posAvg(p); let ltp = liveLtp(p); if (p.optionType === 'SD'){ const b = p.symbol ? p.symbol.replace(/SD$/, '') : ''; const ce = Store.ltpBySym[b + 'CE'], pe = Store.ltpBySym[b + 'PE']; if (ce != null && pe != null) ltp = ce + pe; } let exp = p.expiryDate ? new Date(p.expiryDate) : (parseSymbol(p.symbol) || {}).expiry; if (exp instanceof Date && !isNaN(exp)) exp.setHours(15, 30, 0, 0); const _s = parseSymbol(p.symbol); return { under: (_s && _s.underlying) || 'NIFTY', symbol: p.symbol, symbolId: p.symbolId, qty: p.quantity, avg, ltp, pnl: (ltp - avg) * p.quantity, strike: p.strikePrice || (parseSymbol(p.symbol) || {}).strike || 0, type: p.optionType, expiry: exp }; }); };
  function expandLegs(rows){ const out = []; rows.forEach(p => { if (p.type !== 'SD'){ out.push(p); return; } const ceSym = p.symbol.replace(/SD$/, 'CE'), peSym = p.symbol.replace(/SD$/, 'PE'); const cL = Store.ltpBySym[ceSym], pL = Store.ltpBySym[peSym]; const have = cL != null && pL != null && (cL + pL) > 0, c = have ? cL : p.ltp / 2, pp = have ? pL : p.ltp / 2, sum = c + pp || 1, cA = p.avg * c / sum; out.push(Object.assign({}, p, { type: 'CE', ltp: c, avg: cA, pnl: (c - cA) * p.qty })); out.push(Object.assign({}, p, { type: 'PE', ltp: pp, avg: p.avg - cA, pnl: (pp - (p.avg - cA)) * p.qty })); }); return out; }
  window._allLegs = () => expandLegs(window.parseOpenPos());
  window._bsLegs = () => { const b = activeBook(); return window._allLegs().filter(l => l.under === b); };
  window.getSpot = () => { const b = activeBook(); return Store.spots[b] || spotFor(b) || 0; }; // NEVER fall back to another book's spot
  window.getOpenMTM = () => window.parseOpenPos().reduce((s, p) => s + p.pnl, 0);
  window._bookMTM = () => window._bsLegs().reduce((s, p) => s + p.pnl, 0);
  const allowedMargin = () => (Store.user && Store.user.marginAllowed) || (Store.margin && Store.margin.allowedMargin) || DEFAULT_ALLOWED_MARGIN;
  const marginUsed = () => (Store.margin && Store.margin.totalMarginUsed) || 0;
  window.BS = { norm(x){const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;const s=x<0?-1:1;x=Math.abs(x)/Math.sqrt(2);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return .5*(1+s*y);}, d1(S,K,T,r,v){return(Math.log(S/K)+(r+.5*v*v)*T)/(v*Math.sqrt(T));}, price(S,K,T,r,v,t){if(T<=0)return t==='CE'?Math.max(0,S-K):Math.max(0,K-S);const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T);return t==='CE'?S*this.norm(d1)-K*Math.exp(-r*T)*this.norm(d2):K*Math.exp(-r*T)*this.norm(-d2)-S*this.norm(-d1);}, iv(S,K,T,r,mkt,t){if(T<=0||mkt<=0)return 0;let v=.3;for(let i=0;i<100;i++){const p=this.price(S,K,T,r,v,t),d1=this.d1(S,K,T,r,v),vega=S*Math.sqrt(T)*Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),diff=p-mkt;if(Math.abs(diff)<.001)break;if(vega<1e-10)break;v-=diff/vega;if(v<.001)v=.001;if(v>5)v=5;}return v;}, greeks(S,K,T,r,v,t,qty){if(T<=0||v<=0)return{delta:0,gamma:0,theta:0,vega:0};const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T),nd1=Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),sg=qty<0?-1:1,aq=Math.abs(qty);const delta=t==='CE'?this.norm(d1):this.norm(d1)-1;const gamma=nd1/(S*v*Math.sqrt(T));const theta=t==='CE'?(-S*nd1*v/(2*Math.sqrt(T))-r*K*Math.exp(-r*T)*this.norm(d2))/365:(-S*nd1*v/(2*Math.sqrt(T))+r*K*Math.exp(-r*T)*this.norm(-d2))/365;const vega=S*nd1*Math.sqrt(T)/100;return{delta:sg*delta*aq,gamma:sg*gamma*aq,theta:sg*theta*aq,vega:sg*vega*aq};} };
  window._getPosCtx = function (pos, spot){ const now = new Date();
    const legT = pos.map(p => { let d = 7; if (p.expiry instanceof Date && !isNaN(p.expiry)) d = Math.max(0.001, (p.expiry - now) / 864e5); return Math.max(d / 365, 0.0001); });
    const dte = legT.length ? Math.min(...legT) * 365 : 7, T = Math.max(dte / 365, 0.0001), r = 0.065;
    const legIVs = pos.map((p, j) => window.BS.iv(spot, p.strike, legT[j], r, p.ltp || p.avg, p.type) || 0.15);
    return { T, r, dte, legIVs, legT }; };
  window._bsPnl = function (pos, s2, K, ivD){ ivD = ivD || 0; const legT = K.legT || pos.map(() => K.T);
    return pos.reduce((a, p, j) => { const iv = Math.max(0.01, (K.legIVs[j] || 0.15) + ivD); return a + (window.BS.price(s2, p.strike, legT[j], K.r, iv, p.type) - p.avg) * p.qty; }, 0); };
  window._netGreeks = function (pos, spot){ const K = window._getPosCtx(pos, spot); let nD=0,nG=0,nT=0,nV=0;
    pos.forEach((p, j) => { const g = window.BS.greeks(spot, p.strike, K.legT[j], K.r, K.legIVs[j] || 0.15, p.type, p.qty); nD+=g.delta; nG+=g.gamma; nT+=g.theta; nV+=g.vega; });
    return Object.assign({ nD, nG, nT, nV }, K); };
  window._breakevens = function (legs){ legs = legs || window._bsLegs(); const spot = window.getSpot(); if (!legs.length || !spot) return null; const ks = legs.map(l => l.strike), lo = Math.min(...ks, spot) * 0.9, hi = Math.max(...ks, spot) * 1.1, N = 800; const E = s => legs.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s); return a + (it - l.avg) * l.qty; }, 0); const cr = []; let prev = E(lo), ps = lo; for (let i = 1; i <= N; i++){ const s = lo + (i / N) * (hi - lo), v = E(s); if ((prev >= 0) !== (v >= 0)) cr.push(ps + (-prev / (v - prev)) * (s - ps)); prev = v; ps = s; } return cr.length ? { lower: Math.min(...cr), upper: Math.max(...cr) } : null; };

  const money = v => (v >= 0 ? '+' : '−') + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const moneyK = v => { const a = Math.abs(v), t = a >= 1000 ? (a / 1000).toFixed(a >= 9950 ? 0 : 1).replace(/\.0$/, '') + 'K' : Math.round(a); return (v >= 0 ? '+' : '−') + '₹' + t; };
  const niceStep = x => { if (!(x > 0)) return 1000; const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const col = v => v >= 0 ? C.up : C.dn;

  // ══ SHADOW PANEL ════════════════════════════════════════════════════════════
  let SR = null; const $ = s => SR ? SR.querySelector(s) : null, $id = i => $('#' + i);
  function fitCanvas(id, frac){ const cv = $id(id); if (!cv) return null; const w = Math.round(cv.getBoundingClientRect().width) || 420; cv.width = Math.max(w, 260);
    if (POP && !POP.closed && frac) cv.height = Math.max(Math.round(150 * frac / 0.24), Math.min(560, Math.round((POP.innerHeight || 800) * frac)));
    return cv; }
  function panelCSS(){ return `
      :host{all:initial;} *{box-sizing:border-box;margin:0;padding:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;}
      /* host is positioned (absolute/fixed) by JS to sit in the empty space below the positions tables — never inside Angular's DOM */
      #spay{position:static;width:100%;background:${C.panel};border:1px solid ${C.line};border-radius:16px;overflow:hidden;color:${C.text};box-shadow:0 14px 40px -20px rgba(0,0,0,.6);}
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
      .books{display:flex;gap:6px;padding:3px 14px 0;}.books:empty{display:none;}
      .books button{font-family:${MONO};font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:4px 11px;border-radius:7px;border:1px solid ${C.line2};background:transparent;color:${C.muted};cursor:pointer;}
      .books button:hover{color:${C.text};border-color:${C.muted};}
      .books button.on{background:${C.accent};border-color:${C.accent};color:#04140d;}
      #spay-tot,#spay-real{font-family:${MONO};}
      .mhdr{display:flex;align-items:center;gap:12px;margin:10px 0 3px;font-size:9.5px;color:${C.muted};font-family:${MONO};letter-spacing:.05em;}
      .mhdr .k{display:flex;align-items:center;gap:5px;}
      .mhdr .k:before{content:'';width:10px;height:3px;border-radius:2px;background:${C.accent};}
      .mhdr .k2:before{background:${C.ce};}
      .mhdr .mnow{margin-left:auto;color:${C.sub};}
      .brand{letter-spacing:.02em;}
      /* ── pop-out window: fills its own window, drops the floating-card chrome ── */
      body.pop{background:${C.bg};margin:0;padding:16px;}
      body.pop #spay{max-width:1180px;margin:0 auto;border-radius:12px;box-shadow:none;}
      #spay-legs{display:none;}
      body.pop #spay-legs{display:block;margin-top:8px;background:${C.card};border-radius:10px;overflow:hidden;}
      #spay-legs table{width:100%;border-collapse:collapse;font-family:${MONO};font-size:11.5px;}
      #spay-legs th{text-align:right;color:${C.muted};font-weight:600;font-size:9.5px;letter-spacing:.06em;padding:7px 12px;border-bottom:1px solid ${C.line};}
      #spay-legs td{text-align:right;padding:7px 12px;border-bottom:1px solid ${C.line};color:${C.sub};}
      #spay-legs th:first-child,#spay-legs td:first-child{text-align:left;color:${C.text};}
      #spay-legs tr:last-child td{border-bottom:none;}
      .ic.pop{font-size:12px;font-weight:700;font-family:${MONO};border:1px solid ${C.line2};border-radius:6px;padding:2px 8px;line-height:1.5;}
      .ic.pop:hover{border-color:${C.accent};color:${C.accent};}
    `; }
  function panelHTML(){ return `
      <div class="top" id="spay-top"><div class="brand"><span class="mk">S</span> Payoff &amp; Risk</div>
        <div style="display:flex;align-items:center;gap:10px;"><span class="live" id="spay-live"><span class="d"></span><span id="spay-lt">connecting</span></span><button class="ic pop" id="spay-pop" title="Open in its own window">⤡</button><button class="ic" id="spay-min">—</button><button class="ic" id="spay-close">✕</button></div></div>
      <div class="sub"><span id="spay-spot">NIFTY —</span><span id="spay-dte"></span><span>MTM <b id="spay-mtm">—</b></span><span id="spay-real" style="display:none"></span><span id="spay-tot" style="display:none"></span><span class="dbg" id="spay-dbg"></span></div>
      <div class="books" id="spay-books"></div>
      <div class="wrap"><canvas id="spay-cv" height="230"></canvas>
        <div class="mhdr"><span class="k k1">Day P&amp;L ₹</span><span class="k k2">Δ net</span><span class="mnow" id="spay-mnow"></span></div>
        <canvas id="spay-mtm-cv" height="150"></canvas>
        <div class="grk"><div><div class="gl">Δ Delta</div><div class="gv" id="g-d">—</div></div><div><div class="gl">Γ Gamma</div><div class="gv" id="g-g">—</div></div><div><div class="gl">Θ /hr</div><div class="gv" id="g-t">—</div></div><div><div class="gl">Vega</div><div class="gv" id="g-v">—</div></div></div>
        <div class="risk"><div class="rc"><div class="rl">Max loss (±3%)</div><div class="rv" id="r-ml" style="color:${C.dn}">—</div><div class="rs">worst in stress range</div></div>
          <div class="rc"><div class="rl">Breakevens</div><div class="rv" id="r-be">—</div><div class="rs" id="r-bes">safe zone</div></div>
          <div class="rc"><div class="rl">Margin used</div><div class="rv" id="r-mg">—</div><div class="rs" id="r-mgs"></div></div>
          <div class="rc"><div class="rl">Decay left</div><div class="rv" id="r-dl" style="color:${C.up}">—</div><div class="rs">θ if pinned here</div></div></div>
      </div>
        <div id="spay-legs"></div>`; }

  let POP = null, _mini = false;
  function buildPanel(){
    if (document.getElementById('spay-host')) return;
    const host = document.createElement('div'); host.id = 'spay-host'; host.style.cssText = 'all:initial;position:absolute;z-index:2147483646;top:120px;left:430px;width:500px;';
    SR = host.attachShadow({ mode: 'open' }); window._SPR = SR;
    const st = document.createElement('style'); st.textContent = panelCSS(); SR.appendChild(st);
    const panel = document.createElement('div'); panel.id = 'spay'; panel.innerHTML = panelHTML(); SR.appendChild(panel);
    (document.body || document.documentElement).appendChild(host); // stays on body — Angular can't reconcile it away
    positionPanel(); wirePanel();
  }
  function wirePanel(){
    const mn = $id('spay-min'); if (mn) mn.onclick = () => { _mini = !_mini; const w = $id('spay-cv').parentElement; if (w) w.style.display = _mini ? 'none' : ''; };
    const cl = $id('spay-close'); if (cl) cl.onclick = () => { if (POP){ closePop(); return; } const h = document.getElementById('spay-host'); if (h) h.remove(); SR = null; };
    const po = $id('spay-pop'); if (po) po.onclick = () => { if (POP && !POP.closed) closePop(); else popOut(); };
    [['spay-cv', () => window.drawPayoff()], ['spay-mtm-cv', () => window.drawMtm()]].forEach(([id, draw]) => {
      const cv = $id(id); if (!cv || cv.__h) return; cv.__h = 1; cv.style.cursor = 'crosshair';
      cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); cv._cur = (e.clientX - r.left) * (cv.width / r.width); try { draw(); } catch (_) {} });
      cv.addEventListener('mouseleave', () => { cv._cur = null; try { draw(); } catch (_) {} });
    });
  }
  // ── pop-out: the panel gets its OWN window (second monitor), still fed live by this tab ──
  function popOut(){
    let w = null;
    try { w = window.open('', 'straddly_payoff', 'width=1060,height=840,menubar=no,toolbar=no,location=no'); } catch (e) {}
    if (!w){ const b = $id('spay-pop'); if (b){ b.textContent = 'pop-ups blocked'; b.style.color = C.warn; setTimeout(() => { b.textContent = '⤡'; b.style.color = ''; }, 3500); } return; }
    try {
      w.document.open();
      w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Payoff & Risk — Straddly</title><style>' + panelCSS() + '</style></head><body class="pop"><div id="spay">' + panelHTML() + '</div></body></html>');
      w.document.close();
      POP = w; SR = w.document; window._SPR = SR; startTimers(w);
      const host = document.getElementById('spay-host'); if (host) host.style.display = 'none';
      wirePanel();
      w.addEventListener('resize', () => { try { window.refreshAll(); } catch (e) {} });
      const t = setInterval(() => { if (!POP || POP.closed){ clearInterval(t); dockBack(); } }, 700);
      window.refreshAll();
    } catch (e) { dockBack(); }
  }
  function dockBack(){
    POP = null;
    const host = document.getElementById('spay-host');
    if (host && host.shadowRoot){ SR = host.shadowRoot; host.style.display = ''; } else { SR = null; buildPanel(); }
    window._SPR = SR; startTimers(window); wirePanel(); positionPanel();
    try { window.refreshAll(); } catch (e) {}
  }
  function closePop(){ const w = POP; POP = null; try { if (w && !w.closed) w.close(); } catch (e) {} dockBack(); }
  // locate the positions block on-screen, so we can float the panel right below it (in the empty space) without touching Angular's DOM
  function anchorRect(){
    try {
      // tightest container holding BOTH position headings = the positions box (not the giant page wrapper)
      let cands = [...document.querySelectorAll('div,section,mat-card')].filter(e => /Open Positions/i.test(e.textContent) && /Closed Positions/i.test(e.textContent) && e.textContent.length < 4000);
      if (!cands.length) cands = [...document.querySelectorAll('div,section,mat-card,table')].filter(e => /Total MTM/i.test(e.textContent) && e.textContent.length < 3000);
      const el = cands.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return (r.width > 240 && r.height > 20 && r.height < window.innerHeight * 3) ? r : null;
    } catch (e) { return null; }
  }
  function positionPanel(){
    if (POP && !POP.closed) return; // panel is in its own window — nothing to place here
    const host = document.getElementById('spay-host'); if (!host) return;
    const a = Store.anchor; // set from the actual position rows (page coords) → sits right below them, on-screen
    if (a && Date.now() - a.at < 12000){
      host.style.position = 'absolute';
      host.style.left = Math.max(8, a.left) + 'px';
      host.style.top = (a.top + 14) + 'px';
      host.style.width = Math.max(430, Math.min(980, a.width || 460)) + 'px';
      host.dataset.placed = '1';
    } else if (host.dataset.placed !== '1'){ // no rows seen yet (e.g. another tab) → visible fixed fallback
      host.style.position = 'fixed'; host.style.left = '430px'; host.style.top = '120px'; host.style.width = '500px';
    }
  }

  // ══ PAYOFF CHART ════════════════════════════════════════════════════════════
  function smooth(ctx, p){ for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); }
  window.drawPayoff = function (){
    const cv = fitCanvas('spay-cv', 0.38); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const pos = window._bsLegs(), spot = window.getSpot();
    if (!pos.length || !spot){ ctx.fillStyle = C.muted; ctx.font = '12px ' + MONO; ctx.textAlign = 'center'; ctx.fillText('no open positions', W / 2, H / 2); return; }
    const K = window._getPosCtx(pos, spot), dte = K.dte;
    const ks = pos.map(p => p.strike);
    const ivs = K.legIVs.slice().sort((a, b) => a - b), ivM = ivs[Math.floor(ivs.length / 2)] || 0.15;
    const em = spot * ivM * Math.sqrt(Math.max(K.T, 1 / 8760)); // 1σ move to expiry — the plausible zone
    const kd = Math.max(0, ...ks.map(k => Math.abs(k - spot)));
    const half = Math.min(Math.max(1.5 * em, kd + 0.4 * em, spot * 0.006), spot * 0.035);
    const lo = spot - half, hi = spot + half, N = 220, pN = [];
    for (let i = 0; i <= N; i++){ const s = lo + (i / N) * (hi - lo); pN.push({ s, p: window._bsPnl(pos, s, K, 0) }); }
    const mx = Math.max(...pN.map(p => p.p)), mn = Math.min(...pN.map(p => p.p));
    const yStep = niceStep(((mx - mn) || 1000) / 4), yMin = Math.floor(mn / yStep) * yStep - yStep * 0.2, yMax = Math.ceil(mx / yStep) * yStep + yStep * 0.2;
    const L = 50, R = 12, Tp = 12, B = 24, CW = W - L - R, CH = H - Tp - B, X = s => L + ((s - lo) / (hi - lo)) * CW, Y = v => Tp + CH - ((v - yMin) / (yMax - yMin)) * CH;
    ctx.font = '9px ' + MONO;
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep){ const y = Y(v); ctx.strokeStyle = (Math.abs(v) < yStep * 0.01) ? C.line2 : C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L - 5, y + 3); }
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

  // ══ MTM CURVE (dual axis: ₹ left, net delta right) ═════════════════════════
  window.drawMtm = function (){
    const cv = fitCanvas('spay-mtm-cv', 0.22); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const a = Store.hist[activeBook()] || [];
    if (a.length < 2){ ctx.fillStyle = C.muted; ctx.font = '11px ' + MONO; ctx.textAlign = 'center'; ctx.fillText(a.length ? 'recording MTM…' : 'MTM curve starts recording now', W / 2, H / 2); return; }
    const L = 52, R = 46, Tp = 10, B = 18, CW = W - L - R, CH = H - Tp - B;
    const t0 = a[0][0], t1 = a[a.length - 1][0], span = Math.max(120, t1 - t0);
    const X = t => L + ((t - t0) / span) * CW;
    const ms = a.map(p => p[1] + (p[3] || 0)), ds = a.map(p => p[2]); // open + realised = day P&L
    const mStep = niceStep(((Math.max(0, ...ms) - Math.min(0, ...ms)) || 1000) / 3);
    const mMin = Math.floor(Math.min(0, ...ms) / mStep) * mStep, mMax = Math.ceil(Math.max(0, ...ms) / mStep) * mStep;
    const Y = v => Tp + CH - ((v - mMin) / ((mMax - mMin) || 1)) * CH;
    let dMin = Math.min(...ds), dMax = Math.max(...ds);
    if (dMax - dMin < 1){ const c = (dMax + dMin) / 2; dMin = c - 1; dMax = c + 1; }
    const dp = (dMax - dMin) * 0.18; dMin -= dp; dMax += dp;
    const YD = v => Tp + CH - ((v - dMin) / ((dMax - dMin) || 1)) * CH;
    ctx.font = '9px ' + MONO;
    // left axis = money, right axis = delta
    for (let v = mMin; v <= mMax + 1e-9; v += mStep){ const y = Y(v);
      ctx.strokeStyle = Math.abs(v) < mStep * 0.01 ? C.line2 : C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L - 5, y + 3); }
    [dMin, (dMin + dMax) / 2, dMax].forEach(v => { ctx.fillStyle = C.ce; ctx.textAlign = 'left'; ctx.fillText(v.toFixed(0), W - R + 5, YD(v) + 3); });
    for (let i = 0; i <= 3; i++){ const t = t0 + (i / 3) * span, x = X(t);
      ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + CH); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(hhmm(t), x, H - 5); }
    // filled area, green above the zero line and red below it
    const z = Math.max(Tp, Math.min(Tp + CH, Y(0)));
    const area = () => { ctx.beginPath(); ctx.moveTo(X(a[0][0]), z); a.forEach((q, i) => ctx.lineTo(X(q[0]), Y(ms[i]))); ctx.lineTo(X(a[a.length - 1][0]), z); ctx.closePath(); };
    ctx.save(); ctx.beginPath(); ctx.rect(L, Tp, CW, Math.max(0, z - Tp)); ctx.clip(); area(); ctx.fillStyle = 'rgba(74,222,128,.15)'; ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(L, z, CW, Math.max(0, Tp + CH - z)); ctx.clip(); area(); ctx.fillStyle = 'rgba(255,90,82,.15)'; ctx.fill(); ctx.restore();
    // delta first (thin, behind), then MTM on top
    ctx.strokeStyle = C.ce; ctx.lineWidth = 1.3; ctx.beginPath(); a.forEach((q, i) => { const x = X(q[0]), y = YD(q[2]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.lineWidth = 1.7;
    for (let i = 1; i < a.length; i++){
      ctx.strokeStyle = (ms[i - 1] >= 0 && ms[i] >= 0) ? C.up : (ms[i - 1] < 0 && ms[i] < 0) ? C.dn : C.muted;
      ctx.beginPath(); ctx.moveTo(X(a[i - 1][0]), Y(ms[i - 1])); ctx.lineTo(X(a[i][0]), Y(ms[i])); ctx.stroke(); }
    const lastV = ms[ms.length - 1];
    ctx.beginPath(); ctx.arc(X(a[a.length - 1][0]), Y(lastV), 3, 0, 7); ctx.fillStyle = lastV >= 0 ? C.up : C.dn; ctx.fill();
    // hover crosshair
    if (cv._cur != null){
      const tt = t0 + ((cv._cur - L) / CW) * span;
      let ni = 0; for (let i = 1; i < a.length; i++) if (Math.abs(a[i][0] - tt) < Math.abs(a[ni][0] - tt)) ni = i;
      const nb = a[ni], nv = ms[ni], cx = X(nb[0]);
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(cx, Tp); ctx.lineTo(cx, Tp + CH); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(cx, Y(nv), 3, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, YD(nb[2]), 2.6, 0, 7); ctx.fillStyle = C.ce; ctx.fill();
      const lbl = hhmm(nb[0]) + '  ' + money(nv) + (nb[3] ? '  (R ' + money(nb[3]) + ')' : '') + '  Δ' + nb[2];
      ctx.font = '10px ' + MONO; const tw = ctx.measureText(lbl).width + 14;
      let tx = cx + 8; if (tx + tw > W - 2) tx = cx - tw - 8; tx = Math.max(2, tx);
      ctx.fillStyle = 'rgba(5,6,7,.96)'; ctx.fillRect(tx, Tp + 2, tw, 18);
      ctx.strokeStyle = C.line2; ctx.strokeRect(tx, Tp + 2, tw, 18);
      ctx.fillStyle = nv >= 0 ? C.up : C.dn; ctx.textAlign = 'left'; ctx.fillText(lbl, tx + 7, Tp + 15);
    }
  };

  // ══ REFRESH ═════════════════════════════════════════════════════════════════
  // one payoff per underlying — NIFTY and BANKNIFTY are different books and must never share a spot
  function renderBooks(active){
    const el = $id('spay-books'); if (!el) return; const u = underlyings();
    if (u.length < 2){ if (el.innerHTML) el.innerHTML = ''; el.dataset.key = ''; return; }
    const key = u.join('|') + '>' + active; if (el.dataset.key === key) return; el.dataset.key = key;
    el.innerHTML = u.map(x => '<button data-u="' + x + '"' + (x === active ? ' class="on"' : '') + '>' + x + '</button>').join('');
    [...el.querySelectorAll('button')].forEach(b => { b.onclick = () => { Store.book = b.dataset.u; recomputeSpot(); window.refreshAll(); }; });
  }
  function renderLegs(){
    const el = $id('spay-legs'); if (!el) return;
    const legs = window._bsLegs(); if (!legs.length){ if (el.innerHTML) el.innerHTML = ''; return; }
    const rows = legs.map(l => { const v = (l.ltp - l.avg) * l.qty; return '<tr><td>' + l.under + ' ' + l.strike + ' ' + l.type + '</td><td>' + l.qty + '</td><td>' + l.avg.toFixed(2) + '</td><td>' + l.ltp.toFixed(2) + '</td><td style="color:' + col(v) + '">' + money(v) + '</td></tr>'; }).join('');
    el.innerHTML = '<table><thead><tr><th>Leg</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&amp;L</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  window.refreshAll = function (){
    if (!SR || !$id('spay')) return;
    const set = (id, v, c) => { const e = $id(id); if (!e) return; e.textContent = v; if (c) e.style.color = c; };
    const pos = window._bsLegs(), spot = window.getSpot(), book = activeBook(), mtm = window._bookMTM(), total = window.getOpenMTM();
    renderBooks(book);
    set('spay-spot', book + ' ' + (spot ? spot.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'));
    set('spay-mtm', pos.length ? money(mtm) : '—', col(mtm));
    const rl = $id('spay-real'); const rv = Store.realised[book] || 0;
    if (rl){ rl.style.display = rv ? '' : 'none'; if (rv){ rl.textContent = 'booked ' + money(rv); rl.style.color = col(rv); } }
    const tot = $id('spay-tot'); if (tot){ const multi = underlyings().length > 1; tot.style.display = multi ? '' : 'none'; if (multi){ tot.textContent = 'ALL ' + money(total); tot.style.color = col(total); } }
    if (pos.length && spot){ const K = window._getPosCtx(pos, spot), dte = K.dte; set('spay-dte', dte < 1 ? (dte * 24).toFixed(1) + 'h to expiry' : dte.toFixed(1) + 'd to expiry');
      const G = window._netGreeks(pos, spot); histPush(book, mtm, G.nD); set('g-d', G.nD.toFixed(1), col(G.nD)); set('g-g', G.nG.toFixed(3), C.dn); set('g-t', '₹' + Math.abs(G.nT / 6.25).toFixed(0), C.up); set('g-v', G.nV.toFixed(0), C.dn);
      const stress = [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03].map(s => window._bsPnl(pos, spot * (1 + s), K, 0)); set('r-ml', money(Math.min(0, ...stress)), C.dn);
      const be = window._breakevens(pos); if (be){ const inside = spot >= be.lower && spot <= be.upper, near = Math.min(Math.abs(be.upper - spot), Math.abs(spot - be.lower)); set('r-be', Math.round(be.lower).toLocaleString('en-IN') + '–' + Math.round(be.upper).toLocaleString('en-IN')); set('r-bes', inside ? near.toFixed(0) + ' pt to edge' : 'OUTSIDE', inside ? C.muted : C.dn); } else { set('r-be', '—'); set('r-bes', ''); }
      const decay = pos.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot); return a + (l.ltp - it) * (-l.qty); }, 0); set('r-dl', money(decay), decay >= 0 ? C.up : C.dn);
    } else { ['g-d','g-g','g-t','g-v','r-ml','r-be','r-dl'].forEach(id => set(id, '—', C.muted)); set('spay-dte', ''); }
    const allowed = allowedMargin(), used = marginUsed(), pctm = Math.min(100, allowed ? used / allowed * 100 : 0);
    set('r-mg', pctm.toFixed(0) + '%', pctm > 80 ? C.dn : pctm > 60 ? C.warn : C.up); set('r-mgs', '₹' + Math.round(used / 1000) + 'K / ₹' + Math.round(allowed / 1000) + 'K');
    const lv = $id('spay-live'); if (lv){ const on = Date.now() - Store.lastUpdate < 8000; lv.classList.toggle('on', on); set('spay-lt', on ? 'live' : (Store.lastUpdate ? 'stale' : 'connecting')); }
    renderLegs();
    const pb = $id('spay-pop'); if (pb){ const on = POP && !POP.closed; pb.textContent = on ? '⇲' : '⤡'; pb.title = on ? 'Dock back into the page' : 'Open in its own window'; }
    const age = Store.lastScrape ? Date.now() - Store.lastScrape : -1;
    set('spay-dbg', (Store.dbg || '') + (age >= 0 ? ' · ' + (age < 1000 ? age + 'ms' : (age / 1000).toFixed(1) + 's') : ''));
    positionPanel();
    const mn = $id('spay-mnow');
    if (mn){ const h = Store.hist[book] || []; mn.textContent = h.length ? h.length + ' pts · since ' + hhmm(h[0][0]) : ''; }
    window.drawPayoff(); window.drawMtm();
  };

  // ══ BOOT + WATCHDOG ═════════════════════════════════════════════════════════
  // Chrome throttles timers in a hidden tab (~1s, then ~1/min). When popped out, the portal tab IS hidden —
  // so host the clocks in the pop-out window, which is the visible one.
  let _tm = [];
  function startTimers(w){
    _tm.forEach(t => { try { t.w.clearInterval(t.id); } catch (e) {} }); _tm = [];
    const add = (fn, ms) => { try { _tm.push({ w, id: w.setInterval(fn, ms) }); } catch (e) {} };
    add(() => { try { poll(); } catch (e) {} }, POLL_MS);
    add(() => { try { window.refreshAll(); } catch (e) {} }, UI_REFRESH_MS);
  }
  function boot(){
    histLoad(); buildPanel(); Store.onUpdate(() => { try { window.refreshAll(); } catch (e) {} });
    startTimers(window);
    setInterval(() => { try {
      if (POP && !POP.closed) return; // popped out — leave the host hidden
      if (!document.getElementById('spay-host')){ SR = null; buildPanel(); window.refreshAll(); return; }
      positionPanel();
    } catch (e) {} }, WATCHDOG_MS);
    window.addEventListener('scroll', () => { try { positionPanel(); } catch (e) {} }, true);
    window.addEventListener('resize', () => { try { positionPanel(); } catch (e) {} });
    setTimeout(() => { wirePanel(); poll(); window.refreshAll(); }, 700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
