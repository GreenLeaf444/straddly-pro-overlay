// ==UserScript==
// @name         Straddly Payoff & Risk (mini)
// @namespace    http://tampermonkey.net/
// @version      3.1
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
  // Exchange session. NSE F&O and BSE both close 15:40 IST (moved from 15:30 on 2026-08-03).
  // Time-to-expiry is derived from this, so a wrong value distorts theta/gamma badly on expiry day.
  const OPEN_H = 9, OPEN_M = 15, CLOSE_H = 15, CLOSE_M = 40;
  const IV_MIN = 0.01, IV_MAX = 3.0; // a solved vol outside 1%–300% is a bad mark, not a real vol
  const HOLIDAYS = []; // optional 'YYYY-MM-DD' trading holidays; the frozen-feed check below covers the rest
  const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

  // ══ STORE ═══════════════════════════════════════════════════════════════════
  // The captured Authorization header lives in this closure ONLY. It is deliberately kept off `Store`,
  // because Store is exposed as window.SPAY and anything running on the broker's page could read it there.
  let AUTH = '';
  const Store = { positions: [], ltpById: {}, ltpBySym: {}, chain: {}, margin: null, user: null, spot: 0, spots: {}, book: '', hist: {}, histDay: '', realised: {}, prevLegs: {}, posVisible: false, lastUpdate: 0, markAt: 0, tickAt: 0, tableAt: 0, quoteAt: 0, dbg: '', _l: [], onUpdate(f){ this._l.push(f); }, _emit(){ this.lastUpdate = Date.now(); this._l.forEach(f => { try { f(); } catch (e) {} }); } };
  window.SPAY = Store; // NOTE: intentionally carries no auth token — see AUTH above
  function parseSymbol(s){ if (!s) return null; const m = s.match(/^([A-Z]+?)(\d{2})(\d{2})(\d{2})(\d+)(CE|PE|SD)$/); if (!m) return null; return { underlying: m[1], expiry: new Date(2000 + +m[2], +m[3] - 1, +m[4], CLOSE_H, CLOSE_M, 0), strike: +m[5], type: m[6] }; }
  // CloudFront build: same-origin /api/data/touchline (live quotes) + getuserdetails. Positions come via socket → we DOM-scrape them.
  function ingest(url, body){ if (!url || !body) return; let j; try { j = JSON.parse(body); } catch (e) { return; } const d = j && j.data !== undefined ? j.data : j; try {
    if (/\/(data\/)?[Tt]ouchline/i.test(url) && Array.isArray(d)) {
      const mine = {}; Store.positions.forEach(p => { if (p.symbol) mine[p.symbol] = 1; });
      d.forEach(q => { if (q && q.symbol){ if (q.symbolId != null) Store.ltpById[q.symbolId] = q.ltp; Store.ltpBySym[q.symbol] = q.ltp; if (mine[q.symbol] && q.ltp > 0){ Store.markAt = Date.now(); if (Store.ltpBySym[q.symbol] !== q.ltp) Store.quoteAt = Date.now(); } } });
      recomputeSpot(); Store._emit(); return; }
    if (/user\/getuserdetails/i.test(url) && d && d.id) { Store.user = d; Store._emit(); return; }
    if (/\/(Orders\/Get-MarginusedByID|user\/getMargin)/i.test(url) && Array.isArray(d) && d.length) { Store.margin = d[0]; Store._emit(); return; }
  } catch (e) {} }
  const IDX = { NIFTY: 'NIFTY', BANKNIFTY: 'NIFTY BANK', SENSEX: 'SENSEX' };
  function detectUnderlying(){ for (const p of Store.positions){ const s = parseSymbol(p.symbol); if (s) return s.underlying; } return 'NIFTY'; }
  function paritySpot(under){ const byK = {}; for (const sym in Store.ltpBySym){ const p = parseSymbol(sym), l = Store.ltpBySym[sym]; if (!p || p.type === 'SD' || !(l > 0)) continue; if (under && p.underlying !== under) continue; const o = byK[p.strike] = byK[p.strike] || { exp: p.expiry }; o[p.type] = l; } const rows = []; for (const k in byK){ const r = byK[k]; if (r.CE > 0 && r.PE > 0) rows.push({ k: +k, diff: Math.abs(r.CE - r.PE), cp: r.CE - r.PE, exp: r.exp }); } if (!rows.length) return 0; rows.sort((a, b) => a.diff - b.diff); const top = rows.slice(0, 3), rr = 0.065, now = Date.now(); let s = 0; top.forEach(x => { const T = Math.max((x.exp - now) / (365 * 864e5), 1e-5); s += x.k * Math.exp(-rr * T) + x.cp; }); return s / top.length; }
  const _idx = { under: null, valEl: null, last: 0 };
  function indexSpotDOM(under){ const numIn = el => { const m = (el && el.textContent || '').trim().match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,6}(?:\.\d+)?)/); if (!m) return 0; const v = parseFloat(m[1].replace(/,/g, '')); return (v > 1000 && v < 200000) ? v : 0; }; try { if (_idx.under === under && _idx.valEl && document.contains(_idx.valEl)){ const v = numIn(_idx.valEl); if (v) return v; } if (Date.now() - _idx.last < 1500) return 0; _idx.last = Date.now(); const wants = under === 'BANKNIFTY' ? ['BANKNIFTY','BANK NIFTY','NIFTY BANK'] : [under, 'SPOT']; const leaves = document.querySelectorAll('span,div,b,strong,td,th,p'); for (let i = 0; i < leaves.length; i++){ const el = leaves[i]; if (el.childElementCount !== 0) continue; const t = el.textContent.trim().toUpperCase().replace(':', ''); if (wants.indexOf(t) < 0) continue; const probes = [el.nextElementSibling, el.previousElementSibling].concat(el.parentElement ? Array.from(el.parentElement.children) : []); for (const c of probes){ if (!c || c === el) continue; const v = numIn(c); if (v){ _idx.under = under; _idx.valEl = c; return v; } } } } catch (e) {} return 0; }
  // A closed exchange serves a FROZEN feed, not an empty one — a flat, plausible-looking tape.
  // So we check the clock (in IST, regardless of the machine's timezone) AND whether marks are actually moving.
  function istNow(d){ d = d || new Date(); return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 5.5 * 3600000); }
  function marketState(now){
    const d = istNow(now), dow = d.getDay(), mins = d.getHours() * 60 + d.getMinutes();
    const iso = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    if (dow === 0 || dow === 6 || HOLIDAYS.indexOf(iso) >= 0) return 'CLOSED';
    if (mins < OPEN_H * 60 + OPEN_M || mins > CLOSE_H * 60 + CLOSE_M) return 'CLOSED';
    return 'OPEN';
  }
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
  let _tableSig = '';
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
      out.push({ status: 'OPEN', symbol: sym, symbolId: null, optionType: type, strikePrice: strike, quantity: qty, avgSellPrice: qty < 0 ? avg : 0, avgBuyPrice: qty > 0 ? avg : 0, bepPrice: avg, ltp: ltp, _pnl: pnl, _scraped: true, expiryDate: new Date(yr, +mo - 1, +day, CLOSE_H, CLOSE_M, 0).toISOString() });
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
    if (Store.posVisible){
      Store.markAt = Date.now();
      const tsig = uniq.map(p => p.symbol + ':' + p.ltp).join('|');
      if (tsig !== _tableSig){ _tableSig = tsig; Store.tableAt = Date.now(); }
    }
    const qn = Store.positions.filter(p => Store.ltpBySym[p.symbol] > 0).length;
    Store.dbg = 'pos ' + Store.positions.length + (Store.posVisible ? '' : ' · q' + qn + '/' + Store.positions.length) + (function(){ const v = Store.spots[activeBook()] || Store.spot; return v ? ' · spot ' + Math.round(v) : ' · spot ?'; })() + (AUTH ? ' · auth✓' : ' · auth✗');
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
    if (!AUTH || !origFetch) return;
    const FET = (POP && !POP.closed && POP.fetch) ? POP.fetch.bind(POP) : origFetch; const us = underlyings(); if (!us.length) us.push('NIFTY'); const syms = us.map(u => IDX[u] || u); Store.positions.forEach(p => { if (p.symbol && syms.indexOf(p.symbol) < 0) syms.push(p.symbol); });
    FET(location.origin + '/api/data/touchline', { method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' }, body: JSON.stringify(syms), credentials: 'include' }).then(x => x.text()).then(t => ingest(location.origin + '/api/data/touchline', t)).catch(() => {});
  }

  // ══ INTERCEPTOR ═════════════════════════════════════════════════════════════
  const origFetch = window.fetch;
  const captureAuth = h => { if (!h) return; try { const g = k => (h.get ? h.get(k) : h[k] || h[k.toLowerCase()]); const a = g('authorization'); if (a) AUTH = a; } catch (e) {} };
  if (origFetch) window.fetch = function (...a){ const url = (a[0] && a[0].url) || a[0], init = a[1] || {}; try { if (typeof url === 'string' && /\/api\//.test(url)) captureAuth(init.headers || (a[0] && a[0].headers)); } catch (e) {} const p = origFetch.apply(this, a); try { if (typeof url === 'string') p.then(r => r.clone().text().then(t => ingest(url, t)).catch(()=>{})).catch(()=>{}); } catch (e) {} return p; };
  const oO = XMLHttpRequest.prototype.open, oS = XMLHttpRequest.prototype.send, oH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u){ this.__s = { url: String(u) }; return oO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v){ if (/^authorization$/i.test(k) && v) AUTH = v; return oH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body){ const d = this.__s; if (d) this.addEventListener('load', () => { try { ingest(d.url, this.responseText); } catch (e) {} }); return oS.apply(this, arguments); };
  // Chrome throttles hidden-tab timers to ~1/s, then ~1/min after five minutes, and can freeze the tab.
  // A dedicated Worker's clock is not subject to that, so it drives the poll; setInterval stays as a backstop.
  let HB = null;
  function startHeartbeat(){
    try {
      const src = 'let t=null;onmessage=function(e){if(e.data&&e.data.ms){clearInterval(t);t=setInterval(function(){postMessage(1);},e.data.ms);}};';
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      HB = new Worker(url); URL.revokeObjectURL(url);
      HB.onmessage = () => { try { poll(); window.refreshAll(); } catch (e) {} };
      HB.postMessage({ ms: POLL_MS });
    } catch (e) { HB = null; }
  }
  // A page playing audio is exempt from intensive throttling and from being frozen/discarded. This is the
  // same AudioContext the alert tones use, so enabling sound also keeps the data alive.
  let AC = null, KEEP = null;
  function audioOn(){
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      if (!KEEP){ const o = AC.createOscillator(), g = AC.createGain();
        g.gain.value = 0.0008; o.frequency.value = 20; o.connect(g); g.connect(AC.destination); o.start(); KEEP = o; }
      return AC.state === 'running';
    } catch (e) { return false; }
  }
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
    const q = (p.symbol && Store.ltpBySym[p.symbol] > 0) ? Store.ltpBySym[p.symbol] : 0;
    // Foreground: the table ticks, so mirror it exactly. Background/off-tab: the table is frozen but our
    // touchline poll keeps running — whichever source moved most recently is the honest one.
    const tableFresh = Store.posVisible && p._scraped && p.ltp > 0 && Store.tableAt >= Store.quoteAt;
    if (tableFresh) return p.ltp;
    if (q) return q;
    if (Store.posVisible && p._scraped && p.ltp > 0) return p.ltp;
    if (p.symbolId != null && Store.ltpById[p.symbolId] != null) return Store.ltpById[p.symbolId];
    return p.ltp || 0;
  }
  function posAvg(p){ if (p.bepPrice > 0) return p.bepPrice; if (p.quantity < 0) return p.avgSellPrice; if (p.quantity > 0) return p.avgBuyPrice; return p.avgSellPrice || p.avgBuyPrice || 0; }
  window.parseOpenPos = function (){ return Store.positions.filter(p => p.status === 'OPEN' && p.quantity !== 0).map(p => { const avg = posAvg(p); let ltp = liveLtp(p); if (p.optionType === 'SD'){ const b = p.symbol ? p.symbol.replace(/SD$/, '') : ''; const ce = Store.ltpBySym[b + 'CE'], pe = Store.ltpBySym[b + 'PE']; if (ce != null && pe != null) ltp = ce + pe; } let exp = p.expiryDate ? new Date(p.expiryDate) : (parseSymbol(p.symbol) || {}).expiry; if (exp instanceof Date && !isNaN(exp)) exp.setHours(CLOSE_H, CLOSE_M, 0, 0); const _s = parseSymbol(p.symbol); return { under: (_s && _s.underlying) || 'NIFTY', symbol: p.symbol, symbolId: p.symbolId, qty: p.quantity, avg, ltp, pnl: (ltp - avg) * p.quantity, strike: p.strikePrice || (parseSymbol(p.symbol) || {}).strike || 0, type: p.optionType, expiry: exp }; }); };
  function expandLegs(rows){ const out = []; rows.forEach(p => { if (p.type !== 'SD'){ out.push(p); return; } const ceSym = p.symbol.replace(/SD$/, 'CE'), peSym = p.symbol.replace(/SD$/, 'PE'); const cL = Store.ltpBySym[ceSym], pL = Store.ltpBySym[peSym]; const have = cL != null && pL != null && (cL + pL) > 0, c = have ? cL : p.ltp / 2, pp = have ? pL : p.ltp / 2, sum = c + pp || 1, cA = p.avg * c / sum; out.push(Object.assign({}, p, { type: 'CE', ltp: c, avg: cA, pnl: (c - cA) * p.qty })); out.push(Object.assign({}, p, { type: 'PE', ltp: pp, avg: p.avg - cA, pnl: (pp - (p.avg - cA)) * p.qty })); }); return out; }
  window._allLegs = () => expandLegs(window.parseOpenPos());
  window._bsLegs = () => { const b = activeBook(); return window._allLegs().filter(l => l.under === b); };
  window.getSpot = () => { const b = activeBook(); return Store.spots[b] || spotFor(b) || 0; }; // NEVER fall back to another book's spot
  window.getOpenMTM = () => window.parseOpenPos().reduce((s, p) => s + p.pnl, 0);
  window._bookMTM = () => window._bsLegs().reduce((s, p) => s + p.pnl, 0);
  const allowedMargin = () => (Store.user && Store.user.marginAllowed) || (Store.margin && Store.margin.allowedMargin) || DEFAULT_ALLOWED_MARGIN;
  const marginUsed = () => (Store.margin && Store.margin.totalMarginUsed) || 0;
  window.BS = { norm(x){const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;const s=x<0?-1:1;x=Math.abs(x)/Math.sqrt(2);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return .5*(1+s*y);}, d1(S,K,T,r,v){return(Math.log(S/K)+(r+.5*v*v)*T)/(v*Math.sqrt(T));}, price(S,K,T,r,v,t){if(T<=0)return t==='CE'?Math.max(0,S-K):Math.max(0,K-S);const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T);return t==='CE'?S*this.norm(d1)-K*Math.exp(-r*T)*this.norm(d2):K*Math.exp(-r*T)*this.norm(-d2)-S*this.norm(-d1);}, iv(S,K,T,r,mkt,t){if(!(T>0)||!(mkt>0)||!(S>0)||!(K>0))return 0;const intr=t==='CE'?Math.max(0,S-K*Math.exp(-r*T)):Math.max(0,K*Math.exp(-r*T)-S);if(mkt<=intr+1e-6)return 0;let v=.3;for(let i=0;i<100;i++){const p=this.price(S,K,T,r,v,t),d1=this.d1(S,K,T,r,v),vega=S*Math.sqrt(T)*Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),diff=p-mkt;if(Math.abs(diff)<.001)break;if(vega<1e-10)break;v-=diff/vega;if(!isFinite(v))return 0;if(v<.001)v=.001;if(v>5)v=5;}if(!isFinite(v)||v<IV_MIN||v>IV_MAX)return 0;if(Math.abs(this.price(S,K,T,r,v,t)-mkt)>Math.max(.05,mkt*.02))return 0;return v;}, greeks(S,K,T,r,v,t,qty){if(T<=0||v<=0)return{delta:0,gamma:0,theta:0,vega:0};const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T),nd1=Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),sg=qty<0?-1:1,aq=Math.abs(qty);const delta=t==='CE'?this.norm(d1):this.norm(d1)-1;const gamma=nd1/(S*v*Math.sqrt(T));const theta=t==='CE'?(-S*nd1*v/(2*Math.sqrt(T))-r*K*Math.exp(-r*T)*this.norm(d2))/365:(-S*nd1*v/(2*Math.sqrt(T))+r*K*Math.exp(-r*T)*this.norm(-d2))/365;const vega=S*nd1*Math.sqrt(T)/100;return{delta:sg*delta*aq,gamma:sg*gamma*aq,theta:sg*theta*aq,vega:sg*vega*aq};} };
  window._getPosCtx = function (pos, spot){ const now = new Date();
    const legT = pos.map(p => { let d = 7; if (p.expiry instanceof Date && !isNaN(p.expiry)) d = Math.max(0.001, (p.expiry - now) / 864e5); return Math.max(d / 365, 0.0001); });
    const dte = legT.length ? Math.min(...legT) * 365 : 7, T = Math.max(dte / 365, 0.0001), r = 0.065;
    const raw = pos.map((p, j) => window.BS.iv(spot, p.strike, legT[j], r, p.ltp || p.avg, p.type));
    const ok = raw.filter(v => v > 0).sort((a, b) => a - b);
    const fb = ok.length ? ok[Math.floor(ok.length / 2)] : 0.15; // fall back to the median leg that DID solve
    const legIVs = raw.map(v => v > 0 ? v : fb), ivBad = raw.length - ok.length;
    return { T, r, dte, legIVs, legT, ivBad, ivFallback: fb }; };
  window._bsPnl = function (pos, s2, K, ivD){ ivD = ivD || 0; const legT = K.legT || pos.map(() => K.T);
    return pos.reduce((a, p, j) => { const iv = Math.max(0.01, (K.legIVs[j] || 0.15) + ivD); return a + (window.BS.price(s2, p.strike, legT[j], K.r, iv, p.type) - p.avg) * p.qty; }, 0); };
  window._netGreeks = function (pos, spot){ const K = window._getPosCtx(pos, spot); let nD=0,nG=0,nT=0,nV=0;
    pos.forEach((p, j) => { const g = window.BS.greeks(spot, p.strike, K.legT[j], K.r, K.legIVs[j] || 0.15, p.type, p.qty); nD+=g.delta; nG+=g.gamma; nT+=g.theta; nV+=g.vega; });
    return Object.assign({ nD, nG, nT, nV }, K); };
  window._breakevens = function (legs){ legs = legs || window._bsLegs(); const spot = window.getSpot(); if (!legs.length || !spot) return null; const ks = legs.map(l => l.strike), lo = Math.min(...ks, spot) * 0.9, hi = Math.max(...ks, spot) * 1.1, N = 800; const E = s => legs.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s); return a + (it - l.avg) * l.qty; }, 0); const cr = []; let prev = E(lo), ps = lo; for (let i = 1; i <= N; i++){ const s = lo + (i / N) * (hi - lo), v = E(s); if ((prev >= 0) !== (v >= 0)) cr.push(ps + (-prev / (v - prev)) * (s - ps)); prev = v; ps = s; } return cr.length ? { lower: Math.min(...cr), upper: Math.max(...cr) } : null; };

  const fmtAge = ms => ms < 1000 ? ms + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 60000) + 'm';
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
      .live.warn .d{background:${C.warn};box-shadow:0 0 0 3px rgba(251,191,36,.16);}.live.warn{color:${C.warn};}
      .live.bad .d{background:${C.dn};box-shadow:0 0 0 3px rgba(255,90,82,.18);}.live.bad{color:${C.dn};}
      .live.shut .d{background:${C.muted};}.live.shut{color:${C.muted};}
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
      #spay-tot,#spay-real,#spay-iv{font-family:${MONO};}
      #spay-iv{color:${C.warn};cursor:help;}
      .mhdr{display:flex;align-items:center;gap:12px;margin:10px 0 3px;font-size:9.5px;color:${C.muted};font-family:${MONO};letter-spacing:.05em;}
      .mhdr .k{display:flex;align-items:center;gap:5px;}
      .mhdr .k:before{content:'';width:10px;height:3px;border-radius:2px;background:${C.accent};}
      .mhdr .k2:before{background:${C.ce};}
      .mhdr .mnow{margin-left:auto;color:${C.sub};}
      .alert{display:flex;align-items:center;gap:10px;margin:8px 12px 0;padding:8px 11px;border-radius:9px;font-size:11.5px;font-family:${MONO};border:1px solid;}
      .alert.bad{background:rgba(255,90,82,.12);border-color:rgba(255,90,82,.45);color:${C.dn};}
      .alert.warn{background:rgba(251,191,36,.10);border-color:rgba(251,191,36,.42);color:${C.warn};}
      .alert.good{background:rgba(74,222,128,.10);border-color:rgba(74,222,128,.42);color:${C.accent};}
      .alert .ad{flex:1;} .alert .ax{background:none;border:none;color:inherit;cursor:pointer;font-size:12px;opacity:.7;}
      .cfg{margin:8px 12px 0;padding:10px 12px;background:${C.card};border:1px solid ${C.line};border-radius:10px;}
      .cfg label{display:flex;align-items:center;gap:8px;font-size:11px;color:${C.sub};margin-bottom:6px;}
      .cfg label i{font-style:normal;color:${C.muted};font-size:9.5px;}
      .cfg input[type=number]{width:86px;background:${C.bg};border:1px solid ${C.line2};color:${C.text};font-family:${MONO};font-size:11px;padding:3px 6px;border-radius:5px;}
      .cfg .cks{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;padding-top:8px;border-top:1px solid ${C.line};}
      .cfg .ck{gap:5px;margin:0;cursor:pointer;}
      .cfgn{margin-top:8px;font-size:9.5px;color:${C.muted};line-height:1.45;}
      #spay-log{margin-top:8px;border-top:1px solid ${C.line};padding-top:6px;max-height:150px;overflow:auto;}
      .lg{font-family:${MONO};font-size:10px;padding:2px 0;color:${C.sub};}
      .lg span{color:${C.muted};margin-right:8px;} .lg.bad{color:${C.dn};} .lg.warn{color:${C.warn};} .lg.good{color:${C.accent};}
      .lg.none{color:${C.muted};}
      .ic.bell{font-size:11px;border:1px solid ${C.line2};border-radius:6px;padding:2px 7px;line-height:1.6;}
      .ic.bell.act{border-color:${C.accent};color:${C.accent};}
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
        <div style="display:flex;align-items:center;gap:10px;"><span class="live" id="spay-live"><span class="d"></span><span id="spay-lt">connecting</span></span><button class="ic bell" id="spay-bell" title="Alerts">◉</button><button class="ic pop" id="spay-pop" title="Open in its own window">⤡</button><button class="ic" id="spay-min">—</button><button class="ic" id="spay-close">✕</button></div></div>
      <div class="sub"><span id="spay-spot">NIFTY —</span><span id="spay-dte"></span><span>MTM <b id="spay-mtm">—</b></span><span id="spay-iv" style="display:none" title="A leg's mark did not solve to a believable implied vol, so its greeks use an estimate."></span><span id="spay-real" style="display:none"></span><span id="spay-tot" style="display:none"></span><span class="dbg" id="spay-dbg"></span></div>
      <div class="alert" id="spay-alert" style="display:none"><span class="ad"></span><button class="ax" id="spay-ax">✕</button></div>
      <div class="cfg" id="spay-cfg" style="display:none">
        <label>Breakeven warn <input id="a-be" type="number" min="0" step="5"><i>pts</i></label>
        <label>Target <input id="a-tgt" type="number" step="500"><i>₹</i></label>
        <label>Stop <input id="a-stop" type="number" step="500"><i>₹ (negative)</i></label>
        <label>|Δ| limit <input id="a-dlt" type="number" min="0" step="5"><i>0 = off</i></label>
        <div class="cks">
          <label class="ck"><input id="a-on" type="checkbox">alerts on</label>
          <label class="ck"><input id="a-snd" type="checkbox">sound</label>
          <label class="ck"><input id="a-dsk" type="checkbox">desktop</label>
          <label class="ck"><input id="a-fls" type="checkbox">flash</label>
          <label class="ck"><input id="a-hl" type="checkbox">feed health</label>
        </div>
        <div class="cfgn">Alerts fire once per crossing and re-arm only after the value pulls back. Nothing fires while the feed is stale, frozen, or the market is closed.</div>
        <div id="spay-log"></div>
      </div>
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
  function syncCfg(){
    const v = (id, val) => { const e = $id(id); if (e) e.value = val; };
    const c = (id, val) => { const e = $id(id); if (e) e.checked = !!val; };
    v('a-be', AL.be); v('a-tgt', AL.tgt); v('a-stop', AL.stop); v('a-dlt', AL.dlt);
    c('a-on', AL.on); c('a-snd', AL.sound); c('a-dsk', AL.desktop); c('a-fls', AL.flash); c('a-hl', AL.health);
  }
  function wirePanel(){
    const mn = $id('spay-min'); if (mn) mn.onclick = () => { _mini = !_mini; const w = $id('spay-cv').parentElement; if (w) w.style.display = _mini ? 'none' : ''; };
    const cl = $id('spay-close'); if (cl) cl.onclick = () => { if (POP){ closePop(); return; } const h = document.getElementById('spay-host'); if (h) h.remove(); SR = null; };
    const po = $id('spay-pop'); if (po) po.onclick = () => { if (POP && !POP.closed) closePop(); else popOut(); };
    const ax = $id('spay-ax'); if (ax) ax.onclick = () => { const b = $id('spay-alert'); if (b) b.style.display = 'none'; };
    const bell = $id('spay-bell');
    if (bell) bell.onclick = () => { const c = $id('spay-cfg'); if (!c) return; const show = c.style.display === 'none'; c.style.display = show ? '' : 'none'; if (show){ syncCfg(); renderLog(); } };
    const num = (id, key) => { const e = $id(id); if (!e) return; e.onchange = () => { AL[key] = parseFloat(e.value) || 0; alSave(); Object.keys(ALS).forEach(k => { ALS[k].armed = true; }); }; };
    num('a-be', 'be'); num('a-tgt', 'tgt'); num('a-stop', 'stop'); num('a-dlt', 'dlt');
    const chk = (id, key) => { const e = $id(id); if (!e) return; e.onchange = () => {
      AL[key] = e.checked; alSave();
      if (key === 'sound' && e.checked && !audioOn()) { e.checked = false; AL.sound = false; alSave(); }
      // permission must be asked from a click, never on page load
      if (key === 'desktop' && e.checked && window.Notification && Notification.permission !== 'granted')
        Notification.requestPermission().then(pm => { if (pm !== 'granted'){ e.checked = false; AL.desktop = false; alSave(); } });
    }; };
    chk('a-on', 'on'); chk('a-snd', 'sound'); chk('a-dsk', 'desktop'); chk('a-fls', 'flash'); chk('a-hl', 'health');
    const root = $id('spay'); if (root && !root.__au){ root.__au = 1; root.addEventListener('click', () => { if (AL.sound) audioOn(); }, true); }
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
  const MIN_SPAN = 1800, GAP_S = 45, Y_FLOOR = 1000; // 30-min minimum frame; don't draw across recording gaps
  window.drawMtm = function (){
    const cv = fitCanvas('spay-mtm-cv', 0.22); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
    const a = Store.hist[activeBook()] || [];
    if (a.length < 2){ ctx.fillStyle = C.muted; ctx.font = '11px ' + MONO; ctx.textAlign = 'center'; ctx.fillText(a.length ? 'recording…' : 'day P&L starts recording now', W / 2, H / 2); return; }
    const L2 = 52, R = 46, Tp = 10, B = 18, CW = W - L2 - R, CH = H - Tp - B;
    // left-anchored, minimum 30-minute frame so the curve grows into a stable window instead of rescaling every tick
    const t0 = a[0][0], span = Math.max(MIN_SPAN, a[a.length - 1][0] - t0);
    const X = t => L2 + ((t - t0) / span) * CW;
    const ms = a.map(p => p[1] + (p[3] || 0)), ds = a.map(p => p[2]); // open + realised = day P&L
    let lo = Math.min(0, ...ms), hi = Math.max(0, ...ms);
    if (hi - lo < Y_FLOOR){ const c = (hi + lo) / 2; lo = c - Y_FLOOR / 2; hi = c + Y_FLOOR / 2; } // don't zoom into tick noise
    const mStep = niceStep(((hi - lo) || 1000) / 3);
    const mMin = Math.floor(lo / mStep) * mStep, mMax = Math.ceil(hi / mStep) * mStep;
    const Y = v => Tp + CH - ((v - mMin) / ((mMax - mMin) || 1)) * CH;
    let dMin = Math.min(...ds), dMax = Math.max(...ds);
    if (dMax - dMin < 1){ const c = (dMax + dMin) / 2; dMin = c - 1; dMax = c + 1; }
    const dp = (dMax - dMin) * 0.18; dMin -= dp; dMax += dp;
    const YD = v => Tp + CH - ((v - dMin) / ((dMax - dMin) || 1)) * CH;
    ctx.font = '9px ' + MONO;
    for (let v = mMin; v <= mMax + 1e-9; v += mStep){ const y = Y(v);
      ctx.strokeStyle = Math.abs(v) < mStep * 0.01 ? C.line2 : C.line; ctx.beginPath(); ctx.moveTo(L2, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L2 - 5, y + 3); }
    [dMin, (dMin + dMax) / 2, dMax].forEach(v => { ctx.fillStyle = C.ce; ctx.textAlign = 'left'; ctx.fillText(v.toFixed(0), W - R + 5, YD(v) + 3); });
    for (let i = 0; i <= 3; i++){ const t = t0 + (i / 3) * span, x = X(t);
      ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + CH); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(hhmm(t), x, H - 5); }
    // split into contiguous runs — a jump means we weren't recording (other book / tab closed / reload)
    const runs = []; let st = 0;
    for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] > GAP_S){ runs.push([st, i - 1]); st = i; }
    runs.push([st, a.length - 1]);
    const z = Math.max(Tp, Math.min(Tp + CH, Y(0)));
    runs.forEach(([s0, s1]) => {
      if (s1 <= s0) return;
      const area = () => { ctx.beginPath(); ctx.moveTo(X(a[s0][0]), z); for (let i = s0; i <= s1; i++) ctx.lineTo(X(a[i][0]), Y(ms[i])); ctx.lineTo(X(a[s1][0]), z); ctx.closePath(); };
      ctx.save(); ctx.beginPath(); ctx.rect(L2, Tp, CW, Math.max(0, z - Tp)); ctx.clip(); area(); ctx.fillStyle = 'rgba(74,222,128,.15)'; ctx.fill(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(L2, z, CW, Math.max(0, Tp + CH - z)); ctx.clip(); area(); ctx.fillStyle = 'rgba(255,90,82,.15)'; ctx.fill(); ctx.restore();
      ctx.strokeStyle = C.ce; ctx.lineWidth = 1.3; ctx.beginPath();
      for (let i = s0; i <= s1; i++){ const x = X(a[i][0]), y = YD(ds[i]); i === s0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1.7;
      for (let i = s0 + 1; i <= s1; i++){
        ctx.strokeStyle = (ms[i - 1] >= 0 && ms[i] >= 0) ? C.up : (ms[i - 1] < 0 && ms[i] < 0) ? C.dn : C.muted;
        ctx.beginPath(); ctx.moveTo(X(a[i - 1][0]), Y(ms[i - 1])); ctx.lineTo(X(a[i][0]), Y(ms[i])); ctx.stroke(); }
    });
    const lastV = ms[ms.length - 1];
    ctx.beginPath(); ctx.arc(X(a[a.length - 1][0]), Y(lastV), 3, 0, 7); ctx.fillStyle = lastV >= 0 ? C.up : C.dn; ctx.fill();
    if (cv._cur != null){
      const tt = t0 + ((cv._cur - L2) / CW) * span;
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


  // ══ ALERTS ══════════════════════════════════════════════════════════════════
  // Design rules, in order of importance:
  //  1. NEVER fire off bad data — a stop triggered by a frozen mark is worse than no alert at all.
  //  2. Fire once per crossing. Re-arm only after the value retreats past a buffer (hysteresis), so a
  //     value oscillating around a threshold cannot machine-gun you into ignoring the whole system.
  //  3. Every alert says which book it is about; a multi-book screen makes an unlabelled alert useless.
  const ALERT_KEY = 'spay_alerts_v1', ALERT_COOLDOWN = 60000;
  const AL = { on: true, sound: true, desktop: false, flash: true, health: true, be: 40, tgt: 0, stop: 0, dlt: 0 };
  const ALS = {};            // rule state: key -> { armed, at }
  const ALOG = [];           // most recent first
  function alLoad(){ try { const j = JSON.parse(localStorage.getItem(ALERT_KEY) || '{}'); Object.keys(AL).forEach(k => { if (j[k] !== undefined) AL[k] = j[k]; }); } catch (e) {} }
  function alSave(){ try { localStorage.setItem(ALERT_KEY, JSON.stringify(AL)); } catch (e) {} }

  function beep(kind){
    if (!AL.sound || !audioOn()) return;
    try { const seq = kind === 'bad' ? [[880, 0], [660, .16], [880, .32]] : [[760, 0], [1010, .13]];
      seq.forEach(([f, t]) => { const o = AC.createOscillator(), g = AC.createGain(), at = AC.currentTime + t;
        o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(AC.destination);
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.22, at + .01);
        g.gain.exponentialRampToValueAtTime(0.0001, at + .12); o.start(at); o.stop(at + .14); });
    } catch (e) {}
  }
  let _flash = null;
  function flashTitle(msg){
    if (!AL.flash || !POP || POP.closed) return;
    try { clearInterval(_flash); const base = 'Payoff & Risk'; let i = 0;
      _flash = setInterval(() => { POP.document.title = (i++ % 2) ? base : '🔔 ' + msg; if (i > 12){ clearInterval(_flash); POP.document.title = base; } }, 700);
    } catch (e) {}
  }
  function desktop(title, body){
    if (!AL.desktop) return;
    try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: body, tag: 'spay', renotify: true }); } catch (e) {}
  }
  function fire(key, sev, title, body){
    const st = ALS[key] || (ALS[key] = { armed: true, at: 0 });
    if (!st.armed || Date.now() - st.at < ALERT_COOLDOWN) return;
    st.armed = false; st.at = Date.now();
    ALOG.unshift({ t: Date.now(), sev: sev, msg: title + ' — ' + body }); if (ALOG.length > 30) ALOG.pop();
    beep(sev); desktop(title, body); flashTitle(title);
    const b = $id('spay-alert'); if (b){ b.style.display = ''; b.className = 'alert ' + sev;
      const d = b.querySelector('.ad'); if (d) d.textContent = title + ' — ' + body;
      clearTimeout(b.__t); b.__t = setTimeout(() => { b.style.display = 'none'; }, 25000); }
    renderLog();
  }
  function rearm(key, ok){ const st = ALS[key]; if (st && ok) st.armed = true; }

  function evalAlerts(state){          // state is injectable so the suite can test each session case
    if (!AL.on) return;
    if ((state || marketState()) !== 'OPEN'){ Object.keys(ALS).forEach(k => { ALS[k].armed = true; }); return; }
    const age = Store.markAt ? Date.now() - Store.markAt : -1;
    const frozen = Store.tickAt ? Date.now() - Store.tickAt : -1;
    const sick = age < 0 || age > 30000 || frozen > 180000;
    if (AL.health){
      if (sick) fire('health', 'bad', 'FEED PROBLEM', age > 30000 ? 'no fresh mark for ' + fmtAge(age) : 'no mark has moved in ' + fmtAge(frozen));
      else rearm('health', true);
    }
    if (sick) return; // RULE 1 — do not judge P&L, breakevens or delta on data we do not trust
    const all = window._allLegs();
    underlyings().forEach(u => {
      const lg = all.filter(l => l.under === u); if (!lg.length) return;
      const sp = Store.spots[u] || spotFor(u); if (!sp) return;
      const day = lg.reduce((a, p) => a + p.pnl, 0) + (Store.realised[u] || 0);
      if (AL.be > 0){
        const be = window._breakevens(lg);
        if (be){
          const out = sp < be.lower || sp > be.upper;
          const dist = Math.min(Math.abs(sp - be.lower), Math.abs(be.upper - sp));
          if (out) fire(u + ':beBreach', 'bad', u + ' BREAKEVEN BREACHED', 'spot ' + Math.round(sp).toLocaleString('en-IN') + ' is outside ' + Math.round(be.lower) + '–' + Math.round(be.upper));
          else { rearm(u + ':beBreach', dist > AL.be * 0.5);
            if (dist <= AL.be) fire(u + ':beNear', 'warn', u + ' near breakeven', Math.round(dist) + ' pts away (' + Math.round(be.lower) + '–' + Math.round(be.upper) + ')');
            else rearm(u + ':beNear', dist > AL.be * 1.5); }
        }
      }
      if (AL.tgt > 0){ if (day >= AL.tgt) fire(u + ':tgt', 'good', u + ' TARGET HIT', 'day P&L ' + money(day)); else rearm(u + ':tgt', day < AL.tgt * 0.9); }
      if (AL.stop < 0){ if (day <= AL.stop) fire(u + ':stop', 'bad', u + ' STOP HIT', 'day P&L ' + money(day)); else rearm(u + ':stop', day > AL.stop * 0.9); }
      if (AL.dlt > 0){ const nd = window._netGreeks(lg, sp).nD;
        if (Math.abs(nd) >= AL.dlt) fire(u + ':dlt', 'warn', u + ' delta ' + nd.toFixed(1), 'book has drifted directional (limit ' + AL.dlt + ')');
        else rearm(u + ':dlt', Math.abs(nd) < AL.dlt * 0.8); }
    });
  }
  function renderLog(){
    const el = $id('spay-log'); if (!el) return;
    el.innerHTML = ALOG.length
      ? ALOG.slice(0, 12).map(a => '<div class="lg ' + a.sev + '"><span>' + hhmm(Math.round(a.t / 1000)) + '</span>' + a.msg.replace(/</g, '&lt;') + '</div>').join('')
      : '<div class="lg none">no alerts yet today</div>';
  }

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
  // Sample EVERY book, not just the visible one — a book you're not looking at must not go dark.
  let _histTick = 0;
  let _markSig = '';
  function noteTicks(){
    const sig = window._allLegs().map(l => l.symbol + ':' + l.ltp).join('|');
    if (sig && sig !== _markSig){ _markSig = sig; Store.tickAt = Date.now(); }
  }
  function recordAllBooks(){
    if (marketState() !== 'OPEN') return; // don't pad the curve with a flat after-hours tail
    if (Date.now() - _histTick < HIST_MS - 250) return; _histTick = Date.now();
    const all = window._allLegs();
    underlyings().forEach(u => {
      const lg = all.filter(l => l.under === u); if (!lg.length) return;
      const sp = Store.spots[u] || spotFor(u); if (!sp) return;
      try { histPush(u, lg.reduce((s, p) => s + p.pnl, 0), window._netGreeks(lg, sp).nD); } catch (e) {}
    });
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
      const iw = $id('spay-iv');
      if (iw){ iw.style.display = K.ivBad ? '' : 'none'; if (K.ivBad) iw.textContent = '⚠ ' + K.ivBad + ' leg IV est'; }
      const G = window._netGreeks(pos, spot); set('g-d', G.nD.toFixed(1), col(G.nD)); set('g-g', G.nG.toFixed(3), C.dn); set('g-t', '₹' + Math.abs(G.nT / 6.25).toFixed(0), C.up); set('g-v', G.nV.toFixed(0), C.dn);
      const stress = [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03].map(s => window._bsPnl(pos, spot * (1 + s), K, 0)); set('r-ml', money(Math.min(0, ...stress)), C.dn);
      const be = window._breakevens(pos); if (be){ const inside = spot >= be.lower && spot <= be.upper, near = Math.min(Math.abs(be.upper - spot), Math.abs(spot - be.lower)); set('r-be', Math.round(be.lower).toLocaleString('en-IN') + '–' + Math.round(be.upper).toLocaleString('en-IN')); set('r-bes', inside ? near.toFixed(0) + ' pt to edge' : 'OUTSIDE', inside ? C.muted : C.dn); } else { set('r-be', '—'); set('r-bes', ''); }
      const decay = pos.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot); return a + (l.ltp - it) * (-l.qty); }, 0); set('r-dl', money(decay), decay >= 0 ? C.up : C.dn);
    } else { ['g-d','g-g','g-t','g-v','r-ml','r-be','r-dl'].forEach(id => set(id, '—', C.muted)); set('spay-dte', ''); }
    const allowed = allowedMargin(), used = marginUsed(), pctm = Math.min(100, allowed ? used / allowed * 100 : 0);
    set('r-mg', pctm.toFixed(0) + '%', pctm > 80 ? C.dn : pctm > 60 ? C.warn : C.up); set('r-mgs', '₹' + Math.round(used / 1000) + 'K / ₹' + Math.round(allowed / 1000) + 'K');
    // Status must describe OUR MARKS, not our network activity. Four honest states, worst-case wins.
    const lv = $id('spay-live');
    if (lv){
      const mkt = marketState(), age = Store.markAt ? Date.now() - Store.markAt : -1;
      const frozen = Store.tickAt ? Date.now() - Store.tickAt : -1;
      let txt, cls;
      if (mkt === 'CLOSED'){ txt = 'closed'; cls = 'shut'; }
      else if (age < 0){ txt = 'connecting'; cls = 'shut'; }
      else if (age > 30000){ txt = 'STALE ' + fmtAge(age); cls = 'bad'; }
      else if (frozen > 180000){ txt = 'FROZEN ' + fmtAge(frozen); cls = 'warn'; } // open, but no mark has moved
      else if (age > 5000){ txt = 'delayed ' + fmtAge(age); cls = 'warn'; }
      else { txt = 'live'; cls = 'on'; }
      lv.className = 'live ' + cls; set('spay-lt', txt);
    }
    noteTicks(); recordAllBooks();
    try { evalAlerts(); } catch (e) {}
    const bl = $id('spay-bell'); if (bl) bl.classList.toggle('act', !!AL.on);
    renderLegs();
    const pb = $id('spay-pop'); if (pb){ const on = POP && !POP.closed; pb.textContent = on ? '⇲' : '⤡'; pb.title = on ? 'Dock back into the page' : 'Open in its own window'; }
    const mAge = Store.markAt ? Date.now() - Store.markAt : -1;
    set('spay-dbg', (Store.dbg || '') + (mAge >= 0 ? ' · mark ' + fmtAge(mAge) : ''));
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
    // test surface — assigned here, not at declaration time, so every const above is initialised (TDZ)
    window.SPAY._fn = { AL, ALS, ALOG, evalAlerts, parseSymbol, marketState, istNow, dayKey, scrapePositions, reconcileRealised, histPush, marketConsts: { OPEN_H, OPEN_M, CLOSE_H, CLOSE_M, IV_MIN, IV_MAX } };
    alLoad(); histLoad(); buildPanel(); Store.onUpdate(() => { try { window.refreshAll(); } catch (e) {} });
    startTimers(window);
    setInterval(() => { try {
      if (POP && !POP.closed) return; // popped out — leave the host hidden
      if (!document.getElementById('spay-host')){ SR = null; buildPanel(); window.refreshAll(); return; }
      positionPanel();
    } catch (e) {} }, WATCHDOG_MS);
    startHeartbeat();
    document.addEventListener('visibilitychange', () => { if (!document.hidden){ try { poll(); window.refreshAll(); } catch (e) {} } });
    window.addEventListener('scroll', () => { try { positionPanel(); } catch (e) {} }, true);
    window.addEventListener('resize', () => { try { positionPanel(); } catch (e) {} });
    setTimeout(() => { wirePanel(); poll(); window.refreshAll(); }, 700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
