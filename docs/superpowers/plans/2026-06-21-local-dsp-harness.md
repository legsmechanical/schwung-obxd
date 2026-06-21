# OB-Xd Local DSP Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native (macOS, no Docker) test/debug harness that compiles the OB-Xd DSP and drives it through its real `plugin_api_v2` ABI with a stub host, verifying params, state round-trips, and **audio output** (behavioral sanity + opt-in golden-reference regression) — without deploying to the Move.

**Architecture:** A header-only C++ harness (`tests/harness/harness.hpp`) that white-box-`#include`s the single translation unit `src/dsp/obxd_plugin.cpp`, plus small per-scenario `tests/test_*.cpp` files compiled to their own binaries by `tests/run.sh`. Structured parallel to the davebox harness so a shared `schwung-dsp-testkit` can later be extracted.

**Tech Stack:** C++14, `clang++`, plain shell runner. No Docker, no external deps.

Design spec: `docs/superpowers/specs/2026-06-21-local-dsp-harness-design.md`.

**Branch:** `obxd-local-dsp-harness` (already created off `main`).

**Two intentional refinements of the spec (decided during planning):**
1. **Header-only harness** (no separate `stub_host.cpp`): obxd's `host_api_v1_t`/`plugin_api_v2_t` are inlined in `obxd_plugin.cpp` (no shared header), so the stub host must be defined *after* the white-box include. Everything lives in `harness.hpp`. (Extraction note: davebox could use a separate stub TU because it vendors `plugin_api_v1.h`; obxd cannot.)
2. **Clip-ratio instead of NaN detection**: a float NaN is not observable once `render_block` has converted to int16, so audio health is checked via silence + clip-ratio (fraction of railed samples), which catch pathological output indirectly. `hx_audio_has_nan_or_clip` from the spec sketch becomes `hx_audio_clip_ratio`.

**Commit trailer** on every commit:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017fZojSLfPB7Cpn4SLDh5Xh
```

## File Structure

| File | Responsibility |
|------|----------------|
| `tests/harness/harness.hpp` | Everything: white-box `#include` of `obxd_plugin.cpp`; stub host (log + MIDI capture); `hx_t` instance + `hx_*` API; audio capture stream + analysis; golden compare/update; `HX_ASSERT`. |
| `tests/run.sh` | Compile each `tests/test_*.cpp` with `clang++` and run; PASS/FAIL summary; passes `OBXD_UPDATE_GOLDEN` through. |
| `tests/test_smoke.cpp` | Behavioral coverage: param get/set, state round-trip, audio sanity (non-silent on note, silent after release, different notes differ, not pathologically clipped). |
| `tests/test_golden.cpp` | Determinism gate (two instances render identically) + golden audio compare against `tests/baseline/obxd_c4.s16`. |
| `tests/baseline/obxd_c4.s16` | Committed golden reference (raw interleaved int16), generated via `OBXD_UPDATE_GOLDEN=1`. |
| `tests/README.md` | How to run / add a scenario / update goldens; obxd gotchas. |

---

### Task 1: Foundation header `harness.hpp` (+ native compile & audio probe)

De-risks the whole port (does `obxd_plugin.cpp` compile under `clang++` natively, and does a default-patch note actually produce audio?) and lands the reusable foundation.

**Files:**
- Create: `tests/harness/harness.hpp`
- Create (temporary): `tests/harness/_probe.cpp`

- [ ] **Step 1: Write `tests/harness/harness.hpp`**

```cpp
/* tests/harness/harness.hpp — white-box test API for the OB-Xd DSP.
 * Each tests/test_*.cpp that includes this gets its own copy of the
 * obxd_plugin.cpp translation unit (white-box access to statics + the inlined
 * host/plugin ABI structs). Header-only: obxd inlines its ABI structs in the
 * .cpp, so the stub host must be defined AFTER the include. */
#ifndef HX_HARNESS_HPP
#define HX_HARNESS_HPP

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>

/* White-box: defines move_plugin_init_v2 + host_api_v1_t/plugin_api_v2_t
 * (inlined in the .cpp) + MOVE_* constants + all v2_* statics. */
#include "../../src/dsp/obxd_plugin.cpp"

#define HX_ASSERT(cond, msg) do { \
    if (!(cond)) { std::fprintf(stderr, "FAIL: %s (%s:%d)\n", (msg), __FILE__, __LINE__); std::exit(1); } \
} while (0)

/* ---- stub host: log + MIDI capture (callbacks are context-free -> file-static) ---- */
static std::string hx_log_buf;
struct hx_midi_event { uint8_t bytes[4]; int len; };
static std::vector<hx_midi_event> hx_midi_events;

static void hx_stub_log(const char *m) { if (m) { hx_log_buf += m; hx_log_buf += '\n'; } }
static int  hx_stub_midi_internal(const uint8_t *m, int n) {
    hx_midi_event e; e.len = (n > 4) ? 4 : n; std::memset(e.bytes, 0, 4);
    std::memcpy(e.bytes, m, (size_t)e.len); hx_midi_events.push_back(e); return n;
}
static int  hx_stub_midi_external(const uint8_t *m, int n) { return hx_stub_midi_internal(m, n); }

static host_api_v1_t hx_make_host() {
    host_api_v1_t h; std::memset(&h, 0, sizeof(h));
    h.api_version       = MOVE_PLUGIN_API_VERSION_2;
    h.sample_rate       = MOVE_SAMPLE_RATE;
    h.frames_per_block  = MOVE_FRAMES_PER_BLOCK;
    h.log               = hx_stub_log;
    h.midi_send_internal = hx_stub_midi_internal;
    h.midi_send_external = hx_stub_midi_external;
    return h;
}

/* ---- harness instance ---- */
struct hx_t {
    plugin_api_v2_t *api;
    void *inst;
    std::vector<int16_t> audio;   /* interleaved L,R accumulated across hx_render */
};

static inline hx_t *hx_create(const char *module_dir, const char *json_defaults) {
    static host_api_v1_t host = hx_make_host();   /* must outlive plugin (g_host points at it) */
    static hx_t h;
    hx_log_buf.clear(); hx_midi_events.clear();
    h.api = move_plugin_init_v2(&host);
    if (!h.api) return nullptr;
    h.inst = h.api->create_instance(module_dir, json_defaults);
    h.audio.clear();
    return h.inst ? &h : nullptr;
}
static inline void hx_destroy(hx_t *h) { if (h && h->api && h->inst) h->api->destroy_instance(h->inst); }

static inline void hx_send_midi(hx_t *h, const uint8_t *msg, int len, int source) { h->api->on_midi(h->inst, msg, len, source); }
static inline void hx_set_param(hx_t *h, const char *key, const char *val) { h->api->set_param(h->inst, key, val); }
static inline int  hx_get_param(hx_t *h, const char *key, char *buf, int len) { return h->api->get_param(h->inst, key, buf, len); }

static inline void hx_render(hx_t *h, int n_blocks) {
    int16_t block[MOVE_FRAMES_PER_BLOCK * 2];
    for (int i = 0; i < n_blocks; i++) {
        std::memset(block, 0, sizeof(block));
        h->api->render_block(h->inst, block, MOVE_FRAMES_PER_BLOCK);
        h->audio.insert(h->audio.end(), block, block + MOVE_FRAMES_PER_BLOCK * 2);
    }
}

/* ---- audio capture + analysis ---- */
static inline void   hx_audio_clear(hx_t *h) { h->audio.clear(); }
static inline long   hx_audio_frames(hx_t *h) { return (long)(h->audio.size() / 2); }
static inline const int16_t *hx_audio_data(hx_t *h) { return h->audio.data(); }
static inline int    hx_audio_peak(hx_t *h) { int p = 0; for (int16_t s : h->audio) { int a = s < 0 ? -s : s; if (a > p) p = a; } return p; }
static inline double hx_audio_rms(hx_t *h) {
    if (h->audio.empty()) return 0.0; double acc = 0;
    for (int16_t s : h->audio) acc += (double)s * (double)s;
    return std::sqrt(acc / (double)h->audio.size());
}
static inline int    hx_audio_is_silent(hx_t *h, int threshold) { return hx_audio_peak(h) <= threshold; }
static inline double hx_audio_clip_ratio(hx_t *h) {
    if (h->audio.empty()) return 0.0; long c = 0;
    for (int16_t s : h->audio) if (s == 32767 || s == -32768) c++;
    return (double)c / (double)h->audio.size();
}

/* ---- golden compare / update ----
 * Returns 1 on pass (or after writing a baseline when OBXD_UPDATE_GOLDEN is set).
 * tol = max allowed absolute per-sample difference. */
static inline int hx_golden(hx_t *h, const char *path, int tol) {
    const int16_t *cur = hx_audio_data(h);
    size_t n = h->audio.size();
    if (std::getenv("OBXD_UPDATE_GOLDEN")) {
        FILE *f = std::fopen(path, "wb");
        if (!f) { std::fprintf(stderr, "golden: cannot write %s\n", path); return 0; }
        std::fwrite(cur, sizeof(int16_t), n, f); std::fclose(f);
        std::fprintf(stderr, "golden: updated %s (%zu samples)\n", path, n);
        return 1;
    }
    FILE *f = std::fopen(path, "rb");
    if (!f) { std::fprintf(stderr, "golden: missing baseline %s (run OBXD_UPDATE_GOLDEN=1 tests/run.sh)\n", path); return 0; }
    std::vector<int16_t> base; int16_t tmp;
    while (std::fread(&tmp, sizeof(int16_t), 1, f) == 1) base.push_back(tmp);
    std::fclose(f);
    if (base.size() != n) { std::fprintf(stderr, "golden: length mismatch base=%zu cur=%zu\n", base.size(), n); return 0; }
    int maxd = 0;
    for (size_t i = 0; i < n; i++) { int d = std::abs((int)cur[i] - (int)base[i]); if (d > maxd) maxd = d; }
    if (maxd > tol) { std::fprintf(stderr, "golden: max per-sample diff %d > tol %d\n", maxd, tol); return 0; }
    return 1;
}

#endif /* HX_HARNESS_HPP */
```

- [ ] **Step 2: Write the temporary probe `tests/harness/_probe.cpp`**

```cpp
/* tests/harness/_probe.cpp — TEMPORARY. Proves obxd_plugin.cpp compiles + links
 * natively and that a default-patch note produces non-silent audio. Deleted at
 * end of Task 1. */
#include "harness.hpp"

int main() {
    hx_t *h = hx_create(".", nullptr);
    if (!h) { std::printf("PROBE FAIL: create_instance NULL\n"); return 1; }
    hx_set_param(h, "volume", "80");
    hx_set_param(h, "cutoff", "80");
    hx_set_param(h, "sustain", "100");
    hx_set_param(h, "attack", "0");
    uint8_t on[3] = { 0x90, 60, 100 };
    hx_send_midi(h, on, 3, MOVE_MIDI_SOURCE_INTERNAL);
    hx_render(h, 64);
    std::printf("frames=%ld peak=%d rms=%.1f\n", hx_audio_frames(h), hx_audio_peak(h), hx_audio_rms(h));
    if (hx_audio_is_silent(h, 64)) { std::printf("PROBE FAIL: silent after note-on\n"); return 1; }
    hx_destroy(h);
    std::printf("PROBE OK\n");
    return 0;
}
```

- [ ] **Step 3: Compile and run the probe**

Run (from repo root `schwung-obxd/`):
```bash
clang++ -std=c++14 -Isrc/dsp -Itests/harness -Wall -Wno-unused-function -g \
  tests/harness/_probe.cpp -o /tmp/obxd_probe -lm && /tmp/obxd_probe
```
Expected: a `frames=8192 peak=<nonzero> rms=<nonzero>` line, then `PROBE OK`.

Contingency:
- If compilation fails with errors (the static scan found none, but this is the first real native build), fix only the harness side — do NOT modify anything under `src/dsp/`. If an error originates inside `src/dsp/`, STOP and report BLOCKED with the exact compiler error.
- If it prints `PROBE FAIL: silent`, the default patch may need a different param to be audible. Try also setting `osc1_saw` to `1` and `voice_count` to `1`, and raising `cutoff`. Adjust the probe's param sets until audio is non-silent, and carry the same working param set into Task 3's smoke test. If genuinely no param combination produces audio off-device, STOP and report DONE_WITH_CONCERNS with the observed `peak`/`rms`.

- [ ] **Step 4: Delete the probe and commit the header**

```bash
rm tests/harness/_probe.cpp
git add tests/harness/harness.hpp
git commit -m "test(harness): obxd white-box harness header (stub host, audio capture, golden)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017fZojSLfPB7Cpn4SLDh5Xh"
```

---

### Task 2: Test runner `run.sh`

**Files:**
- Create: `tests/run.sh`

- [ ] **Step 1: Write `tests/run.sh`**

```bash
#!/usr/bin/env bash
# Compile and run every tests/test_*.cpp natively. No Docker.
# OBXD_UPDATE_GOLDEN=1 tests/run.sh  -> regenerate golden baselines instead of asserting.
set -u
cd "$(dirname "$0")/.." || exit 2   # repo root (schwung-obxd/)

CXX="${CXX:-clang++}"
FLAGS="-std=c++14 -Isrc/dsp -Itests/harness -Wall -Wno-unused-function -g"
OUT="/tmp/obxd-tests"
mkdir -p "$OUT" tests/baseline

pass=0; fail=0
shopt -s nullglob
for t in tests/test_*.cpp; do
    name="$(basename "$t" .cpp)"
    bin="$OUT/$name"
    log="$OUT/$name.build.log"
    if ! $CXX $FLAGS "$t" -o "$bin" -lm 2> "$log"; then
        echo "BUILD FAIL: $name"; cat "$log"; fail=$((fail+1)); continue
    fi
    if "$bin"; then echo "PASS: $name"; pass=$((pass+1)); else echo "FAIL: $name"; fail=$((fail+1)); fi
done
echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Make executable; verify it runs with no tests yet**

Run:
```bash
chmod +x tests/run.sh && tests/run.sh; echo "exit=$?"
```
Expected: `0 passed, 0 failed` and `exit=0` (no `test_*.cpp` files yet; `nullglob` makes the empty glob expand to nothing).

- [ ] **Step 3: Commit**

```bash
git add tests/run.sh
git commit -m "test(harness): native clang++ test runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017fZojSLfPB7Cpn4SLDh5Xh"
```

---

### Task 3: Behavioral smoke test `test_smoke.cpp`

**Files:**
- Create: `tests/test_smoke.cpp`

- [ ] **Step 1: Write `tests/test_smoke.cpp`**

```cpp
/* tests/test_smoke.cpp — behavioral coverage: params, state round-trip, audio
 * sanity. Params are set explicitly to guarantee an audible, robust scenario
 * (not relying on whatever the default patch happens to be). */
#include "harness.hpp"

/* Set a known audible patch (native-int param contract; continuous = 0..100). */
static void audible_patch(hx_t *h) {
    hx_set_param(h, "volume",  "80");
    hx_set_param(h, "cutoff",  "90");
    hx_set_param(h, "attack",  "0");
    hx_set_param(h, "sustain", "100");
    hx_set_param(h, "release", "0");   /* fast release so note-off silences quickly */
}

int main() {
    hx_t *h = hx_create(".", nullptr);
    HX_ASSERT(h != nullptr, "hx_create returned NULL");

    /* --- param get/set --- */
    hx_set_param(h, "cutoff", "80");
    char pbuf[256];
    int pn = hx_get_param(h, "cutoff", pbuf, (int)sizeof(pbuf));
    HX_ASSERT(pn > 0, "get_param cutoff returned nothing");

    /* --- state round-trip (direct blob) --- */
    char st[65536];
    int sn = hx_get_param(h, "state", st, (int)sizeof(st));
    HX_ASSERT(sn > 0, "get_param state returned nothing");
    char saved[65536];
    HX_ASSERT((size_t)sn < sizeof(saved), "state larger than buffer");
    std::memcpy(saved, st, (size_t)sn); saved[sn] = '\0';
    hx_set_param(h, "state", saved);
    char st2[65536];
    int sn2 = hx_get_param(h, "state", st2, (int)sizeof(st2));
    HX_ASSERT(sn2 == sn && std::memcmp(st, st2, (size_t)sn) == 0,
              "state not stable across get/set round-trip");

    audible_patch(h);

    /* --- note-on -> non-silent, not pathologically clipped --- */
    hx_audio_clear(h);
    uint8_t on60[3]  = { 0x90, 60, 100 };
    uint8_t off60[3] = { 0x80, 60, 0 };
    hx_send_midi(h, on60, 3, MOVE_MIDI_SOURCE_INTERNAL);
    hx_render(h, 64);  /* ~186ms sustained */
    if (hx_audio_is_silent(h, 64)) {
        std::fprintf(stderr, "peak=%d rms=%.1f\nlog:\n%s\n",
                     hx_audio_peak(h), hx_audio_rms(h), hx_log_buf.c_str());
    }
    HX_ASSERT(!hx_audio_is_silent(h, 64), "expected non-silent audio while note held");
    HX_ASSERT(hx_audio_clip_ratio(h) < 0.5, "audio pathologically clipped (>50% railed)");

    /* --- different note -> different audio (capture both held tails) --- */
    std::vector<int16_t> a60(h->audio.begin(), h->audio.begin() + MOVE_FRAMES_PER_BLOCK * 2 * 16);
    hx_send_midi(h, off60, 3, MOVE_MIDI_SOURCE_INTERNAL);
    hx_render(h, 200);
    hx_audio_clear(h);
    uint8_t on72[3]  = { 0x90, 72, 100 };
    uint8_t off72[3] = { 0x80, 72, 0 };
    hx_send_midi(h, on72, 3, MOVE_MIDI_SOURCE_INTERNAL);
    hx_render(h, 16);
    std::vector<int16_t> a72(h->audio.begin(), h->audio.begin() + MOVE_FRAMES_PER_BLOCK * 2 * 16);
    HX_ASSERT(a60 != a72, "expected different audio for different notes");

    /* --- note-off + release -> eventually silent --- */
    hx_send_midi(h, off72, 3, MOVE_MIDI_SOURCE_INTERNAL);
    hx_render(h, 400);     /* let envelope release fully (release=0) */
    hx_audio_clear(h);
    hx_render(h, 64);      /* tail after release */
    HX_ASSERT(hx_audio_is_silent(h, 64), "expected silence after note-off + release");

    hx_destroy(h);
    std::printf("PASS: smoke (param, state round-trip, audio sanity)\n");
    return 0;
}
```

- [ ] **Step 2: Run the smoke test**

Run:
```bash
tests/run.sh
```
Expected: `PASS: test_smoke` and `1 passed, 0 failed`.

Contingency (only if an audio assertion fails):
- **Non-silent fails:** the diagnostic prints peak/rms/log. Apply the audible param combo that worked in Task 1's probe (e.g. also set `osc1_saw`=`1`, `voice_count`=`1`). Keep `audible_patch()` as the single source of truth for the patch.
- **"silence after note-off" fails:** the release tail is longer than expected. Confirm `release` `0` is applied; if needed increase the post-off render from `400` to e.g. `800` blocks. Do not weaken the other assertions.
- Do NOT modify anything under `src/dsp/`.

- [ ] **Step 3: Commit**

```bash
git add tests/test_smoke.cpp
git commit -m "test(harness): behavioral smoke test (params, state, audio sanity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017fZojSLfPB7Cpn4SLDh5Xh"
```

---

### Task 4: Golden-reference test `test_golden.cpp` + baseline

**Files:**
- Create: `tests/test_golden.cpp`
- Create: `tests/baseline/obxd_c4.s16` (generated)

- [ ] **Step 1: Write `tests/test_golden.cpp`**

```cpp
/* tests/test_golden.cpp — opt-in golden audio regression.
 * Gates on determinism first: OB-Xd's per-voice "analog drift" draws from an
 * RNG seeded by time() (Random::getSystemRandom in Engine/JuceCompat.h), so the
 * scenario zeroes all *_var params and disables unison, then verifies two fresh
 * instances render byte-identically before trusting a baseline.
 * Baseline is a macOS-native reference, NOT device parity. Regenerate with:
 *   OBXD_UPDATE_GOLDEN=1 tests/run.sh */
#include "harness.hpp"

static void render_scenario(hx_t *h) {
    /* deterministic: kill RNG-driven analog drift + unison spread */
    hx_set_param(h, "filter_var", "0");
    hx_set_param(h, "porta_var",  "0");
    hx_set_param(h, "env_var",    "0");
    hx_set_param(h, "level_var",  "0");
    hx_set_param(h, "unison",     "0");
    /* fixed audible patch */
    hx_set_param(h, "volume",  "80");
    hx_set_param(h, "cutoff",  "70");
    hx_set_param(h, "attack",  "0");
    hx_set_param(h, "sustain", "100");
    hx_set_param(h, "release", "0");

    hx_audio_clear(h);
    uint8_t on[3] = { 0x90, 60, 100 };   /* middle C, held */
    hx_send_midi(h, on, 3, MOVE_MIDI_SOURCE_INTERNAL);
    hx_render(h, 128);                    /* ~371ms */
}

int main() {
    /* determinism gate: two fresh instances must render identically */
    hx_t *h1 = hx_create(".", nullptr); HX_ASSERT(h1, "create h1");
    render_scenario(h1);
    std::vector<int16_t> a = h1->audio;
    hx_destroy(h1);

    hx_t *h2 = hx_create(".", nullptr); HX_ASSERT(h2, "create h2");
    render_scenario(h2);
    std::vector<int16_t> b = h2->audio;

    HX_ASSERT(a == b, "scenario not deterministic across instances (RNG/seed leak) — golden unsafe");

    /* golden compare (or update when OBXD_UPDATE_GOLDEN is set) */
    int ok = hx_golden(h2, "tests/baseline/obxd_c4.s16", 8);
    HX_ASSERT(ok, "golden mismatch or missing baseline (run OBXD_UPDATE_GOLDEN=1 tests/run.sh)");

    hx_destroy(h2);
    std::printf("PASS: golden (deterministic + matches baseline)\n");
    return 0;
}
```

- [ ] **Step 2: Verify determinism, then generate the baseline**

First confirm the determinism gate passes and the baseline is created:
```bash
OBXD_UPDATE_GOLDEN=1 tests/run.sh
```
Expected: a `golden: updated tests/baseline/obxd_c4.s16 (<N> samples)` line and `PASS: test_golden`. `<N>` should be `128 * 128 * 2 = 32768` samples.

Contingency: if it fails on `not deterministic across instances`, the analog-drift RNG is still leaking into the held-note scenario. Investigate `src/dsp/Engine/` for other `getSystemRandom()` users in the voice-trigger path and disable them via the relevant `*_var`/unison params; if a code path draws RNG unconditionally (not gated by a `*_var` amount), report DONE_WITH_CONCERNS — the golden surface may need a fixed-seed hook in `src/dsp/` (a host change, out of scope for this plan) and we fall back to behavioral-only for now. Do NOT modify `src/dsp/`.

- [ ] **Step 3: Verify the committed baseline now passes a normal run**

Run (no env var — real comparison):
```bash
tests/run.sh
```
Expected: `PASS: test_golden` and both tests green (`2 passed, 0 failed`).

- [ ] **Step 4: Commit the test and the baseline**

```bash
git add tests/test_golden.cpp tests/baseline/obxd_c4.s16
git commit -m "test(harness): golden audio regression with determinism gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017fZojSLfPB7Cpn4SLDh5Xh"
```

---

### Task 5: Docs + worklog

**Files:**
- Create: `tests/README.md`
- Modify: `../_worklogs/schwung-obxd.md` (workspace container; create if absent)
- Modify: `../_worklogs/OUTSTANDING.md` (cross-repo board)

- [ ] **Step 1: Write `tests/README.md`**

```markdown
# OB-Xd local DSP tests

Native (macOS, no Docker) harness for exercising the OB-Xd DSP off-device.
Design: `docs/superpowers/specs/2026-06-21-local-dsp-harness-design.md`.

## Run

    tests/run.sh                        # compile + run every tests/test_*.cpp
    OBXD_UPDATE_GOLDEN=1 tests/run.sh   # regenerate golden baseline(s)

Override the compiler with `CXX=...`. Build artifacts go to `/tmp/obxd-tests/`.

## How it works

- `tests/harness/harness.hpp` `#include`s the single `src/dsp/obxd_plugin.cpp`
  translation unit, so each test has white-box access to the engine and the
  inlined plugin/host ABI structs. It is header-only because obxd inlines those
  structs in the `.cpp` (no shared header to compile a stub against separately).
- The stub host wires `log` (captured) and the MIDI sends (captured); obxd only
  uses `log` at runtime.
- `hx_render()` accumulates rendered stereo int16 so tests can assert on audio:
  `hx_audio_rms/peak/is_silent/clip_ratio`, or `hx_golden()` for regression.

## Add a scenario

Create `tests/test_<name>.cpp`:

    #include "harness.hpp"
    int main() {
        hx_t *h = hx_create(".", nullptr);
        HX_ASSERT(h, "create failed");
        /* hx_set_param / hx_send_midi(... MOVE_MIDI_SOURCE_INTERNAL) / hx_render */
        /* assert: hx_audio_is_silent / hx_audio_peak / hx_golden(h, "tests/baseline/x.s16", 8) */
        hx_destroy(h);
        printf("PASS: <name>\n");
        return 0;
    }

`tests/run.sh` picks it up automatically.

## Golden baselines

Baselines under `tests/baseline/*.s16` are raw interleaved int16. They are
**macOS-native references, not device parity** — cross-compiler float results
differ, so they guard against host-side regressions only. Regenerate after an
intentional sound change with `OBXD_UPDATE_GOLDEN=1 tests/run.sh`, listen/verify,
then commit the updated `.s16`.

## obxd gotchas for test authors

- **Audio determinism:** per-voice analog drift draws from an RNG seeded by
  `time()` (`Engine/JuceCompat.h` `Random::getSystemRandom`). For golden tests,
  zero `filter_var`/`porta_var`/`env_var`/`level_var` and disable `unison`, and
  keep the two-instance determinism gate (see `test_golden.cpp`).
- **Params are native integers** (continuous = 0..100, toggles = 0..1). Set/get
  as decimal strings.
- **State round-trips directly:** `set_param("state", get_param("state"))` — no
  UUID/file indirection.
- **First-line check, not on-device:** stub host, no host/shim/SPI integration.
  Still verify on Move for anything hardware-related.
```

- [ ] **Step 2: Update the workspace worklog + board**

These live in the workspace container (`/Users/josh/schwung repos/_worklogs/`), NOT in the obxd repo. Read `/Users/josh/schwung repos/_worklogs/README.md` for format first.

(a) Prepend a dated (2026-06-21) entry to `/Users/josh/schwung repos/_worklogs/schwung-obxd.md` (newest on top; create with `# schwung-obxd worklog` heading if absent) recording: the local DSP test harness landed on branch `obxd-local-dsp-harness` — first synth port of the davebox pattern, native off-device (no Docker/deploy): header-only white-box harness over `obxd_plugin.cpp`, stub host, audio capture + analysis, `test_smoke` (param/state/audio sanity) and `test_golden` (determinism gate + golden regression). Link the spec and plan. Note the key obxd findings (header-only because ABI structs are inlined; audio RNG determinism handled by zeroing `*_var`/unison; native-int params; direct `state` blob). Note this is the first of two ports feeding the planned `schwung-dsp-testkit` extraction. Note the branch is unmerged.

(b) Update `/Users/josh/schwung repos/_worklogs/OUTSTANDING.md`: add a line under schwung-obxd noting the harness exists (branch `obxd-local-dsp-harness`, unmerged) and that the next step is extracting the shared `schwung-dsp-testkit` from davebox + obxd.

- [ ] **Step 3: Commit (obxd repo — README only)**

```bash
git add tests/README.md
git commit -m "docs(harness): README for the OB-Xd local DSP test harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017fZojSLfPB7Cpn4SLDh5Xh"
```

(The `_worklogs/` files are in the workspace container, not this repo — do not `git add` them here.)

---

## Verification (whole plan)

- [ ] `tests/run.sh` prints `2 passed, 0 failed` and exits 0.
- [ ] `OBXD_UPDATE_GOLDEN=1 tests/run.sh` regenerates `tests/baseline/obxd_c4.s16` and still passes.
- [ ] No changes were made under `src/dsp/`; host repo untouched.
- [ ] `git status` clean on branch `obxd-local-dsp-harness`; the temporary `_probe.cpp` is gone.
- [ ] Adding a new `tests/test_*.cpp` and re-running `tests/run.sh` picks it up with no other changes.

## Out of scope (do not build)

`.fxb` bank/preset-loading scenarios, MIDI-emission assertions (obxd emits none), cross-device golden parity, Docker/CI wiring, and the generic `schwung-dsp-testkit` extraction itself (the separate next project this port informs).
