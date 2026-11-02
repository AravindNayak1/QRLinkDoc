// Exercises src/background.js against a minimal chrome.* mock: which
// navigations get sent to the viewer, and which are left alone.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const VIEWER = "chrome-extension://abc/viewer/viewer.html";
const listeners = {};
const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
let updates = [];
let syncStore = {};
let sessionStore = {};
let dynamicRules = [];
let sessionRules = [];
let fileAccess = true;
let dnrSupportsResponseHeaders = false;

globalThis.chrome = {
  runtime: { id: "abc", getURL: (p) => `chrome-extension://abc/${p}`, onMessage: on("onMessage") },
  storage: {
    sync: { get: async (d) => ({ ...d, ...syncStore }), set: async (o) => Object.assign(syncStore, o) },
    session: { get: async (d) => ({ ...d, ...sessionStore }), set: async (o) => Object.assign(sessionStore, o) },
    onChanged: on("storageChanged"),
  },
  declarativeNetRequest: {
    updateDynamicRules: async ({ addRules = [], removeRuleIds = [] }) => {
      dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
      for (const r of addRules) {
        if (!dnrSupportsResponseHeaders && r.condition.responseHeaders) throw new Error("Unexpected property: 'responseHeaders'");
        dynamicRules.push(r);
      }
    },
    getDynamicRules: async () => dynamicRules,
    updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
      sessionRules = sessionRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
    },
  },
  webRequest: { onHeadersReceived: on("onHeadersReceived") },
  webNavigation: { onBeforeNavigate: on("onBeforeNavigate"), onCommitted: on("onCommitted") },
  tabs: { update: async (tabId, props) => updates.push([tabId, props.url]), onRemoved: on("tabsRemoved") },
  extension: { isAllowedFileSchemeAccess: async () => fileAccess },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

await import("../src/background.js");
const tick = () => new Promise((r) => setTimeout(r, 10));
const viewerFor = (url) => `${VIEWER}?file=${encodeURIComponent(url)}`;

function headers(url, type, extra = {}) {
  const responseHeaders = [{ name: "Content-Type", value: type }];
  for (const [name, value] of Object.entries(extra)) responseHeaders.push({ name, value });
  return { url, tabId: 7, frameId: 0, method: "GET", statusCode: 200, type: "main_frame", responseHeaders };
}

let urlCounter = 0;
const fresh = (path = "doc.pdf") => `https://example.com/${urlCounter++}/${path}`;

beforeEach(() => {
  updates = [];
  sessionStore = {};
  fileAccess = true;
});

test("application/pdf main-frame response is redirected to the viewer", async () => {
  const url = fresh("paper");
  await listeners.onHeadersReceived(headers(url, "application/pdf; charset=binary"));
  assert.deepEqual(updates, [[7, viewerFor(url)]]);
});

test("octet-stream is redirected only for .pdf URLs", async () => {
  const pdf = fresh("file.PDF");
  await listeners.onHeadersReceived(headers(pdf, "application/octet-stream"));
  await listeners.onHeadersReceived(headers(fresh("file.bin"), "application/octet-stream"));
  assert.deepEqual(updates, [[7, viewerFor(pdf)]]);
});

test("downloads, sub-frames, POSTs, errors and other types are left alone", async () => {
  await listeners.onHeadersReceived(headers(fresh(), "application/pdf", { "Content-Disposition": "attachment; filename=a.pdf" }));
  await listeners.onHeadersReceived({ ...headers(fresh(), "application/pdf"), frameId: 3 });
  await listeners.onHeadersReceived({ ...headers(fresh(), "application/pdf"), method: "POST" });
  await listeners.onHeadersReceived({ ...headers(fresh(), "application/pdf"), statusCode: 404 });
  await listeners.onHeadersReceived({ ...headers(fresh(), "application/pdf"), tabId: -1 });
  await listeners.onHeadersReceived(headers(fresh("page.html"), "text/html"));
  assert.deepEqual(updates, []);
});

test("loop guard: the same URL is not redirected twice in a row", async () => {
  const url = fresh();
  await listeners.onHeadersReceived(headers(url, "application/pdf"));
  await listeners.onHeadersReceived(headers(url, "application/pdf"));
  assert.equal(updates.length, 1);
});

test("our own viewer is never redirected", async () => {
  await listeners.onHeadersReceived(headers(`${VIEWER}?file=x.pdf`, "application/pdf"));
  assert.deepEqual(updates, []);
});

test("local *.pdf navigations are redirected when file access is allowed", async () => {
  await listeners.onBeforeNavigate({ tabId: 3, frameId: 0, url: "file:///C:/docs/Notes.PDF?x#page=2" });
  assert.deepEqual(updates, [[3, viewerFor("file:///C:/docs/Notes.PDF?x#page=2")]]);
  updates = [];
  fileAccess = false;
  await listeners.onBeforeNavigate({ tabId: 4, frameId: 0, url: "file:///C:/docs/other.pdf" });
  await listeners.onBeforeNavigate({ tabId: 5, frameId: 1, url: "file:///C:/docs/framed.pdf" });
  assert.deepEqual(updates, []);
});

test("'Open in native viewer' bypasses the next navigation only", async () => {
  const url = fresh();
  const sender = { id: "abc", tab: { id: 9 } };
  const res = await new Promise((resolve) => listeners.onMessage({ type: "qr:openNative", url }, sender, resolve));
  assert.equal(res.ok, true);
  assert.deepEqual(updates, [[9, url]]); // navigates to the original URL...
  assert.ok(sessionRules.some((r) => r.action.type === "allow" && r.condition.tabIds[0] === 9));
  updates = [];
  await listeners.onHeadersReceived({ ...headers(url, "application/pdf"), tabId: 9 });
  assert.deepEqual(updates, []); // ...without being taken over
  await listeners.onCommitted({ tabId: 9, frameId: 0, url });
  await tick();
  assert.equal(sessionRules.length, 0);
  const next = fresh();
  await listeners.onHeadersReceived({ ...headers(next, "application/pdf"), tabId: 9 });
  assert.deepEqual(updates, [[9, viewerFor(next)]]);
});

test("master switch off disables takeover", async () => {
  await listeners.storageChanged({ enabled: { newValue: false } }, "sync");
  await tick();
  await listeners.onHeadersReceived(headers(fresh(), "application/pdf"));
  await listeners.onBeforeNavigate({ tabId: 3, frameId: 0, url: "file:///C:/a.pdf" });
  assert.deepEqual(updates, []);
  await listeners.storageChanged({ enabled: { newValue: true } }, "sync");
  await tick();
});

test("with DNR responseHeaders support, the rule redirects and webRequest only verifies", async () => {
  dnrSupportsResponseHeaders = true;
  await listeners.storageChanged({ enabled: { newValue: true } }, "sync"); // re-sync rules
  await tick();
  const rule = dynamicRules.find((r) => r.id === 1);
  assert.ok(rule, "dynamic rule installed");
  assert.equal(rule.action.redirect.regexSubstitution, `${VIEWER}?rawfile=\\0`);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);

  const url = fresh();
  await listeners.onHeadersReceived(headers(url, "application/pdf"));
  assert.deepEqual(updates, [], "DNR handles it, no tabs.update");
  // DNR worked: the viewer commits.
  await listeners.onCommitted({ tabId: 7, frameId: 0, url: `${VIEWER}?rawfile=${url}` });
  assert.deepEqual(updates, []);
  // DNR did not fire (the PDF itself committed): fall back to tabs.update.
  const url2 = fresh();
  await listeners.onHeadersReceived(headers(url2, "application/pdf"));
  await listeners.onCommitted({ tabId: 7, frameId: 0, url: url2 });
  assert.deepEqual(updates, [[7, viewerFor(url2)]]);

  await listeners.storageChanged({ enabled: { newValue: false } }, "sync");
  await tick();
  assert.equal(dynamicRules.length, 0, "rules removed when switched off");
});
