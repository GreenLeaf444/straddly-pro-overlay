// ==UserScript==
// @name         Straddly Payoff & Risk (mini)
// @namespace    http://tampermonkey.net/
// @version      4.6
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
  // Two themes. Colour carries meaning (P&L sign, alert state) in both; nothing is decorative.
  // Light is a warm paper tone, not white — white next to a dark chart is glare, and the greens/reds must
  // darken or they fail contrast on a light ground.
  const THEMES = {
    dark: { bg:'#050609', panel:'#0a0c0f', card:'#0f1217', line:'#171a20', line2:'#232830',
            text:'#e8eaed', sub:'#9aa2ac', muted:'#7a818b', dim:'#5a606a',
            accent:'#4d9bff', accent2:'#2f7fe8', accentRing:'rgba(77,155,255,.25)', up:'#3fb950', dn:'#f0563f', warn:'#d29922',
            ce:'#4d9bff', pe:'#f0563f', sd:'#a371f7',
            upFill:'rgba(63,185,80,.09)', dnFill:'rgba(240,86,63,.09)',
            upArea:'rgba(63,185,80,.15)', dnArea:'rgba(240,86,63,.15)',
            goodBg:'rgba(63,185,80,.07)', warnBg:'rgba(210,153,34,.07)', badBg:'rgba(240,86,63,.07)',
            beLine:'rgba(210,153,34,.45)', spotLine:'rgba(77,155,255,.60)',
            hair:'rgba(255,255,255,.30)', tipBg:'rgba(5,6,9,.96)', dot:'#ffffff' },
    light:{ bg:'#eef0ec', panel:'#fcfcfa', card:'#f1f2ee', line:'#dcded8', line2:'#c3c6be',
            text:'#08090c', sub:'#23272d', muted:'#3f444b', dim:'#5d636b',
            accent:'#0b64d4', accent2:'#0a4fa8', accentRing:'rgba(11,100,212,.22)', up:'#1a7f37', dn:'#cf222e', warn:'#9a6700',
            ce:'#0b64d4', pe:'#cf222e', sd:'#6639ba',
            upFill:'rgba(26,127,55,.10)', dnFill:'rgba(207,34,46,.09)',
            upArea:'rgba(26,127,55,.16)', dnArea:'rgba(207,34,46,.14)',
            goodBg:'rgba(26,127,55,.08)', warnBg:'rgba(154,103,0,.09)', badBg:'rgba(207,34,46,.07)',
            beLine:'rgba(154,103,0,.55)', spotLine:'rgba(11,100,212,.60)',
            hair:'rgba(0,0,0,.34)', tipBg:'rgba(251,251,249,.97)', dot:'#16181d' }
  };
  const C = Object.assign({}, THEMES.dark);
  // Exchange session. NSE F&O and BSE both close 15:40 IST (moved from 15:30 on 2026-08-03).
  // Time-to-expiry is derived from this, so a wrong value distorts theta/gamma badly on expiry day.
  const OPEN_H = 9, OPEN_M = 15, CLOSE_H = 15, CLOSE_M = 40;
  const IV_MIN = 0.01, IV_MAX = 3.0; // a solved vol outside 1%–300% is a bad mark, not a real vol
  const HOLIDAYS = []; // optional 'YYYY-MM-DD' trading holidays; the frozen-feed check below covers the rest
  const MONO = 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace';
  const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,system-ui,sans-serif';

  // ══ STORE ═══════════════════════════════════════════════════════════════════
  // The captured Authorization header lives in this closure ONLY. It is deliberately kept off `Store`,
  // because Store is exposed as window.SPAY and anything running on the broker's page could read it there.
  let AUTH = '';
  const Store = { positions: [], ltpById: {}, ltpBySym: {}, chain: {}, margin: null, user: null, spot: 0, spots: {}, book: '', hist: {}, histDay: '', realised: {}, peak: {}, prevLegs: {}, posVisible: false, lastUpdate: 0, markAt: 0, tickAt: 0, tableAt: 0, quoteAt: 0, portalMTM: null, mismatch: 0, dbg: '', _l: [], onUpdate(f){ this._l.push(f); }, _emit(){ this.lastUpdate = Date.now(); this._l.forEach(f => { try { f(); } catch (e) {} }); } };
  window.SPAY = Store; // NOTE: intentionally carries no auth token — see AUTH above
  // Run SPAY.diag() in the console to compare, per leg, what we computed against what the portal printed.
  Store.diag = function (){
    const rows = (window.parseOpenPos ? window.parseOpenPos() : []).map(l => {
      const src = Store.positions.filter(x => x.symbol === l.symbol)[0] || {};
      return { symbol: l.symbol, type: l.type, qty: l.qty, avg: l.avg,
               ltpUsed: l.ltp, ltpScraped: src.ltp, ltpQuote: Store.ltpBySym[l.symbol],
               ourPnl: Math.round(l.pnl * 100) / 100, portalPnl: src._pnl,
               diff: src._pnl != null ? Math.round((l.pnl - src._pnl) * 100) / 100 : null };
    });
    const ourTotal = rows.reduce((a, r) => a + r.ourPnl, 0);
    const out = { legs: rows, ourTotal: Math.round(ourTotal * 100) / 100, portalTotal: Store.portalMTM,
      totalDiff: Store.portalMTM != null ? Math.round((ourTotal - Store.portalMTM) * 100) / 100 : null,
      usingTable: tableTrusted(), posVisible: Store.posVisible,
      quoteMinusTableMs: Store.quoteAt - Store.tableAt, spots: Store.spots };
    try { console.table(rows); } catch (e) {}
    console.log('[SPAY.diag]', out); return out;
  }; // NOTE: intentionally carries no auth token — see AUTH above
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
  // A spot is only credible if it sits near this book's own strikes — that guard stops the portal header's
  // spot for a DIFFERENT index (whatever the user has selected up there) being read as this book's spot.
  function plausibleSpot(under, v){
    if (!(v > 0)) return false;
    const ks = [];
    Store.positions.forEach(p => { const x = parseSymbol(p.symbol);
      if (x && x.underlying === under){ const k = p.strikePrice || x.strike; if (k > 0) ks.push(k); } });
    if (!ks.length) return true;
    ks.sort((a, b) => a - b);
    const mid = ks[Math.floor(ks.length / 2)];
    return v > mid * 0.75 && v < mid * 1.25;
  }
  // DOM FIRST. The portal prints a live spot; our touchline poll can stall (expired token, rejected symbol)
  // and a stalled value would otherwise win forever, freezing the spot and with it the whole payoff.
  function spotFor(under){
    const dom = indexSpotDOM(under);              if (plausibleSpot(under, dom)) return dom;
    const idx = Store.ltpBySym[IDX[under] || under]; if (plausibleSpot(under, idx)) return idx;
    const par = paritySpot(under);                if (plausibleSpot(under, par)) return par;
    return 0;
  }
  function recomputeSpot(){ try { underlyings().forEach(u => { const v = spotFor(u); if (v > 0) Store.spots[u] = v; }); const b = activeBook(); const v = Store.spots[b] || spotFor(b); if (v > 0){ Store.spots[b] = v; Store.spot = v; } } catch (e) {} }
  // ── scrape open positions from the page table (CloudFront build streams positions via socket, not REST) ──
  const MON = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  const INSTR_RE = /(NIFTY BANK|BANKNIFTY|SENSEX|NIFTY)\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{4,6})\s*(CE|PE|SD)/i;
  // MutationObserver beats polling on two counts: it fires the moment the portal writes a new LTP/P&L,
  // and it keeps firing when the portal tab is in the BACKGROUND (timers there get throttled to ~1s by Chrome).
  const OBS = { tables: [], mo: null, last: 0, dirty: false, hits: 0, syncs: 0 }; window.__SPAY_OBS = OBS;
  function syncNow(){ OBS.syncs++; OBS.last = Date.now(); OBS.dirty = false; memClear(); try { scrapePositions(); window.refreshAll(); } catch (e) {} }
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
  // The portal prints its own "Total MTM" — read it, so we can prove we agree instead of assuming it.
  function scrapePortalMTM(){
    try { const m = (document.body ? document.body.innerText : '').match(/Total\s*MTM\s*:?\s*₹?\s*(-?[\d,]+(?:\.\d+)?)/i);
      Store.portalMTM = m ? parseFloat(m[1].replace(/,/g, '')) : null;
    } catch (e) { Store.portalMTM = null; }
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
    watchTables(tables); scrapePortalMTM();
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
      if (j && j.day === dayKey() && j.h){ Store.hist = j.h; Store.histDay = j.day; Store.realised = j.r || {}; Store.peak = j.pk || {}; }
      else localStorage.removeItem(HIST_KEY); // new session day → start clean
    } catch (e) {}
  }
  let _lastSave = 0;
  function histSave(force){
    if (!force && Date.now() - _lastSave < HIST_SAVE_MS) return; _lastSave = Date.now();
    try { localStorage.setItem(HIST_KEY, JSON.stringify({ day: Store.histDay || dayKey(), h: Store.hist, r: Store.realised, pk: Store.peak })); } catch (e) {}
  }
  function histPush(book, mtm, delta){
    if (!book || !isFinite(mtm) || !isFinite(delta)) return;
    const day = dayKey(); if (Store.histDay !== day){ Store.hist = {}; Store.histDay = day; Store.realised = {}; Store.peak = {}; Store.prevLegs = {}; }
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
  // The portal's own row is authoritative whenever we can read it. Timestamp heuristics (which source moved
  // last, how long since the table changed) were tried and both failed: they silently handed the display over
  // to self-fetched quotes, which are stale or mis-mapped, producing numbers that disagreed with the screen.
  // Our quotes now only fill in what the row cannot give us. If the page stops updating, the FROZEN badge says so.
  function tableTrusted(){ return Store.posVisible; }
  function liveLtp(p){
    const q = (p.symbol && Store.ltpBySym[p.symbol] > 0) ? Store.ltpBySym[p.symbol] : 0;
    const onScreen = Store.posVisible && p._scraped && p.ltp > 0;
    // The portal's own LTP column is the source of truth. Two earlier rules were both wrong:
    //   `tableAt >= quoteAt` was a RACE — the timestamps leapfrog tick by tick, so the panel silently drifted
    //   onto self-fetched quotes and disagreed with the screen;
    //   "table changed in the last N seconds" mistakes a QUIET MARKET for a frozen page.
    // The only honest signal is the GAP: our quotes still moving well after the table stopped means the page
    // is throttled. If both are quiet, the market is quiet and the table is still right.
    if (onScreen) return p.ltp;
    if (q) return q;
    if (p.symbolId != null && Store.ltpById[p.symbolId] != null) return Store.ltpById[p.symbolId];
    return p.ltp || 0;
  }
  function posAvg(p){ if (p.bepPrice > 0) return p.bepPrice; if (p.quantity < 0) return p.avgSellPrice; if (p.quantity > 0) return p.avgBuyPrice; return p.avgSellPrice || p.avgBuyPrice || 0; }
  // An SD row's own LTP is the straddle's mark. Rebuilding it as CE+PE from separate quotes was the cause of a
  // sign-flipped P&L: the components summed 16 points away from the mark the portal printed.
  window.parseOpenPos = function (){
    return Store.positions.filter(p => p.status === 'OPEN' && p.quantity !== 0).map(p => {
      const avg = posAvg(p), ltp = liveLtp(p), _s = parseSymbol(p.symbol);
      let exp = p.expiryDate ? new Date(p.expiryDate) : (_s || {}).expiry;
      if (exp instanceof Date && !isNaN(exp)) exp.setHours(CLOSE_H, CLOSE_M, 0, 0);
      const pnl = (p._scraped && p._pnl != null && isFinite(p._pnl) && tableTrusted()) ? p._pnl : (ltp - avg) * p.quantity;
      return { under: (_s && _s.underlying) || 'NIFTY', symbol: p.symbol, symbolId: p.symbolId, qty: p.quantity,
               avg, ltp, pnl, strike: p.strikePrice || (_s || {}).strike || 0, type: p.optionType, expiry: exp };
    });
  };
  function expandLegs(rows){
    const out = [];
    rows.forEach(p => {
      if (p.type !== 'SD'){ out.push(p); return; }
      const cL = Store.ltpBySym[p.symbol.replace(/SD$/, 'CE')], pL = Store.ltpBySym[p.symbol.replace(/SD$/, 'PE')];
      // Component quotes are usable ONLY if they actually reconcile with the straddle's own mark. In the wild
      // they can sit 10%+ away (stale, or a different expiry), which silently corrupts the split.
      const usable = cL > 0 && pL > 0 && p.ltp > 0 && Math.abs((cL + pL) - p.ltp) <= Math.max(2, p.ltp * 0.05);
      const c = usable ? cL : p.ltp / 2, pp = usable ? pL : p.ltp / 2, sum = (c + pp) || 1;
      const wCE = c / sum, cA = p.avg * wCE;
      out.push(Object.assign({}, p, { type: 'CE', ltp: c, avg: cA, pnl: p.pnl * wCE, _est: !usable }));
      out.push(Object.assign({}, p, { type: 'PE', ltp: pp, avg: p.avg - cA, pnl: p.pnl * (1 - wCE), _est: !usable }));
    });
    return out;
  }
  // The leg set, its pricing context and its greeks were each rebuilt many times per frame — and every
  // context rebuild re-ran a Newton solve per leg. Compute once per frame; memClear() opens a new frame.
  // SELF-INVALIDATING on purpose: an earlier version cleared this only at the top of a refresh frame, so any
  // caller outside that frame (alerts, tests, the console) silently got stale legs. The cache key is derived
  // from every input the leg set depends on, so it cannot go stale no matter who calls it.
  const _mem = { key: null, legs: null, ctx: new Map(), grk: new Map() };
  function memClear(){ _mem.key = null; _mem.legs = null; _mem.ctx.clear(); _mem.grk.clear(); }
  function _legKey(){
    let k = Store.posVisible + '|';
    for (let i = 0; i < Store.positions.length; i++){ const p = Store.positions[i];
      k += p.symbol + ':' + p.quantity + ':' + p.ltp + ':' + p._pnl + ':' + (p.bepPrice || p.avgSellPrice || p.avgBuyPrice);
      // every quote the expansion actually consults must be in the key, including a straddle's CE/PE
      // components — those never bump quoteAt (it only tracks POSITION symbols), so leaving them out
      // meant a component quote could change while the cached legs stayed put.
      k += '/' + Store.ltpBySym[p.symbol];
      if (p.optionType === 'SD'){ const b = p.symbol.replace(/SD$/, '');
        k += '/' + Store.ltpBySym[b + 'CE'] + '/' + Store.ltpBySym[b + 'PE']; }
      k += ';';
    }
    return k;
  }
  const _memKey = (pos, spot) => Math.round(spot * 100) + '|' + pos.map(p => p.symbol + ':' + p.ltp + ':' + p.qty + ':' + p.avg).join(',');
  window._allLegs = function (){
    const k = _legKey();
    if (_mem.key !== k){ _mem.key = k; _mem.legs = expandLegs(window.parseOpenPos()); _mem.ctx.clear(); _mem.grk.clear(); }
    return _mem.legs;
  };
  window._bsLegs = () => { const b = activeBook(); return window._allLegs().filter(l => l.under === b); };
  window.getSpot = () => { const b = activeBook(); return Store.spots[b] || spotFor(b) || 0; }; // NEVER fall back to another book's spot
  window.getOpenMTM = () => window.parseOpenPos().reduce((s, p) => s + p.pnl, 0);
  window._bookMTM = () => window._bsLegs().reduce((s, p) => s + p.pnl, 0);
  const allowedMargin = () => (Store.user && Store.user.marginAllowed) || (Store.margin && Store.margin.allowedMargin) || DEFAULT_ALLOWED_MARGIN;
  const marginUsed = () => (Store.margin && Store.margin.totalMarginUsed) || 0;
  window.BS = { norm(x){const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;const s=x<0?-1:1;x=Math.abs(x)/Math.sqrt(2);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return .5*(1+s*y);}, d1(S,K,T,r,v){return(Math.log(S/K)+(r+.5*v*v)*T)/(v*Math.sqrt(T));}, price(S,K,T,r,v,t){if(T<=0)return t==='CE'?Math.max(0,S-K):Math.max(0,K-S);const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T);return t==='CE'?S*this.norm(d1)-K*Math.exp(-r*T)*this.norm(d2):K*Math.exp(-r*T)*this.norm(-d2)-S*this.norm(-d1);}, iv(S,K,T,r,mkt,t){if(!(T>0)||!(mkt>0)||!(S>0)||!(K>0))return 0;const intr=t==='CE'?Math.max(0,S-K*Math.exp(-r*T)):Math.max(0,K*Math.exp(-r*T)-S);if(mkt<=intr+1e-6)return 0;let v=.3;for(let i=0;i<100;i++){const p=this.price(S,K,T,r,v,t),d1=this.d1(S,K,T,r,v),vega=S*Math.sqrt(T)*Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),diff=p-mkt;if(Math.abs(diff)<.001)break;if(vega<1e-10)break;v-=diff/vega;if(!isFinite(v))return 0;if(v<.001)v=.001;if(v>5)v=5;}if(!isFinite(v)||v<IV_MIN||v>IV_MAX)return 0;if(Math.abs(this.price(S,K,T,r,v,t)-mkt)>Math.max(.05,mkt*.02))return 0;return v;}, greeks(S,K,T,r,v,t,qty){if(T<=0||v<=0)return{delta:0,gamma:0,theta:0,vega:0};const d1=this.d1(S,K,T,r,v),d2=d1-v*Math.sqrt(T),nd1=Math.exp(-.5*d1*d1)/Math.sqrt(2*Math.PI),sg=qty<0?-1:1,aq=Math.abs(qty);const delta=t==='CE'?this.norm(d1):this.norm(d1)-1;const gamma=nd1/(S*v*Math.sqrt(T));const theta=t==='CE'?(-S*nd1*v/(2*Math.sqrt(T))-r*K*Math.exp(-r*T)*this.norm(d2))/365:(-S*nd1*v/(2*Math.sqrt(T))+r*K*Math.exp(-r*T)*this.norm(-d2))/365;const vega=S*nd1*Math.sqrt(T)/100;return{delta:sg*delta*aq,gamma:sg*gamma*aq,theta:sg*theta*aq,vega:sg*vega*aq};} };
  window._getPosCtx = function (pos, spot){
    const mk = _memKey(pos, spot); const hit = _mem.ctx.get(mk); if (hit) return hit;
    const val = _posCtx(pos, spot); _mem.ctx.set(mk, val); return val; };
  function _posCtx(pos, spot){ const now = new Date();
    const legT = pos.map(p => { let d = 7; if (p.expiry instanceof Date && !isNaN(p.expiry)) d = Math.max(0.001, (p.expiry - now) / 864e5); return Math.max(d / 365, 0.0001); });
    const dte = legT.length ? Math.min(...legT) * 365 : 7, T = Math.max(dte / 365, 0.0001), r = 0.065;
    const raw = pos.map((p, j) => window.BS.iv(spot, p.strike, legT[j], r, p.ltp || p.avg, p.type));
    const ok = raw.filter(v => v > 0).sort((a, b) => a - b);
    const fb = ok.length ? ok[Math.floor(ok.length / 2)] : 0.15; // fall back to the median leg that DID solve
    const legIVs = raw.map(v => v > 0 ? v : fb), ivBad = raw.length - ok.length;
    return { T, r, dte, legIVs, legT, ivBad, ivFallback: fb }; }
  window._bsPnl = function (pos, s2, K, ivD){ ivD = ivD || 0; const legT = K.legT || pos.map(() => K.T);
    return pos.reduce((a, p, j) => { const iv = Math.max(0.01, (K.legIVs[j] || 0.15) + ivD); return a + (window.BS.price(s2, p.strike, legT[j], K.r, iv, p.type) - p.avg) * p.qty; }, 0); };
  window._netGreeks = function (pos, spot){
    const mk = _memKey(pos, spot); const hit = _mem.grk.get(mk); if (hit) return hit;
    const K = window._getPosCtx(pos, spot); let nD=0,nG=0,nT=0,nV=0;
    pos.forEach((p, j) => { const g = window.BS.greeks(spot, p.strike, K.legT[j], K.r, K.legIVs[j] || 0.15, p.type, p.qty); nD+=g.delta; nG+=g.gamma; nT+=g.theta; nV+=g.vega; });
    const out = Object.assign({ nD, nG, nT, nV }, K); _mem.grk.set(mk, out); return out; };
  window._breakevens = function (legs){ legs = legs || window._bsLegs(); const spot = window.getSpot(); if (!legs.length || !spot) return null; const ks = legs.map(l => l.strike), lo = Math.min(...ks, spot) * 0.9, hi = Math.max(...ks, spot) * 1.1, N = 800; const E = s => legs.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s); return a + (it - l.avg) * l.qty; }, 0); const cr = []; let prev = E(lo), ps = lo; for (let i = 1; i <= N; i++){ const s = lo + (i / N) * (hi - lo), v = E(s); if ((prev >= 0) !== (v >= 0)) cr.push(ps + (-prev / (v - prev)) * (s - ps)); prev = v; ps = s; } return cr.length ? { lower: Math.min(...cr), upper: Math.max(...cr) } : null; };

  const fmtAge = ms => ms < 1000 ? ms + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 60000) + 'm';
  const money = v => (v >= 0 ? '+' : '−') + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const moneyK = v => { const a = Math.abs(v), t = a >= 1000 ? (a / 1000).toFixed(a >= 9950 ? 0 : 1).replace(/\.0$/, '') + 'K' : Math.round(a); return (v >= 0 ? '+' : '−') + '₹' + t; };
  const niceStep = x => { if (!(x > 0)) return 1000; const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const col = v => v >= 0 ? C.up : C.dn;

  // ══ SHADOW PANEL ════════════════════════════════════════════════════════════
  const THEME_KEY = 'spay_theme';
  function applyTheme(name){
    if (!THEMES[name]) name = 'dark';
    Object.assign(C, THEMES[name]); Store.theme = name;
    try { localStorage.setItem(THEME_KEY, name); } catch (e) {}
    // the stylesheet is a template over C, so it has to be re-emitted wherever the panel currently lives
    [SR, (POP && !POP.closed) ? POP.document : null].forEach(root => {
      if (!root) return;
      const st = root.querySelector('style'); if (st) st.textContent = panelCSS();
      const b = root.body; if (b) b.style.background = C.bg;
    });
    const tb = $id('spay-theme'); if (tb) tb.title = name === 'dark' ? 'Switch to light' : 'Switch to dark';
    try { window.refreshAll(); } catch (e) {}
  }
  let SR = null; const $ = s => SR ? SR.querySelector(s) : null, $id = i => $('#' + i);
  // Sized in CSS pixels but backed at devicePixelRatio — without this every line and label is drawn at 1x
  // and upscaled by the compositor, which is why canvas UIs look soft next to the page's own text.
  const PAYOFF_H_KEY = 'spay_payoff_h';
  function fitCanvas(id, frac, baseH){
    const cv = $id(id); if (!cv) return null;
    const W = Math.max(Math.round(cv.getBoundingClientRect().width) || 420, 260);
    let H = baseH || 150;
    if (POP && !POP.closed && frac) H = Math.max(H, Math.min(560, Math.round((POP.innerHeight || 800) * frac)));
    if (id === 'spay-cv' && Store.payoffH > 0) H = Store.payoffH; // user-dragged height wins
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (cv._W !== W || cv._H !== H || cv._dpr !== dpr){
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.height = H + 'px'; cv._W = W; cv._H = H; cv._dpr = dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return cv; }
  function panelCSS(){ return `
      :host{all:initial;}
      *{box-sizing:border-box;margin:0;padding:0;font-family:${SANS};}
      /* One surface, hairline rules, two radii. Colour is reserved for P&L sign and alert state. */
      #spay{position:static;width:100%;background:${C.panel};border:1px solid ${C.line2};border-radius:8px;
            overflow:hidden;color:${C.text};font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}
      .num,.gv,.rv,.hv,#spay-mtm,#spay-spot,#spay-dte,#spay-tot,#spay-real,#spay-dbg{font-family:${MONO};font-variant-numeric:tabular-nums;}
      .lbl{font-size:9px;letter-spacing:.12em;color:${C.muted};text-transform:uppercase;white-space:nowrap;}

      .top{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid ${C.line};user-select:none;}
      .wm{font-size:9.5px;letter-spacing:.18em;color:${C.accent};font-weight:600;}
      .tools{display:flex;align-items:center;gap:4px;}
      .live{display:flex;align-items:center;gap:5px;font-size:9.5px;letter-spacing:.1em;color:${C.muted};margin-right:6px;text-transform:uppercase;}
      .live .d{width:5px;height:5px;border-radius:50%;background:${C.muted};}
      .live.on .d{background:${C.up};}.live.on{color:${C.up};}
      .live.warn .d{background:${C.warn};}.live.warn{color:${C.warn};}
      .live.bad .d{background:${C.dn};}.live.bad{color:${C.dn};}
      .ic{background:transparent;border:none;color:${C.muted};cursor:pointer;padding:3px 4px;border-radius:4px;display:grid;place-items:center;line-height:0;}
      .ic:hover{color:${C.text};background:${C.card};}
      .ic.act{color:${C.accent};}
      .ic svg{display:block;}

      /* book switcher: underline, not pills */
      .books{display:flex;gap:0;padding:0 14px;border-bottom:1px solid ${C.line};}.books:empty{display:none;border:0;}
      .books button{font-family:${MONO};font-size:11px;font-weight:600;letter-spacing:.1em;padding:7px 0;margin-right:16px;
                    border:none;border-bottom:1.5px solid transparent;background:none;color:${C.muted};cursor:pointer;}
      .books button:hover{color:${C.sub};}
      .books button.on{color:${C.text};border-bottom-color:${C.accent};}

      /* hero — the answer, first */
      .hero{padding:13px 14px 12px;border-bottom:1px solid ${C.line};}
      .hero .hl{display:flex;align-items:center;gap:8px;margin-bottom:5px;}
      .hv{font-family:${MONO};font-size:33px;line-height:1.05;letter-spacing:-.015em;font-variant-numeric:tabular-nums;}
      .hs{display:flex;flex-wrap:wrap;gap:13px;margin-top:7px;font-size:11.5px;color:${C.muted};font-family:${MONO};}
      .hs b{color:${C.sub};font-weight:400;}
      #spay-rec{color:${C.dn};cursor:help;font-size:10px;letter-spacing:.04em;font-family:${MONO};}
      #spay-iv{color:${C.warn};cursor:help;font-size:10px;letter-spacing:.04em;}
      #spay-dbg{margin-left:auto;color:${C.dim};font-size:9.5px;}

      .wrap{padding:10px 14px 12px;}
      canvas{display:block;width:100%;background:transparent;}
      .rsz{height:11px;margin:1px 0 0;cursor:ns-resize;display:grid;place-items:center;}
      .rsz span{display:block;width:34px;height:2px;border-radius:1px;background:${C.line2};transition:background .12s;}
      .rsz:hover span{background:${C.accent};}
      .mhdr{display:flex;align-items:center;gap:14px;margin:14px 0 4px;font-size:9px;letter-spacing:.12em;
            color:${C.muted};font-family:${MONO};text-transform:uppercase;}
      .mhdr .k{display:flex;align-items:center;gap:5px;}
      .mhdr .k:before{content:'';width:9px;height:2px;background:${C.accent};}
      .mhdr .k2:before{background:${C.ce};}
      .mhdr .mnow{margin-left:auto;color:${C.dim};letter-spacing:.04em;}

      /* greeks: one hairline-separated row, no boxes */
      .grk{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid ${C.line};}
      .grk>div{padding:9px 0 9px 12px;border-left:1px solid ${C.line};}
      .grk>div:first-child{border-left:none;padding-left:14px;}
      .gl{font-size:9px;letter-spacing:.12em;color:${C.muted};text-transform:uppercase;}
      .gv{font-size:16.5px;margin-top:4px;}

      /* risk: label/value pairs on a grid, no cards */
      .risk{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid ${C.line};}
      .rc{padding:10px 14px;border-left:1px solid ${C.line};border-top:1px solid ${C.line};}
      .rc:nth-child(-n+2){border-top:none;}
      .rc:nth-child(odd){border-left:none;}
      .rl{font-size:9px;letter-spacing:.12em;color:${C.muted};text-transform:uppercase;}
      .rv{font-size:15.5px;margin-top:4px;}
      .rs{font-size:10px;color:${C.dim};margin-top:3px;}

      .alert{display:flex;align-items:center;gap:10px;padding:9px 14px;font-size:12px;font-family:${MONO};
             border-top:1px solid ${C.line};border-left:2px solid;}
      .alert.bad{background:${C.badBg};border-left-color:${C.dn};color:${C.dn};}
      .alert.warn{background:${C.warnBg};border-left-color:${C.warn};color:${C.warn};}
      .alert.good{background:${C.goodBg};border-left-color:${C.up};color:${C.up};}
      .alert .ad{flex:1;} .alert .ax{background:none;border:none;color:inherit;cursor:pointer;font-size:11px;opacity:.6;}

      .cfg{padding:12px 14px;border-top:1px solid ${C.line};background:${C.card};}
      .cfg label{display:flex;align-items:center;gap:8px;font-size:9px;letter-spacing:.12em;color:${C.muted};
                 text-transform:uppercase;margin-bottom:7px;}
      .cfg label i{font-style:normal;color:${C.dim};letter-spacing:.04em;text-transform:none;font-size:10px;}
      .cfg input[type=number]{width:92px;background:${C.panel};border:1px solid ${C.line2};color:${C.text};
                 font-family:${MONO};font-size:12px;padding:5px 8px;border-radius:4px;font-variant-numeric:tabular-nums;}
      .cfg input[type=number]:focus{outline:none;border-color:${C.accent};box-shadow:0 0 0 2px ${C.accentRing};}
      .cfg .cks{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;padding-top:10px;border-top:1px solid ${C.line};}
      .cfg .ck{gap:6px;margin:0;cursor:pointer;letter-spacing:.1em;}
      .cfg .ck input{accent-color:${C.accent};}
      .cfgn{margin-top:10px;font-size:10px;color:${C.dim};line-height:1.5;letter-spacing:0;text-transform:none;}
      #spay-log{margin-top:10px;border-top:1px solid ${C.line};padding-top:8px;max-height:150px;overflow:auto;}
      .lg{font-family:${MONO};font-size:10.5px;padding:2px 0;color:${C.sub};}
      .lg span{color:${C.dim};margin-right:8px;}
      .lg.bad{color:${C.dn};}.lg.warn{color:${C.warn};}.lg.good{color:${C.up};}.lg.none{color:${C.dim};}

      /* pop-out window */
      body.pop{background:${C.bg};margin:0;padding:20px;}
      body.pop #spay{max-width:1180px;margin:0 auto;}
      #spay-legs{display:none;}
      body.pop #spay-legs{display:block;border-top:1px solid ${C.line};}
      #spay-legs table{width:100%;border-collapse:collapse;font-family:${MONO};font-size:12.5px;font-variant-numeric:tabular-nums;}
      #spay-legs th{text-align:right;color:${C.muted};font-weight:600;font-size:9px;letter-spacing:.12em;
                    text-transform:uppercase;padding:8px 14px;border-bottom:1px solid ${C.line};}
      #spay-legs td{text-align:right;padding:7px 14px;border-bottom:1px solid ${C.line};color:${C.sub};}
      #spay-legs th:first-child,#spay-legs td:first-child{text-align:left;color:${C.text};}
      #spay-legs tr:last-child td{border-bottom:none;}
    `; }
  function panelHTML(){ return `
      <div class="top" id="spay-top">
        <span class="wm">PAYOFF &amp; RISK</span>
        <span class="tools">
          <span class="live" id="spay-live"><span class="d"></span><span id="spay-lt">connecting</span></span>
          <button class="ic" id="spay-theme" title="Switch theme"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3" stroke-linecap="round"/></svg></button><button class="ic" id="spay-bell" title="Alerts"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4.6 6.6a3.4 3.4 0 0 1 6.8 0c0 2.4.7 3.4 1.1 3.8H3.5c.4-.4 1.1-1.4 1.1-3.8Z"/><path d="M6.5 12.4a1.6 1.6 0 0 0 3 0"/></svg></button>
          <button class="ic" id="spay-pop" title="Open in its own window"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M9.5 2.5H13.5V6.5"/><path d="M13.5 2.5 8.5 7.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg></button>
          <button class="ic" id="spay-min" title="Collapse"><svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 8h8"/></svg></button>
          <button class="ic" id="spay-close" title="Close"><svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg></button>
        </span>
      </div>
      <div class="books" id="spay-books"></div>
      <div class="hero">
        <div class="hl"><span class="lbl"><span id="spay-book">NIFTY</span> · DAY P&amp;L</span><span id="spay-rec" style="display:none" title="Our total does not match the portal's own Total MTM. Trust the portal until this clears."></span><span id="spay-iv" style="display:none" title="A leg's mark did not solve to a believable implied vol, so its greeks use an estimate."></span></div>
        <div class="hv" id="spay-day">—</div>
        <div class="hs">
          <span id="spay-spot">—</span><span id="spay-dte"></span>
          <span>open <b id="spay-mtm">—</b></span>
          <span id="spay-real" style="display:none"></span><span id="spay-tot" style="display:none"></span>
          <span id="spay-dbg"></span>
        </div>
      </div>
      <div class="alert" id="spay-alert" style="display:none"><span class="ad"></span><button class="ax" id="spay-ax">✕</button></div>
      <div class="cfg" id="spay-cfg" style="display:none">
        <label>Breakeven warn <input id="a-be" type="number" min="0" step="5"><i>pts</i></label>
        <label>P&amp;L profit at <input id="a-tgt" type="number" step="500"><i>₹ day P&amp;L · 0 = off</i></label>
        <label>P&amp;L loss at <input id="a-stop" type="number" step="500"><i>₹ negative · 0 = off</i></label>
        <label>Giveback from peak <input id="a-give" type="number" min="0" step="500"><i>₹ off the day high · 0 = off</i></label>
        <label>Delta limit <input id="a-dlt" type="number" min="0" step="5"><i>0 = off</i></label>
        <div class="cks">
          <label class="ck"><input id="a-on" type="checkbox">alerts on</label>
          <label class="ck"><input id="a-snd" type="checkbox">sound</label>
          <label class="ck"><input id="a-dsk" type="checkbox">desktop</label>
          <label class="ck"><input id="a-fls" type="checkbox">flash</label>
          <label class="ck"><input id="a-hl" type="checkbox">feed health</label>
        </div>
        <div class="cfgn">Alerts fire once per crossing and re-arm only after the value pulls back. Nothing fires while the feed is stale or frozen, or outside market hours.</div>
        <div id="spay-log"></div>
      </div>
      <div class="wrap">
        <canvas id="spay-cv" height="230"></canvas>
        <div class="rsz" id="spay-rsz" title="Drag to resize the payoff chart"><span></span></div>
        <div class="mhdr"><span class="k k1">Day P&amp;L</span><span class="k k2">Net delta</span><span class="mnow" id="spay-mnow"></span></div>
        <canvas id="spay-mtm-cv" height="150"></canvas>
      </div>
      <div class="grk">
        <div><div class="gl">Delta</div><div class="gv" id="g-d">—</div></div>
        <div><div class="gl">Gamma</div><div class="gv" id="g-g">—</div></div>
        <div><div class="gl">Theta / hr</div><div class="gv" id="g-t">—</div></div>
        <div><div class="gl">Vega</div><div class="gv" id="g-v">—</div></div>
      </div>
      <div class="risk">
        <div class="rc"><div class="rl">Breakevens</div><div class="rv" id="r-be">—</div><div class="rs" id="r-bes">safe zone</div></div>
        <div class="rc"><div class="rl">Max loss ±3%</div><div class="rv" id="r-ml">—</div><div class="rs">worst in stress range</div></div>
        <div class="rc"><div class="rl">Margin used</div><div class="rv" id="r-mg">—</div><div class="rs" id="r-mgs"></div></div>
        <div class="rc"><div class="rl">Decay left</div><div class="rv" id="r-dl">—</div><div class="rs">theta if pinned here</div></div>
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
    v('a-be', AL.be); v('a-tgt', AL.tgt); v('a-stop', AL.stop); v('a-give', AL.give); v('a-dlt', AL.dlt);
    c('a-on', AL.on); c('a-snd', AL.sound); c('a-dsk', AL.desktop); c('a-fls', AL.flash); c('a-hl', AL.health);
  }
  function wirePanel(){
    const mn = $id('spay-min'); if (mn) mn.onclick = () => { _mini = !_mini; const w = $id('spay-cv').parentElement; if (w) w.style.display = _mini ? 'none' : ''; };
    const cl = $id('spay-close'); if (cl) cl.onclick = () => { if (POP){ closePop(); return; } const h = document.getElementById('spay-host'); if (h) h.remove(); SR = null; };
    const po = $id('spay-pop'); if (po) po.onclick = () => { if (POP && !POP.closed) closePop(); else popOut(); };
    const rz = $id('spay-rsz');
    if (rz && !rz.__w){ rz.__w = 1;
      rz.addEventListener('pointerdown', e => {
        e.preventDefault(); const cv = $id('spay-cv'); if (!cv) return;
        const y0 = e.clientY, h0 = cv._H || 230; rz.setPointerCapture(e.pointerId);
        const mv = ev => { Store.payoffH = Math.max(150, Math.min(620, Math.round(h0 + (ev.clientY - y0)))); try { window.drawPayoff(); } catch (_) {} };
        const up = () => { rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up);
          try { localStorage.setItem(PAYOFF_H_KEY, String(Store.payoffH)); } catch (_) {} };
        rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
      });
    }
    const th = $id('spay-theme'); if (th) th.onclick = () => applyTheme(Store.theme === 'dark' ? 'light' : 'dark');
    const ax = $id('spay-ax'); if (ax) ax.onclick = () => { const b = $id('spay-alert'); if (b) b.style.display = 'none'; };
    const bell = $id('spay-bell');
    if (bell) bell.onclick = () => { const c = $id('spay-cfg'); if (!c) return; const show = c.style.display === 'none'; c.style.display = show ? '' : 'none'; if (show){ syncCfg(); renderLog(); } };
    const num = (id, key) => { const e = $id(id); if (!e) return; e.onchange = () => { AL[key] = parseFloat(e.value) || 0; alSave(); Object.keys(ALS).forEach(k => { ALS[k].armed = true; }); }; };
    num('a-be', 'be'); num('a-tgt', 'tgt'); num('a-stop', 'stop'); num('a-give', 'give'); num('a-dlt', 'dlt');
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
      cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); cv._cur = (e.clientX - r.left) * ((cv._W || r.width) / r.width); try { draw(); } catch (_) {} });
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
      w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Payoff & Risk — Straddly</title><style>' + panelCSS() + '</style></head><body class="pop" style="background:' + C.bg + '"><div id="spay">' + panelHTML() + '</div></body></html>');
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
    const cv = fitCanvas('spay-cv', 0.38, 230); if (!cv) return; const ctx = cv.getContext('2d'), W = cv._W, H = cv._H;
    const pos = window._bsLegs(), spot = window.getSpot();
    if (!pos.length || !spot){ ctx.fillStyle = C.muted; ctx.font = '13px ' + MONO; ctx.textAlign = 'center'; ctx.fillText('no open positions', W / 2, H / 2); return; }
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
    const L = 58, R = 14, Tp = 14, B = 26, CW = W - L - R, CH = H - Tp - B, X = s => L + ((s - lo) / (hi - lo)) * CW, Y = v => Tp + CH - ((v - yMin) / (yMax - yMin)) * CH;
    ctx.font = '10.5px ' + MONO;
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep){ const y = Y(v); ctx.strokeStyle = (Math.abs(v) < yStep * 0.01) ? C.line2 : C.line; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L - 5, y + 3); }
    for (let i = 0; i <= 5; i++){ const s = lo + (i / 5) * (hi - lo), x = X(s); ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + CH); ctx.stroke(); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(Math.round(s).toLocaleString('en-IN'), x, H - 8); }
    const z = Y(0); ctx.strokeStyle = C.line2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(L, z); ctx.lineTo(W - R, z); ctx.stroke(); ctx.setLineDash([]);
    const be = window._breakevens(pos);
    if (be){ [be.lower, be.upper].forEach(v => { if (v < lo || v > hi) return; const bx = X(v); ctx.strokeStyle = C.beLine; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(bx, Tp); ctx.lineTo(bx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.warn; ctx.textAlign = 'center'; ctx.fillText(Math.round(v), bx, Tp + 10); }); }
    const sx = X(spot); ctx.strokeStyle = C.spotLine; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(sx, Tp); ctx.lineTo(sx, Tp + CH); ctx.stroke(); ctx.setLineDash([]);
    // ── node-dot payoff: green above 0, red below (the "TradingAlgo" vibe) ──
    // Node-dot payoff: tinted region to the zero line, then evenly spaced markers joined by a thin line.
    // Dot spacing is derived from the chart's WIDTH, so they stay evenly spaced as the panel resizes.
    const zc = Math.max(Tp, Math.min(Tp + CH, z));
    const region = () => { ctx.beginPath(); ctx.moveTo(X(pN[0].s), zc); pN.forEach(q => ctx.lineTo(X(q.s), Y(q.p))); ctx.lineTo(X(pN[N].s), zc); ctx.closePath(); };
    ctx.save(); ctx.beginPath(); ctx.rect(L, Tp, CW, Math.max(0, zc - Tp)); ctx.clip(); region(); ctx.fillStyle = C.upFill; ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(L, zc, CW, Math.max(0, Tp + CH - zc)); ctx.clip(); region(); ctx.fillStyle = C.dnFill; ctx.fill(); ctx.restore();
    const gap = 13, want = Math.max(14, Math.min(70, Math.round(CW / gap)));
    const step = Math.max(1, Math.round(N / want)), nodes = [];
    for (let i = 0; i <= N; i += step) nodes.push(pN[i]);
    if (nodes[nodes.length - 1] !== pN[N]) nodes.push(pN[N]);
    ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
    for (let i = 1; i < nodes.length; i++){
      ctx.strokeStyle = (nodes[i - 1].p >= 0 && nodes[i].p >= 0) ? C.up : (nodes[i - 1].p < 0 && nodes[i].p < 0) ? C.dn : C.muted;
      ctx.beginPath(); ctx.moveTo(X(nodes[i - 1].s), Y(nodes[i - 1].p)); ctx.lineTo(X(nodes[i].s), Y(nodes[i].p)); ctx.stroke(); }
    nodes.forEach(q => { ctx.beginPath(); ctx.arc(X(q.s), Y(q.p), 2.7, 0, 7); ctx.fillStyle = q.p >= 0 ? C.up : C.dn; ctx.fill(); });
    const at = pN.reduce((b, q) => Math.abs(q.s - spot) < Math.abs(b.s - spot) ? q : b);
    ctx.beginPath(); ctx.arc(X(at.s), Y(at.p), 4.6, 0, 7); ctx.fillStyle = at.p >= 0 ? C.up : C.dn; ctx.fill();
    ctx.strokeStyle = C.panel; ctx.lineWidth = 2; ctx.stroke();
    const ds = dte >= 1 ? dte.toFixed(1) + 'd' : (dte * 24).toFixed(1) + 'h'; ctx.fillStyle = C.muted; ctx.font = '10.5px ' + MONO; ctx.textAlign = 'left'; ctx.fillText('DTE ' + ds, L + 2, Tp + 11);
    // hover crosshair
    if (cv._cur != null){ const sX = lo + ((cv._cur - L) / CW) * (hi - lo); const nb = pN.reduce((b, p) => Math.abs(p.s - sX) < Math.abs(b.s - sX) ? p : b, pN[0]); const cx = X(nb.s); ctx.strokeStyle = C.hair; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(cx, Tp); ctx.lineTo(cx, Tp + CH); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(cx, Y(nb.p), 3, 0, 7); ctx.fillStyle = C.dot; ctx.fill(); const lbl = Math.round(nb.s).toLocaleString('en-IN') + '  ' + money(nb.p); ctx.font = '11.5px ' + MONO; const tw = ctx.measureText(lbl).width + 16; let tx = cx + 8; if (tx + tw > W - 2) tx = cx - tw - 8; tx = Math.max(2, tx); ctx.fillStyle = C.tipBg; ctx.fillRect(tx, Tp + 2, tw, 18); ctx.strokeStyle = C.line2; ctx.strokeRect(tx, Tp + 2, tw, 18); ctx.fillStyle = nb.p >= 0 ? C.up : C.dn; ctx.textAlign = 'left'; ctx.fillText(lbl, tx + 7, Tp + 15); }
  };

  // ══ MTM CURVE (dual axis: ₹ left, net delta right) ═════════════════════════
  const MIN_SPAN = 1800, GAP_S = 45, Y_FLOOR = 1000; // 30-min minimum frame; don't draw across recording gaps
  window.drawMtm = function (){
    const cv = fitCanvas('spay-mtm-cv', 0.22, 150); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv._W, H = cv._H;
    const a = Store.hist[activeBook()] || [];
    if (a.length < 2){ ctx.fillStyle = C.muted; ctx.font = '12px ' + MONO; ctx.textAlign = 'center'; ctx.fillText(a.length ? 'recording…' : 'day P&L starts recording now', W / 2, H / 2); return; }
    const L2 = 60, R = 52, Tp = 12, B = 21, CW = W - L2 - R, CH = H - Tp - B;
    // left-anchored, minimum 30-minute frame so the curve grows into a stable window instead of rescaling every tick
    const t0 = a[0][0], span = Math.max(MIN_SPAN, a[a.length - 1][0] - t0);
    const X = t => L2 + ((t - t0) / span) * CW;
    // Raw day P&L is a tick-by-tick series and reads as noise. Smooth it for DISPLAY with a centred moving
    // average — the stored samples and the hover readout stay raw, so no number is ever fabricated.
    const raw = a.map(p => p[1] + (p[3] || 0)), rawD = a.map(p => p[2]);
    const win = Math.max(1, Math.min(9, Math.round(a.length / 40) * 2 + 1));
    const smooth = arr => { if (win < 2) return arr.slice(); const h = (win - 1) / 2;
      return arr.map((_, i) => { let sum = 0, c = 0;
        for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++){ sum += arr[j]; c++; }
        return sum / c; }); };
    const ms = smooth(raw), ds = smooth(rawD);
    let lo = Math.min(0, ...ms), hi = Math.max(0, ...ms);
    if (hi - lo < Y_FLOOR){ const c = (hi + lo) / 2; lo = c - Y_FLOOR / 2; hi = c + Y_FLOOR / 2; } // don't zoom into tick noise
    const mStep = niceStep(((hi - lo) || 1000) / 3);
    const mMin = Math.floor(lo / mStep) * mStep, mMax = Math.ceil(hi / mStep) * mStep;
    const Y = v => Tp + CH - ((v - mMin) / ((mMax - mMin) || 1)) * CH;
    let dMin = Math.min(...ds), dMax = Math.max(...ds);
    if (dMax - dMin < 1){ const c = (dMax + dMin) / 2; dMin = c - 1; dMax = c + 1; }
    const dp = (dMax - dMin) * 0.18; dMin -= dp; dMax += dp;
    const YD = v => Tp + CH - ((v - dMin) / ((dMax - dMin) || 1)) * CH;
    ctx.font = '10.5px ' + MONO;
    for (let v = mMin; v <= mMax + 1e-9; v += mStep){ const y = Y(v);
      ctx.strokeStyle = Math.abs(v) < mStep * 0.01 ? C.line2 : C.line; ctx.beginPath(); ctx.moveTo(L2, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText(moneyK(v), L2 - 5, y + 3); }
    [dMin, (dMin + dMax) / 2, dMax].forEach(v => { ctx.fillStyle = C.ce; ctx.textAlign = 'left'; ctx.fillText(v.toFixed(0), W - R + 5, YD(v) + 3); });
    for (let i = 0; i <= 3; i++){ const t = t0 + (i / 3) * span, x = X(t);
      ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + CH); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(hhmm(t), x, H - 6); }
    // split into contiguous runs — a jump means we weren't recording (other book / tab closed / reload)
    const runs = []; let st = 0;
    for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] > GAP_S){ runs.push([st, i - 1]); st = i; }
    runs.push([st, a.length - 1]);
    const z = Math.max(Tp, Math.min(Tp + CH, Y(0)));
    runs.forEach(([s0, s1]) => {
      if (s1 <= s0) return;
      const area = () => { ctx.beginPath(); ctx.moveTo(X(a[s0][0]), z); for (let i = s0; i <= s1; i++) ctx.lineTo(X(a[i][0]), Y(ms[i])); ctx.lineTo(X(a[s1][0]), z); ctx.closePath(); };
      ctx.save(); ctx.beginPath(); ctx.rect(L2, Tp, CW, Math.max(0, z - Tp)); ctx.clip(); area(); ctx.fillStyle = C.upArea; ctx.fill(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(L2, z, CW, Math.max(0, Tp + CH - z)); ctx.clip(); area(); ctx.fillStyle = C.dnArea; ctx.fill(); ctx.restore();
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
      const nb = a[ni], nv = raw[ni], cx = X(nb[0]); // hover reports the RAW sample, not the smoothed line
      ctx.strokeStyle = C.hair; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(cx, Tp); ctx.lineTo(cx, Tp + CH); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(cx, Y(nv), 3, 0, 7); ctx.fillStyle = C.dot; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, YD(rawD[ni]), 2.6, 0, 7); ctx.fillStyle = C.ce; ctx.fill();
      const lbl = hhmm(nb[0]) + '  ' + money(nv) + (nb[3] ? '  (R ' + money(nb[3]) + ')' : '') + '  Δ' + nb[2];
      ctx.font = '11.5px ' + MONO; const tw = ctx.measureText(lbl).width + 16;
      let tx = cx + 8; if (tx + tw > W - 2) tx = cx - tw - 8; tx = Math.max(2, tx);
      ctx.fillStyle = C.tipBg; ctx.fillRect(tx, Tp + 2, tw, 18);
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
  const AL = { on: true, sound: true, desktop: false, flash: true, health: true, be: 40, tgt: 0, stop: 0, give: 0, dlt: 0 };
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
      if (AL.tgt > 0){ if (day >= AL.tgt) fire(u + ':tgt', 'good', u + ' PROFIT TARGET', 'day P&L ' + money(day) + ' (target ' + money(AL.tgt) + ')'); else rearm(u + ':tgt', day < AL.tgt * 0.9); }
      if (AL.stop < 0){ if (day <= AL.stop) fire(u + ':stop', 'bad', u + ' LOSS LIMIT', 'day P&L ' + money(day) + ' (limit ' + money(AL.stop) + ')'); else rearm(u + ':stop', day > AL.stop * 0.9); }
      // giving back an open profit is the loss a premium seller actually feels, and no target/stop catches it
      if (AL.give > 0){ const pk = Store.peak[u] || 0, back = pk - day;
        if (pk > 0 && back >= AL.give) fire(u + ':give', 'warn', u + ' GIVING BACK', money(back) + ' off the day high of ' + money(pk) + ' — now ' + money(day));
        else rearm(u + ':give', back < AL.give * 0.6); }
      if (AL.dlt > 0){ const nd = window._netGreeks(lg, sp).nD;
        if (Math.abs(nd) >= AL.dlt) fire(u + ':dlt', 'warn', u + ' delta ' + nd.toFixed(1), 'book has drifted directional (limit ' + AL.dlt + ')');
        else rearm(u + ':dlt', Math.abs(nd) < AL.dlt * 0.8); }
    });
  }
  function renderLog(){
    const el = $id('spay-log'); if (!el) return;
    const html = ALOG.length
      ? ALOG.slice(0, 12).map(a => '<div class="lg ' + a.sev + '"><span>' + hhmm(Math.round(a.t / 1000)) + '</span>' + a.msg.replace(/</g, '&lt;') + '</div>').join('')
      : '<div class="lg none">no alerts yet today</div>';
    if (el.__sig === html) return; el.__sig = html;
    el.innerHTML = html;
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
    if (el.__sig === rows) return; el.__sig = rows; // only touch the DOM when content actually changed
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
      try {
        const mtmU = lg.reduce((s, p) => s + p.pnl, 0), dayU = mtmU + (Store.realised[u] || 0);
        if (!(Store.peak[u] > dayU)) Store.peak[u] = dayU;   // intraday high-water mark of day P&L
        histPush(u, mtmU, window._netGreeks(lg, sp).nD);
      } catch (e) {}
    });
  }
  window.refreshAll = function (){
    if (!SR || !$id('spay')) return;
    memClear(); // start a new frame
    // Always write the colour — clearing it to '' when none is given. Leaving the previous inline colour
    // in place meant a value coloured under one theme kept that colour after switching to the other.
    const set = (id, v, c) => { const e = $id(id); if (!e) return; e.textContent = v; e.style.color = c || ''; };
    const pos = window._bsLegs(), spot = window.getSpot(), book = activeBook(), mtm = window._bookMTM(), total = window.getOpenMTM();
    renderBooks(book);
    set('spay-book', book);
    set('spay-spot', (spot ? spot.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—') + ' spot');
    const day = mtm + (Store.realised[book] || 0);
    set('spay-day', pos.length ? money(day) : '—', pos.length ? col(day) : C.muted);
    set('spay-mtm', pos.length ? money(mtm) : '—', pos.length ? col(mtm) : C.muted);
    // Reconciliation: our number must agree with the portal's own printed total, or we say so out loud.
    const rec = $id('spay-rec');
    if (rec){
      const pm = Store.portalMTM;
      if (pm == null || !Store.posVisible){ rec.style.display = 'none'; Store.mismatch = 0; }
      else { const diff = total - pm; Store.mismatch = diff;
        const bad = Math.abs(diff) > Math.max(5, Math.abs(pm) * 0.01);
        rec.style.display = bad ? '' : 'none';
        if (bad) rec.textContent = '≠ PORTAL ' + money(pm) + ' (off by ' + money(diff) + ')';
      }
    }
    const rl = $id('spay-real'); const rv = Store.realised[book] || 0;
    if (rl){ rl.style.display = rv ? '' : 'none'; if (rv){ rl.textContent = 'booked ' + money(rv); rl.style.color = col(rv); } }
    const tot = $id('spay-tot'); if (tot){ const multi = underlyings().length > 1; tot.style.display = multi ? '' : 'none'; if (multi){ tot.textContent = 'all books ' + money(total); tot.style.color = col(total); } }
    if (pos.length && spot){ const K = window._getPosCtx(pos, spot), dte = K.dte; set('spay-dte', dte < 1 ? Math.floor(dte * 24) + 'h ' + Math.round((dte * 24 % 1) * 60) + 'm to expiry' : dte.toFixed(1) + 'd to expiry');
      const iw = $id('spay-iv');
      const estSplit = pos.filter(l => l._est).length;
      if (iw){ const msg = K.ivBad ? K.ivBad + ' LEG IV ESTIMATED' : (estSplit ? 'STRADDLE SPLIT ESTIMATED' : '');
        iw.style.display = msg ? '' : 'none'; if (msg) iw.textContent = msg; }
      const G = window._netGreeks(pos, spot); set('g-d', G.nD.toFixed(1), col(G.nD)); set('g-g', G.nG.toFixed(3), C.dn); set('g-t', '₹' + Math.abs(G.nT / 6.25).toFixed(0), C.up); set('g-v', G.nV.toFixed(0), C.dn);
      const stress = [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03].map(s => window._bsPnl(pos, spot * (1 + s), K, 0)); set('r-ml', money(Math.min(0, ...stress)), C.dn);
      const be = window._breakevens(pos); if (be){ const inside = spot >= be.lower && spot <= be.upper, near = Math.min(Math.abs(be.upper - spot), Math.abs(spot - be.lower)); set('r-be', Math.round(be.lower).toLocaleString('en-IN') + '–' + Math.round(be.upper).toLocaleString('en-IN')); set('r-bes', inside ? near.toFixed(0) + ' pt to edge' : 'OUTSIDE', inside ? C.muted : C.dn); } else { set('r-be', '—'); set('r-bes', ''); }
      const decay = pos.reduce((a, l) => { const it = l.type === 'CE' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot); return a + (l.ltp - it) * (-l.qty); }, 0); set('r-dl', money(decay), decay >= 0 ? C.up : C.dn);
    } else { ['g-d','g-g','g-t','g-v','r-ml','r-be','r-dl'].forEach(id => set(id, '—', C.muted)); set('spay-dte', ''); set('spay-day', '—', C.muted); }
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
    const pb = $id('spay-pop'); if (pb){ const on = POP && !POP.closed; pb.classList.toggle('act', !!on); pb.title = on ? 'Dock back into the page' : 'Open in its own window'; } // never overwrite the icon markup
    const mAge = Store.markAt ? Date.now() - Store.markAt : -1;
    set('spay-dbg', (Store.dbg || '') + (mAge >= 0 ? ' · mark ' + fmtAge(mAge) : ''));
    positionPanel();
    const mn = $id('spay-mnow');
    if (mn){ const h = Store.hist[book] || []; mn.textContent = h.length ? h.length + ' pts · since ' + hhmm(h[0][0]) + ' · smoothed' : ''; }
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
    window.SPAY._fn = { AL, ALS, ALOG, evalAlerts, scrapePortalMTM, plausibleSpot, spotFor, expandLegs, parseSymbol, marketState, istNow, dayKey, scrapePositions, reconcileRealised, histPush, marketConsts: { OPEN_H, OPEN_M, CLOSE_H, CLOSE_M, IV_MIN, IV_MAX } };
    alLoad(); histLoad();
    try { Store.payoffH = parseInt(localStorage.getItem(PAYOFF_H_KEY), 10) || 0; } catch (e) {}
    buildPanel();
    try { applyTheme(localStorage.getItem(THEME_KEY) || 'dark'); } catch (e) {} Store.onUpdate(() => { try { window.refreshAll(); } catch (e) {} });
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
