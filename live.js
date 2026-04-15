(function () {
  const gridEl = document.getElementById("video-grid");
  const statusEl = document.getElementById("status");
  const isMobileDevice = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const sources = [
    "/videotory/manifest.json",
  ];

  function updateMobileOrientationClass() {
    const isLandscape = window.matchMedia("(orientation: landscape)").matches || window.innerWidth > window.innerHeight;
    document.body.classList.toggle("mobile-device", isMobileDevice);
    document.body.classList.toggle("mobile-landscape", isMobileDevice && isLandscape);
    document.body.classList.toggle("mobile-portrait", isMobileDevice && !isLandscape);
  }

  async function tryLockLandscapeOnLoad() {
    if (!isMobileDevice) return;
    const orientationApi = screen.orientation;
    if (!orientationApi || typeof orientationApi.lock !== "function") return;
    try {
      await orientationApi.lock("landscape");
    } catch (e) {
      // Ignore browsers that block lock without fullscreen/user gesture.
    }
  }

  function normalizeItem(item) {
    if (typeof item === "string") {
      return { url: item, title: item };
    }
    return item;
  }

  function fileNameFromUrl(url) {
    const parts = url.split("/");
    return parts[parts.length - 1] || url;
  }

  function titleFromFile(file) {
    return file.replace(/\.(mp4|webm|mov|m4v)$/i, "").replace(/[-_]+/g, " ");
  }

  function parseDate(name) {
    const ymd = name.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/);
    if (ymd) {
      return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    }
    return null;
  }

  function render(items) {
    if (!items.length) {
      statusEl.textContent = "No videos found. Upload videos to /videotory/.";
      return;
    }

    statusEl.textContent = `Found ${items.length} video(s).`;
    gridEl.innerHTML = "";

    items.forEach((item) => {
      const file = fileNameFromUrl(item.url);
      const title = item.title || titleFromFile(file);
      const card = document.createElement("div");
      card.className = "video-card";

      if (item.thumb) {
        const img = document.createElement("img");
        img.src = item.thumb.startsWith("/") ? item.thumb : `/videotory/${item.thumb}`;
        img.alt = title;
        card.appendChild(img);
      } else {
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        const source = document.createElement("source");
        source.src = item.url;
        source.type = "video/mp4";
        video.appendChild(source);
        card.appendChild(video);
      }

      const name = document.createElement("div");
      name.className = "video-title";
      name.textContent = title;
      card.appendChild(name);

      const open = document.createElement("a");
      open.className = "video-link";
      open.href = item.url;
      open.textContent = "Open video";
      card.appendChild(open);

      gridEl.appendChild(card);
    });
  }

  async function loadManifest(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("manifest not found");
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.items || [];
    return items.map(normalizeItem).map((item) => ({
      url: item.url.startsWith("/") ? item.url : `/videotory/${item.url}`,
      title: item.title,
      thumb: item.thumb,
    }));
  }

  function parseAutoIndex(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll("a"));
    return links
      .map((a) => a.getAttribute("href") || "")
      .filter((href) => href && !href.endsWith("/") && href.match(/\.(mp4|webm|mov|m4v)$/i))
      .map((href) => ({
        url: href.startsWith("http") ? href : baseUrl + href,
      }));
  }

  async function loadAutoIndex(baseUrl) {
    const res = await fetch(baseUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("no index");
    const html = await res.text();
    return parseAutoIndex(html, baseUrl);
  }

  async function main() {
    let items = [];
    for (const src of sources) {
      try {
        items = await loadManifest(src);
        if (items.length) break;
      } catch (e) {}
    }

    if (!items.length) {
      try {
        items = await loadAutoIndex("/videotory/");
      } catch (e) {}
    }

    items = items.filter((i) => i.url && i.url.match(/\.(mp4|webm|mov|m4v)$/i));
    items.sort((a, b) => {
      const da = parseDate(fileNameFromUrl(a.url));
      const db = parseDate(fileNameFromUrl(b.url));
      if (da && db) return db - da;
      return fileNameFromUrl(b.url).localeCompare(fileNameFromUrl(a.url));
    });

    render(items);
  }

  updateMobileOrientationClass();
  window.addEventListener("resize", updateMobileOrientationClass);
  window.addEventListener("orientationchange", updateMobileOrientationClass);
  tryLockLandscapeOnLoad();
  main();
})();
