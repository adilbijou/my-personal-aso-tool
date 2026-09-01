/**
 * app.js — DOM wiring for the ASO Intelligence dashboard.
 * All data logic lives in data-utils.js (window.ASOUtils); this file only
 * fetches data, builds the search index, and renders it into the page.
 */
(function () {
  "use strict";

  const DATA_JSON_URL = "data/comprehensive_aso_history.json";
  const DATA_CSV_URL = "data/aso_dashboard.csv";

  const state = {
    history: {},
    dates: [],
    selectedDate: null,
    csvRows: [],
    activeTab: "overview",
    searchIndex: [],
    trendChart: null,
  };

  const el = {};
  function cacheEls() {
    [
      "brand-app-name", "sidebar-footer", "page-title", "global-search", "search-results",
      "date-prev", "date-next", "date-label", "scoreboard", "signal-feed-container",
      "keyword-filter", "keyword-country-filter", "keyword-trend-panel", "keyword-table-body", "keyword-empty",
      "competitor-filter", "competitor-list", "competitor-empty",
      "review-app-select", "review-country-select", "review-body",
      "niche-seed-select", "niche-filter", "niche-body",
      "chart-country-select", "chart-category-select", "chart-type-select", "chart-filter", "chart-body",
      "nav-count-keywords", "nav-count-competitors", "nav-count-charts",
    ].forEach((id) => { el[id] = document.getElementById(id); });
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  function todayEntry() {
    return state.history[state.selectedDate] || {};
  }

  // ── Data loading ──────────────────────────────────────────────────

  async function loadData() {
    let historyOk = true;
    let csvOk = true;

    try {
      const resp = await fetch(DATA_JSON_URL, { cache: "no-store" });
      state.history = resp.ok ? await resp.json() : {};
      if (!resp.ok) historyOk = false;
    } catch (e) {
      state.history = {};
      historyOk = false;
    }

    try {
      const resp = await fetch(DATA_CSV_URL, { cache: "no-store" });
      if (resp.ok) {
        const text = await resp.text();
        const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
        state.csvRows = parsed.data;
      } else {
        state.csvRows = [];
        csvOk = false;
      }
    } catch (e) {
      state.csvRows = [];
      csvOk = false;
    }

    state.dates = ASOUtils.sortedDates(state.history);
    state.selectedDate = state.dates.length ? state.dates[state.dates.length - 1] : null;

    if (!historyOk || !csvOk || state.dates.length === 0) {
      console.warn("ASO Intelligence: no data yet — has the daily workflow run?");
    }

    render();
  }

  // ── Tab switching ────────────────────────────────────────────────

  const TAB_TITLES = {
    overview: "Overview",
    keywords: "Keyword ranks",
    competitors: "Competitors",
    reviews: "Reviews",
    niche: "Niche explorer",
    charts: "Charts & new releases",
  };

  function switchTab(tab, payload) {
    state.activeTab = tab;
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${tab}`);
    });
    el["page-title"].textContent = TAB_TITLES[tab] || tab;
    window.location.hash = tab;

    if (payload) applyFocus(tab, payload);
  }

  function applyFocus(tab, payload) {
    if (tab === "keywords" && payload.keyword) {
      el["keyword-filter"].value = payload.keyword;
      if (payload.country) el["keyword-country-filter"].value = payload.country;
      renderKeywords();
      renderKeywordTrend(payload.keyword, payload.country || el["keyword-country-filter"].value);
    } else if (tab === "competitors" && payload.appId) {
      const meta = todayEntry().competitor_metadata?.[payload.appId];
      el["competitor-filter"].value = meta && meta.title ? meta.title : "";
      renderCompetitors();
    } else if (tab === "niche" && payload.seed) {
      el["niche-seed-select"].value = payload.seed;
      el["niche-filter"].value = payload.term || "";
      renderNiche();
    } else if (tab === "charts" && payload.country) {
      el["chart-country-select"].value = payload.country;
      el["chart-category-select"].value = payload.catId;
      el["chart-type-select"].value = payload.chartType;
      el["chart-filter"].value = "";
      renderCharts();
    }
  }

  // ── Date navigation ──────────────────────────────────────────────

  function renderDateNav() {
    const idx = state.dates.indexOf(state.selectedDate);
    el["date-label"].textContent = state.selectedDate || "No data";
    el["date-prev"].disabled = idx <= 0;
    el["date-next"].disabled = idx === -1 || idx >= state.dates.length - 1;
  }

  function goToDate(deltaOrDate) {
    if (typeof deltaOrDate === "number") {
      const idx = state.dates.indexOf(state.selectedDate);
      const next = idx + deltaOrDate;
      if (next < 0 || next >= state.dates.length) return;
      state.selectedDate = state.dates[next];
    } else {
      state.selectedDate = deltaOrDate;
    }
    render();
  }

  // ── Sidebar / brand ──────────────────────────────────────────────

  function renderSidebar() {
    const today = todayEntry();
    const meta = today.competitor_metadata || {};
    // Object keys that look like integers (all app IDs do) get reordered
    // to ascending numeric order by the JS engine, so we can't just take
    // Object.keys(meta)[0] and assume it's the target app — we look it up
    // by the explicit target_app_id the engine records each day instead.
    const targetApp = today.target_app_id ? meta[today.target_app_id] : null;
    el["brand-app-name"].textContent = targetApp && targetApp.title
      ? `Tracking ${targetApp.title}`
      : (state.dates.length ? "Tracking your app" : "No data yet");

    const kwCount = Object.values(today.keyword_ranks || {}).reduce((sum, kws) => sum + Object.keys(kws || {}).length, 0);
    const compCount = Object.keys(meta).length;
    let chartCount = 0;
    for (const cats of Object.values(today.charts || {})) {
      for (const chartTypes of Object.values(cats || {})) {
        for (const [ct, entries] of Object.entries(chartTypes || {})) {
          if (!ct.endsWith("_recent_new_releases") && Array.isArray(entries)) chartCount += entries.length;
        }
      }
    }
    el["nav-count-keywords"].textContent = kwCount ? String(kwCount) : "";
    el["nav-count-competitors"].textContent = compCount ? String(compCount) : "";
    el["nav-count-charts"].textContent = chartCount ? String(chartCount) : "";

    if (state.dates.length) {
      el["sidebar-footer"].innerHTML =
        `Last updated ${esc(state.dates[state.dates.length - 1])}<br>${state.dates.length} day${state.dates.length === 1 ? "" : "s"} of history`;
    } else {
      el["sidebar-footer"].textContent = "Data refreshes daily via GitHub Actions.";
    }
  }

  // ── Overview ──────────────────────────────────────────────────────

  function renderOverview() {
    const today = todayEntry();

    if (state.dates.length === 0) {
      el.scoreboard.innerHTML = "";
      el["signal-feed-container"].innerHTML = emptyStateHtml(
        "No signals yet",
        "The daily workflow hasn't produced any data yet. Trigger it manually from the Actions tab, or wait for the next scheduled 6 AM UTC run."
      );
      return;
    }

    const kwEntries = Object.values(today.keyword_ranks || {}).flatMap((kws) => Object.values(kws || {}));
    const rankedKw = kwEntries.filter((d) => d && !d.error && d.rank != null);
    const bestRank = rankedKw.length ? Math.min(...rankedKw.map((d) => d.rank)) : null;

    const compCount = Object.keys(today.competitor_metadata || {}).length;

    let newEntrants = 0;
    for (const cats of Object.values(today.charts || {})) {
      for (const chartTypes of Object.values(cats || {})) {
        for (const [ct, entries] of Object.entries(chartTypes || {})) {
          if (ct.endsWith("_recent_new_releases") || !Array.isArray(entries)) continue;
          newEntrants += entries.filter((e) => e.is_new_entrant).length;
        }
      }
    }

    let metaChanges = 0;
    for (const m of Object.values(today.competitor_metadata || {})) {
      metaChanges += (m.changes_since_last_run || []).length;
    }

    const stats = [
      { label: "Keywords tracked", value: kwEntries.length },
      { label: "Best rank today", value: bestRank != null ? `#${bestRank}` : "—" },
      { label: "Competitors watched", value: compCount },
      { label: "New chart entrants", value: newEntrants },
      { label: "Metadata changes", value: metaChanges },
    ];

    el.scoreboard.innerHTML = stats.map((s) => `
      <div class="stat-block">
        <div class="stat-value">${esc(s.value)}</div>
        <div class="stat-label">${esc(s.label)}</div>
      </div>
    `).join("");

    const signals = ASOUtils.buildSignalFeed(state.history, state.dates, state.selectedDate);
    if (signals.length === 0) {
      el["signal-feed-container"].innerHTML = emptyStateHtml(
        "No changes detected",
        "Nothing moved between this snapshot and the previous one — or this is the first tracked day, so there's nothing to compare against yet."
      );
      return;
    }

    el["signal-feed-container"].innerHTML = `<div class="signal-feed">${signals.map((s, i) => `
      <button class="signal-row" data-signal-index="${i}">
        <span class="signal-dot ${s.kind}"></span>
        <span>${esc(s.text)}</span>
      </button>
    `).join("")}</div>`;

    el["signal-feed-container"].querySelectorAll(".signal-row").forEach((row, i) => {
      row.addEventListener("click", () => {
        const s = signals[i];
        switchTab(s.tab, s.payload);
      });
    });
  }

  function emptyStateHtml(title, body) {
    return `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
  }

  // ── Keywords ──────────────────────────────────────────────────────

  function keywordCountries() {
    const today = todayEntry();
    return Object.keys(today.keyword_ranks || {});
  }

  function populateKeywordFilters() {
    const countries = keywordCountries();
    const current = el["keyword-country-filter"].value;
    el["keyword-country-filter"].innerHTML =
      `<option value="">All countries</option>` + countries.map((c) => `<option value="${esc(c)}">${esc(c.toUpperCase())}</option>`).join("");
    if (countries.includes(current)) el["keyword-country-filter"].value = current;
  }

  function renderKeywords() {
    const today = todayEntry();
    const ranks = today.keyword_ranks || {};
    const filterText = (el["keyword-filter"].value || "").toLowerCase();
    const filterCountry = el["keyword-country-filter"].value;

    const rows = [];
    for (const [country, kws] of Object.entries(ranks)) {
      if (filterCountry && country !== filterCountry) continue;
      for (const [keyword, d] of Object.entries(kws || {})) {
        if (filterText && !keyword.toLowerCase().includes(filterText)) continue;
        rows.push({ country, keyword, ...d });
      }
    }

    if (state.dates.length === 0 || rows.length === 0) {
      el["keyword-table-body"].innerHTML = "";
      el["keyword-empty"].style.display = "block";
      el["keyword-empty"].innerHTML = emptyStateHtml(
        state.dates.length === 0 ? "No data yet" : "No keywords match",
        state.dates.length === 0 ? "Run the workflow to start tracking keyword ranks." : "Try a different filter or country."
      );
      return;
    }
    el["keyword-empty"].style.display = "none";

    // previous date for the "change" column
    const idx = state.dates.indexOf(state.selectedDate);
    const prevEntry = idx > 0 ? state.history[state.dates[idx - 1]] : null;

    el["keyword-table-body"].innerHTML = rows.map((r) => {
      if (r.error) {
        return `<tr><td>${esc(r.keyword)}</td><td>${esc(r.country.toUpperCase())}</td><td colspan="4" class="delta-flat">lookup failed</td></tr>`;
      }
      const prevD = prevEntry?.keyword_ranks?.[r.country]?.[r.keyword];
      let deltaHtml = `<span class="delta-flat">—</span>`;
      if (prevD && !prevD.error && prevD.rank != null && r.rank != null) {
        const delta = prevD.rank - r.rank;
        if (delta > 0) deltaHtml = `<span class="delta-up num">▲ ${delta}</span>`;
        else if (delta < 0) deltaHtml = `<span class="delta-down num">▼ ${Math.abs(delta)}</span>`;
        else deltaHtml = `<span class="delta-flat num">flat</span>`;
      }
      return `
        <tr data-keyword="${esc(r.keyword)}" data-country="${esc(r.country)}">
          <td>${esc(r.keyword)}</td>
          <td><span class="badge badge-country">${esc(r.country.toUpperCase())}</span></td>
          <td class="num">${r.rank != null ? "#" + esc(r.rank) : "—"}</td>
          <td>${deltaHtml}</td>
          <td class="num">${esc(r.difficulty_score)}</td>
          <td class="num">${esc(r.result_count)}</td>
        </tr>`;
    }).join("");

    el["keyword-table-body"].querySelectorAll("tr[data-keyword]").forEach((tr) => {
      tr.addEventListener("click", () => renderKeywordTrend(tr.dataset.keyword, tr.dataset.country));
    });
  }

  function renderKeywordTrend(keyword, country) {
    const trend = ASOUtils.computeKeywordTrend(state.csvRows, keyword, country);
    el["keyword-trend-panel"].innerHTML = `
      <div class="trend-panel">
        <h2 class="section-heading">${esc(keyword)} <span class="badge badge-country">${esc(country.toUpperCase())}</span></h2>
        <canvas id="trend-canvas" height="80"></canvas>
      </div>`;

    if (state.trendChart) { state.trendChart.destroy(); state.trendChart = null; }
    if (!trend.length || typeof Chart === "undefined") return;

    const ctx = document.getElementById("trend-canvas").getContext("2d");
    state.trendChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: trend.map((t) => t.date),
        datasets: [{
          label: "Rank",
          data: trend.map((t) => t.rank),
          borderColor: "#5b93ff",
          backgroundColor: "rgba(91,147,255,0.12)",
          spanGaps: true,
          tension: 0.25,
          pointRadius: 3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { reverse: true, ticks: { color: "#9298a6" }, grid: { color: "#262a33" }, title: { display: true, text: "Rank (lower is better)", color: "#9298a6" } },
          x: { ticks: { color: "#9298a6" }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Competitors ───────────────────────────────────────────────────

  function renderCompetitors() {
    const today = todayEntry();
    const meta = today.competitor_metadata || {};
    const filterText = (el["competitor-filter"].value || "").toLowerCase();

    const apps = Object.entries(meta).filter(([appId, m]) => {
      if (m.error) return false;
      if (!filterText) return true;
      return (m.title || appId).toLowerCase().includes(filterText);
    });

    if (state.dates.length === 0 || apps.length === 0) {
      el["competitor-list"].innerHTML = "";
      el["competitor-empty"].style.display = "block";
      el["competitor-empty"].innerHTML = emptyStateHtml(
        state.dates.length === 0 ? "No data yet" : "No competitors match",
        state.dates.length === 0 ? "Run the workflow to start tracking competitor metadata." : "Try a different filter."
      );
      return;
    }
    el["competitor-empty"].style.display = "none";

    el["competitor-list"].innerHTML = apps.map(([appId, m]) => {
      const changes = m.changes_since_last_run || [];
      const changesHtml = changes.length
        ? `<div class="change-list">${changes.map((c) => `<div><strong>${esc(ASOUtils.formatFieldName(c.field))}</strong> changed &mdash; was: ${esc((c.old || "").slice(0, 90))}${c.old && c.old.length > 90 ? "…" : ""}</div>`).join("")}</div>`
        : "";
      const iconSrc = m.icon_url || "";
      return `
        <div class="competitor-row">
          ${iconSrc ? `<img class="competitor-icon" src="${esc(iconSrc)}" alt="" loading="lazy">` : `<div class="competitor-icon"></div>`}
          <div style="flex:1; min-width:0;">
            <div class="competitor-title">${esc(m.title || appId)}</div>
            <div class="competitor-meta">v${esc(m.version || "?")} &middot; ${esc(m.primary_genre || "")} &middot; ${esc(m.rating_count || 0)} ratings</div>
            ${changesHtml}
          </div>
          <div class="competitor-rating">${m.average_rating != null ? "★ " + esc(m.average_rating) : ""}</div>
        </div>`;
    }).join("");
  }

  // ── Reviews ───────────────────────────────────────────────────────

  function populateReviewSelects() {
    const today = todayEntry();
    const rm = today.review_mining || {};
    // Put the target app first so it's the default selection, then the
    // rest in whatever order Object.keys gives us (see the note in
    // renderSidebar about numeric-string key reordering).
    const appIds = Object.keys(rm).sort((a, b) => {
      if (a === today.target_app_id) return -1;
      if (b === today.target_app_id) return 1;
      return 0;
    });
    const currentApp = el["review-app-select"].value;
    el["review-app-select"].innerHTML = appIds.map((id) => {
      const title = today.competitor_metadata?.[id]?.title || id;
      return `<option value="${esc(id)}">${esc(title)}</option>`;
    }).join("");
    if (appIds.includes(currentApp)) el["review-app-select"].value = currentApp;

    const selectedApp = el["review-app-select"].value;
    const countries = selectedApp ? Object.keys(rm[selectedApp] || {}) : [];
    const currentCountry = el["review-country-select"].value;
    el["review-country-select"].innerHTML = countries.map((c) => `<option value="${esc(c)}">${esc(c.toUpperCase())}</option>`).join("");
    if (countries.includes(currentCountry)) el["review-country-select"].value = currentCountry;
  }

  function renderReviews() {
    const today = todayEntry();
    const rm = today.review_mining || {};
    const appId = el["review-app-select"].value;
    const country = el["review-country-select"].value;
    const data = appId && country ? rm[appId]?.[country] : null;

    if (state.dates.length === 0 || !data || data.error) {
      el["review-body"].innerHTML = emptyStateHtml(
        state.dates.length === 0 ? "No data yet" : "No reviews found",
        state.dates.length === 0 ? "Run the workflow to start mining reviews." : "This app/country combination had no reviews in the sampled pages."
      );
      return;
    }

    const maxTop = Math.max(1, ...data.top_15_words.map((w) => w[1]));
    const maxGap = Math.max(1, ...data.feature_gap_words.map((w) => w[1]));

    const wordBars = (words, max, negative) => words.map(([word, count]) => `
      <div class="word-bar-row">
        <span>${esc(word)}</span>
        <div class="word-bar-track"><div class="word-bar-fill ${negative ? "negative" : ""}" style="width:${Math.round((count / max) * 100)}%"></div></div>
        <span class="num">${esc(count)}</span>
      </div>`).join("");

    const samplesHtml = data.sample_negative_reviews.length
      ? data.sample_negative_reviews.map((r) => `
        <div class="review-card">
          <div class="review-card-head">
            <span class="review-rating">${esc(r.rating)}★</span>
            <span class="review-title">${esc(r.title)}</span>
          </div>
          <div class="review-snippet">${esc(r.snippet)}${r.snippet.length >= 250 ? "…" : ""}</div>
        </div>`).join("")
      : `<p class="section-sub">No 1&ndash;2★ reviews in this sample.</p>`;

    el["review-body"].innerHTML = `
      <div class="scoreboard">
        <div class="stat-block"><div class="stat-value">${esc(data.reviews_analyzed)}</div><div class="stat-label">Reviews analyzed</div></div>
        <div class="stat-block"><div class="stat-value">${esc(data.average_rating_sampled)}</div><div class="stat-label">Average rating</div></div>
        <div class="stat-block"><div class="stat-value">${esc(data.negative_review_count)}</div><div class="stat-label">1&ndash;2★ reviews</div></div>
      </div>
      <div class="two-col">
        <div class="panel">
          <h2 class="section-heading">Top words</h2>
          ${wordBars(data.top_15_words, maxTop, false)}
        </div>
        <div class="panel">
          <h2 class="section-heading">Feature gap (1&ndash;2★ reviews)</h2>
          ${wordBars(data.feature_gap_words, maxGap, true)}
        </div>
      </div>
      <h2 class="section-heading">Sample negative reviews</h2>
      ${samplesHtml}
    `;
  }

  // ── Niche explorer ────────────────────────────────────────────────

  function populateNicheSelect() {
    const today = todayEntry();
    const seeds = Object.keys(today.autocomplete || {});
    const current = el["niche-seed-select"].value;
    el["niche-seed-select"].innerHTML = seeds.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    if (seeds.includes(current)) el["niche-seed-select"].value = current;
  }

  function renderNiche() {
    const today = todayEntry();
    const ac = today.autocomplete || {};
    const seed = el["niche-seed-select"].value;
    const seedData = seed ? ac[seed] : null;

    if (state.dates.length === 0 || !seedData) {
      el["niche-body"].innerHTML = emptyStateHtml(
        state.dates.length === 0 ? "No data yet" : "No suggestions found",
        state.dates.length === 0 ? "Run the workflow to start exploring long-tail keywords." : "Try a different seed keyword."
      );
      return;
    }

    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const letterGridHtml = letters.map((L) => {
      const hints = seedData[L] || [];
      return `<button class="letter-tile" data-letter="${L}"><span class="letter-char">${L}</span><span class="letter-count">${hints.length}</span></button>`;
    }).join("");

    const filterText = (el["niche-filter"].value || "").toLowerCase();
    const allTerms = seedData._all_unique_longtail || [];
    const filtered = filterText ? allTerms.filter((t) => t.toLowerCase().includes(filterText)) : allTerms;

    el["niche-body"].innerHTML = `
      <p class="section-sub">A-to-Z expansion of "${esc(seed)}" &mdash; ${esc(allTerms.length)} unique long-tail suggestions found.</p>
      <div class="letter-grid">${letterGridHtml}</div>
      <h2 class="section-heading">${filterText ? "Matching suggestions" : "All suggestions"}</h2>
      <div class="longtail-list">${filtered.map((t) => `<span class="longtail-chip">${esc(t)}</span>`).join("") || `<p class="section-sub">No suggestions match.</p>`}</div>
    `;

    el["niche-body"].querySelectorAll(".letter-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const L = tile.dataset.letter;
        const hints = seedData[L] || [];
        document.querySelectorAll(".letter-tile").forEach((t) => t.classList.remove("active"));
        tile.classList.add("active");
        const listHeading = el["niche-body"].querySelector(".section-heading:last-of-type");
        const list = el["niche-body"].querySelector(".longtail-list");
        if (listHeading) listHeading.textContent = `Suggestions for "${seed} ${L}"`;
        if (list) list.innerHTML = hints.map((t) => `<span class="longtail-chip">${esc(t)}</span>`).join("") || `<p class="section-sub">No suggestions for this letter.</p>`;
      });
    });
  }

  // ── Charts ────────────────────────────────────────────────────────

  function populateChartFilters() {
    const today = todayEntry();
    const charts = today.charts || {};
    const countries = Object.keys(charts);
    const prevCountry = el["chart-country-select"].value;
    el["chart-country-select"].innerHTML = countries.map((c) => `<option value="${esc(c)}">${esc(c.toUpperCase())}</option>`).join("");
    if (countries.includes(prevCountry)) el["chart-country-select"].value = prevCountry;

    const selCountry = el["chart-country-select"].value;
    const cats = selCountry ? Object.keys(charts[selCountry] || {}) : [];
    const prevCat = el["chart-category-select"].value;
    el["chart-category-select"].innerHTML = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    if (cats.includes(prevCat)) el["chart-category-select"].value = prevCat;

    const selCat = el["chart-category-select"].value;
    const chartTypes = selCountry && selCat
      ? Object.keys(charts[selCountry][selCat] || {}).filter((k) => !k.endsWith("_recent_new_releases"))
      : [];
    const prevType = el["chart-type-select"].value;
    el["chart-type-select"].innerHTML = chartTypes.map((c) => `<option value="${esc(c)}">${esc(ASOUtils.formatChartTypeLabel(c))}</option>`).join("");
    if (chartTypes.includes(prevType)) el["chart-type-select"].value = prevType;
  }

  function renderCharts() {
    const today = todayEntry();
    const charts = today.charts || {};
    const country = el["chart-country-select"].value;
    const catId = el["chart-category-select"].value;
    const chartType = el["chart-type-select"].value;
    const entries = country && catId && chartType ? charts[country]?.[catId]?.[chartType] : null;
    const filterText = (el["chart-filter"].value || "").toLowerCase();

    if (state.dates.length === 0 || !Array.isArray(entries) || entries.length === 0) {
      el["chart-body"].innerHTML = emptyStateHtml(
        state.dates.length === 0 ? "No data yet" : "No chart data",
        state.dates.length === 0 ? "Run the workflow to start monitoring charts." : "Try a different country, category, or chart type."
      );
      return;
    }

    const filtered = filterText
      ? entries.filter((e) => (e.name || "").toLowerCase().includes(filterText))
      : entries;

    el["chart-body"].innerHTML = `<div class="panel" style="padding:0">${filtered.map((e) => `
      <div class="leaderboard-row">
        <span class="leaderboard-rank">${esc(e.rank)}</span>
        <div style="flex:1; min-width:0;">
          <div class="leaderboard-name">${esc(e.name || e.app_id || "Unknown")}</div>
          <div class="leaderboard-artist">${esc(e.artist || "")}</div>
        </div>
        ${e.is_new_entrant ? `<span class="badge badge-new">New</span>` : ""}
      </div>`).join("") || `<div class="empty-state"><p>No apps match this filter.</p></div>`}</div>`;
  }

  // ── Global search ─────────────────────────────────────────────────

  function handleSearchInput() {
    const q = el["global-search"].value;
    if (!q.trim()) {
      el["search-results"].classList.remove("open");
      el["search-results"].innerHTML = "";
      return;
    }
    const matches = ASOUtils.filterBySearch(state.searchIndex, q, (i) => i.label).slice(0, 20);
    if (matches.length === 0) {
      el["search-results"].innerHTML = `<div class="search-result-row" style="cursor:default">No matches</div>`;
    } else {
      el["search-results"].innerHTML = matches.map((m, i) => `
        <button class="search-result-row" data-idx="${i}">
          <span class="search-result-type">${esc(m.type)}</span>
          <span class="search-result-label">${esc(m.label)}</span>
          ${m.tags.map((t) => `<span class="badge badge-country">${esc(t)}</span>`).join("")}
        </button>`).join("");
      el["search-results"].querySelectorAll(".search-result-row[data-idx]").forEach((row) => {
        row.addEventListener("click", () => {
          const m = matches[Number(row.dataset.idx)];
          el["global-search"].value = "";
          el["search-results"].classList.remove("open");
          el["search-results"].innerHTML = "";
          switchTab(m.tab, m.payload);
        });
      });
    }
    el["search-results"].classList.add("open");
  }

  // ── Master render ─────────────────────────────────────────────────

  function render() {
    state.searchIndex = state.dates.length ? ASOUtils.buildSearchIndex(state.history, state.selectedDate) : [];
    renderSidebar();
    renderDateNav();
    populateKeywordFilters();
    populateReviewSelects();
    populateNicheSelect();
    populateChartFilters();

    renderOverview();
    renderKeywords();
    renderCompetitors();
    renderReviews();
    renderNiche();
    renderCharts();
  }

  // ── Init / event wiring ──────────────────────────────────────────

  function init() {
    cacheEls();

    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    el["date-prev"].addEventListener("click", () => goToDate(-1));
    el["date-next"].addEventListener("click", () => goToDate(1));

    el["global-search"].addEventListener("input", handleSearchInput);
    document.addEventListener("click", (e) => {
      if (!el["search-results"].contains(e.target) && e.target !== el["global-search"]) {
        el["search-results"].classList.remove("open");
      }
    });

    el["keyword-filter"].addEventListener("input", renderKeywords);
    el["keyword-country-filter"].addEventListener("change", renderKeywords);
    el["competitor-filter"].addEventListener("input", renderCompetitors);
    el["review-app-select"].addEventListener("change", () => { populateReviewSelects(); renderReviews(); });
    el["review-country-select"].addEventListener("change", renderReviews);
    el["niche-seed-select"].addEventListener("change", renderNiche);
    el["niche-filter"].addEventListener("input", renderNiche);
    el["chart-country-select"].addEventListener("change", () => { populateChartFilters(); renderCharts(); });
    el["chart-category-select"].addEventListener("change", () => { populateChartFilters(); renderCharts(); });
    el["chart-type-select"].addEventListener("change", renderCharts);
    el["chart-filter"].addEventListener("input", renderCharts);

    const initialTab = (window.location.hash || "").replace("#", "");
    if (TAB_TITLES[initialTab]) switchTab(initialTab);

    loadData();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
