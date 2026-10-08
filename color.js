/*
 * Color math for Color Diff.
 * Input colors are sRGB triples in 0..255 (floats allowed, e.g. averaged samples).
 * Works as a browser global (window.ColorDiff) or as a CommonJS module (for tests).
 */
(function (root) {
  'use strict';

  const RAD = Math.PI / 180;
  const D65 = [0.95047, 1.0, 1.08883];
  const EPS = 216 / 24389;
  const KAPPA = 24389 / 27;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sq = (v) => v * v;

  // Shortest angular distance between two hues, 0..180.
  function hueDistance(h1, h2) {
    const d = Math.abs(h1 - h2) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Signed hue change from h1 to h2, in (-180, 180].
  function hueDelta(h1, h2) {
    let d = h2 - h1;
    if (d > 180) d -= 360;
    else if (d <= -180) d += 360;
    return d;
  }

  // ---------- Conversions ----------

  function toLinear(v) {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function fromLinear(c) {
    c = clamp(c, 0, 1);
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return v * 255;
  }

  function toHex(rgb) {
    return '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  }

  function linToXyz([r, g, b]) {
    return [
      0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
      0.2126729 * r + 0.7151522 * g + 0.072175 * b,
      0.0193339 * r + 0.119192 * g + 0.9503041 * b,
    ];
  }

  function xyzToLab([x, y, z]) {
    const f = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
    const fx = f(x / D65[0]);
    const fy = f(y / D65[1]);
    const fz = f(z / D65[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function xyzToLuv([x, y, z]) {
    const yr = y / D65[1];
    const L = yr > EPS ? 116 * Math.cbrt(yr) - 16 : KAPPA * yr;
    const d = x + 15 * y + 3 * z;
    if (d === 0) return [L, 0, 0];
    const dn = D65[0] + 15 * D65[1] + 3 * D65[2];
    const un = (4 * D65[0]) / dn;
    const vn = (9 * D65[1]) / dn;
    return [L, 13 * L * ((4 * x) / d - un), 13 * L * ((9 * y) / d - vn)];
  }

  // [L, a, b] -> [L, C, h°]
  function toPolar([L, a, b]) {
    const C = Math.hypot(a, b);
    let h = Math.atan2(b, a) / RAD;
    if (h < 0) h += 360;
    return [L, C, h];
  }

  // Björn Ottosson's OKLab, from linear sRGB.
  function linToOklab([r, g, b]) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  // SMPTE ST 2084 (PQ) inverse EOTF; y is luminance / 10000 cd/m².
  function pq(y) {
    const m1 = 2610 / 16384;
    const m2 = (2523 / 4096) * 128;
    const c1 = 3424 / 4096;
    const c2 = (2413 / 4096) * 32;
    const c3 = (2392 / 4096) * 32;
    const p = Math.pow(Math.max(y, 0), m1);
    return Math.pow((c1 + c2 * p) / (1 + c3 * p), m2);
  }

  // ICtCp (BT.2100 PQ) from linear sRGB, with display white at `white` cd/m².
  function linToIctcp([r, g, b], white = 100) {
    // BT.709 -> BT.2020 primaries (same D65 white)
    const R = 0.627403895934699 * r + 0.329283038377884 * g + 0.043313065687417 * b;
    const G = 0.069097289358232 * r + 0.919540395075459 * g + 0.011362315566309 * b;
    const B = 0.01639143887515 * r + 0.088013307877226 * g + 0.895595253247624 * b;
    const k = white / 10000;
    const L = pq((k * (1688 * R + 2146 * G + 262 * B)) / 4096);
    const M = pq((k * (683 * R + 2951 * G + 462 * B)) / 4096);
    const S = pq((k * (99 * R + 309 * G + 3688 * B)) / 4096);
    return [
      0.5 * L + 0.5 * M,
      (6610 * L - 13613 * M + 7003 * S) / 4096,
      (17933 * L - 17390 * M - 543 * S) / 4096,
    ];
  }

  // HSV and HSL in one pass. h in degrees, s/v/l in 0..1, chroma in 0..1.
  function rgbToHsx([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const l = (max + min) / 2;
    return {
      h,
      chroma: d,
      sv: max === 0 ? 0 : d / max,
      v: max,
      sl: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)),
      l,
    };
  }

  function analyze(rgb) {
    const lin = rgb.map(toLinear);
    const xyz = linToXyz(lin);
    const lab = xyzToLab(xyz);
    const oklab = linToOklab(lin);
    return {
      rgb,
      hex: toHex(rgb),
      lin,
      xyz,
      Y: xyz[1],
      lab,
      lch: toPolar(lab),
      luv: xyzToLuv(xyz),
      oklab,
      oklch: toPolar(oklab),
      ictcp: linToIctcp(lin),
      hs: rgbToHsx(rgb),
    };
  }

  // ---------- Difference formulas ----------

  function deltaE76(l1, l2) {
    return Math.hypot(l1[0] - l2[0], l1[1] - l2[1], l1[2] - l2[2]);
  }

  // CIE94, graphic-arts weights. Asymmetric: l1 is the reference.
  function deltaE94(l1, l2, kL = 1, K1 = 0.045, K2 = 0.015) {
    const dL = l1[0] - l2[0];
    const C1 = Math.hypot(l1[1], l1[2]);
    const C2 = Math.hypot(l2[1], l2[2]);
    const dC = C1 - C2;
    const dH2 = Math.max(0, sq(l1[1] - l2[1]) + sq(l1[2] - l2[2]) - sq(dC));
    const SC = 1 + K1 * C1;
    const SH = 1 + K2 * C1;
    return Math.sqrt(sq(dL / kL) + sq(dC / SC) + dH2 / sq(SH));
  }

  // CIEDE2000 (Sharma, Wu & Dalal 2005 implementation notes).
  function deltaE2000(l1, l2, kL = 1, kC = 1, kH = 1) {
    const [L1, a1, b1] = l1;
    const [L2, a2, b2] = l2;
    const P25 = Math.pow(25, 7);
    const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + P25)));
    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1);
    const C2p = Math.hypot(a2p, b2);
    const hp = (b, a) => {
      if (a === 0 && b === 0) return 0;
      const h = Math.atan2(b, a) / RAD;
      return h < 0 ? h + 360 : h;
    };
    const h1p = hp(b1, a1p);
    const h2p = hp(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

    const Lbp = (L1 + L2) / 2;
    const Cbp = (C1p + C2p) / 2;
    let hbp;
    if (C1p * C2p === 0) hbp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
    else hbp = (h1p + h2p - 360) / 2;

    const T =
      1 -
      0.17 * Math.cos((hbp - 30) * RAD) +
      0.24 * Math.cos(2 * hbp * RAD) +
      0.32 * Math.cos((3 * hbp + 6) * RAD) -
      0.2 * Math.cos((4 * hbp - 63) * RAD);
    const dTheta = 30 * Math.exp(-sq((hbp - 275) / 25));
    const RC = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + P25));
    const SL = 1 + (0.015 * sq(Lbp - 50)) / Math.sqrt(20 + sq(Lbp - 50));
    const SC = 1 + 0.045 * Cbp;
    const SH = 1 + 0.015 * Cbp * T;
    const RT = -Math.sin(2 * dTheta * RAD) * RC;

    const tL = dLp / (kL * SL);
    const tC = dCp / (kC * SC);
    const tH = dHp / (kH * SH);
    return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
  }

  // CMC l:c (1984). Asymmetric: l1 is the reference.
  function deltaECMC(l1, l2, l = 2, c = 1) {
    const [L1, a1, b1] = l1;
    const [L2, a2, b2] = l2;
    const C1 = Math.hypot(a1, b1);
    const C2 = Math.hypot(a2, b2);
    const dL = L1 - L2;
    const dC = C1 - C2;
    const dH2 = Math.max(0, sq(a1 - a2) + sq(b1 - b2) - sq(dC));
    let H1 = Math.atan2(b1, a1) / RAD;
    if (H1 < 0) H1 += 360;
    const C14 = Math.pow(C1, 4);
    const F = Math.sqrt(C14 / (C14 + 1900));
    const T =
      H1 >= 164 && H1 <= 345
        ? 0.56 + Math.abs(0.2 * Math.cos((H1 + 168) * RAD))
        : 0.36 + Math.abs(0.4 * Math.cos((H1 + 35) * RAD));
    const SL = L1 < 16 ? 0.511 : (0.040975 * L1) / (1 + 0.01765 * L1);
    const SC = (0.0638 * C1) / (1 + 0.0131 * C1) + 0.638;
    const SH = SC * (F * T + 1 - F);
    return Math.sqrt(sq(dL / (l * SL)) + sq(dC / (c * SC)) + dH2 / sq(SH));
  }

  // ITU-R BT.2124 ΔE_ITP. 1.0 ≈ one just-noticeable difference.
  function deltaEITP(i1, i2) {
    return 720 * Math.sqrt(sq(i1[0] - i2[0]) + sq(0.5 * (i1[1] - i2[1])) + sq(i1[2] - i2[2]));
  }

  // WCAG 2.x contrast ratio from relative luminance.
  function contrastRatio(Y1, Y2) {
    const hi = Math.max(Y1, Y2);
    const lo = Math.min(Y1, Y2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // APCA (0.0.98G-4g) lightness contrast, text color on background color.
  function apca(txt, bg) {
    const lum = (c) => {
      const Y =
        0.2126729 * Math.pow(c[0] / 255, 2.4) +
        0.7151522 * Math.pow(c[1] / 255, 2.4) +
        0.072175 * Math.pow(c[2] / 255, 2.4);
      return Y < 0.022 ? Y + Math.pow(0.022 - Y, 1.414) : Y;
    };
    const Yt = lum(txt);
    const Yb = lum(bg);
    if (Math.abs(Yb - Yt) < 0.0005) return 0;
    if (Yb > Yt) {
      const s = (Math.pow(Yb, 0.56) - Math.pow(Yt, 0.57)) * 1.14;
      return s < 0.1 ? 0 : (s - 0.027) * 100;
    }
    const s = (Math.pow(Yb, 0.65) - Math.pow(Yt, 0.62)) * 1.14;
    return s > -0.1 ? 0 : (s + 0.027) * 100;
  }

  function verdict(de00) {
    if (de00 < 1) return 'Not perceptible to the human eye';
    if (de00 < 2) return 'Perceptible on close observation';
    if (de00 < 10) return 'Perceptible at a glance';
    if (de00 < 50) return 'Clearly different, but more similar than opposite';
    return 'Very different';
  }

  // ---------- Full comparison ----------

  function compare(rgbA, rgbB) {
    const A = analyze(rgbA);
    const B = analyze(rgbB);
    const de00 = deltaE2000(A.lab, B.lab);

    const [dR, dG, dB] = [0, 1, 2].map((i) => B.rgb[i] - A.rgb[i]);
    const rmean = (A.rgb[0] + B.rgb[0]) / 2;
    const redmean = Math.sqrt(
      (2 + rmean / 256) * dR * dR + 4 * dG * dG + (2 + (255 - rmean) / 256) * dB * dB
    );
    const rgbEuclid = Math.hypot(dR, dG, dB);

    // CIELAB components, B relative to A
    const dL = B.lab[0] - A.lab[0];
    const dC = B.lch[1] - A.lch[1];
    const chromaticLab = A.lch[1] > 0.5 && B.lch[1] > 0.5;
    const dh = chromaticLab ? hueDelta(A.lch[2], B.lch[2]) : null;
    const dHmag = Math.sqrt(
      Math.max(0, sq(B.lab[1] - A.lab[1]) + sq(B.lab[2] - A.lab[2]) - dC * dC)
    );
    const dH = dh === null ? dHmag : Math.sign(dh || 1) * dHmag;

    const chromaticOk = A.oklch[1] > 0.002 && B.oklch[1] > 0.002;
    const chromaticHsv = A.hs.chroma * 255 > 0.5 && B.hs.chroma * 255 > 0.5;

    const pct = (v) => v * 100;

    const groups = [
      {
        title: 'CIE ΔE formulas (CIELAB, D65)',
        items: [
          { name: 'ΔE₀₀ — CIEDE2000', value: de00, digits: 2, note: 'Current CIE standard. ≈1 is a just-noticeable difference.' },
          { name: 'ΔE₉₄ — CIE94 (graphic arts)', value: deltaE94(A.lab, B.lab), digits: 2, note: 'Weights chroma and hue by A’s chroma. Asymmetric: A is the reference.' },
          { name: 'ΔE CMC 2:1 (acceptability)', value: deltaECMC(A.lab, B.lab, 2, 1), digits: 2, note: 'Textile industry. Tolerates lightness differences more. A is the reference.' },
          { name: 'ΔE CMC 1:1 (perceptibility)', value: deltaECMC(A.lab, B.lab, 1, 1), digits: 2, note: 'Same formula with equal lightness and chroma weight.' },
          { name: 'ΔE*ab — CIE76', value: deltaE76(A.lab, B.lab), digits: 2, note: 'Straight-line distance in L*a*b*. Simple, but overstates differences in saturated colors.' },
          { name: 'ΔE*uv — CIELUV', value: deltaE76(A.luv, B.luv), digits: 2, note: 'Straight-line distance in L*u*v*, which is common for lights and displays.' },
        ],
      },
      {
        title: 'Modern uniform spaces',
        items: [
          { name: 'ΔE OK — OKLab (×100)', value: 100 * deltaE76(A.oklab, B.oklab), digits: 2, note: 'Distance in OKLab, the space CSS Color 4 uses. ≈2 is a just-noticeable difference.' },
          { name: 'ΔE ITP — ITU-R BT.2124', value: deltaEITP(A.ictcp, B.ictcp), digits: 2, note: 'ICtCp space from HDR/video work. 1 ≈ one JND. Assumes a 100 cd/m² white.' },
          { name: 'ΔL (OKLab lightness)', value: pct(B.oklab[0] - A.oklab[0]), digits: 2, sign: true, unit: '%', note: 'Positive means B is lighter.' },
          { name: 'ΔC (OKLCh chroma)', value: B.oklch[1] - A.oklch[1], digits: 4, sign: true, note: 'Positive means B is more colorful.' },
          { name: 'Δh (OKLCh hue)', value: chromaticOk ? hueDelta(A.oklch[2], B.oklch[2]) : null, digits: 1, sign: true, unit: '°', note: 'n/a when either color is gray.' },
        ],
      },
      {
        title: 'CIELAB components (B − A)',
        items: [
          { name: 'ΔL* lightness', value: dL, digits: 2, sign: true, note: 'Positive means B is lighter.' },
          { name: 'Δa* green ↔ red', value: B.lab[1] - A.lab[1], digits: 2, sign: true, note: 'Positive means B is redder.' },
          { name: 'Δb* blue ↔ yellow', value: B.lab[2] - A.lab[2], digits: 2, sign: true, note: 'Positive means B is yellower.' },
          { name: 'ΔC*ab chroma', value: dC, digits: 2, sign: true, note: 'Positive means B is more saturated.' },
          { name: 'ΔH*ab hue (metric)', value: dH, digits: 2, sign: true, note: 'Hue difference in ΔE units, so ΔE76² = ΔL² + ΔC² + ΔH².' },
          { name: 'Δh_ab hue angle', value: dh, digits: 1, sign: true, unit: '°', note: 'n/a when either color is near gray.' },
        ],
      },
      {
        title: 'RGB-based',
        items: [
          { name: 'Euclidean sRGB', value: rgbEuclid, digits: 2, note: `Range 0–441.7, so this is ${(100 * rgbEuclid / 441.673).toFixed(1)}% of the maximum. Not perceptual.` },
          { name: 'Weighted “redmean”', value: redmean, digits: 2, note: 'Cheap approximation of perceived difference (range 0–765).' },
          { name: 'Euclidean linear RGB', value: Math.hypot(...[0, 1, 2].map((i) => B.lin[i] - A.lin[i])), digits: 4, note: 'Distance in physical light (range 0–1.732).' },
          { name: 'Max channel difference', value: Math.max(Math.abs(dR), Math.abs(dG), Math.abs(dB)), digits: 1, note: 'Chebyshev distance (range 0–255).' },
          { name: 'ΔR / ΔG / ΔB', value: [dR, dG, dB].map((v) => (v >= 0 ? '+' : '') + v.toFixed(1)).join(' / '), note: 'Change in each channel, B − A.' },
        ],
      },
      {
        title: 'HSV / HSL',
        items: [
          { name: 'Δ hue', value: chromaticHsv ? hueDelta(A.hs.h, B.hs.h) : null, digits: 1, sign: true, unit: '°', note: 'Shortest path around the hue wheel. n/a for grays.' },
          { name: 'Δ saturation (HSV)', value: pct(B.hs.sv - A.hs.sv), digits: 1, sign: true, unit: '%' },
          { name: 'Δ value (HSV)', value: pct(B.hs.v - A.hs.v), digits: 1, sign: true, unit: '%' },
          { name: 'Δ saturation (HSL)', value: pct(B.hs.sl - A.hs.sl), digits: 1, sign: true, unit: '%' },
          { name: 'Δ lightness (HSL)', value: pct(B.hs.l - A.hs.l), digits: 1, sign: true, unit: '%' },
        ],
      },
      {
        title: 'Luminance & contrast',
        items: [
          { name: 'Relative luminance Y', value: `${A.Y.toFixed(4)} → ${B.Y.toFixed(4)}`, note: 'CIE Y, where 0 is black and 1 is white.' },
          { name: 'ΔY', value: B.Y - A.Y, digits: 4, sign: true, note: `B emits ${A.Y > 0 ? ((B.Y / A.Y) * 100).toFixed(1) + '%' : '∞'} of A’s luminance.` },
          { name: 'WCAG 2 contrast ratio', value: contrastRatio(A.Y, B.Y), digits: 2, unit: ':1', note: 'Text needs 4.5 (AA) or 7 (AAA). Large text needs 3.' },
          { name: 'APCA Lc (A text on B)', value: apca(A.rgb, B.rgb), digits: 1, sign: true, note: 'WCAG 3 draft. |Lc| 60 suits body text and 75 is preferred.' },
          { name: 'APCA Lc (B text on A)', value: apca(B.rgb, A.rgb), digits: 1, sign: true, note: 'APCA is polarity-aware, so the two directions differ.' },
        ],
      },
    ];

    return { A, B, de00, verdict: verdict(de00), groups };
  }

  const api = {
    toLinear, fromLinear, toHex, linToXyz, xyzToLab, xyzToLuv, toPolar, linToOklab, linToIctcp, rgbToHsx,
    analyze, deltaE76, deltaE94, deltaE2000, deltaECMC, deltaEITP, contrastRatio, apca, hueDistance, compare,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ColorDiff = api;
})(typeof window !== 'undefined' ? window : this);
