/* tests/test_smoke.cpp — behavioral coverage: params, state round-trip, audio
 * sanity. Params are set explicitly to guarantee an audible, robust scenario
 * (not relying on whatever the default patch happens to be). */
#include "harness.hpp"

/* Set a known audible patch (native-int param contract; continuous = 0..100).
 * brightness is MANDATORY: v2_init_default_patch never calls processBrightness(),
 * leaving a ~1 Hz lowpass that silences the default patch (found in Task 1). */
static void audible_patch(hx_t *h) {
    hx_set_param(h, "brightness", "100");  /* REQUIRED — default patch is silent without it */
    hx_set_param(h, "osc1_saw",   "1");
    hx_set_param(h, "osc1_mix",   "100");
    hx_set_param(h, "volume",     "100");
    hx_set_param(h, "cutoff",     "90");
    hx_set_param(h, "attack",     "0");
    hx_set_param(h, "sustain",    "100");
    hx_set_param(h, "release",    "0");   /* fast release so note-off silences quickly */
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
