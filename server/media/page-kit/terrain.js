/*
 * ChandraTerrain — a walkable world in a canvas. No network, no WebGL: a heightfield drawn column by column in the
 * "voxel space" manner (front to back, one height buffer per screen column), so it runs in any browser and in a
 * headless one with no graphics card.
 *
 *   ChandraTerrain.generate(spec)          -> { size, h: Uint8Array, rgb: Uint8Array, water }   (pure; Node can run it)
 *   ChandraTerrain.mount(canvas, spec, o)  -> { state(), step(ms, keys), setMode('walk'|'fly'), destroy() }
 *
 * spec: { name, seed, elevation 0.3–2, water 0–0.6, rugged 0–1, island bool, fog 0–1, sky:[top, bottom],
 *         palette:{ water, shore, ground, rock, snow }, landmarks:[{ name, kind, x, z (-1..1), color }], start:{x,z},
 *         data?:{ size, heights: base64 Uint8 size², colours: base64 RGB size² } (a world read from a picture) }
 * kinds: tower, peak, plaza, bridge, ruin, depot.  Controls: W/S or arrows move, A/D turn, drag to look, F walk/fly,
 * Space/Shift up/down while flying, on-screen buttons on touch screens.  window.__chandraWorld is the live handle
 * (used by the page check to walk and read the position).
 */
(function (root) {
  'use strict';
  var N_DEFAULT = 256;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hexRgb(h) { h = String(h || '#888888').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var n = parseInt(h, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function hash(x, y, s) { var h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
  function vnoise(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    var a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  function fbm(x, y, s, oct) { var v = 0, amp = 0.5, f = 1, tot = 0; for (var i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f, s + i * 17); tot += amp; amp *= 0.5; f *= 2; } return v / tot; }
  function b64ToBytes(s) { var bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary'); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

  var DEFAULT_PALETTE = { water: '#2f6fb3', shore: '#d9c38a', ground: '#5f9e4f', rock: '#7c7468', snow: '#f2f4f7' };

  /** Heights and colours for a spec. Deterministic: the same spec always gives the same world. */
  function generate(spec) {
    spec = spec || {};
    var pal = {}, k; var P = spec.palette || {};
    for (k in DEFAULT_PALETTE) pal[k] = hexRgb(P[k] || DEFAULT_PALETTE[k]);
    // a missing ground colour comes from the spec's own shore and rock, not a stock green (a desert came out green)
    if (!P.ground && (P.shore || P.rock)) pal.ground = mix(hexRgb(P.shore || P.rock), hexRgb(P.rock || P.shore), 0.35);
    var water = clamp(spec.water == null ? 0.28 : +spec.water, 0, 0.6);
    var N, h, rgb, i, x, y;
    if (spec.data && spec.data.heights) {
      N = spec.data.size; h = b64ToBytes(spec.data.heights);
      rgb = spec.data.colours ? b64ToBytes(spec.data.colours) : null;
    } else {
      N = N_DEFAULT; h = new Uint8Array(N * N);
      var seed = (spec.seed | 0) || 7, rug = clamp(spec.rugged == null ? 0.4 : +spec.rugged, 0, 1), f = new Float32Array(N * N), mn = 1e9, mx = -1e9;
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        var u = x / N * 4, v = y / N * 4;
        var base = fbm(u, v, seed, 5), ridge = 1 - Math.abs(2 * fbm(u * 1.7 + 9, v * 1.7 + 3, seed + 99, 4) - 1);
        var val = base * (1 - rug) + ridge * ridge * rug;
        // an island sinks smoothly toward the edge (no clamp: a third of the map at exactly 0 left the water line nowhere to go)
        if (spec.island) { var dx = x / N - 0.5, dy = y / N - 0.5, d = Math.sqrt(dx * dx + dy * dy) * 2; val = val * clamp(1.25 - d * d * 1.4, 0.05, 1) - d * d * 0.35; }
        f[y * N + x] = val;
      }
      var lms = spec.landmarks || [];
      for (var li = 0; li < lms.length; li++) {
        var L = lms[li], cx = (clamp(L.x, -1, 1) * 0.42 + 0.5) * N, cz = (clamp(L.z, -1, 1) * 0.42 + 0.5) * N;
        var r = L.kind === 'peak' ? N * 0.09 : N * 0.035, rr = r * r * 2;
        var local = f[(cz | 0) * N + (cx | 0)];
        for (y = Math.max(0, cz - r * 2 | 0); y < Math.min(N, cz + r * 2); y++) for (x = Math.max(0, cx - r * 2 | 0); x < Math.min(N, cx + r * 2); x++) {
          var g = Math.exp(-((x - cx) * (x - cx) + (y - cz) * (y - cz)) / rr);
          var o = y * N + x;
          if (L.kind === 'peak') f[o] += g * 0.45;
          else f[o] = f[o] * (1 - g) + Math.max(local, water + 0.06) * g;   // a flat place to stand for anything built
        }
      }
      for (i = 0; i < f.length; i++) { if (f[i] < mn) mn = f[i]; if (f[i] > mx) mx = f[i]; }
      for (i = 0; i < f.length; i++) h[i] = Math.round((f[i] - mn) / (mx - mn || 1) * 255);
    }
    // `water` is the share of the land under water: the water line is set at that share of the heights (a histogram
    // quantile), not at a fixed height — an island's falloff would otherwise drown most of it
    var hist = new Uint32Array(256); for (i = 0; i < h.length; i++) hist[h[i]]++;
    var want = water * h.length, acc = 0, wq = 0; for (wq = 0; wq < 256 && acc + hist[wq] <= want; wq++) acc += hist[wq];
    water = water <= 0 ? 0 : Math.max(0, wq - 1) / 255;
    if (!rgb) {
      rgb = new Uint8Array(N * N * 3);
      var wl = water * 255, sun = [-0.55, 0.62, 0.55];
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        var o2 = y * N + x, hv = h[o2];
        var hx = h[y * N + Math.min(N - 1, x + 1)] - h[y * N + Math.max(0, x - 1)], hy = h[Math.min(N - 1, y + 1) * N + x] - h[Math.max(0, y - 1) * N + x];
        var nx = -hx / 255 * 6, ny = 1, nz = -hy / 255 * 6, nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        var light = clamp(0.58 + 0.5 * (nx * sun[0] + ny * sun[1] + nz * sun[2]) / nl, 0.35, 1.15);
        var slope = Math.sqrt(hx * hx + hy * hy) / 255, rel = (hv - wl) / Math.max(1, 255 - wl), c;
        if (hv <= wl) c = mix(pal.water, [10, 25, 50], clamp((wl - hv) / 90, 0, 0.7));
        else if (rel < 0.035) c = pal.shore;
        else if (rel > 0.82 && P.snow !== null) c = pal.snow;
        else if (rel > 0.58 || slope > 0.16) c = mix(pal.ground, pal.rock, clamp(Math.max((rel - 0.58) / 0.2, (slope - 0.16) / 0.12), 0, 1));
        else c = pal.ground;
        var jit = 0.94 + hash(x, y, 5) * 0.12, lt = hv <= wl ? 1 : light * jit;
        rgb[o2 * 3] = clamp(c[0] * lt, 0, 255); rgb[o2 * 3 + 1] = clamp(c[1] * lt, 0, 255); rgb[o2 * 3 + 2] = clamp(c[2] * lt, 0, 255);
      }
    }
    return { size: N, h: h, rgb: rgb, water: water };
  }

  /** Landmark shapes: for a column u (0..1 across the sprite) the [bottom, top] it fills, as fractions of its height. */
  var SHAPES = {
    tower: function (u) { return u > 0.36 && u < 0.64 ? [0, 1] : u > 0.28 && u < 0.72 ? [0.84, 0.96] : null; },
    peak: function (u) { return u > 0.46 && u < 0.52 ? [0, 1] : u >= 0.52 && u < 0.86 ? [0.62 + (u - 0.52) * 0.3, 1 - (u - 0.52) * 0.3] : null; },
    plaza: function (u) { return u > 0.04 && u < 0.96 ? [0, 0.16 + 0.06 * Math.sin(u * 9)] : null; },
    bridge: function (u) { return u < 0.08 || u > 0.92 ? [0, 0.55] : [0.42, 0.55]; },
    ruin: function (u) { return u < 0.18 ? [0, 0.7] : u > 0.4 && u < 0.58 ? [0, 1] : u > 0.82 ? [0, 0.45] : u >= 0.18 && u < 0.82 ? [0, 0.12] : null; },
    depot: function (u) { return u > 0.12 && u < 0.88 ? [0, u > 0.3 && u < 0.7 ? 0.62 : 0.5] : null; },
  };

  function mount(canvas, spec, opts) {
    opts = opts || {};
    var W0 = generate(spec), N = W0.size, H8 = W0.h, RGB = W0.rgb, WL = W0.water * 255;
    // map height byte -> world units. 0.32 made the land a third of the map tall and every first view a wall of slope;
    // 0.13 keeps the tallest land at about an eighth of the map's width (elevation 1)
    var elev = clamp(spec.elevation == null ? 1 : +spec.elevation, 0.3, 2), HS = 0.13 * elev;
    var fogAmt = clamp(spec.fog == null ? 0.35 : +spec.fog, 0, 1), sky = (spec.sky || ['#7fb6ff', '#dfefff']).map(hexRgb);
    var ctx = canvas.getContext('2d'), buf = document.createElement('canvas'), bctx = buf.getContext('2d');
    var Bw = 0, Bh = 0, img, px, ybuf;
    var marks = (spec.landmarks || []).map(function (L) { return { name: String(L.name || ''), kind: SHAPES[L.kind] ? L.kind : 'tower', x: (clamp(L.x, -1, 1) * 0.42 + 0.5) * N, z: (clamp(L.z, -1, 1) * 0.42 + 0.5) * N, rgb: hexRgb(L.color || '#f4a261') }; });
    var st = spec.start || { x: 0, z: 0.6 };
    var cam = { x: (clamp(st.x, -1, 1) * 0.42 + 0.5) * N, z: (clamp(st.z, -1, 1) * 0.42 + 0.5) * N, yaw: Math.PI, pitch: 0, y: 0, mode: 'walk' };
    var keys = {}, touched = false, last = 0, raf = 0, t = 0, visibleLabels = [];
    function groundAt(x, z) {
      x = clamp(x, 0, N - 1.001); z = clamp(z, 0, N - 1.001);
      var ix = x | 0, iz = z | 0, fx = x - ix, fz = z - iz, i = iz * N + ix;
      var a = Math.max(H8[i], WL), b = Math.max(H8[i + 1], WL), c = Math.max(H8[i + N], WL), d = Math.max(H8[i + N + 1], WL);
      return ((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz) * HS;
    }
    var EYE = 5.5;
    // start on land, facing into the world: the first world began at the shore looking out to sea
    (function () {
      var cx = N / 2, cz = N / 2;
      for (var s = 0; s < 40 && H8[(cam.z | 0) * N + (cam.x | 0)] <= WL + 4; s++) { cam.x += (cx - cam.x) * 0.08; cam.z += (cz - cam.z) * 0.08; }
      // of 16 headings, face the most open one that still looks across land: the steepest ground within 40 units
      // ahead should not rise above the eye (a wall of slope), and some of the next 90 units should be land
      var eye = groundAt(cam.x, cam.z) + EYE, bestYaw = cam.yaw, bestScore = -1e9;
      for (var k = 0; k < 16; k++) {
        var yaw = k / 16 * Math.PI * 2, fx = -Math.sin(yaw), fz = -Math.cos(yaw), worst = -1e9, land = 0;
        for (var d = 4; d <= 90; d += 3) {
          var x = cam.x + fx * d, z = cam.z + fz * d;
          if (x < 0 || z < 0 || x >= N || z >= N) break;
          if (d <= 40) worst = Math.max(worst, (groundAt(x, z) - eye) / d);
          if (H8[(z | 0) * N + (x | 0)] > WL) land++;
        }
        var toMid = Math.cos(yaw - Math.atan2(-(N / 2 - cam.x), -(N / 2 - cam.z)));
        var score = -Math.max(0, worst) * 8 + Math.min(land, 20) * 0.05 + toMid * 0.2;
        if (score > bestScore) { bestScore = score; bestYaw = yaw; }
      }
      cam.yaw = bestYaw;
    })();
    cam.y = groundAt(cam.x, cam.z) + EYE;
    var landShare = 0;
    function resize() {
      var r = canvas.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
      canvas.width = Math.max(320, (r.width || 960) * dpr | 0); canvas.height = Math.max(200, (r.height || 540) * dpr | 0);
      Bw = Math.min(560, canvas.width / 2 | 0); Bh = Math.round(Bw * canvas.height / canvas.width);
      buf.width = Bw; buf.height = Bh; img = bctx.createImageData(Bw, Bh); px = new Uint32Array(img.data.buffer); ybuf = new Float32Array(Bw);
    }
    function pack(r, g, b) { return (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255); }
    function render() {
      var horizon = Bh * 0.42 + cam.pitch * Bh, far = N * 0.95, scaleH = Bh * 1.15, sn = Math.sin(cam.yaw), cs = Math.cos(cam.yaw);
      var x, y, i;
      for (y = 0; y < Bh; y++) { var s = clamp(y / Bh, 0, 1), c = mix(sky[0], sky[1], s), p = pack(c[0], c[1], c[2]); for (x = 0; x < Bw; x++) px[y * Bw + x] = p; }
      for (i = 0; i < Bw; i++) ybuf[i] = Bh;
      // landmarks in front of the camera, by depth, so they are drawn as the sweep passes their distance
      var queue = [];
      for (var m = 0; m < marks.length; m++) {
        var L = marks[m], dx = L.x - cam.x, dz = L.z - cam.z;
        var depth = -dx * sn - dz * cs, side = dx * cs - dz * sn;
        if (depth > 2) queue.push({ L: L, depth: depth, sx: (side / depth * 0.5 + 0.5) * Bw, base: groundAt(L.x, L.z) });
      }
      queue.sort(function (a, b) { return a.depth - b.depth; });
      visibleLabels = [];
      var qi = 0, z = 1, dzs = 0.25, shimmer = t * 0.002, landPx = 0;
      while (z < far) {
        while (qi < queue.length && queue[qi].depth <= z) { drawMark(queue[qi], horizon, scaleH, far); qi++; }
        var lx = -cs * z - sn * z, lz = sn * z - cs * z, rx = cs * z - sn * z, rz = -sn * z - cs * z;
        var plx = cam.x + lx, plz = cam.z + lz, ddx = (rx - lx) / Bw, ddz = (rz - lz) / Bw, inv = scaleH / z, fog = clamp(z / far, 0, 1) * fogAmt * 1.6;
        var near = z < 48;                       // close up, one map cell spans many columns: blend cells, not blocks
        for (i = 0; i < Bw; i++, plx += ddx, plz += ddz) {
          var mx = plx | 0, mz = plz | 0, hv, o;
          if (mx < 0 || mz < 0 || mx >= N || mz >= N) { hv = WL; o = -1; }
          else {
            o = mz * N + mx; hv = H8[o];
            if (near && mx < N - 1 && mz < N - 1) { var fx = plx - mx, fz = plz - mz; hv = (H8[o] * (1 - fx) + H8[o + 1] * fx) * (1 - fz) + (H8[o + N] * (1 - fx) + H8[o + N + 1] * fx) * fz; }
          }
          var wet = hv <= WL; if (wet) hv = WL;
          var top = (cam.y - hv * HS) * inv + horizon;
          if (top < ybuf[i]) {
            var r, g, b;
            if (o < 0) { r = 40; g = 90; b = 150; } else { r = RGB[o * 3]; g = RGB[o * 3 + 1]; b = RGB[o * 3 + 2]; }
            if (wet) { var w = 0.9 + 0.1 * Math.sin(mx * 0.7 + mz * 0.5 + shimmer * 6); r *= w; g *= w; b *= w + 0.04; }
            var fs = fog > 1 ? 1 : fog, sc = mix(sky[1], sky[0], 0.25);
            r = r + (sc[0] - r) * fs; g = g + (sc[1] - g) * fs; b = b + (sc[2] - b) * fs;
            var p2 = pack(r, g, b), y0 = top < 0 ? 0 : top | 0, y1 = ybuf[i] | 0;
            for (y = y0; y < y1; y++) px[y * Bw + i] = p2;
            if (!wet && y1 > y0) landPx += y1 - y0;
            ybuf[i] = top;
          }
        }
        z += dzs; dzs += 0.006;
      }
      landShare = landPx / (Bw * Bh);
      bctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
      overlay();
    }
    function drawMark(q, horizon, scaleH, far) {
      var L = q.L, inv = scaleH / q.depth, size = 9 * elev + 6, hpx = size * 2.2 * inv, wpx = size * 1.4 * inv;
      if (L.kind === 'plaza' || L.kind === 'bridge') { wpx *= 2.4; hpx *= 0.6; }
      var baseY = (cam.y - q.base) * inv + horizon, x0 = q.sx - wpx / 2, fog = clamp(q.depth / far, 0, 1) * fogAmt * 1.6, sc = mix(sky[1], sky[0], 0.25);
      var shape = SHAPES[L.kind], seen = false;
      for (var c = Math.max(0, x0 | 0); c < Math.min(Bw, x0 + wpx); c++) {
        var u = (c - x0) / wpx, span = shape(u); if (!span) continue;
        var ya = baseY - span[1] * hpx, yb = baseY - span[0] * hpx, lim = ybuf[c], shade = 0.72 + 0.28 * (1 - Math.abs(u - 0.4) * 1.6);
        var r = L.rgb[0] * shade, g = L.rgb[1] * shade, b = L.rgb[2] * shade, fs = Math.min(1, fog);
        r += (sc[0] - r) * fs; g += (sc[1] - g) * fs; b += (sc[2] - b) * fs;
        var p = pack(r, g, b);
        for (var y = Math.max(0, ya | 0); y < Math.min(lim, yb); y++) { px[y * Bw + c] = p; seen = true; }
      }
      if (seen && q.depth < far * 0.7) visibleLabels.push({ name: L.name, x: q.sx / Bw, y: (baseY - hpx) / Bh, d: q.depth });
    }
    function overlay() {
      var W = canvas.width, H = canvas.height, s = W / 960;
      ctx.font = '600 ' + Math.round(13 * s) + 'px system-ui, sans-serif'; ctx.textAlign = 'center';
      for (var i = 0; i < visibleLabels.length; i++) {
        var v = visibleLabels[i], tx = v.x * W, ty = Math.max(18 * s, v.y * H - 8 * s);
        ctx.fillStyle = 'rgba(10,14,24,0.55)'; var tw = ctx.measureText(v.name).width + 12 * s; ctx.fillRect(tx - tw / 2, ty - 15 * s, tw, 20 * s);
        ctx.fillStyle = '#fff'; ctx.fillText(v.name, tx, ty);
      }
      // minimap: the colour map, the landmarks, you
      var mm = Math.round(Math.min(150, W * 0.16)), mx0 = W - mm - 12 * s, my0 = 12 * s;
      if (!overlay.map) { var mc = document.createElement('canvas'); mc.width = N; mc.height = N; var mctx = mc.getContext('2d'), mi = mctx.createImageData(N, N); for (var k = 0; k < N * N; k++) { mi.data[k * 4] = RGB[k * 3]; mi.data[k * 4 + 1] = RGB[k * 3 + 1]; mi.data[k * 4 + 2] = RGB[k * 3 + 2]; mi.data[k * 4 + 3] = 255; } mctx.putImageData(mi, 0, 0); overlay.map = mc; }
      ctx.globalAlpha = 0.9; ctx.drawImage(overlay.map, mx0, my0, mm, mm); ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5 * s; ctx.strokeRect(mx0, my0, mm, mm);
      for (var j = 0; j < marks.length; j++) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(mx0 + marks[j].x / N * mm, my0 + marks[j].z / N * mm, 2.5 * s, 0, 7); ctx.fill(); }
      var ppx = mx0 + cam.x / N * mm, ppz = my0 + cam.z / N * mm;
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.moveTo(ppx - Math.sin(cam.yaw) * 7 * s, ppz - Math.cos(cam.yaw) * 7 * s); ctx.lineTo(ppx + Math.cos(cam.yaw) * 3.5 * s, ppz - Math.sin(cam.yaw) * 3.5 * s); ctx.lineTo(ppx - Math.cos(cam.yaw) * 3.5 * s, ppz + Math.sin(cam.yaw) * 3.5 * s); ctx.fill();
    }
    function step(ms, k) {
      k = k || keys; var dt = Math.min(0.1, ms / 1000), speed = (cam.mode === 'fly' ? 26 : 12) * dt, turn = 1.6 * dt;
      var moved = false;
      if (k.left) { cam.yaw += turn; moved = true; } if (k.right) { cam.yaw -= turn; moved = true; }
      var fwd = (k.up ? 1 : 0) - (k.down ? 1 : 0);
      if (fwd) { cam.x = clamp(cam.x - Math.sin(cam.yaw) * speed * fwd, 1, N - 2); cam.z = clamp(cam.z - Math.cos(cam.yaw) * speed * fwd, 1, N - 2); moved = true; }
      var g = groundAt(cam.x, cam.z);
      if (cam.mode === 'fly') { if (k.rise) cam.y += speed * 1.2; if (k.sink) cam.y -= speed * 1.2; cam.y = Math.max(cam.y, g + EYE); }
      else cam.y += (g + EYE - cam.y) * Math.min(1, dt * 10);
      if (!touched && !moved) cam.yaw += 0.12 * dt;          // a slow look around until someone takes the controls
      return moved;
    }
    function loop(now) { var ms = last ? now - last : 16; last = now; t = now; step(ms); render(); raf = root.requestAnimationFrame(loop); }
    var KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'rise', ShiftLeft: 'sink', ShiftRight: 'sink' };
    function kd(e) { if (e.code === 'KeyF') { api.setMode(cam.mode === 'walk' ? 'fly' : 'walk'); return; } var a = KEYMAP[e.code]; if (a) { keys[a] = true; touched = true; e.preventDefault(); } }
    function ku(e) { var a = KEYMAP[e.code]; if (a) keys[a] = false; }
    var drag = null;
    function pd(e) { drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch }; touched = true; }
    function pm(e) { if (!drag) return; cam.yaw = drag.yaw + (e.clientX - drag.x) * 0.006; cam.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.002, -0.35, 0.35); }
    function pu() { drag = null; }
    root.addEventListener('keydown', kd); root.addEventListener('keyup', ku);
    canvas.addEventListener('pointerdown', pd); root.addEventListener('pointermove', pm); root.addEventListener('pointerup', pu);
    root.addEventListener('resize', resize);
    resize();
    var api = {
      state: function () { return { x: cam.x, z: cam.z, y: cam.y, ground: groundAt(cam.x, cam.z), yaw: cam.yaw, mode: cam.mode, size: N, landShare: +landShare.toFixed(3), landmarksVisible: visibleLabels.map(function (v) { return v.name; }) }; },
      step: function (ms, k) { var r = step(ms, k); render(); return r; },
      press: function (name, on) { keys[name] = !!on; touched = true; },
      setMode: function (m) { cam.mode = m === 'fly' ? 'fly' : 'walk'; if (cam.mode === 'fly') cam.y += 30; if (opts.onMode) opts.onMode(cam.mode); },
      destroy: function () { root.cancelAnimationFrame(raf); root.removeEventListener('keydown', kd); root.removeEventListener('keyup', ku); root.removeEventListener('resize', resize); },
    };
    raf = root.requestAnimationFrame(loop);
    root.__chandraWorld = api;
    return api;
  }

  root.ChandraTerrain = { generate: generate, mount: mount, SHAPES: Object.keys(SHAPES) };
})(typeof window !== 'undefined' ? window : globalThis);
