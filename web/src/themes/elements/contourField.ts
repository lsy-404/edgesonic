// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Endfield's background: a flat 2D "calibration route matrix" — quantized
// elevation contour lines over a noise field, staggered top-band-first
// reveal. Standalone gradient-noise + marching-squares extraction (the same
// generic technique other topographic-line tools use); no 3D terrain, no
// rivers/markers, no shared code or assets with anything else.

type Rgb = [number, number, number];

class Noise2D {
  private perm: Uint8Array;
  constructor(seed: number) {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  private static fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
  private static grad(hash: number, x: number, y: number) {
    switch (hash & 7) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x; case 5: return -x; case 6: return y; default: return -y;
    }
  }
  noise(x: number, y: number): number {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = Noise2D.fade(xf), v = Noise2D.fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1], ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const x1 = lerp(Noise2D.grad(aa, xf, yf), Noise2D.grad(ba, xf - 1, yf), u);
    const x2 = lerp(Noise2D.grad(ab, xf, yf - 1), Noise2D.grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }
}

function fbm(n: Noise2D, x: number, y: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) { sum += n.noise(x * freq, y * freq) * amp; freq *= 2; amp *= 0.5; }
  return sum;
}

type Segment = [[number, number], [number, number]];

// marching squares: returns grid-space segment endpoint pairs for iso-level t.
function contourSegments(field: Float32Array, N: number, t: number): Segment[] {
  const segs: Segment[] = [];
  const at = (i: number, j: number) => field[j * (N + 1) + i];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const h00 = at(i, j), h10 = at(i + 1, j), h11 = at(i + 1, j + 1), h01 = at(i, j + 1);
      const id = (h00 > t ? 1 : 0) | (h10 > t ? 2 : 0) | (h11 > t ? 4 : 0) | (h01 > t ? 8 : 0);
      if (id === 0 || id === 15) continue;
      const lerpF = (a: number, b: number) => (t - a) / (b - a);
      const T: [number, number] = [i + lerpF(h00, h10), j];
      const R: [number, number] = [i + 1, j + lerpF(h10, h11)];
      const B: [number, number] = [i + lerpF(h01, h11), j + 1];
      const L: [number, number] = [i, j + lerpF(h00, h01)];
      const push = (a: [number, number], b: [number, number]) => segs.push([a, b]);
      switch (id) {
        case 1: case 14: push(L, T); break;
        case 2: case 13: push(T, R); break;
        case 3: case 12: push(L, R); break;
        case 4: case 11: push(R, B); break;
        case 6: case 9: push(T, B); break;
        case 7: case 8: push(L, B); break;
        case 5: { const c = (h00 + h10 + h11 + h01) / 4; if (c > t) { push(T, R); push(B, L); } else { push(L, T); push(R, B); } break; }
        case 10: { const c = (h00 + h10 + h11 + h01) / 4; if (c > t) { push(L, T); push(R, B); } else { push(T, R); push(B, L); } break; }
      }
    }
  }
  return segs;
}

interface Band { segs: Segment[]; strokeStyle: string; delayMs: number; }

export interface ContourFieldOptions {
  /** Low-elevation band colour (outer/common rings). */
  colorLow: Rgb;
  /** High-elevation band colour (inner/rare rings). */
  colorHigh: Rgb;
  levels?: number;
  gridSize?: number;
  seed?: number;
}

const REVEAL_MS = 520;
const REVEAL_STAGGER_MS = 90;
const BREATHE_S = 6.4;

// Full revolution period for the slow ambient rotation — a real contour/
// terrain map, not a static line drawing (see .contour-canvas in
// elements.css). Pure CSS animation: cheap, GPU-composited, independent of
// the JS reveal/breathe draw loop below.
const ROTATE_PERIOD_S = 200;

export function mountContourField(host: HTMLElement, options: ContourFieldOptions): () => void {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reuses .el-bg (atmospheric --deco-a/b/c gradient wash, shared by every SP
  // theme) — its own `overflow: hidden` is what clips the oversized rotating
  // square below back down to the viewport rect.
  const wrap = document.createElement("div");
  wrap.className = "el-bg";
  wrap.setAttribute("aria-hidden", "true");
  const canvas = document.createElement("canvas");
  canvas.className = "contour-canvas";
  if (!reduce) {
    canvas.classList.add("is-spinning");
    canvas.style.animationDuration = `${ROTATE_PERIOD_S}s`;
  }
  wrap.appendChild(canvas);
  host.appendChild(wrap);
  const remove = () => wrap.remove();

  const ctx = canvas.getContext("2d");
  if (!ctx) return remove;

  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const N = options.gridSize ?? 96;
  const levels = options.levels ?? 12;
  const noise = new Noise2D(options.seed ?? 1337);

  const field = new Float32Array((N + 1) * (N + 1));
  let min = Infinity, max = -Infinity;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const v = fbm(noise, (i / N) * 3.2, (j / N) * 3.2);
      field[j * (N + 1) + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const rgb = (c: Rgb) => `${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)}`;
  const bands: Band[] = [];
  for (let li = 0; li < levels; li++) {
    const mix = li / Math.max(1, levels - 1);
    const t = min + (max - min) * ((li + 0.5) / levels);
    const segs = contourSegments(field, N, t);
    if (!segs.length) continue;
    const lo = options.colorLow, hi = options.colorHigh;
    const blended: Rgb = [lo[0] + (hi[0] - lo[0]) * mix, lo[1] + (hi[1] - lo[1]) * mix, lo[2] + (hi[2] - lo[2]) * mix];
    // Highest bands (rarest) reveal first, mirroring a top-down survey scan.
    bands.push({ segs, strokeStyle: `rgb(${rgb(blended)})`, delayMs: (levels - 1 - li) * REVEAL_STAGGER_MS });
  }

  // Square, sized well past the viewport's diagonal and centered by CSS: at
  // any rotation angle the square still fully covers the rectangular
  // viewport. The extra margin (beyond a flat top-down field's plain
  // diagonal) covers the perspective tilt's foreshortening — the CSS
  // rotateX(52deg) compresses the plane's reach along one axis, and
  // perspective projection compresses it non-uniformly toward the horizon,
  // so a pure cos(tilt) correction is only an approximation.
  const TILT_OVERSIZE = 1.9;
  let side = 0;
  function resize() {
    side = Math.ceil(Math.hypot(window.innerWidth, window.innerHeight) * TILT_OVERSIZE);
    canvas.style.width = `${side}px`;
    canvas.style.height = `${side}px`;
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  function draw(revealFrac: number, breathe: number) {
    ctx!.clearRect(0, 0, side, side);
    ctx!.lineWidth = 1;
    for (const band of bands) {
      const local = Math.max(0, Math.min(1, (revealFrac - band.delayMs) / REVEAL_MS));
      if (local <= 0) continue;
      ctx!.globalAlpha = local * 0.5 * breathe;
      ctx!.strokeStyle = band.strokeStyle;
      ctx!.beginPath();
      for (const [[ax, ay], [bx, by]] of band.segs) {
        ctx!.moveTo((ax / N) * side, (ay / N) * side);
        ctx!.lineTo((bx / N) * side, (by / N) * side);
      }
      ctx!.stroke();
    }
    ctx!.globalAlpha = 1;
  }

  if (reduce) {
    draw(Number.POSITIVE_INFINITY, 1);
    return () => { window.removeEventListener("resize", resize); remove(); };
  }

  const startedAt = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    const elapsed = now - startedAt;
    const totalReveal = REVEAL_MS + (levels - 1) * REVEAL_STAGGER_MS;
    const breathe = elapsed < totalReveal ? 1 : 0.82 + 0.18 * Math.sin(((elapsed - totalReveal) / 1000 / BREATHE_S) * Math.PI * 2);
    draw(elapsed, breathe);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    remove();
  };
}
