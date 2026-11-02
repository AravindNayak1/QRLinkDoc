# QR Link PDF

A Microsoft Edge (Chromium, Manifest V3) extension that makes the **QR codes inside PDFs clickable**.

Edge's built-in PDF reader is a native component that extensions can't script. So QR Link PDF opens PDFs in its own
[pdf.js](https://github.com/mozilla/pdf.js) viewer, decodes the QR codes on each page, and lays a clickable link over each one.
Zoom, search, the sidebar, rotation and printing all come from the stock pdf.js viewer.

## Install

```bash
npm install
```

```bash
npm run build
```

1. Open `edge://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `dist/` folder.
2. On the extension's details page, turn on **Allow access to file URLs**. This is needed for PDFs on your computer
   (`file://`). Web PDFs work without it.
3. Check that `edge://settings/content/pdfDocuments` is **not** set to "Always download PDF files". If it is, Edge downloads
   PDFs instead of navigating to them, and nothing gets taken over.
4. Open any PDF with QR codes in it (drag it into Edge, or use the toolbar popup → **Open a local PDF**). Hover a QR code
   (you'll see an outline and a small "QR" badge) and click it. The link opens in a new tab.

The sample PDF used during development (`samples/GATE_CN_PYQs_filtered_to_GATE2027_syllabus.pdf`) is third-party content and
isn't in the repository; `samples/*.pdf` is git-ignored.

`npm test` runs the Node tests (see [Tests](#tests)).

The build downloads Mozilla's official prebuilt viewer (`pdfjs-<version>-dist.zip`, about 6.5 MB) once from the pdf.js GitHub
release that matches the installed `pdfjs-dist`, and caches it in `.cache/`. To build offline, set
`PDFJS_DIST_ZIP=/path/to/pdfjs-6.5.438-dist.zip`.

## How it works

### 1. PDF takeover ([src/background.js](src/background.js))

| Source | Mechanism |
| --- | --- |
| Web PDFs (`http`/`https`) | `webRequest.onHeadersReceived` (non-blocking, `main_frame` only) looks for `Content-Type: application/pdf` or `application/x-pdf`, or `application/octet-stream` with a `.pdf` path, then calls `tabs.update(tabId, viewerUrl)`. |
| Flicker-free path | If Chromium accepts `declarativeNetRequest` rules with a `responseHeaders` condition (checked at startup by adding the rule and reading it back), a dynamic rule redirects the response before Edge's viewer starts. The webRequest observer then only checks it worked: if the PDF itself commits, it falls back to `tabs.update`. |
| Local PDFs (`file://`) | `webNavigation.onBeforeNavigate` / `onCommitted` for main-frame URLs whose path ends in `.pdf` (case-insensitive; query and hash ignored). Only happens when file access is allowed. Otherwise Edge's own viewer keeps the file. |
| Manual fallback | The viewer has an **Open PDF** button and accepts drag-and-drop. The popup has **Open a local PDF**. |

What it leaves alone, and how it avoids loops:
- Sub-frames, `<embed>`/`<iframe>`, POST responses, non-2xx responses, and `Content-Disposition: attachment` downloads.
- The extension's own viewer URL.
- The same URL redirected again in the same tab within 4 s (loop guard).
- The master switch in the popup (`chrome.storage.sync`) turns all of this off and removes the DNR rules.
- **Native viewer** in the viewer toolbar sets a one-time bypass for that tab: a session flag plus a tab-scoped DNR
  `allow` rule. It then opens the original URL in Edge's viewer. The bypass is cleared on the next commit, after 60 s, or
  when the tab closes.

Viewer URL: `chrome-extension://<id>/viewer/viewer.html?file=<encoded original url>`. The DNR rule can't URL-encode, so it uses
`?rawfile=<url>`, and [boot.js](src/viewer/boot.js) rewrites that to `?file=` before pdf.js reads it.

### 2. Viewer ([scripts/build.mjs](scripts/build.mjs))

`dist/viewer/` is the stock pdf.js generic viewer (`viewer.html`/`viewer.mjs`/`viewer.css`, images, locale) with
`build/pdf.mjs`, `build/pdf.worker.mjs`, cmaps, standard fonts, wasm and ICC profiles from `pdfjs-dist`. The build script
applies these patches, and fails if any of them no longer matches:

- `validateFileURL` also accepts `http(s):`, `file:` and `blob:` URLs from any origin. Cross-origin fetches work because of
  `host_permissions`.
- Asset paths point next to `viewer.html`. `workerSrc` is the local `build/pdf.worker.mjs`.
- No demo PDF loads when there's no `?file=`. Cookies are sent with the request (`withCredentials`) so PDFs on sites you're
  signed in to load.
- `file:` is added to the viewer's own CSP `connect-src`. `boot.js` runs before the viewer and `qr-layer.js` after it.

`boot.js` turns PDF JavaScript off (`enableScripting: false`). It also refuses to run inside a frame, because `viewer.html`
has to be web-accessible for the DNR redirect.

### 3. QR detection ([src/qr/](src/qr))

- **Decoders** ([decoder.js](src/qr/decoder.js)):
  - `zxing-wasm` reader build, `formats: ["QRCode"]`: returns every code in an image, with corner positions.
  - `BarcodeDetector`, if available. It isn't in Edge on Windows.
  - `jsQR` with an erase-and-repeat loop: each hit is painted white and the image is rescanned.

  The WASM file ships in the package and loads with `locateFile`. The build also strips zxing-wasm's default CDN URL from
  the bundle.
- **Scan strategy** ([scan-core.js](src/qr/scan-core.js)), once per page:
  1. Render the page to an `OffscreenCanvas` at the scan DPI (default 200, independent of zoom) and decode it in a
     **Web Worker** ([worker.js](src/qr/worker.js)).
  2. Decode the pixels of embedded images that are roughly square (10–300 pt) and not already covered by a hit. Their
     positions come from walking the operator list and tracking the transform matrix.
  3. Re-render any remaining square-image regions at **2×** and decode again.

  All corners are mapped back to PDF user space (viewport at scale 1). Codes smaller than 40 px at 200 DPI are ignored, and
  boxes overlapping by more than 50% are de-duplicated.
- **Order:** visible pages first, then the pages around the current one, then the rest in idle time. Results are kept per
  page and never rescanned. They're cached in `chrome.storage.local` by document fingerprint and DPI (last 30 documents).

#### Covered QR codes

The sample PDF is a *filtered* copy: questions outside the 2027 syllabus are hidden under opaque white rectangles, but their
QR images are still in the file. On **page 3**:
- `/412` and `/42` are visible.
- `/2106` (y ≈ 388–416 pt) and `/39628` (y ≈ 76–104 pt) are embedded but painted over. A scan based only on rendering
  can't find them.

The image pass decodes all four. Each code is marked `visible: true/false` by checking whether its area in the rendered page
is flat. Only visible codes get clickable overlays by default, so the extension never puts invisible links on blank space.
Covered codes still appear in the links lists with a "covered" tag. Options → "Also link QR codes that are painted over"
turns them into links too.

### 4. Overlay ([src/viewer/qr-layer.js](src/viewer/qr-layer.js))

- Each page gets a `div.qrLinkLayer` (z-index above pdf.js's text and annotation layers, `pointer-events: none`). Each code
  is an `<a target="_blank" rel="noopener noreferrer">` sized in **percent** of the page box. Only the link boxes take
  pointer events, so text selection elsewhere works as usual.
- pdf.js removes foreign children when it resets a page (zoom, rotation). The layer is re-attached on `pagerender` and
  `pagerendered`. Hooks: `pagesinit`, `documentloaded`, `pagerender`, `pagerendered`, `updateviewarea`, `rotationchanging`.
- Each link shows the URL as its native `title` tooltip, plus an outline and a "QR" badge on hover. Middle-click and
  Ctrl-click work as for any link.
- Treated as URLs: `http(s)://`, `www.`, `mailto:`, `tel:`, and bare domains (`example.com/x` becomes `https://`). Anything
  else, including `javascript:` and `data:`, opens a small popover with the text and a **Copy** button.
- Toolbar additions: **QR n** (a links list where you click to jump to the code), **Open PDF**, and **Native viewer**.

### 5. Popup and options

- **Popup** ([src/popup/](src/popup)):
  - Master on/off switch.
  - "Local files" status, with a button that opens `edge://extensions/?id=<id>`.
  - **Open a local PDF**.
  - For a viewer tab: the QR count and scan progress, a links list (page + URL; click to jump, "Open" to follow), and
    **Scan all pages** when auto-scan is off.
- The toolbar badge shows the number of links in the current viewer tab.
- **Options** ([src/options/](src/options)):
  - Scan DPI: 150, 200 or 300.
  - Auto-scan on/off. When off, nothing is scanned until you click "Scan all pages".
  - Open links in a new tab or the same tab.
  - Link covered QR codes (default off).

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` | Non-blocking observation of main-frame response headers (`Content-Type`, `Content-Disposition`) to detect web PDFs. Nothing is blocked or modified. |
| `webNavigation` | Detects top-level navigations to `file://…/*.pdf`, which webRequest doesn't see. Also confirms whether the DNR redirect happened. |
| `tabs` | `tabs.update` to open the viewer in the same tab. Lets the popup read the active tab's URL to see whether it's a viewer tab. |
| `storage` | Settings (`sync`), the one-time bypass (`session`), and the scan cache (`local`). |
| `declarativeNetRequest` | Optional fast path: a dynamic redirect rule keyed on response headers, plus a tab-scoped `allow` rule for the native-viewer bypass. Feature-detected; everything works without it. |
| `host_permissions: <all_urls>` | Fetch the PDF from its original site inside the viewer (cross-origin, with cookies). Required for webRequest/DNR to see those responses. |
| `host_permissions: file:///*` | Read local PDFs. Only takes effect once you turn on "Allow access to file URLs". |

CSP for extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `wasm-unsafe-eval` is needed for
zxing-wasm and pdf.js's image decoders. No remote code is loaded; the build fails if a bundle references a CDN.

## Tests

`npm test` runs three files:
- [test/page3.test.mjs](test/page3.test.mjs): opens the sample with `pdfjs-dist` and `@napi-rs/canvas` and scans page 3
  with the shared scanner, once with zxing-wasm and once with the jsQR fallback. Asserts:
  - the 56-page count
  - the four URLs `https://gateoverflow.in/412`, `/2106`, `/42`, `/39628`
  - ~28 pt square boxes in the right margin (x ≈ 525–554 pt), not overlapping
  - the visible/covered flags

  These two tests are skipped when the sample PDF isn't in `samples/`.
- [test/payload.test.mjs](test/payload.test.mjs): URL vs text classification and de-duplication.
- [test/background.test.mjs](test/background.test.mjs): takeover rules against a mocked `chrome.*` API (PDF types,
  downloads, frames, POST, loop guard, `file://`, master switch, one-time bypass, DNR rule + fallback).

To develop the viewer outside the extension (no `chrome.*`; takeover and popup features turn themselves off), run
`npm run serve`, put a PDF in `samples/`, and open
`http://localhost:8571/dist/viewer/viewer.html?file=/samples/<name>.pdf`.

## Troubleshooting

- **Redirect loop, or a PDF keeps reloading.**
  - Turn the extension off in the popup, reload, and check the service worker console (`edge://extensions` → "Inspect
    views: service worker").
  - The loop guard skips a second redirect of the same URL in the same tab within 4 s.
  - The viewer's own requests are `xmlhttprequest`/`fetch`, never `main_frame`, so they're never taken over.
  - Use **Native viewer** to open a PDF in Edge's viewer once.
- **"Unexpected server response" or a CORS error for a web PDF.**
  - The viewer downloads the PDF again from its URL. Pages that serve a PDF in reply to a form POST, or through single-use
    links, can't be fetched a second time. POST responses are never taken over; for single-use links use **Native viewer**.
  - Sites that need login get your cookies (`withCredentials`), but some reject requests that aren't top-level.
  - CORS headers don't matter: `host_permissions` let the extension skip CORS.
- **Local PDFs open in Edge's own viewer, or show a yellow "Allow access to file URLs" bar.** Turn on **Allow access to file
  URLs** on the extension's details page (the popup links there), then reopen the file.
- **PDFs download instead of opening.** Make sure `edge://settings/content/pdfDocuments` isn't "Always download PDF files".
  Responses sent as `Content-Disposition: attachment` are downloads by design and are left alone.
- **No QR codes found.**
  - Try 300 DPI in Options for very small or dense codes.
  - Check auto-scan is on, or click **Scan all pages**.
  - Codes painted over by other content are listed as "covered" and aren't linked unless you turn that option on.
- **WASM / CSP errors (`CompileError`, "violates the Content Security Policy").**
  - The manifest CSP must keep `'wasm-unsafe-eval'`.
  - `dist/qr/zxing_reader.wasm` must be next to `dist/qr/worker.js`. Run `npm run build` again.
  - If zxing-wasm can't start, the worker logs a warning and uses jsQR instead.
- **Scanning pauses in background tabs.** pdf.js renders with `requestAnimationFrame`, which browsers throttle in hidden tabs.
  Scanning continues when the tab is visible again.
- **`npm install` warns that esbuild's install script was blocked.** That's harmless: esbuild's native binary comes from its
  platform package (`@esbuild/<platform>`).

## Layout

```
manifest.json            MV3 manifest (copied to dist/)
src/background.js        PDF takeover (webRequest / webNavigation / DNR), bypass, badge
src/shared/settings.js   settings defaults + chrome.storage helpers, viewer URL
src/viewer/boot.js       runs before pdf.js: framing guard, ?rawfile=, viewer options
src/viewer/qr-layer.js   scheduling, overlays, toolbar, popup messaging
src/viewer/qr-layer.css
src/qr/decoder.js        zxing-wasm / BarcodeDetector / jsQR adapters
src/qr/scan-core.js      render + image + upscale passes, coordinate mapping, dedupe
src/qr/payload.js        URL vs text classification
src/qr/worker.js         decoder Web Worker
src/popup/, src/options/
scripts/build.mjs        assets, viewer patch, esbuild bundles, icons -> dist/
scripts/serve.mjs        static dev server
test/                    page3, payload, background tests
samples/                 local test PDFs (git-ignored)
```
