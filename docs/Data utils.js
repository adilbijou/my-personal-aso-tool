/**
 * data-utils.js — pure data transforms for the ASO Intelligence dashboard.
 *
 * Nothing in this file touches the DOM. It only reads the two data shapes
 * produced by aso_intelligence_engine.py:
 *   - history: the parsed comprehensive_aso_history.json object
 *   - csvRows: the parsed aso_dashboard.csv rows (array of objects)
 *
 * Kept separate from app.js so the logic here can be unit tested directly
 * in Node (see docs/test-data-utils.js) without spinning up a browser.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ASOUtils = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CHART_TYPE_LABELS = {
    topfreeapplications: "Top Free",
    toppaidapplications: "Top Paid",
    topgrossingapplications: "Top Grossing",
    newapplications: "New Apps",
    newfreeapplications: "New Free Apps",
    newpaidapplications: "New Paid Apps",
  };

  function formatChartTypeLabel(chartType) {
    return CHART_TYPE_LABELS[chartType] || chartType;
  }

  function formatFieldName(field) {
    return String(field || "").replace(/_/g, " ");
  }

  function sortedDates(history) {
    return Object.keys(history || {}).sort();
  }

  /**
   * Walks today's snapshot against the previous day's and produces a flat,
   * human-readable list of concrete changes: rank moves, new chart
   * entrants, metadata field updates. This is the data behind the
   * Overview tab's "Signal feed".
   */
  function buildSignalFeed(history, dates, dateStr) {
    const idx = dates.indexOf(dateStr);
    const today = history[dateStr] || {};
    const prevDateStr = idx > 0 ? dates[idx - 1] : null;
    const prev = prevDateStr ? history[prevDateStr] || {} : null;
    const signals = [];

    // --- Keyword rank moves ---
    const todayRanks = today.keyword_ranks || {};
    for (const country of Object.keys(todayRanks)) {
      const kws = todayRanks[country] || {};
      for (const keyword of Object.keys(kws)) {
        const d = kws[keyword];
        if (!d || d.error) continue;
        const prevD = prev && prev.keyword_ranks && prev.keyword_ranks[country]
          ? prev.keyword_ranks[country][keyword]
          : null;

        if (prevD && !prevD.error && prevD.rank != null && d.rank != null && prevD.rank !== d.rank) {
          const delta = prevD.rank - d.rank; // positive = moved to a better (lower) rank
          signals.push({
            kind: delta > 0 ? "up" : "down",
            text: `"${keyword}" moved from #${prevD.rank} to #${d.rank} in ${country.toUpperCase()}`,
            tab: "keywords",
            payload: { keyword, country },
          });
        } else if ((!prevD || prevD.rank == null) && d.rank != null) {
          signals.push({
            kind: "info",
            text: `"${keyword}" entered the top 200 at #${d.rank} in ${country.toUpperCase()}`,
            tab: "keywords",
            payload: { keyword, country },
          });
        } else if (prevD && prevD.rank != null && d.rank == null) {
          signals.push({
            kind: "down",
            text: `"${keyword}" dropped out of the top 200 in ${country.toUpperCase()}`,
            tab: "keywords",
            payload: { keyword, country },
          });
        }
      }
    }

    // --- Competitor metadata changes ---
    const todayMeta = today.competitor_metadata || {};
    for (const appId of Object.keys(todayMeta)) {
      const m = todayMeta[appId];
      if (!m || m.error) continue;
      for (const change of m.changes_since_last_run || []) {
        signals.push({
          kind: "info",
          text: `${m.title || appId} updated its ${formatFieldName(change.field)}`,
          tab: "competitors",
          payload: { appId },
        });
      }
      if (typeof m.ratings_delta === "number" && m.ratings_delta !== 0) {
        signals.push({
          kind: m.ratings_delta > 0 ? "up" : "down",
          text: `${m.title || appId} ${m.ratings_delta > 0 ? "gained" : "lost"} ${Math.abs(m.ratings_delta)} ratings`,
          tab: "competitors",
          payload: { appId },
        });
      }
    }

    // --- New chart entrants ---
    const todayCharts = today.charts || {};
    for (const country of Object.keys(todayCharts)) {
      const cats = todayCharts[country] || {};
      for (const catId of Object.keys(cats)) {
        const chartTypes = cats[catId] || {};
        for (const chartType of Object.keys(chartTypes)) {
          if (chartType.endsWith("_recent_new_releases")) continue;
          const entries = chartTypes[chartType];
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            if (e.is_new_entrant) {
              signals.push({
                kind: "up",
                text: `${e.name || e.app_id} entered ${formatChartTypeLabel(chartType)} (${country.toUpperCase()}) at #${e.rank}`,
                tab: "charts",
                payload: { country, catId, chartType },
              });
            }
          }
        }
      }
    }

    return signals;
  }

  /**
   * Flattens today's snapshot into a single searchable index used by the
   * global search box. Each item carries small "tags" (not a joined
   * string) so the UI can render them as separate badges.
   */
  function buildSearchIndex(history, dateStr) {
    const today = history[dateStr] || {};
    const idx = [];

    for (const [country, kws] of Object.entries(today.keyword_ranks || {})) {
      for (const [keyword, d] of Object.entries(kws || {})) {
        if (!d || d.error) continue;
        idx.push({
          type: "keyword",
          label: keyword,
          tags: [country.toUpperCase(), d.rank != null ? `#${d.rank}` : "unranked"],
          tab: "keywords",
          payload: { keyword, country },
        });
      }
    }

    for (const [appId, m] of Object.entries(today.competitor_metadata || {})) {
      if (!m || m.error) continue;
      idx.push({
        type: "app",
        label: m.title || appId,
        tags: [m.version ? `v${m.version}` : null, m.average_rating != null ? `${m.average_rating}★` : null].filter(Boolean),
        tab: "competitors",
        payload: { appId },
      });
    }

    for (const [seed, seedData] of Object.entries(today.autocomplete || {})) {
      for (const term of seedData._all_unique_longtail || []) {
        idx.push({
          type: "longtail",
          label: term,
          tags: [`from "${seed}"`],
          tab: "niche",
          payload: { seed, term },
        });
      }
    }

    for (const [country, cats] of Object.entries(today.charts || {})) {
      for (const [catId, chartTypes] of Object.entries(cats || {})) {
        for (const [chartType, entries] of Object.entries(chartTypes || {})) {
          if (chartType.endsWith("_recent_new_releases") || !Array.isArray(entries)) continue;
          for (const e of entries) {
            idx.push({
              type: "chart",
              label: e.name || e.app_id,
              tags: [`#${e.rank}`, formatChartTypeLabel(chartType)],
              tab: "charts",
              payload: { country, catId, chartType },
            });
          }
        }
      }
    }

    return idx;
  }

  function filterBySearch(list, query, keyFn) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return list;
    return list.filter((item) => String(keyFn(item) || "").toLowerCase().includes(q));
  }

  /**
   * Builds a rank-over-time series for one keyword/country pair from the
   * flat CSV rows (module=keyword_rank, metric_name=rank).
   */
  function computeKeywordTrend(csvRows, keyword, country) {
    return csvRows
      .filter((r) => r.module === "keyword_rank" && r.metric_name === "rank"
        && r.keyword === keyword && r.country === country)
      .map((r) => ({
        date: r.date,
        rank: r.metric_value === "" || r.metric_value == null ? null : Number(r.metric_value),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  return {
    formatChartTypeLabel,
    formatFieldName,
    sortedDates,
    buildSignalFeed,
    buildSearchIndex,
    filterBySearch,
    computeKeywordTrend,
  };
});
