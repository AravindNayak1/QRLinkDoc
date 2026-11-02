// Settings stored in chrome.storage.sync, shared by every extension page.

export const DEFAULTS = Object.freeze({
  enabled: true, // take over PDF display
  dpi: 200, // scan resolution: 150 | 200 | 300
  autoScan: true, // scan pages automatically as they are viewed
  linkTarget: "_blank", // "_blank" (new tab) | "_self" (same tab)
  linkHidden: false, // also link QR codes that are painted over in the PDF
});

export async function getSettings() {
  try {
    return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(patch) {
  return chrome.storage.sync.set(patch);
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const patch = {};
    for (const [k, { newValue }] of Object.entries(changes)) if (k in DEFAULTS) patch[k] = newValue ?? DEFAULTS[k];
    if (Object.keys(patch).length) cb(patch);
  });
}

export const VIEWER_PATH = "viewer/viewer.html";

export function viewerUrl(fileUrl) {
  const base = chrome.runtime.getURL(VIEWER_PATH);
  return fileUrl ? `${base}?file=${encodeURIComponent(fileUrl)}` : base;
}

export function isViewerUrl(url) {
  return typeof url === "string" && url.startsWith(chrome.runtime.getURL(VIEWER_PATH));
}
