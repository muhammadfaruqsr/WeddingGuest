/* =========================================================
   Wedding Video Guestbook — Efek visual interaktif (fx.js)
   - debu emas melayang (canvas latar)
   - percikan emas saat layar disentuh / digeser
   - confetti emas di layar Terima Kasih
   - kemiringan 3D mengikuti sentuhan / sensor gerak (--tx, --ty)
   - denyut cincin saat hitung mundur
   - mode ringan otomatis bila perangkat lambat
   Semua efek MATI di layar rekam dan bila "kurangi animasi" aktif.
   Skrip ini tidak menyentuh IndexedDB maupun kamera.
   ========================================================= */
(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const bg = document.getElementById("fxBg");
  const top = document.getElementById("fxTop");
  if (!bg || !top) return;

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctxB = bg.getContext("2d");
  const ctxT = top.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let screenName = body.dataset.screen || "welcome";
  let lite = false;

  const GOLD = ["#fff3cf", "#f6e2aa", "#e6d2a6", "#cfb07a", "#ffffff"];
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---------- ukuran canvas ---------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = bg.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    [bg, top].forEach((c) => { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); });
    ctxB.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxT.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedDust();
  }

  /* ---------- sprite cahaya (digambar sekali) ---------- */
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 32;
  (() => {
    const g = sprite.getContext("2d");
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,244,210,1)");
    grad.addColorStop(0.25, "rgba(246,226,170,0.7)");
    grad.addColorStop(1, "rgba(207,176,122,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  })();

  /* ---------- debu emas ---------- */
  let dust = [];
  function seedDust() {
    const n = lite ? 18 : Math.round(Math.min(46, (W * H) / 26000));
    dust = Array.from({ length: n }, () => ({
      x: rnd(0, W), y: rnd(0, H), s: rnd(5, 17), vy: rnd(-9, -3), vx: rnd(-4, 4),
      ph: rnd(0, 6.28), sp: rnd(0.6, 1.6), z: rnd(0.4, 1),
    }));
  }

  /* ---------- percikan & confetti ---------- */
  const sparks = [];
  const confetti = [];
  const MAX_SPARKS = 220;

  function burst(x, y, n, power) {
    for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
      const a = rnd(0, 6.283), v = rnd(0.3, 1) * power;
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - power * 0.25, life: 1, d: rnd(0.9, 1.6), s: rnd(6, 16) });
    }
    wake();
  }

  function launchConfetti() {
    if (reduce) return;
    const n = lite ? 40 : 110;
    for (let i = 0; i < n; i++) {
      confetti.push({
        x: rnd(0, W), y: rnd(-H * 0.5, -10), vx: rnd(-40, 40), vy: rnd(120, 300),
        w: rnd(6, 13), h: rnd(10, 20), rot: rnd(0, 6.28), vr: rnd(-6, 6),
        c: GOLD[(Math.random() * GOLD.length) | 0], ph: rnd(0, 6.28),
      });
    }
    wake();
  }

  /* ---------- loop ---------- */
  let raf = 0, last = 0, running = false;
  function active() { return screenName !== "recording" && !document.hidden; }

  function wake() {
    if (running || reduce || !active()) return;
    running = true; last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ctxB.clearRect(0, 0, W, H);
    ctxT.clearRect(0, 0, W, H);
  }

  // pantau FPS untuk mode ringan
  let slowFrames = 0, fpsT = 0, fpsN = 0;
  function watchFps(dt) {
    fpsT += dt; fpsN++;
    if (fpsT < 2) return;
    const fps = fpsN / fpsT;
    fpsT = 0; fpsN = 0;
    if (fps < 24) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
    if (!lite && slowFrames >= 2) {
      lite = true; body.classList.add("lite"); seedDust();
    }
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    watchFps(dt);

    // latar: debu
    ctxB.clearRect(0, 0, W, H);
    ctxB.globalCompositeOperation = "lighter";
    for (const p of dust) {
      p.y += p.vy * dt * p.z; p.x += (p.vx + Math.sin(now / 1800 + p.ph) * 6) * dt * p.z;
      p.x += tiltX * -14 * dt * p.z;
      if (p.y < -20) { p.y = H + 20; p.x = rnd(0, W); }
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(now / 1000 * p.sp + p.ph));
      ctxB.globalAlpha = a * p.z;
      ctxB.drawImage(sprite, p.x - p.s, p.y - p.s, p.s * 2, p.s * 2);
    }
    ctxB.globalAlpha = 1;
    ctxB.globalCompositeOperation = "source-over";

    // atas: percikan + confetti
    ctxT.clearRect(0, 0, W, H);
    ctxT.globalCompositeOperation = "lighter";
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt * s.d;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      s.vy += 260 * dt; s.vx *= 0.985; s.x += s.vx * dt; s.y += s.vy * dt;
      ctxT.globalAlpha = Math.max(0, s.life);
      const r = s.s * (0.5 + s.life * 0.6);
      ctxT.drawImage(sprite, s.x - r, s.y - r, r * 2, r * 2);
    }
    ctxT.globalCompositeOperation = "source-over";
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i];
      c.ph += dt * 4; c.rot += c.vr * dt;
      c.x += (c.vx + Math.sin(c.ph) * 30) * dt; c.y += c.vy * dt;
      if (c.y > H + 30) { confetti.splice(i, 1); continue; }
      ctxT.save();
      ctxT.translate(c.x, c.y); ctxT.rotate(c.rot);
      ctxT.scale(1, Math.cos(c.ph)); // efek berputar 3D
      ctxT.globalAlpha = 0.92; ctxT.fillStyle = c.c;
      ctxT.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctxT.restore();
    }
    ctxT.globalAlpha = 1;

    smoothTilt(dt);
    raf = requestAnimationFrame(frame);
  }

  /* ---------- kemiringan 3D ---------- */
  let tiltX = 0, tiltY = 0, tx = 0, ty = 0;
  let lastGyro = 0;
  function smoothTilt(dt) {
    const k = 1 - Math.exp(-6 * dt);
    tiltX += (tx - tiltX) * k; tiltY += (ty - tiltY) * k;
    root.style.setProperty("--tx", tiltX.toFixed(3));
    root.style.setProperty("--ty", tiltY.toFixed(3));
  }
  const clamp = (v) => Math.max(-1, Math.min(1, v));

  function onPointerMove(e) {
    if (performance.now() - lastGyro < 600) return;
    tx = clamp((e.clientX / window.innerWidth - 0.5) * 2);
    ty = clamp((e.clientY / window.innerHeight - 0.5) * 2);
    wake();
  }
  function onOrient(e) {
    if (e.gamma == null) return;
    lastGyro = performance.now();
    tx = clamp(e.gamma / 25);
    ty = clamp(((e.beta || 0) - 40) / 25);
    wake();
  }

  /* ---------- interaksi ---------- */
  function ignoreTarget(t) {
    return t && t.closest && t.closest("#adminHotspot");
  }
  let lastTrail = 0;
  window.addEventListener("pointerdown", (e) => {
    if (ignoreTarget(e.target) || screenName === "recording" || reduce) return;
    burst(e.clientX, e.clientY, lite ? 8 : 18, 170);
  }, { passive: true });
  window.addEventListener("pointermove", (e) => {
    if (reduce || screenName === "recording") return;
    onPointerMove(e);
    if (e.buttons || e.pointerType === "touch") {
      const now = performance.now();
      if (now - lastTrail > 45 && !ignoreTarget(e.target)) {
        lastTrail = now;
        burst(e.clientX, e.clientY, 2, 60);
      }
    }
  }, { passive: true });
  window.addEventListener("deviceorientation", (e) => { if (!reduce && screenName !== "recording") onOrient(e); }, { passive: true });

  /* ---------- peristiwa dari app.js ---------- */
  window.addEventListener("guestbook:screen", (e) => {
    screenName = (e.detail && e.detail.name) || screenName;
    if (screenName === "recording") { stop(); tx = ty = tiltX = tiltY = 0; return; }
    wake();
    if (screenName === "thanks") setTimeout(launchConfetti, 350);
  });

  window.addEventListener("guestbook:tick", (e) => {
    if (reduce) return;
    const ring = document.querySelector(".countdown__ring");
    if (ring) {
      ring.classList.remove("pulse");
      void ring.offsetWidth;
      ring.classList.add("pulse");
      const r = ring.getBoundingClientRect();
      const host = bg.getBoundingClientRect();
      burst(r.left - host.left + r.width / 2, r.top - host.top + r.height / 2, lite ? 14 : 34, 260);
    }
  });

  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else wake(); });
  window.addEventListener("resize", () => { resize(); wake(); });
  window.addEventListener("orientationchange", () => setTimeout(() => { resize(); wake(); }, 250));

  /* ---------- mulai ---------- */
  screenName = body.dataset.screen || "welcome";
  resize();
  if (reduce) { body.classList.add("lite"); } else wake();
})();
