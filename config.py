"""
config.py — All tunable settings for the ASO Intelligence Engine.

Edit the values in this file to point the engine at your app, your
competitors, and the markets you care about. Nothing in
aso_intelligence_engine.py should need to change for normal use —
it all reads from here.
"""

# ──────────────────────────────────────────────────────────────────────────
# 1. PRIMARY APP
# ──────────────────────────────────────────────────────────────────────────
# The numeric Apple App Store ID of the app you want to track.
# Find it in your App Store URL, e.g.:
#   https://apps.apple.com/us/app/some-app/id570060128  ->  570060128
TARGET_APP_ID = "570060128"  # <-- REPLACE with your app's numeric ID

# ──────────────────────────────────────────────────────────────────────────
# 2. KEYWORDS (Module 1: Keyword Rank Tracker)
# ──────────────────────────────────────────────────────────────────────────
# Keywords you want to track TARGET_APP_ID's exact rank position for,
# across every country in TARGET_COUNTRIES.
TARGET_KEYWORDS = [
    "meal planner",
    "calorie tracker",
    "healthy recipes",
    "diet planner",
    "weight loss app",
]

# ──────────────────────────────────────────────────────────────────────────
# 3. COUNTRIES
# ──────────────────────────────────────────────────────────────────────────
# Two-letter iTunes storefront country codes to run the keyword tracker
# and the charts monitor in. Keep this list short-ish — every extra
# country multiplies the number of requests made per run.
TARGET_COUNTRIES = ["us", "gb", "ae"]

# ──────────────────────────────────────────────────────────────────────────
# 4. COMPETITOR METADATA TRACKING (Module 2)
# ──────────────────────────────────────────────────────────────────────────
# Explicit competitor app IDs you always want tracked, regardless of
# whether they currently rank for any of your keywords.
COMPETITOR_APP_IDS = [
    "341232718",   # example: MyFitnessPal
    "1044790302",  # example: Lifesum
]

# In addition to the explicit list above, the engine automatically feeds in
# the top N ranked apps per keyword/country combo from the Keyword Rank
# Tracker as "auto-discovered" competitors, so new entrants get tracked
# without you having to notice them first.
AUTO_DISCOVER_TOP_N_COMPETITORS = 5

# Hard cap on how many unique competitor apps get a full metadata lookup
# per run (target app + explicit + auto-discovered, deduped). Keeps
# runtime and request volume bounded even if auto-discovery finds a lot.
MAX_COMPETITORS_TRACKED = 25

# ──────────────────────────────────────────────────────────────────────────
# 5. REVIEW MINING (Module 3)
# ──────────────────────────────────────────────────────────────────────────
# Apps to mine App Store reviews for. Defaults to target + explicit
# competitors. Auto-discovered competitors are intentionally excluded
# here to keep the request volume predictable.
REVIEW_APP_IDS = [TARGET_APP_ID] + COMPETITOR_APP_IDS

# Storefronts to pull the Customer Reviews RSS feed from, per app above.
REVIEW_COUNTRIES = ["us", "gb"]

# How many RSS pages to pull per app/country. Each page is ~50 reviews;
# Apple's public reviews feed caps out around page 10 (~500 reviews).
REVIEW_PAGES_PER_RUN = 3

# ──────────────────────────────────────────────────────────────────────────
# 6. AUTOCOMPLETE / NICHE EXPLORER (Module 4)
# ──────────────────────────────────────────────────────────────────────────
# Seed terms to expand using the hidden MZSearchHints autocomplete endpoint.
AUTOCOMPLETE_SEED_KEYWORDS = ["meal planner", "calorie"]

# Storefront to query the autocomplete endpoint against.
AUTOCOMPLETE_COUNTRY = "us"

# A-to-Z expansion alphabet used to generate long-tail suggestions
# ("<seed> a", "<seed> b", ... "<seed> z"). Add digits if you also want
# numeric variants, e.g. list("abcdefghijklmnopqrstuvwxyz0123456789").
AUTOCOMPLETE_EXPANSION_CHARS = list("abcdefghijklmnopqrstuvwxyz")

# ──────────────────────────────────────────────────────────────────────────
# 7. CHARTS / NEW RELEASES (Module 5)
# ──────────────────────────────────────────────────────────────────────────
# Apple genre (category) IDs to snapshot, mapped to a human-readable label.
# A few common ones: Health & Fitness=6013, Productivity=6007, Games=6014,
# Food & Drink=6023, Lifestyle=6012, Utilities=6002, Finance=6015.
TARGET_CATEGORIES = {
    "6013": "Health & Fitness",
    "6007": "Productivity",
}

# Chart types to fetch per category/country, using Apple's classic RSS
# generator feed naming convention.
CHART_TYPES = [
    "topfreeapplications",
    "toppaidapplications",
    "newapplications",
]

# How many entries to pull per chart (Apple supports up to 200 on this feed).
CHART_LIMIT = 100

# If True, every chart entry gets an extra /lookup call to fetch its real
# release date, and entries released within NEW_RELEASE_LOOKBACK_DAYS are
# collected into a "recent_new_releases" list. This is accurate but adds
# up to CHART_LIMIT extra HTTP requests per chart, so it's off by default.
ENRICH_CHART_WITH_RELEASE_DATES = False
NEW_RELEASE_LOOKBACK_DAYS = 30

# ──────────────────────────────────────────────────────────────────────────
# 8. STORAGE
# ──────────────────────────────────────────────────────────────────────────
DATA_DIR = "data"
JSON_HISTORY_PATH = f"{DATA_DIR}/comprehensive_aso_history.json"
CSV_DASHBOARD_PATH = f"{DATA_DIR}/aso_dashboard.csv"

# ──────────────────────────────────────────────────────────────────────────
# 9. NETWORKING
# ──────────────────────────────────────────────────────────────────────────
REQUEST_TIMEOUT_SECONDS = 20
REQUEST_DELAY_SECONDS = 1.2  # politeness delay between individual Apple requests
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5
