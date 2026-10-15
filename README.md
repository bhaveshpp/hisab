# દુકાન હિસાબ — Shop daily accounts (Google Sheet + Apps Script + GitHub Pages)

Built on the Finance engine, **all labels in Gujarati**. Types: **વેપાર** (+ green) · **ખર્ચા** (− red) · **ઉપાડ** (− blue, money taken home) · **ટ્રાન્સફર** (રોકડ ↔ બેંક, never counted as વેપાર / ખર્ચા).

```
backend/Code.gs   → Apps Script        site/ → index · home (આજ) · analysis (હિસાબ) · accounts (ખાતા) · categories (કેટેગરી) · common.js · store.js · common.css
tests/            → node tests (see bottom)
```

## Setup (everything is created automatically)
1. New Google Sheet → Extensions → Apps Script → paste `backend/Code.gs`.
2. Run **`setupSheets`** once → creates the tabs **વપરાશકર્તા · વ્યવહાર · ખાતા · કેટેગરી · હિસાબ**, the accounts **રોકડ** + **બેંક**, and the default categories:
   - વેપાર: **રોકડ** (→ રોકડ ખાતું) · **ઓનલાઇન** (→ બેંક)
   - ખર્ચા: ચા-નાસ્તો · કારીગર પગાર · લાઇટ બિલ · સ્ટેશનરી · ભાડું · અન્ય  (karigar nu naam નોંધ ma)
   - ઉપાડ: ઘર ખર્ચ · અન્ય
3. Edit `createUser` (username / name / password / role) → run it. Run it again for more users (bhai = એડિટ, papa = વ્યૂ).
4. Deploy → New deployment → Web app (Execute as *Me*, Access *Anyone*) → paste the URL into `API_URL` in `site/common.js` → upload `site/` to GitHub Pages.
Update later: paste Code.gs → Deploy → Manage deployments → pencil → *New version*.

## Users (વપરાશકર્તા tab)
| Role | Can see | Can edit |
|---|---|---|
| **એડમિન** | everything | everything |
| **એડિટ** | pages in Access | only those: `આજ` = entries · `ખાતા` = accounts · `કેટેગરી` = categories |
| **વ્યૂ** | pages in Access | nothing |
Access = e.g. `આજ, હિસાબ` (pages: આજ, હિસાબ, ખાતા, કેટેગરી; English names also work). Blank Role = વ્યૂ, blank Access = no page. The script filters what it sends (balances only with `ખાતા`, notes only with `આજ`, …) and refuses forbidden writes.

## App
- **આજ**: one day (‹ › or date picker) — વેપાર / ખર્ચા / ઉપાડ / બચ્યું and that day's list; `+` adds. New entry opens on **વેપાર**; choosing કેટેગરી *રોકડ / ઓનલાઇન* fills the ખાતું (રોકડ / બેંક) — change it by hand if needed.
- **હિસાબ**: month (default) / વર્ષ / કસ્ટમ — **બચ્યું = વેપાર − ખર્ચા − ઉપાડ**, category-wise (વેપાર રોકડ vs ઓનલાઇન too), day-wise graph. The sheet's own **હિસાબ** tab does the same with FROM / TO in B1 / B2.
- **ખાતા / કેટેગરી**: add / edit; **no delete — નિષ્ક્રિય** hides it from new entries but keeps history. Each category can have a **ડિફોલ્ટ ખાતું**.
- Local-first like Finance: all data cached (5 min), entries instant + background save (⚠ retry), ⟳ refresh, password change, works offline.

## Notes
- Values in the sheet are Gujarati (વેપાર, ખર્ચા, ઉપાડ, ટ્રાન્સફર, સક્રિય / નિષ્ક્રિય, એડમિન / એડિટ / વ્યૂ); headings stay English. Use the dropdowns.
- The sheet formulas (Current_Balance, હિસાબ tab, QUERY) are checked for syntax only — open the sheet once and look at them.
- Own separate Sheet + URL (not the personal Finance sheet).
- Tests: `node tests/dukan_gs_test.js` (41) · `node tests/dukan_analysis_test.js` (11) · `node tests/dukan_dom_test.js` (52, needs `npm i jsdom`).
