(() => {
  'use strict';

  const CD = window.ColorDiff;
  const $ = (s) => document.querySelector(s);

  const stage = $('#stage');
  const view = $('#view');
  const vctx = view.getContext('2d');
  const loupe = $('#loupe');
  const lctx = loupe.getContext('2d');
  const resultsEl = $('#results');

  const MAX_SIDE = 4000; // downscale huge photos to keep memory sane
  const LOUPE_CELLS = 15; // source pixels across the loupe
  const LOUPE_W = 150;
  const LOUPE_H = 172;
  const COLORS = { A: '#ff4d6d', B: '#2fa8ff' };

  // Full-resolution pixels live here; the visible canvas is just a scaled view.
  const src = document.createElement('canvas');
  const sctx = src.getContext('2d', { willReadFrequently: true });

  // sRGB byte -> linear lookup, so sample averaging happens in linear light.
  const LIN = new Float64Array(256).map((_, i) => CD.toLinear(i));

  const state = {
    w: 0,
    h: 0,
    data: null,
    points: { A: null, B: null },
    target: 'A',
    radius: 2,
    fit: { s: 1, ox: 0, oy: 0 },
    drag: null,
    loupeAt: null, // {x, y, cx, cy} image + css coords
  };

  // ---------- Loading ----------

  function setImage(source, w, h) {
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const W = Math.max(1, Math.round(w * k));
    const H = Math.max(1, Math.round(h * k));
    src.width = W;
    src.height = H;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, W, H);
    state.data = sctx.getImageData(0, 0, W, H).data;
    state.w = W;
    state.h = H;
    state.points = { A: null, B: null };
    state.loupeAt = null;
    setTarget('A');
    $('#empty').hidden = true;
    stage.classList.add('has-image');
    layout();
  }

  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      setImage(img, img.naturalWidth, img.naturalHeight);
    } catch (err) {
      alert(`Couldn't open that image. Your browser may not support its format (for example, HEIC outside Safari).\n\n${err.message || err}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $('#fileInput').addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#captureInput').addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = '';
  });

  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  stage.addEventListener('dragover', (e) => {
    e.preventDefault();
    stage.classList.add('dragover');
  });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    loadFile(e.dataTransfer.files[0]);
  });

  // ---------- Camera ----------

  const camDialog = $('#camDialog');
  const video = $('#video');
  let stream = null;
  let facing = 'environment';

  async function startCamera() {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 4096 }, height: { ideal: 4096 } },
      audio: false,
    });
    video.srcObject = stream;
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  $('#cameraBtn').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#captureInput').click(); // e.g. insecure context: fall back to native picker
      return;
    }
    try {
      camDialog.showModal();
      await startCamera();
    } catch (err) {
      camDialog.close();
      $('#captureInput').click();
    }
  });
  $('#camFlip').addEventListener('click', () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    startCamera().catch((err) => alert(`Couldn't switch camera: ${err.message}`));
  });
  $('#camShoot').addEventListener('click', () => {
    if (!video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    camDialog.close();
    setImage(c, c.width, c.height);
  });
  $('#camCancel').addEventListener('click', () => camDialog.close());
  camDialog.addEventListener('close', stopCamera);

  // ---------- Layout & drawing ----------

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    if (state.w) {
      const width = stage.clientWidth;
      const maxH = window.innerWidth > 960 ? Math.max(260, window.innerHeight - 190) : window.innerHeight * 0.65;
      stage.style.height = Math.round(Math.min(maxH, (width * state.h) / state.w)) + 'px';
    }
    const r = stage.getBoundingClientRect();
    view.width = Math.round(r.width * dpr);
    view.height = Math.round(r.height * dpr);
    view.style.width = r.width + 'px';
    view.style.height = r.height + 'px';
    loupe.width = LOUPE_W * dpr;
    loupe.height = LOUPE_H * dpr;
    if (state.w) {
      const s = Math.min(r.width / state.w, r.height / state.h);
      state.fit = { s, ox: (r.width - state.w * s) / 2, oy: (r.height - state.h * s) / 2 };
    }
    render();
  }

  let raf = 0;
  let resultsDirty = true;
  // render(false) is for loupe-only updates (mouse hover) that don't change the results.
  function render(results = true) {
    if (results) resultsDirty = true;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
      drawLoupe();
      if (resultsDirty) {
        resultsDirty = false;
        renderResults();
      }
    });
  }

  function toScreen(p) {
    const { s, ox, oy } = state.fit;
    return { x: ox + (p.x + 0.5) * s, y: oy + (p.y + 0.5) * s };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, view.width, view.height);
    if (!state.w) return;
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { s, ox, oy } = state.fit;
    vctx.imageSmoothingEnabled = s < 1; // show crisp pixels when zoomed in
    vctx.drawImage(src, ox, oy, state.w * s, state.h * s);
    // Draw the selected marker last so it sits on top.
    const order = state.target === 'A' ? ['B', 'A'] : ['A', 'B'];
    for (const k of order) if (state.points[k]) drawMarker(k, state.points[k]);
  }

  function drawMarker(k, p) {
    const { x, y } = toScreen(p);
    const half = (state.radius + 0.5) * state.fit.s;
    const active = k === state.target;
    const c = vctx;
    c.save();

    // Sample area, when big enough to see
    if (half >= 3) {
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,.6)';
      c.strokeRect(x - half, y - half, half * 2, half * 2);
      c.lineWidth = 1;
      c.strokeStyle = '#fff';
      c.strokeRect(x - half, y - half, half * 2, half * 2);
    }

    // Ring with a gap in the middle so the sampled pixel stays visible
    const R = active ? 13 : 11;
    c.lineWidth = 5;
    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.beginPath();
    c.arc(x, y, R, 0, Math.PI * 2);
    c.stroke();
    c.lineWidth = active ? 3 : 2;
    c.strokeStyle = COLORS[k];
    c.beginPath();
    c.arc(x, y, R, 0, Math.PI * 2);
    c.stroke();

    // Crosshair ticks outside the ring
    c.lineWidth = 2;
    c.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      c.moveTo(x + dx * (R + 2), y + dy * (R + 2));
      c.lineTo(x + dx * (R + 7), y + dy * (R + 7));
    }
    c.stroke();

    // Label
    c.font = 'bold 12px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const lx = x + R + 10;
    const ly = y - R - 8;
    c.fillStyle = COLORS[k];
    c.beginPath();
    c.arc(lx, ly, 9, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.fillText(k, lx, ly + 0.5);
    c.restore();
  }

  function drawLoupe() {
    const q = state.loupeAt;
    if (!q || !state.w) {
      loupe.hidden = true;
      return;
    }
    loupe.hidden = false;
    // Keep the loupe away from the pointer.
    loupe.classList.toggle('right', q.cx < LOUPE_W + 40 && q.cy < LOUPE_H + 40);

    const dpr = window.devicePixelRatio || 1;
    const c = lctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, LOUPE_W, LOUPE_H);

    const n = LOUPE_CELLS;
    const cell = LOUPE_W / n;
    const half = (n - 1) / 2;
    const px = Math.floor(q.x);
    const py = Math.floor(q.y);
    c.imageSmoothingEnabled = false;
    // Clip the source rect to the image so edges render correctly.
    const sx0 = Math.max(0, px - half);
    const sy0 = Math.max(0, py - half);
    const sx1 = Math.min(state.w, px + half + 1);
    const sy1 = Math.min(state.h, py + half + 1);
    if (sx1 > sx0 && sy1 > sy0) {
      c.drawImage(
        src, sx0, sy0, sx1 - sx0, sy1 - sy0,
        (sx0 - (px - half)) * cell, (sy0 - (py - half)) * cell, (sx1 - sx0) * cell, (sy1 - sy0) * cell
      );
    }

    // Sample area + center pixel
    const r = Math.min(state.radius, half);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,.9)';
    c.strokeRect((half - r) * cell + 0.5, (half - r) * cell + 0.5, (2 * r + 1) * cell - 1, (2 * r + 1) * cell - 1);
    c.strokeStyle = 'rgba(0,0,0,.9)';
    c.strokeRect(half * cell - 0.5, half * cell - 0.5, cell + 1, cell + 1);

    // Readout
    const rgb = sample({ x: px, y: py });
    c.fillStyle = 'rgba(0,0,0,.85)';
    c.fillRect(0, LOUPE_W, LOUPE_W, LOUPE_H - LOUPE_W);
    c.fillStyle = CD.toHex(rgb);
    c.fillRect(6, LOUPE_W + 5, 12, 12);
    c.fillStyle = '#fff';
    c.font = '11px ui-monospace, Consolas, monospace';
    c.textBaseline = 'middle';
    c.fillText(`${CD.toHex(rgb)}  ${px},${py}`, 24, LOUPE_W + 11);
  }

  // ---------- Sampling ----------

  function sample(p) {
    const r = state.radius;
    const d = state.data;
    const W = state.w;
    let R = 0, G = 0, B = 0, n = 0;
    const y0 = Math.max(0, p.y - r), y1 = Math.min(state.h - 1, p.y + r);
    const x0 = Math.max(0, p.x - r), x1 = Math.min(W - 1, p.x + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        R += LIN[d[i]];
        G += LIN[d[i + 1]];
        B += LIN[d[i + 2]];
        n++;
      }
    }
    return [CD.fromLinear(R / n), CD.fromLinear(G / n), CD.fromLinear(B / n)];
  }

  // ---------- Interaction ----------

  function setTarget(k) {
    state.target = k;
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === k));
    render();
  }

  document.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => setTarget(b.dataset.target))
  );

  $('#radius').addEventListener('change', (e) => {
    state.radius = Number(e.target.value);
    render();
  });

  $('#swapBtn').addEventListener('click', () => {
    const { A, B } = state.points;
    state.points = { A: B, B: A };
    render();
  });

  $('#clearBtn').addEventListener('click', () => {
    state.points = { A: null, B: null };
    setTarget('A');
  });

  function pointerInfo(e) {
    const r = view.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const { s, ox, oy } = state.fit;
    return { cx, cy, x: (cx - ox) / s, y: (cy - oy) / s };
  }

  const clampPoint = (x, y) => ({
    x: Math.min(state.w - 1, Math.max(0, Math.floor(x))),
    y: Math.min(state.h - 1, Math.max(0, Math.floor(y))),
  });

  const inImage = (q) => q.x >= 0 && q.y >= 0 && q.x < state.w && q.y < state.h;

  function hitMarker(q, slop) {
    // Prefer the selected marker when the two overlap.
    const order = state.target === 'A' ? ['A', 'B'] : ['B', 'A'];
    for (const k of order) {
      const p = state.points[k];
      if (!p) continue;
      const s = toScreen(p);
      if (Math.hypot(s.x - q.cx, s.y - q.cy) <= slop) return k;
    }
    return null;
  }

  view.addEventListener('pointerdown', (e) => {
    if (!state.w || e.button > 0) return;
    const q = pointerInfo(e);
    const slop = e.pointerType === 'mouse' ? 16 : 30;
    let k = hitMarker(q, slop);
    const isNew = !k;
    let grabOffset = { x: 0, y: 0 };
    if (k) {
      // Keep the marker under the finger where it was grabbed (no jump).
      const p = state.points[k];
      grabOffset = { x: p.x + 0.5 - q.x, y: p.y + 0.5 - q.y };
    } else {
      if (!inImage(q)) return;
      k = state.target;
      state.points[k] = clampPoint(q.x, q.y);
    }
    state.drag = { key: k, id: e.pointerId, off: grabOffset };
    view.setPointerCapture(e.pointerId);
    setTarget(k);
    state.loupeAt = { ...state.points[k], cx: q.cx, cy: q.cy };
    // After placing A for the first time, B is the natural next point.
    if (isNew && k === 'A' && !state.points.B) state.drag.thenTarget = 'B';
    render();
  });

  view.addEventListener('pointermove', (e) => {
    if (!state.w) return;
    const q = pointerInfo(e);
    if (state.drag && state.drag.id === e.pointerId) {
      const p = clampPoint(q.x + state.drag.off.x, q.y + state.drag.off.y);
      state.points[state.drag.key] = p;
      state.loupeAt = { ...p, cx: q.cx, cy: q.cy };
      render();
    } else if (e.pointerType === 'mouse') {
      state.loupeAt = inImage(q) ? { x: q.x, y: q.y, cx: q.cx, cy: q.cy } : null;
      render(false);
    }
  });

  function endDrag(e) {
    if (!state.drag || state.drag.id !== e.pointerId) return;
    const next = state.drag.thenTarget;
    state.drag = null;
    if (e.pointerType !== 'mouse') state.loupeAt = null;
    if (next) setTarget(next);
    render();
  }
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('pointerleave', () => {
    if (!state.drag) {
      state.loupeAt = null;
      render(false);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!state.w || e.target.closest('input, select, textarea')) return;
    if (e.key === 'a' || e.key === 'A') return setTarget('A');
    if (e.key === 'b' || e.key === 'B') return setTarget('B');
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    const p = state.points[state.target];
    if (!d || !p) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    state.points[state.target] = clampPoint(p.x + d[0] * step, p.y + d[1] * step);
    render();
  });

  new ResizeObserver(() => layout()).observe(stage.parentElement);
  window.addEventListener('resize', layout);

  // ---------- Results ----------

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const f = (v, d = 1) => v.toFixed(d);

  function fmtValue(it) {
    if (it.value === null || it.value === undefined) return 'n/a';
    if (typeof it.value === 'string') return it.value;
    const v = it.value;
    const s = (it.sign && v > 0 ? '+' : '') + v.toFixed(it.digits ?? 2);
    return s + (it.unit || '');
  }

  function swatchHtml(k, p) {
    if (!p) {
      return `<div class="sw"><div class="chip empty-chip"><span class="tag ${k}">${k}</span></div>
        <dl><dt>—</dt><dd>${k === state.target ? 'Click the image to place' : 'Not placed'}</dd></dl></div>`;
    }
    const c = CD.analyze(sample(p));
    const [L, a, b] = c.lab;
    const [oL, oC, oh] = c.oklch;
    return `<div class="sw">
      <div class="chip" style="background:${c.hex}"><span class="tag ${k}">${k}</span></div>
      <dl>
        <dt>Hex</dt><dd>${c.hex}</dd>
        <dt>RGB</dt><dd>${c.rgb.map((v) => f(v, 0)).join(', ')}</dd>
        <dt>Lab</dt><dd>${f(L)}, ${f(a)}, ${f(b)}</dd>
        <dt>LCh</dt><dd>${f(c.lch[0])}, ${f(c.lch[1])}, ${f(c.lch[2])}°</dd>
        <dt>OKLCh</dt><dd>${f(oL * 100)}%, ${f(oC, 3)}, ${f(oh)}°</dd>
        <dt>HSL</dt><dd>${f(c.hs.h, 0)}°, ${f(c.hs.sl * 100, 0)}%, ${f(c.hs.l * 100, 0)}%</dd>
        <dt>Pixel</dt><dd>${p.x}, ${p.y}</dd>
      </dl></div>`;
  }

  let lastResult = null;

  function renderResults() {
    if (!state.w) {
      resultsEl.innerHTML = `<p class="placeholder">Open a photo, then pick two points to compare their colors.</p>`;
      return;
    }
    const { A, B } = state.points;
    let html = `<div class="swatches">${swatchHtml('A', A)}${swatchHtml('B', B)}</div>`;

    if (A && B) {
      const res = CD.compare(sample(A), sample(B));
      lastResult = res;
      // Log-ish scale so small differences are readable: 0, 1, 2, 10, 50, 100
      const pos = Math.min(100, (Math.log1p(res.de00) / Math.log1p(100)) * 100);
      html += `
        <div class="strip"><div style="background:${res.A.hex}"></div><div style="background:${res.B.hex}"></div></div>
        <div class="headline">
          <div class="big"><small>ΔE₀₀</small>${res.de00.toFixed(2)}</div>
          <div class="verdict">${esc(res.verdict)}</div>
          <div class="scale"><div class="pin" style="left:${pos}%"></div></div>
          <div class="scale-labels"><span>0</span><span>1</span><span>2</span><span>10</span><span>50</span><span>100</span></div>
        </div>`;
      for (const g of res.groups) {
        html += `<section class="group"><h3>${esc(g.title)}</h3><table>`;
        for (const it of g.items) {
          html += `<tr><td class="name">${esc(it.name)}${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}</td>
            <td class="val">${esc(fmtValue(it))}</td></tr>`;
        }
        html += `</table></section>`;
      }
      html += `<div class="row-actions"><button class="btn small" id="copyBtn" type="button">Copy results</button></div>`;
    } else {
      lastResult = null;
    }
    resultsEl.innerHTML = html;
  }

  resultsEl.addEventListener('click', async (e) => {
    if (!e.target.closest('#copyBtn') || !lastResult) return;
    const r = lastResult;
    const lines = [
      `A\t${r.A.hex}\trgb(${r.A.rgb.map((v) => f(v, 0)).join(', ')})`,
      `B\t${r.B.hex}\trgb(${r.B.rgb.map((v) => f(v, 0)).join(', ')})`,
      `Sample\t${2 * state.radius + 1}×${2 * state.radius + 1} px`,
      '',
    ];
    for (const g of r.groups) {
      lines.push(`# ${g.title}`);
      for (const it of g.items) lines.push(`${it.name}\t${fmtValue(it)}`);
      lines.push('');
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      e.target.textContent = 'Copied ✓';
      setTimeout(() => (e.target.textContent = 'Copy results'), 1500);
    } catch {
      alert(lines.join('\n'));
    }
  });

  layout();
})();
