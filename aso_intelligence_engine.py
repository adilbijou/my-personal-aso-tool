"""
aso_intelligence_engine.py — Personal App Store Intelligence Engine.

Runs five modules against Apple's public/undocumented endpoints (no paid
APIs, no API keys) for every tracked app "project" defined in
docs/data/tracking_config.json — which you manage from the dashboard's
Settings tab — and appends the results to two historical data files:

  docs/data/comprehensive_aso_history.json   — full nested history, one entry
                                                per day, one sub-entry per project
  docs/data/aso_dashboard.csv                — flat, tall (EAV-style) history,
                                                one row per metric, tagged with
                                                which project it belongs to

Modules (run once per project):
  1. Keyword Rank Tracker        — exact rank + a difficulty proxy score
  2. Competitor Metadata Spy     — metadata snapshots + day-over-day diffs
  3. Review Miner                — word-frequency + 1★/2★ "feature gap" mining
  4. Autocomplete Niche Explorer — hidden MZSearchHints endpoint, A-to-Z expansion
  5. Charts & New Releases       — classic RSS generator feeds, per category

Designed to run unattended on a daily GitHub Actions cron job. Every module,
for every project, is wrapped in its own try/except in main() so a single
broken/blocked endpoint or misconfigured project never kills the whole run.

Usage:
    python aso_intelligence_engine.py
"""

import csv
import json
import os
import plistlib
import re
import time
from collections import Counter
from datetime import date, datetime

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import config

# ──────────────────────────────────────────────────────────────────────────
# SHARED HELPERS
# ──────────────────────────────────────────────────────────────────────────

CSV_FIELDNAMES = [
    "date", "project", "module", "country", "category_id", "app_id",
    "keyword", "metric_name", "metric_value", "notes",
]

# A reasonably complete map of iTunes storefront IDs, required as the
# X-Apple-Store-Front header for the hidden autocomplete endpoint. If a
# country a project uses isn't listed, the engine falls back to "us".
STOREFRONT_IDS = {
    "us": "143441-1,29", "gb": "143444-1,29", "ca": "143455-1,29",
    "au": "143460-1,29", "de": "143443-1,29", "fr": "143442-1,29",
    "it": "143450-1,29", "es": "143454-1,29", "jp": "143462-1,29",
    "in": "143467-1,29", "ae": "143481-1,29", "sa": "143479-1,29",
    "eg": "143516-1,29", "br": "143503-1,29", "mx": "143468-1,29",
    "nl": "143452-1,29", "se": "143456-1,29", "kr": "143466-1,29",
    "ru": "143469-1,29", "tr": "143480-1,29", "id": "143476-1,29",
    "sg": "143464-1,29", "ie": "143449-1,29", "ch": "143459-1,29",
    "pl": "143478-1,29",
}

STOPWORDS = set("""
a about above after again against all am an and any are arent as at be
because been before being below between both but by cant cannot could
couldnt did didnt do does doesnt doing dont down during each few for from
further had hadnt has hasnt have havent having he hed hell hes her here
heres hers herself him himself his how hows i id ill im ive if in into is
isnt it its itself lets me more most mustnt my myself no nor not of off on
once only or other ought our ours ourselves out over own same shant she
shed shell shes should shouldnt so some such than that thats the their
theirs them themselves then there theres these they theyd theyll theyre
theyve this those through to too under until up very was wasnt we wed
well were weve were werent what whats when whens where wheres which while
who whos whom why whys with wont would wouldnt you youd youll youre youve
your yours yourself yourselves app apps im ive dont just get got really
much also use used using great good nice one two would like now even
""".split())


def get_session():
    """A requests Session with automatic retry/backoff on transient errors."""
    session = requests.Session()
    retry = Retry(
        total=config.MAX_RETRIES,
        backoff_factor=config.RETRY_BACKOFF_SECONDS,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        )
    })
    return session


def safe_get(session, url, headers=None, params=None):
    """GET with error handling + a politeness delay. Returns None on failure."""
    try:
        resp = session.get(
            url, headers=headers, params=params,
            timeout=config.REQUEST_TIMEOUT_SECONDS,
        )
        time.sleep(config.REQUEST_DELAY_SECONDS)
        if resp.status_code != 200:
            print(f"      [warn] HTTP {resp.status_code} for {resp.url}")
            return None
        return resp
    except requests.RequestException as e:
        print(f"      [warn] request failed for {url}: {e}")
        return None


def safe_extract(entry, *keys, default=None):
    """Walk a chain of nested dict.get() calls without blowing up on None."""
    cur = entry
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur


def _csv_row(date_str, project_id, module, country="", category_id="", app_id="",
             keyword="", metric_name="", metric_value="", notes=""):
    return {
        "date": date_str, "project": project_id, "module": module, "country": country,
        "category_id": category_id, "app_id": app_id, "keyword": keyword,
        "metric_name": metric_name, "metric_value": metric_value, "notes": notes,
    }


def clean_and_tokenize(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = text.lower()
    text = re.sub(r"[^a-z\s]", " ", text)
    words = text.split()
    return [w for w in words if len(w) > 2 and w not in STOPWORDS]


# ──────────────────────────────────────────────────────────────────────────
# TRACKING CONFIG (what to track — editable from the dashboard's Settings tab)
# ──────────────────────────────────────────────────────────────────────────

def load_tracking_config():
    """Loads docs/data/tracking_config.json. Returns an empty project list
    (with a warning) if the file is missing, empty, or malformed, so a
    fresh install or a mid-edit file never crashes the whole run."""
    if not os.path.exists(config.TRACKING_CONFIG_PATH):
        print(f"  [warn] {config.TRACKING_CONFIG_PATH} not found — no projects to track. "
              f"Add one from the dashboard's Settings tab.")
        return {"projects": []}
    try:
        with open(config.TRACKING_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"  [warn] couldn't parse {config.TRACKING_CONFIG_PATH} ({e}) — treating as empty.")
        return {"projects": []}

    projects = data.get("projects", [])
    valid = []
    for p in projects:
        if not p.get("id") or not p.get("app_id"):
            print(f"  [warn] skipping a project missing 'id' or 'app_id': {p}")
            continue
        p.setdefault("label", p["id"])
        p.setdefault("keywords", [])
        p.setdefault("countries", ["us"])
        p.setdefault("competitor_app_ids", [])
        p.setdefault("categories", {})
        p.setdefault("review_countries", p["countries"][:1] or ["us"])
        p.setdefault("autocomplete_seeds", [])
        valid.append(p)
    return {"projects": valid}


# ──────────────────────────────────────────────────────────────────────────
# STORAGE
# ──────────────────────────────────────────────────────────────────────────

def load_json_history():
    if os.path.exists(config.JSON_HISTORY_PATH):
        with open(config.JSON_HISTORY_PATH, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                print("  [warn] history JSON was corrupt/empty — starting fresh")
                return {}
    return {}


def save_json_history(history):
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(config.JSON_HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False, default=str)


def get_previous_date_key(history, today_str):
    dates = sorted(k for k in history.keys() if k != today_str)
    return dates[-1] if dates else None


def append_csv_rows(rows, today_str):
    """Rewrites the CSV with today's rows merged in, replacing any rows
    already logged for today. This makes manual re-runs on the same day
    idempotent instead of duplicating that day's data."""
    if not rows:
        return

    existing_rows = []
    if os.path.exists(config.CSV_DASHBOARD_PATH):
        with open(config.CSV_DASHBOARD_PATH, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            existing_rows = [r for r in reader if r.get("date") != today_str]

    os.makedirs(config.DATA_DIR, exist_ok=True)
    all_rows = existing_rows + rows
    with open(config.CSV_DASHBOARD_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
        writer.writeheader()
        for row in all_rows:
            writer.writerow(row)


# ──────────────────────────────────────────────────────────────────────────
# MODULE 1 — GLOBAL KEYWORD RANK TRACKER
# ──────────────────────────────────────────────────────────────────────────

def calculate_keyword_difficulty(result_count, results, limit):
    """Heuristic 0-100 difficulty proxy (this is NOT Apple's real algorithm —
    no public API exposes true keyword difficulty, so we approximate it):

      - 50% weight: result saturation. iTunes search caps `resultCount` at
        the requested `limit`, so hitting the cap means "at least <limit>
        competing apps" (max saturation); coming in under it gives us the
        true total competitor count for that term.
      - 50% weight: average App Store rating count of the top 10 ranked
        apps for the term, as a proxy for how entrenched the competition is.
    """
    saturation_ratio = min(result_count / limit, 1.0) if limit else 0
    saturation_score = saturation_ratio * 50

    top10 = results[:10]
    rating_counts = [
        r.get("userRatingCount", 0) for r in top10
        if r.get("userRatingCount") is not None
    ]
    avg_top10_ratings = sum(rating_counts) / len(rating_counts) if rating_counts else 0
    strength_score = min(avg_top10_ratings / 50000, 1.0) * 50

    return round(saturation_score + strength_score, 1), round(avg_top10_ratings, 1)


def run_keyword_rank_tracker(session, project):
    data = {}
    csv_rows = []
    auto_competitors = set()
    today = date.today().isoformat()

    for country in project["countries"]:
        data[country] = {}
        for keyword in project["keywords"]:
            params = {
                "term": keyword, "country": country,
                "entity": "software", "limit": 200,
            }
            resp = safe_get(session, "https://itunes.apple.com/search", params=params)
            if resp is None:
                data[country][keyword] = {"error": "request_failed"}
                continue
            try:
                payload = resp.json()
            except ValueError:
                data[country][keyword] = {"error": "invalid_json"}
                continue

            results = payload.get("results", [])
            result_count = payload.get("resultCount", len(results))

            rank = None
            for idx, app in enumerate(results):
                if str(app.get("trackId")) == str(project["app_id"]):
                    rank = idx + 1
                    break

            difficulty_score, avg_top10_ratings = calculate_keyword_difficulty(
                result_count, results, params["limit"]
            )

            for app in results[: config.AUTO_DISCOVER_TOP_N_COMPETITORS]:
                tid = app.get("trackId")
                if tid and str(tid) != str(project["app_id"]):
                    auto_competitors.add(str(tid))

            data[country][keyword] = {
                "rank": rank,
                "difficulty_score": difficulty_score,
                "result_count": result_count,
                "avg_top10_ratings": avg_top10_ratings,
            }

            csv_rows.append(_csv_row(today, project["id"], "keyword_rank", country=country, keyword=keyword,
                                      metric_name="rank", metric_value=rank if rank is not None else ""))
            csv_rows.append(_csv_row(today, project["id"], "keyword_rank", country=country, keyword=keyword,
                                      metric_name="difficulty_score", metric_value=difficulty_score))
            csv_rows.append(_csv_row(today, project["id"], "keyword_rank", country=country, keyword=keyword,
                                      metric_name="result_count", metric_value=result_count))

            print(f"      [{country}] '{keyword}': rank={rank}  difficulty={difficulty_score}  results={result_count}")

    return data, csv_rows, auto_competitors


# ──────────────────────────────────────────────────────────────────────────
# MODULE 2 — COMPETITOR METADATA TIMELINE & UPDATE SPY
# ──────────────────────────────────────────────────────────────────────────

def fetch_app_metadata(session, app_id, country="us"):
    params = {"id": app_id, "country": country}
    resp = safe_get(session, "https://itunes.apple.com/lookup", params=params)
    if resp is None:
        return None
    try:
        payload = resp.json()
    except ValueError:
        return None
    results = payload.get("results", [])
    if not results:
        return None
    r = results[0]
    return {
        "app_id": str(app_id),
        "title": r.get("trackName"),
        # NOTE: Apple's public /lookup endpoint does not expose the App
        # Store "subtitle" field (it's only visible via App Store Connect
        # or the storefront UI), so it cannot be reliably captured here.
        "subtitle": None,
        "seller_name": r.get("sellerName"),
        "version": r.get("version"),
        "release_date": r.get("releaseDate"),
        "current_version_release_date": r.get("currentVersionReleaseDate"),
        "release_notes": r.get("releaseNotes"),
        "description": r.get("description"),
        "icon_url": r.get("artworkUrl512") or r.get("artworkUrl100"),
        "price": r.get("price"),
        "formatted_price": r.get("formattedPrice"),
        "primary_genre": r.get("primaryGenreName"),
        "average_rating": r.get("averageUserRating"),
        "rating_count": r.get("userRatingCount"),
        "min_os_version": r.get("minimumOsVersion"),
        "track_view_url": r.get("trackViewUrl"),
    }


def diff_metadata(old, new, max_chars=300):
    if not old:
        return []
    changes = []
    for field in ("title", "version", "release_date", "current_version_release_date",
                  "release_notes", "description", "icon_url", "price", "primary_genre"):
        old_val, new_val = old.get(field), new.get(field)
        if old_val != new_val:
            changes.append({
                "field": field,
                "old": str(old_val)[:max_chars] if old_val else old_val,
                "new": str(new_val)[:max_chars] if new_val else new_val,
            })
    return changes


def build_competitor_id_list(project, auto_discovered):
    ids = [project["app_id"], *project["competitor_app_ids"], *sorted(auto_discovered)]
    deduped = list(dict.fromkeys(ids))  # preserve order, drop dupes
    return deduped[: config.MAX_COMPETITORS_TRACKED]


def collect_competitor_metadata(session, project_id, prev_metadata, competitor_ids, lookup_country):
    data = {}
    csv_rows = []
    today = date.today().isoformat()

    for app_id in competitor_ids:
        meta = fetch_app_metadata(session, app_id, country=lookup_country)
        if meta is None:
            data[app_id] = {"error": "lookup_failed"}
            continue

        old_meta = prev_metadata.get(app_id)
        changes = diff_metadata(old_meta, meta)
        meta["changes_since_last_run"] = changes
        meta["ratings_delta"] = None
        if old_meta and old_meta.get("rating_count") is not None and meta.get("rating_count") is not None:
            try:
                meta["ratings_delta"] = meta["rating_count"] - old_meta["rating_count"]
            except TypeError:
                pass

        data[app_id] = meta

        csv_rows.append(_csv_row(today, project_id, "competitor_metadata", app_id=app_id,
                                  metric_name="rating_count", metric_value=meta.get("rating_count") or ""))
        csv_rows.append(_csv_row(today, project_id, "competitor_metadata", app_id=app_id,
                                  metric_name="average_rating", metric_value=meta.get("average_rating") or ""))
        csv_rows.append(_csv_row(today, project_id, "competitor_metadata", app_id=app_id,
                                  metric_name="version", metric_value=meta.get("version") or ""))
        for change in changes:
            csv_rows.append(_csv_row(today, project_id, "metadata_change", app_id=app_id,
                                      metric_name=change["field"], metric_value=change["new"],
                                      notes=f"was: {change['old']}"))
            print(f"      [CHANGE] app {app_id}: {change['field']} changed")

        print(f"      app {app_id}: {meta.get('title')!r} v{meta.get('version')} "
              f"rating={meta.get('average_rating')} ({meta.get('rating_count')} ratings)")

    return data, csv_rows


# ──────────────────────────────────────────────────────────────────────────
# MODULE 3 — CUSTOMER REVIEW MINER & OPPORTUNITY FINDER
# ──────────────────────────────────────────────────────────────────────────

def fetch_reviews(session, app_id, country, max_pages):
    all_reviews = []
    for page in range(1, max_pages + 1):
        url = (f"https://itunes.apple.com/{country}/rss/customerreviews/"
               f"id={app_id}/sortBy=mostRecent/page={page}/json")
        resp = safe_get(session, url)
        if resp is None:
            break
        try:
            payload = resp.json()
        except ValueError:
            break

        entries = payload.get("feed", {}).get("entry", [])
        if isinstance(entries, dict):
            entries = [entries]
        if not entries:
            break

        got_review = False
        for entry in entries:
            # The first entry on page 1 is often an app-summary element, not
            # a review — it has no im:rating, so we simply skip it.
            if "im:rating" not in entry:
                continue
            got_review = True
            all_reviews.append({
                "rating": int(safe_extract(entry, "im:rating", "label", default="0") or 0),
                "title": safe_extract(entry, "title", "label", default=""),
                "content": safe_extract(entry, "content", "label", default=""),
                "author": safe_extract(entry, "author", "name", "label", default=""),
                "updated": safe_extract(entry, "updated", "label", default=""),
                "app_version": safe_extract(entry, "im:version", "label", default=""),
            })
        if not got_review:
            break
    return all_reviews


def run_review_miner(session, project, review_app_ids):
    data = {}
    csv_rows = []
    today = date.today().isoformat()

    for app_id in review_app_ids:
        data[app_id] = {}
        for country in project["review_countries"]:
            reviews = fetch_reviews(session, app_id, country, config.REVIEW_PAGES_PER_RUN)
            if not reviews:
                data[app_id][country] = {"error": "no_reviews_found"}
                continue

            all_text = " ".join(f"{r['title']} {r['content']}" for r in reviews)
            top_words = Counter(clean_and_tokenize(all_text)).most_common(15)

            negative_reviews = [r for r in reviews if r["rating"] in (1, 2)]
            negative_text = " ".join(f"{r['title']} {r['content']}" for r in negative_reviews)
            feature_gap_words = Counter(clean_and_tokenize(negative_text)).most_common(15)

            sample_negative = [
                {"rating": r["rating"], "title": r["title"], "snippet": r["content"][:250]}
                for r in negative_reviews[:5]
            ]

            avg_rating = round(sum(r["rating"] for r in reviews) / len(reviews), 2)

            data[app_id][country] = {
                "reviews_analyzed": len(reviews),
                "average_rating_sampled": avg_rating,
                "negative_review_count": len(negative_reviews),
                "top_15_words": top_words,
                "feature_gap_words": feature_gap_words,
                "sample_negative_reviews": sample_negative,
            }

            for word, count in top_words:
                csv_rows.append(_csv_row(today, project["id"], "review_word_freq", country=country, app_id=app_id,
                                          metric_name=word, metric_value=count))
            for word, count in feature_gap_words:
                csv_rows.append(_csv_row(today, project["id"], "feature_gap_word", country=country, app_id=app_id,
                                          metric_name=word, metric_value=count))
            csv_rows.append(_csv_row(today, project["id"], "review_summary", country=country, app_id=app_id,
                                      metric_name="average_rating_sampled", metric_value=avg_rating))
            csv_rows.append(_csv_row(today, project["id"], "review_summary", country=country, app_id=app_id,
                                      metric_name="negative_review_count", metric_value=len(negative_reviews)))

            print(f"      app {app_id} [{country}]: {len(reviews)} reviews, "
                  f"avg={avg_rating}, negative={len(negative_reviews)}")

    return data, csv_rows


# ──────────────────────────────────────────────────────────────────────────
# MODULE 4 — REAL-TIME NICHE EXPLORER & AUTOCOMPLETE SEARCH
# ──────────────────────────────────────────────────────────────────────────

def get_autocomplete_hints(session, term, country):
    storefront = STOREFRONT_IDS.get(country, STOREFRONT_IDS["us"])
    url = "https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints"
    headers = {
        "X-Apple-Store-Front": storefront,
        "User-Agent": "iTunes/12.12.3 (Macintosh; OS X 10.15.7) AppleWebKit/0605.1.15",
        "Accept": "*/*",
    }
    params = {"clientApplication": "Software", "term": term}
    resp = safe_get(session, url, headers=headers, params=params)
    if resp is None:
        return []
    try:
        parsed = plistlib.loads(resp.content)
        hints = parsed.get("hints", [])
        terms = []
        for h in hints:
            if isinstance(h, dict) and "term" in h:
                terms.append(h["term"])
            elif isinstance(h, str):
                terms.append(h)
        return list(dict.fromkeys(terms))  # dedupe, preserve order
    except Exception as e:
        print(f"      [warn] failed to parse autocomplete hints for {term!r}: {e}")
        return []


def run_autocomplete_explorer(session, project):
    results = {}
    csv_rows = []
    today = date.today().isoformat()
    ac_country = project["countries"][0] if project["countries"] else "us"

    for seed in project["autocomplete_seeds"]:
        seed_results = {}

        base_hints = get_autocomplete_hints(session, seed, ac_country)
        seed_results["_base"] = base_hints
        for h in base_hints:
            csv_rows.append(_csv_row(today, project["id"], "autocomplete_hint", country=ac_country,
                                      keyword=seed, metric_name="base", metric_value=h))

        all_terms = set(base_hints)
        for letter in config.AUTOCOMPLETE_EXPANSION_CHARS:
            expanded_term = f"{seed} {letter}"
            hints = get_autocomplete_hints(session, expanded_term, ac_country)
            seed_results[letter] = hints
            all_terms.update(hints)
            for h in hints:
                csv_rows.append(_csv_row(today, project["id"], "autocomplete_hint", country=ac_country,
                                          keyword=seed, metric_name=letter, metric_value=h))

        seed_results["_all_unique_longtail"] = sorted(all_terms)
        results[seed] = seed_results
        print(f"      seed '{seed}': {len(base_hints)} base hints, "
              f"{len(all_terms)} unique long-tail suggestions after A-Z expansion")

    return results, csv_rows


# ──────────────────────────────────────────────────────────────────────────
# MODULE 5 — NEW RELEASES & TRENDING CHARTS MONITOR
# ──────────────────────────────────────────────────────────────────────────

def fetch_chart(session, country, category_id, chart_type, limit):
    url = f"https://itunes.apple.com/{country}/rss/{chart_type}/limit={limit}/genre={category_id}/json"
    resp = safe_get(session, url)
    if resp is None:
        return []
    try:
        payload = resp.json()
    except ValueError:
        return []

    entries = payload.get("feed", {}).get("entry", [])
    if isinstance(entries, dict):
        entries = [entries]

    chart = []
    for idx, entry in enumerate(entries):
        chart.append({
            "rank": idx + 1,
            "app_id": safe_extract(entry, "id", "attributes", "im:id"),
            "name": safe_extract(entry, "im:name", "label"),
            "artist": safe_extract(entry, "im:artist", "label"),
            "release_date_label": safe_extract(entry, "im:releaseDate", "label"),
        })
    return chart


def run_charts_monitor(session, project, prev_charts):
    data = {}
    csv_rows = []
    today = date.today().isoformat()

    for country in project["countries"]:
        data[country] = {}
        for category_id, category_name in project["categories"].items():
            data[country][category_id] = {}
            prev_country_cat = prev_charts.get(country, {}).get(category_id, {})

            for chart_type in config.CHART_TYPES:
                entries = fetch_chart(session, country, category_id, chart_type, config.CHART_LIMIT)
                prev_ids = {
                    e.get("app_id") for e in prev_country_cat.get(chart_type, [])
                    if isinstance(e, dict)
                }

                recent_new_releases = []
                for e in entries:
                    e["is_new_entrant"] = bool(prev_ids) and e["app_id"] not in prev_ids

                    if config.ENRICH_CHART_WITH_RELEASE_DATES and e["app_id"]:
                        meta = fetch_app_metadata(session, e["app_id"], country=country)
                        if meta and meta.get("release_date"):
                            try:
                                rd = datetime.fromisoformat(meta["release_date"].replace("Z", "+00:00"))
                                age_days = (datetime.now(rd.tzinfo) - rd).days
                                e["release_date_iso"] = meta["release_date"]
                                e["age_days"] = age_days
                                if age_days <= config.NEW_RELEASE_LOOKBACK_DAYS:
                                    recent_new_releases.append(e)
                            except (ValueError, TypeError):
                                pass

                data[country][category_id][chart_type] = entries
                data[country][category_id][f"{chart_type}_recent_new_releases"] = recent_new_releases

                for e in entries:
                    csv_rows.append(_csv_row(
                        today, project["id"], "chart_entry", country=country, category_id=category_id,
                        app_id=e.get("app_id") or "", metric_name=f"{chart_type}_rank",
                        metric_value=e["rank"],
                        notes=f"{e.get('name')} | new_entrant={e['is_new_entrant']}",
                    ))

                new_count = sum(1 for e in entries if e["is_new_entrant"])
                print(f"      [{country}] {category_name} / {chart_type}: "
                      f"{len(entries)} entries, {new_count} new entrants")

    return data, csv_rows


# ──────────────────────────────────────────────────────────────────────────
# PER-PROJECT ORCHESTRATION
# ──────────────────────────────────────────────────────────────────────────

def run_project(session, project, prev_project_snapshot):
    """Runs all five modules for a single tracked project. Every module is
    independently try/excepted so one broken endpoint doesn't take out the
    rest of this project's data, or any other project's."""
    project_entry = {"app_id": project["app_id"], "label": project["label"]}
    csv_rows = []
    auto_competitors = set()

    print(f"\n  [1/5] Keyword Rank Tracker")
    try:
        kr_data, kr_rows, auto_competitors = run_keyword_rank_tracker(session, project)
        project_entry["keyword_ranks"] = kr_data
        csv_rows.extend(kr_rows)
    except Exception as e:
        print(f"    ERROR in keyword rank tracker: {e}")
        project_entry["keyword_ranks"] = {"error": str(e)}

    print(f"\n  [2/5] Competitor Metadata Timeline & Update Spy")
    try:
        competitor_ids = build_competitor_id_list(project, auto_competitors)
        lookup_country = project["countries"][0] if project["countries"] else "us"
        prev_metadata = prev_project_snapshot.get("competitor_metadata", {})
        cm_data, cm_rows = collect_competitor_metadata(
            session, project["id"], prev_metadata, competitor_ids, lookup_country
        )
        project_entry["competitor_metadata"] = cm_data
        csv_rows.extend(cm_rows)
    except Exception as e:
        print(f"    ERROR in competitor metadata spy: {e}")
        project_entry["competitor_metadata"] = {"error": str(e)}

    print(f"\n  [3/5] Customer Review Miner & Opportunity Finder")
    try:
        review_app_ids = list(dict.fromkeys([project["app_id"], *project["competitor_app_ids"]]))
        rm_data, rm_rows = run_review_miner(session, project, review_app_ids)
        project_entry["review_mining"] = rm_data
        csv_rows.extend(rm_rows)
    except Exception as e:
        print(f"    ERROR in review miner: {e}")
        project_entry["review_mining"] = {"error": str(e)}

    print(f"\n  [4/5] Real-Time Niche Explorer & Autocomplete Search")
    try:
        ac_data, ac_rows = run_autocomplete_explorer(session, project)
        project_entry["autocomplete"] = ac_data
        csv_rows.extend(ac_rows)
    except Exception as e:
        print(f"    ERROR in autocomplete explorer: {e}")
        project_entry["autocomplete"] = {"error": str(e)}

    print(f"\n  [5/5] New Releases & Trending Charts Monitor")
    try:
        prev_charts = prev_project_snapshot.get("charts", {})
        ch_data, ch_rows = run_charts_monitor(session, project, prev_charts)
        project_entry["charts"] = ch_data
        csv_rows.extend(ch_rows)
    except Exception as e:
        print(f"    ERROR in charts monitor: {e}")
        project_entry["charts"] = {"error": str(e)}

    return project_entry, csv_rows


# ──────────────────────────────────────────────────────────────────────────
# ORCHESTRATOR
# ──────────────────────────────────────────────────────────────────────────

def main():
    print("=" * 78)
    print(f"ASO Intelligence Engine — run started {datetime.utcnow().isoformat()}Z")
    print("=" * 78)

    os.makedirs(config.DATA_DIR, exist_ok=True)
    session = get_session()

    tracking = load_tracking_config()
    projects = tracking["projects"]
    print(f"\nTracked projects: {len(projects)}"
          + (f" ({', '.join(p['label'] for p in projects)})" if projects else " — none configured yet."))

    history = load_json_history()
    today_str = date.today().isoformat()
    prev_date = get_previous_date_key(history, today_str)
    prev_snapshot = history.get(prev_date, {}) if prev_date else {}
    prev_projects = prev_snapshot.get("projects", {})
    print(f"Previous snapshot found: {prev_date or 'none (this is day 1)'}")

    today_entry = {"generated_at_utc": datetime.utcnow().isoformat() + "Z", "projects": {}}
    all_csv_rows = []

    for project in projects:
        print(f"\n{'=' * 78}\nProject: {project['label']}  (app {project['app_id']})\n{'=' * 78}")
        prev_project_snapshot = prev_projects.get(project["id"], {})
        try:
            project_entry, csv_rows = run_project(session, project, prev_project_snapshot)
            today_entry["projects"][project["id"]] = project_entry
            all_csv_rows.extend(csv_rows)
        except Exception as e:
            print(f"  ERROR running project '{project['id']}': {e}")
            today_entry["projects"][project["id"]] = {
                "app_id": project["app_id"], "label": project["label"], "error": str(e),
            }

    history[today_str] = today_entry
    save_json_history(history)
    append_csv_rows(all_csv_rows, today_str)

    print("\n" + "=" * 78)
    print(f"Done. {len(all_csv_rows)} metric rows written for {today_str} across {len(projects)} project(s).")
    print(f"  -> {config.JSON_HISTORY_PATH}")
    print(f"  -> {config.CSV_DASHBOARD_PATH}")
    print("=" * 78)


if __name__ == "__main__":
    main()
