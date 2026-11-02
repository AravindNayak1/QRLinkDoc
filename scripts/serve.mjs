// Tiny static server for developing the viewer outside the extension:
//   node scripts/serve.mjs [port]
//   http://localhost:8571/dist/viewer/viewer.html?file=/samples/<name>.pdf
// chrome.* APIs are absent there; the viewer and QR layer degrade gracefully.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8571);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".ftl": "text/plain", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf", ".icc": "application/octet-stream" };

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "content-length": st.size, "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}/`));
