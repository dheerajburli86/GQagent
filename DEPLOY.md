# Deploying the GQuants Agent (Telegram bot)

Total time: about 40 minutes, most of it Telegram and Railway clicking.

## What goes where

| What | Where | Needed? |
|---|---|---|
| The code | new private GitHub repo **`dheerajburli86/gquants-agent`** | yes |
| The bot process | Railway: workspace **dheerajburli86's Projects**, new project **`gquants-agent`** | yes |
| The bot itself | Telegram: a **new** bot made with @BotFather | yes |
| Model | DeepInfra: one API key, with billing | yes |
| Repo read access | GitHub: one fine-grained read-only token | yes |
| Live market data | Supabase: the **heatmap dashboard** project (`xmcvsnollphnsonaupzt`), two values copied from it | optional, read-only |
| Storage | a Railway **volume** at `/data` on the same service | yes (settings and budgets) |
| Frontend, Vercel, Supabase logins, Supabase tables | **not needed** | no |

There is no Telegram channel. A channel only broadcasts and can't read questions.
The bot works in direct messages and in a **group** where the team is.

Two things to watch:
- **Use a new bot token.** Don't reuse the bot used for FinXray alerts, whose token
  was also left in a log file. Revoke that old token too (see Step 9).
- **Messages reach outside services.** Your question and any file you send go to
  DeepInfra (the model). Web searches go to DuckDuckGo, Google News and Wikipedia.
  Anyone in an allowed group sees the answers, so send sensitive files in a direct chat.

---

## Step 1: Create the Telegram bot (about 5 min)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Name: **GQuants Agent**. Username: something ending in `bot`, for example
   `gquants_agent_bot`.
3. BotFather replies with a token like `123456789:AAH…`. Copy it. This becomes
   **`TELEGRAM_BOT_TOKEN`**. Treat it like a password.
4. Still in BotFather, send `/setcommands` and choose the bot. Paste:

```
start - Menu
market - Today's market
updates - My regular updates
lists - Our stocks
new - Start a fresh conversation
help - How to use
```

5. Send `/setprivacy`, choose the bot, and keep it **Enabled**. The bot then sees
   only commands, mentions and replies in groups, which is what you want.
That's all Telegram needs. The bot is open: anyone who finds it, taps Start and
types can use it, in a direct chat or in any group it's added to. (To lock it down
later, see "Restricting access" at the end.)

---

## Step 2: Collect the other keys (about 10 min)

Keep these in a password manager.

**2a. DeepInfra.** deepinfra.com → **Dashboard → API keys → New key** → this is
**`DEEPINFRA_API_KEY`**. Under **Billing**, add a payment method. The model
(`google/gemini-2.5-flash`) costs about $0.30 per million input tokens and $2.50 per
million output tokens.

**2b. GitHub read token.** github.com → avatar → **Settings → Developer settings →
Personal access tokens → Fine-grained tokens → Generate new token**.
- Name: `gquants-agent-read`. Resource owner: `dheerajburli86`. Expiry: 90 days
  (set a reminder to rotate it).
- Repository access → **Only select repositories**: `heatmap-dashboard`, `busybee`,
  `gq-finxray-us`, `GDP-Macro-Dashboard`.
- Permissions → Repository permissions → **Contents: Read-only**. Leave everything else
  at No access.
- Generate, copy. This is **`GITHUB_READ_TOKEN`**.

**2c. Live market data (optional).** This lets the agent answer questions about
stock prices, returns and technicals from the heatmap database.
- supabase.com → organisation **primary projects** → project **heatmap dashboard**
  → **Project Settings → API Keys**.
- Copy the URL `https://xmcvsnollphnsonaupzt.supabase.co` → **`HEATMAP_SUPABASE_URL`**.
- Copy the **service_role** key → **`HEATMAP_SUPABASE_KEY`**.

The agent only reads from it, through an allowlist of tables and read functions.
The key itself is powerful, though: keep it only in Railway and your password
manager. Without these two values the bot still works, but market questions are
answered from general knowledge only.

**2d. xAI Grok (optional).** Used ONLY when someone writes **@grok** in a message
(Grok answers, with its live web search), or **@grok @deepinfra** (both answer and
DeepInfra merges them into one). Untagged messages and tasks never touch Grok.
- console.x.ai → create an API key → this is **`XAI_API_KEY`**.
- Add billing on the xAI console. Grok search is billed per search, on top of
  tokens, so @grok answers cost more than ordinary ones.
- Model names and prices change. Check console.x.ai before choosing a model, and set
  `AGENT_GROK_MODEL` if you want a different one.

Without this key the bot works normally; @grok replies that Grok isn't set up.

---

## Step 3: Put the code on GitHub (about 5 min)

1. github.com/new: owner **dheerajburli86**, repository name **gquants-agent**,
   **Private**. Leave README, .gitignore and licence unticked. Create.
2. Unzip `gquants-agent.zip`. Open a terminal inside the `gquants-agent` folder and run:

```bash
git init
git add .
git commit -m "GQuants Agent: Telegram bot"
git branch -M main
git remote add origin https://github.com/dheerajburli86/gquants-agent.git
git push -u origin main
```

3. Refresh the GitHub page. Check that there is **no `.env` file** in the repo.

---

## Step 4: Check it on your laptop first (about 5 min, recommended)

Needs Node 20 or newer (`node -v`). Inside the folder:

```bash
npm install
npm test                      # should print: # pass 141
cp .env.example .env          # then fill in the values from Steps 1–2
npm run doctor
```

`doctor` checks your settings, asks Telegram who the bot is (it sends no messages),
makes one tiny DeepInfra call with the agent's full tool list, and tests the
GitHub repos, the optional live data, the web search, the exchange-rate and weather
sources, and the calculator. Fix every ✘. A `!` on one search source is fine.

Then try a question from the terminal, using your real keys:

```bash
npm run ask -- "What is the EMI on 50 lakh at 9% for 20 years?"
npm run ask -- --projects busybee "When do BusyBee reminders go out?"
```

---

## Step 5: Create the service on Railway (about 10 min)

1. railway.com → workspace **dheerajburli86's Projects** → **+ New → Empty Project**.
   Name it **`gquants-agent`**. (It is separate from `heatmap-dashboard-automation`,
   so the agent can be redeployed without touching the data pipelines.)
2. Inside it: **+ Create → GitHub Repo → `dheerajburli86/gquants-agent`**. If the repo
   is not listed, use **Configure GitHub App** and grant access to it.
3. Railway reads `railway.toml` and builds the `Dockerfile`. It runs **one replica**
   and health-checks `/health`. Leave **Root Directory** empty, and don't set a
   custom start command.
4. **Add a volume** (this keeps the settings and the budget totals across restarts):
   open the service → **Settings → Volumes → + New Volume**, mount path **`/data`**.
5. Open **Variables → Raw Editor**, paste the block below and fill in the blanks:

```
TELEGRAM_BOT_TOKEN=<token from Step 1>
DEEPINFRA_API_KEY=<key from 2a>
AGENT_MODEL=google/gemini-2.5-flash
GITHUB_READ_TOKEN=<token from 2b>
SEC_USER_AGENT=GQuants Research <your email>
HEATMAP_SUPABASE_URL=<from 2c, or delete this line>
HEATMAP_SUPABASE_KEY=<from 2c, or delete this line>
XAI_API_KEY=<from 2d, or delete this line>
DATA_DIR=/data
TASKS_ENABLED=true
```

   There are no spending caps by default (`AGENT_DAILY_TOKENS_PER_USER` and
   `AGENT_MONTHLY_TOKENS` are 0 = unlimited). Set them later if you want a ceiling.
   The other task settings (`TASK_*`) have defaults in `.env.example`.
6. **Deploy.** Wait until the deployment shows **Active** (about 2–3 minutes).
7. Open **Deployments → View logs**. You should see, in order:
   - `[agent] health on 8080; model: deepinfra/google/gemini-2.5-flash`
   - `[bot] @gquants_agent_bot ready (1 allowed user(s), 0 group(s))`
   - `research: grok/grok-4.3` in the same line, if you set `XAI_API_KEY`
   - `[snapshot] warm: {...}` with a commit for each repo

   If you see `[state] … is not usable`, the volume isn't mounted at `/data`.
   If you see `TELEGRAM_BOT_TOKEN … not set`, recheck Step 5.4.
8. A public domain isn't needed. Only the health check uses HTTP, and it happens
   inside Railway.

---

## Step 6: Try it in Telegram (about 5 min)

1. Open a direct chat with your bot and send **/start**. You get a short welcome and
   four buttons at the bottom: 📊 Market today, 🔔 My updates, ⭐ Our stocks, ❓ How to use.
2. Type a question, such as "What is 18% of 2.5 lakh?". The bot shows typing, then
   answers. Longer research shows "🔎 Looking into it…" first.
3. Tap **📊 Market today**, then **🔔 My updates** and **⭐ Our stocks**.
4. Admins only: send **/status** (model, live data, spend, repo commits) and **/more**
   (every shortcut, including the admin ones).

Team members never need a slash command: they type in plain words or tap the buttons.
Give them [docs/HOW_TO_USE.md](docs/HOW_TO_USE.md).

---

## Step 7: Add the team group (optional, 2 min)

1. In Telegram: **New Group** → add the bot and your team.
2. In the group, try: `@yourbotname what is the CAGR from 100 to 250 in 5 years?`
   The bot replies to your message. Without the mention, or a reply to the bot, it
   stays quiet, so normal group chat isn't disturbed.

Nothing to set in Railway. New people just open the bot and tap Start.

**Daily market summary:** no setting needed. In the group, say "every weekday at
8:30 am, send the market summary here". It becomes a regular update like any other,
and 🔔 My updates pauses or removes it. Add as many automations as you like this way.

---

## Step 8: Ongoing monitoring (scheduled tasks)

Tasks are defined once and then run on their own schedule, in IST. Each run posts
only what is new since the last run (the bot remembers what it already reported).
Tasks live in the volume's `state.json`, so they survive redeploys.

Two ways to create one, in a direct chat or an allowed group:

- **Plain words:** "Every weekday at 9am, check news on our India holdings: HDFC
  Bank, Infosys, Tata Motors. Only tell me if something material happened." The
  bot creates the task and confirms the schedule.
- **Command:** `/task add weekdays 09:00 | News and filings on HDFC Bank, Infosys,
  Tata Motors`. Put `alerts` after the schedule (`/task add every 1h alerts | …`) to post only when
  something is new.

Manage them with `/tasks` (list), `/task show 3`, `/task run 3`, `/task pause 3`,
`/task resume 3`, `/task schedule 3 every 2h`, `/task edit 3 | new instruction`,
`/task delete 3`. Schedules: `every 30m`, `every 2h`, `daily 08:30`,
`weekdays 09:00,15:45`, `mon,thu 18:00`, `hourly`. The shortest interval is 15
minutes (`TASK_MIN_INTERVAL_MINUTES`).

A task that fails 5 times in a row pauses itself, and so does one whose chat is
removed from a group. `/task resume` restarts it. Set
`TASKS_ENABLED=false` to stop every task without deleting them. Each run costs about
as much as asking the question by hand, so a task every 15 minutes is ~100 runs a day.

---

### Watchlists: tell it once what the team holds

Tasks and questions that say "our holdings" read the team's watchlists on every run, so
updating a list updates every task that uses it. Admins set them up once:

```
/list create india-holdings | What we hold in India
/list add india-holdings HDFC Bank (NSE: HDFCBANK), Infosys (NSE: INFY), Larsen & Toubro (NSE: LT)
/list create global-holdings ASML (NASDAQ: ASML), TSMC (NYSE: TSM) | What we hold outside India
/list create interest | Companies we don't own but track
/list create countries India, United States, China, Japan, Euro area | Macro coverage
```

Or in plain words: "add Bajaj Finance to our India holdings". `/lists` shows them all,
`/list <name>` one list; `remove`, `set` (replace all), `describe` and `delete` also work.
Then, for example: `/task add weekdays 09:00, 16:15 alerts | Material news and filings
on our India holdings`.

### Company filings

The agent reads disclosures from the source: NSE corporate announcements (BSE if NSE
refuses) for results, concall transcripts, presentations and board outcomes, and SEC
EDGAR for US filings and reported financials. Set `SEC_USER_AGENT` (SEC asks every
client to identify itself). NSE and BSE sometimes block cloud servers; when both refuse,
the agent says so and uses web research instead. `npm run doctor` shows which work.

---

## Step 9: Afterwards

- **Revoke the old FinXray bot token.** A Telegram bot token was committed in a log
  file in the `gq-finxray-us` repo. In Telegram, message @BotFather with `/revoke`,
  choose the FinXray bot, and update that service. Delete the log file from the repo.
- **Rotate the GitHub token** before it expires. Update `GITHUB_READ_TOKEN` in Railway.
- **Watch spend:** `/status` shows the team's monthly tokens and the task count. `/tasks`
  shows tokens per task. DeepInfra's and xAI's dashboards show the cost.
- **Keep one replica.** Two copies would fight over the Telegram connection.
- **Update the bot's code** by pushing to `main` on GitHub. Railway redeploys. The
  settings and budget totals survive, because they're on the volume.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| Deploy fails at `npm ci` | `package-lock.json` wasn't pushed. Commit and push it. |
| Log: `TELEGRAM_BOT_TOKEN … not set` | Step 5.5: add the variable. |
| Log: `Telegram rejected the token` | Wrong token, or it was revoked in BotFather. |
| Log: `another instance is polling this bot` | Two replicas or two copies running (for example one on your laptop). Stop the other one. |
| The bot ignores a group | The message doesn't mention the bot (@yourbotname) or reply to it. |
| "The agent's model is not configured" | Set `DEEPINFRA_API_KEY`. |
| "Something went wrong" | Check the logs. Usually a model error; try again or narrow the question. |
| "today's allowance" | The person reached `AGENT_DAILY_TOKENS_PER_USER`. It resets at midnight IST. |
| "monthly budget … used up" | The team reached `AGENT_MONTHLY_TOKENS`. Raise it. |
| A snapshot shows `GitHub 404/401` | The token doesn't cover that repo, or has expired. |
| "[state] … is not usable" in the logs | The volume isn't mounted at `/data`. Add it (Step 5.4). |
| Market questions answer from general knowledge | `HEATMAP_SUPABASE_*` aren't set (Step 2c). |
| Web answers say search failed | A public source refused. Run `npm run doctor` to see which. |
| "web research unavailable (xAI 401)" | `XAI_API_KEY` is wrong or revoked. |
| "web research unavailable (xAI 402/403)" | The xAI account needs billing or credit. |
| A task never posts | It may be in `alerts` mode with nothing new. `/task run <id>` forces a run and says "Nothing new" if so. |
| A task shows "paused after 5 failures" | `/task show <id>` gives the last error. Fix the cause, then `/task resume <id>`. |
| A task shows "paused: chat no longer allowed" | The chat was removed from the access lists, or the bot was removed from the group. |
| "Task limit reached" | `TASK_MAX_PER_CHAT` / `TASK_MAX_TOTAL`. Delete old tasks or raise the limit. |
| "could not read exchange announcements" | NSE and BSE both refused the server. The agent falls back to web research; `npm run doctor` shows which exchange answers. |
| SEC answers "HTTP 403" | Set `SEC_USER_AGENT` to `Company name contact@email`. |
| A task about "our holdings" says the list is missing | Create it: `/list create india-holdings` and `/list add …` (admins). |
| A PDF reads as empty | It's a scan with no text layer. |
| Slow answers (20–60 s) | Multi-step questions make several model calls. Narrow the project selection. |

## Restricting access (optional, later)

The bot is open by default. Anyone who finds its username can use it, which spends
your DeepInfra/xAI credit and lets them ask about anything the bot can read
(including private repo code if `GITHUB_READ_TOKEN` is set, and the heatmap data). If
that becomes a concern, set any of these (comma-separated Telegram IDs; a person sees
their ID when the bot refuses them, or via /whoami):

| Variable | Effect when set |
|---|---|
| `TELEGRAM_ALLOWED_USER_IDS` | only these people can use the bot |
| `TELEGRAM_ALLOWED_GROUP_IDS` | only these groups are answered |
| `TELEGRAM_ADMIN_USER_IDS` | only these people can change stock lists and see `/status` |
| `AGENT_DAILY_TOKENS_PER_USER` | a daily usage cap per person |

## Full project data and BusyBee actions

**Reading every project's database.** In Railway, set a URL and key for each project
(Supabase → that project → Project Settings → API: the Project URL and the
`service_role` / secret key):

```
BUSYBEE_SUPABASE_URL=   BUSYBEE_SUPABASE_KEY=
FINXRAY_SUPABASE_URL=   FINXRAY_SUPABASE_KEY=
HEATMAP_SUPABASE_URL=   HEATMAP_SUPABASE_KEY=
```

The agent can then read every table of each (read-only), but only for **team
members**: people whose Telegram is linked in BusyBee (Settings → Telegram). Nobody
keeps a list. Everyone else still gets the public features. Credentials stored in the
databases are never read, and pay/bank columns are shown only to BusyBee admins.
`PROJECT_DATA_ACCESS=everyone` removes the team check (not recommended: BusyBee holds
staff data).

**Creating and updating BusyBee tasks.** The agent asks BusyBee to do it, as the person
who asked, so BusyBee's own permissions and alerts apply.

1. Add the two files from `busybee-agent-patch.zip` to the BusyBee repo
   (`lib/agent-auth.ts` new, `app/api/tasks/route.ts` changed), commit and push.
2. Make a secret (PowerShell):
   `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | % { $_.ToString("x2") }) -join ""`
3. BusyBee's Vercel → Settings → Environment Variables: `AGENT_SHARED_SECRET=<that secret>`
   (and `SUPABASE_SERVICE_ROLE_KEY` must already be set; Telegram alerts use it). Redeploy.
4. Railway (the agent): `BUSYBEE_APP_URL=https://<your busybee address>` and
   `BUSYBEE_AGENT_SECRET=<the same secret>`.
5. `npm run doctor` shows the databases, the number of linked team members, and whether
   BusyBee answers.
