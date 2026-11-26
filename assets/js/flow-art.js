/* ============================================================
   DDFE — research-area illustrations drawn on <canvas>.
   <canvas class="flow-art" data-art="cylinder" data-src="...bin"></canvas>
   - cylinder: live D2Q9 lattice-Boltzmann simulation of flow past a
               circular cylinder (Re = 150), coloured by vorticity, with an
               adaptive (quadtree) mesh that follows the vorticity field.
               Starts from a fully developed state (assets/data/*.bin).
   - optimize: Bayesian-optimization style search on a design landscape;
               unexplored regions stay "foggy" until sampled.
   - rough:    turbulent flow over a 3D rough surface; the drag-relevant
               roughness elements are highlighted.
   Animations pause off-screen and respect prefers-reduced-motion.
   ============================================================ */
(function () {
  'use strict';
  var REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var BG = '#0b1626', BGC = [11, 22, 38];
  var TAU = Math.PI * 2;

  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a.toFixed(3) + ')'; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  /* draw particle trails, batched into a few colour buckets (one stroke per bucket) */
  function trails(ctx, parts, colorOf) {
    var NB = 6, buckets = [], i, k, b;
    for (b = 0; b < NB; b++) buckets.push([]);
    for (i = 0; i < parts.length; i++) if (parts[i].h.length >= 6) buckets[Math.min(NB - 1, Math.floor(clamp(colorOf.level(parts[i]), 0, 0.999) * NB))].push(parts[i]);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (b = 0; b < NB; b++) {
      var L = buckets[b]; if (!L.length) continue;
      var c = colorOf.style((b + 0.5) / NB);
      ctx.lineWidth = c.w || 1.1;
      for (var pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = rgba(c.rgb, pass ? c.a : c.a * 0.35);
        ctx.beginPath();
        for (i = 0; i < L.length; i++) {
          var h = L[i].h, n = h.length, half = (n >> 2) << 1, k0 = pass ? half : 0, k1 = pass ? n - 2 : half;
          ctx.moveTo(h[k0], h[k0 + 1]);
          for (k = k0 + 2; k <= k1; k += 2) ctx.lineTo(h[k], h[k + 1]);
        }
        ctx.stroke();
      }
    }
  }
  function vignette(ctx, W, H) {
    var g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  /* ============ 01: lattice-Boltzmann flow past a cylinder ============ */
  function Cylinder(src) {
    var NX = 320, NY = 110, CX = 64, CY = NY / 2 - 0.5, RC = 9, U = 0.1, TAUR = 0.536;
    var EX = [0, 1, 0, -1, 0, 1, -1, -1, 1], EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
    var WT = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36], OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
    var N = NX * NY, f = null, g, ux = new Float32Array(N), uy = new Float32Array(N), vort = new Float32Array(N);
    var solid = new Uint8Array(N), fin = new Float32Array(9), ready = false, loading = false;
    var W, H, vx0, vw, sc, img = canvas(NX, NY), ictx = img.getContext('2d'), idata = ictx.createImageData(NX, NY);
    var parts = [], rand = rng(5), WSCALE = 0.04, x, y, i;
    var glow1 = canvas(80, 28), gl1 = glow1.getContext('2d'), glow2 = canvas(40, 14), gl2 = glow2.getContext('2d');
    var POS = [236, 104, 88], NEG = [70, 150, 236], HOT_P = [255, 214, 190], HOT_N = [205, 232, 255];
    var LUT = new Uint8Array(2 * 256 * 3);          /* [sign][level] -> rgb */
    (function () {
      for (var sgn = 0; sgn < 2; sgn++) for (var q = 0; q < 256; q++) {
        var m = q / 255, band = m * (1 + 0.12 * Math.sin(m * 6 * TAU));   /* soft contour ripples */
        var col = mix(BGC, sgn ? POS : NEG, clamp(Math.pow(Math.max(0, band), 0.75) * 1.05, 0, 1));
        if (m > 0.7) col = mix(col, sgn ? HOT_P : HOT_N, (m - 0.7) / 0.3 * 0.6);
        var o = (sgn * 256 + q) * 3; LUT[o] = col[0]; LUT[o + 1] = col[1]; LUT[o + 2] = col[2];
      }
    })();

    for (y = 0; y < NY; y++) for (x = 0; x < NX; x++) solid[y * NX + x] = ((x - CX) * (x - CX) + (y - CY) * (y - CY) <= RC * RC) ? 1 : 0;
    for (i = 0; i < 9; i++) { var eu = EX[i] * U; fin[i] = WT[i] * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * U * U); }

    function initFrom(rho, vx, vy) {
      f = new Float32Array(9 * N); g = new Float32Array(9 * N);
      for (var c = 0; c < N; c++) {
        var r = rho[c], u = solid[c] ? 0 : vx[c], v = solid[c] ? 0 : vy[c], usq = u * u + v * v;
        for (var i = 0; i < 9; i++) { var e = EX[i] * u + EY[i] * v; f[i * N + c] = WT[i] * r * (1 + 3 * e + 4.5 * e * e - 1.5 * usq); }
      }
      for (var k = 0; k < 40; k++) lbm();        /* smooth out quantization noise */
      ready = true; macro();
    }
    function load() {
      if (loading) return; loading = true;
      var fallback = function () {   /* no state file: start from uniform flow */
        var r = new Float32Array(N), a = new Float32Array(N), b = new Float32Array(N);
        for (var c = 0; c < N; c++) { r[c] = 1; a[c] = U; b[c] = 0.002 * Math.sin(c); }
        initFrom(r, a, b);
      };
      if (!src || !window.fetch) return fallback();
      fetch(src).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(function (buf) {
        var dv = new DataView(buf), nx = dv.getUint16(0, true), ny = dv.getUint16(2, true);
        if (nx !== NX || ny !== NY) throw 0;
        var rg = []; for (var k = 0; k < 6; k++) rg.push(dv.getFloat32(4 + 4 * k, true));
        var q = new Uint8Array(buf, 28), r = new Float32Array(N), a = new Float32Array(N), b = new Float32Array(N);
        for (var c = 0; c < N; c++) {
          r[c] = rg[0] + q[c] / 255 * (rg[1] - rg[0]);
          a[c] = rg[2] + q[N + c] / 255 * (rg[3] - rg[2]);
          b[c] = rg[4] + q[2 * N + c] / 255 * (rg[5] - rg[4]);
        }
        initFrom(r, a, b);
      }).catch(fallback);
    }
    function lbm() {
      var c, i, x, y, inv = 1 / TAUR;
      for (c = 0; c < N; c++) {                                   /* collide */
        if (solid[c]) { for (i = 0; i < 9; i++) g[i * N + c] = f[OPP[i] * N + c]; continue; }   /* bounce-back */
        var r = 0, mx = 0, my = 0;
        for (i = 0; i < 9; i++) { var fi = f[i * N + c]; r += fi; mx += fi * EX[i]; my += fi * EY[i]; }
        var u = mx / r, v = my / r, usq = 1.5 * (u * u + v * v);
        for (i = 0; i < 9; i++) {
          var e = EX[i] * u + EY[i] * v, fe = WT[i] * r * (1 + 3 * e + 4.5 * e * e - usq), o = i * N + c;
          g[o] = f[o] - (f[o] - fe) * inv;
        }
      }
      for (i = 0; i < 9; i++) {                                   /* stream (pull, periodic) */
        var ex = EX[i], ey = EY[i], base = i * N;
        for (y = 0; y < NY; y++) {
          var ys = y - ey; if (ys < 0) ys += NY; else if (ys >= NY) ys -= NY;
          var row = base + y * NX, srow = base + ys * NX;
          for (x = 0; x < NX; x++) { var xs = x - ex; if (xs < 0) xs += NX; else if (xs >= NX) xs -= NX; f[row + x] = g[srow + xs]; }
        }
      }
      for (y = 0; y < NY; y++) for (i = 0; i < 9; i++) {          /* inlet: equilibrium at U; outlet: zero gradient */
        f[i * N + y * NX] = fin[i];
        f[i * N + y * NX + NX - 1] = f[i * N + y * NX + NX - 2];
      }
    }
    function macro() {
      for (var c = 0; c < N; c++) {
        if (solid[c]) { ux[c] = 0; uy[c] = 0; continue; }
        var r = 0, mx = 0, my = 0;
        for (var i = 0; i < 9; i++) { var fi = f[i * N + c]; r += fi; mx += fi * EX[i]; my += fi * EY[i]; }
        ux[c] = mx / r; uy[c] = my / r;
      }
      for (var y = 1; y < NY - 1; y++) for (var x = 1; x < NX - 1; x++) {
        var k = y * NX + x;
        /* screen y points down: flip sign so the upper shear layer is negative (blue) */
        vort[k] = -((uy[k + 1] - uy[k - 1]) * 0.5 - (ux[k + NX] - ux[k - NX]) * 0.5);
      }
    }
    function init(w, h) {
      W = w; H = h;
      vw = Math.min(NX - 4, NY * W / H); sc = W / vw;
      vx0 = clamp(CX - 3.2 * RC, 0, NX - vw);
      parts = [];
      var n = Math.min(450, Math.round(W * H / 900));
      for (var k = 0; k < n; k++) parts.push(spawn(true));
      if (!f) load();
    }
    function spawn(any) { return { x: any ? vx0 + rand() * vw : vx0 + rand() * 2, y: 1 + rand() * (NY - 2), life: 6 + rand() * 8, h: [] }; }
    function sample(arr, x, y) {
      var i = clamp(x | 0, 0, NX - 2), j = clamp(y | 0, 0, NY - 2), fx = x - i, fy = y - j, k = j * NX + i;
      return arr[k] * (1 - fx) * (1 - fy) + arr[k + 1] * fx * (1 - fy) + arr[k + NX] * (1 - fx) * fy + arr[k + NX + 1] * fx * fy;
    }
    var STEPS = 2;
    function step(dt) {
      if (!ready) return;
      var n = Math.max(1, Math.round(STEPS * dt * 60));
      for (var s = 0; s < n; s++) lbm();
      macro();
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k];
        p.x += sample(ux, p.x, p.y) * n; p.y += sample(uy, p.x, p.y) * n; p.life -= dt;
        var dx = p.x - CX, dy = p.y - CY;
        if (p.x > vx0 + vw || p.y < 1 || p.y > NY - 2 || p.life < 0 || dx * dx + dy * dy < RC * RC) { parts[k] = spawn(false); continue; }
        p.h.push((p.x - vx0) * sc, p.y * sc);
        if (p.h.length > 36) p.h.splice(0, 2);
      }
    }
    function need(x0, y0, s, d) {
      /* refine where |vorticity| is large (sampled over the cell) or next to the body */
      var cx = vx0 + (x0 + s / 2) / sc, cy = (y0 + s / 2) / sc, hs = s / sc / 2;
      if (Math.hypot(cx - CX, cy - CY) - hs * 1.41 < RC * 1.35) return true;
      var m = 0;
      for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) m = Math.max(m, Math.abs(sample(vort, cx + a * hs * 0.8, cy + b * hs * 0.8)));
      return Math.sqrt(m / WSCALE) > 0.2 + 0.11 * d;
    }
    function quad(paths, x0, y0, s, d) {
      if (d < 4 && need(x0, y0, s, d)) {
        var h2 = s / 2;
        quad(paths, x0, y0, h2, d + 1); quad(paths, x0 + h2, y0, h2, d + 1);
        quad(paths, x0, y0 + h2, h2, d + 1); quad(paths, x0 + h2, y0 + h2, h2, d + 1);
      } else paths[d].push(x0, y0, s);
    }
    function draw(ctx) {
      ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      if (!ready) return;
      var d = idata.data, o = 0, iw = 1 / WSCALE;
      for (var c = 0; c < N; c++, o += 4) {
        var w = vort[c], l;
        if (solid[c]) l = 0;
        else { var a = (w < 0 ? -w : w) * iw - 0.02; l = a <= 0 ? 0 : a >= 0.98 ? 255 : (Math.sqrt(a / 0.98) * 255) | 0; }
        var li = ((w > 0 ? 256 : 0) + l) * 3;
        d[o] = LUT[li]; d[o + 1] = LUT[li + 1]; d[o + 2] = LUT[li + 2]; d[o + 3] = 255;
      }
      ictx.putImageData(idata, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, vx0, 0, vw, NY, 0, 0, W, H);
      /* glow: down-sample then up-sample (cheap blur, no canvas filter) */
      gl1.drawImage(img, vx0, 0, vw, NY, 0, 0, glow1.width, glow1.height);
      gl2.drawImage(glow1, 0, 0, glow2.width, glow2.height);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.4;
      ctx.drawImage(glow2, 0, 0, W, H); ctx.restore();
      var paths = [[], [], [], [], []], base = H / 2, k;             /* adaptive mesh */
      for (var bx = 0; bx < W; bx += base) for (var by = 0; by < H - 1; by += base) quad(paths, bx, by, base, 0);
      for (k = 0; k < 5; k++) {
        ctx.strokeStyle = 'rgba(190,225,255,' + (0.06 + 0.05 * k).toFixed(3) + ')'; ctx.lineWidth = 1;
        ctx.beginPath(); var P = paths[k];
        for (var q = 0; q < P.length; q += 3) ctx.rect(Math.round(P[q]) + 0.5, Math.round(P[q + 1]) + 0.5, P[q + 2], P[q + 2]);
        ctx.stroke();
      }
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      trails(ctx, parts, { level: function () { return 0.5; }, style: function () { return { rgb: [200, 220, 240], a: 0.32, w: 1 }; } });
      ctx.restore();
      var px = (CX - vx0) * sc, py = CY * sc, pr = RC * sc;        /* cylinder */
      ctx.save(); ctx.shadowColor = 'rgba(160,210,255,0.6)'; ctx.shadowBlur = pr * 0.8;
      ctx.fillStyle = '#eef4fa'; ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill(); ctx.restore();
      vignette(ctx, W, H);
    }
    return { init: init, step: step, draw: draw, warm: 0 };
  }

  /* ============ 02: Bayesian-optimization style search ============ */
  function Optimize() {
    var W, H, S, x0, y0, chX, chY, chW, chH, N = 96, NF = 48, seed = 1, cyc = -1, T0 = 0, shownPrev = -1;
    var land, pts, best, segs, lo, hi;
    var fill = canvas(N, N), fctx = fill.getContext('2d'), fdat = fctx.createImageData(N, N);
    var fog = canvas(NF, NF), gctx = fog.getContext('2d'), gdat = gctx.createImageData(NF, NF);
    var STEP = 0.5, NP = 22, HOLD = 2.6, LEN = 0.11, LEVELS = 14;
    var STOPS = [[0, [240, 170, 110]], [0.16, [214, 232, 247]], [0.4, [96, 172, 232]], [0.7, [34, 98, 156]], [1, [16, 40, 72]]];
    function cmap(v) {
      v = clamp(v, 0, 1);
      for (var i = 1; i < STOPS.length; i++) if (v <= STOPS[i][0]) { var a = STOPS[i - 1], b = STOPS[i]; return mix(a[1], b[1], (v - a[0]) / (b[0] - a[0])); }
      return STOPS[STOPS.length - 1][1];
    }
    function contours(vals, n) {
      /* marching squares on an (n+1)x(n+1) grid; segments in [0,1] coordinates */
      var out = [];
      for (var L = 1; L < LEVELS; L++) {
        var lev = lo + (hi - lo) * Math.pow(L / LEVELS, 1.35), seg = [];
        for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
          var a = vals[j * (n + 1) + i], b = vals[j * (n + 1) + i + 1], c = vals[(j + 1) * (n + 1) + i + 1], d = vals[(j + 1) * (n + 1) + i];
          var A = a > lev, B = b > lev, C = c > lev, D = d > lev;
          if (A === B && B === C && C === D) continue;
          var e = [];
          if (A !== B) e.push((i + (lev - a) / (b - a)) / n, j / n);
          if (B !== C) e.push((i + 1) / n, (j + (lev - b) / (c - b)) / n);
          if (D !== C) e.push((i + (lev - d) / (c - d)) / n, (j + 1) / n);
          if (A !== D) e.push(i / n, (j + (lev - a) / (d - a)) / n);
          if (e.length >= 4) seg.push(e[0], e[1], e[2], e[3]);
          if (e.length === 8) seg.push(e[4], e[5], e[6], e[7]);
        }
        out.push({ t: L / LEVELS, s: seg });
      }
      return out;
    }
    function newLand() {
      var r = rng(97 + seed * 31), gs = [], k;
      gs.push([0.25 + r() * 0.5, 0.25 + r() * 0.5, -1.0, 0.1 + r() * 0.05]);
      for (k = 0; k < 4; k++) gs.push([r(), r(), -0.35 - r() * 0.35, 0.08 + r() * 0.1]);
      for (k = 0; k < 3; k++) gs.push([r(), r(), 0.4 + r() * 0.3, 0.12 + r() * 0.1]);
      land = function (x, y) {
        var v = 0.15 * ((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5));
        for (var i = 0; i < gs.length; i++) { var dx = x - gs[i][0], dy = y - gs[i][1]; v += gs[i][2] * Math.exp(-(dx * dx + dy * dy) / (2 * gs[i][3] * gs[i][3])); }
        return v;
      };
      var n = 64, vals = new Float32Array((n + 1) * (n + 1)), i, j;
      lo = 1e9; hi = -1e9;
      for (j = 0; j <= n; j++) for (i = 0; i <= n; i++) { var v = land(i / n, j / n); vals[j * (n + 1) + i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      segs = contours(vals, n);
      for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
        var c = cmap(Math.pow((land((i + 0.5) / N, (j + 0.5) / N) - lo) / (hi - lo), 0.75)), o = (j * N + i) * 4, dk = mix(BGC, c, 0.55);
        fdat.data[o] = dk[0]; fdat.data[o + 1] = dk[1]; fdat.data[o + 2] = dk[2]; fdat.data[o + 3] = 255;
      }
      fctx.putImageData(fdat, 0, 0);
      pts = []; best = [];
      var bx = 0, by = 0, bf = 1e9;
      for (k = 0; k < NP; k++) {
        var x, y;
        if (k < 6) { x = 0.08 + 0.84 * ((k * 0.618 + r() * 0.3) % 1); y = 0.08 + 0.84 * ((k * 0.382 + r() * 0.3 + 0.2) % 1); }
        else {
          var rad = 0.35 * Math.pow(0.8, k - 6), cand = null, cf = 1e9;
          for (var q = 0; q < 14; q++) {
            var tx = clamp(bx + (r() * 2 - 1) * rad, 0.03, 0.97), ty = clamp(by + (r() * 2 - 1) * rad, 0.03, 0.97), tf = land(tx, ty) + 0.02 * r();
            if (tf < cf) { cf = tf; cand = [tx, ty]; }
          }
          if (k % 5 === 0) cand = [0.06 + 0.88 * r(), 0.06 + 0.88 * r()];   /* exploration */
          x = cand[0]; y = cand[1];
        }
        var fv = land(x, y);
        if (fv < bf) { bf = fv; bx = x; by = y; }
        pts.push([x, y, fv]); best.push([bx, by, bf]);
      }
      shownPrev = -1;
    }
    function updateFog(shown) {
      /* surrogate uncertainty: fog clears around sampled designs */
      for (var j = 0; j < NF; j++) for (var i = 0; i < NF; i++) {
        var x = (i + 0.5) / NF, y = (j + 0.5) / NF, u = 1;
        for (var k = 0; k < shown; k++) { var dx = x - pts[k][0], dy = y - pts[k][1]; u *= 1 - Math.exp(-(dx * dx + dy * dy) / (2 * LEN * LEN)); }
        var o = (j * NF + i) * 4;
        gdat.data[o] = BGC[0]; gdat.data[o + 1] = BGC[1]; gdat.data[o + 2] = BGC[2]; gdat.data[o + 3] = Math.round(255 * 0.82 * u);
      }
      gctx.putImageData(gdat, 0, 0);
    }
    function init(w, h) {
      W = w; H = h;
      S = Math.min(H * 0.84, W * 0.5);
      chW = Math.min(S * 0.95, W - S - W * 0.16); chH = S * 0.62;
      var gap = Math.max(W * 0.06, 18), total = S + gap + chW;
      x0 = (W - total) / 2; y0 = (H - S) / 2; chX = x0 + S + gap; chY = H / 2 - chH / 2;
      if (cyc < 0) { cyc = 0; newLand(); }
    }
    function step(dt, t) {
      var c = Math.floor(t / (NP * STEP + HOLD));
      if (c !== cyc) { cyc = c; seed++; newLand(); }
      T0 = t - c * (NP * STEP + HOLD);
    }
    function draw(ctx) {
      ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      var shown = Math.min(NP, Math.floor(T0 / STEP) + 1), k;
      if (shown !== shownPrev) { updateFog(shown); shownPrev = shown; }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fill, x0, y0, S, S);
      for (k = 0; k < segs.length; k++) {                          /* contour lines */
        var L = segs[k], s = L.s;
        ctx.strokeStyle = rgba(mix(cmap(L.t), [255, 255, 255], 0.15), 0.75); ctx.lineWidth = k < 3 ? 1.4 : 1;
        ctx.beginPath();
        for (var q = 0; q < s.length; q += 4) { ctx.moveTo(x0 + s[q] * S, y0 + s[q + 1] * S); ctx.lineTo(x0 + s[q + 2] * S, y0 + s[q + 3] * S); }
        ctx.stroke();
      }
      ctx.drawImage(fog, x0, y0, S, S);
      ctx.strokeStyle = 'rgba(233,239,245,0.5)'; ctx.lineWidth = 1.2; var m = S * 0.06;   /* corner marks */
      [[x0, y0, 1, 1], [x0 + S, y0, -1, 1], [x0, y0 + S, 1, -1], [x0 + S, y0 + S, -1, -1]].forEach(function (c) {
        ctx.beginPath(); ctx.moveTo(c[0] + c[2] * m, c[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0], c[1] + c[3] * m); ctx.stroke();
      });
      ctx.strokeStyle = 'rgba(240,170,110,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]); ctx.beginPath();
      for (k = 0; k < shown; k++) { var bp = best[k]; if (k) ctx.lineTo(x0 + bp[0] * S, y0 + bp[1] * S); else ctx.moveTo(x0 + bp[0] * S, y0 + bp[1] * S); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.shadowColor = 'rgba(200,230,255,0.9)'; ctx.shadowBlur = 8;
      for (k = 0; k < shown; k++) {
        var p = pts[k], newest = k === shown - 1;
        ctx.fillStyle = newest ? '#ffffff' : 'rgba(225,238,250,0.85)';
        ctx.beginPath(); ctx.arc(x0 + p[0] * S, y0 + p[1] * S, newest ? 3.4 : 2.3, 0, TAU); ctx.fill();
      }
      ctx.restore();
      var pn = pts[shown - 1], ph = (T0 % STEP) / STEP;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.8 * (1 - ph)).toFixed(3) + ')'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x0 + pn[0] * S, y0 + pn[1] * S, 3.4 + ph * 14, 0, TAU); ctx.stroke();
      var b = best[shown - 1], bxp = x0 + b[0] * S, byp = y0 + b[1] * S;
      ctx.save(); ctx.shadowColor = 'rgba(240,170,110,0.9)'; ctx.shadowBlur = 12;
      ctx.strokeStyle = '#f0aa6e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bxp, byp, 7.5, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bxp - 12, byp); ctx.lineTo(bxp - 9, byp); ctx.moveTo(bxp + 9, byp); ctx.lineTo(bxp + 12, byp);
      ctx.moveTo(bxp, byp - 12); ctx.lineTo(bxp, byp - 9); ctx.moveTo(bxp, byp + 9); ctx.lineTo(bxp, byp + 12); ctx.stroke();
      ctx.restore();
      /* convergence: best objective vs. iteration */
      ctx.strokeStyle = 'rgba(233,239,245,0.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(chX + 0.5, chY); ctx.lineTo(chX + 0.5, chY + chH + 0.5); ctx.lineTo(chX + chW, chY + chH + 0.5); ctx.stroke();
      for (k = 1; k < 4; k++) { ctx.strokeStyle = 'rgba(233,239,245,0.07)'; ctx.beginPath(); ctx.moveTo(chX, chY + chH * k / 4 + 0.5); ctx.lineTo(chX + chW, chY + chH * k / 4 + 0.5); ctx.stroke(); }
      function yv(fv) { return chY + chH * 0.06 + chH * 0.88 * (fv - lo) / (hi - lo); }
      function xv(i) { return chX + chW * (i + 0.5) / NP; }
      ctx.fillStyle = 'rgba(225,238,250,0.4)';
      for (k = 0; k < shown; k++) { ctx.beginPath(); ctx.arc(xv(k), yv(pts[k][2]), 1.8, 0, TAU); ctx.fill(); }
      var gpath = function () { ctx.beginPath(); for (var i = 0; i < shown; i++) { var yy = yv(best[i][2]); if (!i) ctx.moveTo(xv(i), yy); else { ctx.lineTo(xv(i), yv(best[i - 1][2])); ctx.lineTo(xv(i), yy); } } };
      gpath(); ctx.lineTo(xv(shown - 1), chY + chH); ctx.lineTo(xv(0), chY + chH); ctx.closePath();
      var gr = ctx.createLinearGradient(0, chY, 0, chY + chH); gr.addColorStop(0, 'rgba(96,172,232,0.05)'); gr.addColorStop(1, 'rgba(96,172,232,0.28)');
      ctx.fillStyle = gr; ctx.fill();
      ctx.save(); ctx.shadowColor = 'rgba(96,172,232,0.9)'; ctx.shadowBlur = 8; ctx.strokeStyle = '#7cc0f0'; ctx.lineWidth = 2; gpath(); ctx.stroke(); ctx.restore();
      vignette(ctx, W, H);
    }
    return { init: init, step: step, draw: draw };
  }

  /* ============ 03: turbulent flow over a 3D rough surface ============ */
  function Rough() {
    var W, H, s, ox, oy, LX, LZ = 0.6, YM = 0.22, YS = 1.5, NXh, NZh = 60, hgt, bumps, top, surf, parts = [], rand = rng(11), U;
    function P(X, Z, Y) { return [ox + (X + Z * 0.5) * s, oy - Z * 0.5 * s - Y * YS * s]; }
    function hAt(X, Z) {
      var i = clamp(X / LX * (NXh - 1), 0, NXh - 1.001), j = clamp(Z / LZ * (NZh - 1), 0, NZh - 1.001), a = i | 0, b = j | 0, fx = i - a, fz = j - b;
      return hgt[b * NXh + a] * (1 - fx) * (1 - fz) + hgt[b * NXh + a + 1] * fx * (1 - fz) + hgt[(b + 1) * NXh + a] * (1 - fx) * fz + hgt[(b + 1) * NXh + a + 1] * fx * fz;
    }
    function init(w, h) {
      W = w; H = h;
      LX = clamp((W / H) / 1.6, 1, 1.9);
      s = Math.min(W * 0.96 / (LX + 0.5 * LZ), H * 0.92 / (0.5 * LZ + YM * YS));
      ox = (W - (LX + 0.5 * LZ) * s) / 2;
      oy = H - (H - (0.5 * LZ + YM * YS) * s) / 2;
      U = 0.16 * LX;
      var r = rng(4), k, i, j;                                     /* random roughness: Gaussian bumps */
      NXh = Math.round(100 * LX);
      bumps = [];
      var nb = Math.round(190 * LX);
      for (k = 0; k < nb; k++) bumps.push([r() * LX, r() * LZ, 0.009 + r() * 0.012, 0.004 + Math.pow(r(), 2.2) * 0.026]);
      hgt = new Float32Array(NXh * NZh);
      for (j = 0; j < NZh; j++) for (i = 0; i < NXh; i++) {
        var X = i / (NXh - 1) * LX, Z = j / (NZh - 1) * LZ, v = 0;
        for (k = 0; k < nb; k++) { var dx = X - bumps[k][0], dz = Z - bumps[k][1]; v += bumps[k][3] * Math.exp(-(dx * dx + dz * dz) / (2 * bumps[k][2] * bumps[k][2])); }
        hgt[j * NXh + i] = v;
      }
      /* "discovered" drag-inducing elements: the tallest, steepest bumps */
      top = bumps.slice().sort(function (a, b) { return b[3] - a[3]; }).slice(0, Math.round(5 * LX));
      renderSurface();
      parts = [];
      var n = Math.min(650, Math.round(W * H / 200));
      for (k = 0; k < n; k++) parts.push(spawn(true));
    }
    function renderSurface() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      surf = canvas(Math.round(W * dpr), Math.round(H * dpr));
      var c = surf.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      var maxh = 0, i, j, k;
      for (i = 0; i < hgt.length; i++) maxh = Math.max(maxh, hgt[i]);
      var LOWC = [26, 60, 102], MIDC = [56, 132, 200], HIC = [200, 232, 252], HEAT = [245, 160, 96];
      for (j = NZh - 2; j >= 0; j--) for (i = 0; i < NXh - 1; i++) {
        var X0 = i / (NXh - 1) * LX, X1 = (i + 1) / (NXh - 1) * LX, Z0 = j / (NZh - 1) * LZ, Z1 = (j + 1) / (NZh - 1) * LZ;
        var h00 = hgt[j * NXh + i], h10 = hgt[j * NXh + i + 1], h01 = hgt[(j + 1) * NXh + i], h11 = hgt[(j + 1) * NXh + i + 1];
        var p0 = P(X0, Z0, h00), p1 = P(X1, Z0, h10), p2 = P(X1, Z1, h11), p3 = P(X0, Z1, h01);
        var hm = (h00 + h10 + h01 + h11) / 4, t = Math.pow(hm / maxh, 0.7);
        var nx = -(h10 - h00) / (X1 - X0), nz = -(h01 - h00) / (Z1 - Z0), lam = clamp(0.75 + 1.1 * (nx * -0.6 + nz * 0.5) / Math.sqrt(1 + nx * nx + nz * nz), 0.35, 1.35);
        var col = t < 0.5 ? mix(LOWC, MIDC, t * 2) : mix(MIDC, HIC, (t - 0.5) * 2);
        var heat = 0, Xm = (X0 + X1) / 2, Zm = (Z0 + Z1) / 2;     /* explainability heat-map */
        for (k = 0; k < top.length; k++) { var dx = Xm - top[k][0], dz = Zm - top[k][1]; heat = Math.max(heat, Math.exp(-(dx * dx + dz * dz) / (2 * Math.pow(top[k][2] * 1.3, 2)))); }
        col = mix(col, HEAT, heat * 0.75);
        col = [col[0] * lam, col[1] * lam, col[2] * lam];
        c.fillStyle = rgba(col, 1);
        c.beginPath(); c.moveTo(p0[0], p0[1]); c.lineTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]); c.lineTo(p3[0], p3[1]); c.closePath(); c.fill();
        c.strokeStyle = rgba(col, 1); c.lineWidth = 0.5; c.stroke();   /* seal seams */
      }
      c.strokeStyle = 'rgba(200,225,250,0.45)'; c.lineWidth = 1; c.beginPath();   /* front edge */
      for (i = 0; i < NXh; i++) { var q = P(i / (NXh - 1) * LX, 0, hgt[i]); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); }
      c.stroke();
    }
    function spawn(any) {
      var X = any ? rand() * LX : rand() * 0.02, Z = rand() * LZ, h0 = hAt(X, Z);
      return { X: X, Z: Z, Y: h0 + 0.003 + Math.pow(rand(), 2) * (YM - h0), life: 4 + rand() * 8, ph: rand() * TAU, h: [] };
    }
    function step(dt, t) {
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k], h0 = hAt(p.X, p.Z), eta = clamp((p.Y - h0) / (YM - h0), 0, 1);
        var u = U * (0.12 + 0.88 * Math.pow(eta, 0.22)), damp = Math.pow(1 - eta, 1.4);
        var dh = (hAt(p.X + 0.01, p.Z) - h0) / 0.01;
        var vy = u * dh * (1 - eta) + damp * U * 0.22 * Math.sin(p.X * 38 - t * 2.2 + p.ph) * Math.cos(p.Z * 30 + t * 0.7);
        for (var q = 0; q < top.length; q++) {                     /* wakes behind the highlighted elements */
          var dx = p.X - top[q][0], dz = p.Z - top[q][1];
          if (dx > 0 && dx < 0.12 && Math.abs(dz) < top[q][2] * 2) vy += U * 0.35 * damp * Math.exp(-dx / 0.05) * Math.sin(dx * 90 - t * 4);
        }
        p.X += u * dt; p.Y += vy * dt; p.Z += damp * U * 0.12 * Math.sin(t * 1.3 + p.ph) * dt; p.life -= dt;
        if (p.X > LX || p.life < 0 || p.Y < hAt(p.X, p.Z) || p.Y > YM * 1.05 || p.Z < 0 || p.Z > LZ) { parts[k] = spawn(false); continue; }
        var sp = P(p.X, p.Z, p.Y);
        p.e = eta; p.h.push(sp[0], sp[1]);
        if (p.h.length > 70) p.h.splice(0, 2);
      }
    }
    function draw(ctx, t) {
      ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(surf, 0, 0, W, H);
      for (var k = 0; k < top.length; k++) {                       /* pulsing markers */
        var b = top[k], pk = P(b[0], b[1], hAt(b[0], b[1])), ph = ((t || 0) * 0.55 + k * 0.23) % 1, rr = s * 0.032;
        var g = ctx.createRadialGradient(pk[0], pk[1], 0, pk[0], pk[1], rr * 1.6);
        g.addColorStop(0, 'rgba(255,190,130,0.55)'); g.addColorStop(1, 'rgba(255,170,110,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pk[0], pk[1], rr * 1.6, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,190,130,' + (0.85 * (1 - ph)).toFixed(3) + ')'; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.ellipse(pk[0], pk[1], rr * (0.3 + ph * 1.4), rr * (0.3 + ph * 1.4) * 0.45, 0, 0, TAU); ctx.stroke();
      }
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      trails(ctx, parts, {
        level: function (p) { return p.e || 0; },
        style: function (e) { return { rgb: mix([90, 160, 230], [230, 244, 255], e), a: 0.22 + 0.36 * e, w: 1.1 }; }
      });
      ctx.restore();
      vignette(ctx, W, H);
    }
    return { init: init, step: step, draw: draw };
  }

  var KINDS = { cylinder: Cylinder, optimize: Optimize, rough: Rough };
  var items = [];

  function fit(it) {
    var c = it.c, r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    var ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (w !== it.w || h !== it.h) {
      it.w = w; it.h = h; it.art.init(w, h);
      var wu = it.art.warm === undefined ? 3 : it.art.warm;      /* warm-up, seconds */
      for (var k = 0; k < wu * 30; k++) it.art.step(1 / 30, it.t + k / 30);
      it.t += wu;
    }
    return ctx;
  }
  function frame(it, dt) {
    var ctx = fit(it);
    it.t += dt;
    it.art.step(dt, it.t);
    it.art.draw(ctx, it.t);
  }

  document.querySelectorAll('canvas.flow-art').forEach(function (c) {
    var K = KINDS[c.getAttribute('data-art')];
    if (K) items.push({ c: c, art: K(c.getAttribute('data-src')), w: 0, h: 0, t: 0, visible: true });
  });
  if (!items.length) return;

  if (REDUCE) {
    var still = function () { items.forEach(function (it) { it.w = 0; frame(it, 1 / 30); }); };
    still(); setTimeout(still, 800); window.addEventListener('resize', still);
    return;
  }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { items.forEach(function (it) { if (it.c === e.target) it.visible = e.isIntersecting; }); });
    });
    items.forEach(function (it) { io.observe(it.c); });
  }
  var last = 0;
  function loop(ts) {
    var dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 60;
    last = ts;
    if (!document.hidden) items.forEach(function (it) { if (it.visible) frame(it, dt); });
    requestAnimationFrame(loop);
  }
  items.forEach(function (it) { frame(it, 1 / 60); });
  requestAnimationFrame(loop);
})();
