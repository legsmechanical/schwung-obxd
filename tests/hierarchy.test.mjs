// The DECLARATION is the editor now.
//
// This is the converted form of canvas_banks.test.mjs. That test asserted the
// canvas BANKS covered every editable param exactly once, because the canvas was
// the editor; the bank editor is suppressed and the host draws its own knob grid
// from ui_hierarchy, so the same guarantee has to be made about the declaration
// instead. Deleting the old test with the canvas would have left this module —
// whose entire test surface was those two files — with no coverage of the thing
// that changed.
//
// It reads the hierarchy out of the C SOURCE rather than a built .so: the .so is
// aarch64 and cannot be run here, and module.json's copy of the hierarchy is
// DEAD for a sound_generator (chain_host takes a synth's ui_hierarchy straight
// from the plugin, with no module.json fallback). The source is what ships.
//
// Run: node tests/hierarchy.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cpp = readFileSync(join(root, "src", "dsp", "obxd_plugin.cpp"), "utf8");
const buildSh = readFileSync(join(root, "scripts", "build.sh"), "utf8");
const moduleJson = JSON.parse(readFileSync(join(root, "src", "module.json"), "utf8"));

/** A level's EDITABLE params. An entry carrying `level` is a navigation link to
 * another page, not a parameter, and counting those as params yields nulls. */
const editableOf = (lvl) => (lvl.params || [])
  .map((p) => (typeof p === "string" ? p : p.key))
  .filter((k) => typeof k === "string" && k);

let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error("FAIL " + m); } else console.log("ok   " + m); };

/* ---------------------------------------------------------------- helpers */

/** The C string pieces between two markers, joined and unescaped. */
function joinedLiteral(from, to) {
  const i = cpp.indexOf(from);
  /* Searched FROM i, not from 0: both of these end markers also occur earlier in
   * the file, in other functions, so a bare indexOf finds the wrong one and the
   * slice comes out empty or backwards. */
  const j = i < 0 ? -1 : cpp.indexOf(to, i + from.length);
  if (i < 0 || j < 0) throw new Error("markers not found: " + from);
  const lits = cpp.slice(i, j).match(/"(?:[^"\\]|\\.)*"/g) || [];
  return lits.map((l) => l.slice(1, -1)).join("")
             .replace(/\\"/g, '"').replace(/\\n/g, "");
}

/** First balanced {...} in a string. The literal is followed by format tails. */
function firstObject(s) {
  const start = s.indexOf("{");
  let depth = 0;
  for (let n = start; n < s.length; n++) {
    if (s[n] === "{") depth++;
    else if (s[n] === "}" && --depth === 0) return s.slice(start, n + 1);
  }
  throw new Error("unbalanced object");
}

const hierarchy = JSON.parse(firstObject(
  joinedLiteral('if (strcmp(key, "ui_hierarchy") == 0)',
                'if (strcmp(key, "chain_params") == 0)')));
const levels = hierarchy.levels || {};

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

/* ============================================================== 1 ==
 * THE CANVAS IS SUPPRESSED, in all four places it was declared.
 *
 * All four matter and they fail differently. A leftover chain_params entry puts
 * the bank editor back on the host's own grid; a leftover hierarchy link leaves
 * a row that opens nothing; a leftover host_canvas_ui makes dAVEBOx host the
 * canvas IN PREFERENCE to the grid (davebox reads it directly and loads
 * canvas.js itself, so the chain_params entry alone would not have freed the
 * screen); and packaging canvas.js ships a file nothing declares.
 */
{
  const chainParams = joinedLiteral('if (strcmp(key, "chain_params") == 0)',
                                    "/* Add all shadow params");
  ok(!/"type":"canvas"/.test(chainParams),
     "chain_params declares no canvas");
  ok(!/"canvas_script"/.test(chainParams),
     "and names no canvas script");

  const paramKeys = Object.values(levels).flatMap(editableOf);
  ok(!paramKeys.includes("editor"),
     "no level links an `editor` row");

  ok(moduleJson.capabilities === undefined
     || moduleJson.capabilities.host_canvas_ui === undefined,
     "module.json declares no host_canvas_ui — this is the one dAVEBOx reads");

  const packaging = buildSh.split("\n").filter(
    (l) => /canvas\.js/.test(l) && !/^\s*#/.test(l));
  ok(packaging.length === 0,
     "build.sh does not package canvas.js, got " + JSON.stringify(packaging));
}

/* ============================================================== 2 ==
 * EVERY EDITABLE PARAM IS REACHABLE, EXACTLY ONCE.
 *
 * The guarantee canvas_banks.test.mjs used to make about BANKS. A key in no
 * level cannot be edited at all; a key in two is two rows that write the same
 * parameter, which reads as a bug in the synth rather than in the menu.
 */
{
  const seen = Object.values(levels).flatMap(editableOf);

  const dupes = [...new Set(seen.filter((k, i) => seen.indexOf(k) !== i))];
  ok(dupes.length === 0, "no param is declared on two levels, got " + JSON.stringify(dupes));

  const missing = EXPECTED.filter((k) => !seen.includes(k));
  ok(missing.length === 0, "every editable param is reachable, missing " + JSON.stringify(missing));

  const extra = seen.filter((k) => !EXPECTED.includes(k));
  ok(extra.length === 0, "and nothing unexpected is, got " + JSON.stringify(extra));
}

/* ============================================================== 3 ==
 * THE KNOB ROWS ARE PLAYABLE.
 *
 * `knobs` maps to the eight physical encoders, so a ninth is a key that cannot
 * be reached from the page it is declared on, and a knob naming a param the
 * level does not carry is a cell that reads and writes somewhere else.
 */
{
  for (const [name, lvl] of Object.entries(levels)) {
    const knobs = lvl.knobs || [];
    if (!knobs.length) continue;
    ok(knobs.length <= 8, `${name}: ${knobs.length} knobs (max 8)`);

    /* ⚠ NOT "a param of its OWN level" — that is not the contract, and asserting
     * it failed on `root`. The landing page deliberately names eight knobs whose
     * parameters are declared on the detail levels (cutoff, the ADSR, ...), and
     * the planner places an authored knob wherever it is declared. What WOULD be
     * broken is a knob naming a key the module does not serve at all: a live
     * looking cell that reads and writes nothing. */
    const orphan = knobs.filter((k) => !EXPECTED.includes(k));
    ok(orphan.length === 0, `${name}: every knob names a real param, stray ` + JSON.stringify(orphan));
  }
}

/* ============================================================== 4 ==
 * THE ENVELOPE PAGES KEEP THE ORDER A GRAPHIC NEEDS.
 *
 * The host draws an ADSR when it finds attack/decay/sustain/release adjacent on
 * one row. Both envelope pages already declare them in that order and in the
 * canvas's order; reordering either would silently cost the picture, which is
 * exactly the kind of change nobody would connect to the diff that caused it.
 */
{
  const adsr = (name, keys) => {
    const knobs = (levels[name] || {}).knobs || [];
    ok(JSON.stringify(knobs.slice(0, 4)) === JSON.stringify(keys),
       `${name} opens with ${keys.join(", ")}, got ` + JSON.stringify(knobs.slice(0, 4)));
  };
  adsr("amp_env", ["attack", "decay", "sustain", "release"]);
  adsr("filt_env", ["f_attack", "f_decay", "f_sustain", "f_release"]);
}

console.log(failures === 0
  ? `\nALL HIERARCHY CHECKS PASSED (${Object.keys(levels).length} levels, ${EXPECTED.length} params)`
  : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
