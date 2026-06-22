# OB-Xd local DSP tests

Native (macOS, no Docker) harness for exercising the OB-Xd DSP off-device.
Design: `docs/superpowers/specs/2026-06-21-local-dsp-harness-design.md`.

## Run

    tests/run.sh        # compile + run every tests/test_*.cpp, print PASS/FAIL

Override the compiler with `CXX=...`. Build artifacts go to `/tmp/obxd-tests/`.

## How it works

- `tests/harness/harness.hpp` `#include`s the single `src/dsp/obxd_plugin.cpp`
  translation unit, so each test has white-box access to the engine and the
  inlined plugin/host ABI structs. It is header-only because obxd inlines those
  structs in the `.cpp` (no shared header to compile a stub against separately).
- The stub host wires `log` (captured) and the MIDI sends (captured); obxd only
  uses `log` at runtime.
- `hx_render()` accumulates rendered stereo int16 so tests can assert on audio:
  `hx_audio_rms/peak/is_silent/clip_ratio`.

## Add a scenario

Create `tests/test_<name>.cpp`:

    #include "harness.hpp"
    int main() {
        hx_t *h = hx_create(".", nullptr);
        HX_ASSERT(h, "create failed");
        /* set an AUDIBLE patch (see gotchas), then:
           hx_send_midi(h, msg, 3, MOVE_MIDI_SOURCE_INTERNAL); hx_render(h, N);
           assert with hx_audio_is_silent / hx_audio_peak / ... */
        hx_destroy(h);
        printf("PASS: <name>\n");
        return 0;
    }

`tests/run.sh` picks it up automatically.

## obxd gotchas for test authors

- **The default patch is SILENT.** `v2_init_default_patch` never calls
  `processBrightness()`, leaving a ~1 Hz lowpass on the oscillator output. Any
  test that wants audio MUST set `brightness` (e.g. `100`) plus oscillator params
  (`osc1_saw`=`1`, `osc1_mix`=`100`). See `audible_patch()` in `test_smoke.cpp`.
- **Params are native integers** (continuous = 0..100, toggles = 0..1). Set/get
  as decimal strings.
- **State round-trips directly:** `set_param("state", get_param("state"))` — no
  UUID/file indirection.
- **First-line check, not on-device:** stub host, no host/shim/SPI integration.
  Still verify on Move for anything hardware-related.

## Golden audio regression — deferred (not shipped)

Golden-reference audio comparison is intentionally NOT included for OB-Xd. The
engine adds unconditional per-sample RNG noise — filter-cutoff noise
(`Engine/ObxdVoice.h:203`) and oscillator pitch "dirt" hardcoded to 0.1
(`Engine/ObxdOscillatorB.h:165,208`) — seeded from `Random::getSystemRandom()`
(`Engine/JuceCompat.h:71`, seeded by `time()`). No exposed parameter disables it,
so rendered audio is not reproducible run-to-run (two instances diverged by a max
of 4111 over 32768 samples). `getSystemRandom()` is also a process-global static,
so a fixed seed alone would not make instances match without per-instance reset.

A deterministic golden would require a fixed-seed hook in `src/dsp/` (e.g. a
test-only constant seed for the per-voice/per-osc RNG, with reset per instance).
Until that lands, OB-Xd audio testing is behavioral-only (`test_smoke.cpp`). The
`hx_golden()` helper remains in the harness for modules/synths that are
deterministic.
