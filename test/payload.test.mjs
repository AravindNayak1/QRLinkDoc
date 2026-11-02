import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPayload } from "../src/qr/payload.js";
import { dedupe, overlapRatio } from "../src/qr/scan-core.js";

test("URL-like payloads become links", () => {
  assert.deepEqual(classifyPayload("https://gateoverflow.in/412"), { kind: "url", href: "https://gateoverflow.in/412" });
  assert.equal(classifyPayload("HTTP://Example.com/a?b=1").href, "http://example.com/a?b=1");
  assert.equal(classifyPayload("www.example.com/path").href, "https://www.example.com/path");
  assert.equal(classifyPayload("example.org").href, "https://example.org/");
  assert.equal(classifyPayload("gateoverflow.in/2106").href, "https://gateoverflow.in/2106");
  assert.equal(classifyPayload("mailto:someone@example.com").kind, "url");
  assert.equal(classifyPayload("tel:+15551234567").kind, "url");
  assert.equal(classifyPayload("  https://example.com  ").href, "https://example.com/");
});

test("everything else is shown as text, never navigated to", () => {
  for (const raw of ["javascript:alert(1)", "data:text/html,hi", "WIFI:S:home;T:WPA;P:secret;;", "hello world", "12345", "file:///C:/x.pdf", "", "version1.2"]) {
    assert.equal(classifyPayload(raw).kind, "text", raw);
    assert.equal(classifyPayload(raw).href, null, raw);
  }
});

test("dedupe drops boxes overlapping more than 50%", () => {
  const a = { text: "a", rect: [0, 0, 10, 10] };
  const b = { text: "b", rect: [2, 2, 12, 12] }; // 64% of a
  const c = { text: "c", rect: [8, 8, 18, 18] }; // 4% of a
  assert.ok(overlapRatio(a.rect, b.rect) > 0.5);
  assert.deepEqual(dedupe([a, b, c]).map((x) => x.text).sort(), ["a", "c"]);
});
