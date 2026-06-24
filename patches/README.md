# Fork-only patches

Self-contained patches for **daily-driver-only** features that are **not** going upstream.
Kept here so they can be re-applied after an upstream history rewrite / rebase (upstream
periodically squashes/rebases its public history, so fork commits don't always replay cleanly).

## bank-editor-canvas.patch

On-device dAVEBOx-style **Bank Editor** for OB-Xd via the host's `type:"canvas"` hook (no host
changes): jog cycles 14 banks, 8 encoders edit live, all params exposed, bottom category-tab bar,
labels cleaned, capacitive-touch highlight. Known limitation: overridden by the overtake render
inside co-run (host-side, unfixed). See the workspace worklog `_worklogs/schwung-obxd.md`.

Touches only: `src/canvas.js` (new), `tests/canvas_*.test.mjs` (new), `src/dsp/obxd_plugin.cpp`
(+16 lines: `editor` canvas chain-param, root menu entry, `editor_bank` get/set), `scripts/build.sh`
(+1 line: package `canvas.js`). Generated against pre-feature base `upstream/main` (v0.4.7 `57d03dd`).

### Re-apply after an upstream rebase/reset

```bash
# clean apply (base unchanged):
git apply patches/bank-editor-canvas.patch

# if upstream moved obxd_plugin.cpp / build.sh and it won't apply clean, 3-way merge:
git apply --3way patches/bank-editor-canvas.patch
# (resolve any conflict in obxd_plugin.cpp — the +16 lines are additive and well-isolated)

# then verify:
node tests/canvas_helpers.test.mjs && node tests/canvas_banks.test.mjs && node --check src/canvas.js
```

To regenerate after further tweaks on `main`:

```bash
git diff upstream/main HEAD -- src/canvas.js tests/canvas_helpers.test.mjs tests/canvas_banks.test.mjs \
  src/dsp/obxd_plugin.cpp scripts/build.sh > patches/bank-editor-canvas.patch
```
