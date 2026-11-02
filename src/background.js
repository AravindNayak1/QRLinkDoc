// Service worker: sends top-level PDF navigations to our pdf.js viewer.
//
//   http(s): webRequest.onHeadersReceived (non-blocking observation) detects a
//            PDF response and calls tabs.update(viewer). Where Chromium
//            supports declarativeNetRequest `responseHeaders` conditions, a
//            dynamic rule redirects first (no flicker); the observer then only
//            verifies the redirect happened.
//   file:    webNavigation.onBeforeNavigate / onCommitted for *.pdf.
//
// Only main frames are touched, never our own viewer, with a per-tab loop
// guard and a one-time bypass for "Open in Edge's native viewer".

import { getSettings, onSettingsChanged, viewerUrl, isViewerUrl, VIEWER_PATH } from "./shared/settings.js";

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const OCTET_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);
const DNR_RULE_IDS = [1, 2];
const BYPASS_RULE_BASE = 1000;
const BYPASS_TTL_MS = 60_000;
const LOOP_GUARD_MS = 4000;

let settings = null;
const settingsReady = getSettings().then((s) => (settings = s));
onSettingsChanged((patch) => {
  settings = { ...settings, ...patch };
  if ("enabled" in patch) dnrReady = syncDnrRules();
});

// ---------------------------------------------------------------------------
// declarativeNetRequest (feature-detected)

let dnrActive = false;
let dnrReady = syncDnrRules();

function buildDnrRules() {
  const redirect = { regexSubstitution: `${chrome.runtime.getURL(VIEWER_PATH)}?rawfile=\\0` };
  const common = {
    resourceTypes: ["main_frame"],
    requestMethods: ["get"],
    excludedResponseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
  };
  return [
    {
      id: 1,
      priority: 1,
      action: { type: "redirect", redirect },
      condition: { ...common, regexFilter: "^https?://.*$", responseHeaders: [{ header: "content-type", values: ["application/pdf*", "application/x-pdf*"] }] },
    },
    {
      id: 2,
      priority: 1,
      action: { type: "redirect", redirect },
      condition: {
        ...common,
        regexFilter: "^https?://[^?#]*\\.[pP][dD][fF]([?#].*)?$",
        responseHeaders: [{ header: "content-type", values: ["application/octet-stream*", "binary/octet-stream*"] }],
      },
    },
  ];
}

async function syncDnrRules() {
  await settingsReady;
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return (dnrActive = false);
  try {
    await dnr.updateDynamicRules({ removeRuleIds: DNR_RULE_IDS });
    if (!settings.enabled) return (dnrActive = false);
    await dnr.updateDynamicRules({ addRules: buildDnrRules() });
    // Older Chromium rejects or drops unknown condition keys; only trust the
    // rule if it round-trips with its responseHeaders condition intact.
    const rules = await dnr.getDynamicRules();
    dnrActive = rules.some((r) => r.id === 1 && r.condition?.responseHeaders?.length);
    if (!dnrActive) await dnr.updateDynamicRules({ removeRuleIds: DNR_RULE_IDS });
  } catch (err) {
    console.info("[qr-link] DNR responseHeaders redirect unavailable, using webRequest + tabs.update:", err?.message);
    dnrActive = false;
    try {
      await dnr.updateDynamicRules({ removeRuleIds: DNR_RULE_IDS });
    } catch {}
  }
  return dnrActive;
}

// ---------------------------------------------------------------------------
// One-time bypass ("Open in Edge's native viewer")

async function getBypass() {
  return (await chrome.storage.session.get({ bypass: {} })).bypass;
}

async function hasBypass(tabId) {
  const until = (await getBypass())[tabId];
  return typeof until === "number" && until > Date.now();
}

async function setBypass(tabId) {
  const bypass = await getBypass();
  bypass[tabId] = Date.now() + BYPASS_TTL_MS;
  await chrome.storage.session.set({ bypass });
  // Also let the request through our DNR redirect (session rules can be tab-scoped).
  const id = BYPASS_RULE_BASE + (tabId % 1_000_000);
  try {
    await chrome.declarativeNetRequest?.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{ id, priority: 100, action: { type: "allow" }, condition: { tabIds: [tabId], resourceTypes: ["main_frame"] } }],
    });
  } catch {}
}

async function clearBypass(tabId) {
  const bypass = await getBypass();
  const now = Date.now();
  let changed = false;
  for (const [k, until] of Object.entries(bypass)) {
    if (Number(k) === tabId || until <= now) {
      delete bypass[k];
      changed = true;
    }
  }
  if (changed) await chrome.storage.session.set({ bypass });
  try {
    await chrome.declarativeNetRequest?.updateSessionRules({ removeRuleIds: [BYPASS_RULE_BASE + (tabId % 1_000_000)] });
  } catch {}
}

// ---------------------------------------------------------------------------
// Redirect

const recent = new Map(); // tabId -> { url, t } (loop guard)
const pending = new Map(); // tabId -> url DNR should have redirected

function redirect(tabId, url) {
  if (isViewerUrl(url)) return;
  const last = recent.get(tabId);
  if (last && last.url === url && Date.now() - last.t < LOOP_GUARD_MS) return;
  recent.set(tabId, { url, t: Date.now() });
  chrome.tabs.update(tabId, { url: viewerUrl(url) }).catch(() => {});
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}

export function isPdfPath(url) {
  try {
    return /\.pdf$/i.test(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
}

function isPdfResponse(details) {
  const disposition = header(details.responseHeaders, "content-disposition").trim().toLowerCase();
  if (disposition.startsWith("attachment")) return false; // the site asked for a download
  const type = header(details.responseHeaders, "content-type").split(";")[0].trim().toLowerCase();
  if (PDF_TYPES.has(type)) return true;
  if (OCTET_TYPES.has(type)) return isPdfPath(details.url) || /filename\*?=[^;]*\.pdf/i.test(disposition);
  return false;
}

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId < 0 || details.frameId !== 0 || details.method !== "GET") return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    if (!isPdfResponse(details)) return;
    await settingsReady;
    if (!settings.enabled || (await hasBypass(details.tabId))) return;
    await dnrReady;
    if (dnrActive) {
      // Rule 2 needs a .pdf path; octet-stream + filename-only is ours to handle.
      const type = header(details.responseHeaders, "content-type").split(";")[0].trim().toLowerCase();
      if (PDF_TYPES.has(type) || isPdfPath(details.url)) {
        pending.set(details.tabId, details.url);
        return;
      }
    }
    redirect(details.tabId, details.url);
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"],
);

async function maybeRedirectFile(details) {
  if (details.frameId !== 0 || !details.url.startsWith("file:") || !isPdfPath(details.url)) return false;
  await settingsReady;
  if (!settings.enabled || (await hasBypass(details.tabId))) return false;
  // Without "Allow access to file URLs" the viewer could not read the file;
  // leave it to the native viewer.
  if (!(await chrome.extension.isAllowedFileSchemeAccess())) return false;
  redirect(details.tabId, details.url);
  return true;
}

chrome.webNavigation.onBeforeNavigate.addListener(maybeRedirectFile, { url: [{ schemes: ["file"] }] });

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const expected = pending.get(details.tabId);
  pending.delete(details.tabId);
  if (await hasBypass(details.tabId)) {
    if (!isViewerUrl(details.url)) await clearBypass(details.tabId);
    return;
  }
  if (await maybeRedirectFile(details)) return;
  // DNR was expected to redirect but the PDF itself committed: fall back.
  if (expected && expected === details.url && settings?.enabled) redirect(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recent.delete(tabId);
  pending.delete(tabId);
  clearBypass(tabId);
});

// ---------------------------------------------------------------------------
// Messages from the viewer and popup

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "qr:openNative" && sender.tab?.id >= 0 && /^(https?|file):/i.test(msg.url)) {
    const tabId = sender.tab.id;
    setBypass(tabId)
      .then(() => chrome.tabs.update(tabId, { url: msg.url }))
      .then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg?.type === "qr:count" && sender.tab?.id >= 0) {
    const text = msg.count > 0 ? String(msg.count) : "";
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#0b63ce" }).catch(() => {});
    chrome.action.setBadgeText({ tabId: sender.tab.id, text }).catch(() => {});
    return false;
  }
  if (msg?.type === "qr:status") {
    Promise.all([settingsReady, dnrReady, chrome.extension.isAllowedFileSchemeAccess()]).then(([, , fileAccess]) =>
      sendResponse({ enabled: settings.enabled, fileAccess, dnrActive }),
    );
    return true;
  }
  return false;
});
