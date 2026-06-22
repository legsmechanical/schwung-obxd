// One-shot node check for canvas.js pure helpers. Run: node tests/canvas_helpers.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "canvas.js"), "utf8");
// canvas.js is a plain script that assigns globalThis.bank_editor; eval it here.
(0, eval)(src);
const T = globalThis.bank_editor._test;

let failures = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { failures++; console.error(`FAIL ${msg}: got ${a}, want ${e}`); }
  else { console.log(`ok   ${msg}`); }
}

// dirFromCC: 1..63 -> +1, 65..127 -> -1, 0 and 64 -> 0
eq(T.dirFromCC(1), 1, "dirFromCC cw min");
eq(T.dirFromCC(63), 1, "dirFromCC cw max");
eq(T.dirFromCC(65), -1, "dirFromCC ccw min");
eq(T.dirFromCC(127), -1, "dirFromCC ccw max");
eq(T.dirFromCC(0), 0, "dirFromCC zero");
eq(T.dirFromCC(64), 0, "dirFromCC sixtyfour");

// clampBank: wraps within [0, n)
eq(T.clampBank(0, 14), 0, "clampBank low");
eq(T.clampBank(13, 14), 13, "clampBank high");
eq(T.clampBank(-1, 14), 0, "clampBank below clamps to 0");
eq(T.clampBank(14, 14), 13, "clampBank above clamps to last");

// accumStep: returns {accum, fire}. Fires (and resets) when |accum| reaches sens;
// a direction reversal resets the accumulator first.
eq(T.accumStep(0, 1, 2), { accum: 1, fire: false }, "accum first tick no fire");
eq(T.accumStep(1, 1, 2), { accum: 0, fire: true }, "accum second tick fires+resets");
eq(T.accumStep(1, -1, 2), { accum: -1, fire: false }, "accum reversal resets then counts");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall helper tests passed");
