// Asserts BANKS covers every editable OB-Xd param exactly once, cells are
// well-formed, and JUMP_SECTIONS targets are sane.
// Run: node tests/canvas_banks.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "canvas.js"), "utf8");
(0, eval)(src);
const T = globalThis.bank_editor._test;
const BANKS = T.BANKS;

// The authoritative editable-param set = union of all ui_hierarchy level "params"
// in obxd_plugin.cpp (preset/bank_index are not knob params, excluded). 69 keys.
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
  "filter_var","porta_var","env_var","level_var","spread"
];

const KINDS = new Set(["unipolar", "bipolar", "enum", "octave", "count", "fader"]);

let failures = 0;
function fail(m) { failures++; console.error("FAIL " + m); }

// Each bank: <=8 cells, each a well-formed descriptor.
const seen = [];
for (const b of BANKS) {
  if (!b.label) fail("bank missing label");
  if (b.knobs.length > 8) fail(`bank ${b.label} has >8 cells`);
  for (const c of b.knobs) {
    if (!c || typeof c.key !== "string") { fail(`bad cell in ${b.label}`); continue; }
    if (typeof c.label !== "string" || !c.label) fail(`cell ${c.key} missing label`);
    if (!KINDS.has(c.kind)) fail(`cell ${c.key} bad kind ${c.kind}`);
    if (typeof c.min !== "number" || typeof c.max !== "number" || c.min >= c.max)
      fail(`cell ${c.key} bad range`);
    if (c.kind === "enum") {
      if (!Array.isArray(c.options) || c.options.length !== c.max - c.min + 1)
        fail(`enum ${c.key} options/range mismatch`);
    } else if (typeof c.step !== "number" || typeof c.sens !== "number") {
      fail(`cell ${c.key} missing step/sens`);
    }
    seen.push(c.key);
  }
}

const seenSet = new Set(seen);
if (seen.length !== seenSet.size) fail("duplicate param across banks");
for (const key of EXPECTED) if (!seenSet.has(key)) fail(`missing param: ${key}`);
for (const key of seenSet) if (!EXPECTED.includes(key)) fail(`unexpected param: ${key}`);
if (seenSet.size !== EXPECTED.length) fail(`count ${seenSet.size} != ${EXPECTED.length}`);

// Env banks must be all-fader (they render as the full-height fader layout).
for (const label of ["Filter Env", "Amp Env"]) {
  const b = BANKS.find((x) => x.label === label);
  if (!b) { fail(`missing bank ${label}`); continue; }
  if (!b.knobs.every((c) => c.kind === "fader")) fail(`${label} not all-fader`);
}

// JUMP_SECTIONS: strictly ascending bank targets, all in range, first at 0;
// names must fit the picker overlay's usable row width.
{
  const secs = T.JUMP_SECTIONS;
  if (secs[0].bank !== 0) fail("JUMP_SECTIONS must start at bank 0");
  for (let i = 0; i < secs.length; i++) {
    const t = secs[i].bank;
    if (t < 0 || t >= BANKS.length) fail(`section ${secs[i].name} target out of range`);
    if (i > 0 && t <= secs[i - 1].bank) fail(`section ${secs[i].name} not ascending`);
    if (!secs[i].name) fail(`section ${i} missing name`);
    if (secs[i].name.length * 6 - 1 > 108) fail(`section name too wide for picker: ${secs[i].name}`);
  }
}

// Every bank has an icon with a registered width.
for (let i = 0; i < BANKS.length; i++) {
  const icon = T.BANK_ICONS[i];
  if (!icon) fail(`bank ${BANKS[i].label} missing icon`);
  else if (typeof T.ICON_W[icon] !== "number") fail(`icon ${icon} missing ICON_W`);
}
if (T.BANK_ICONS.length !== BANKS.length) fail("BANK_ICONS length != BANKS length");

// DEFAULTS covers exactly the editable-param set (the previewer's data source).
for (const key of EXPECTED) if (!(key in T.DEFAULTS)) fail(`DEFAULTS missing ${key}`);
for (const key of Object.keys(T.DEFAULTS)) if (!EXPECTED.includes(key)) fail(`DEFAULTS unexpected ${key}`);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log(`all ${EXPECTED.length} params covered exactly once across ${BANKS.length} banks`);
