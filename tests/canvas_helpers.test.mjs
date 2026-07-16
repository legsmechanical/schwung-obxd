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

// enum cells: slower sens than continuous, and clamp (no wrap) at the ends —
// exercised through onMidi with a stub ctx (CC 71 = knob 1, d2 1 = CW, 127 = CCW).
{
  const be = globalThis.bank_editor;
  const store = Object.assign({}, T.DEFAULTS);
  const ctx = {
    state: {},
    getParam: (k) => String(store[k]),
    setParam: (k, v) => { store[k] = parseInt(v, 10); },
    getValue: () => "12", setValue: () => {}   // bank 12 = Global (legato on knob 7)
  };
  be.onOpen(ctx);
  const turn = (cc, d2) => be.onMidi(ctx, { data: [0xB0, cc, d2] });
  const legato = T.BANKS[12].knobs.find((c) => c.key === "legato");
  eq(legato.sens, 3, "enum sens is 3 (slower than continuous 2)");
  store.legato = 0;
  turn(77, 1); turn(77, 1);
  eq(store.legato, 0, "enum: 2 detents don't fire at sens 3");
  turn(77, 1);
  eq(store.legato, 1, "enum: 3rd detent fires");
  store.legato = 3;
  turn(77, 1); turn(77, 1); turn(77, 1);
  eq(store.legato, 3, "enum clamps at max (no wrap to 0)");
  store.unison = 0; // Voice bank knob 1 — but stay on Global: as_played knob 8
  store.as_played = 0;
  turn(78, 127); turn(78, 127); turn(78, 127);
  eq(store.as_played, 0, "toggle clamps at min (no wrap to On)");
}

// activeSection: the last JUMP_SECTIONS target <= bankIdx
{
  const secs = T.JUMP_SECTIONS;
  eq(T.activeSection(0), 0, "activeSection first bank");
  eq(T.activeSection(T.BANKS.length - 1), secs.length - 1, "activeSection last bank");
  const fm = T.BANKS.findIndex((b) => b.label === "Filter Mode");
  const flt = secs.findIndex((sec) => sec.name === "FILTER");
  eq(T.activeSection(fm), flt, "activeSection owned bank (Filter Mode -> FILTER)");
}

// Jog paradigm: plain jog steps EVERY bank 1:1 (no overlay); SHIFT (CC 49) +
// jog jumps section-to-section at NAV_SENS detents/step. Both clamp.
{
  const be = globalThis.bank_editor;
  const ctx = {
    state: {},
    getParam: () => "0", setParam: () => {},
    getValue: () => "3", setValue: () => {}   // bank 3 = Filter
  };
  be.onOpen(ctx);
  const midi = (cc, d2) => be.onMidi(ctx, { data: [0xB0, cc, d2] });
  eq(ctx.state.bank, 3, "opens on persisted bank");
  midi(14, 1);
  eq(ctx.state.bank, 4, "plain jog steps 1:1 (Filter -> Filter Mode)");
  midi(49, 127);                       // SHIFT down (CC 49, the real Move shift)
  eq(ctx.state.shift, true, "shift registers on CC 49");
  midi(14, 1);
  eq(ctx.state.bank, 4, "shift+jog: first detent doesn't step (NAV_SENS 2)");
  midi(14, 1);
  eq(ctx.state.bank, 5, "shift+jog: 2nd detent jumps to next SECTION (Filter Env)");
  midi(49, 0);                         // SHIFT up
  eq(ctx.state.shift, false, "shift releases");
  ctx.state.bank = T.BANKS.length - 1;
  midi(14, 1);
  eq(ctx.state.bank, T.BANKS.length - 1, "plain jog clamps at last bank");

  // On-device path: shift comes from the shadow_get_shift_held() SHM binding
  // (the shim never forwards CC 49 to shadow_ui in chain-edit), overriding
  // the CC-49 fallback state.
  globalThis.shadow_get_shift_held = () => 1;
  ctx.state.bank = 3;                  // Filter
  ctx.state.jogAccum = 0;
  midi(14, 1); midi(14, 1);
  eq(ctx.state.bank, 5, "SHM shift (no CC 49) drives section jump");
  delete globalThis.shadow_get_shift_held;
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
