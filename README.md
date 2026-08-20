# Straddly Pro Overlay

A lightweight risk/position dashboard that overlays on the [Straddly](https://new.straddly.com)
options-trading terminal. Live MTM, greeks, payoff, risk, P&L attribution, strategy book, and
slippage — read straight from your own account.

> Runs as a **Tampermonkey userscript**. It reads only the Straddly API traffic your browser
> already makes. **Nothing leaves your machine** — there is no server, no tracking, no data sent
> anywhere. It works on *your* logged-in account.

## Install (1 minute)

1. Install the **[Tampermonkey](https://www.tampermonkey.net/)** browser extension.
2. Click **[straddly-pro.user.js](https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/straddly-pro.user.js)**
   — Tampermonkey will open a 1-click **Install** page.
   *(If it shows raw text instead, open Tampermonkey → Dashboard → **+** → paste the file → Ctrl+S.)*
3. Open **https://new.straddly.com** and log in. The panel appears top-left. Drag it anywhere.

You'll get **automatic updates** whenever a new version is published.

## What you need
- A **Straddly** account (it only runs on straddly.com).
- Tampermonkey installed once.

## Tabs
**Payoff · Risk · P&L (curve + attribution) · Book (strategy groups) · Costs (charges + slippage) · Order (preview) · Notes**

Plus an always-on header: total MTM, open/closed, NIFTY spot, greeks, margin, target/SL, and your breakeven band.

## Notes
- Order placement is **preview only** by design (it never fires live orders).
- Found a bug or have feedback? Use the **✉ Send feedback** link in the panel footer.

---

# Payoff & Risk (mini)

A compact, fixed panel for the trade page — **position payoff diagram + greeks + risk metrics**, nothing else.
Dark "terminal" styling with a dotted green/red payoff curve.

**Install:** Tampermonkey → click
**[straddly-payoff.user.js](https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/straddly-payoff.user.js)**
→ Install → open your Straddly trade page.

Shows: payoff (BS-now, green profit / red loss) with breakeven band, net Δ/Γ/Θ/Vega, max-loss (stress),
breakevens + distance, margin used, decay-left. Hover the chart for spot + P&L. Same privacy — nothing leaves your browser.

- **Multi-book** — NIFTY / BANKNIFTY / SENSEX each get their own tab, own spot, own payoff. Header shows the
  selected book's MTM plus an **ALL** total.
- **Pop out (⤡)** — opens the dashboard in its own window for a second monitor, with a per-leg table.
  Keep the portal tab open; it's the data source.
- **Live sync** — mirrors the portal within ~1ms of it updating (MutationObserver, not polling). The small
  grey readout in the header shows how fresh the numbers are.
- **MTM curve** — intraday P&L (₹, left axis, green above zero / red below) with **net delta** on the right
  axis, so you can see position drift against the P&L that followed it. Hover for time + MTM + Δ.
  Recorded per book every 3s and kept in `localStorage` for the trading day, so a reload doesn't lose the
  morning. It starts empty and fills as the session runs — history can't be reconstructed retroactively.
  The curve is **day P&L = open MTM + booked**, so exiting a leg doesn't drop a step in it; the header shows
  `booked ₹x` once anything is closed. Keeps recording on the Orders/Baskets tabs via its own quote poll.

**Status is honest.** The badge describes *your marks*, not network activity: `live` (fresh),
`delayed 12s`, `STALE 2m`, `FROZEN 4m` (market open but nothing is moving — a closed exchange serves a
frozen feed, not an empty one), or `closed` outside 09:15–15:40 IST. If a leg's mark won't solve to a
believable implied vol, the header says `⚠ 1 leg IV est` rather than quietly inventing greeks.

**Your session token never leaves the closure** it's captured in — it is deliberately kept off the
`window.SPAY` debug object so nothing else running on the broker's page can read it.

**Tests:** open [`tests.html`](tests.html) next to the script to re-run the suite (pricing, implied vol,
P&L signs, mixed expiries, realised-on-exit, session hours, day rollover).

> If your broker serves the trade page at a **new URL**, add it to the `@match` lines at the top of the script.

---

# Backoffice Analytics Pro (companion)

A post-trade **performance dashboard** that overlays on the Straddly backoffice (`backoffices.pro`) —
turns your trade journal into institutional-grade analytics.

**Install:** Tampermonkey → click
**[backoffice-pro.user.js](https://raw.githubusercontent.com/GreenLeaf444/straddly-pro-overlay/main/backoffice-pro.user.js)**
→ Install → open **backoffices.pro** → Reports → set a wide date range.

**Tabs:** Overview (win rate · profit factor · expectancy · payoff · R/MaxDD · Sortino · Sharpe · return-on-capital) ·
Equity (curve + drawdown) · Daily (bars + calendar heatmap + monthly) · Trades (by type / 0DTE / weekday + histogram) ·
Edge (rolling expectancy · tail risk: skew/kurtosis/CVaR · premium-capture) · Costs (cost-drag) · Monte Carlo (forward projection) · Sizing (Kelly).
Hover any chart for date + value tooltips. Same privacy — nothing leaves your browser.

---
*Not affiliated with Straddly. Use at your own risk — this is a personal tool shared with friends.*
