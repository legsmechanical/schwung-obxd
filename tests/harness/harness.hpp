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
