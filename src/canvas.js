/* OB-Xd Bank Editor — on-device canvas overlay.
 * Loaded by the host as type:"canvas" param "editor" (canvas.js#bank_editor).
 * Sets globalThis.bank_editor = { onOpen, onMidi, draw }.
 * Jog turn (CC 14) cycles banks; knobs (CC 71-78) edit the active bank's params.
 * No host changes; all bank/param indication is on the 128x64 OLED (no LED API). */

/* ---- pure helpers (unit-tested off-device) ---- */

/* Relative-encoder sign: d2 1..63 = CW (+1), 65..127 = CCW (-1), else 0. */
function dirFromCC(d2) {
  if (d2 >= 1 && d2 <= 63) return 1;
  if (d2 >= 65 && d2 <= 127) return -1;
  return 0;
}

/* Clamp a bank index into [0, count-1]. */
function clampBank(idx, count) {
  if (idx < 0) return 0;
  if (idx > count - 1) return count - 1;
  return idx;
}

/* Encoder accumulator: count detents until |accum| reaches sens, then fire+reset.
 * A direction reversal discards the pending accumulation first (davebox feel). */
function accumStep(accum, dir, sens) {
  if ((accum > 0 && dir < 0) || (accum < 0 && dir > 0)) accum = 0;
  accum += dir;
  if (Math.abs(accum) >= sens) return { accum: 0, fire: true };
  return { accum: accum, fire: false };
}

/* ---- bank layout (all params; categories >8 split as "(n/N)") ---- */

/* knob factory helpers: native-int ranges, step 1, sens = detents per increment */
function c(key, abbrev)        { return { key, abbrev, min: 0,  max: 100, step: 1, sens: 2 }; } // continuous %
function t(key, abbrev)        { return { key, abbrev, min: 0,  max: 1,   step: 1, sens: 2 }; } // toggle
function r(key, abbrev, lo, hi){ return { key, abbrev, min: lo, max: hi,  step: 1, sens: 3 }; } // small range

const BANKS = [
  { label: "Osc 1", knobs: [
    t("osc1_saw","O1Sw"), t("osc1_pulse","O1Pl"), c("osc1_pitch","O1Pt"), c("osc1_mix","O1Mx") ] },
  { label: "Osc 2", knobs: [
    t("osc2_saw","O2Sw"), t("osc2_pulse","O2Pl"), c("osc2_pitch","O2Pt"), c("osc2_mix","O2Mx"),
    c("osc2_detune","O2Dt"), t("osc2_sync","Sync"), t("osc_quantize","Quan") ] },
  { label: "Osc Common", knobs: [
    c("pw","PW"), c("pw_env","PWEn"), t("pw_env_both","PWBo"), c("pw_ofs","PWOf"),
    c("noise","Nois"), c("xmod","XMod"), c("brightness","Brit") ] },
  { label: "Amp Env", knobs: [
    c("attack","Atk"), c("decay","Dec"), c("sustain","Sus"), c("release","Rel"), c("vel_amp","VAmp") ] },
  { label: "Filter (1/2)", knobs: [
    c("cutoff","Cut"), c("resonance","Res"), c("filter_env","FEnv"),
    c("key_follow","KeyF"), c("multimode","Mult") ] },
  { label: "Filter (2/2)", knobs: [
    t("bandpass","BP"), t("fourpole","4Pol"), t("self_osc","Self"), t("fenv_inv","FInv") ] },
  { label: "Filter Env", knobs: [
    c("f_attack","FAtk"), c("f_decay","FDec"), c("f_sustain","FSus"), c("f_release","FRel"),
    c("vel_filter","VFlt") ] },
  { label: "LFO", knobs: [
    c("lfo_rate","Rate"), c("lfo_amt1","Amt1"), c("lfo_amt2","Amt2"),
    t("lfo_sin","Sine"), t("lfo_square","Squr"), t("lfo_sh","S&H"), t("lfo_sync","Sync") ] },
  { label: "LFO Dest", knobs: [
    t("lfo_osc1",">Os1"), t("lfo_osc2",">Os2"), t("lfo_filter",">Flt"),
    t("lfo_pw1",">PW1"), t("lfo_pw2",">PW2") ] },
  { label: "Pitch Mod", knobs: [
    c("env_pitch","EPit"), t("env_pitch_both","EPBo"), t("bend_range","Bend"),
    t("bend_osc2","B>O2"), c("vibrato","Vib") ] },
  { label: "Global (1/2)", knobs: [
    c("volume","Vol"), c("tune","Tune"), r("octave","Oct",-2,2),
    r("octave_transpose","OctT",-3,3), c("portamento","Port") ] },
  { label: "Global (2/2)", knobs: [
    r("voice_count","Vcs",1,8), r("legato","Lgto",0,3), t("unison","Uni"),
    c("unison_det","UDet"), t("as_played","AsPl") ] },
  { label: "Voice Var (1/2)", knobs: [
    c("filter_var","FVar"), c("porta_var","PVar"), c("env_var","EVar"), c("level_var","LVar") ] },
  { label: "Voice Var (2/2)", knobs: [
    c("pan_1","Pan1"), c("pan_2","Pan2"), c("pan_3","Pan3"), c("pan_4","Pan4"),
    c("pan_5","Pan5"), c("pan_6","Pan6"), c("pan_7","Pan7"), c("pan_8","Pan8") ] }
];

globalThis.bank_editor = {
  _test: { dirFromCC: dirFromCC, clampBank: clampBank, accumStep: accumStep, BANKS: BANKS }
};
