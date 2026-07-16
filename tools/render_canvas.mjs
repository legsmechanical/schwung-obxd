// Off-device renderer for src/canvas.js (the bank_editor canvas overlay).
// Builds a real 128x64 1-bit framebuffer ctx, evals canvas.js, and renders each
// bank (plus the SHIFT section-nav overlay) to a single stacked PNG so the
// layout can be eyeballed without a device. Node-only; no deps (uses zlib).
// Ported from schwung-echidna/tools/render_canvas.mjs.
//   node tools/render_canvas.mjs [outfile.png]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "canvas.js"), "utf8");
(0, eval)(src);
const be = globalThis.bank_editor, T = be._test;

const W = 128, H = 64;
function makeCtx(init = {}) {
  const store = Object.assign({}, T.DEFAULTS, init);
  const fb = new Uint8Array(W * H); // 0/1 per pixel
  const px = (x, y, v) => { x |= 0; y |= 0; if (x >= 0 && x < W && y >= 0 && y < H) fb[y * W + x] = v ? 1 : 0; };
  return {
    fb, width: W, height: H, state: { init: true, bank: 0, lastKnob: -1, accum: [0, 0, 0, 0, 0, 0, 0, 0], shift: false, jogTouch: false },
    getParam(k) { return Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null; },
    setParam(k, v) { store[k] = parseInt(v, 10); },
    getValue: () => "0", setValue: () => {},
    setPixel: (x, y, v) => px(x, y, v),
    fillRect: (x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, v); },
    drawRect: (x, y, w, h, v) => { for (let i = 0; i < w; i++) { px(x + i, y, v); px(x + i, y + h - 1, v); } for (let j = 0; j < h; j++) { px(x, y + j, v); px(x + w - 1, y + j, v); } },
    // print/measureText are overridden by draw() with the pixel font.
    print() {}, measureText: (s) => String(s).length * 6
  };
}

function renderBank(bankIdx, { shift = false, lastKnob = -1, init = {} } = {}) {
  const ctx = makeCtx(init);
  be.draw(ctx);                 // installs font+cache; first frame
  ctx.fb.fill(0);
  ctx.state.bank = bankIdx; ctx.state.lastKnob = lastKnob; ctx.state.shift = shift;
  be.draw(ctx);
  return ctx.fb;
}

// ---- compose all frames into one tall image (scaled) -----------------------
const SCALE = 3, GAP = 6;
const frames = [];
for (let b = 0; b < T.BANKS.length; b++) frames.push({ fb: renderBank(b), name: T.BANKS[b].label });
frames.push({ fb: renderBank(6, { lastKnob: 1 }), name: "Amp Env (Decay touched)" });
frames.push({ fb: renderBank(11, { lastKnob: 2, init: { pan_3: 80 } }), name: "Pan (V3 touched, panned R)" });
frames.push({ fb: renderBank(0, { shift: true }), name: "SHIFT section navigator (overlay)" });

const rows = frames.length;
const cellW = W * SCALE, cellH = H * SCALE;
const imgW = cellW + 2 * GAP;
const imgH = rows * (cellH + GAP) + GAP;
const img = Buffer.alloc(imgW * imgH * 4, 0);
for (let i = 0; i < imgW * imgH; i++) { img[i * 4] = 30; img[i * 4 + 1] = 30; img[i * 4 + 2] = 34; img[i * 4 + 3] = 255; }
frames.forEach((f, idx) => {
  const oy = GAP + idx * (cellH + GAP), ox = GAP;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const on = f.fb[y * W + x];
    const r = on ? 235 : 10, g = on ? 235 : 12, b = on ? 240 : 16;
    for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
      const px = ox + x * SCALE + sx, py = oy + y * SCALE + sy;
      const o = (py * imgW + px) * 4;
      img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
    }
  }
});

// ---- minimal PNG encoder (RGBA, zlib deflate) ------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(imgW, 0); ihdr.writeUInt32BE(imgH, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(imgH * (1 + imgW * 4));
for (let y = 0; y < imgH; y++) { raw[y * (1 + imgW * 4)] = 0; img.copy(raw, y * (1 + imgW * 4) + 1, y * imgW * 4, (y + 1) * imgW * 4); }
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
]);
const out = process.argv[2] || join(here, "..", "canvas_preview.png");
writeFileSync(out, png);
console.log("wrote", out, `(${imgW}x${imgH}, ${frames.length} frames)`);
frames.forEach((f, i) => console.log(`  frame ${i}: ${f.name}`));
