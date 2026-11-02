// Decoder Web Worker. Receives { id, image: ImageData } and answers
// { id, hits } (or { id, error }), so decoding never blocks the viewer UI.

import { initZXing, decodeImage } from "./decoder.js";

// zxing_reader.wasm is packaged next to this script; never fetch it remotely.
const ready = initZXing({
  locateFile: (file) => new URL(file, self.location.href).href,
});

self.onmessage = async ({ data }) => {
  const { id, image } = data;
  try {
    await ready;
    const hits = await decodeImage(image);
    self.postMessage({ id, hits });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
