/* =========================================================
   Wedding Video Guestbook — Tahap 6: PWA & Offline
   Dimuat oleh index.html (data-mode="guest") dan admin.html (data-mode="admin").

   - mendaftarkan Service Worker (sw.js)
   - indikator status online/offline (HANYA di dashboard admin; layar tamu tanpa notifikasi)
   - alur pembaruan versi yang AMAN untuk sesi tamu:
       • layar tamu : versi baru diaktifkan hanya saat aplikasi idle
                      (layar sambutan, tidak ada sesi/penyimpanan berjalan)
       • admin      : muncul bilah "Versi baru tersedia" + tombol
   - API window.PWA untuk panel status di dashboard admin

   Catatan: skrip ini TIDAK menyentuh IndexedDB.
   ========================================================= */

(() => {
  "use strict";

  const script = document.currentScript;
  const MODE = (script && script.dataset.mode) === "admin" ? "admin" : "guest";
  const SW_URL = "sw.js";
  const UPDATE_CHECK_MS = 30 * 60 * 1000; // periksa versi baru tiap 30 menit saat online

  const swSupported = "serviceWorker" in navigator;
  const secure = window.isSecureContext;

  let reg = null;
  let waitingWorker = null;
  let hadController = swSupported && !!navigator.serviceWorker.controller;
  let needsReload = false;
  let reloading = false;
  let userInitiated = false;
  let deferredInstall = null;
  let installed = false;
  let lastError = null;
  const listeners = new Set();

  function emit() {
    listeners.forEach((fn) => { try { fn(); } catch (_) { /* diabaikan */ } });
  }

  /* =========================================================
     INDIKATOR ONLINE / OFFLINE
     (navigator.onLine hanya tahu "ada jaringan atau tidak", bukan "internet berfungsi")
     ========================================================= */
  const pill = document.createElement("div");
  pill.className = "net-pill";
  pill.setAttribute("role", "status");
  pill.setAttribute("aria-live", "polite");
  pill.hidden = true;

  let pillHideTimer = null;
  let pillFadeTimer = null;

  function showNet(state) {
    if (MODE !== "admin") return; // layar tamu: tidak ada notifikasi online/offline (mengganggu tampilan)
    clearTimeout(pillHideTimer);
    clearTimeout(pillFadeTimer);
    pill.dataset.state = state;
    pill.textContent = state === "offline" ? "Mode offline · aplikasi tetap berjalan" : "Kembali online";
    pill.hidden = false;
    void pill.offsetWidth;
    pill.classList.add("show");

    if (state === "online") {
      pillHideTimer = setTimeout(() => {
        pill.classList.remove("show");
        pillFadeTimer = setTimeout(() => { pill.hidden = true; }, 500);
      }, 3000);
    }
  }

  function mountPill() {
    if (MODE !== "admin") return; // indikator hanya untuk admin
    document.body.appendChild(pill);
    if (!navigator.onLine) showNet("offline");
  }
  if (document.body) mountPill();
  else document.addEventListener("DOMContentLoaded", mountPill, { once: true });

  window.addEventListener("offline", () => { showNet("offline"); emit(); });
  window.addEventListener("online", () => {
    showNet("online");
    emit();
    checkForUpdate();
  });

  /* =========================================================
     BILAH PEMBARUAN (admin)
     ========================================================= */
  let bar = null;

  function hideBar() {
    if (bar) { bar.remove(); bar = null; }
  }

  function showBar(kind) {
    hideBar();
    bar = document.createElement("div");
    bar.className = "pwa-bar";
    bar.setAttribute("role", "alert");

    const text = document.createElement("p");
    text.textContent =
      kind === "reload"
        ? "Versi baru aplikasi sudah aktif. Muat ulang halaman ini untuk memakainya."
        : "Versi baru aplikasi tersedia.";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = kind === "reload" ? "MUAT ULANG" : "PERBARUI SEKARANG";
    btn.addEventListener("click", () => {
      if (kind === "reload") { reloading = true; location.reload(); }
      else applyUpdate();
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "pwa-bar__close";
    close.setAttribute("aria-label", "Tutup");
    close.textContent = "×";
    close.addEventListener("click", hideBar);

    bar.append(text, btn, close);
    document.body.appendChild(bar);
  }

  /* =========================================================
     ALUR PEMBARUAN
     ========================================================= */
  function guestIdle() {
    const app = window.GuestbookApp;
    return !app || typeof app.isIdle !== "function" || app.isIdle();
  }

  function setWaiting(worker) {
    waitingWorker = worker;
    emit();
    maybeApplyUpdate();
  }

  function maybeApplyUpdate() {
    if (!waitingWorker) return;
    if (MODE === "guest") {
      // Aktifkan hanya saat tidak ada tamu yang sedang direkam / video yang sedang disimpan
      if (guestIdle()) applyUpdate();
    } else {
      showBar("update");
    }
  }

  function applyUpdate() {
    if (!waitingWorker) return false;
    userInitiated = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    return true;
  }

  function maybeReload() {
    if (!needsReload || reloading) return;
    if (MODE === "guest") {
      if (guestIdle()) {
        reloading = true;
        location.reload();
      }
      // jika tidak idle: tunggu event "guestbook:idle"
    } else if (userInitiated) {
      reloading = true;
      location.reload();
    } else {
      showBar("reload"); // pembaruan diaktifkan dari tab lain
    }
  }

  // app.js memberi tahu saat kembali ke layar sambutan / penyimpanan selesai
  window.addEventListener("guestbook:idle", () => {
    maybeReload();
    maybeApplyUpdate();
  });

  function trackInstalling(worker) {
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        setWaiting(worker);
      }
    });
  }

  async function checkForUpdate() {
    if (!reg) return "unavailable";
    if (!navigator.onLine) return "offline";
    try {
      await reg.update();
      const w = reg.installing;
      if (w && w.state === "installing") {
        await new Promise((resolve) => {
          w.addEventListener("statechange", () => { if (w.state !== "installing") resolve(); });
        });
      }
      return waitingWorker || (reg.waiting && navigator.serviceWorker.controller) ? "ready" : "latest";
    } catch (err) {
      return "error";
    }
  }

  /* =========================================================
     PENDAFTARAN SERVICE WORKER
     ========================================================= */
  async function register() {
    if (!swSupported) { lastError = "Browser tidak mendukung Service Worker."; emit(); return; }
    if (!secure) { lastError = "Service Worker membutuhkan HTTPS atau localhost."; emit(); return; }

    try {
      reg = await navigator.serviceWorker.register(SW_URL, { scope: "./", updateViaCache: "none" });
    } catch (err) {
      lastError = "Pendaftaran Service Worker gagal: " + ((err && err.message) || err);
      emit();
      return;
    }

    if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
    if (reg.installing) trackInstalling(reg.installing);
    reg.addEventListener("updatefound", () => {
      if (reg.installing) trackInstalling(reg.installing);
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) {
        // Pemasangan pertama: SW mengambil alih halaman ini, tidak perlu memuat ulang.
        hadController = true;
        emit();
        return;
      }
      needsReload = true;
      emit();
      maybeReload();
    });

    navigator.serviceWorker.ready.then(emit);

    setInterval(checkForUpdate, UPDATE_CHECK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    emit();
  }

  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });

  /* =========================================================
     PEMASANGAN (INSTAL) — hanya dikelola di dashboard admin
     ========================================================= */
  window.addEventListener("beforeinstallprompt", (e) => {
    if (MODE !== "admin") return; // layar tamu: biarkan perilaku bawaan Chrome
    e.preventDefault();
    deferredInstall = e;
    emit();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    installed = true;
    emit();
  });

  async function promptInstall() {
    if (!deferredInstall) return "unavailable";
    const ev = deferredInstall;
    deferredInstall = null;
    ev.prompt();
    let outcome = "dismissed";
    try { outcome = (await ev.userChoice).outcome; } catch (_) { /* diabaikan */ }
    emit();
    return outcome;
  }

  /* =========================================================
     STATUS (untuk panel admin)
     ========================================================= */
  function ask(worker, message, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
      worker.postMessage(message, [ch.port2]);
    });
  }

  async function getStatus() {
    const status = {
      mode: MODE,
      supported: swSupported,
      secure,
      online: navigator.onLine,
      standalone:
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        navigator.standalone === true,
      registered: !!reg,
      controlled: swSupported && !!navigator.serviceWorker.controller,
      workerState: null,
      version: null,
      cacheName: null,
      cachedCount: null,
      expectedCount: null,
      precacheComplete: false,
      updateReady: !!waitingWorker,
      canInstall: !!deferredInstall,
      installed,
      error: lastError,
    };

    if (reg) {
      const w = reg.active || reg.waiting || reg.installing;
      status.workerState = w ? w.state : null;
      if (reg.active) {
        try { Object.assign(status, await ask(reg.active, { type: "GET_INFO" })); } catch (_) { /* diabaikan */ }
      }
    }
    return status;
  }

  window.PWA = {
    mode: MODE,
    getStatus,
    checkForUpdate,
    applyUpdate,
    promptInstall,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
