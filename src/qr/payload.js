// Decide whether a decoded QR payload is a link and, if so, what to open.

const SCHEME_RE = /^(https?:\/\/|mailto:|tel:)/i;
const WWW_RE = /^www\.[^\s]+\.[^\s]+$/i;
// Bare domain with an alphabetic TLD, optional port and path: example.com/x
const BARE_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

/** @returns {{ kind: "url"|"text", href: string|null }} */
export function classifyPayload(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /\s/.test(text)) return { kind: "text", href: null };
  if (SCHEME_RE.test(text)) return safe(text);
  if (WWW_RE.test(text) || BARE_DOMAIN_RE.test(text)) return safe(`https://${text}`);
  return { kind: "text", href: null };
}

function safe(href) {
  try {
    const url = new URL(href);
    if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return { kind: "text", href: null };
    return { kind: "url", href: url.href };
  } catch {
    return { kind: "text", href: null };
  }
}
