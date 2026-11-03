# Projects the GQuants agent knows about

This file is the agent's map of the four repos. `read_docs` serves the matching
section to the model, and the system prompt carries a one-line version of each
from `projects.js`. It was written by reading each repo on 2026-11-01. When a
repo changes shape, update this file. Do not trust it over the code.

All four repos live under GitHub owner `dheerajburli86` on branch `main`.

---

## heatmap-dashboard (`heatmap-dashboard`)

**What it is:** the GQuants market heatmap. It is a React + Vite single-page app
deployed on Vercel. A Python `pipeline/` package and several Railway services
keep a Supabase database (project "heatmap dashboard", ap-south-1) current.

- **Universes:** India stocks, ETFs and indices (Zerodha Kite); US stocks, ETFs
  and indices (Massive, with an FMP fallback for blocked indices); Global stocks,
  ETFs and indices across about 39 countries (FMP); crypto, commodities and
  currency ETFs.
- **Data model:** `instruments` is the universe. `price_history` holds daily bars.
  `returns_latest` holds 1d to all-time returns. `fundamentals` holds FMP
  statements. `tech_*` tables hold the nightly technical scan.
  `india_volume_daily` holds NSE/BSE/total volume.
- **Taxonomy:** one GICS taxonomy (11 sectors, 25 industry groups) for every
  market, in `pipeline/taxonomy/gics.py`. The frontend copy, `src/utils/gics.js`,
  is generated from it.
- **Services:**
  - `india-live`: Kite ticker plus the India EOD, 16:10 IST.
  - `us-live`: Massive feed plus the US EOD, 16:02 ET.
  - Three Railway batch crons: global prices, fundamentals, technical analysis.
  - `alerts-live`: Telegram and web-push alerts for watchlists.
  - `team-agent`: the earlier single-project assistant (this standalone agent supersedes it).
- **Known state worth knowing:** FMP fundamentals fetches are paused (owner's
  decision, 2026-10-27). India prices publish the official close until 18:30
  IST and the last trade after that. `CLAUDE.md` in the repo holds the
  operating notes and is the best first read.
- **Live data:** yes. The agent has read-only tools over allowlisted tables and
  RPCs.

## busybee (`busybee`)

**What it is:** BusyBee, GQuants' internal work-management app. It is a
Next.js 15 (App Router, TypeScript, Tailwind) app on Vercel, backed by its own
Supabase project in the "secondary projects" org.

- **Features, from `app/(app)` and `app/api`:**
  - Tasks with assignors, review and acceptance, deadline extensions,
    adjustments, dependencies, subtasks, attachments, comments and activity
  - Projects with project-based access, OKRs, timesheet, and payroll (renamed
    IROP)
  - Documents and folders, chat rooms, to-do lists, reports and search
  - An "Ask" page (`lib/ask.ts`) and a heatmap view
- **Notifications:** in-app, email (Gmail or Resend), Telegram, and web push.
- **Scheduler:** `scheduler/main.py` is a Python service on Railway. It runs
  deadline reminders (24, 8 and 6 hours), overdue alerts, start-of-day and
  end-of-day summaries, "no update" nudges, and auto-archiving.
- **Schema:** `supabase/migrations` (Sept–Oct 2026), covering project-based
  access, workflow, Telegram and email alerts, to-do lists, push, and soft
  delete.
- **Docs:** the repo has no README or CLAUDE.md. The scheduler's module
  docstring and the migrations are the best written description.
- **Live data:** not wired. Its Supabase sits in a separate org and needs its
  own key.

## gq-finxray-us (`gq-finxray-us`)

**What it is:** GQ FinXray US. It is a Python worker (`Procfile`:
`worker: python main.py`) that watches US markets and sends feature-tagged
alerts to Telegram. Supabase project `gq-finxray-us`, ap-northeast-2.

- **13 alert features:**
  1. SEC EDGAR filings
  2. Company and sector news (FMP plus RSS)
  3. Result snapshots
  4. Earnings calendar and EPS surprise
  5. Insider and large deals
  6. Technical alerts (Massive and FMP)
  7. ETF flow
  8. IPO deep dive
  9. Sector heatmap image
  10. Earnings-call transcripts
  11. Analyst ratings
  12. Macro and policy digest
  13. Watchlist heatmap
  Since October 2026 there are also ETF signals and mutual-fund pollers:
  holdings, expenses, managers and schemes.
- **Pipeline:**
  1. Pollers write `raw_filings` with status PENDING.
  2. `ai_pipeline.py` runs a gibberish check, a relevance check, and then
     summarisation with a retry ladder.
  3. It then runs validation, impact classification and dedup.
  4. Results go to `alerts`, and delivery sends them to Telegram.
  5. Failures go to `flagged_summaries`.
  The LLM is Gemini 2.5 Flash via DeepInfra. Prompts live in the `Prompt_*.py`
  files.
- **Main tables:** `alerts`, `raw_filings`, `watchlists`, `users`, `stocks`,
  `etf_master`, `mf_*`, `payload_log`, `poller_error_log`.
- **Docs:** `README.md` (a fix bundle note),
  `US_DATA_COLLECTION_SOURCES_AND_PROCESSING_SUMMARY.md` (the best overview),
  `CHANGES_TO_AI_PIPELINE.md` and `WATCHLIST_EXPANSION_INSTRUCTIONS.md`. That
  summary flags a licensing risk: FMP and Massive personal tiers prohibit
  redistribution.
- **Live data:** not wired. It is a separate Supabase project and needs its own
  key.

## GDP-Macro-Dashboard (`gdp-macro-dashboard`)

**What it is:** an India GDP nowcast dashboard. It is a React 18 + Vite +
Recharts front end with no backend.

- **Structure:** GDP is broken into its expenditure constituents: Consumption
  (C), Investment (I), Government (G), Net Exports (NX), plus a Cross-Cutting
  group. Together they hold 53 monthly indicators, defined in
  `src/config/indicators.js`. Examples include FMCG volume, two-wheeler sales,
  UPI, cement, steel, IIP capital goods, PMIs and FDI.
- **Views:** Home tiles, a constituent panel, and a focused indicator view with
  MoM and YoY changes, monthly or yearly toggles, and an FY-quarter nowcast
  label.
- **Data:** `src/lib/data.js` loads `/data/indicators.json` (or `VITE_DATA_URL`).
  The expected payload is `{updated, nowcast:{quarter,value}, series:{<id>:[{date,value,unit}]}}`.
  Until a feed is connected it shows **deterministic dummy data**
  (`src/lib/dummy.js`). So the repo holds no real figures: any number on screen
  today is a placeholder.
- **Not in this repo:** the 1991–2024 India composite index (13 and 20
  indicators, four dimensions, Colab plus an Excel workbook) is not in this
  repository. If it should be queryable, it has to be added to the repo or
  given a data source.
- **Docs:** none (no README or CLAUDE.md). The comments in `data.js`,
  `indicators.js` and `dummy.js` are the documentation.
- **Live data:** none.
