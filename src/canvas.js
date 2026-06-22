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

globalThis.bank_editor = {
  _test: { dirFromCC: dirFromCC, clampBank: clampBank, accumStep: accumStep }
};
