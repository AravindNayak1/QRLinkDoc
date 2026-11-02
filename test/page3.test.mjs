// Renders page 3 of the sample PDF with pdf.js + @napi-rs/canvas and checks
// that the shared scanner finds the four QR codes with sensible bounding boxes.
//
//   npm test
//
// The sample PDF is third-party content and is not in the repository; put a
// copy in samples/ to run these tests, otherwise they are skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { scanPage } from "../src/qr/scan-core.js";
import { initZXing, decodeImage } from "../src/qr/decoder.js";

const require = createRequire(import.meta.url);
const SAMPLE = fileURLToPath(new URL("../samples/GATE_CN_PYQs_filtered_to_GATE2027_syllabus.pdf", import.meta.url));
const SKIP = existsSync(SAMPLE) ? false : "sample PDF not present in samples/";
const EXPECTED = [
  "https://gateoverflow.in/412",
  "https://gateoverflow.in/2106",
  "https://gateoverflow.in/42",
  "https://gateoverflow.in/39628",
];

// This "filtered" PDF paints white rectangles over questions outside the 2027
// syllabus. On page 3 two of the four embedded QR images sit under those
// rectangles: they still decode (from the image data) but must be reported as
// not visible.
const VISIBLE = new Set(["https://gateoverflow.in/412", "https://gateoverflow.in/42"]);

const canvasFactory = (w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, context: canvas.getContext("2d") };
};

async function openSample() {
  const data = new Uint8Array(await readFile(SAMPLE));
  const pdfDir = new URL("../node_modules/pdfjs-dist/", import.meta.url);
  // pdf.js wants these as directory paths ending in "/" (also on Windows).
  const dir = (name) => fileURLToPath(new URL(name, pdfDir)).replaceAll("\\", "/");
  return pdfjs.getDocument({
    data,
    standardFontDataUrl: dir("standard_fonts/"),
    cMapUrl: dir("cmaps/"),
    wasmUrl: dir("wasm/"),
    verbosity: 0,
  });
}

async function scanPage3(engines) {
  const task = await openSample();
  try {
    const doc = await task.promise;
    assert.equal(doc.numPages, 56, "sample should have 56 pages");
    const page = await doc.getPage(3);
    const view = page.view; // [x1, y1, x2, y2] of the page box
    const codes = await scanPage(page, {
      pdfjs,
      dpi: 200,
      createCanvas: canvasFactory,
      decode: (img) => decodeImage(img, { engines }),
    });
    return { codes, view };
  } finally {
    await task.destroy();
  }
}

function assertPage3(codes, view, label) {
  const texts = codes.map((c) => c.text);
  assert.deepEqual([...texts].sort(), [...EXPECTED].sort(), `${label}: decoded payloads`);
  for (const code of codes) {
    const [x1, y1, x2, y2] = code.rect;
    const w = x2 - x1;
    const h = y2 - y1;
    // ~35pt symbols (93px @ 192ppi incl. quiet zone); the symbol itself is a bit smaller.
    assert.ok(w > 20 && w < 45 && h > 20 && h < 45, `${label}: ${code.text} size ${w.toFixed(1)}x${h.toFixed(1)}pt`);
    assert.ok(Math.abs(w - h) < 3, `${label}: ${code.text} should be square`);
    // Right margin, roughly x = 522..556pt, inside the page.
    assert.ok(x1 > 510 && x2 < 568, `${label}: ${code.text} x-range ${x1.toFixed(1)}..${x2.toFixed(1)}`);
    assert.ok(y1 >= view[1] && y2 <= view[3], `${label}: ${code.text} within page`);
    assert.equal(code.visible, VISIBLE.has(code.text), `${label}: ${code.text} visibility`);
    assert.equal(code.kind, "url");
    assert.equal(code.href, code.text);
  }
  // No two boxes overlap.
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const a = codes[i].rect;
      const b = codes[j].rect;
      const disjoint = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
      assert.ok(disjoint, `${label}: boxes of ${codes[i].text} and ${codes[j].text} overlap`);
    }
  }
}

test("zxing-wasm finds all 4 QR codes on page 3", { skip: SKIP }, async () => {
  const wasmBinary = await readFile(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
  assert.equal(await initZXing({ wasmBinary }), true, "zxing-wasm should initialise");
  const { codes, view } = await scanPage3(["zxing"]);
  for (const c of codes) console.log(`  [zxing] ${c.text}  rect=${c.rect.map((v) => v.toFixed(1)).join(",")}  via=${c.source} visible=${c.visible}`);
  assertPage3(codes, view, "zxing");
});

test("jsQR erase-and-repeat fallback finds all 4 QR codes on page 3", { skip: SKIP }, async () => {
  const { codes, view } = await scanPage3(["jsqr"]);
  for (const c of codes) console.log(`  [jsqr]  ${c.text}  rect=${c.rect.map((v) => v.toFixed(1)).join(",")}  via=${c.source} visible=${c.visible}`);
  assertPage3(codes, view, "jsqr");
});
