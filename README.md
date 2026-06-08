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
*Not affiliated with Straddly. Use at your own risk — this is a personal tool shared with friends.*
