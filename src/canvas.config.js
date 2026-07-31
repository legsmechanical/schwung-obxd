/* OB-Xd canvas config for schwung-canvaskit (../../schwung-canvaskit).
 * This is the SOURCE for src/canvas.js — regenerate after editing:
 *   node ../schwung-canvaskit/build.mjs src/canvas.config.js src/canvas.js
 * Concatenated between the kit prelude (cell constructors in scope) and the
 * kit engine (which reads CONFIG) inside one IIFE. */

/* Native continuous params are 0..100 (the module's chain contract). */
KIT_PARAM_MAX = 100;
/* v30 stepped every PICK-class cell at 3 — enums via KIT_ENUM_SENS, oct() and
 * count() hardcoded. v39 folds all three into KIT_PICK_SENS, whose default is
 * 6, so regenerating without this would silently DOUBLE the travel on every
 * enum, octave and count knob. Pinned so the regeneration changes no feel;
 * re-tuning is a separate, deliberate call. (obxd's own
 * tests/canvas_helpers.test.mjs asserts the 3-detent step and catches this.) */
KIT_PICK_SENS = 3;

/* Legato mode order matches the engine (LEGATOMODE 0-3) and the remote UI.
 * Kept to 4 chars so values never get fitText-trimmed in a label cell. */
const kLegatoLabels = ["Rtrg", "Leg1", "Leg2", "Keep"];

const CONFIG = {
  name: "OB-Xd",

  /* All 69 editable params exactly once (test-asserted). Cell labels are
   * deliberate <=4-char abbreviations (a 32px label cell fits 4 glyphs of
   * the 6px-advance pixel font). */
  banks: [
    { label: "Osc 1", knobs: [tog("osc1_saw", "Saw"), tog("osc1_pulse", "Pls"), uni("osc1_pitch", "Ptch"), uni("osc1_mix", "Mix")] },
    { label: "Osc 2", knobs: [tog("osc2_saw", "Saw"), tog("osc2_pulse", "Pls"), uni("osc2_pitch", "Ptch"), uni("osc2_mix", "Mix"), uni("osc2_detune", "Detn"), tog("osc2_sync", "Sync"), tog("osc_quantize", "Quan")] },
    { label: "Osc Common", knobs: [uni("pw", "PW"), uni("pw_env", "PWEn"), tog("pw_env_both", "Both"), uni("pw_ofs", "POfs"), uni("noise", "Nois"), uni("xmod", "XMod"), uni("brightness", "Brit")] },
    { label: "Filter", knobs: [uni("cutoff", "Cut"), uni("resonance", "Res"), uni("filter_env", "Env"), uni("key_follow", "Key"), uni("multimode", "Mult")] },
    { label: "Filter Mode", knobs: [tog("bandpass", "BP"), tog("fourpole", "4Pol"), tog("self_osc", "Self"), tog("fenv_inv", "Inv")] },
    { label: "Filter Env", env: true, knobs: [fader("f_attack", "A"), fader("f_decay", "D"), fader("f_sustain", "S"), fader("f_release", "R"), fader("vel_filter", "Vel")] },
    { label: "Amp Env", env: true, knobs: [fader("attack", "A"), fader("decay", "D"), fader("sustain", "S"), fader("release", "R"), fader("vel_amp", "Vel")] },
    { label: "LFO", knobs: [uni("lfo_rate", "Rate"), uni("lfo_amt1", "Amt1"), uni("lfo_amt2", "Amt2"), tog("lfo_sin", "Sin"), tog("lfo_square", "Sqr"), tog("lfo_sh", "S/H"), tog("lfo_sync", "Sync")] },
    { label: "LFO Dest", knobs: [tog("lfo_osc1", "Osc1"), tog("lfo_osc2", "Osc2"), tog("lfo_filter", "Filt"), tog("lfo_pw1", "PW1"), tog("lfo_pw2", "PW2")] },
    { label: "Pitch Mod", knobs: [uni("env_pitch", "Env"), tog("env_pitch_both", "Both"), tog("bend_range", "Bend"), tog("bend_osc2", ">Os2"), uni("vibrato", "Vib")] },
    { label: "Voice", knobs: [tog("unison", "Uni"), uni("unison_det", "Detn"), uni("filter_var", "Filt"), uni("porta_var", "Prta"), uni("env_var", "Env"), uni("level_var", "Lvl"), uni("spread", "Sprd")] },
    { label: "Global", knobs: [uni("volume", "Vol"), bip("tune", "Tune"), oct("octave", "Oct", -2, 2), oct("octave_transpose", "Trsp", -3, 3), uni("portamento", "Port"), count("voice_count", "Vcs", 1, 8), enumc("legato", "Lgto", kLegatoLabels, ["RTG", "LG1", "LG2", "KEP"]), tog("as_played", "Play")] }
  ],

  /* SHIFT-picker rows. Plain jog steps every bank overlay-free, so the
   * picker stays coarse: a section owns every bank from its target up to
   * the next (FILTER covers Filter + Filter Mode, LFO covers LFO Dest). */
  sections: [
    { name: "OSC 1", bank: 0 },
    { name: "OSC 2", bank: 1 },
    { name: "OSC COMMON", bank: 2 },
    { name: "FILTER", bank: 3 },
    { name: "FILTER ENV", bank: 5 },
    { name: "AMP ENV", bank: 6 },
    { name: "LFO", bank: 7 },
    { name: "PITCH MOD", bank: 9 },
    { name: "VOICE", bank: 10 },
    { name: "GLOBAL", bank: 11 }
  ],

  /* Per-bank icons, shown on the picker rows. */
  icons: ["sawpulse", "sawpulse", "pulse", "lp", "lp", "envf", "enva", "sine", "routes", "bend", "random", "global"],

  /* Default native-int values (v2_init_default_patch, display units) — only
   * consumed off-device (previewer/tests); on device every read is live. */
  defaults: {
    volume: 100, tune: 50, portamento: 0, unison_det: 0,
    octave: 0, octave_transpose: 0, voice_count: 6, legato: 0, unison: 0, as_played: 0,
    osc1_saw: 1, osc1_pulse: 0, osc1_pitch: 0, osc1_mix: 50,
    osc2_saw: 1, osc2_pulse: 0, osc2_pitch: 0, osc2_mix: 50,
    osc2_detune: 10, osc2_sync: 0, osc_quantize: 0,
    pw: 0, pw_env: 0, pw_env_both: 0, pw_ofs: 0, noise: 0, xmod: 0, brightness: 100,
    cutoff: 70, resonance: 20, filter_env: 30, key_follow: 0, multimode: 0,
    bandpass: 0, fourpole: 1, self_osc: 0, fenv_inv: 0,
    f_attack: 1, f_decay: 30, f_sustain: 0, f_release: 20, vel_filter: 0,
    attack: 1, decay: 30, sustain: 70, release: 20, vel_amp: 0,
    lfo_rate: 30, lfo_amt1: 0, lfo_amt2: 0,
    lfo_sin: 1, lfo_square: 0, lfo_sh: 0, lfo_sync: 0,
    lfo_osc1: 0, lfo_osc2: 0, lfo_filter: 0, lfo_pw1: 0, lfo_pw2: 0,
    env_pitch: 0, env_pitch_both: 0, bend_range: 0, bend_osc2: 0, vibrato: 0,
    filter_var: 0, porta_var: 0, env_var: 0, level_var: 0,
    spread: 0
  },

  testExports: { kLegatoLabels }
};
