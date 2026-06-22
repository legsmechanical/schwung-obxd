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

/* Abbreviations drop anything the bank heading already implies (the "Osc 1" bank
 * shows "Saw", not "O1Sw"); kept to <=4 chars to fit a cell. */
const BANKS = [
  { label: "Osc 1", knobs: [
    t("osc1_saw","Saw"), t("osc1_pulse","Puls"), c("osc1_pitch","Ptch"), c("osc1_mix","Mix") ] },
  { label: "Osc 2", knobs: [
    t("osc2_saw","Saw"), t("osc2_pulse","Puls"), c("osc2_pitch","Ptch"), c("osc2_mix","Mix"),
    c("osc2_detune","Detn"), t("osc2_sync","Sync"), t("osc_quantize","Quan") ] },
  { label: "Osc Common", knobs: [
    c("pw","PW"), c("pw_env","PWEn"), t("pw_env_both","Both"), c("pw_ofs","Ofs"),
    c("noise","Nois"), c("xmod","XMod"), c("brightness","Brit") ] },
  { label: "Amp Env", knobs: [
    c("attack","Atk"), c("decay","Dec"), c("sustain","Sus"), c("release","Rel"), c("vel_amp","Vel") ] },
  { label: "Filter (1/2)", knobs: [
    c("cutoff","Cut"), c("resonance","Res"), c("filter_env","Env"),
    c("key_follow","Key"), c("multimode","Mult") ] },
  { label: "Filter (2/2)", knobs: [
    t("bandpass","BP"), t("fourpole","4Pol"), t("self_osc","Self"), t("fenv_inv","Inv") ] },
  { label: "Filter Env", knobs: [
    c("f_attack","Atk"), c("f_decay","Dec"), c("f_sustain","Sus"), c("f_release","Rel"),
    c("vel_filter","Vel") ] },
  { label: "LFO", knobs: [
    c("lfo_rate","Rate"), c("lfo_amt1","Amt1"), c("lfo_amt2","Amt2"),
    t("lfo_sin","Sine"), t("lfo_square","Squr"), t("lfo_sh","S&H"), t("lfo_sync","Sync") ] },
  { label: "LFO Dest", knobs: [
    t("lfo_osc1","Osc1"), t("lfo_osc2","Osc2"), t("lfo_filter","Filt"),
    t("lfo_pw1","PW1"), t("lfo_pw2","PW2") ] },
  { label: "Pitch Mod", knobs: [
    c("env_pitch","Env"), t("env_pitch_both","Both"), t("bend_range","Bend"),
    t("bend_osc2",">Os2"), c("vibrato","Vib") ] },
  { label: "Global (1/2)", knobs: [
    c("volume","Vol"), c("tune","Tune"), r("octave","Oct",-2,2),
    r("octave_transpose","Trsp",-3,3), c("portamento","Port") ] },
  { label: "Global (2/2)", knobs: [
    r("voice_count","Vcs",1,8), r("legato","Lgto",0,3), t("unison","Uni"),
    c("unison_det","Detn"), t("as_played","Play") ] },
  { label: "Voice Var (1/2)", knobs: [
    c("filter_var","Filt"), c("porta_var","Prta"), c("env_var","Env"), c("level_var","Lvl") ] },
  { label: "Voice Var (2/2)", knobs: [
    c("pan_1","Pan1"), c("pan_2","Pan2"), c("pan_3","Pan3"), c("pan_4","Pan4"),
    c("pan_5","Pan5"), c("pan_6","Pan6"), c("pan_7","Pan7"), c("pan_8","Pan8") ] }
];

/* Bottom category tabs: one per logical group; split banks share a tab (Filter
 * 1/2+2/2 -> Fl, LFO+LFO Dest -> LF, etc.). BANK_CAT maps bank index -> tab index. */
var TABS = ["O1","O2","OC","Am","Fl","FE","LF","Pt","Gl","Vr"];
var BANK_CAT = [0, 1, 2, 3, 4, 4, 5, 6, 6, 7, 8, 8, 9, 9];

/* ---- drawing constants (2x4 cell grid + bottom tab bar) ---- */
var HDR_H = 9;                 // header band height (bank label)
var CELL_W = 30, CELL_H = 21;  // 4 cols x 30, 2 rows x 21 (shrunk for tab bar)
var COL_X0 = 4, ROW_Y0 = HDR_H + 1, ROW_GAP = 2;
var TAB_Y = 55;                // bottom tab bar top (rows end at 54)

function cellX(k) { return COL_X0 + (k % 4) * CELL_W; }
function cellY(k) { return k < 4 ? ROW_Y0 : ROW_Y0 + CELL_H + ROW_GAP; }

/* bottom category tabs: 10 even cells; active = inverted (filled + black text) */
function drawTabs(ctx, activeCat) {
  var n = TABS.length;
  for (var i = 0; i < n; i++) {
    var x0 = Math.round(i * ctx.width / n);
    var x1 = Math.round((i + 1) * ctx.width / n);
    if (i === activeCat) {
      ctx.fillRect(x0, TAB_Y, x1 - x0 - 1, 9, 1);
      ctx.print(x0 + 1, TAB_Y + 1, TABS[i], 0);
    } else {
      ctx.print(x0 + 1, TAB_Y + 1, TABS[i], 1);
    }
  }
}


function readState(ctx) {
  var s = ctx.state;
  if (!s.init) {
    s.init = true;
    var b = parseInt(ctx.getValue() || "0", 10);
    if (isNaN(b)) b = 0;
    s.bank = clampBank(b, BANKS.length);
    s.accum = [0,0,0,0,0,0,0,0];
    s.lastKnob = -1;
  }
  return s;
}

globalThis.bank_editor = {
  onOpen: function(ctx) {
    var s = ctx.state;
    s.init = false;        // force re-seed from the persisted param value
    readState(ctx);
  },

  onMidi: function(ctx, payload) {
    var d = payload && payload.data;
    if (!d || d.length < 3) return;
    var s = readState(ctx);
    var status = d[0] & 0xF0;

    // capacitive knob touch: notes 0-7 = knob 1-8 (on = vel>=64, release < 64).
    // Highlight the touched param's cell; clear on release.
    if (status === 0x90 || status === 0x80) {
      var note = d[1];
      if (note <= 7) s.lastKnob = (status === 0x90 && d[2] >= 64) ? note : -1;
      return;
    }

    if (status !== 0xB0) return;          // CC only below
    var cc = d[1], val = d[2];

    if (cc === 14) {                       // jog turn -> cycle bank
      var jd = dirFromCC(val);
      if (jd) {
        s.bank = clampBank(s.bank + jd, BANKS.length);
        s.lastKnob = -1;                   // clear stale highlight on bank switch
        ctx.setValue(String(s.bank));      // persist for re-open
      }
      return;
    }

    if (cc >= 71 && cc <= 78) {            // encoder -> edit param
      var k = cc - 71;
      var pm = BANKS[s.bank].knobs[k];
      if (!pm) return;                     // empty cell on this bank
      var dir = dirFromCC(val);
      if (!dir) return;
      s.lastKnob = k;
      var res = accumStep(s.accum[k], dir, pm.sens);
      s.accum[k] = res.accum;
      if (!res.fire) return;
      var cur = parseInt(ctx.getParam(pm.key) || "0", 10);
      if (isNaN(cur)) cur = 0;
      var nv = cur + dir * pm.step;
      if (nv < pm.min) nv = pm.min;
      if (nv > pm.max) nv = pm.max;
      if (nv !== cur) ctx.setParam(pm.key, String(nv));  // one write per onMidi (no race)
    }
  },

  draw: function(ctx) {
    var s = readState(ctx);
    var bank = BANKS[s.bank];

    // header: black text on a white bar
    ctx.fillRect(0, 0, ctx.width, HDR_H, 1);
    ctx.print(2, 1, bank.label.slice(0, 20), 0);

    // 8 params in a fixed 2x4 layout (no cell borders); touched cell inverts.
    for (var k = 0; k < 8; k++) {
      var pm = bank.knobs[k];
      if (!pm) continue;                 // empty slot: nothing drawn
      var x = cellX(k), y = cellY(k);
      var hi = (k === s.lastKnob);
      if (hi) ctx.fillRect(x, y, CELL_W - 2, CELL_H, 1);
      var fg = hi ? 0 : 1;
      ctx.print(x + 2, y + 2, pm.abbrev, fg);
      var raw = ctx.getParam(pm.key);
      var txt = (raw === null || raw === undefined || raw === "") ? "-" : String(raw);
      ctx.print(x + 2, y + 13, txt, fg);
    }

    ctx.fillRect(0, TAB_Y - 1, ctx.width, 1, 1);   // separator line above tabs
    drawTabs(ctx, BANK_CAT[s.bank]);                // bottom category-tab bar, active inverted
  },

  _test: { dirFromCC: dirFromCC, clampBank: clampBank, accumStep: accumStep, BANKS: BANKS }
};
