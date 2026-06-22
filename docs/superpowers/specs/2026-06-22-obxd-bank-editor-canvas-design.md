# OB-Xd Bank Editor — on-device canvas UI

**Date:** 2026-06-22
**Module:** schwung-obxd (OB-Xd, `sound_generator` chain module)
**Status:** Design approved, ready for implementation plan

## Problem

On-device synth editing in Schwung is driven by the host's declarative `ui_hierarchy`
renderer (`schwung/src/shadow/shadow_ui.js`): params are spread across menu pages, 8
encoders per page, and you navigate page-to-page. For a deep synth this means too much
paging, poor at-a-glance visibility, slow param discovery, and a fixed layout you can't
reorganize.

We want the **dAVEBOx "parameter bank" feel** on a chain synth: flip between banks of 8
knobs instantly (primarily with the **jog wheel**), with the 8 encoders always live on the
current bank and an on-screen bank-position strip showing where you are — *without
modifying the protected host* (`schwung/`).

## Constraint: no host changes

`schwung/` is the protected host. Everything here is module-side only. The relevant host
capability we build on (read-only dependency) is the `type:"canvas"` chain-param hook in
`shadow_ui.js`, which is already shipped and unused by every existing module.

## Approach: a single `type:"canvas"` "Bank Editor" screen

A chain module gets no global pad/jog/button input in normal menu mode — **except inside a
`type:"canvas"` view**, where pads, encoders, steps, buttons, and jog-turn all arrive at the
overlay's `onMidi` hook, and the overlay draws the full 128×64 framebuffer itself. That is
the sanctioned, host-change-free way to build a custom editing surface.

So the Bank Editor is one canvas param ("Editor") that, when entered, becomes a fullscreen
davebox-style bank editor.

### Why canvas and not richer `ui_hierarchy`

Declarative levels can fake "banks" only as menu pages you *click* between — that is the
current paging paradigm, not the davebox feel. True bank-switching needs **jog/pad input
while the 8 encoders stay live**, and a chain module only receives that input inside a
canvas view. Canvas is therefore the only host-change-free path to the desired UX.

## Components (all module-side)

### 1. `src/canvas.js` (new) — the Bank Editor overlay

Registers `globalThis.bank_editor` implementing the canvas hooks (`onOpen`, `tick`, `draw`,
`onMidi`, `onClose`). Contains:

- **`BANKS` table** (the davebox `BANKS` pattern). Each bank: `{ label, knobs: [8 × { key,
  abbrev, min, max, step, sens }] }`. `key` is an OB-Xd param key (unprefixed; the canvas
  runtime auto-prefixes). `step`/`sens` tune encoder feel per param (davebox-style: small
  `sens` for integers/toggles, larger `sens` for fine continuous params).
- **`onMidi({ source, data })`**:
  - **Jog turn (CC 14)** → cycle `activeBank` (`+1`/`-1`, clamped to `[0, BANKS.length-1]`).
    This is the primary bank nav.
  - **Encoders (CC 71–78)** → edit the active bank's 8 params. Relative handling like
    davebox (`d2` 1–63 = CW, 64–127 = CCW), accumulate per-knob until `>= sens`, then
    `newVal = clamp(cur + dir*step, min, max)` and `ctx.setParam(key, newVal)`. Track
    last-touched knob index for highlight.
  - Back (CC 51) and jog-click (CC 3) are **stolen by the host** to close the canvas — not
    available to us.
- **`draw(ctx)`**:
  - **Bank-position strip** (davebox `drawBankStrip` pattern): right-aligned ticks at top,
    active bank = tall block, inactive = short stub. Bank label drawn alongside.
  - **8 param cells**: 2 rows × 4 cols (davebox geometry: `colX = 4 + (k%4)*30`,
    `rowY = k<4 ? 12 : 36`). Each cell: `abbrev` label + live value (read via
    `ctx.getParam(key)`). Highlight the last-touched knob's cell (invert fill).
  - All indication is **on-screen only** — no LED API exists in a chain-module canvas.
- **`tick(ctx)`**: per-tick accumulator housekeeping / optional blink phase. Fires ~44 Hz;
  redraw is host-throttled to ~15 Hz.
- **Active-bank persistence**: store `activeBank` in the **canvas param's own value** via
  `ctx.getValue()` / `ctx.setValue(idx)`. Canvas `state{}` resets on close, but the param
  value persists, so re-opening the editor restores the last bank. Read it in `onOpen`.
- **Single write per tick**: the canvas→host param channel is a single racey slot; write at
  most one param per tick. Encoder turns are sequential, so this is a non-issue in practice
  — just never batch multiple independent writes in one frame.

### 2. `src/dsp/obxd_plugin.cpp` (small additive change)

OB-Xd generates `chain_params` and `ui_hierarchy` in C (`obxd_plugin.cpp` ~1187–1328).

- Add **one** `chain_params` entry surfaced into the generated JSON:
  `{"key":"editor","type":"canvas","canvas_script":"canvas.js#bank_editor",
  "show_footer":false,"show_value":false}`. Its int value doubles as the persisted
  active-bank index (range `0..BANKS.length-1`), so `get_param("editor")` /
  `set_param("editor")` must round-trip a small int (add a trivial backing field; it touches
  no DSP/preset state).
- Surface **"Editor"** in the **root** `ui_hierarchy` level so it is one click from the top
  page. No other hierarchy/DSP logic changes.

Per the repo's native-int param model, the `editor` param is advertised `"type":"canvas"`
(not `int`), so it bypasses the normal int knob path — it only opens the canvas view.

### 3. `scripts/build.sh`

Add `cp src/canvas.js dist/obxd/` alongside the existing `web_ui.html` copy, so `canvas.js`
deploys to `/data/UserData/schwung/modules/sound_generators/obxd/canvas.js` — the module dir,
where `canvas_script:"canvas.js#…"` resolves.

## Bank layout — every param exposed

**All synth params are reachable.** Banks follow the synth's natural categories; a category
with more than 8 params splits across consecutively-numbered banks using a `Category (n/N)`
label convention (e.g. `Filter (1/2)`). A category with fewer than 8 params is its own bank
and leaves trailing cells empty (their encoders inert). OB-Xd params are native-int at the
boundary (continuous → 0..100, toggles → 0..1, etc.), so value formatting is trivial. Order
puts amp envelope ahead of filter, per request:

1. **Osc 1:** `osc1_saw`, `osc1_pulse`, `osc1_pitch`, `osc1_mix`
2. **Osc 2:** `osc2_saw`, `osc2_pulse`, `osc2_pitch`, `osc2_mix`, `osc2_detune`, `osc2_sync`,
   `osc_quantize`
3. **Osc Common:** `pw`, `pw_env`, `pw_env_both`, `pw_ofs`, `noise`, `xmod`, `brightness`
4. **Amp Env:** `attack`, `decay`, `sustain`, `release`, `vel_amp`
5. **Filter (1/2):** `cutoff`, `resonance`, `filter_env`, `key_follow`, `multimode`
6. **Filter (2/2):** `bandpass`, `fourpole`, `self_osc`, `fenv_inv`
7. **Filter Env:** `f_attack`, `f_decay`, `f_sustain`, `f_release`, `vel_filter`
8. **LFO:** `lfo_rate`, `lfo_amt1`, `lfo_amt2`, `lfo_sin`, `lfo_square`, `lfo_sh`, `lfo_sync`
9. **LFO Dest:** `lfo_osc1`, `lfo_osc2`, `lfo_filter`, `lfo_pw1`, `lfo_pw2`
10. **Pitch Mod:** `env_pitch`, `env_pitch_both`, `bend_range`, `bend_osc2`, `vibrato`
11. **Global (1/2):** `volume`, `tune`, `octave`, `octave_transpose`, `portamento`
12. **Global (2/2):** `voice_count`, `legato`, `unison`, `unison_det`, `as_played`
13. **Voice Var (1/2):** `filter_var`, `porta_var`, `env_var`, `level_var`
14. **Voice Var (2/2):** `pan_1`, `pan_2`, `pan_3`, `pan_4`, `pan_5`, `pan_6`, `pan_7`, `pan_8`

This covers every entry in `g_shadow_params[]` plus the plugin-level `octave_transpose`
(`preset`/`bank_index` are not knob params and are excluded). Implementation must enumerate
against `g_shadow_params[]` to confirm no param is missed — the count is the check. The whole
layout lives in `canvas.js`'s `BANKS` table and is freely tunable without a DSP rebuild.

With ~14 banks, **jog-turn cycling is the only bank nav in v1** (no pad jump — see Out of
scope). Cycling wraps or clamps across all banks.

## Data flow

1. User clicks **Editor** in the root menu → host enters `VIEWS.CANVAS`, loads `canvas.js`,
   calls `onOpen` (reads persisted bank via `getValue`).
2. **Jog turn** → `activeBank` changes → `setValue(activeBank)` persists it → redraw shows
   the new bank's 8 params (`getParam` per cell).
3. **Encoder turn** → accumulate → on threshold, `setParam(key, newVal)` (one write/tick).
4. **Back / jog-click** → host closes the canvas; `onClose` runs. Re-entry restores the bank.

## Limits accepted (no host changes)

- **Modal**: the editor is a screen entered from the menu, not an always-on menu
  replacement. Re-entry is instant.
- **No LEDs**: pad/knob-ring LEDs are not controllable from a chain-module canvas; all
  indication is on the 128×64 OLED.
- **Jog-click unavailable** (host closes the canvas with it) — so no davebox-style
  alt-layer-on-click. A future second layer per bank, if wanted, would toggle via a pad/
  button instead.
- **~15 Hz redraw / ~44 Hz input** — ample for this UX.

## Testing

This is almost entirely JS/UX, so the real verification is on-device:

1. `qjs`-validate `canvas.js` syntax before deploy.
2. Build `dsp.so` (Docker), package, `scp` to the device, instantiate OB-Xd.
3. Enter **Editor**; verify: jog cycles all 8 banks with the strip tracking; each bank's 8
   encoders edit the correct params with sensible feel; cell values read back live and match
   the menu/Remote UI; exiting and re-entering restores the last bank; empty trailing cells
   are inert.
4. Confirm no audio dropouts while turning encoders inside the canvas (single-write-per-tick
   discipline holds).

## Out of scope (possible later)

- **Shift + top-row pad direct bank jump** (deferred from v1; jog-only for now).
- Generalizing the Bank Editor into a shared, reusable toolkit across modules.
- Per-bank alt-layers, pad-driven A/B compare, modulation visualization.
- LED indication (would require host changes / overtake mode).
