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

// clampBank: clamps within [0, n)
eq(T.clampBank(0, 13), 0, "clampBank low");
eq(T.clampBank(12, 13), 12, "clampBank high");
eq(T.clampBank(-1, 13), 0, "clampBank below clamps to 0");
eq(T.clampBank(13, 13), 12, "clampBank above clamps to last");

// accumStep: returns {accum, fire}. Fires (and resets) when |accum| reaches sens;
// a direction reversal resets the accumulator first.
eq(T.accumStep(0, 1, 2), { accum: 1, fire: false }, "accum first tick no fire");
eq(T.accumStep(1, 1, 2), { accum: 0, fire: true }, "accum second tick fires+resets");
eq(T.accumStep(1, -1, 2), { accum: -1, fire: false }, "accum reversal resets then counts");

// wrapInc: wrapping increment for enum cells
eq(T.wrapInc(0, 1, 2), 1, "wrapInc up");
eq(T.wrapInc(1, 1, 2), 0, "wrapInc wraps high->0");
eq(T.wrapInc(0, -1, 4), 3, "wrapInc wraps low->last");
eq(T.wrapInc(3, -1, 4), 2, "wrapInc down");

// activeSection: the last JUMP_SECTIONS target <= bankIdx
eq(T.activeSection(0), 0, "activeSection first bank");
{
  const secs = T.JUMP_SECTIONS;
  const last = secs[secs.length - 1];
  eq(T.activeSection(last.bank), secs.length - 1, "activeSection last section");
  eq(T.activeSection(T.BANKS.length - 1), secs.length - 1, "activeSection last bank");
  // a bank strictly between two section targets belongs to the earlier one
  const fm = T.BANKS.findIndex((b) => b.label === "Filter Mode");
  const flt = secs.findIndex((sec) => sec.name === "FILTER");
  eq(T.activeSection(fm), flt, "activeSection owned bank (Filter Mode -> FILTER)");
}

// formatCell: per-kind text/bar resolution (fed by a stub ctx over DEFAULTS)
function stubCtx(over = {}) {
  const store = Object.assign({}, T.DEFAULTS, over);
  return { getParam: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null) };
}
function cellByKey(key) {
  for (const b of T.BANKS) for (const c of b.knobs) if (c.key === key) return c;
  return null;
}
{
  const ctx = stubCtx({ cutoff: 70, pan_1: 80, pan_2: 20, tune: 50, octave: -2, octave_transpose: 2, voice_count: 6, legato: 1, unison: 0 });
  const cut = T.formatCell(ctx, cellByKey("cutoff"));
  eq(cut.text, "70", "formatCell unipolar text");
  eq(cut.bar, 0.7, "formatCell unipolar bar frac");
  const p1 = T.formatCell(ctx, cellByKey("pan_1"));
  eq(p1.text, "+30", "formatCell bipolar + text");
  eq(p1.centerBar, 0.6, "formatCell bipolar + centerBar");
  const p2 = T.formatCell(ctx, cellByKey("pan_2"));
  eq(p2.text, "-30", "formatCell bipolar - text");
  const tune = T.formatCell(ctx, cellByKey("tune"));
  eq(tune.text, "0", "formatCell bipolar center text");
  eq(tune.centerBar, 0, "formatCell bipolar center bar");
  eq(T.formatCell(ctx, cellByKey("octave")).text, "-2", "formatCell octave negative");
  eq(T.formatCell(ctx, cellByKey("octave_transpose")).text, "+2", "formatCell octave positive");
  eq(T.formatCell(ctx, cellByKey("voice_count")).text, "6", "formatCell count");
  eq(T.formatCell(ctx, cellByKey("legato")).text, "Leg1", "formatCell enum legato");
  eq(T.formatCell(ctx, cellByKey("unison")).text, "Off", "formatCell toggle off");
  const atk = T.formatCell(ctx, cellByKey("attack"));
  eq(atk.fader, 0.01, "formatCell fader frac");
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall helper tests passed");
