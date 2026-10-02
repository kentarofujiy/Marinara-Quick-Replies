// Build the installable bundle from source.
//
// quick-reply.json's `js`/`css` fields hold the extension code; this splices
// the current extension.js/style.css into it so the bundle never drifts
// from source by hand. selfcheck runs first: a version that fails its own
// checks is never bundled.
//   node build.mjs
import { readFileSync, writeFileSync } from "node:fs";

const BUNDLE = "quick-reply.json";
const JS_SOURCE = "extension.js";
const CSS_SOURCE = "style.css";

// 1) Gate on selfcheck (its top-level assertions throw on failure).
try {
  await import("./selfcheck.mjs");
} catch (e) {
  console.error("\nbuild: selfcheck FAILED — bundle not written.\n" + (e && e.message ? e.message : e));
  process.exit(1);
}

// 2) Splice source into the bundle, preserving key order + metadata.
const bundle = JSON.parse(readFileSync(BUNDLE, "utf8"));
const js = readFileSync(JS_SOURCE, "utf8");
const css = readFileSync(CSS_SOURCE, "utf8");
bundle.js = js;
bundle.css = css;

// Pretty-print (2-space) then convert structural newlines to CRLF to match
// the other ported extensions' bundle convention. Newlines inside the js/css
// strings are already escaped as "\n" by JSON.stringify.
const out = JSON.stringify(bundle, null, 2).replace(/\n/g, "\r\n");
writeFileSync(BUNDLE, out, "utf8");

// 3) Round-trip check: the written bundle must parse and its js/css must match.
const check = JSON.parse(readFileSync(BUNDLE, "utf8"));
if (check.js !== js) {
  console.error("build: round-trip mismatch — bundle js does not equal extension.js.");
  process.exit(1);
}
if (check.css !== css) {
  console.error("build: round-trip mismatch — bundle css does not equal style.css.");
  process.exit(1);
}
console.log(`build: wrote ${BUNDLE} (${out.length} chars; js ${js.length} chars, css ${css.length} chars) OK`);
