/*
 * ChandraPlatformer — a small side-scrolling platform game in a canvas. No network, no WebGL.
 *
 *   ChandraPlatformer.level.generate({ seed, cols, rows, difficulty }) -> tiles (array of strings)   (pure; Node runs it)
 *   ChandraPlatformer.level.makePlayable(tiles)                        -> { tiles, fixes, reachable }  (pure)
 *   ChandraPlatformer.mount(canvas, spec)                              -> { state(), press(name, on), destroy() }
 *
 * Tiles: '.' air, '#' solid, '=' solid with a walkable top, '^' spikes, 'o' coin, 'S' start, 'G' goal.
 * spec: { name, tiles, palette: { sky: [top, bottom], ground, platform, accent }, hero?: data URL of a sprite,
 *         backdrop?: data URL of a picture drawn behind the level }.
 * Controls: ←/→ or A/D run, Space / ↑ / W jump (held = higher), touch buttons on phones.
 * window.__chandraGame is the live handle (used by the page check to play).
 *
 * The physics and the reachability search share one set of numbers (PHYS), so a level the search calls winnable
 * is winnable with these jumps: a jump climbs at most REACH.up tiles and crosses at most REACH.across.
 */
(function (root) {
  'use strict';
  var PHYS = { tile: 32, gravity: 1900, jump: 660, run: 230, coyote: 0.09, buffer: 0.12, maxFall: 900 };
  // what a jump can do, in tiles, from PHYS (with a margin): height v²/2g, distance run × airtime
  var REACH = { up: Math.floor(PHYS.jump * PHYS.jump / (2 * PHYS.gravity) / PHYS.tile - 0.4), across: Math.floor(PHYS.run * (2 * PHYS.jump / PHYS.gravity) / PHYS.tile - 0.6) };
  var SOLID = { '#': 1, '=': 1 };
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rng(seed) { var s = (seed >>> 0) || 1; return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; }; }
  function grid(tiles) { return tiles.map(function (r) { return r.split(''); }); }
  function rows(g) { return g.map(function (r) { return r.join(''); }); }
  function solid(g, r, c) { return r >= 0 && r < g.length && c >= 0 && c < g[0].length && !!SOLID[g[r][c]]; }
  function standable(g, r, c) { if (r < 0 || r >= g.length - 1 || c < 0 || c >= g[0].length) return false; var t = g[r][c]; return !SOLID[t] && t !== '^' && solid(g, r + 1, c); }

  /** A level from a seed: ground with hills, pits and spikes, floating platforms, then made playable and decorated. */
  function generate(o) {
    o = o || {}; var R = rng(o.seed || 7), cols = clamp(o.cols || 64, 24, 160), rowsN = clamp(o.rows || 14, 9, 24), diff = clamp(o.difficulty || 2, 1, 3);
    var g = []; for (var r = 0; r < rowsN; r++) { g.push([]); for (var c = 0; c < cols; c++) g[r].push('.'); }
    var h = 3, c2;
    for (c2 = 0; c2 < cols; c2++) {
      if (c2 > 6 && c2 < cols - 6 && R() < 0.06 * diff) {               // a pit, sometimes with spikes at the bottom
        var w = 2 + Math.floor(R() * Math.min(REACH.across - 1, 1 + diff));
        for (var k = 0; k < w && c2 < cols - 6; k++, c2++) if (R() < 0.3 * diff) g[rowsN - 1][c2] = '^';
        c2--; continue;
      }
      if (c2 > 4 && R() < 0.18) h = clamp(h + (R() < 0.5 ? -1 : 1) * (1 + (R() < 0.3 ? 1 : 0)), 1, rowsN - 5);
      for (var y = rowsN - h; y < rowsN; y++) g[y][c2] = '#';
      if (c2 > 8 && c2 < cols - 8 && R() < 0.035 * diff) g[rowsN - h - 1][c2] = '^';
    }
    for (var p = 0; p < Math.floor(cols / 9); p++) {                      // floating platforms
      var pc = 6 + Math.floor(R() * (cols - 14)), pl = 3 + Math.floor(R() * 4), pr = 3 + Math.floor(R() * (rowsN - 8));
      for (var q = 0; q < pl && pc + q < cols; q++) if (g[pr][pc + q] === '.') g[pr][pc + q] = '=';
    }
    return decorate(makePlayable(rows(g)).tiles, o.seed || 7);
  }

  /** Every cell a player can stand in and get to from the start (BFS over jumps within REACH, falls of any height). */
  function reachable(tiles, from) {
    var g = grid(tiles), H = g.length, W = g[0].length, seen = {}, q = [];
    var start = from || findStart(g);
    if (!start) return { cells: {}, count: 0, maxCol: -1, start: null };
    var key = function (r, c) { return r * 10000 + c; };
    q.push(start); seen[key(start[0], start[1])] = 1;
    var maxCol = start[1];
    while (q.length) {
      var cur = q.shift(), r = cur[0], c = cur[1];
      if (c > maxCol) maxCol = c;
      for (var dc = -REACH.across; dc <= REACH.across; dc++) {
        var nc = c + dc; if (nc < 0 || nc >= W) continue;
        for (var nr = Math.max(0, r - REACH.up); nr < H - 1; nr++) {
          if (!standable(g, nr, nc)) continue;
          var drop = nr - r;
          if (drop > 0 && Math.abs(dc) > REACH.across + Math.floor(drop / 2)) continue;
          if (!clearPath(g, r, c, nr, nc)) continue;
          var k = key(nr, nc); if (seen[k]) continue; seen[k] = 1; q.push([nr, nc]);
        }
      }
    }
    return { cells: seen, count: Object.keys(seen).length, maxCol: maxCol, start: start };
  }
  // a jump needs air above the higher of the two cells across the way (no going through a wall or a ceiling)
  function clearPath(g, r, c, nr, nc) {
    var top = Math.min(r, nr) - (nr < r ? 1 : 0), step = nc > c ? 1 : -1;
    for (var x = c; x !== nc; x += step) { if (solid(g, Math.max(0, top), x + step) && solid(g, Math.max(0, top) - 1, x + step) && top > 0) return false; }
    return true;
  }
  function findStart(g) {
    for (var r = 0; r < g.length; r++) for (var c = 0; c < g[0].length; c++) if (g[r][c] === 'S') return [r, c];
    for (c = 0; c < Math.min(6, g[0].length); c++) for (r = g.length - 2; r >= 0; r--) if (standable(g, r, c)) return [r, c];
    return null;
  }

  /**
   * Repair a level until its right end can be reached: ground is laid under the start if there is none, and where
   * the search stops, a platform is placed within reach (or a wall too high to climb is cut down), up to 40 times.
   */
  function makePlayable(tiles) {
    var g = grid(tiles), H = g.length, W = g[0].length, fixes = [];
    if (!findStart(g)) { for (var c0 = 0; c0 < 3; c0++) g[H - 1][c0] = '#'; fixes.push('ground laid under the start'); }
    for (var i = 0; i < 40; i++) {
      var R2 = reachable(rows(g));
      if (R2.maxCol >= W - 3) return { tiles: rows(g), fixes: fixes, reachable: true, cells: R2.count };
      // the reachable cell furthest right (lowest of those, so a placed step is easy to reach)
      var best = null;
      for (var k in R2.cells) { var r = Math.floor(k / 10000), c = k % 10000; if (!best || c > best[1] || (c === best[1] && r > best[0])) best = [r, c]; }
      var tc = Math.min(W - 1, best[1] + REACH.across - 1), tr = best[0] + 1;          // a step at the same height, a jump away
      for (var x = best[1] + 1; x <= tc; x++) for (var y = Math.max(0, best[0] - 2); y <= best[0]; y++) if (SOLID[g[y][x]] || g[y][x] === '^') { g[y][x] = '.'; }
      if (tr < H) { g[tr][tc] = '='; if (tc + 1 < W) g[tr][tc + 1] = '='; }
      fixes.push('step added at column ' + tc);
    }
    var last = reachable(rows(g));
    return { tiles: rows(g), fixes: fixes, reachable: last.maxCol >= W - 3, cells: last.count };
  }

  /** Start at the left, goal at the right end, coins on some reachable platform tops (deterministic). */
  function decorate(tiles, seed) {
    var g = grid(tiles), H = g.length, W = g[0].length, R = rng((seed || 7) + 31);
    for (var r = 0; r < H; r++) for (var c = 0; c < W; c++) if (g[r][c] === 'S' || g[r][c] === 'G' || g[r][c] === 'o') g[r][c] = '.';
    var s = findStart(g); if (s) g[s[0]][s[1]] = 'S';
    var reach = reachable(rows(g)), goal = null;
    for (var k in reach.cells) { var rr = Math.floor(k / 10000), cc = k % 10000; if (!goal || cc > goal[1]) goal = [rr, cc]; }
    if (goal) g[goal[0]][goal[1]] = 'G';
    var coins = 0;
    for (k in reach.cells) {
      rr = Math.floor(k / 10000); cc = k % 10000;
      if (coins < 14 && g[rr][cc] === '.' && cc > 3 && R() < 0.22) { g[rr][cc] = 'o'; coins++; }
    }
    return rows(g);
  }

  // ── the game ─────────────────────────────────────────────────────────────────────────────────────────
  function hexRgba(h, a) { h = String(h || '#888').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var n = parseInt(h, 16) || 0; return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (a == null ? 1 : a) + ')'; }

  function mount(canvas, spec) {
    var g = grid(spec.tiles), H = g.length, W = g[0].length, T = PHYS.tile, ctx = canvas.getContext('2d');
    var pal = spec.palette || {}, sky = pal.sky || ['#6ec6ff', '#e0f6ff'];
    var hero = null, backdrop = null;
    if (spec.hero) { hero = new Image(); hero.src = spec.hero; }
    if (spec.backdrop) { backdrop = new Image(); backdrop.src = spec.backdrop; }
    var start = findStart(g) || [H - 2, 1], goal = null, coinsTotal = 0;
    for (var r = 0; r < H; r++) for (var c = 0; c < W; c++) { if (g[r][c] === 'G') goal = [r, c]; if (g[r][c] === 'o') coinsTotal++; }
    var P = { x: start[1] * T + 4, y: start[0] * T + 2, w: T - 8, h: T - 2, vx: 0, vy: 0, ground: false, face: 1, coyote: 0, buffer: 0, coins: 0, deaths: 0, won: false, wonAt: 0, jumps: 0, takeoffY: 0, peakY: 0 };
    var checkpoint = { x: P.x, y: P.y }, keys = {}, raf = 0, last = 0, t0 = 0, scale = 1, camX = 0;
    function resize() { var rr = canvas.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1); canvas.width = Math.max(320, (rr.width || 960) * dpr | 0); canvas.height = Math.max(200, (rr.height || 540) * dpr | 0); scale = canvas.height / (H * T); }
    function tileAt(px, py) { var cc = Math.floor(px / T), rr2 = Math.floor(py / T); if (cc < 0 || cc >= W) return '#'; if (rr2 < 0) return '.'; if (rr2 >= H) return '.'; return g[rr2][cc]; }
    // a box occupies rows floor(y/T) .. floor((y+h-ε)/T). An earlier "-1" let the hero sink a whole pixel into the
    // floor unnoticed, so `ground` flickered false for several steps at rest (coyote time and the play check both saw it)
    var EPS = 1e-4;
    function hits(x, y, w, h) { for (var yy = Math.floor(y / T); yy <= Math.floor((y + h - EPS) / T); yy++) for (var xx = Math.floor(x / T); xx <= Math.floor((x + w - EPS) / T); xx++) if (SOLID[tileAt(xx * T + 1, yy * T + 1)]) return true; return false; }
    function die() { P.deaths++; P.x = checkpoint.x; P.y = checkpoint.y; P.vx = P.vy = 0; }
    function step(dt) {
      if (P.won) return;
      var dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      P.vx = dir * PHYS.run; if (dir) P.face = dir;
      P.coyote = P.ground ? PHYS.coyote : Math.max(0, P.coyote - dt);
      P.buffer = keys.jumpPressed ? PHYS.buffer : Math.max(0, P.buffer - dt); keys.jumpPressed = false;
      if (P.buffer > 0 && P.coyote > 0) { P.vy = -PHYS.jump; P.buffer = 0; P.coyote = 0; P.jumps++; P.takeoffY = P.peakY = P.y; }
      if (!keys.jump && P.vy < -PHYS.jump * 0.45) P.vy = -PHYS.jump * 0.45;   // let go early = a shorter hop
      P.vy = Math.min(PHYS.maxFall, P.vy + PHYS.gravity * dt);
      var nx = P.x + P.vx * dt;
      if (!hits(nx, P.y, P.w, P.h)) P.x = nx; else P.x = P.vx > 0 ? Math.floor((nx + P.w) / T) * T - P.w - 0.01 : Math.ceil(nx / T) * T + 0.01;
      var ny = P.y + P.vy * dt; P.ground = false;
      if (!hits(P.x, ny, P.w, P.h)) P.y = ny;
      else { if (P.vy > 0) { P.y = Math.floor((ny + P.h) / T) * T - P.h - 0.01; P.ground = true; } else P.y = Math.ceil(ny / T) * T + 0.01; P.vy = 0; }
      if (!P.ground && P.y < P.peakY) P.peakY = P.y;   // highest point of the current jump, exact at any frame rate
      if (P.y > H * T + 64) die();
      var cx = Math.floor((P.x + P.w / 2) / T), cy = Math.floor((P.y + P.h / 2) / T), feet = Math.floor((P.y + P.h - 2) / T);
      if (cy >= 0 && cy < H && cx >= 0 && cx < W) {
        if (g[cy][cx] === 'o') { g[cy][cx] = '.'; P.coins++; }
        if (g[cy][cx] === '^' || (feet < H && g[feet][cx] === '^')) die();
        if (g[cy][cx] === 'G') { P.won = true; P.wonAt = t0; }
      }
      if (P.ground && cx % 12 === 0) { checkpoint.x = P.x; checkpoint.y = P.y; }
    }
    function draw(now) {
      var Wc = canvas.width, Hc = canvas.height, s = scale, viewW = Wc / s;
      camX += (clamp(P.x + P.w / 2 - viewW * 0.4, 0, Math.max(0, W * T - viewW)) - camX) * 0.15;
      var grd = ctx.createLinearGradient(0, 0, 0, Hc); grd.addColorStop(0, sky[0]); grd.addColorStop(1, sky[1]); ctx.fillStyle = grd; ctx.fillRect(0, 0, Wc, Hc);
      var ready = backdrop && backdrop.complete && backdrop.naturalWidth, asLevel = ready && spec.backdropMode === 'level';
      if (ready && !asLevel) {   // a scenery picture: scrolls slowly behind the level
        var bh = Hc, bw = backdrop.naturalWidth * bh / backdrop.naturalHeight, off = -(camX * s * 0.3) % bw;
        ctx.globalAlpha = 0.85; for (var bx = off - bw; bx < Wc; bx += bw) ctx.drawImage(backdrop, bx, 0, bw, bh); ctx.globalAlpha = 1;
      }
      ctx.save(); ctx.scale(s, s); ctx.translate(-camX, 0);
      // a level read from a picture: the picture IS the level, drawn cell for cell under the tiles it became
      if (asLevel) ctx.drawImage(backdrop, 0, 0, W * T, H * T);
      var c0 = Math.max(0, Math.floor(camX / T) - 1), c1 = Math.min(W, Math.ceil((camX + viewW) / T) + 1), tt = now / 1000;
      for (var r2 = 0; r2 < H; r2++) for (var c3 = c0; c3 < c1; c3++) {
        var ch = g[r2][c3], x = c3 * T, y = r2 * T;
        if (SOLID[ch]) {
          var top = r2 === 0 || !SOLID[g[r2 - 1][c3]];
          ctx.fillStyle = ch === '=' && !(r2 + 1 < H && SOLID[g[r2 + 1][c3]]) ? (pal.platform || '#c58b4b') : (pal.ground || '#5b8c3a');
          if (asLevel) {   // a tint, so the picture shows through; the walkable top is a bright line
            ctx.globalAlpha = 0.3; ctx.fillRect(x, y, T, T); ctx.globalAlpha = 1;
            if (top) { ctx.fillStyle = pal.accent || '#ffd23f'; ctx.fillRect(x, y, T, 3); }
          } else {
            ctx.fillRect(x, y, T, T);
            if (top) { ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(x, y, T, 5); }
            ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(x, y + T - 3, T, 3);
          }
        } else if (ch === '^') {
          ctx.fillStyle = '#d9dde3'; ctx.beginPath(); for (var k = 0; k < 3; k++) { ctx.moveTo(x + k * T / 3, y + T); ctx.lineTo(x + k * T / 3 + T / 6, y + T * 0.45); ctx.lineTo(x + (k + 1) * T / 3, y + T); } ctx.fill();
        } else if (ch === 'o') {
          var sq = Math.abs(Math.cos(tt * 3 + c3)); ctx.fillStyle = pal.accent || '#ffd23f'; ctx.beginPath(); ctx.ellipse(x + T / 2, y + T / 2 + Math.sin(tt * 4 + c3) * 2, T * 0.28 * sq + 1, T * 0.28, 0, 0, 7); ctx.fill();
        } else if (ch === 'G') {
          ctx.fillStyle = '#f4f1de'; ctx.fillRect(x + T / 2 - 2, y - T * 1.5, 4, T * 2.5);
          ctx.fillStyle = pal.accent || '#e63946'; ctx.beginPath(); ctx.moveTo(x + T / 2 + 2, y - T * 1.5); ctx.quadraticCurveTo(x + T * 1.3, y - T * 1.2 + Math.sin(tt * 5) * 4, x + T / 2 + 2, y - T * 0.6); ctx.fill();
        }
      }
      // the hero: the sprite (kept in proportion, about a tile and a half tall) or a drawn blob
      var px = P.x + P.w / 2, py = P.y + P.h;
      if (hero && hero.complete && hero.naturalWidth) {
        var hh = T * 1.5, hw = hero.naturalWidth * hh / hero.naturalHeight;
        ctx.save(); ctx.translate(px, py); ctx.scale(P.face, 1); ctx.drawImage(hero, -hw / 2, -hh, hw, hh); ctx.restore();
      } else {
        var bob = P.ground && P.vx ? Math.sin(tt * 18) * 2 : 0;
        ctx.fillStyle = pal.hero || '#7b61ff'; ctx.beginPath(); ctx.ellipse(px, py - T * 0.55 + bob, T * 0.42, T * 0.55, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px + P.face * 6, py - T * 0.75 + bob, 5, 0, 7); ctx.fill();
        ctx.fillStyle = '#1a1a2e'; ctx.beginPath(); ctx.arc(px + P.face * 7.5, py - T * 0.75 + bob, 2.5, 0, 7); ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(10,14,24,0.6)'; ctx.fillRect(10, 10, 210, 30); ctx.fillStyle = '#fff'; ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillText('● ' + P.coins + ' / ' + coinsTotal + '    falls ' + P.deaths, 20, 31);
      if (P.won) { ctx.fillStyle = 'rgba(10,14,24,0.6)'; ctx.fillRect(0, Hc / 2 - 40, Wc, 80); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 32px system-ui, sans-serif'; ctx.fillText('You made it!  ' + P.coins + ' of ' + coinsTotal + ' coins', Wc / 2, Hc / 2 + 11); ctx.textAlign = 'left'; }
    }
    // fixed 1/120 s steps: game time keeps pace with real time at any frame rate (a slow frame runs several steps),
    // and a long stall (hidden tab) is cut to a quarter second so nothing tunnels through a wall
    var acc = 0, SUB = 1 / 120, simTime = 0;
    function loop(now) {
      acc += last ? Math.min(0.25, (now - last) / 1000) : SUB; last = now; t0 = now;
      while (acc >= SUB) { step(SUB); acc -= SUB; simTime += SUB; }
      draw(now); raf = root.requestAnimationFrame(loop);
    }
    var KEY = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'jump', ArrowUp: 'jump', KeyW: 'jump' };
    function kd(e) { var a = KEY[e.code]; if (!a) return; if (a === 'jump' && !keys.jump) keys.jumpPressed = true; keys[a] = true; e.preventDefault(); }
    function ku(e) { var a = KEY[e.code]; if (a) keys[a] = false; }
    root.addEventListener('keydown', kd); root.addEventListener('keyup', ku); root.addEventListener('resize', resize);
    resize(); raf = root.requestAnimationFrame(loop);
    var api = {
      state: function () { return { x: P.x / T, y: P.y / T, ground: P.ground, coins: P.coins, coinsTotal: coinsTotal, deaths: P.deaths, won: P.won, goal: goal, width: W, height: H, time: simTime, jumps: P.jumps, rise: (P.takeoffY - P.peakY) / T }; },
      press: function (name, on) { if (name === 'jump' && on && !keys.jump) keys.jumpPressed = true; keys[name] = !!on; },
      destroy: function () { root.cancelAnimationFrame(raf); root.removeEventListener('keydown', kd); root.removeEventListener('keyup', ku); root.removeEventListener('resize', resize); },
    };
    root.__chandraGame = api;
    return api;
  }

  root.ChandraPlatformer = { mount: mount, PHYS: PHYS, REACH: REACH, level: { generate: generate, reachable: reachable, makePlayable: makePlayable, decorate: decorate, standable: function (t, r, c) { return standable(grid(t), r, c); } } };
})(typeof window !== 'undefined' ? window : globalThis);
