/* ---- OB-Xd Bank Editor overlay ----
 * On-device canvas editor (loaded by the host as canvas.js#bank_editor),
 * rebuilt on the Echidna canvas chassis (schwung-echidna/src/canvas.js):
 * 5x5 pixel font, framed grid with per-kind cell rendering (bars /
 * center-detent bars / enums / faders), all-fader envelope banks, and a
 * SHIFT / jog-touch section-jump picker instead of the old bottom tab bar.
 * Jog turn (CC 14) cycles banks; knobs (CC 71-78) edit the active bank.
 * Wrapped in an IIFE to keep top-level declarations scoped to this overlay. */
(function () {

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

/* ---- mcufont: 5x5 monospace bitmap font (ported from the Echidna canvas,
 * itself from schwung-davebox assets/fonts/mcufont.h) ----
 * Rendered as flat 1-bit pixels via ctx.setPixel; draw() overrides
 * ctx.print/ctx.measureText to use these, so all layout code renders in this
 * font. Uppercase only (glyphs upcased); 5px glyph + 1px gap = 6px advance. */
var PF_GLYPH_W = 5, PF_GLYPH_H = 5, PF_ADVANCE = 6;
var PF_FONT = {
  "A": ["01110", "10001", "11111", "10001", "10001"],
  "B": ["11110", "10001", "11110", "10001", "11110"],
  "C": ["01111", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "11100", "10000", "11111"],
  "F": ["11111", "10000", "11100", "10000", "10000"],
  "G": ["01111", "10000", "10011", "10001", "01111"],
  "H": ["10001", "10001", "11111", "10001", "10001"],
  "I": ["11111", "00100", "00100", "00100", "11111"],
  "J": ["11111", "00010", "00010", "10010", "01100"],
  "K": ["10010", "10100", "11000", "10100", "10010"],
  "L": ["10000", "10000", "10000", "10000", "11111"],
  "M": ["11111", "10101", "10101", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001"],
  "O": ["01110", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "11110", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10010", "01101"],
  "R": ["11110", "10001", "11110", "10010", "10001"],
  "S": ["01111", "10000", "01110", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "01010", "01010", "00100"],
  "W": ["10001", "10001", "10101", "10101", "11011"],
  "X": ["10001", "01010", "00100", "01010", "10001"],
  "Y": ["10001", "01010", "00100", "00100", "00100"],
  "Z": ["11111", "00010", "00100", "01000", "11111"],
  "0": ["01110", "10001", "10101", "10001", "01110"],
  "1": ["01100", "10100", "00100", "00100", "11111"],
  "2": ["01110", "10001", "00110", "01000", "11111"],
  "3": ["11111", "00001", "01110", "00001", "11110"],
  "4": ["10010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "01110", "00001", "11110"],
  "6": ["01110", "10000", "11110", "10001", "01110"],
  "7": ["11111", "00010", "00100", "01000", "01000"],
  "8": ["01110", "10001", "01110", "10001", "01110"],
  "9": ["11111", "10001", "11111", "00001", "00001"],
  " ": ["00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "01110", "00000", "00000"],
  "+": ["00000", "00100", "01110", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "01000"],
  ":": ["00000", "01000", "00000", "01000", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000"],
  ">": ["10000", "01000", "00100", "01000", "10000"]
};

/* Width in px of `text` in the pixel-font (no trailing gap). */
function pfWidth(text) {
  return Math.max(0, String(text).length * PF_ADVANCE - 1);
}

/* Draw `text` at (x,y) top-left in `color` (0/1) by plotting each on-pixel via
 * ctx.setPixel — the ctx.print replacement. Uppercased; missing chars -> space. */
function pfPrint(ctx, x, y, text, color) {
  var s = String(text).toUpperCase();
  var v = color ? 1 : 0;
  var ox0 = Math.round(x), oy = Math.round(y);
  for (var i = 0; i < s.length; i++) {
    var rows = PF_FONT[s[i]] || PF_FONT[" "];
    var ox = ox0 + i * PF_ADVANCE;
    for (var r = 0; r < PF_GLYPH_H; r++) {
      var row = rows[r];
      for (var c = 0; c < PF_GLYPH_W; c++) {
        if (row[c] === "1") ctx.setPixel(ox + c, oy + r, v);
      }
    }
  }
}

/* ---- enum label tables ---- */

const kToggleLabels = ["Off", "On"];
/* Legato mode order matches the engine (LEGATOMODE 0-3) and the remote UI.
 * Kept to 4 chars so values never get fitText-trimmed in a 32px grid cell. */
const kLegatoLabels = ["Rtrg", "Leg1", "Leg2", "Keep"];

/* ---- default native-int values (v2_init_default_patch, display units) ----
 * Only consumed off-device (tools/render_canvas.mjs); on device every read
 * comes from the live engine. */
const DEFAULTS = {
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
  pan_1: 50, pan_2: 50, pan_3: 50, pan_4: 50,
  pan_5: 50, pan_6: 50, pan_7: 50, pan_8: 50
};

/* ---- cell descriptor constructors (native-int chain contract) ----
 * Enum cells step slower (sens 3) than continuous ones and CLAMP at their
 * ends rather than wrapping — an accidental extra detent shouldn't flip
 * On back to Off or jump Keep back to Rtrg. */
function uni(key, label) { return { key, label, kind: "unipolar", min: 0, max: 100, step: 1, sens: 2 }; }
function bip(key, label) { return { key, label, kind: "bipolar", min: 0, max: 100, step: 1, sens: 2, dflt: 50 }; }
function tog(key, label) { return { key, label, kind: "enum", min: 0, max: 1, step: 1, sens: 3, options: kToggleLabels }; }
function enumc(key, label, options) { return { key, label, kind: "enum", min: 0, max: options.length - 1, step: 1, sens: 3, options }; }
function oct(key, label, lo, hi) { return { key, label, kind: "octave", min: lo, max: hi, step: 1, sens: 3 }; }
function count(key, label, lo, hi) { return { key, label, kind: "count", min: lo, max: hi, step: 1, sens: 3 }; }
function fader(key, label) { return { key, label, kind: "fader", min: 0, max: 100, step: 1, sens: 2 }; }

/* ---- the bank set (all 76 editable params exactly once) ---- */

/* Cell labels are deliberate <=4-char abbreviations: a 32px grid cell's inner
 * width (27-28px) fits exactly 4 glyphs of the 6px-advance pixel font, so
 * anything longer would get fitText-trimmed mid-word ("PITC", "LEGA"). */
const BANKS = [
  { label: "Osc 1", knobs: [tog("osc1_saw", "Saw"), tog("osc1_pulse", "Pls"), uni("osc1_pitch", "Ptch"), uni("osc1_mix", "Mix")] },
  { label: "Osc 2", knobs: [tog("osc2_saw", "Saw"), tog("osc2_pulse", "Pls"), uni("osc2_pitch", "Ptch"), uni("osc2_mix", "Mix"), uni("osc2_detune", "Detn"), tog("osc2_sync", "Sync"), tog("osc_quantize", "Quan")] },
  { label: "Osc Common", knobs: [uni("pw", "PW"), uni("pw_env", "PWEn"), tog("pw_env_both", "Both"), uni("pw_ofs", "POfs"), uni("noise", "Nois"), uni("xmod", "XMod"), uni("brightness", "Brit")] },
  { label: "Filter", knobs: [uni("cutoff", "Cut"), uni("resonance", "Res"), uni("filter_env", "Env"), uni("key_follow", "Key"), uni("multimode", "Mult")] },
  { label: "Filter Mode", knobs: [tog("bandpass", "BP"), tog("fourpole", "4Pol"), tog("self_osc", "Self"), tog("fenv_inv", "Inv")] },
  { label: "Filter Env", knobs: [fader("f_attack", "A"), fader("f_decay", "D"), fader("f_sustain", "S"), fader("f_release", "R"), fader("vel_filter", "Vel")] },
  { label: "Amp Env", knobs: [fader("attack", "A"), fader("decay", "D"), fader("sustain", "S"), fader("release", "R"), fader("vel_amp", "Vel")] },
  { label: "LFO", knobs: [uni("lfo_rate", "Rate"), uni("lfo_amt1", "Amt1"), uni("lfo_amt2", "Amt2"), tog("lfo_sin", "Sin"), tog("lfo_square", "Sqr"), tog("lfo_sh", "S/H"), tog("lfo_sync", "Sync")] },
  { label: "LFO Dest", knobs: [tog("lfo_osc1", "Osc1"), tog("lfo_osc2", "Osc2"), tog("lfo_filter", "Filt"), tog("lfo_pw1", "PW1"), tog("lfo_pw2", "PW2")] },
  { label: "Pitch Mod", knobs: [uni("env_pitch", "Env"), tog("env_pitch_both", "Both"), tog("bend_range", "Bend"), tog("bend_osc2", ">Os2"), uni("vibrato", "Vib")] },
  { label: "Voice", knobs: [tog("unison", "Uni"), uni("unison_det", "Detn"), uni("filter_var", "Filt"), uni("porta_var", "Prta"), uni("env_var", "Env"), uni("level_var", "Lvl")] },
  { label: "Pan", knobs: [bip("pan_1", "V1"), bip("pan_2", "V2"), bip("pan_3", "V3"), bip("pan_4", "V4"), bip("pan_5", "V5"), bip("pan_6", "V6"), bip("pan_7", "V7"), bip("pan_8", "V8")] },
  { label: "Global", knobs: [uni("volume", "Vol"), bip("tune", "Tune"), oct("octave", "Oct", -2, 2), oct("octave_transpose", "Trsp", -3, 3), uni("portamento", "Port"), count("voice_count", "Vcs", 1, 8), enumc("legato", "Lgto", kLegatoLabels), tog("as_played", "Play")] }
];

/* Shift+jog jump targets — the section picker. A section "owns" every bank
 * from its target up to the next target (FILTER covers Filter + Filter Mode,
 * LFO covers LFO + LFO Dest). */
/* Detents per step while scrolling the SHIFT section picker (slower than
 * plain jog bank-stepping, which stays 1:1). */
const NAV_SENS = 2;

const JUMP_SECTIONS = [
  { name: "OSC 1", bank: 0 },
  { name: "OSC 2", bank: 1 },
  { name: "OSC COMMON", bank: 2 },
  { name: "FILTER", bank: 3 },
  { name: "FILTER ENV", bank: 5 },
  { name: "AMP ENV", bank: 6 },
  { name: "LFO", bank: 7 },
  { name: "PITCH MOD", bank: 9 },
  { name: "VOICE", bank: 10 },
  { name: "PAN", bank: 11 },
  { name: "GLOBAL", bank: 12 }
];
/* Which section the current bank falls under (the last target <= bankIdx). */
function activeSection(bankIdx) {
  let idx = 0;
  for (let i = 0; i < JUMP_SECTIONS.length; i++) if (JUMP_SECTIONS[i].bank <= bankIdx) idx = i;
  return idx;
}

/* ---- state / lifecycle ---- */

function readState(ctx) {
  const s = ctx.state;
  if (!s.init) {
    s.init = true;
    let v = parseInt(ctx.getValue() || "0", 10);
    if (isNaN(v)) v = 0;
    s.bank = clampBank(v, BANKS.length);
    s.accum = [0, 0, 0, 0, 0, 0, 0, 0];
    s.lastKnob = -1;
    s.shift = false;       // SHIFT button held (CC 15) -> section picker
    s.jogTouch = false;    // jog-wheel capacitive touch (note 9) -> same picker, no hold
    s.jogAccum = 0;        // shift+jog detent accumulator (slows the section picker)
  }
  return s;
}

/* ---- layout renderers (ported from the Echidna canvas; pure presentation:
 * given (ctx, bank, cells, state), paint the 128x64 frame) ---- */

const HDR_H = 9;
const CONTENT_BOT = 64;   // no bottom tab bar — content runs to the last row (63)

function getRaw(ctx, cell) {
  const fallback = cell.dflt != null ? cell.dflt : cell.min;
  const v = parseInt(ctx.getParam(cell.key) || String(fallback), 10);
  return isNaN(v) ? fallback : v;
}

/* Trim text from the end until it fits maxW px (measured in the live font). */
function fitText(ctx, text, maxW) {
  if (maxW <= 0) return "";
  let t = String(text);
  while (t.length > 0 && ctx.measureText(t) > maxW) t = t.slice(0, -1);
  return t;
}

/* Resolve {text, bar/centerBar/fader} for a cell. bar/fader are null unless
 * that cell's kind uses them (each is a 0..1 fill fraction); centerBar is a
 * -1..1 signed fraction for the center-detent kinds. */
function formatCell(ctx, cell) {
  const raw = getRaw(ctx, cell);
  if (cell.kind === "enum") {
    const idx = raw - cell.min;
    const name = cell.options[idx] || ("#" + raw);
    return { text: name, bar: null, fader: null };
  }
  if (cell.kind === "bipolar") {
    const signed = raw - 50;
    return { text: (signed > 0 ? "+" : "") + signed, bar: null, fader: null, centerBar: signed / 50 };
  }
  if (cell.kind === "octave") {
    return { text: (raw > 0 ? "+" : "") + raw, bar: null, fader: null };
  }
  if (cell.kind === "count") {
    return { text: String(raw), bar: null, fader: null };
  }
  const frac = Math.max(0, Math.min(1, (raw - cell.min) / (cell.max - cell.min)));
  if (cell.kind === "fader") return { text: String(raw), bar: null, fader: frac };
  return { text: String(raw), bar: frac, fader: null }; // unipolar
}

/* ---- header chrome + per-bank icons ---- */

/* Per-bank orientation icon, drawn at the right of the inverted header in
 * black. Small iconographic marks, each as wide as it needs to read. */
const BANK_ICONS = ["sawpulse", "sawpulse", "pulse", "lp", "lp", "envf", "enva", "sine", "routes", "bend", "random", "pan", "global"];
const ICON_W = { sawpulse: 12, pulse: 8, lp: 11, envf: 17, enva: 17, sine: 13, routes: 12, bend: 12, random: 11, pan: 13, global: 7 };

function plotLine(ctx, x1, y1, x2, y2, fg) {
  const dx = x2 - x1, dy = y2 - y1;
  const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    ctx.setPixel(Math.round(x1 + dx * t), Math.round(y1 + dy * t), fg);
  }
}

function drawBankIcon(ctx, x, y, icon) {
  const fg = 0; // black on the white header
  if (icon === "sawpulse") {
    // a saw tooth next to a pulse wave (Echidna's Oscillators glyph)
    plotLine(ctx, x, y + 6, x + 4, y, fg); plotLine(ctx, x + 4, y, x + 4, y + 6, fg);
    plotLine(ctx, x + 6, y + 6, x + 6, y, fg);
    ctx.fillRect(x + 6, y, 3, 1, fg);
    plotLine(ctx, x + 8, y, x + 8, y + 6, fg);
    ctx.fillRect(x + 8, y + 6, 3, 1, fg);
    plotLine(ctx, x + 10, y + 6, x + 10, y, fg);
  } else if (icon === "pulse") {
    // single pulse bracket (PW / osc-common)
    plotLine(ctx, x, y + 6, x, y, fg);
    ctx.fillRect(x, y, 4, 1, fg);
    plotLine(ctx, x + 3, y, x + 3, y + 6, fg);
    ctx.fillRect(x + 3, y + 6, 4, 1, fg);
    plotLine(ctx, x + 6, y + 6, x + 6, y, fg);
  } else if (icon === "lp") {
    ctx.fillRect(x, y + 1, 6, 1, fg); plotLine(ctx, x + 5, y + 1, x + 10, y + 6, fg);
  } else if (icon === "envf" || icon === "enva") {
    // Env banks: an A (Amp) or F (Filter) tag to the left of the ADSR shape.
    ctx.print(x - 2, y + 1, icon === "enva" ? "A" : "F", fg);
    const ex = x + 5;
    plotLine(ctx, ex, y + 6, ex + 2, y, fg); plotLine(ctx, ex + 2, y, ex + 5, y + 3, fg);
    ctx.fillRect(ex + 5, y + 3, 3, 1, fg); plotLine(ctx, ex + 8, y + 3, ex + 11, y + 6, fg);
  } else if (icon === "sine") {
    // continuous sine (LFO)
    let py = y + 3;
    for (let i = 1; i <= 12; i++) {
      const cy = y + 3 - Math.round(2.5 * Math.sin((i / 12) * Math.PI * 4));
      plotLine(ctx, x + i - 1, py, x + i, cy, fg);
      py = cy;
    }
  } else if (icon === "routes") {
    // filled right-pointing arrow (LFO destinations)
    ctx.fillRect(x, y + 2, 6, 3, fg);
    for (let c = 0; c <= 6; c++) {
      const hh = 3 - Math.floor(c / 2);
      ctx.fillRect(x + 5 + c, y + 3 - hh, 1, hh * 2 + 1, fg);
    }
  } else if (icon === "bend") {
    // pitch mod: a ramp bending up with an arrowhead
    plotLine(ctx, x, y + 6, x + 8, y + 1, fg);
    plotLine(ctx, x + 5, y, x + 8, y + 1, fg);
    plotLine(ctx, x + 8, y + 1, x + 7, y + 4, fg);
  } else if (icon === "random") {
    // scattered dots (per-voice variation / drift)
    const dots = [[0, 4], [1, 2], [3, 5], [4, 1], [6, 4], [7, 2], [9, 5], [10, 3]];
    for (const [dx, dy] of dots) ctx.setPixel(x + dx, y + dy, fg);
  } else if (icon === "pan") {
    // stereo pan: center bar with arrows pointing left + right
    ctx.fillRect(x + 6, y + 1, 1, 5, fg);
    plotLine(ctx, x + 4, y + 3, x + 1, y + 3, fg);
    ctx.setPixel(x + 2, y + 2, fg); ctx.setPixel(x + 2, y + 4, fg);
    plotLine(ctx, x + 8, y + 3, x + 11, y + 3, fg);
    ctx.setPixel(x + 10, y + 2, fg); ctx.setPixel(x + 10, y + 4, fg);
  } else if (icon === "global") {
    ctx.fillRect(x + 2, y + 2, 3, 3, fg);
    ctx.setPixel(x + 3, y, fg); ctx.setPixel(x + 3, y + 6, fg); ctx.setPixel(x, y + 3, fg); ctx.setPixel(x + 6, y + 3, fg);
    ctx.setPixel(x + 1, y + 1, fg); ctx.setPixel(x + 5, y + 1, fg); ctx.setPixel(x + 1, y + 5, fg); ctx.setPixel(x + 5, y + 5, fg);
  }
}

function drawChrome(ctx, headerLabel, s) {
  ctx.fillRect(0, 0, ctx.width, HDR_H, 1);
  const icon = BANK_ICONS[s.bank];
  const iw = icon ? ICON_W[icon] : 0;
  ctx.print(2, 1, fitText(ctx, headerLabel, ctx.width - 4 - (iw ? iw + 3 : 0)), 0);
  if (icon) drawBankIcon(ctx, ctx.width - iw - 2, 1, icon);
}

/* Section-jump navigator — the transient overlay shown WHILE SHIFT is held
 * (or a finger rests on the jog wheel). Shift+jog moves the highlight
 * section-to-section; releasing shift leaves you in that section. Drawn on
 * top of whatever layout is underneath. */
function drawSectionNav(ctx, s) {
  if (!s.shift && !s.jogTouch) return;
  const items = JUMP_SECTIONS;
  const active = activeSection(s.bank);
  const x = 4, y = 2, w = ctx.width - 8, h = ctx.height - 4;
  ctx.fillRect(x, y, w, h, 0);   // clear the screen beneath
  ctx.drawRect(x, y, w, h, 1);   // popup frame
  const rowH = 8, listY = y + 3, visible = 7;
  // Scroll so the active row stays in view (centered where possible).
  let top = active - Math.floor(visible / 2);
  top = Math.max(0, Math.min(Math.max(0, items.length - visible), top));
  for (let r = 0; r < visible; r++) {
    const i = top + r;
    if (i >= items.length) break;
    const ry = listY + r * rowH;
    const sel = i === active;
    if (sel) ctx.fillRect(x + 2, ry - 1, w - 6, rowH, 1);
    ctx.print(x + 4, ry, items[i].name, sel ? 0 : 1);
  }
  // Right-edge scrollbar: track + a thumb sized/positioned to the window.
  const trackY = listY - 1, trackH = visible * rowH;
  const thumbH = Math.max(4, Math.round(trackH * visible / items.length));
  const denom = Math.max(1, items.length - visible);
  const thumbY = trackY + Math.round((trackH - thumbH) * top / denom);
  ctx.fillRect(x + w - 2, trackY, 1, trackH, 1);
  ctx.fillRect(x + w - 3, thumbY, 2, thumbH, 1);
}

/* Small vertical slider: end-stop ticks top/bottom + a bottom-up proportional
 * fill — used by the Filter/Amp Env fader banks. */
function drawFader(ctx, x, y, h, frac, fg, w) {
  w = w || 2;
  ctx.fillRect(x, y, w, 1, fg);
  ctx.fillRect(x, y + h - 1, w, 1, fg);
  const fillH = Math.round((h - 2) * frac);
  if (fillH > 0) ctx.fillRect(x, y + (h - 1 - fillH), w, fillH, fg);
}

/* Value bar under a cell. Unipolar -> left-anchored proportional fill.
 * Bipolar (center-detent kinds) -> a center-OUT fill: a permanent 1px center
 * tick, the bar growing rightward for + and leftward for -, so "how far and
 * which way from neutral" reads at a glance. Returns true if it drew. */
function drawValueBar(ctx, x, y, w, th, fmt, fg) {
  const bg = fg === 1 ? 0 : 1;
  if (fmt.centerBar != null) {
    ctx.fillRect(x, y, w, th, bg); // clear track
    const half = Math.floor(w / 2), cx = x + half;
    const sgn = Math.max(-1, Math.min(1, fmt.centerBar));
    const mag = Math.round(half * Math.abs(sgn));
    if (sgn >= 0) { if (mag > 0) ctx.fillRect(cx, y, mag, th, fg); }
    else if (mag > 0) ctx.fillRect(cx - mag, y, mag, th, fg);
    ctx.fillRect(cx, y, 1, th, fg); // center detent tick, always visible
    return true;
  }
  if (fmt.bar != null) {
    ctx.fillRect(x, y, w, th, bg); // clear track
    const fillW = Math.round(w * fmt.bar);
    if (fillW > 0) ctx.fillRect(x, y, fillW, th, fg);
    return true;
  }
  return false;
}

/* A label+value(+bar/fader) box at (x,y,w,h). Used by the grid cells and the
 * single-row layout's full-height cells. */
function drawCellBox(ctx, x, y, w, h, label, fmt, highlighted) {
  if (highlighted) ctx.fillRect(x, y, w, h, 1);
  const fg = highlighted ? 0 : 1;
  const innerW = w - 4;
  if (fmt.fader !== null && h >= 18) {
    // The slider IS the readout here — no digital number, like a real fader.
    ctx.print(x + 2, y + 1, fitText(ctx, label, innerW), fg);
    drawFader(ctx, x + Math.round(w / 2) - 1, y + 8, h - 9, fmt.fader, fg);
    return;
  }
  if (h < 18) {
    // short cell: label only (no room for a stacked value/bar)
    ctx.print(x + 2, y + 1, fitText(ctx, label, innerW), fg);
    return;
  }
  // Vertically center the label -> value (-> bar) block in the cell. Center by
  // the SAME block height whether or not the cell has a bar, so label/value
  // rows align across mixed cells in a row (enum cells next to bar cells).
  const hasBar = fmt.bar != null || fmt.centerBar != null;
  const blockH = 20;
  const ly = y + Math.max(1, Math.floor((h - blockH) / 2));
  ctx.print(x + 2, ly, fitText(ctx, label, innerW), fg);
  ctx.print(x + 2, ly + 8, fitText(ctx, fmt.text, innerW), fg);
  if (hasBar) drawValueBar(ctx, x + 2, ly + 18, innerW, 2, fmt, fg);
}

/* ---- "all faders" bank special-case (Filter/Amp Env): one row of labels,
 * one row of sliders beneath using ALL remaining vertical space. ---- */
function drawEnvGrid(ctx, cells, s) {
  const n = cells.length;
  const top = HDR_H + 1, bottom = CONTENT_BOT - 1;
  const colW = Math.floor(124 / n);
  const FW = 6;   // fader bar width
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (!cell) continue;
    const x = 2 + i * colW;
    const hi = i === s.lastKnob;
    // highlight only the LABEL (not the whole column) so which knob's active
    // reads without the big invert-block hiding the bar.
    const lab = fitText(ctx, cell.label, colW - 4);
    if (hi) ctx.fillRect(x + 1, top, ctx.measureText(lab) + 2, 8, 1);
    ctx.print(x + 2, top + 1, lab, hi ? 0 : 1);
    const raw = getRaw(ctx, cell);
    const sliderY = top + 8, sliderH = bottom - sliderY - 1;
    const sx = x + Math.round(colW / 2) - Math.floor(FW / 2);
    const frac = Math.max(0, Math.min(1, (raw - cell.min) / (cell.max - cell.min)));
    drawFader(ctx, sx, sliderY, sliderH, frac, 1, FW);
  }
}

/* Sparse-bank layout: a bank with only 2-4 params reads as unfinished in the
 * 2x4 grid (empty boxes), so it gets a single ROW of N equal, full-height
 * cells instead. */
function drawRowGrid(ctx, cells, s) {
  const n = cells.length;
  const gLeft = 0, gRight = 128, gTop = HDR_H, gBot = CONTENT_BOT - 1;
  ctx.drawRect(gLeft, gTop, gRight - gLeft, gBot - gTop, 1);
  const colW = Math.floor((gRight - gLeft) / n);
  for (let i = 1; i < n; i++) ctx.fillRect(gLeft + i * colW, gTop, 1, gBot - gTop, 1);
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    if (!cell) continue;
    const lx = gLeft + i * colW;
    const rx = i === n - 1 ? gRight - 1 : gLeft + (i + 1) * colW;
    drawCellBox(ctx, lx + 1, gTop + 1, rx - lx - 1, gBot - gTop - 2, cell.label, formatCell(ctx, cell), i === s.lastKnob);
  }
}

/* ---- the main layout: framed 2x4 grid with dividers ---- */
function drawGrid(ctx, bank, cells, s) {
  drawChrome(ctx, bank.label, s);
  if (cells.length && cells.every((c) => c && c.kind === "fader")) return drawEnvGrid(ctx, cells, s);
  if (cells.length <= 4) return drawRowGrid(ctx, cells, s);
  const CELL_W = 32, COL_X0 = 0, ROW_Y0 = HDR_H + 1, ROW_GAP = 2;
  const CELL_H = Math.floor(((CONTENT_BOT - 1) - ROW_Y0 + 1 - ROW_GAP) / 2);

  // Grid lines framing the 2x4 cell grid: an outer border, 3 vertical column
  // dividers, and the horizontal divider between the two rows.
  const gLeft = 0, gRight = 128, gTop = ROW_Y0 - 1;
  const rowDivY = ROW_Y0 + CELL_H;
  const gBot = ROW_Y0 + 2 * CELL_H + ROW_GAP;
  ctx.drawRect(gLeft, gTop, gRight - gLeft, gBot - gTop, 1);
  for (let c = 1; c < 4; c++) {
    ctx.fillRect(COL_X0 + c * CELL_W - 1, gTop, 1, gBot - gTop, 1);
  }
  ctx.fillRect(gLeft, rowDivY, gRight - gLeft, 1, 1);

  // Each cell fills its framed column/row with a uniform 1px inset from every
  // divider and border, so the touched-cell highlight sits evenly inside.
  const colL = (c) => (c === 0 ? gLeft : COL_X0 + c * CELL_W - 1);
  const colR = (c) => (c === 3 ? gRight - 1 : COL_X0 + (c + 1) * CELL_W - 1);
  for (let k = 0; k < 8; k++) {
    const cell = cells[k];
    if (!cell) continue;
    const col = k % 4, row = k < 4 ? 0 : 1;
    const lx = colL(col), rx = colR(col);
    const ty = row === 0 ? gTop : rowDivY, by = row === 0 ? rowDivY : gBot - 1;
    drawCellBox(ctx, lx + 1, ty + 1, rx - lx - 1, by - ty - 1, cell.label, formatCell(ctx, cell), k === s.lastKnob);
  }
}

/* ---- the overlay object ---- */

const bank_editor = {
  onOpen(ctx) {
    ctx.state.init = false; // force re-seed from the persisted value
    readState(ctx);
  },

  onMidi(ctx, payload) {
    const d = payload && payload.data;
    if (!d || d.length < 3) return;
    const s = readState(ctx);
    const status = d[0] & 0xF0;

    if (status === 0x90 || status === 0x80) { // capacitive touch: notes 0-7 knobs, 9 jog
      const note = d[1];
      if (note <= 7) s.lastKnob = (status === 0x90 && d[2] >= 64) ? note : -1;
      // Jog-wheel touch (MoveMainTouch = 9): rest a finger on the jog to see
      // the section-nav overlay (same picker as SHIFT, no hold needed).
      if (note === 9) s.jogTouch = (status === 0x90 && d[2] >= 64);
      return;
    }
    if (status !== 0xB0) return;
    const cc = d[1], val = d[2];

    if (cc === 15) { s.shift = val >= 64; s.jogAccum = 0; return; } // SHIFT hold: gates section-jump + the nav popup

    if (cc === 14) { // jog turn
      const jd = dirFromCC(val);
      if (jd) {
        if (s.shift) {
          // Shift+jog: step through the section picker, landing on that
          // section's first bank. Accumulated (NAV_SENS detents per step)
          // so scrolling the list is slower than plain bank stepping.
          const nr = accumStep(s.jogAccum, jd, NAV_SENS);
          s.jogAccum = nr.accum;
          if (!nr.fire) return;
          const ni = clampBank(activeSection(s.bank) + jd, JUMP_SECTIONS.length);
          s.bank = JUMP_SECTIONS[ni].bank;
        } else {
          s.bank = clampBank(s.bank + jd, BANKS.length);
        }
        ctx.setValue(String(s.bank));  // persist for re-open
        s.lastKnob = -1;
      }
      return;
    }

    if (cc < 71 || cc > 78) return;
    const k = cc - 71;
    const dir = dirFromCC(val);
    if (!dir) return;
    const cell = BANKS[s.bank].knobs[k];
    if (!cell) return;                  // empty slot on this bank
    s.lastKnob = k;

    // All kinds (incl. enum) step-and-CLAMP; accumulate cell.sens detents
    // per step (knob feel + fewer blocking writes).
    const cr = accumStep(s.accum[k], dir, cell.sens || 2);
    s.accum[k] = cr.accum;
    if (!cr.fire) return;
    const cur = parseInt(ctx.getParam(cell.key) || String(cell.dflt != null ? cell.dflt : 0), 10);
    let nv = (isNaN(cur) ? (cell.dflt != null ? cell.dflt : cell.min) : cur) + dir * cell.step;
    if (nv < cell.min) nv = cell.min;
    if (nv > cell.max) nv = cell.max;
    if (nv !== cur) ctx.setParam(cell.key, String(nv));
  },

  draw(ctx) {
    // One-time per-ctx install (guarded; draw runs every frame).
    if (!ctx._pfInstalled) {
      // (1) Text via the 5x5 pixel-font (the host's native OLED font has
      // different glyphs/metrics). Override print + measureText -> the layout
      // code routes every string through these.
      ctx.print = function (x, y, text, color) { pfPrint(ctx, x, y, text, color ? 1 : 0); };
      ctx.measureText = function (str) { return pfWidth(str); };
      // (2) getParam cache. On device each ctx.getParam is a ~2.6ms blocking
      // SHM round-trip, and the layout reads one per cell EVERY frame. Cache
      // reads; write-through on setParam so knob turns reflect instantly; and
      // full-refresh a couple times/sec to catch external changes (preset load).
      var rawGet = ctx.getParam, rawSet = ctx.setParam;
      ctx._pcache = {};
      ctx.getParam = function (k) {
        if (Object.prototype.hasOwnProperty.call(ctx._pcache, k)) return ctx._pcache[k];
        var v = rawGet.call(ctx, k);
        ctx._pcache[k] = v;
        return v;
      };
      ctx.setParam = function (k, v) {
        var r = rawSet.call(ctx, k, v);
        ctx._pcache[k] = String(v);   // reflect the write now
        return r;
      };
      ctx._cacheTick = 0;
      ctx._pfInstalled = true;
    }
    // Periodic full refresh (~2x/sec) so external param changes surface.
    if ((ctx._cacheTick = (ctx._cacheTick + 1) % 24) === 0) ctx._pcache = {};

    const s = readState(ctx);
    const bank = BANKS[s.bank];
    drawGrid(ctx, bank, bank.knobs, s);
    drawSectionNav(ctx, s);
  },

  _test: {
    BANKS, JUMP_SECTIONS, activeSection, NAV_SENS,
    dirFromCC, clampBank, accumStep,
    formatCell, DEFAULTS, kToggleLabels, kLegatoLabels,
    drawBankIcon, BANK_ICONS, ICON_W
  }
};

globalThis.bank_editor = bank_editor;
})();
