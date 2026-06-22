# OB-Xd Bank Editor (canvas) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dAVEBOx-style on-device "Bank Editor" to OB-Xd — a fullscreen screen where the jog wheel flips between banks of 8 params and the 8 encoders edit the current bank live — using the host's `type:"canvas"` hook, with no host changes.

**Architecture:** A new module-side `src/canvas.js` registers `globalThis.bank_editor`, an overlay object the host loads when the user opens a `type:"canvas"` chain-param named `editor`. The overlay owns the 128×64 framebuffer, reads jog/encoder MIDI via its `onMidi` hook, and reads/writes any OB-Xd param via the canvas runtime `ctx`. A small additive C change in `obxd_plugin.cpp` declares the `editor` canvas param, surfaces it in the root menu, and round-trips an int so the active bank persists across re-opens. `build.sh` ships `canvas.js`.

**Tech Stack:** QuickJS (on-device JS runtime; pure helpers tested off-device with node), C++ (OB-Xd plugin), bash build/deploy, Docker cross-compile to aarch64.

---

## Background: the host canvas contract (verified, read-only)

These facts are confirmed against `schwung/src/shadow/shadow_ui.js` and must be honored exactly:

- **Registration:** chain-param meta `"canvas_script":"canvas.js#bank_editor"` → host loads `<module-dir>/canvas.js` then looks up the overlay at `globalThis.bank_editor` (`resolveOverlayFromGlobals` checks `globalThis[overlayRef]` first). So `canvas.js` MUST set `globalThis.bank_editor = { ... }`.
- **Hooks** are called as `fn(ctx, payload)`:
  - `onOpen(ctx, {param_key, module_id, script_path, overlay_ref})` — once on entry.
  - `onMidi(ctx, {source, data})` — `data` is the raw `[status, d1, d2]` array; `source` is `"internal"` for Move hardware.
  - `tick(ctx, {})` — ~44 Hz (optional; omitted in v1).
  - `draw(ctx, {})` — host calls `clear_screen()` first, then `draw`. If `draw` exists the host skips its fallback message. Redraw is throttled to ~15 Hz; `onMidi` sets `needsRedraw` so edits repaint promptly.
  - `onClose(ctx, {cancelled})` — on exit (optional; omitted in v1).
- **Runtime `ctx` API** (the complete surface): `ctx.width` (128), `ctx.height` (64), `ctx.state` (object, persists during one open, reset on close), `ctx.clear()`, `ctx.setPixel(x,y,v)`, `ctx.drawRect(x,y,w,h,v)`, `ctx.fillRect(x,y,w,h,v)`, `ctx.drawLine(x1,y1,x2,y2,v)`, `ctx.print(x,y,text,color=1)`, `ctx.now()`, `ctx.random()`, `ctx.getValue()` / `ctx.setValue(v)` (the `editor` param's own value, as strings), `ctx.getParam(key)` (returns string or null), `ctx.setParam(key, value)` (coerced to string; returns bool), `ctx.sourcePath()`. There is **no LED API** and no `fill_circle`/`text_width`.
- **Stolen input:** in canvas view the host consumes only CC 3 (jog click → close) and CC 51 (Back → close). Jog turn (CC 14), knobs (CC 71–78), pads, steps, shift (CC 49) all reach `onMidi`.
- **Relative encoder encoding:** `d2` in 1–63 = clockwise (+1), 65–127 = counter-clockwise (−1), 0/64 = no-op. Same for jog (CC 14) and knobs (CC 71–78).
- **Param model:** OB-Xd advertises every param as native int. Continuous → 0..100, toggles → 0..1, `voice_count` → 1..8, `octave` → −2..2, `legato` → 0..3, `octave_transpose` → −3..3, pans → 0..100. `ctx.getParam`/`setParam` speak these native ints as decimal strings.

## File structure

- **Create** `schwung-obxd/src/canvas.js` — the entire Bank Editor overlay: pure helpers, the `BANKS` table, and `globalThis.bank_editor` with `onOpen`/`onMidi`/`draw`. Single focused file.
- **Create** `schwung-obxd/tests/canvas_helpers.test.mjs` — node test for the pure helpers.
- **Create** `schwung-obxd/tests/canvas_banks.test.mjs` — node test asserting the `BANKS` table covers every editable param exactly once.
- **Modify** `schwung-obxd/src/dsp/obxd_plugin.cpp` — add `editor_bank` field, init it, handle `get/set_param("editor")`, add the `editor` canvas entry to `chain_params`, and surface "Bank Editor" in the root `ui_hierarchy`.
- **Modify** `schwung-obxd/scripts/build.sh` — copy `src/canvas.js` into `dist/obxd/`.

> Note on testing: this repo deliberately has **no persistent test harness** (the DSP harness was removed 2026-06-21 as low-ROI). The two `tests/*.mjs` files here are lightweight one-shot node checks for the trickiest pure logic — run on demand, not wired into CI. The real verification is on-device (Task 6).

---

### Task 1: Pure helpers (`dirFromCC`, `clampBank`, `accumStep`)

These three pure functions carry all the fiddly logic; isolate and test them first.

**Files:**
- Create: `schwung-obxd/src/canvas.js`
- Test: `schwung-obxd/tests/canvas_helpers.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `schwung-obxd/tests/canvas_helpers.test.mjs`:

```js
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

// clampBank: wraps within [0, n)
eq(T.clampBank(0, 14), 0, "clampBank low");
eq(T.clampBank(13, 14), 13, "clampBank high");
eq(T.clampBank(-1, 14), 0, "clampBank below clamps to 0");
eq(T.clampBank(14, 14), 13, "clampBank above clamps to last");

// accumStep: returns {accum, fire}. Fires (and resets) when |accum| reaches sens;
// a direction reversal resets the accumulator first.
eq(T.accumStep(0, 1, 2), { accum: 1, fire: false }, "accum first tick no fire");
eq(T.accumStep(1, 1, 2), { accum: 0, fire: true }, "accum second tick fires+resets");
eq(T.accumStep(1, -1, 2), { accum: -1, fire: false }, "accum reversal resets then counts");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall helper tests passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "schwung-obxd" && node tests/canvas_helpers.test.mjs`
Expected: FAIL — `ENOENT` opening `src/canvas.js` (it doesn't exist yet), or a TypeError reading `_test`.

- [ ] **Step 3: Write minimal implementation**

Create `schwung-obxd/src/canvas.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "schwung-obxd" && node tests/canvas_helpers.test.mjs`
Expected: PASS — all `ok` lines, ending `all helper tests passed`.

- [ ] **Step 5: Commit**

```bash
cd "schwung-obxd"
git add src/canvas.js tests/canvas_helpers.test.mjs
git commit -m "feat(obxd): bank editor canvas pure helpers + tests"
```

---

### Task 2: The `BANKS` table (every param, split with `(n/N)`)

**Files:**
- Modify: `schwung-obxd/src/canvas.js`
- Test: `schwung-obxd/tests/canvas_banks.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `schwung-obxd/tests/canvas_banks.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "schwung-obxd" && node tests/canvas_banks.test.mjs`
Expected: FAIL — `BANKS` is undefined (TypeError on `BANKS` iteration).

- [ ] **Step 3: Write minimal implementation**

In `src/canvas.js`, add the `BANKS` table above the `globalThis.bank_editor` assignment. Helper shorthands keep it readable: `c`=continuous(0..100), `t`=toggle(0..1), `r`=small ranged.

```js
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
```

Then extend the `_test` export so the test can reach `BANKS`:

```js
globalThis.bank_editor = {
  _test: { dirFromCC: dirFromCC, clampBank: clampBank, accumStep: accumStep, BANKS: BANKS }
};
```

(Replace the Task-1 `globalThis.bank_editor = {...}` line with this one.)

- [ ] **Step 4: Run both tests to verify they pass**

Run: `cd "schwung-obxd" && node tests/canvas_helpers.test.mjs && node tests/canvas_banks.test.mjs`
Expected: both PASS; final line `all 76 params covered exactly once across 14 banks`.

- [ ] **Step 5: Cross-check against the C source (manual)**

Open `src/dsp/obxd_plugin.cpp` and confirm the `EXPECTED` list in the test equals the union of every level's `"params"` array in the `ui_hierarchy` block (lines ~1190–1273), minus `preset`/`bank_index`. If OB-Xd's param set has changed, update `EXPECTED` and `BANKS` together.
Expected: lists match (76 keys).

- [ ] **Step 6: Commit**

```bash
cd "schwung-obxd"
git add src/canvas.js tests/canvas_banks.test.mjs
git commit -m "feat(obxd): bank editor BANKS table covering all params + coverage test"
```

---

### Task 3: The overlay hooks (`onOpen`, `onMidi`, `draw`)

Wire the helpers + `BANKS` into the live overlay object. State lives in `ctx.state`.

**Files:**
- Modify: `schwung-obxd/src/canvas.js`

- [ ] **Step 1: Replace the `_test`-only export with the full overlay**

In `src/canvas.js`, replace the `globalThis.bank_editor = { _test: {...} }` line with the full object below. Keep `BANKS` and the helpers above it unchanged.

```js
/* ---- drawing constants (davebox-derived 2x4 cell grid) ---- */
var HDR_H = 9;                 // header band height
var CELL_W = 30, CELL_H = 23;  // 4 cols x 30, 2 rows x 23
var COL_X0 = 4, ROW_Y0 = HDR_H + 2;

function cellX(k) { return COL_X0 + (k % 4) * CELL_W; }
function cellY(k) { return k < 4 ? ROW_Y0 : ROW_Y0 + CELL_H + 3; }

/* draw the right-aligned bank-position strip; active bank = tall block */
function drawBankStrip(ctx, active, count) {
  var pitch = 4, w = 3;
  var x = ctx.width - 4 - (count - 1) * pitch; // left edge so the strip is right-aligned
  for (var i = 0; i < count; i++) {
    var bx = x + i * pitch;
    if (i === active) ctx.fillRect(bx, 0, w, 7, 1);
    else ctx.fillRect(bx, 4, w, 2, 1);
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
    if ((d[0] & 0xF0) !== 0xB0) return;   // CC only
    var cc = d[1], val = d[2];
    var s = readState(ctx);

    if (cc === 14) {                       // jog turn -> cycle bank
      var jd = dirFromCC(val);
      if (jd) {
        s.bank = clampBank(s.bank + jd, BANKS.length);
        ctx.setValue(s.bank);              // persist for re-open
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
      if (nv !== cur) ctx.setParam(pm.key, nv);  // one write per onMidi (no race)
    }
  },

  draw: function(ctx) {
    var s = readState(ctx);
    var bank = BANKS[s.bank];

    // header: bank label (left) + position strip (right)
    ctx.print(2, 1, bank.label.slice(0, 16), 1);
    drawBankStrip(ctx, s.bank, BANKS.length);

    // 8 cells
    for (var k = 0; k < 8; k++) {
      var pm = bank.knobs[k];
      var x = cellX(k), y = cellY(k);
      var hi = (k === s.lastKnob) && pm;
      if (hi) ctx.fillRect(x, y, CELL_W - 2, CELL_H, 1);
      if (!pm) continue;
      var fg = hi ? 0 : 1;
      ctx.print(x + 1, y + 1, pm.abbrev, fg);
      var raw = ctx.getParam(pm.key);
      var txt = (raw === null || raw === undefined || raw === "") ? "-" : String(raw);
      ctx.print(x + 1, y + 12, txt, fg);
    }
  },

  _test: { dirFromCC: dirFromCC, clampBank: clampBank, accumStep: accumStep, BANKS: BANKS }
};
```

- [ ] **Step 2: Syntax-check the file with node**

Run: `cd "schwung-obxd" && node --check src/canvas.js`
Expected: no output, exit 0 (a parse error would print here). This is the off-device stand-in for the QuickJS load.

- [ ] **Step 3: Re-run the pure tests (regression)**

Run: `cd "schwung-obxd" && node tests/canvas_helpers.test.mjs && node tests/canvas_banks.test.mjs`
Expected: both PASS (the `_test` export still exposes helpers + BANKS).

- [ ] **Step 4: Commit**

```bash
cd "schwung-obxd"
git add src/canvas.js
git commit -m "feat(obxd): bank editor overlay hooks (onOpen/onMidi/draw)"
```

---

### Task 4: OB-Xd C wiring (param + menu entry)

Add the `editor` canvas param, persist the active bank, and surface "Bank Editor" in the root menu.

**Files:**
- Modify: `schwung-obxd/src/dsp/obxd_plugin.cpp`

- [ ] **Step 1: Add the `editor_bank` field to the instance struct**

In `obxd_plugin.cpp`, the struct ends at line ~328 `int current_bank;`. Add a field:

```c
    int bank_count;
    int current_bank;
    int editor_bank;  /* active bank index for the canvas Bank Editor (persists per instance) */
} obxd_instance_t;
```

- [ ] **Step 2: Initialize it in `v2_create_instance`**

In `v2_create_instance` (~line 763), find where `inst->current_bank = -1;` is set (~line 788) and add right after it:

```c
        inst->current_bank = -1;  /* Force load */
        inst->editor_bank = 0;
```

- [ ] **Step 3: Handle `set_param("editor")`**

In `v2_set_param` (~line 998), add a new branch in the `if/else if` chain — place it right before the final `else` that does the named-param loop (after the `param_bank`/`param_` branches, ~line 1095):

```c
    else if (strcmp(key, "editor") == 0) {
        int n = atoi(val);
        if (n < 0) n = 0;
        if (n > 63) n = 63;       /* generous upper clamp; canvas owns real bound */
        inst->editor_bank = n;
    }
```

- [ ] **Step 4: Handle `get_param("editor")`**

In `v2_get_param` (~line 1113), add near the other scalar getters (e.g. right after the `bank_index` getter at ~line 1127):

```c
    if (strcmp(key, "editor") == 0) {
        return snprintf(buf, buf_len, "%d", inst->editor_bank);
    }
```

- [ ] **Step 5: Add the `editor` canvas entry to `chain_params`**

In the `chain_params` branch (~line 1312), extend the initial fixed entries so `editor` is advertised. Replace:

```c
        offset += snprintf(buf + offset, buf_len - offset,
            "[{\"key\":\"preset\",\"name\":\"Preset\",\"type\":\"int\",\"min\":0,\"max\":9999},"
            "{\"key\":\"octave_transpose\",\"name\":\"Octave\",\"type\":\"int\",\"min\":-3,\"max\":3}");
```

with:

```c
        offset += snprintf(buf + offset, buf_len - offset,
            "[{\"key\":\"preset\",\"name\":\"Preset\",\"type\":\"int\",\"min\":0,\"max\":9999},"
            "{\"key\":\"octave_transpose\",\"name\":\"Octave\",\"type\":\"int\",\"min\":-3,\"max\":3},"
            "{\"key\":\"editor\",\"name\":\"Bank Editor\",\"type\":\"canvas\","
            "\"canvas_script\":\"canvas.js#bank_editor\",\"show_footer\":false,\"show_value\":false}");
```

- [ ] **Step 6: Surface "Bank Editor" in the root `ui_hierarchy`**

In the `ui_hierarchy` string (~line 1196), add the editor entry as the first item in the root `params` array. Replace:

```c
                    "\"params\":["
                        "{\"level\":\"banks\",\"label\":\"Banks\"},"
```

with:

```c
                    "\"params\":["
                        "{\"key\":\"editor\",\"label\":\"Bank Editor\"},"
                        "{\"level\":\"banks\",\"label\":\"Banks\"},"
```

- [ ] **Step 7: Build the DSP to verify it compiles**

Run: `cd "schwung-obxd" && ./scripts/build.sh`
Expected: build succeeds, produces `build/dsp.so` and `dist/obxd/dsp.so`. (Uses Docker cross-compile per the repo's build script.)

- [ ] **Step 8: Commit**

```bash
cd "schwung-obxd"
git add src/dsp/obxd_plugin.cpp
git commit -m "feat(obxd): declare editor canvas param + persist active bank + root menu entry"
```

---

### Task 5: Ship `canvas.js` in the build

**Files:**
- Modify: `schwung-obxd/scripts/build.sh`

- [ ] **Step 1: Add the copy line**

In `scripts/build.sh`, after the `ui.js` copy (line ~63 `cat src/ui.js > dist/obxd/ui.js`), add:

```bash
cat src/ui.js > dist/obxd/ui.js
cat src/canvas.js > dist/obxd/canvas.js
```

- [ ] **Step 2: Build and verify canvas.js lands in dist**

Run: `cd "schwung-obxd" && ./scripts/build.sh && test -f dist/obxd/canvas.js && echo "canvas.js packaged"`
Expected: prints `canvas.js packaged`.

- [ ] **Step 3: Commit**

```bash
cd "schwung-obxd"
git add scripts/build.sh
git commit -m "build(obxd): package canvas.js into the module tarball"
```

---

### Task 6: Deploy and verify on hardware

This feature is host-integration + UX; the real test is on-device.

**Files:** none (deploy + manual verification)

- [ ] **Step 1: Deploy the module**

Run: `cd "schwung-obxd" && ./scripts/install.sh`
Expected: `scp` copies `dist/obxd/*` (including `canvas.js`, new `dsp.so`) to `/data/UserData/schwung/modules/sound_generators/obxd/` on the device.

- [ ] **Step 2: Reload OB-Xd so the new dsp.so + canvas.js take effect**

The new `dsp.so` loads fresh on next instantiation. If OB-Xd is currently loaded in a slot, swap it out and back in (or run the workspace `scripts/restart_move.sh` — no reboot needed for a module). On the device, open a slot with OB-Xd as the sound generator.

- [ ] **Step 3: Verify the menu entry + canvas open**

On the device: open OB-Xd's shadow parameter editor (slot → synth). At the root level, confirm a **"Bank Editor"** item appears at the top of the list. Select it.
Expected: a fullscreen screen with a bank label top-left ("Osc 1"), a tick strip top-right, and an 8-cell (2×4) grid showing param abbreviations + values. No host footer/value chrome.

- [ ] **Step 4: Verify jog cycles banks**

Turn the jog wheel.
Expected: the bank label and the active tick in the strip advance through all 14 banks (Osc 1 → Osc 2 → … → Voice Var (2/2)) and clamp at the ends. The 8 cells update to the new bank's params.

- [ ] **Step 5: Verify encoders edit the active bank live**

On a continuous bank (e.g. "Filter (1/2)"), turn encoders 1–5.
Expected: each cell's value changes (0..100), audibly affecting the sound. Turning feels reasonable (not too fast/slow); reversing direction reverses cleanly. On toggle banks (e.g. "Filter (2/2)") values flip 0/1.

- [ ] **Step 6: Verify value read-back matches the menu / Remote UI**

Note a couple of values in the Bank Editor, exit (Back or jog-click), open the same params via the normal menu pages (or the Remote UI at `http://move.local:7700/remote-ui`).
Expected: values match exactly (same native-int contract).

- [ ] **Step 7: Verify bank persists across re-open**

Jog to "LFO", exit the canvas (Back), re-open "Bank Editor".
Expected: it re-opens on "LFO" (persisted via the `editor` param), not "Osc 1".

- [ ] **Step 8: Verify empty cells are inert**

On a bank with fewer than 8 params (e.g. "Filter (2/2)", 4 params), turn encoders 5–8.
Expected: nothing happens; those cells are blank and their encoders do nothing.

- [ ] **Step 9: Verify no audio dropouts under editing**

Hold a note (or run a sequence) and sweep an encoder rapidly in the Bank Editor.
Expected: the param sweeps smoothly with no audio glitches/dropouts (single-write-per-`onMidi` keeps the param channel uncontended).

- [ ] **Step 10: Record the outcome**

Update the workspace worklog `_worklogs/schwung-obxd.md` and `_worklogs/OUTSTANDING.md` with the result (works / issues found). If everything passes, note the feature as shipped on the fork; flag any device-only bugs for follow-up.

---

## Self-review notes

- **Spec coverage:** canvas hook (Task 3) ✓; jog-only bank nav (Task 3 `onMidi` CC 14) ✓; encoders edit bank (Task 3) ✓; all params in banks, `(n/N)` split (Task 2 + coverage test) ✓; bank strip + 8 cells on-screen only (Task 3 `draw`) ✓; persist active bank via canvas param value (Task 3 `getValue/setValue` + Task 4 C round-trip) ✓; single write per tick (Task 3 one `setParam` per `onMidi`) ✓; no LEDs / modal / jog-click-closes accepted (Background) ✓; build ships canvas.js (Task 5) ✓; on-device verification (Task 6) ✓.
- **Pad direct-jump** is intentionally out of scope (jog-only v1) — not implemented.
- **Type consistency:** helper names `dirFromCC`/`clampBank`/`accumStep` and `BANKS` are used identically across canvas.js, both tests, and the overlay. The C key `"editor"` matches `canvas_script` overlay ref `bank_editor` (global name) — these are deliberately different: the *param key* is `editor`, the *global object* is `bank_editor`.
- **No placeholders.**
```
