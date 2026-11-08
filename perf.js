(function () {
  "use strict";

  const DATA_URLS = ["perf-data/perf.json", "perf.json"];  // new location first, old one as fallback
  const REFRESH_MS = 2 * 60 * 1000;     // re-read the file every 2 minutes
  const STALE_MS = 30 * 60 * 1000;      // older than 30 min = flagged as not up to date
  const COLORS = ["#5fd68a", "#f7f7f2", "#e08a4f", "#ffd27a", "#b98ce0"];  // light tints, readable on the dark panels

  const statusEl = document.getElementById("perfStatus");
  const groupsEl = document.getElementById("groups");
  const chartEl = document.getElementById("chart");
  const legendEl = document.getElementById("chartLegend");

  function fmtPct(v) {
    if (typeof v !== "number" || !isFinite(v)) return "–";
    const s = v.toFixed(2).replace("-0.00", "0.00");
    return (v > 0 ? "+" : "") + s + " %";
  }

  function signClass(v) {
    if (typeof v !== "number" || v === 0) return "";
    return v > 0 ? "pos" : "neg";
  }

  function card(label, value, kind) {
    const div = document.createElement("div");
    div.className = "perf-card";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    const v = document.createElement("div");
    const num = typeof value === "number" && isFinite(value);
    if (kind === "level") {
      v.className = "value";
      v.textContent = num ? value.toFixed(2) + " %" : "–";
    } else {
      v.className = "value " + signClass(value);
      v.textContent = kind === "ratio" ? (num ? value.toFixed(2) : "–") : fmtPct(value);
    }
    div.append(l, v);
    return div;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso || "";
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function renderCards(data) {
    const sections = (data.groups || []).map((g) => {
      const sec = document.createElement("section");
      sec.className = "perf-panel";
      const h = document.createElement("h2");
      h.textContent = g.title;
      const grid = document.createElement("div");
      grid.className = "perf-cards";
      grid.append(...(g.items || []).map((it) => card(it.label, it.value, it.kind)));
      sec.append(h, grid);
      return sec;
    });
    groupsEl.replaceChildren(...sections);
  }

  function renderChart(data) {
    const series = data.series || [];
    const hist = data.history || [];
    chartEl.replaceChildren();
    legendEl.replaceChildren();
    if (hist.length < 2 || !series.length) {
      chartEl.textContent = "Not enough data yet.";
      return;
    }

    const W = 1000, H = 360, L = 56, R = 16, T = 12, B = 34;
    const times = hist.map((h) => new Date(h.t).getTime());
    const t0 = times[0], t1 = times[times.length - 1] || t0 + 1;
    let lo = 0, hi = 0;
    hist.forEach((h) => series.forEach((s) => {
      const v = h[s.key];
      if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }));
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; hi += pad; lo -= pad;

    // Points are spaced by index, not by clock time, so nights and weekends do not leave flat gaps.
    const n = hist.length;
    const x = (i) => L + (i / (n - 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const el = (name, attrs, text) => {
      const e = document.createElementNS(NS, name);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
      if (text != null) e.textContent = text;
      svg.appendChild(e);
      return e;
    };

    // y grid: 5 ticks
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "axis" });
      el("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(1) + "%");
    }
    if (lo < 0 && hi > 0) el("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), class: "zero" });

    // x labels: first, middle, last
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => {
      const d = new Date(times[i]);
      el("text", { x: x(i), y: H - 10, "text-anchor": ["start", "middle", "end"][k] },
        d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }));
    });

    series.forEach((s, si) => {
      const c = COLORS[si % COLORS.length];
      let d = "", pen = false;
      hist.forEach((h, i) => {
        const v = h[s.key];
        if (typeof v !== "number") { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
        pen = true;
      });
      el("path", { d, fill: "none", stroke: c, "stroke-width": 2.5, "stroke-linejoin": "round" });
      const lg = document.createElement("span");
      lg.style.setProperty("--c", c);
      lg.textContent = s.label;
      legendEl.appendChild(lg);
    });

    chartEl.appendChild(svg);
  }

  async function load() {
    try {
      let data = null;
      for (const url of DATA_URLS) {
        try {
          const res = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
          if (res.ok) { data = await res.json(); break; }
        } catch (_) { /* missing or not JSON (nginx falls back to index.html): try the next one */ }
      }
      if (!data) throw new Error("no data");
      renderCards(data);
      renderChart(data);
      const age = Date.now() - new Date(data.updated).getTime();
      statusEl.textContent = "Last update: " + fmtDate(data.updated);
      statusEl.classList.toggle("stale", age > STALE_MS);
      if (age > STALE_MS) statusEl.textContent += " (markets closed or update paused)";
    } catch (e) {
      statusEl.textContent = "Performance data is not available right now.";
      statusEl.classList.add("stale");
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();
