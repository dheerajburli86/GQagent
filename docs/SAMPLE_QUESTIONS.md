# Sample questions

These show what the agent can do. In Telegram, choose which projects it may read
with `/projects` (or `/all` and `/none`). Every answer ends with `Projects used: …`.

In a group, call the bot with a mention (`@gquants_agent_bot …`) or reply to one of
its messages. Everything else in the group is ignored.

## heatmap-dashboard

Code, docs and live market data (read-only).

- "Top 10 Indian stocks by 1-month return. Show the as-of date."
- "How is TCS doing technically? RSI, MACD and where it sits against its 52-week high."
- "Show HFCL's volume on NSE and BSE for the last few sessions."
- "Which US sector did best this week?"
- "Why does an India price on the dashboard sometimes differ from Google after market close?"
- "What runs at 05:30 UTC on Railway, and why that time?"
- "How does the dashboard decide a stock's GICS sector? Walk me through the evidence order."
- "Which Railway services does this project have, and what does each one own?"
- "Heatmap ke India EOD pipeline mein kaunse steps hain, order ke saath batao."

## busybee

Code and docs.

- "When does BusyBee send deadline reminders, and to whom?"
- "Can a regular member assign tasks, or only admins? Show me where that's enforced."
- "Which environment variables does the BusyBee scheduler need?"
- "What happens when a task is deleted 'for everyone' versus 'for me'?"
- "List all the API routes under /api/tasks/[id] and what each one does."
- "BusyBee mein overdue alert kab jaata hai, aur end-of-day summary kab?"

## gq-finxray-us

Code and docs.

- "List the 13 FinXray alert features and the file that implements each one."
- "Walk me through what happens to a news item, from poller to Telegram."
- "What happens when a summary still fails the quality check at 100 words?"
- "How does the ETF signals poller avoid sending repeat alerts?"
- "Which data vendors does FinXray use, and is there a licensing risk noted anywhere?"
- "Which Supabase tables do the mutual-fund pollers write to?"

## GDP-Macro-Dashboard

Code and docs.

- "Which indicators make up the Investment constituent?"
- "What JSON format does the dashboard expect from the data feed?"
- "Is the data on the dashboard real right now?" (It should say it is placeholder data until a feed is connected.)
- "How is the Indian fiscal-year quarter label computed?"
- "GDP dashboard mein kitne indicators hain aur kis constituent mein kitne?"

## Project history (any selected project)

- "What changed in BusyBee in the last 7 days?"
- "Who last changed the India EOD runner in heatmap-dashboard, and what did that commit do?"
- "When was the ETF signals feature added to FinXray?"

## Across projects

Select **All**, or the ones named.

- "Which of my projects send Telegram alerts, and for what?"
- "Which projects use Supabase, and what env var name does each use for the service key?"
- "heatmap-dashboard and gq-finxray-us both use FMP and Massive. Compare how each handles rate limits."
- "Which of my projects are Next.js and which are Vite?"
- "If I renamed the `instruments` table, what would break in each project?"

## General

Select none.

- "What is the EMI on a ₹50 lakh home loan at 9% for 20 years?" (uses `calculate`)
- "Explain XIRR vs CAGR with a worked example."
- "What did RBI announce at its latest policy meeting?" (searches the news and cites links)
- "Summarise this page: https://…" (reads the page with `web_fetch`)
- "Write a Python function to compute a rolling 20-day volatility from daily closes."
- "Explain how a Kalman filter works, simply."
- "Draft a polite email to a vendor asking them to resend an invoice."
- "मुझे Sharpe ratio आसान भाषा में समझाओ।"
- "Translate 'markets closed higher on strong IT buying' into Hindi."

## With attached files (send a PDF, CSV or text file in Telegram)

- Send an annual report PDF: "Summarise revenue, profit and debt for the last two years, with page numbers."
- Send a sales CSV: "Total revenue by region, and which product grew fastest?"
- Send a log file: "Why did this job fail? Find the first error."
- Send two PDFs: "Compare the risk factors in these two filings."
- Send a code file: "Review this for bugs and explain the fix."

## Research (needs XAI_API_KEY; uses Grok's live web search)

- "Compare the latest RBI and Fed policy statements and what markets read into them. Cite sources."
- "What did the last two quarterly results of Infosys and TCS say about deal wins? Link the sources."
- "Survey the current state of Indian mutual fund flows, with dated sources."

## Live public data (`/none` first, or any selection)

- "What's USD to INR today, and what was it on 1 Jan 2025?"
- "Bitcoin and Ethereum price in rupees right now?"
- "Will it rain in Mumbai tomorrow?"
- "Read this annual report and list the key numbers: https://…/annual-report.pdf"
- "/brief" (the morning market brief, on demand)

## Company filings (primary sources)

- "Did Infosys post a concall transcript this quarter? Give me the 5 key points on guidance and margins."
- "Show HDFC Bank's exchange filings from the last 2 weeks."
- "Any board-meeting outcomes or results filed by L&T this month?"
- "Apple's revenue, net income and operating cash flow for the last 6 quarters, from SEC filings, with QoQ growth."
- "Has NVIDIA filed any 8-K in the last 30 days? What were they about?"
- "Compare TSMC's last two 6-K/20-F filings: anything material?"

## Macro news by country (the Global Indices tile countries)

- "What did the Bank of Japan decide, and how did inflation print?"
- "Macro news this week for all our countries: rates, inflation, growth. Group by country."
- "Which central banks changed rates in the last 30 days?"
- "UK and Eurozone inflation news from official sources only."
- "Any budget or tariff news from Brazil, Mexico and Argentina?"

## Team watchlists

- "What's in our India holdings list?"
- "Add Bajaj Finance (NSE: BAJFINANCE) and Titan (NSE: TITAN) to our India holdings." (admins)
- "Any material news or filings on our global holdings since Friday?"
- "Which of our India holdings fell the most today, and is there news behind it?"

## Ongoing monitoring (scheduled tasks)

- All countries: "Every weekday at 8:30 am, send macro news for every country on the Global Indices tile: central-bank decisions, inflation, growth, jobs and policy. Official sources first, only what's new, grouped by country."

Say it in plain words and the bot sets up a task, or use `/task add <schedule> | <what to watch>`.
Each run posts only what's new since the last one.

- Holdings: "Every weekday at 9am and 4pm, check news, exchange filings and results for our India holdings. Only material items, with links." (reads the `india-holdings` list every run)
- Global holdings: "Daily at 7pm, track Apple, Nvidia, ASML and TSMC: earnings, guidance changes, regulatory news."
- Good news on names we don't own: "Every 2 hours during market hours, look for positive news (order wins, upgrades, approvals) on Indian mid-caps in defence and capital goods. Alerts only."
- Macro by country: "Every morning at 8:30, summarise overnight macro news for India, the US, China and Japan: rates, inflation, central bank comments, policy."
- Sectors: "Mon and Thu at 6pm, what moved Indian banks, IT and pharma this week, and why?"
- Company micro news: "Every 30 minutes, alert me if there's news on Zomato, Paytm or Nykaa: management changes, block deals, SEBI actions."
- Concalls and filings: "Weekdays at 8pm, check whether any of HDFC Bank, Infosys or L&T posted a concall transcript or results filing today, and give me the key points."
- With the heatmap data: "Daily at 4:15pm, list the 10 biggest India movers today from the dashboard and any news that explains them."
- Hinglish: "Har din subah 9 baje hamare India holdings ki news check karo, sirf important cheezein batana."
- Commands: `/task add every 1h alerts | RBI, SEBI or Finance Ministry announcements affecting banks`, then `/tasks`, `/task run 1`, `/task pause 1`, `/task schedule 1 weekdays 10:00`.

## What it will decline

- "Should I buy Reliance?" It gives no buy, sell or hold advice and no price
  targets. It gives the facts instead.
- "Fix the bug and push to main." It is read-only: it explains the change and
  where to make it, and you make it.
- "Show me the API keys in the repo." Secret files are never read, and
  credential values are masked.
- Asking about a project that isn't selected: it says so and asks you to add it.
