// QR decoder adapters. Environment-agnostic: runs in the extension's Web Worker
// and in Node (test/page3.test.mjs).
//
// Every adapter takes an ImageData-like object ({ data, width, height }) and
// returns an array of { text, corners: [tl, tr, br, bl], engine } in the
// pixel space of that image.

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import jsQR from "jsqr";

const MAX_SYMBOLS = 64;

// ---------------------------------------------------------------------------
// zxing-wasm (primary): returns every code in the image in one call.

let zxingReady = null;

/**
 * @param {object} overrides Emscripten overrides. Pass `wasmBinary` (bytes) or
 *   `locateFile` so the WASM is never fetched from the default CDN.
 */
export function initZXing(overrides) {
  if (!zxingReady) {
    zxingReady = prepareZXingModule({ overrides, fireImmediately: true }).then(
      () => true,
      (err) => {
        console.warn("[qr-link] zxing-wasm unavailable, falling back:", err);
        return false;
      },
    );
  }
  return zxingReady;
}

export async function decodeWithZXing(image) {
  const results = await readBarcodes(toImageData(image), {
    formats: ["QRCode"],
    tryHarder: true,
    tryRotate: true,
    tryInvert: false,
    tryDownscale: true,
    maxNumberOfSymbols: MAX_SYMBOLS,
  });
  return results
    .filter((r) => r.isValid && r.text)
    .map((r) => {
      const p = r.position;
      return {
        text: r.text,
        corners: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map(pt),
        engine: "zxing",
      };
    });
}

// ---------------------------------------------------------------------------
// jsQR (fallback): one code per call, so erase each hit and rescan.

export function decodeWithJsQR(image) {
  const { width, height } = image;
  // Work on a copy; we paint over found codes.
  const data = new Uint8ClampedArray(image.data);
  const found = [];
  for (let i = 0; i < MAX_SYMBOLS; i++) {
    const hit = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
    if (!hit || !hit.data) break;
    const loc = hit.location;
    const corners = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner].map(pt);
    found.push({ text: hit.data, corners, engine: "jsqr" });
    eraseRegion(data, width, height, corners);
  }
  return found;
}

function eraseRegion(data, width, height, corners) {
  const { x0, y0, x1, y1 } = cornersBox(corners);
  // Pad by ~15% so finder patterns are fully removed (avoids re-detection loops).
  const pad = Math.max(4, Math.round(Math.max(x1 - x0, y1 - y0) * 0.15));
  const xs = Math.max(0, Math.floor(x0 - pad));
  const ys = Math.max(0, Math.floor(y0 - pad));
  const xe = Math.min(width, Math.ceil(x1 + pad));
  const ye = Math.min(height, Math.ceil(y1 + pad));
  for (let y = ys; y < ye; y++) {
    data.fill(255, (y * width + xs) * 4, (y * width + xe) * 4);
  }
}

// ---------------------------------------------------------------------------
// Native BarcodeDetector (opportunistic; not available in Edge on Windows).

let nativeDetector;

export async function getNativeDetector() {
  if (nativeDetector !== undefined) return nativeDetector;
  nativeDetector = null;
  try {
    if (typeof BarcodeDetector !== "undefined") {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        nativeDetector = new BarcodeDetector({ formats: ["qr_code"] });
      }
    }
  } catch {
    nativeDetector = null;
  }
  return nativeDetector;
}

export async function decodeWithNative(detector, image) {
  const codes = await detector.detect(toImageData(image));
  return codes
    .filter((c) => c.rawValue)
    .map((c) => ({ text: c.rawValue, corners: c.cornerPoints.map(pt), engine: "native" }));
}

// ---------------------------------------------------------------------------

/**
 * Decode with the best available engine. `engines` restricts the order
 * (default: zxing -> native -> jsqr). The first engine that is available is
 * used; jsQR is also used when zxing failed to initialise.
 */
export async function decodeImage(image, { engines = ["zxing", "native", "jsqr"] } = {}) {
  for (const engine of engines) {
    if (engine === "zxing") {
      if (zxingReady && (await zxingReady)) return decodeWithZXing(image);
    } else if (engine === "native") {
      const det = await getNativeDetector();
      if (det) return decodeWithNative(det, image);
    } else if (engine === "jsqr") {
      return decodeWithJsQR(image);
    }
  }
  return [];
}

export function cornersBox(corners) {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function pt(p) {
  return { x: p.x, y: p.y };
}

function toImageData(image) {
  if (typeof ImageData !== "undefined" && image instanceof ImageData) return image;
  if (typeof ImageData !== "undefined") {
    return new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), image.width, image.height);
  }
  // Node: zxing-wasm only reads { data, width, height }.
  return { data: image.data, width: image.width, height: image.height, colorSpace: "srgb" };
}
