// i18n/i18n.js — French / English for saheltrigger.net (no framework).
//
// The texts live in i18n/en.js and i18n/fr.js (window.ST_LOCALES.en / .fr, keys like "home.title").
// In the HTML:
//   <h1 data-i18n="refo.title">English text</h1>                 -> text replaced
//   <img data-i18n-attr="alt:nav.logoAlt, title:nav.logoAlt">     -> attributes replaced
// The English in the HTML is only the fallback for browsers without JavaScript.
//
// Language: ?lang=fr|en in the URL, else the last choice (localStorage), else the browser language.
// Page scripts use window.ST_I18N.t("key", { n: 3 }) and listen to the "st:lang" event to redraw.
(function () {
  "use strict";

  const LANGS = ["fr", "en"];
  const KEY = "st-lang";
  const DICT = window.ST_LOCALES || {};

  function initial() {
    try {
      const q = new URLSearchParams(location.search).get("lang");
      if (LANGS.includes(q)) { localStorage.setItem(KEY, q); return q; }
    } catch (_) { /* ignore */ }
    try {
      const saved = localStorage.getItem(KEY);
      if (LANGS.includes(saved)) return saved;
    } catch (_) { /* storage blocked: use the browser language */ }
    return /^fr\b/i.test(navigator.language || "") ? "fr" : "en";
  }

  let lang = initial();

  // Missing key in French -> English -> the key itself
  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) ?? (DICT.en && DICT.en[key]) ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }

  // Optional translation (for labels coming from data files): returns the fallback if the key is unknown
  function tOr(key, fallback) {
    return (DICT[lang] && DICT[lang][key]) ?? (DICT.en && DICT.en[key]) ?? fallback;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.getAttribute("data-i18n-attr").split(",").forEach((pair) => {
        const [attr, key] = pair.split(":").map((x) => x.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
    document.querySelectorAll(".lang-switch button").forEach((b) => {
      const on = b.dataset.lang === lang;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const sw = document.querySelector(".lang-switch");
    if (sw) sw.setAttribute("aria-label", t("lang.choose"));
  }

  function set(next) {
    if (!LANGS.includes(next) || next === lang) return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch (_) { /* nothing to do */ }
    apply();
    document.dispatchEvent(new CustomEvent("st:lang", { detail: lang }));
  }

  // FR / EN switch, added to the white navigation band of every page
  function addSwitch() {
    const band = document.querySelector(".nav-band");
    if (!band || band.querySelector(".lang-switch")) return;
    const box = document.createElement("div");
    box.className = "lang-switch";
    box.setAttribute("role", "group");
    LANGS.forEach((l) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.lang = l;
      b.lang = l;
      b.textContent = l.toUpperCase();
      b.setAttribute("aria-label", l === "fr" ? "Français" : "English");
      b.addEventListener("click", () => set(l));
      box.appendChild(b);
    });
    band.appendChild(box);
  }

  window.ST_I18N = {
    get lang() { return lang; },
    get locale() { return lang === "fr" ? "fr-FR" : "en-GB"; },
    t, tOr, set,
  };

  addSwitch();
  apply();
})();
