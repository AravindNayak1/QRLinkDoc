// Runs before pdf.js's viewer.mjs (see the <script> order in viewer.html).

// viewer.html is web-accessible (needed for the declarativeNetRequest
// redirect). Refuse to run inside a frame so other sites cannot embed it to
// load files with the extension's privileges.
if (window.top !== window) {
  history.replaceState(null, "", location.pathname);
  document.documentElement.replaceChildren();
  throw new Error("QR Link PDF viewer cannot be framed");
}

// The DNR redirect passes the original URL unencoded: ?rawfile=<url incl. its
// own query>. Normalise it to ?file=<encoded> before viewer.mjs reads it.
const RAW = "?rawfile=";
if (location.search.startsWith(RAW)) {
  const raw = location.search.slice(RAW.length);
  history.replaceState(null, "", `${location.pathname}?file=${encodeURIComponent(raw)}${location.hash}`);
}

document.addEventListener(
  "webviewerloaded",
  () => {
    const options = window.PDFViewerApplicationOptions;
    if (!options) return;
    // PDF JavaScript is not needed to view documents; keep it off in an
    // extension page.
    options.set("enableScripting", false);
    // Absolute asset URLs: pdf.js may fetch these from its worker
    // (viewer/build/), where the relative defaults would not resolve.
    for (const [name, dir] of [["cMapUrl", "cmaps/"], ["iccUrl", "iccs/"], ["standardFontDataUrl", "standard_fonts/"], ["wasmUrl", "wasm/"]]) {
      options.set(name, new URL(dir, location.href).href);
    }
  },
  { once: true },
);
