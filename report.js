(function () {
  "use strict";

  // Published reports are listed in /reportory/manifest.json (written by publish.sh on the server):
  // { "monthly": [{ "period", "title", "start", "url", "urlFr", "published" }, ...], "weekly", "quarterly", "annual": [...] }, newest first.
  // url = English PDF, urlFr = French PDF: the page opens the one matching the site language
  // (French falls back to English, marked "PDF en anglais"). Report titles are rebuilt in the page language.
  const BASE = "/reportory/";
  const SHOW_OLDER = 6; // older reports shown before "Show all"

  const I = window.ST_I18N;
  const tr = (key, fallback, vars) => (I ? I.t(key, vars) : fallback);
  const loc = () => (I ? I.locale : undefined);

  const statusEl = document.getElementById("status");
  const KINDS = ["weekly", "monthly", "quarterly", "annual"]; // page order
  const boxes = Object.fromEntries(KINDS.map((k) => [k, document.getElementById(k + "-list")]));
  let data = null;

  function href(url) {
    return /^(https?:)?\//.test(url) ? url : BASE + url;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric" });
  }

  // "2026-11" -> "November 2026" / "Novembre 2026"; "2026-W47" + start -> "Week 47, 16–20 November 2026";
  // "2026-Q4" -> "Q4 2026" / "4e trimestre 2026"; "2026" -> "Year 2026" / "Année 2026"
  function title(item) {
    const p = item.period || "";
    let q = /^(\d{4})-Q([1-4])$/.exec(p);
    if (q) return tr("report.quarter" + (q[2] === "1" ? "1" : ""), item.title, { n: +q[2], year: q[1] });
    if (/^\d{4}$/.test(p)) return tr("report.year", item.title, { year: p });
    let m = /^(\d{4})-(\d{2})$/.exec(p);
    if (m) {
      const s = new Date(Date.UTC(+m[1], +m[2] - 1, 15)).toLocaleDateString(loc(), { month: "long", year: "numeric", timeZone: "UTC" });
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    m = /^\d{4}-W(\d{2})$/.exec(p);
    if (m && /^\d{4}-\d{2}-\d{2}$/.test(item.start || "")) {
      const mon = new Date(item.start + "T12:00:00Z");
      const fri = new Date(mon.getTime() + 4 * 86400000);
      const o = { timeZone: "UTC" };
      const end = fri.toLocaleDateString(loc(), { ...o, day: "numeric", month: "long", year: "numeric" });
      const start = mon.getUTCMonth() === fri.getUTCMonth()
        ? String(mon.getUTCDate())
        : mon.toLocaleDateString(loc(), { ...o, day: "numeric", month: "long", ...(mon.getUTCFullYear() !== fri.getUTCFullYear() ? { year: "numeric" } : {}) });
      return tr("report.week", item.title, { n: +m[1], range: `${start}–${end}` });
    }
    return item.title || p;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // PDF in the page language when it exists
  const isFr = () => !!(I && I.lang === "fr");
  const hasOwnLang = (item) => !isFr() || !!item.urlFr;
  function pdfUrl(item) {
    return isFr() && item.urlFr ? item.urlFr : item.url;
  }

  function link(item, cls) {
    const a = el("a", cls);
    a.href = href(pdfUrl(item));
    a.hreflang = isFr() && item.urlFr ? "fr" : "en";
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function renderList(kind, items) {
    const box = boxes[kind];
    const name = tr(`report.${kind}Name`, kind);
    box.replaceChildren();
    if (!items.length) {
      const ul = el("ul", "slot-list");
      const li = el("li");
      const div = el("div", "empty-slot");
      div.append(el("div", "slot-name", name), el("div", "report-meta", tr(`report.${kind}Empty`, "")));
      li.append(div);
      ul.append(li);
      box.append(ul);
      return;
    }

    const [latest, ...older] = items;
    box.append(el("div", "latest-label", tr("report.latest", "Latest")));
    const ul = el("ul", "slot-list");
    const li = el("li");
    const a = link(latest);
    a.append(el("div", "slot-name", title(latest)),
      el("div", "report-meta", tr(hasOwnLang(latest) ? "report.published" : "report.publishedOther", "PDF", { date: fmtDate(latest.published) })));
    li.append(a);
    ul.append(li);
    box.append(ul);

    if (!older.length) return;
    box.append(el("div", "older-title", tr("report.earlier", "Earlier")));
    const list = el("ul", "older-list");
    older.forEach((item, i) => {
      const row = el("li");
      if (i >= SHOW_OLDER) row.hidden = true;
      const a2 = link(item);
      a2.append(el("span", "", title(item)), el("span", "report-meta", tr(hasOwnLang(item) ? "report.pdf" : "report.pdfOther", "PDF")));
      row.append(a2);
      list.append(row);
    });
    box.append(list);
    if (older.length > SHOW_OLDER) {
      const btn = el("button", "more-button", tr("report.showAll", "Show all", { n: older.length }));
      btn.type = "button";
      btn.addEventListener("click", () => {
        list.querySelectorAll("li[hidden]").forEach((r) => { r.hidden = false; });
        btn.remove();
      });
      box.append(btn);
    }
  }

  function render() {
    KINDS.forEach((k) => renderList(k, data[k]));
    const n = KINDS.reduce((a, k) => a + data[k].length, 0);
    statusEl.textContent = n ? "" : tr("report.none", "No report has been published yet.");
    statusEl.hidden = n > 0;
  }

  async function main() {
    data = Object.fromEntries(KINDS.map((k) => [k, []]));
    try {
      const res = await fetch(BASE + "manifest.json?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) {
        const raw = await res.json();
        data = Object.fromEntries(KINDS.map((k) => [k, Array.isArray(raw[k]) ? raw[k].filter((x) => x && x.url) : []]));
      }
    } catch (_) { /* no manifest yet: empty columns */ }
    render();
  }

  // Language switched: redraw the lists in the new language
  document.addEventListener("st:lang", () => { if (data) render(); });

  main();
})();
