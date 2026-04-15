(function () {
  const statusEl = document.getElementById("status");

  const slots = {
    monthlyReport: document.getElementById("monthly-report-slot"),
    monthlyFactSheet: document.getElementById("monthly-factsheet-slot"),
    weeklyReport: document.getElementById("weekly-report-slot"),
    dailyReport: document.getElementById("daily-report-slot"),
  };

  const expected = [
    { key: "monthlyReport", label: "Monthly Report" },
    { key: "monthlyFactSheet", label: "Monthly Fact Sheet" },
    { key: "weeklyReport", label: "Weekly Report" },
    { key: "dailyReport", label: "Daily Report" },
  ];

  function normalizeItem(item) {
    if (!item) return null;
    if (typeof item === "string") {
      return { url: item, title: "" };
    }
    if (typeof item.url !== "string") return null;
    return { url: item.url, title: item.title || "" };
  }

  function absoluteUrl(url, basePath) {
    if (!url) return "";
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) {
      return url;
    }
    return `${basePath}${url}`;
  }

  function fileNameFromUrl(url) {
    const parts = url.split("/");
    return parts[parts.length - 1] || url;
  }

  function titleFromFile(file) {
    return file.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ");
  }

  function parseDate(name) {
    const ymd = name.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/);
    if (ymd) {
      return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    }
    const ym = name.match(/(20\d{2})[-_]?([01]\d)/);
    if (ym) {
      return new Date(Number(ym[1]), Number(ym[2]) - 1, 1);
    }
    return null;
  }

  function renderSlot(el, label, item) {
    if (!el) return;
    el.innerHTML = "";
    if (!item || !item.url) {
      const empty = document.createElement("div");
      empty.className = "empty-slot";
      empty.innerHTML = `<div class="slot-name">${label}</div><div class="report-meta">No file uploaded yet</div>`;
      el.appendChild(empty);
      return;
    }

    const file = fileNameFromUrl(item.url);
    const title = item.title || titleFromFile(file);
    const date = parseDate(file);
    const a = document.createElement("a");
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.innerHTML = `<div class="slot-name">${label}</div><div>${title}</div>`;
    if (date) {
      const meta = document.createElement("div");
      meta.className = "report-meta";
      meta.textContent = date.toLocaleDateString();
      a.appendChild(meta);
    }
    el.appendChild(a);
  }

  function render(data) {
    renderSlot(slots.monthlyReport, "Monthly Report", data.monthlyReport);
    renderSlot(slots.monthlyFactSheet, "Monthly Fact Sheet", data.monthlyFactSheet);
    renderSlot(slots.weeklyReport, "Weekly Report", data.weeklyReport);
    renderSlot(slots.dailyReport, "Daily Report", data.dailyReport);

    const available = expected.filter((entry) => data[entry.key] && data[entry.key].url).length;
    statusEl.textContent = `Available: ${available}/${expected.length} required uploads.`;
  }

  function mapStructuredManifest(raw, basePath) {
    const data = {
      monthlyReport: null,
      monthlyFactSheet: null,
      weeklyReport: null,
      dailyReport: null,
    };

    if (!raw || typeof raw !== "object") return data;

    const monthly = raw.monthly || {};
    const weekly = raw.weekly || {};
    const daily = raw.daily || {};

    data.monthlyReport = normalizeItem(monthly.report);
    data.monthlyFactSheet = normalizeItem(monthly.factsheet || monthly.factSheet || monthly["fact-sheet"]);
    data.weeklyReport = normalizeItem(weekly.report);
    data.dailyReport = normalizeItem(daily.report);

    Object.keys(data).forEach((key) => {
      if (data[key] && data[key].url) {
        data[key].url = absoluteUrl(data[key].url, basePath);
      }
    });

    return data;
  }

  function scoreType(name, type) {
    const n = name.toLowerCase();
    if (type === "monthlyReport") {
      return n.includes("month") && n.includes("report");
    }
    if (type === "monthlyFactSheet") {
      return n.includes("month") && (n.includes("fact") || n.includes("sheet"));
    }
    if (type === "weeklyReport") {
      return n.includes("week") && n.includes("report");
    }
    if (type === "dailyReport") {
      return n.includes("day") && n.includes("report");
    }
    return false;
  }

  function pickLatestByType(items, type) {
    const matches = items.filter((item) => scoreType(fileNameFromUrl(item.url), type));
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const da = parseDate(fileNameFromUrl(a.url));
      const db = parseDate(fileNameFromUrl(b.url));
      if (da && db) return db - da;
      return fileNameFromUrl(b.url).localeCompare(fileNameFromUrl(a.url));
    });
    return matches[0];
  }

  async function loadManifest() {
    const basePath = "/reportory/";
    const res = await fetch(`${basePath}manifest.json`, { cache: "no-store" });
    if (!res.ok) throw new Error("manifest not found");
    const raw = await res.json();
    const structured = mapStructuredManifest(raw, basePath);

    if (Array.isArray(raw.items)) {
      const items = raw.items
        .map(normalizeItem)
        .filter(Boolean)
        .map((item) => ({
          url: absoluteUrl(item.url, basePath),
          title: item.title || "",
        }))
        .filter((item) => item.url.toLowerCase().endsWith(".pdf"));

      if (!structured.monthlyReport) structured.monthlyReport = pickLatestByType(items, "monthlyReport");
      if (!structured.monthlyFactSheet) structured.monthlyFactSheet = pickLatestByType(items, "monthlyFactSheet");
      if (!structured.weeklyReport) structured.weeklyReport = pickLatestByType(items, "weeklyReport");
      if (!structured.dailyReport) structured.dailyReport = pickLatestByType(items, "dailyReport");
    }

    return structured;
  }

  function parseAutoIndex(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll("a"));
    return links
      .map((a) => a.getAttribute("href") || "")
      .filter((href) => href && !href.endsWith("/") && href.toLowerCase().endsWith(".pdf"))
      .map((href) => ({
        url: href.startsWith("http://") || href.startsWith("https://") ? href : baseUrl + href,
      }));
  }

  async function loadAutoIndex() {
    const basePath = "/reportory/";
    const res = await fetch(basePath, { cache: "no-store" });
    if (!res.ok) throw new Error("no index");
    const items = parseAutoIndex(await res.text(), basePath);
    return {
      monthlyReport: pickLatestByType(items, "monthlyReport"),
      monthlyFactSheet: pickLatestByType(items, "monthlyFactSheet"),
      weeklyReport: pickLatestByType(items, "weeklyReport"),
      dailyReport: pickLatestByType(items, "dailyReport"),
    };
  }

  async function main() {
    let data = null;
    try {
      data = await loadManifest();
    } catch (e) {
      try {
        data = await loadAutoIndex();
      } catch (e2) {
        data = {
          monthlyReport: null,
          monthlyFactSheet: null,
          weeklyReport: null,
          dailyReport: null,
        };
      }
    }
    render(data);
  }

  main();
})();
