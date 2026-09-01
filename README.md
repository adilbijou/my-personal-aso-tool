# ASO Intelligence Engine

A 100% free, self-hosted App Store Intelligence tool that runs entirely on
GitHub Actions, stores its historical data inside the repo itself, and
serves a searchable dashboard over that data — no paid APIs, no external
servers, no database, no build step.

It replicates the core value of paid tools like ASOSpy / AppstoreSpy:

| Module | What it does |
|---|---|
| **1. Keyword Rank Tracker** | Exact 1–100 rank of your app for a keyword list, per country, plus a heuristic "difficulty" score |
| **2. Competitor Metadata Spy** | Snapshots competitor title/version/description/icon/release date daily and diffs against yesterday |
| **3. Review Miner** | Mines the public reviews RSS feed for word frequency + a "feature gap" summary from 1★/2★ reviews |
| **4. Autocomplete Niche Explorer** | Hits Apple's hidden autocomplete endpoint + does an A–Z long-tail expansion |
| **5. Charts & New Releases Monitor** | Snapshots Top Free / Top Paid / New Apps per category and flags new chart entrants |

Every daily run writes to:
- `docs/data/comprehensive_aso_history.json` — full nested history (one key per date)
- `docs/data/aso_dashboard.csv` — flat, "tall" (one row per metric) history, easy to pivot in a spreadsheet or BI tool

Both live inside `docs/` alongside a static dashboard site (`index.html`,
`style.css`, `app.js`, `data-utils.js`) — plain HTML/CSS/JS, no framework,
no build step. It fetches the two data files above directly in the browser.

## The dashboard site

- **Overview** — a "signal feed": a plain-English, clickable log of what actually changed since yesterday (rank moves, metadata updates, new chart entrants), plus a headline stat strip.
- **Keyword ranks** — a filterable table with day-over-day rank change (▲/▼) and a click-through historical rank trend chart per keyword/country.
- **Competitors** — icons, versions, ratings, and an inline diff of exactly what changed in the latest metadata pull.
- **Reviews** — top-word and "feature gap" (1★/2★) word-frequency bars, plus sample negative review snippets, per app/country.
- **Niche explorer** — the A–Z autocomplete expansion as a clickable letter grid with a live filter over every long-tail suggestion.
- **Charts** — a leaderboard per country/category/chart type, with a green "New" badge on anything that wasn't there in the previous snapshot.
- **Global search** — one search box across every keyword, competitor, chart entry, and long-tail suggestion in the current snapshot; picking a result jumps you to the right tab, filtered.
- **Date navigator** (top right) — step through every day the workflow has ever run to see any historical snapshot, not just today's.

---

## 1. A privacy decision before you create the repo

The data this tool generates — your keyword rankings, competitors' unreleased
update history, mined review text — is competitive intelligence you probably
don't want public. But GitHub's free plan only serves GitHub Pages sites
**from public repositories**; a private repo can only publish a Pages site
if you're on GitHub Pro ($4/mo) or higher, and even then the published site
itself is public by default (anyone with the URL can view it). So pick one:

| Option | Repo | Cost | Dashboard access |
|---|---|---|---|
| **A. Public + Pages** | Public | $0 | Live URL, anyone with the link can view your data |
| **B. Private, view locally** | Private | $0 | Clone the repo, open `docs/index.html` (or run a one-line local server) after each `git pull` |
| **C. Private + Pages** | Private | $4/mo (GitHub Pro) | Live URL (still public by default unless you're on GitHub Enterprise Cloud with Pages access control) |

If you don't mind the data being visible to anyone who finds the repo, **A**
is simplest and truest to "100% free." If you want it private and free,
**B** costs you nothing but a `git pull` before you check it. This guide
covers A and B below; if you want C, the only difference is upgrading to
GitHub Pro and enabling Pages the same way as option A.

## 2. Repository setup

1. **Create a new GitHub repository** — public or private, per the decision above.
2. Add all the files from this project to the repo root, keeping the folder structure exactly as given:
   ```
   .github/workflows/aso_cron.yml
   aso_intelligence_engine.py
   config.py
   requirements.txt
   README.md
   .gitignore
   docs/index.html
   docs/style.css
   docs/app.js
   docs/data-utils.js
   docs/data/comprehensive_aso_history.json
   docs/data/aso_dashboard.csv
   ```
   (The two files under `docs/data/` are placeholders — an empty `{}` and a
   header-only CSV — so the dashboard shows a clean "no data yet" state
   instead of a broken fetch before the workflow's first run.)
3. **Edit `config.py`** before your first run:
   - `TARGET_APP_ID` — your app's numeric App Store ID
   - `TARGET_KEYWORDS` — the keywords you want ranked
   - `TARGET_COUNTRIES` — storefronts to track (`"us"`, `"gb"`, `"ae"`, ...)
   - `COMPETITOR_APP_IDS` — competitor app IDs you already know about
   - `TARGET_CATEGORIES` — genre IDs for the charts monitor (Health & Fitness = `6013`, Productivity = `6007`, Games = `6014`, Food & Drink = `6023`, Lifestyle = `6012`, Utilities = `6002`, Finance = `6015` — full list is Apple's iTunes genre ID table)
   - Every other value has a sensible default and can be left alone.
4. Commit and push.

## 3. Give Actions permission to write back to the repo

By default, GitHub Actions' built-in token is **read-only**. The workflow needs write access to commit the daily data files:

1. Go to your repo → **Settings → Actions → General**.
2. Scroll to **Workflow permissions**.
3. Select **"Read and write permissions"**.
4. Save.

If you skip this step, the workflow will run and generate data, but the final "Commit and push updated data" step will fail with a permissions error.

## 4. (Option A/C only) Turn on GitHub Pages

1. Go to your repo → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Branch: `main`, folder: **`/docs`**. Save.
4. GitHub shows your site URL at the top of that page (`https://<username>.github.io/<repo>/`) once the first deployment finishes, usually within a minute or two.

If you chose **Option B** (private, local-only), skip this — see step 6 below instead.

## 5. Run it for the first time

1. Go to the **Actions** tab → **ASO Intelligence Engine** → **Run workflow** (this uses the `workflow_dispatch` trigger, no need to wait for 6 AM UTC).
2. Watch the logs. The first run has no "yesterday" to diff against, so:
   - Module 2's `changes_since_last_run` will be empty for every app (nothing to compare yet).
   - Module 5's `is_new_entrant` flags will all be `False` (no previous chart snapshot exists).
   - The Overview tab's signal feed will say "no changes detected" — expected on day 1. From day 2 onward, both start producing real signals.
3. Check that `docs/data/comprehensive_aso_history.json` and `docs/data/aso_dashboard.csv` were updated and committed by the bot.
4. From here, it runs automatically every day at 6:00 AM UTC.

## 6. (Option B only) Viewing the dashboard locally

After each `git pull`, either:
- Double-click `docs/index.html` to open it directly in a browser (works fine — everything is a relative `fetch` within the same folder), or
- From the `docs/` folder, run a tiny local server so `fetch` behaves exactly like it would on a real host:
  ```
  cd docs
  python3 -m http.server 8000
  ```
  then open `http://localhost:8000` in a browser.

## 7. Connecting the data to a BI tool (optional)

The dashboard site covers most day-to-day use, but if you also want the raw
data in Google Looker Studio or Excel, `aso_dashboard.csv` uses a flat
"long" format on purpose, since the five modules produce very different
shapes of data:

```
date, module, country, category_id, app_id, keyword, metric_name, metric_value, notes
```

Each row is one metric (e.g. `module=keyword_rank, metric_name=rank, metric_value=14`).

**If your repo is public:** create a blank Google Sheet and put this in cell `A1`:
```
=IMPORTDATA("https://raw.githubusercontent.com/<your-username>/<your-repo>/main/docs/data/aso_dashboard.csv")
```
Sheets refreshes `IMPORTDATA` roughly hourly on its own. Then add a **Google
Sheets** data source in Looker Studio pointing at that sheet.

**If your repo is private:** `IMPORTDATA` can't authenticate, so either
download the CSV periodically and re-upload it to a Sheet, or open it
directly in Excel/Numbers/Google Sheets any time — no dashboard required.

## 8. Things worth knowing

- **These are undocumented/unofficial endpoints.** The Search API and lookup API are public and stable; the RSS review feed, the classic per-genre chart RSS feeds, and especially the `MZSearchHints` autocomplete endpoint are not officially documented by Apple and can change or rate-limit without notice. Every module is wrapped in its own `try/except` in `main()`, so if one endpoint breaks or gets rate-limited, the other four still run and commit their data — you won't lose a whole day's history over one flaky call.
- **The "Keyword Difficulty Proxy Score" is a heuristic**, not Apple's real ranking algorithm (no public API exposes true difficulty). It's a 0–100 blend of how "saturated" the search results are (capped at 200 by the API) and how strong the top 10 competitors are by rating count. Read it as a relative signal across your own keyword list, not an absolute truth.
- **"Subtitle" isn't available.** Apple's public `/lookup` API doesn't expose the App Store subtitle field (only the storefront UI and App Store Connect show it), so `subtitle` is always `null` in the output. Everything else (title, version, description, release notes, icon, price, rating count) is real.
- **Autocomplete storefront IDs**: the hidden endpoint needs an `X-Apple-Store-Front` header, not a country query param. `config.py`'s `STOREFRONT_IDS` dict covers ~25 common countries. If you add a country that isn't listed, the engine falls back to the US storefront ID and prints a warning — add the real ID for accurate results.
- **Repo growth**: `comprehensive_aso_history.json` grows by one entry per day forever, and the dashboard fetches the whole file on every page load. For a personal tool this stays small and fast for a long time (plain JSON compresses well, and GitHub Pages serves it gzipped), but if you run this for years, consider periodically archiving older years into a separate file.
- **Re-running the same day is safe.** If you manually trigger a second run on the same UTC date, the CSV writer replaces that day's rows instead of duplicating them, and the JSON simply overwrites that date's key.
- **Rate limiting**: the engine sleeps ~1.2s between requests and retries transient errors (429/500/502/503/504) with backoff. If you add a lot of keywords, countries, or competitors, the run will simply take longer — it won't hammer Apple's endpoints.
