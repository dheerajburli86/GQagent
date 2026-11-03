# GQuants Agent

A Telegram bot for the GQuants team. Ask it anything, or give it ongoing work:
**scheduled monitoring tasks** run on their own (every 30 minutes, every morning,
weekdays at 9:15…) and post only what's new: news on holdings, sectors, countries,
themes, companies you're watching. It answers from the team's
projects (their code, docs, commit history and, where selected, live market
data), searches the web, reads PDFs and CSVs you send, does exact calculations,
and answers general questions in English, Hindi or Hinglish.

It **reads** everything it is connected to, and **changes** only what it can change
safely: BusyBee tasks (through BusyBee's own rules), rows in the heatmap and FinXray
databases (only after the person taps Confirm), and the asker's own dashboard
watchlists. It never changes code or servers. When it can't do something it says so,
with the reason. It gives no buy, sell or hold advice and no price targets.

**Setup and deployment: see [DEPLOY.md](DEPLOY.md).**

## What it can do

| Ask about | Example |
|---|---|
| Your projects (code, docs) | "Where is the India EOD pipeline defined, and what does each step do?" |
| What changed recently | "What changed in BusyBee in the last 7 days?" |
| Live market data (if enabled) | "Top 10 Indian stocks by 1-month return, with the as-of date" |
| Files you send | PDF, Excel (.xlsx, every sheet), Word (.docx), PowerPoint (.pptx), CSV, text, code; remembered for follow-up questions |
| The web | "What did RBI announce at its latest policy meeting?" |
| Choosing the AI | untagged → DeepInfra · `@grok …` → Grok with live web search · `@grok @deepinfra …` → both, merged by DeepInfra into one answer |
| Every project's live data | "Who has overdue tasks in BusyBee?" · "What alerts did FinXray send today?" · "Which heatmap pipeline failed last night?" (team members) |
| BusyBee actions | "Assign Asha a task to update the Q3 deck by Friday 5 pm" · "Mark my Fix tile task done" |
| Company filings | "Latest concall transcript of HDFC Bank: key points" · "NVIDIA's last 6 quarters of revenue and operating cash flow from its SEC filings" |
| Macro news by country | "What did the Bank of Japan decide?" · "Macro news this week for all our countries" |
| Team watchlists | "Any news on our India holdings this week?" (after `/list add india-holdings …`) |
| Exact maths | "EMI on ₹50 lakh at 9% for 20 years" |
| Exchange rates, crypto, weather | "USD to INR today, and on 1 Jan 2025" |
| General questions | "Explain XIRR vs CAGR with an example" |
| **Ongoing monitoring** | "Every weekday at 9:15, send India macro and banking news" · "Alert me every 2 hours on big news about TCS, Infosys, HCL" |

More in [docs/SAMPLE_QUESTIONS.md](docs/SAMPLE_QUESTIONS.md).

## How it works

```
Telegram (direct messages, or a team group where the bot is called)
   │  long polling: the service asks Telegram for messages; no public URL needed
   ▼
bot.js     who may ask (allowlist by Telegram user ID, listed groups only),
           commands, project picker, files you send, one question at a time per chat
   │
   ▼
agent.js   the tool loop: model → tool calls → results → model … (step, time and budget limits)
   │        model: DeepInfra google/gemini-2.5-flash (optional fallback model, same key)
   ▼
tools (built per question; tools for unselected projects are never offered)
   research  web_research: a sourced answer from xAI Grok's web search (only with XAI_API_KEY)
   general   web_search (DuckDuckGo, Google News, Wikipedia), web_fetch (pages and PDFs,
             SSRF-guarded), calculate (mathjs + finance, isolated), public_data (ECB FX,
             CoinGecko, Open-Meteo), current_time, macro_news (22 Global Indices tile countries, official sources first), company_filings (NSE → BSE announcements;
             SEC EDGAR filings + XBRL financials), watchlists (the team's saved lists)
   files     read_attachment, search_attachment, analyze_table   (only when files are sent)
   repo      read_docs, list_files, grep_code, read_file          (in-memory GitHub snapshots)
             recent_changes, show_commit                           (GitHub API, GET only)
   live      heatmap market data, read-only allowlist             (only if configured)
   tasks     schedule_task, list_scheduled_tasks, manage_scheduled_task, edit_watchlist (admins)
             (live chats only; they change only the bot's own state file)
```

### Scheduled tasks

Anyone allowed can create a task in a chat, in plain words ("keep an eye on…",
"every morning send…") or with `/task add <schedule> [alerts] | <what to watch>`.

- **Schedules (IST):** `every 30m`, `every 2h`, `hourly`, `daily 08:30`,
  `daily 9:00, 15:30`, `weekdays 09:15`, `weekends 10:00`, `mon,thu 18:00`.
  The shortest interval is 15 minutes.
- **Each run** is a normal agent turn with a monitoring brief. It searches the news
  with a recency filter, runs Grok research when the key is set, opens primary
  sources (filings, results, regulators), and uses live market data when
  available. It writes a grouped update with a source and date for every item.
- **No repeats:** each task remembers what it reported (the `SEEN` lines the
  model adds, hidden from readers), and the next run is told the list. If nothing
  is new, it posts nothing.
- **Modes:** `digest` reports everything new and relevant. `alerts` reports only
  material events: results, guidance, ratings, management, M&A, orders,
  regulatory action, policy and macro surprises.
- **Safety:** a run can't create more tasks or ask questions. After 5 failed runs
  in a row, a task pauses and tells the chat. Tasks in a chat that is removed from
  the allowlist, or that blocks the bot, pause themselves. A few tasks run at
  once, beside normal chat.
- **Managing tasks:** `/tasks`, `/task run|pause|resume|delete|show <n>`,
  `/task schedule <n> <schedule>`, `/task edit <n> | <instruction>`, or just ask.
  Only the creator or an admin can change a task.
- **Projects:** by default a task gets only the live market data (if the chat reads
  it). Ask for project code explicitly when the task needs it.
- **Try one first:** `npm run task -- "India macro news: RBI, inflation, rupee"`
  runs it once from your terminal, without saving or posting anything.

### What it stores (and what it doesn't)

- **No database of its own.** Nothing about questions or answers is stored.
- **`DATA_DIR` (a Railway volume, `/data`)** holds one small JSON file: each chat's
  project selection, the scheduled tasks (with what each has already reported),
  the team's watchlists, and token totals.
- **Conversation memory** (the last few turns, for follow-up questions) is kept in
  RAM only and resets on restart or with `/clear`.
- **Repo snapshots** are copies of the four repos kept in memory, refreshed on a
  schedule.
- **Uploaded files** live in memory for the question they are sent with, and are
  not written to disk.

### Who can use it

- **Open by default:** anyone who opens the bot and taps Start can use it, in a direct
  chat or in any group it is added to. In a group it speaks only when called: a
  `/command`, an `@mention`, or a reply to one of its messages.
- **Optional locks** (all empty by default): `TELEGRAM_ALLOWED_USER_IDS`,
  `TELEGRAM_ALLOWED_GROUP_IDS`, `TELEGRAM_ADMIN_USER_IDS`. With no admin list,
  everyone can change stock lists and use `/status`. See DEPLOY.md, "Restricting access".

### What it can change, and how that is kept safe

- **Reading** uses SELECT only (`src/projectdb.js`, `src/tools/database.js`).
- **`project_change`** (heatmap, FinXray) never writes when called: it checks the table
  and columns, counts the rows, and asks the person to tap **Confirm**. Only that
  person's tap runs it, once, within 10 minutes, after re-counting the rows (if the data
  moved it refuses). Updates and deletes need a `where`; at most 100 rows; deletes and
  more than 10 rows need a BusyBee admin or supervisor; credential tables and columns are
  never touched. Not offered in scheduled runs.
- **BusyBee** is changed only through its own API as the asker (`busybee_create_task`,
  `busybee_update_task`), so its permissions and alerts apply. Never directly in its tables.
- **`dashboard_watchlist`** touches only the asker's own dashboard lists (matched by e-mail).
- Every change is in the audit log (`/changes`) and the server log.
- **Never, by design:** code, git, deploys, servers, schemas, keys, other people's data.
- Repo tools read in-memory copies. They never touch the filesystem, spawn
  processes or run git. Snapshots skip symlinks, `.env` and key files, and mask
  credential-looking strings.
- Recent changes and commit details come from the GitHub API with GET requests only.
- Project scope is enforced twice: tools for unselected projects are not offered
  to the model, and each one checks the selection again when it runs.

## Commands

Nobody has to learn these. People type in plain words or tap the four buttons
(📊 Market today, 🔔 My updates, ⭐ Our stocks, ❓ How to use); updates are run, paused
and removed with buttons. The commands are shortcuts and admin tools (`/more` lists them).

| Command | Who | What |
|---|---|---|
| `/start`, `/help` | allowed people | short welcome and the four buttons |
| `/market`, `/updates`, `/lists`, `/new` | allowed people | same as the buttons; `/new` starts a fresh conversation |
| `/more` | allowed people | every shortcut |
| `/projects` | allowed people | pick which projects it may read (tap to toggle) |
| `/all`, `/none` | allowed people | read every project, or none (general questions) |
| `/clear` | allowed people | forget this chat's conversation |
| `/brief` | allowed people | today's market brief now (needs live data) |
| `/tasks` | allowed people | this chat's scheduled tasks (`/tasks all`: every chat, admins) |
| `/task add <schedule> [alerts] \| <what to watch>` | allowed people | create a task |
| `/task run\|pause\|resume\|delete\|show <n>`, `/task schedule <n> …`, `/task edit <n> \| …` | creator or admin | manage a task |
| `/lists`, `/list <name>` | allowed people | the team's watchlists |
| `/list create\|add\|remove\|set\|describe\|delete <name> …` | admins | change a watchlist |
| `/whoami` | allowed people | your Telegram ID and the chat ID (works in unlisted groups too) |
| `/status` | admins | model, live-data state, team spend this month, snapshot commits |
| `/refresh [project]` | admins | re-download repo snapshots now |

## Files

```
server.js                 entry point: health route, Telegram polling, snapshots, scheduled tasks
src/
  bot.js                  routing, access, commands, project picker, files, answers, brief
  access.js               allowlist rules (users, listed groups)
  telegram.js             Bot API client (long polling, retries, token scrubbing)
  format.js               Markdown → Telegram HTML; splitting under 4096 characters
  state.js                per-chat projects, tasks, spend, rate limiter (one JSON file)
  schedule.js             task schedules in IST: parse, describe, next run
  tasks.js                the task runner: run prompt, no-repeat memory, posting, failures
  answer.js               the agent core without a front end (used by scripts)
  agent.js                the tool loop
  config.js               every environment variable
  prompt.js               system prompt (+ plain-language and Telegram rules, "📁 From" source line)
  projects.js             the four projects
  snapshots.js            GitHub tarball → in-memory index (+ secret filtering)
  documents.js            PDF/CSV/text extraction and table analysis
  readonly.js             read-only database wrapper (the heatmap market tools)
  tools/dbwrite.js        project_change (confirm first), dashboard_watchlist, audit
  providers/              deepinfra.js (any OpenAI-compatible endpoint: DeepInfra, xAI Grok), index.js
  tools/research.js       web_research (xAI Grok, Responses API with web search)
  tools/schedule_tools.js schedule_task, list_scheduled_tasks, manage_scheduled_task (live chats only)
  projectdb.js            one read handle per project database; credential tables/columns never read
  team.js                 team member = Telegram linked in BusyBee
  tools/database.js       project_tables, project_query (SELECT only)
  tools/busybee.js        busybee_create_task / _update_task via BusyBee's API
  engines.js              @grok / @deepinfra / both: picks the AI, runs both in parallel, merges
  tools/filings.js        company_filings (NSE, BSE, SEC EDGAR)
  tools/macro.js          macro_news (country list from the dashboard, official-source queries)
  tools/watchlists.js     watchlists, edit_watchlist
  tools/                  index, search, web, calc(+Worker), public_data, attachments,
                          github, repo, scope, live, dashboard, util
docs/PROJECTS.md          the agent's map of the four projects (read by read_docs)
docs/HOW_TO_USE.md        one-page guide for the team (plain words)
docs/SAMPLE_QUESTIONS.md  what to ask
evals/questions.json      36 test questions with expected behaviour
scripts/doctor.js         checks every setting and source (npm run doctor)
scripts/ask.js            ask from your terminal, with your real keys (npm run ask)
scripts/evals.js          runs the evals through the real agent (npm run evals)
scripts/run-task.js       tries a monitoring task once (npm run task)
tests/                    npm test: 150 tests, no network, no keys
```

## Configuration

Every setting is an environment variable. [`.env.example`](.env.example) lists them
all with defaults. The important ones:

| Required | Variable |
|---|---|
| yes | `TELEGRAM_BOT_TOKEN` |
| yes | `DEEPINFRA_API_KEY` |
| recommended | `XAI_API_KEY`, `GITHUB_READ_TOKEN`, `DATA_DIR` (`/data` on Railway), `SEC_USER_AGENT` (`Company name contact@email`, for SEC EDGAR) |
| optional | `TASKS_ENABLED` and the other `TASK_*` limits, `XAI_API_KEY` (used only for @grok / @grok @deepinfra messages), `AGENT_GROK_MODEL`, access locks (`TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_GROUP_IDS`, `TELEGRAM_ADMIN_USER_IDS`), `FILE_MEMORY_HOURS`, `HEATMAP_SUPABASE_URL` + `HEATMAP_SUPABASE_KEY` (live market data, read-only), `AGENT_MODEL`, `AGENT_FALLBACK_MODEL`, budgets and limits |

## Develop

```bash
npm install
npm test                      # 150 tests, no network or keys
cp .env.example .env          # fill in what you have
npm run doctor                # checks settings, Telegram token, model, repos, sources
npm run ask -- "question"     # ask from the terminal, with your real keys
npm start                     # runs the bot (polls Telegram from your machine)
```

Run **one** instance per bot token. Telegram refuses a second poller, and the
conversation memory and budgets are per process.

### Adding a project

1. Add it to `PROJECTS` in `src/projects.js` and a section to `docs/PROJECTS.md`.
2. Give `GITHUB_READ_TOKEN` access to the repo.

### Adding a live data source

1. Add its tables and read functions to `SOURCES` in `src/tools/live.js`.
2. Build its read client in `server.js` with its own URL and key.

## Known limits

- **Scanned PDFs** (no text layer) can't be read. Excel and Word files must be
  exported to CSV or PDF first.
- **Photos** are not read; the bot asks for the document instead.
- **Telegram files** are limited to 20 MB by Telegram, and to 10 MB by the agent.
- **Web search** depends on public sources. DuckDuckGo sometimes refuses cloud
  servers; news and Wikipedia cover it.
- **Live market data** comes from the heatmap database, and is only as fresh as its
  nightly pipelines.
- **Memory** of a conversation is lost on restart. Tasks are not: they live on the volume.
- **"Real time"** means each task's schedule (15 minutes at the fastest), from public
  sources. Paywalled news and exchange data needs a paid feed.
- **Cost** scales with the number of tasks × how often they run. There is no cap by
  default. Set `AGENT_MONTHLY_TOKENS` when you want one, and watch `/status`.
