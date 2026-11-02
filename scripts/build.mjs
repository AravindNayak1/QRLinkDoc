// Build the unpacked extension into dist/.
//
//   node scripts/build.mjs
//
// - copies pdf.js (pdfjs-dist) runtime assets into dist/viewer/
// - takes the prebuilt generic viewer (viewer.html / viewer.mjs / viewer.css,
//   images, locale) from the official pdf.js release zip of the SAME version as
//   the installed pdfjs-dist (npm's pdfjs-dist does not ship the full viewer).
//   The zip is cached in .cache/; set PDFJS_DIST_ZIP=/path/to/zip to build
//   offline.
// - patches the viewer (origin check, asset paths, defaults, CSP, our scripts)
// - bundles our sources with esbuild
// - generates the toolbar icons

import { build } from "esbuild";
import { unzipSync } from "fflate";
import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const VIEWER = path.join(DIST, "viewer");
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));
const PDFJS_VERSION = JSON.parse(await fs.readFile(path.join(PDFJS_DIR, "package.json"), "utf8")).version;

const log = (...a) => console.log("[build]", ...a);

async function main() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(VIEWER, { recursive: true });

  await copyPdfjsAssets();
  await installPrebuiltViewer();
  await bundle();
  await copyStatic();
  await makeIcons();
  await verify();
  log(`done -> ${path.relative(ROOT, DIST)}/ (pdf.js ${PDFJS_VERSION})`);
}

// ---------------------------------------------------------------------------

async function copyPdfjsAssets() {
  const buildDir = path.join(VIEWER, "build");
  await fs.mkdir(buildDir, { recursive: true });
  for (const f of ["pdf.mjs", "pdf.worker.mjs", "pdf.renderer.mjs", "pdf.sandbox.mjs"]) {
    const src = path.join(PDFJS_DIR, "build", f);
    if (await exists(src)) await fs.copyFile(src, path.join(buildDir, f));
  }
  for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    const src = path.join(PDFJS_DIR, dir);
    if (await exists(src)) await fs.cp(src, path.join(VIEWER, dir), { recursive: true });
  }
  log("copied pdfjs-dist build/, cmaps/, standard_fonts/, wasm/, iccs/");
}

async function getViewerZip() {
  if (process.env.PDFJS_DIST_ZIP) return fs.readFile(process.env.PDFJS_DIST_ZIP);
  const cached = path.join(ROOT, ".cache", `pdfjs-${PDFJS_VERSION}-dist.zip`);
  if (await exists(cached)) return fs.readFile(cached);
  const url = `https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip`;
  log(`downloading prebuilt viewer ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}. Set PDFJS_DIST_ZIP to a local copy.`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, buf);
  return buf;
}

async function installPrebuiltViewer() {
  const files = unzipSync(new Uint8Array(await getViewerZip()), {
    filter: (f) => /^web\/(viewer\.(html|mjs|css)$|images\/|locale\/)/.test(f.name),
  });
  const text = (name) => {
    if (!files[name]) throw new Error(`pdf.js viewer zip is missing ${name}`);
    return Buffer.from(files[name]).toString("utf8");
  };

  let mjs = text("web/viewer.mjs");
  if (!mjs.includes(`pdfjsVersion = ${PDFJS_VERSION}`)) {
    throw new Error(`viewer.mjs in the zip is not pdf.js ${PDFJS_VERSION}`);
  }
  // 1. Accept PDFs from any origin we can fetch (host_permissions), not just
  //    the viewer's own origin.
  mjs = patch(mjs, "if (fileOrigin === viewerOrigin) {", "if (fileOrigin === viewerOrigin || /^(https?|file|blob):/i.test(file)) {", "validateFileURL");
  // 2. Assets live next to viewer.html (viewer/build, viewer/cmaps, ...).
  mjs = patch(mjs, /"\.\.\/build\//g, '"./build/', "build paths", 3);
  mjs = patch(mjs, /"\.\.\/web\//g, '"./', "web asset paths", 4);
  // 3. No demo document when opened without ?file=.
  mjs = patch(mjs, /(\["defaultUrl", \{\s*value: )"compressed\.tracemonkey-pldi-09\.pdf"/, '$1""', "defaultUrl");
  // 4. Send cookies with the PDF request (signed-in sites).
  mjs = patch(mjs, /this\.open\(\{\s*url: file\s*\}\)/, "this.open({ url: file, withCredentials: /^https?:/i.test(file) })", "withCredentials", 1, { optional: true });

  let html = text("web/viewer.html");
  html = patch(html, '<script src="../build/pdf.mjs" type="module"></script>', '<script src="build/pdf.mjs" type="module"></script>', "pdf.mjs script");
  html = patch(html, '<script src="viewer.mjs" type="module"></script>', '<script src="boot.js" type="module"></script>\n  <script src="viewer.mjs" type="module"></script>\n  <script src="qr-layer.js" type="module"></script>', "our scripts");
  html = patch(html, '<link rel="stylesheet" href="viewer.css" />', '<link rel="stylesheet" href="viewer.css" />\n    <link rel="stylesheet" href="qr-layer.css" />', "our css");
  html = patch(html, "connect-src * blob: data:", "connect-src * blob: data: file:", "CSP connect-src");
  html = patch(html, "<title>PDF.js viewer</title>", "<title>QR Link PDF</title>", "title");

  await fs.writeFile(path.join(VIEWER, "viewer.mjs"), mjs);
  await fs.writeFile(path.join(VIEWER, "viewer.html"), html);
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/") || name === "web/viewer.mjs" || name === "web/viewer.html") continue;
    const out = path.join(VIEWER, name.slice("web/".length));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, data);
  }
  log("installed and patched prebuilt pdf.js viewer");
}

/**
 * Replace `search` in `src`, failing the build if it is not found (or found
 * fewer than `min` times), so viewer updates never silently break a patch.
 */
function patch(src, search, replacement, label, min = 1, { optional = false } = {}) {
  const re = typeof search === "string" ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : new RegExp(search.source, search.flags.includes("g") ? search.flags : search.flags + "g");
  const count = src.match(re)?.length ?? 0;
  if (count < min) {
    const msg = `viewer patch "${label}" matched ${count} time(s), expected >= ${min}`;
    if (optional) {
      console.warn(`[build] warning: ${msg}`);
      return src;
    }
    throw new Error(msg);
  }
  return src.replace(re, replacement);
}

async function bundle() {
  const common = { bundle: true, minify: false, sourcemap: false, target: "chrome116", logLevel: "warning", legalComments: "none" };
  await build({
    ...common,
    format: "esm",
    entryPoints: {
      background: "src/background.js",
      "viewer/boot": "src/viewer/boot.js",
      "viewer/qr-layer": "src/viewer/qr-layer.js",
      "popup/popup": "src/popup/popup.js",
      "options/options": "src/options/options.js",
    },
    outdir: DIST,
    absWorkingDir: ROOT,
  });
  await build({ ...common, format: "iife", entryPoints: { "qr/worker": "src/qr/worker.js" }, outdir: DIST, absWorkingDir: ROOT });

  // zxing-wasm's default locateFile points at a CDN. We always override it,
  // but strip the URL anyway so the package contains no remote code location.
  const workerPath = path.join(DIST, "qr", "worker.js");
  let worker = await fs.readFile(workerPath, "utf8");
  worker = worker.replace(/`https:\/\/fastly\.jsdelivr\.net\/npm\/zxing-wasm@[^`]*\$\{(\w+)\}`/g, "`./${$1}`");
  await fs.writeFile(workerPath, worker);
  await fs.copyFile(require.resolve("zxing-wasm/reader/zxing_reader.wasm"), path.join(DIST, "qr", "zxing_reader.wasm"));
  log("bundled background, viewer, worker, popup, options");
}

async function copyStatic() {
  await fs.copyFile(path.join(ROOT, "manifest.json"), path.join(DIST, "manifest.json"));
  await fs.copyFile(path.join(ROOT, "src/viewer/qr-layer.css"), path.join(VIEWER, "qr-layer.css"));
  for (const [dir, files] of [["popup", ["popup.html", "popup.css"]], ["options", ["options.html", "options.css"]]]) {
    for (const f of files) await fs.copyFile(path.join(ROOT, "src", dir, f), path.join(DIST, dir, f));
  }
}

async function makeIcons() {
  const dir = path.join(DIST, "icons");
  await fs.mkdir(dir, { recursive: true });
  // A 7x7 "finder pattern" with a link-blue corner badge.
  for (const size of [16, 32, 48, 128]) {
    const c = createCanvas(size, size);
    const g = c.getContext("2d");
    const u = size / 16;
    g.fillStyle = "#ffffff";
    roundRect(g, 0, 0, size, size, 3 * u);
    g.fill();
    g.fillStyle = "#1b1b1f";
    g.fillRect(1.5 * u, 1.5 * u, 9 * u, 9 * u);
    g.fillStyle = "#ffffff";
    g.fillRect(2.8 * u, 2.8 * u, 6.4 * u, 6.4 * u);
    g.fillStyle = "#1b1b1f";
    g.fillRect(4.2 * u, 4.2 * u, 3.6 * u, 3.6 * u);
    g.fillStyle = "#0b63ce";
    g.beginPath();
    g.arc(12 * u, 12 * u, 3.6 * u, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#ffffff";
    g.lineWidth = Math.max(1, 1.1 * u);
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(10.6 * u, 13.4 * u);
    g.lineTo(13.4 * u, 10.6 * u);
    g.stroke();
    await fs.writeFile(path.join(dir, `icon${size}.png`), c.toBuffer("image/png"));
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

async function verify() {
  const must = [
    "manifest.json", "background.js", "icons/icon128.png",
    "viewer/viewer.html", "viewer/viewer.mjs", "viewer/viewer.css", "viewer/boot.js", "viewer/qr-layer.js", "viewer/qr-layer.css",
    "viewer/build/pdf.mjs", "viewer/build/pdf.worker.mjs", "viewer/cmaps", "viewer/standard_fonts", "viewer/locale/locale.json",
    "qr/worker.js", "qr/zxing_reader.wasm", "popup/popup.html", "popup/popup.js", "options/options.html", "options/options.js",
  ];
  for (const f of must) {
    if (!(await exists(path.join(DIST, f)))) throw new Error(`build output missing ${f}`);
  }
  // MV3: no remote code. Our bundles must not reference a CDN.
  for (const f of ["background.js", "viewer/boot.js", "viewer/qr-layer.js", "qr/worker.js", "popup/popup.js", "options/options.js"]) {
    const src = await fs.readFile(path.join(DIST, f), "utf8");
    if (/jsdelivr|unpkg\.com|cdnjs/.test(src)) throw new Error(`${f} references a CDN`);
  }
  JSON.parse(await fs.readFile(path.join(DIST, "manifest.json"), "utf8"));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("[build] FAILED:", err.message);
  process.exit(1);
});
