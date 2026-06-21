# OB-Xd Local DSP Test Harness — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Scope:** `schwung-obxd` (module-local). First synth port of the davebox harness pattern; deliberately structured to feed a later extraction of a shared `schwung-dsp-testkit`.

## Problem

Testing the OB-Xd DSP today requires a build → deploy → reboot cycle to the Move
for every change. The DSP is highly decoupled from the device (single C++
translation unit, plugin_api_v2 ABI, only `host->log` used at runtime), so it can
be compiled and exercised natively on the host machine. davebox already has such
a harness; this ports the same pattern to the first **synth** module — which adds
the dimension davebox lacked: real audio output.

## Goal

A native (macOS, no Docker) test/debug harness that compiles the OB-Xd DSP and
drives it through its real ABI, optimized to be driven by Claude during
development. It verifies the synth's observable behavior off-device:
param get/set, state round-trips, and **audio output** (both behavioral sanity and
opt-in golden-reference regression).

This is the **first of two ports** (davebox + obxd) from which a generic
`schwung-dsp-testkit` will later be extracted. The harness is therefore kept
structurally parallel to davebox's so the extraction is a clean common-vs-per-module diff.

## Why local testing is feasible (verified)

- **Single-TU includable.** The entire DSP is one compiled file,
  `src/dsp/obxd_plugin.cpp` (~1369 lines), which `#include`s the whole header-only
  engine (`Engine/*.h`). A test that `#include`s that one `.cpp` gets white-box
  access — the same model as davebox's `seq8.c`.
- **C++14, not C.** Build is `clang++ -std=c++14 -Isrc/dsp`. The harness TU is
  therefore C++ (`.cpp` / `.hpp`).
- **Exports v2 only:** `extern "C" plugin_api_v2_t* move_plugin_init_v2(const host_api_v1_t*)`.
  The `host_api_v1_t` / `plugin_api_v2_t` struct definitions are inlined at the top
  of `obxd_plugin.cpp` (no separate vendored header) — they come in via the
  white-box include for free.
- **Host surface used at runtime: `host->log` only.** No MIDI sends, no
  `mapped_memory`, no `get_bpm`. The stub host is trivial.
- **Real audio.** `render_block` runs BLEP oscillators → 4-pole filter → ADSR/LFO,
  writing interleaved stereo int16. This is the new surface to assert on.
- **State is simple.** `get_param("state")` returns a JSON blob;
  `set_param("state", blob)` restores it directly — no UUID/file-path detour like
  davebox. No `fmemopen`/`open_memstream`.
- **No macOS portability landmines.** No NEON/aarch64 intrinsics, no `_GNU_SOURCE`,
  no glibc-only calls. `dirent.h`/`strcasecmp` used are POSIX (present on macOS).
  **No `compat` shim needed** (unlike davebox).
- **No preset-file dependency for tests.** `create_instance(".", NULL)` falls
  through to a valid default patch when no `presets/` are found, so tests run on
  the deterministic default patch + explicit param sets.

## Architecture

A `tests/` tree mirroring davebox's layout, so the eventual testkit extraction
diffs cleanly:

```
schwung-obxd/tests/
  harness/
    stub_host.hpp/.cpp   # host_api_v1_t builder (log->buffer); MIDI capture (parity);
                         # audio capture stream + analysis; configurable bpm/sample_rate
    harness.hpp          # white-box #include of obxd_plugin.cpp; hx_* API; HX_ASSERT;
                         # audio helpers; golden compare/update
  baseline/
    <name>.s16           # committed golden audio reference(s), raw interleaved int16
  test_smoke.cpp         # behavioral coverage (param/state/audio sanity)
  test_golden.cpp        # opt-in golden-reference audio regression
  run.sh                 # native clang++ runner over tests/test_*.cpp
  README.md
```

Two layers: a reusable **foundation** (`harness/`) and small **per-scenario**
`test_*.cpp` files, each its own binary with its own `main()`, compiled by `run.sh`.

### Harness language
C++ (`.hpp`/`.cpp`), because the DSP is C++14. `harness.hpp` `#include`s
`../../src/dsp/obxd_plugin.cpp` once per test binary (white-box). Compile:
`clang++ -std=c++14 -Isrc/dsp -Itests/harness`.

## Observability surfaces

1. **Param get/set.** `hx_set_param` / `hx_get_param` (native-integer string
   contract per the module's param model).
2. **State round-trip.** `get_param("state")` → `set_param("state", blob)` →
   `get_param("state")` again, assert stable.
3. **Audio output (the new surface).** `hx_render(n_blocks)` accumulates rendered
   stereo int16 into a capture buffer. Analysis helpers:
   - `hx_audio_rms()`, `hx_audio_peak()`
   - `hx_audio_is_silent(threshold)`
   - `hx_audio_has_nan_or_clip()`
4. **Internal inspection.** Direct struct access (white-box) + captured `log` text.

(MIDI capture plumbing is carried over from davebox for parity with the future
generic core, even though obxd emits no MIDI.)

## Harness API (sketch)

```cpp
hx_t *hx_create(const char *module_dir, const char *json_defaults); // build stub host + create_instance
void  hx_destroy(hx_t *h);
void  hx_send_midi(hx_t *h, const uint8_t *msg, int len, int source);
void  hx_set_param(hx_t *h, const char *key, const char *val);
int   hx_get_param(hx_t *h, const char *key, char *buf, int len);
void  hx_render(hx_t *h, int n_blocks);          // advances time, accumulates audio

// audio
void   hx_audio_clear(hx_t *h);
long   hx_audio_frames(hx_t *h);
const int16_t *hx_audio_data(hx_t *h);           // interleaved L,R
double hx_audio_rms(hx_t *h);
int    hx_audio_peak(hx_t *h);
int    hx_audio_is_silent(hx_t *h, int threshold);
int    hx_audio_has_nan_or_clip(hx_t *h);

// golden
int    hx_golden_check(hx_t *h, const char *baseline_path, int tol); // 1=pass

#define HX_ASSERT(cond, msg) /* print FAIL + exit(1) */
```

## Behavioral smoke test (`test_smoke.cpp`)

1. `hx_create(".", NULL)` → default patch.
2. Set a param (native-int contract), read it back.
3. State round-trip: `state` get → set → get, assert byte-stable.
4. Note-on (internal source) → `hx_render(N)` → assert **non-silent** (RMS/peak >
   threshold) and **no NaN/clip**.
5. Note-off → `hx_render(M)` → assert eventually **silent** (envelope releases).
6. Two different notes (or a param change) produce **different** audio.

## Golden-reference test (`test_golden.cpp`)

- Render a fixed, deterministic scenario: default patch + a fixed param set + a
  fixed note sequence for N blocks; capture the audio stream.
- Compare to `tests/baseline/<name>.s16`: require equal length AND max per-sample
  absolute difference ≤ `GOLDEN_TOL` (small default — tight enough to catch DSP
  regressions, loose enough to absorb `-O`/compiler variance on the **same**
  toolchain).
- `OBXD_UPDATE_GOLDEN=1 tests/run.sh` (re)writes the baseline instead of asserting.
- README documents baselines as **macOS-native references, NOT device parity**
  (cross-compiler float results differ); they guard against host-side regressions.

## Build / run

- `tests/run.sh`: `clang++ -std=c++14 -Isrc/dsp -Itests/harness -Wall -g` per
  `test_*.cpp`, link `stub_host.cpp`, run each, aggregate PASS/FAIL, exit non-zero
  on any failure. Honors `OBXD_UPDATE_GOLDEN` to regenerate baselines.
- Native only. No Docker. No CI wiring (run on demand).

## First deliverables

1. Foundation (`stub_host`, `harness.hpp`) compiling obxd_plugin.cpp natively.
2. `test_smoke.cpp` green (param/state/audio-sanity).
3. `test_golden.cpp` + a committed baseline, green; update workflow verified.
4. `tests/README.md`.

## Extraction notes (input for the later `schwung-dsp-testkit`)

Record the davebox-vs-obxd divergences that the generic testkit must accommodate:
- **Language:** C (davebox) vs C++14 (obxd) → core must support a C++ TU /
  `extern "C"`; header is `.h` vs `.hpp`.
- **compat shim:** required for davebox (`fmemopen`), unneeded for obxd → compat is
  per-module/optional.
- **Audio:** davebox MIDI-only (silence) vs obxd real audio → audio capture +
  analysis helpers belong in the generic core; the davebox `hx_last_audio` hook
  generalizes to a capture stream.
- **State restore shape:** davebox `state_load` = UUID/file-path; obxd `state` =
  direct blob → the round-trip helper must not assume one shape.
- **Instance creation:** davebox `create_instance(".")`; obxd takes a `module_dir`
  that may scan presets → keep `module_dir` a parameter.
- **Host surface:** both minimal but different fields → stub wires all known fields
  generically (harmless extras).
- **Golden/audio analysis:** new generic capability introduced here.

## Out of scope (YAGNI)

- `.fxb` bank/preset-loading scenarios (test on the default patch).
- MIDI-emission assertions (obxd emits none).
- Cross-device golden parity (baselines are macOS-native references only).
- Docker / CI integration.
- The generic `schwung-dsp-testkit` extraction itself (separate next project; this
  port informs it).

## Risks / open questions

- **Golden tolerance value.** Start small; tune in the plan if same-toolchain
  `-O` variance trips it. `OBXD_UPDATE_GOLDEN` mitigates churn.
- **First native compile may surface incidental warnings** beyond expectations
  (static scan only); the plan's first step is "make it compile" against the real
  toolchain.
- **Default-patch determinism.** Assumes the default patch + explicit param sets
  render deterministically across runs on one machine (no RNG seeded by wall
  clock in the audio path). The plan verifies this before committing a baseline;
  if drift exists, the golden scenario pins any RNG/seed or falls back to
  behavioral-only for that case.
