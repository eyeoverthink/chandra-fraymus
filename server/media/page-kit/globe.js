/* ChandraGlobe — a spinning Earth with real coastlines, in one script and no network.
 *
 *   var globe = ChandraGlobe.mount(canvasElement, { spin: 2, tilt: 20, longitude: 0, stars: true, interactive: true });
 *   globe.setSpin(rpm)  globe.setTilt(degrees)  globe.lookAt(longitude, latitude)  globe.destroy()
 *
 * The canvas is sized by CSS; the globe fills it and follows resizes. Drag turns it, the wheel zooms,
 * a double click resets. Coastlines: Natural Earth 1:110m (public domain).
 *
 * How it draws: the land outlines are painted once into a 2048×1024 longitude/latitude mask. For every
 * pixel of the disc the latitude row, the base longitude column and the sunlight are worked out once
 * per size or tilt; a frame is then one table lookup per pixel with the spin added to the column, so a
 * 900-pixel globe stays smooth on the Canvas 2D API alone.
 */
(function (root) {
  'use strict';
  var LAND = /*LAND_DATA*/[];
  var TW = 2048, TH = 1024, mask = null, landRGB = null, seaRGB = null;

  function buildMask() {
    if (mask) return;
    var c = document.createElement('canvas'); c.width = TW; c.height = TH;
    var g = c.getContext('2d'); g.fillStyle = '#fff';
    for (var p = 0; p < LAND.length; p++) {
      g.beginPath();
      for (var r = 0; r < LAND[p].length; r++) {
        var a = LAND[p][r];
        for (var i = 0; i < a.length; i += 2) {
          var x = (a[i] / 10 + 180) / 360 * TW, y = (90 - a[i + 1] / 10) / 180 * TH;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.closePath();
      }
      g.fill('evenodd');
    }
    var d = g.getImageData(0, 0, TW, TH).data;
    mask = new Uint8Array(TW * TH);
    for (var k = 0; k < mask.length; k++) mask[k] = d[k * 4 + 3];
    // colour by latitude: ice at the poles, tundra, temperate green, dry band, tropical green
    landRGB = new Uint8Array(TH * 3); seaRGB = new Uint8Array(TH * 3);
    var stops = [[90, 244, 247, 250], [72, 232, 238, 242], [62, 122, 138, 110], [50, 74, 122, 70], [36, 96, 132, 66], [24, 176, 158, 104], [12, 86, 138, 62], [0, 46, 118, 54]];
    for (var row = 0; row < TH; row++) {
      var lat = Math.abs(90 - (row + 0.5) / TH * 180), south = row > TH / 2;
      if (south && lat > 60) lat = Math.min(90, lat + 12);          // Antarctica is ice from its coast inward
      var s = 0; while (s < stops.length - 2 && lat < stops[s + 1][0]) s++;
      var hi = stops[s], lo = stops[s + 1], t = (lat - lo[0]) / (hi[0] - lo[0] || 1); t = t < 0 ? 0 : t > 1 ? 1 : t;
      for (var ch = 0; ch < 3; ch++) landRGB[row * 3 + ch] = lo[ch + 1] + (hi[ch + 1] - lo[ch + 1]) * t;
      var w = Math.cos(lat * Math.PI / 180);                         // warmer, lighter water near the equator
      seaRGB[row * 3] = 8 + 14 * w; seaRGB[row * 3 + 1] = 38 + 52 * w; seaRGB[row * 3 + 2] = 92 + 70 * w;
    }
  }

  function mount(canvas, options) {
    if (!canvas || !canvas.getContext) throw new Error('ChandraGlobe.mount needs a <canvas> element');
    var o = options || {};
    var spin = typeof o.spin === 'number' ? o.spin : 2;              // turns per minute; 0 = still
    var pitch = (typeof o.tilt === 'number' ? o.tilt : 20) * Math.PI / 180;
    var yaw = typeof o.longitude === 'number' ? o.longitude : 0;     // degrees of longitude facing the viewer
    var stars = o.stars !== false, interactive = o.interactive !== false, background = o.background || '#02040a';
    var zoom = 1, home = { pitch: pitch, yaw: yaw };
    var ctx = canvas.getContext('2d'), disc = document.createElement('canvas'), dctx = disc.getContext('2d');
    var sky = document.createElement('canvas');
    var W = 0, H = 0, R = 0, D = 0, img = null, count = 0, rowAt, colAt, lightAt, edgeAt, posAt, dirty = true, raf = 0, last = 0, alive = true, dragging = null;
    buildMask();

    function layout() {
      var dpr = Math.min(root.devicePixelRatio || 1, 1.5);
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w !== W || h !== H) {
        W = canvas.width = w; H = canvas.height = h;
        sky.width = W; sky.height = H;
        var s = sky.getContext('2d'); s.fillStyle = background; s.fillRect(0, 0, W, H);
        if (stars) {
          var seed = 12345;
          for (var i = 0; i < Math.round(W * H / 2600); i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff; var x = seed % W;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff; var y = seed % H;
            seed = (seed * 1103515245 + 12345) & 0x7fffffff; var b = 90 + seed % 165;
            s.fillStyle = 'rgba(' + b + ',' + b + ',' + Math.min(255, b + 30) + ',' + (0.35 + (seed % 60) / 100) + ')';
            s.fillRect(x, y, seed % 9 === 0 ? 2 : 1, seed % 9 === 0 ? 2 : 1);
          }
        }
      }
      R = Math.max(8, Math.min(Math.min(W, H) * 0.42 * zoom, 520));
      D = Math.ceil(R * 2) + 2;
      disc.width = D; disc.height = D; img = dctx.createImageData(D, D);
      var n = D * D; rowAt = new Int32Array(n); colAt = new Int32Array(n); lightAt = new Float32Array(n); edgeAt = new Uint8Array(n); posAt = new Int32Array(n);
      var cp = Math.cos(pitch), sp = Math.sin(pitch), c = D / 2, sx = -0.52, sy = 0.36, sz = 0.775;   // the Sun: up and to the left of the viewer
      count = 0;
      for (var py = 0; py < D; py++) for (var px = 0; px < D; px++) {
        var nx = (px + 0.5 - c) / R, ny = (c - py - 0.5) / R, rr = nx * nx + ny * ny;
        if (rr > 1) continue;
        var nz = Math.sqrt(1 - rr);
        var ye = ny * cp + nz * sp, ze = -ny * sp + nz * cp;          // into the Earth's own frame: its axis leans toward the viewer
        var lat = Math.asin(ye < -1 ? -1 : ye > 1 ? 1 : ye), lon = Math.atan2(nx, ze);
        var row = Math.min(TH - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * TH)));
        rowAt[count] = row; colAt[count] = Math.floor((lon / (2 * Math.PI) + 0.5) * TW);
        lightAt[count] = nx * sx + ny * sy + nz * sz;
        edgeAt[count] = Math.max(0, Math.min(255, Math.round((1 - Math.sqrt(rr)) * R * 255)));   // soft one-pixel rim
        posAt[count] = (py * D + px) * 4;
        count++;
      }
      dirty = false;
    }

    function frame(now) {
      if (!alive) return;
      raf = root.requestAnimationFrame(frame);
      if (!last) last = now;
      var dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (!dragging) yaw -= spin * 6 * dt;                            // the Earth turns eastward: the longitude facing us falls; 1 turn per minute = 6 degrees per second
      if (canvas.clientWidth * Math.min(root.devicePixelRatio || 1, 1.5) !== W && Math.abs(Math.round(canvas.clientWidth * Math.min(root.devicePixelRatio || 1, 1.5)) - W) > 1) dirty = true;
      if (Math.abs(Math.round(canvas.clientHeight * Math.min(root.devicePixelRatio || 1, 1.5)) - H) > 1) dirty = true;
      if (dirty) layout();
      var shift = Math.round(((yaw % 360) + 360) % 360 / 360 * TW), d = img.data, M = TW - 1;
      for (var i = 0; i < count; i++) {
        var row = rowAt[i], cov = mask[row * TW + ((colAt[i] + shift) & M)] / 255, r3 = row * 3;
        var r = seaRGB[r3] + (landRGB[r3] - seaRGB[r3]) * cov, g = seaRGB[r3 + 1] + (landRGB[r3 + 1] - seaRGB[r3 + 1]) * cov, b = seaRGB[r3 + 2] + (landRGB[r3 + 2] - seaRGB[r3 + 2]) * cov;
        var L = lightAt[i], lit = L > 0 ? 0.16 + 0.98 * L : 0.16 + 0.5 * L;   // a soft terminator; the night side keeps a little colour
        if (lit < 0.05) lit = 0.05;
        var glint = cov < 0.5 && L > 0.9 ? (L - 0.9) * 420 * (1 - cov) : 0;   // sunlight on open water
        var p = posAt[i];
        d[p] = Math.min(255, r * lit + glint); d[p + 1] = Math.min(255, g * lit + glint); d[p + 2] = Math.min(255, b * lit + glint * 1.1); d[p + 3] = edgeAt[i];
      }
      dctx.putImageData(img, 0, 0);
      ctx.drawImage(sky, 0, 0);
      var cx = W / 2, cy = H / 2;
      var halo = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.16);
      halo.addColorStop(0, 'rgba(110,170,255,0.38)'); halo.addColorStop(0.45, 'rgba(90,150,255,0.12)'); halo.addColorStop(1, 'rgba(90,150,255,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.16, 0, 6.2832); ctx.fill();
      ctx.drawImage(disc, Math.round(cx - D / 2), Math.round(cy - D / 2));
    }

    function down(e) { dragging = { x: e.clientX, y: e.clientY, yaw: yaw, pitch: pitch }; if (canvas.setPointerCapture) try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } }
    function move(e) {
      if (!dragging) return;
      var k = 180 / (Math.PI * Math.max(40, R / Math.min(root.devicePixelRatio || 1, 1.5)));
      yaw = dragging.yaw - (e.clientX - dragging.x) * k;           // the surface follows the pointer
      var np = dragging.pitch + (e.clientY - dragging.y) * k * Math.PI / 180;
      np = Math.max(-1.4, Math.min(1.4, np));
      if (np !== pitch) { pitch = np; dirty = true; }
    }
    function up() { dragging = null; }
    function wheel(e) { e.preventDefault(); zoom = Math.max(0.5, Math.min(2.4, zoom * (e.deltaY < 0 ? 1.08 : 0.926))); dirty = true; }
    function reset() { pitch = home.pitch; yaw = home.yaw; zoom = 1; dirty = true; }
    if (interactive) {
      canvas.style.touchAction = 'none'; canvas.style.cursor = 'grab';
      canvas.addEventListener('pointerdown', down); root.addEventListener('pointermove', move); root.addEventListener('pointerup', up);
      canvas.addEventListener('wheel', wheel, { passive: false }); canvas.addEventListener('dblclick', reset);
    }
    function onResize() { dirty = true; }
    root.addEventListener('resize', onResize);
    raf = root.requestAnimationFrame(frame);

    return {
      setSpin: function (rpm) { spin = Number(rpm) || 0; },
      setTilt: function (deg) { pitch = Math.max(-1.4, Math.min(1.4, (Number(deg) || 0) * Math.PI / 180)); dirty = true; },
      lookAt: function (lon, lat) { yaw = Number(lon) || 0; if (typeof lat === 'number') { pitch = Math.max(-1.4, Math.min(1.4, lat * Math.PI / 180)); dirty = true; } },
      getLongitude: function () { return ((yaw % 360) + 360) % 360; },
      destroy: function () {
        alive = false; root.cancelAnimationFrame(raf); root.removeEventListener('resize', onResize);
        if (interactive) { canvas.removeEventListener('pointerdown', down); root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('dblclick', reset); }
      },
    };
  }

  root.ChandraGlobe = { mount: mount, source: 'Coastlines: Natural Earth 1:110m (public domain)' };
})(window);
