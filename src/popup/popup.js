import { getSettings, setSettings, viewerUrl, isViewerUrl } from "../shared/settings.js";

const $ = (id) => document.getElementById(id);

async function init() {
  const settings = await getSettings();
  const enabled = $("enabled");
  enabled.checked = settings.enabled;
  renderEnabled(settings.enabled);
  enabled.addEventListener("change", async () => {
    await setSettings({ enabled: enabled.checked });
    renderEnabled(enabled.checked);
  });

  const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  const state = $("fileAccessState");
  state.textContent = fileAccess ? "allowed" : "not allowed";
  state.className = `pill ${fileAccess ? "ok" : "off"}`;
  $("fileAccessFix").hidden = fileAccess;
  $("fileAccessHelp").hidden = fileAccess;
  $("fileAccessFix").addEventListener("click", () => {
    const scheme = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
    chrome.tabs.create({ url: `${scheme}://extensions/?id=${chrome.runtime.id}` });
    window.close();
  });

  $("openLocal").addEventListener("click", () => {
    chrome.tabs.create({ url: viewerUrl() });
    window.close();
  });
  $("options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && isViewerUrl(tab.url)) {
    $("scanAll").addEventListener("click", () => chrome.runtime.sendMessage({ type: "qr:scanAll", tabId: tab.id }));
    refresh(tab.id);
    setInterval(() => refresh(tab.id), 1000);
  }
}

function renderEnabled(on) {
  $("enabledHint").textContent = on
    ? "PDFs you open are shown in the QR Link viewer."
    : "Off: PDFs open in Edge's built-in viewer.";
}

let lastKey = "";

async function refresh(tabId) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "qr:getLinks", tabId });
  } catch {
    res = null;
  }
  if (!res) {
    $("summary").textContent = "The viewer in this tab is still loading.";
    return;
  }
  const key = JSON.stringify([res.scanned, res.total, res.links.length, res.linkHidden]);
  if (key === lastKey) return;
  lastKey = key;

  const shown = res.links.filter((l) => l.visible || res.linkHidden).length;
  const covered = res.links.length - shown;
  const done = res.scanned >= res.total;
  $("summary").textContent =
    `${shown} QR link${shown === 1 ? "" : "s"} found` +
    (covered ? ` (+${covered} covered in the PDF)` : "") +
    (done ? ` · all ${res.total} pages scanned` : ` · ${res.scanned}/${res.total} pages scanned`);
  $("scanAll").hidden = done;

  const list = $("links");
  list.replaceChildren(
    ...res.links.map((l) => {
      const li = document.createElement("li");
      const go = document.createElement("button");
      go.type = "button";
      go.title = `Go to page ${l.page}`;
      const page = document.createElement("span");
      page.className = "page";
      page.textContent = `p.${l.page}`;
      const url = document.createElement("span");
      url.className = "url";
      url.textContent = l.text;
      go.append(page, url);
      if (!l.visible) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "covered";
        tag.title = "This QR code is painted over by other content in the PDF";
        go.append(tag);
      }
      go.addEventListener("click", () => chrome.runtime.sendMessage({ type: "qr:goto", tabId, page: l.page, rect: l.rect }));
      li.append(go);
      if (l.href) {
        const open = document.createElement("a");
        open.href = l.href;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.textContent = "Open";
        li.append(open);
      }
      return li;
    }),
  );
}

init();
