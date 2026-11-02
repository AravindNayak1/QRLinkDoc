// QR Link layer for the prebuilt pdf.js viewer.
//
// - scans each page once (visible pages first, then neighbours, then the rest
//   in idle time) with scan-core + the decoder Web Worker
// - draws a div.qrLinkLayer of <a> elements over each page, positioned in
//   percentages so it follows zoom/resize; re-attached when pdf.js re-renders
// - adds toolbar controls (QR links list, Open PDF, native viewer) and answers
//   the popup's questions

import { scanPage, toViewportRect } from "../qr/scan-core.js";
import { DEFAULTS, getSettings, onSettingsChanged } from "../shared/settings.js";

const hasChrome = !!globalThis.chrome?.runtime?.id;
const app = window.PDFViewerApplication;
const pdfjs = globalThis.pdfjsLib;
const CACHE_PREFIX = "scan:";
const CACHE_MAX_DOCS = 30;
const CACHE_VERSION = 1;

let settings = { ...DEFAULTS };
let myTabId = null;

const state = {
  doc: null,
  gen: 0,
  results: new Map(), // pageIndex -> codes[]
  failed: new Set(),
  manualAll: false, // "Scan all pages" was clicked while auto-scan is off
  running: false,
  scanning: false, // an off-screen scan render is in flight
  cacheKey: null,
};

// ---------------------------------------------------------------------------
// Decoder worker

let worker = null;
let nextId = 1;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../qr/worker.js", import.meta.url));
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    data.error ? w.reject(new Error(data.error)) : w.resolve(data.hits);
  };
  worker.onerror = (e) => {
    console.error("[qr-link] decoder worker failed", e.message);
    for (const w of waiting.values()) w.reject(new Error("worker failed"));
    waiting.clear();
    worker = null;
  };
  return worker;
}

function decode(image) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    // Structured clone (no transfer): scan-core still reads the pixels after.
    getWorker().postMessage({ id, image });
  });
}

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
}

// ---------------------------------------------------------------------------
// Scheduling

function visiblePageIndices() {
  try {
    const { views } = app.pdfViewer._getVisiblePages();
    return views.map((v) => v.id - 1);
  } catch {
    return [app.pdfViewer.currentPageNumber - 1];
  }
}

function nextPageToScan() {
  const n = state.doc?.numPages ?? 0;
  const todo = (i) => i >= 0 && i < n && !state.results.has(i) && !state.failed.has(i);
  if (!settings.autoScan && !state.manualAll) return null;
  for (const i of visiblePageIndices()) if (todo(i)) return { index: i, urgent: true };
  const cur = app.pdfViewer.currentPageNumber - 1;
  for (const d of [1, -1, 2, -2]) if (todo(cur + d)) return { index: cur + d, urgent: false };
  for (let k = 0; k < n; k++) {
    const i = (cur + k) % n;
    if (todo(i)) return { index: i, urgent: false };
  }
  return null;
}

const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 1500 }) : setTimeout(r, 50)));

async function pump() {
  if (state.running || !state.doc) return;
  state.running = true;
  try {
    for (;;) {
      const gen = state.gen;
      let next = nextPageToScan();
      if (next == null) break;
      if (!next.urgent) {
        await idle();
        if (gen !== state.gen) continue;
        // A visible page may have become due while we were idle.
        next = nextPageToScan();
        if (next == null) break;
      }
      const index = next.index;
      try {
        state.scanning = true;
        const page = await state.doc.getPage(index + 1);
        const codes = await scanPage(page, { pdfjs, dpi: settings.dpi, decode, createCanvas });
        if (gen !== state.gen) continue;
        state.results.set(index, codes);
      } catch (err) {
        if (gen !== state.gen) continue;
        console.warn(`[qr-link] scanning page ${index + 1} failed`, err);
        state.failed.add(index);
      } finally {
        state.scanning = false;
      }
      onPageScanned(index);
    }
  } finally {
    state.running = false;
  }
  saveCache();
}

function onPageScanned(index) {
  attachLayer(index + 1);
  updateUi();
}

// ---------------------------------------------------------------------------
// Cache (chrome.storage.local, keyed by document fingerprint + DPI)

async function loadCache() {
  if (!hasChrome || !state.cacheKey) return;
  try {
    const entry = (await chrome.storage.local.get(state.cacheKey))[state.cacheKey];
    if (entry?.v !== CACHE_VERSION) return;
    for (const [i, codes] of Object.entries(entry.pages)) state.results.set(Number(i), codes);
  } catch {}
}

let saveTimer = null;
function saveCache() {
  if (!hasChrome || !state.cacheKey) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const pages = Object.fromEntries(state.results);
      await chrome.storage.local.set({ [state.cacheKey]: { v: CACHE_VERSION, t: Date.now(), pages } });
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)).sort((a, b) => (all[b].t ?? 0) - (all[a].t ?? 0));
      if (keys.length > CACHE_MAX_DOCS) await chrome.storage.local.remove(keys.slice(CACHE_MAX_DOCS));
    } catch {}
  }, 500);
}

// ---------------------------------------------------------------------------
// Overlay

function codesFor(index) {
  const codes = state.results.get(index) ?? [];
  return settings.linkHidden ? codes : codes.filter((c) => c.visible !== false);
}

function attachLayer(pageNumber) {
  const pageView = app.pdfViewer?.getPageView(pageNumber - 1);
  const div = pageView?.div;
  if (!div || !pageView.pdfPage) return;
  let layer = div.querySelector(":scope > .qrLinkLayer");
  const codes = codesFor(pageNumber - 1);
  if (!codes.length) {
    layer?.remove();
    return;
  }
  const rotation = pageView.viewport.rotation;
  const key = `${rotation}|${settings.linkTarget}|${settings.linkHidden}|${codes.length}`;
  if (layer && layer.dataset.key === key) return;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "qrLinkLayer";
  }
  // Keep it last so it stacks above the text and annotation layers.
  div.append(layer);
  layer.dataset.key = key;
  const vp = pageView.pdfPage.getViewport({ scale: 1, rotation });
  layer.replaceChildren(...codes.map((code) => makeLink(code, vp, pageNumber)));
}

function makeLink(code, vp, pageNumber) {
  const [x1, y1, x2, y2] = toViewportRect(vp, code.rect);
  const isUrl = code.kind === "url" && code.href;
  const el = document.createElement(isUrl ? "a" : "button");
  el.className = "qrLink";
  if (code.visible === false) el.classList.add("qrLinkHidden");
  el.style.left = `${(x1 / vp.width) * 100}%`;
  el.style.top = `${(y1 / vp.height) * 100}%`;
  el.style.width = `${((x2 - x1) / vp.width) * 100}%`;
  el.style.height = `${((y2 - y1) / vp.height) * 100}%`;
  el.title = code.text;
  el.dataset.page = pageNumber;
  if (isUrl) {
    el.href = code.href;
    el.target = settings.linkTarget === "_self" ? "_self" : "_blank";
    if (el.target === "_blank") el.rel = "noopener noreferrer";
    el.setAttribute("aria-label", `QR code link: ${code.text}`);
  } else {
    el.type = "button";
    el.setAttribute("aria-label", `QR code text: ${code.text}`);
    el.addEventListener("click", (e) => {
      e.preventDefault();
      showTextPopover(el, code.text);
    });
  }
  const badge = document.createElement("span");
  badge.className = "qrLinkBadge";
  badge.textContent = "QR";
  el.append(badge);
  return el;
}

let popover = null;
function showTextPopover(anchor, text) {
  closePopover();
  popover = document.createElement("div");
  popover.className = "qrPopover";
  popover.setAttribute("role", "dialog");
  const body = document.createElement("pre");
  body.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(body);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copy.textContent = "Press Ctrl+C";
    }
  });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closePopover);
  const actions = document.createElement("div");
  actions.className = "qrPopoverActions";
  actions.append(copy, close);
  popover.append(body, actions);
  document.body.append(popover);
  const r = anchor.getBoundingClientRect();
  const pw = popover.offsetWidth;
  popover.style.left = `${Math.max(8, Math.min(innerWidth - pw - 8, r.left + r.width / 2 - pw / 2))}px`;
  popover.style.top = `${Math.min(innerHeight - popover.offsetHeight - 8, r.bottom + 6)}px`;
  copy.focus();
}

function closePopover() {
  popover?.remove();
  popover = null;
}

document.addEventListener("pointerdown", (e) => {
  if (popover && !popover.contains(e.target) && !e.target.closest?.(".qrLink")) closePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopover();
});

function refreshAllLayers() {
  const n = state.doc?.numPages ?? 0;
  for (let p = 1; p <= n; p++) {
    const div = app.pdfViewer.getPageView(p - 1)?.div;
    const layer = div?.querySelector(":scope > .qrLinkLayer");
    if (layer) delete layer.dataset.key;
    if (div?.querySelector(":scope > .canvasWrapper, :scope > .textLayer") || layer) attachLayer(p);
  }
}

// ---------------------------------------------------------------------------
// Links list / toolbar

function allLinks() {
  const links = [];
  for (const [index, codes] of [...state.results].sort((a, b) => a[0] - b[0])) {
    for (const c of codes) {
      links.push({ page: index + 1, text: c.text, href: c.href, kind: c.kind, visible: c.visible !== false, rect: c.rect });
    }
  }
  return links;
}

function linkedCount() {
  return allLinks().filter((l) => l.visible || settings.linkHidden).length;
}

function scanStatus() {
  const total = state.doc?.numPages ?? 0;
  return { scanned: state.results.size + state.failed.size, total };
}

function goToCode(page, rect) {
  const dest = rect ? [null, { name: "XYZ" }, rect[0] - 40, rect[3] + 40, null] : null;
  app.pdfViewer.scrollPageIntoView(dest ? { pageNumber: page, destArray: dest } : { pageNumber: page });
  // Flash the target so it is easy to spot.
  setTimeout(() => {
    const layer = app.pdfViewer.getPageView(page - 1)?.div?.querySelector(".qrLinkLayer");
    for (const a of layer?.querySelectorAll(".qrLink") ?? []) {
      a.classList.remove("qrFlash");
      void a.offsetWidth;
      a.classList.add("qrFlash");
    }
  }, 150);
}

let ui = null;

function buildToolbar() {
  const right = document.getElementById("toolbarViewerRight");
  if (!right) return;
  const group = document.createElement("div");
  group.id = "qrLinkToolbar";
  group.className = "toolbarHorizontalGroup";

  const openBtn = toolbarButton("Open PDF", "Open a PDF file from this computer");
  openBtn.addEventListener("click", () => app.eventBus.dispatch("openfile", { source: window }));

  const nativeBtn = toolbarButton("Native viewer", "Open this PDF in Edge's built-in viewer");
  nativeBtn.hidden = true;
  nativeBtn.addEventListener("click", openNative);

  const wrap = document.createElement("div");
  wrap.className = "qrLinksWrap";
  const listBtn = toolbarButton("QR", "QR code links found in this document");
  listBtn.classList.add("qrCountButton");
  listBtn.setAttribute("aria-haspopup", "true");
  listBtn.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "qrLinksPanel";
  panel.hidden = true;
  listBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    listBtn.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) renderPanel();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !wrap.contains(e.target)) {
      panel.hidden = true;
      listBtn.setAttribute("aria-expanded", "false");
    }
  });
  wrap.append(listBtn, panel);

  group.append(wrap, openBtn, nativeBtn);
  right.prepend(group);
  ui = { listBtn, panel, nativeBtn };
  updateUi();
}

function toolbarButton(label, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "qrToolbarButton";
  b.textContent = label;
  b.title = title;
  return b;
}

function renderPanel() {
  if (!ui || ui.panel.hidden) return;
  const { scanned, total } = scanStatus();
  const links = allLinks();
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "qrLinksHead";
  head.textContent = total ? `${links.length} QR code${links.length === 1 ? "" : "s"} · ${scanned}/${total} pages scanned` : "No document";
  frag.append(head);
  if (total && scanned < total && !settings.autoScan && !state.manualAll) {
    const scanAll = document.createElement("button");
    scanAll.type = "button";
    scanAll.className = "qrScanAll";
    scanAll.textContent = "Scan all pages";
    scanAll.addEventListener("click", () => {
      state.manualAll = true;
      pump();
      renderPanel();
    });
    frag.append(scanAll);
  }
  const list = document.createElement("ol");
  for (const l of links) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = l.visible ? `Go to page ${l.page}` : `Go to page ${l.page} (this QR code is covered by other content in the PDF)`;
    const pg = document.createElement("span");
    pg.className = "qrLinksPage";
    pg.textContent = `p.${l.page}`;
    const tx = document.createElement("span");
    tx.className = "qrLinksText";
    tx.textContent = l.text;
    btn.append(pg, tx);
    if (!l.visible) {
      const hid = document.createElement("span");
      hid.className = "qrLinksHiddenTag";
      hid.textContent = "covered";
      btn.append(hid);
    }
    btn.addEventListener("click", () => goToCode(l.page, l.rect));
    li.append(btn);
    if (l.href) {
      const open = document.createElement("a");
      open.href = l.href;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.className = "qrLinksOpen";
      open.textContent = "Open";
      li.append(open);
    }
    list.append(li);
  }
  frag.append(list);
  ui.panel.replaceChildren(frag);
}

function updateUi() {
  const count = linkedCount();
  if (ui) {
    const { scanned, total } = scanStatus();
    const busy = total && scanned < total && (settings.autoScan || state.manualAll);
    ui.listBtn.textContent = busy ? `QR ${count}…` : `QR ${count}`;
    ui.listBtn.title = `${count} QR link${count === 1 ? "" : "s"} · ${scanned}/${total} pages scanned`;
    renderPanel();
  }
  if (hasChrome) chrome.runtime.sendMessage({ type: "qr:count", count }).catch(() => {});
}

function originalUrl() {
  const file = new URLSearchParams(location.search).get("file");
  return file && /^(https?|file):/i.test(file) ? file : null;
}

async function openNative() {
  const url = originalUrl();
  if (!url) return;
  if (hasChrome) {
    const res = await chrome.runtime.sendMessage({ type: "qr:openNative", url }).catch(() => null);
    if (res?.ok) return;
  }
  location.href = url;
}

// ---------------------------------------------------------------------------
// Empty state and file-access hint

function showEmptyState() {
  if (document.getElementById("qrEmptyState")) return;
  const box = document.createElement("div");
  box.id = "qrEmptyState";
  const card = document.createElement("div");
  card.className = "qrEmptyCard";
  const h = document.createElement("h1");
  h.textContent = "QR Link PDF";
  const p = document.createElement("p");
  p.textContent = "Open a PDF to make the QR codes inside it clickable.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Open PDF";
  btn.addEventListener("click", () => app.eventBus.dispatch("openfile", { source: window }));
  const hint = document.createElement("p");
  hint.className = "qrEmptyHint";
  hint.textContent = "…or drop a PDF file anywhere on this page.";
  card.append(h, p, btn, hint);
  box.append(card);
  document.getElementById("mainContainer")?.append(box);
}

async function maybeShowFileAccessHint() {
  const url = originalUrl();
  if (!hasChrome || !url?.startsWith("file:")) return;
  if (await chrome.extension.isAllowedFileSchemeAccess()) return;
  const bar = document.createElement("div");
  bar.id = "qrFileAccessBar";
  const msg = document.createElement("span");
  msg.textContent = 'To open local PDFs, turn on "Allow access to file URLs" for QR Link PDF.';
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Open extension settings";
  btn.addEventListener("click", () => {
    const scheme = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
    chrome.tabs.create({ url: `${scheme}://extensions/?id=${chrome.runtime.id}` });
  });
  bar.append(msg, btn);
  document.getElementById("mainContainer")?.append(bar);
}

// ---------------------------------------------------------------------------
// Wiring

async function onDocument() {
  const doc = app.pdfDocument;
  if (!doc || doc === state.doc) return;
  state.doc = doc;
  state.gen++;
  // The viewer calls pdfDocument.cleanup() when idle, which pdf.js rejects
  // while any page is rendering, including our off-screen scan renders.
  if (!doc.__qrCleanupGuard) {
    const cleanup = doc.cleanup.bind(doc);
    doc.cleanup = (...args) => (state.scanning && state.doc === doc ? Promise.resolve() : cleanup(...args));
    doc.__qrCleanupGuard = true;
  }
  state.results = new Map();
  state.failed = new Set();
  state.manualAll = false;
  const fp = doc.fingerprints?.[0] ?? null;
  state.cacheKey = fp ? `${CACHE_PREFIX}${fp}:${settings.dpi}` : null;
  document.getElementById("qrEmptyState")?.remove();
  await loadCache();
  updateUi();
  refreshAllLayers();
  pump();
}

async function init() {
  await app.initializedPromise;
  if (hasChrome) {
    settings = await getSettings();
    onSettingsChanged((patch) => {
      const dpiChanged = "dpi" in patch && patch.dpi !== settings.dpi;
      settings = { ...settings, ...patch };
      if (dpiChanged && state.doc) {
        const doc = state.doc;
        state.doc = null;
        app.pdfDocument === doc && onDocument();
      } else {
        refreshAllLayers();
        updateUi();
        pump();
      }
    });
    chrome.tabs.getCurrent((tab) => (myTabId = tab?.id ?? null));
    chrome.runtime.onMessage.addListener(onMessage);
  }
  buildToolbar();
  if (ui && originalUrl()) ui.nativeBtn.hidden = false;

  const bus = app.eventBus;
  bus.on("pagesinit", onDocument);
  bus.on("documentloaded", onDocument);
  // pdf.js removes foreign children of the page div when it resets a page
  // (zoom, rotation), so re-attach on every (re)render.
  bus.on("pagerender", ({ pageNumber }) => attachLayer(pageNumber));
  bus.on("pagerendered", ({ pageNumber }) => {
    attachLayer(pageNumber);
    pump();
  });
  bus.on("updateviewarea", () => pump());
  bus.on("rotationchanging", () => setTimeout(refreshAllLayers, 0));

  if (app.pdfDocument) onDocument();
  else if (!new URLSearchParams(location.search).get("file")) showEmptyState();
  maybeShowFileAccessHint();
}

function onMessage(msg, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || msg?.tabId == null || msg.tabId !== myTabId) return false;
  if (msg.type === "qr:getLinks") {
    sendResponse({ ...scanStatus(), links: allLinks(), linkHidden: settings.linkHidden, title: document.title });
    return false;
  }
  if (msg.type === "qr:goto") {
    goToCode(msg.page, msg.rect);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "qr:scanAll") {
    state.manualAll = true;
    pump();
    sendResponse({ ok: true });
    return false;
  }
  return false;
}

init().catch((err) => console.error("[qr-link] init failed", err));
