// Asserts BANKS covers every editable OB-Xd param exactly once.
// Run: node tests/canvas_banks.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "canvas.js"), "utf8");
(0, eval)(src);
const BANKS = globalThis.bank_editor._test.BANKS;

// The authoritative editable-param set = union of all ui_hierarchy level "params"
// in obxd_plugin.cpp (preset/bank_index are not knob params, excluded). 76 keys.
const EXPECTED = [
  "osc1_saw","osc1_pulse","osc1_pitch","osc1_mix",
  "osc2_saw","osc2_pulse","osc2_pitch","osc2_mix","osc2_detune","osc2_sync","osc_quantize",
  "pw","pw_env","pw_env_both","pw_ofs","noise","xmod","brightness",
  "attack","decay","sustain","release","vel_amp",
  "cutoff","resonance","filter_env","key_follow","multimode","bandpass","fourpole","self_osc","fenv_inv",
  "f_attack","f_decay","f_sustain","f_release","vel_filter",
  "lfo_rate","lfo_amt1","lfo_amt2","lfo_sin","lfo_square","lfo_sh","lfo_sync",
  "lfo_osc1","lfo_osc2","lfo_filter","lfo_pw1","lfo_pw2",
  "env_pitch","env_pitch_both","bend_range","bend_osc2","vibrato",
  "volume","tune","octave","octave_transpose","portamento",
  "voice_count","legato","unison","unison_det","as_played",
  "filter_var","porta_var","env_var","level_var",
  "pan_1","pan_2","pan_3","pan_4","pan_5","pan_6","pan_7","pan_8"
];

let failures = 0;
function fail(m) { failures++; console.error("FAIL " + m); }

// Each bank: <=8 knobs, each knob a {key,abbrev,min,max,step,sens}.
const seen = [];
for (const b of BANKS) {
  if (!b.label) fail("bank missing label");
  if (b.knobs.length > 8) fail(`bank ${b.label} has >8 knobs`);
  for (const k of b.knobs) {
    if (!k || typeof k.key !== "string") { fail(`bad knob in ${b.label}`); continue; }
    if (typeof k.min !== "number" || typeof k.max !== "number" ||
        typeof k.step !== "number" || typeof k.sens !== "number" ||
        typeof k.abbrev !== "string") fail(`knob ${k.key} missing fields`);
    seen.push(k.key);
  }
}

const seenSet = new Set(seen);
if (seen.length !== seenSet.size) fail("duplicate param across banks");
for (const key of EXPECTED) if (!seenSet.has(key)) fail(`missing param: ${key}`);
for (const key of seenSet) if (!EXPECTED.includes(key)) fail(`unexpected param: ${key}`);
if (seenSet.size !== EXPECTED.length) fail(`count ${seenSet.size} != ${EXPECTED.length}`);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log(`all ${EXPECTED.length} params covered exactly once across ${BANKS.length} banks`);
