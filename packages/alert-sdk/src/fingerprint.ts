// A stable deduplication key for an exception, so the same bug thrown a
// thousand times is one incident with a thousand alerts, not a thousand
// incidents:
//
//   TypeError: Cannot read properties of undefined (reading 'id')
//       at loadCart (/srv/checkout/cart.js:41:17)
//                      ─────────────────── no line/column: survives a redeploy that shifts lines
//   → "exc-" + hash(TypeError | cannot read properties of undefined (reading '<str>') | loadCart cart.js)
//
// Numbers, ids and quoted values in the message are masked, so "order 4711
// failed" and "order 4712 failed" group together.

// Input is clipped first and every pattern is linear, so a hostile message
// (thousands of quotes or spaces) can't make fingerprinting slow.
export function normalizeMessage(message: string) {
  return message
    .slice(0, 2000)
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

// "at loadCart (/srv/checkout/cart.js:41:17)" → "loadCart cart.js"
export function topFrame(stack: string | undefined) {
  const line = stack?.split("\n").find((l) => l.trimStart().startsWith("at "));
  if (!line) return "";
  // Plain string handling instead of one backtracking regex.
  let rest = line.trim().slice(3, 500).trim();
  let fn = "";
  const open = rest.lastIndexOf(" (");
  if (open !== -1 && rest.endsWith(")")) {
    fn = rest.slice(0, open).trim();
    rest = rest.slice(open + 2, -1);
  }
  const location = rest.replace(/(?::\d+){1,2}$/, "");
  const file = location.split(/[\\/]/).pop() ?? "";
  return `${fn} ${file}`.trim();
}

// FNV-1a, 32-bit: tiny, dependency-free and good enough for grouping keys.
function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function errorFingerprint(error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  return `exc-${fnv1a([err.name, normalizeMessage(err.message), topFrame(err.stack)].join("|"))}`;
}
