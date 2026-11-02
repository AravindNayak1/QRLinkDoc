// Page scanning shared by the extension viewer and the Node test.
//
//   scanPage(page, { pdfjs, dpi, decode, createCanvas })
//
// 1. Render pass: render the page once at `dpi` (independent of the viewer's
//    zoom) and hand the pixels to `decode(imageData) -> Promise<hit[]>` (a Web
//    Worker in the extension).
// 2. Image pass: decode roughly square embedded images directly from their
//    pixels. This catches codes that are too small/blurry at `dpi`, and codes
//    that are painted over by later content (flagged `visible: false`).
// 3. Upscale pass: re-render, at 2x, square image regions still not covered.
//
// Every hit is mapped back to PDF user space (viewport at scale 1, y up).

import { classifyPayload } from "./payload.js";

export const DEFAULT_DPI = 200;
// "ignore codes under 40 px at 200 DPI", expressed in PDF points.
const MIN_CODE_PT = (40 * 72) / 200;
const MAX_CANVAS_PIXELS = 24e6;
const MAX_CANDIDATES = 24;

/**
 * @returns {Promise<Array<{text:string, href:string|null, kind:"url"|"text",
 *   rect:number[], quad:number[][], engine:string, source:string,
 *   visible:boolean}>>}
 *   `rect` is [x1, y1, x2, y2] in PDF user space, `quad` the symbol corners
 *   (tl, tr, br, bl) in PDF user space.
 */
export async function scanPage(page, { pdfjs, dpi = DEFAULT_DPI, decode, createCanvas }) {
  let scale = dpi / 72;
  const base = page.getViewport({ scale: 1 });
  if (base.width * base.height * scale * scale > MAX_CANVAS_PIXELS) {
    scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
  }
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);

  // 1. Render pass.
  const full = await renderRegion(page, pdfjs, createCanvas, viewport, 0, 0, width, height);
  const rendered = mapHits(await decode(full), (x, y) => viewport.convertToPdfPoint(x, y), "render");
  let codes = rendered.map((c) => ({ ...c, visible: true }));
  const covered = (rect) => codes.some((c) => overlapRatio(c.rect, rect) > 0.5);

  // 2. Image pass.
  const images = (await findSquareImages(page, pdfjs)).filter((img) => !covered(img.rect)).slice(0, MAX_CANDIDATES);
  const stillMissing = [];
  for (const img of images) {
    const hits = await decodeEmbeddedImage(page, img, decode, createCanvas);
    if (hits.length) {
      codes = codes.concat(hits.map((c) => ({ ...c, visible: isPainted(full, viewport, c.rect) })));
    } else {
      stillMissing.push(img);
    }
  }

  // 3. Upscale pass for candidates neither pass could read.
  if (stillMissing.length) {
    const zoomed = page.getViewport({ scale: scale * 2 });
    for (const { rect } of stillMissing) {
      if (covered(rect)) continue;
      const [vx1, vy1, vx2, vy2] = toViewportRect(zoomed, rect);
      const pad = (vx2 - vx1) * 0.25;
      const x = Math.max(0, Math.floor(vx1 - pad));
      const y = Math.max(0, Math.floor(vy1 - pad));
      const w = Math.min(Math.ceil(zoomed.width) - x, Math.ceil(vx2 - vx1 + 2 * pad));
      const h = Math.min(Math.ceil(zoomed.height) - y, Math.ceil(vy2 - vy1 + 2 * pad));
      if (w < 16 || h < 16) continue;
      const img = await renderRegion(page, pdfjs, createCanvas, zoomed, x, y, w, h);
      const hits = mapHits(await decode(img), (px, py) => zoomed.convertToPdfPoint(px + x, py + y), "upscale");
      codes = codes.concat(hits.map((c) => ({ ...c, visible: true })));
    }
  }
  return dedupe(codes);
}

async function renderRegion(page, pdfjs, createCanvas, viewport, x, y, w, h) {
  const { canvas, context } = createCanvas(w, h);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, w, h);
  await page.render({
    canvasContext: context,
    canvas,
    viewport,
    transform: x || y ? [1, 0, 0, 1, -x, -y] : null,
    annotationMode: pdfjs.AnnotationMode.DISABLE,
    background: "#ffffff",
  }).promise;
  return context.getImageData(0, 0, w, h);
}

function mapHits(hits, toPdf, source) {
  const out = [];
  for (const hit of hits) {
    const quad = hit.corners.map((c) => toPdf(c.x, c.y));
    const rect = boundsOf(quad);
    if (Math.min(rect[2] - rect[0], rect[3] - rect[1]) < MIN_CODE_PT) continue;
    out.push({ text: hit.text, ...classifyPayload(hit.text), rect, quad, engine: hit.engine, source });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Embedded images

/**
 * Roughly square images between ~10pt and ~300pt, found by walking the
 * operator list and tracking the CTM. Returns { id, rect, ctm, w, h }.
 */
export async function findSquareImages(page, pdfjs) {
  const { OPS } = pdfjs;
  let ops;
  try {
    ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  } catch {
    return [];
  }
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].filter((v) => v !== undefined));
  const identity = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ctm = identity;
  const found = [];
  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? identity;
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0];
      if (m && m.length === 6) ctm = multiply(ctm, Array.from(m));
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? identity;
    } else if (imageOps.has(fn)) {
      const rect = boundsOf([[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => apply(ctm, u, v)));
      const w = rect[2] - rect[0];
      const h = rect[3] - rect[1];
      const ratio = w / h;
      if (w >= 10 && h >= 10 && w <= 300 && h <= 300 && ratio > 0.8 && ratio < 1.25) {
        // paintImageXObject: [objId, width, height]; inline images carry the data.
        const id = typeof args?.[0] === "string" ? args[0] : null;
        const inline = id ? null : args?.[0];
        if (!found.some((f) => f.id && f.id === id && overlapRatio(f.rect, rect) > 0.9)) {
          found.push({ id, inline, rect, ctm, pixelWidth: args?.[1] ?? inline?.width, pixelHeight: args?.[2] ?? inline?.height });
        }
      }
    }
  }
  return found;
}

async function getImageObject(page, img) {
  if (img.inline) return img.inline;
  if (!img.id) return null;
  const store = img.id.startsWith("g_") ? page.commonObjs : page.objs;
  if (!store?.get) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    try {
      store.get(img.id, (obj) => {
        clearTimeout(timer);
        resolve(obj);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Decode an embedded image's own pixels and map hits through its CTM. */
async function decodeEmbeddedImage(page, img, decode, createCanvas) {
  let obj;
  try {
    obj = await getImageObject(page, img);
  } catch {
    obj = null;
  }
  const rgba = obj && imageObjectToRGBA(obj, createCanvas);
  if (!rgba || rgba.width < 21 || rgba.height < 21) return [];

  // Nearest-neighbour upscale (small symbols) plus a white quiet zone.
  const k = Math.max(1, Math.min(4, Math.ceil(240 / Math.max(rgba.width, rgba.height))));
  const margin = Math.round(Math.max(rgba.width, rgba.height) * k * 0.15);
  const prepared = padAndScale(rgba, k, margin);
  const { width: W, height: H } = rgba;
  // Image space: pixel (u, v) with v down -> unit square (u / W, 1 - v / H).
  const toPdf = (px, py) => apply(img.ctm, (px - margin) / k / W, 1 - (py - margin) / k / H);
  return mapHits(await decode(prepared), toPdf, "image");
}

function imageObjectToRGBA(obj, createCanvas) {
  const { width, height } = obj;
  if (!width || !height) return null;
  if (obj.bitmap) {
    const { context } = createCanvas(width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(obj.bitmap, 0, 0);
    return context.getImageData(0, 0, width, height);
  }
  const src = obj.data;
  if (!src) return null;
  const out = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  if (obj.kind === 3 || src.length === n * 4) {
    // RGBA_32BPP: composite over white.
    for (let i = 0; i < n; i++) {
      const a = src[i * 4 + 3] / 255;
      out[i * 4] = src[i * 4] * a + 255 * (1 - a);
      out[i * 4 + 1] = src[i * 4 + 1] * a + 255 * (1 - a);
      out[i * 4 + 2] = src[i * 4 + 2] * a + 255 * (1 - a);
      out[i * 4 + 3] = 255;
    }
  } else if (obj.kind === 2 || src.length === n * 3) {
    for (let i = 0; i < n; i++) {
      out[i * 4] = src[i * 3];
      out[i * 4 + 1] = src[i * 3 + 1];
      out[i * 4 + 2] = src[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
  } else if (obj.kind === 1) {
    // GRAYSCALE_1BPP: rows padded to whole bytes, 1 = white.
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return { data: out, width, height };
}

function padAndScale(img, k, margin) {
  const W = img.width * k + 2 * margin;
  const H = img.height * k + 2 * margin;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < img.height * k; y++) {
    const sy = (y / k) | 0;
    for (let x = 0; x < img.width * k; x++) {
      const s = (sy * img.width + ((x / k) | 0)) * 4;
      const o = ((y + margin) * W + x + margin) * 4;
      out[o] = img.data[s];
      out[o + 1] = img.data[s + 1];
      out[o + 2] = img.data[s + 2];
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Is anything actually drawn at `rect` in the rendered page? A code painted
 * over by an opaque shape renders as a flat area.
 */
function isPainted(image, viewport, rect) {
  const [x1, y1, x2, y2] = toViewportRect(viewport, rect).map(Math.round);
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  const step = Math.max(1, Math.round((x2 - x1) / 48));
  for (let y = Math.max(0, y1); y < Math.min(image.height, y2); y += step) {
    for (let x = Math.max(0, x1); x < Math.min(image.width, x2); x += step) {
      const o = (y * image.width + x) * 4;
      const l = 0.299 * image.data[o] + 0.587 * image.data[o + 1] + 0.114 * image.data[o + 2];
      sum += l;
      sumSq += l * l;
      n++;
    }
  }
  if (!n) return false;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean)) > 12;
}

// ---------------------------------------------------------------------------
// Geometry

/** PDF-space [x1, y1, x2, y2] -> viewport-space [x1, y1, x2, y2] (normalised). */
export function toViewportRect(viewport, rect) {
  const a = viewport.convertToViewportPoint(rect[0], rect[1]);
  const b = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Intersection area / smaller area, for [x1, y1, x2, y2] rects. */
export function overlapRatio(a, b) {
  const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return (ix * iy) / Math.min(area(a), area(b));
}

/** Drop codes whose boxes overlap an earlier one by >50%; sort in reading order. */
export function dedupe(codes) {
  const kept = [];
  for (const code of codes) {
    if (!kept.some((k) => overlapRatio(k.rect, code.rect) > 0.5)) kept.push(code);
  }
  return kept.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
}

function boundsOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
