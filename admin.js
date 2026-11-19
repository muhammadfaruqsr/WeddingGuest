/* =========================================================
   Wedding Video Guestbook — Tahap 5: Dashboard Admin
   Semua data tetap di IndexedDB (lewat db.js → window.VideoDB).
   Tidak ada server, tidak ada cloud.

   PERINGATAN KEAMANAN: PIN diperiksa di browser. Ini hanya pembatas
   akses biasa dan TIDAK setara dengan keamanan sisi server.
   ========================================================= */

(() => {
  "use strict";

  const DB = window.VideoDB;

  /* ---------- Konfigurasi ---------- */
  const CFG = {
    defaultPin: "1234",              // HANYA untuk pengujian — harus diganti lewat menu Keamanan
    pbkdf2Iterations: 150000,
    sessionKey: "guestbook-admin-session",
    lockKey: "guestbook-admin-lock",
    idleLockMs: 10 * 60 * 1000,      // kunci otomatis setelah 10 menit tanpa aktivitas
    maxFails: 5,
    lockMs: 30 * 1000,
    defaultBride: "Alya",
    defaultGroom: "Dimas",
    maxNameLength: 30,
    maxIntroBytes: 500 * 1024 * 1024,
  };

  /* ---------- Elemen ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    lockScreen: $("lockScreen"), pinForm: $("pinForm"), pinInput: $("pinInput"),
    pinError: $("pinError"), pinSubmit: $("pinSubmit"),
    app: $("adminApp"), brandName: $("brandName"), lockBtn: $("lockBtn"),
    banner: $("defaultPinBanner"), bannerGo: $("bannerGoSecurity"),
    statCount: $("statCount"), statDuration: $("statDuration"), statSize: $("statSize"),
    statSizeSub: $("statSizeSub"), statFree: $("statFree"), statFreeSub: $("statFreeSub"),
    galleryCount: $("galleryCount"), refreshBtn: $("refreshBtn"),
    galleryLoading: $("galleryLoading"), galleryEmpty: $("galleryEmpty"),
    galleryError: $("galleryError"), galleryErrorText: $("galleryErrorText"),
    galleryRetry: $("galleryRetry"), galleryGrid: $("galleryGrid"),
    eventForm: $("eventForm"), brideInput: $("brideInput"), groomInput: $("groomInput"),
    namePreview: $("namePreview"), eventError: $("eventError"), eventSaveBtn: $("eventSaveBtn"),
    introChip: $("introChip"), introDetails: $("introDetails"), introError: $("introError"),
    introPlayBtn: $("introPlayBtn"), introPickBtn: $("introPickBtn"), introFile: $("introFile"),
    changePinForm: $("changePinForm"), curPin: $("curPin"), newPin: $("newPin"),
    confirmPin: $("confirmPin"), pinChangeError: $("pinChangeError"),
    pinChangeBtn: $("pinChangeBtn"), pinStatus: $("pinStatus"),
    playerDialog: $("playerDialog"), playerTitle: $("playerTitle"), playerVideo: $("playerVideo"),
    playerClose: $("playerClose"), playerLoading: $("playerLoading"),
    confirmDialog: $("confirmDialog"), confirmTitle: $("confirmTitle"),
    confirmMessage: $("confirmMessage"), confirmOk: $("confirmOk"), confirmCancel: $("confirmCancel"),
    toast: $("toast"),
  };
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const views = {
    gallery: $("view-gallery"),
    event: $("view-event"),
    security: $("view-security"),
    app: $("view-app"),
  };

  /* ---------- Util ---------- */
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* diabaikan */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (_) { /* diabaikan */ } },
  };

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>',
  };
  function iconSpan(name) {
    const s = document.createElement("span");
    s.innerHTML = ICONS[name]; // string statis, bukan data pengguna
    return s;
  }

  function formatBytes(bytes) {
    if (bytes == null || Number.isNaN(bytes)) return "–";
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms)) return "–:––";
    const t = Math.round(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }

  function formatTotalDuration(ms) {
    const t = Math.round(ms / 1000);
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    if (hh > 0) return `${hh} j ${String(mm).padStart(2, "0")} m`;
    if (mm > 0) return `${mm} m ${String(ss).padStart(2, "0")} d`;
    return `${ss} d`;
  }

  const dateFmt = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  function formatDate(ms) { return Number.isFinite(ms) ? dateFmt.format(new Date(ms)) : "–"; }
  function formatTime(ms) { return Number.isFinite(ms) ? timeFmt.format(new Date(ms)).replace(/\./g, ":") : "–"; }

  /* ---------- Toast ---------- */
  let toastTimer = null, toastHide = null;
  function showToast(text, kind) {
    clearTimeout(toastTimer);
    clearTimeout(toastHide);
    el.toast.textContent = text;
    el.toast.classList.toggle("toast--error", kind === "error");
    el.toast.hidden = false;
    void el.toast.offsetWidth;
    el.toast.classList.add("show");
    toastTimer = setTimeout(() => {
      el.toast.classList.remove("show");
      toastHide = setTimeout(() => { el.toast.hidden = true; }, 450);
    }, 3500);
  }

  function showMsg(node, text) {
    node.textContent = text;
    node.hidden = !text;
  }

  /* ---------- Dialog konfirmasi (promise) ---------- */
  function ask({ title, message, okLabel, danger }) {
    return new Promise((resolve) => {
      el.confirmTitle.textContent = title;
      el.confirmMessage.textContent = message;
      el.confirmOk.textContent = okLabel;
      el.confirmOk.classList.toggle("btn--danger", !!danger);
      el.confirmOk.classList.toggle("btn--primary", !danger);
      el.confirmDialog.returnValue = ""; // Esc / klik latar = batal
      el.confirmDialog.addEventListener("close", () => resolve(el.confirmDialog.returnValue === "ok"), { once: true });
      el.confirmDialog.showModal();
    });
  }

  // Klik di area gelap (backdrop) menutup dialog
  [el.confirmDialog, el.playerDialog].forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  });

  /* =========================================================
     PIN & SESI
     ========================================================= */
  const enc = new TextEncoder();
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function cryptoAvailable() {
    return !!(window.crypto && window.crypto.subtle);
  }

  async function derive(pin, saltBytes, iterations) {
    const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
      key,
      256
    );
    return toB64(bits);
  }

  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // Belum ada PIN tersimpan → pakai PIN default pengujian
  async function verifyPin(pin) {
    const auth = await DB.getConfig("adminAuth");
    if (!auth) return { ok: safeEqual(pin, CFG.defaultPin), isDefault: true };
    if (!cryptoAvailable()) throw new Error("Verifikasi PIN membutuhkan HTTPS atau localhost.");
    const hash = await derive(pin, fromB64(auth.salt), auth.iterations);
    return { ok: safeEqual(hash, auth.hash), isDefault: false };
  }

  async function storePin(pin) {
    if (!cryptoAvailable()) throw new Error("Penyimpanan PIN membutuhkan HTTPS atau localhost.");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(pin, salt, CFG.pbkdf2Iterations);
    await DB.setConfig("adminAuth", {
      salt: toB64(salt),
      hash,
      iterations: CFG.pbkdf2Iterations,
      algo: "PBKDF2-SHA256",
      updatedAt: Date.now(),
    });
  }

  // Pembatasan percobaan (sekadar menyulitkan tebak-tebakan, bukan pengaman sungguhan)
  function readLock() {
    try { return JSON.parse(store.get(CFG.lockKey)) || { fails: 0, until: 0 }; } catch (_) { return { fails: 0, until: 0 }; }
  }
  function writeLock(v) { store.set(CFG.lockKey, JSON.stringify(v)); }

  let unlocked = false;
  let lastTouch = 0;

  function sessionValid() {
    const t = Number(store.get(CFG.sessionKey));
    return !!t && Date.now() - t < CFG.idleLockMs;
  }
  function touchSession() {
    if (!unlocked) return;
    const now = Date.now();
    if (now - lastTouch < 5000) return;
    lastTouch = now;
    store.set(CFG.sessionKey, String(now));
  }
  ["pointerdown", "keydown", "scroll"].forEach((ev) =>
    document.addEventListener(ev, touchSession, { passive: true, capture: true })
  );
  setInterval(() => {
    if (unlocked && !sessionValid()) lockApp("Sesi berakhir karena tidak ada aktivitas. Masukkan PIN lagi.");
  }, 15000);

  el.pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const lock = readLock();
    if (lock.until > Date.now()) {
      showMsg(el.pinError, `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((lock.until - Date.now()) / 1000)} detik.`);
      return;
    }

    const pin = el.pinInput.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      showMsg(el.pinError, "PIN terdiri dari 4–8 angka.");
      return;
    }

    el.pinSubmit.disabled = true;
    try {
      const r = await verifyPin(pin);
      if (r.ok) {
        writeLock({ fails: 0, until: 0 });
        store.set(CFG.sessionKey, String(Date.now()));
        await unlockApp();
      } else {
        const fails = lock.fails + 1;
        if (fails >= CFG.maxFails) {
          writeLock({ fails: 0, until: Date.now() + CFG.lockMs });
          showMsg(el.pinError, `PIN salah ${CFG.maxFails} kali. Coba lagi dalam ${CFG.lockMs / 1000} detik.`);
        } else {
          writeLock({ fails, until: 0 });
          showMsg(el.pinError, `PIN salah. Sisa percobaan: ${CFG.maxFails - fails}.`);
        }
        el.pinInput.value = "";
        el.pinInput.focus();
      }
    } catch (err) {
      showMsg(el.pinError, err.message || "Tidak dapat memeriksa PIN.");
    } finally {
      el.pinSubmit.disabled = false;
    }
  });

  async function unlockApp() {
    unlocked = true;
    lastTouch = Date.now();
    el.lockScreen.hidden = true;
    el.app.hidden = false;
    el.pinInput.value = "";
    showMsg(el.pinError, "");
    await refreshBrand();
    await refreshPinBanner();
    setView("gallery");
  }

  function lockApp(message) {
    unlocked = false;
    store.del(CFG.sessionKey);
    el.playerDialog.close();
    el.confirmDialog.close();
    releasePreviews();
    el.galleryGrid.replaceChildren();
    el.app.hidden = true;
    el.lockScreen.hidden = false;
    showMsg(el.pinError, message || "");
    el.pinInput.value = "";
    el.pinInput.focus();
  }

  el.lockBtn.addEventListener("click", () => lockApp(""));

  async function refreshPinBanner() {
    try {
      const auth = await DB.getConfig("adminAuth");
      el.banner.hidden = !!auth;
      el.pinStatus.textContent = auth
        ? "PIN kustom aktif. Anda dapat menggantinya kapan saja."
        : "PIN default pengujian masih dipakai. Segera ganti dengan PIN Anda sendiri.";
    } catch (_) { /* diabaikan */ }
  }
  el.bannerGo.addEventListener("click", () => setView("security"));

  /* =========================================================
     NAVIGASI
     ========================================================= */
  function setView(name) {
    tabs.forEach((t) => {
      const active = t.dataset.view === name;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
    });
    Object.entries(views).forEach(([key, node]) => { node.hidden = key !== name; });
    window.scrollTo({ top: 0 });

    if (name === "gallery") loadGallery();
    if (name === "event") loadEventSettings();
    if (name === "security") refreshPinBanner();
    if (name === "app") renderPwaPanel();
  }
  tabs.forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

  /* =========================================================
     NAMA PENGANTIN
     ========================================================= */
  async function getEventConfig() {
    try { return (await DB.getConfig("event")) || null; } catch (_) { return null; }
  }

  async function refreshBrand() {
    const cfg = await getEventConfig();
    const bride = (cfg && cfg.brideName) || CFG.defaultBride;
    const groom = (cfg && cfg.groomName) || CFG.defaultGroom;
    el.brandName.textContent = `${bride} & ${groom}`;
  }

  function updateNamePreview() {
    const b = el.brideInput.value.trim() || CFG.defaultBride;
    const g = el.groomInput.value.trim() || CFG.defaultGroom;
    el.namePreview.textContent = `${b} & ${g}`;
  }
  el.brideInput.addEventListener("input", updateNamePreview);
  el.groomInput.addEventListener("input", updateNamePreview);

  el.eventForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showMsg(el.eventError, "");

    const bride = el.brideInput.value.trim().replace(/\s+/g, " ");
    const groom = el.groomInput.value.trim().replace(/\s+/g, " ");
    if (!bride || !groom) {
      showMsg(el.eventError, "Kedua nama pengantin wajib diisi.");
      return;
    }
    if (bride.length > CFG.maxNameLength || groom.length > CFG.maxNameLength) {
      showMsg(el.eventError, `Nama maksimal ${CFG.maxNameLength} karakter.`);
      return;
    }

    el.eventSaveBtn.disabled = true;
    try {
      await DB.setConfig("event", { brideName: bride, groomName: groom, updatedAt: Date.now() });
      showToast("✓ Nama pengantin disimpan");
      await refreshBrand();
    } catch (err) {
      showMsg(el.eventError, err.message || "Gagal menyimpan nama.");
    } finally {
      el.eventSaveBtn.disabled = false;
    }
  });

  /* =========================================================
     VIDEO INTRO
     ========================================================= */
  async function renderIntro() {
    showMsg(el.introError, "");
    let intro = null;
    try {
      intro = await DB.getIntro();
    } catch (err) {
      el.introChip.textContent = "Gagal memeriksa";
      el.introChip.className = "chip";
      el.introDetails.replaceChildren();
      showMsg(el.introError, err.message);
      return;
    }

    el.introDetails.replaceChildren();
    if (intro && intro.blob) {
      el.introChip.textContent = "Tersimpan";
      el.introChip.className = "chip chip--ok";
      const rows = [
        ["Berkas", intro.fileName || "intro"],
        ["Format", `${(intro.extension || "").toUpperCase()} · ${intro.mimeType}`],
        ["Ukuran", formatBytes(intro.size)],
        ["Disimpan", `${formatDate(intro.savedAtMs)} ${formatTime(intro.savedAtMs)}`],
        ["Sumber", intro.source === "admin" ? "Diunggah lewat dashboard" : "Disalin otomatis dari assets/intro.mp4"],
      ];
      rows.forEach(([k, v]) => el.introDetails.append(h("dt", { text: k }), h("dd", { text: v })));
      el.introPlayBtn.hidden = false;
      el.introPickBtn.textContent = "GANTI VIDEO INTRO";
    } else {
      el.introChip.textContent = "Belum ada intro";
      el.introChip.className = "chip chip--none";
      el.introDetails.append(h("dt", { text: "Status" }), h("dd", { text: "Tamu langsung ke hitung mundur tanpa video pembuka." }));
      el.introPlayBtn.hidden = true;
      el.introPickBtn.textContent = "UNGGAH VIDEO INTRO";
    }
  }

  function setIntroBusy(busy) {
    el.introPickBtn.disabled = busy;
    el.introPlayBtn.disabled = busy;
    if (busy) {
      el.introChip.textContent = "Menyimpan…";
      el.introChip.className = "chip";
    }
  }

  el.introPickBtn.addEventListener("click", () => el.introFile.click());

  el.introFile.addEventListener("change", async () => {
    const file = el.introFile.files && el.introFile.files[0];
    el.introFile.value = ""; // izinkan memilih berkas yang sama lagi
    if (!file) return;
    showMsg(el.introError, "");

    if (file.size === 0) { showMsg(el.introError, "Berkas kosong."); return; }
    if (file.size > CFG.maxIntroBytes) {
      showMsg(el.introError, `Berkas terlalu besar (maksimal ${formatBytes(CFG.maxIntroBytes)}).`);
      return;
    }
    const fmt = await DB.sniffVideoFormat(file);
    if (!fmt) {
      showMsg(el.introError, "Berkas bukan video MP4 atau WebM yang valid. Pilih berkas lain.");
      return;
    }

    let existing = null;
    try { existing = await DB.getIntro(); } catch (_) { /* diabaikan */ }

    const ok = await ask({
      title: existing ? "Ganti video intro?" : "Simpan video intro?",
      message: `${file.name} (${formatBytes(file.size)}). ` +
        (existing ? "Video intro yang sekarang akan digantikan untuk tamu berikutnya." : "Video ini akan diputar sebelum tamu merekam."),
      okLabel: existing ? "GANTI" : "SIMPAN",
      danger: false,
    });
    if (!ok) return;

    setIntroBusy(true);
    try {
      await DB.saveIntro(file, { mimeType: file.type, source: "admin", fileName: file.name, sourceInfo: {} });
      showToast("✓ Video intro disimpan");
    } catch (err) {
      showMsg(el.introError, err.message || "Gagal menyimpan video intro.");
    } finally {
      setIntroBusy(false);
      await renderIntro();
    }
  });

  el.introPlayBtn.addEventListener("click", async () => {
    openPlayer("Video Intro", async () => {
      const intro = await DB.getIntro();
      if (!intro || !intro.blob) throw new Error("Video intro tidak ditemukan.");
      return intro.blob;
    });
  });

  async function loadEventSettings() {
    const cfg = await getEventConfig();
    el.brideInput.value = (cfg && cfg.brideName) || "";
    el.groomInput.value = (cfg && cfg.groomName) || "";
    el.brideInput.placeholder = CFG.defaultBride;
    el.groomInput.placeholder = CFG.defaultGroom;
    showMsg(el.eventError, "");
    updateNamePreview();
    await renderIntro();
  }

  /* =========================================================
     PEMUTAR
     ========================================================= */
  let playerUrl = null;

  async function openPlayer(title, loadBlob) {
    el.playerTitle.textContent = title;
    el.playerLoading.hidden = false;
    if (!el.playerDialog.open) el.playerDialog.showModal();

    try {
      const blob = await loadBlob();
      if (!el.playerDialog.open) return; // dialog ditutup saat memuat
      playerUrl = URL.createObjectURL(blob);
      el.playerVideo.src = playerUrl;
      const p = el.playerVideo.play();
      if (p && p.catch) p.catch(() => {});
    } catch (err) {
      el.playerDialog.close();
      showToast(err.message || "Video tidak dapat diputar.", "error");
    } finally {
      el.playerLoading.hidden = true;
    }
  }

  // File WebM hasil MediaRecorder sering tanpa durasi (Infinity) → paksa browser menghitungnya agar bisa digeser.
  el.playerVideo.addEventListener("loadedmetadata", () => {
    const v = el.playerVideo;
    if (v.duration === Infinity) {
      v.currentTime = 1e101;
      v.addEventListener("timeupdate", function fix() {
        v.removeEventListener("timeupdate", fix);
        v.currentTime = 0;
      });
    }
  });

  el.playerDialog.addEventListener("close", () => {
    el.playerVideo.pause();
    el.playerVideo.removeAttribute("src");
    el.playerVideo.load();
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  });
  el.playerClose.addEventListener("click", () => el.playerDialog.close());

  /* =========================================================
     GALERI
     ========================================================= */
  let previewUrls = [];
  let previewObserver = null;
  let loadToken = 0;

  function releasePreviews() {
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    previewUrls.forEach((u) => URL.revokeObjectURL(u));
    previewUrls = [];
  }

  function setGalleryState(name) {
    el.galleryLoading.hidden = name !== "loading";
    el.galleryEmpty.hidden = name !== "empty";
    el.galleryError.hidden = name !== "error";
    el.galleryGrid.hidden = name !== "grid";
  }

  async function loadGallery({ silent = false } = {}) {
    const token = ++loadToken;
    if (!silent) setGalleryState("loading");

    try {
      const [list, info, intro] = await Promise.all([
        DB.listVideos(),
        DB.getStorageInfo(),
        DB.getIntro().catch(() => null),
      ]);
      if (token !== loadToken || !unlocked) return;
      renderStats(list, info, intro);
      renderGallery(list);
    } catch (err) {
      if (token !== loadToken) return;
      el.galleryErrorText.textContent = err.message || "Gagal memuat video.";
      setGalleryState("error");
    }
  }

  function renderStats(list, info, intro) {
    const totalSize = list.reduce((s, v) => s + (v.size || 0), 0);
    const totalMs = list.reduce((s, v) => s + (Number.isFinite(v.durationMs) ? v.durationMs : 0), 0);

    el.statCount.textContent = String(list.length);
    el.statDuration.textContent = list.length ? formatTotalDuration(totalMs) : "0 d";
    el.statSize.textContent = formatBytes(totalSize);
    el.statSizeSub.textContent = intro && intro.size ? `+ intro ${formatBytes(intro.size)}` : "tanpa video intro";

    if (info.supported && info.free != null) {
      el.statFree.textContent = formatBytes(info.free);
      let sub = `perkiraan, dari kuota ${formatBytes(info.quota)}`;
      if (info.persisted === true) sub += " · persistent diminta & dikabulkan";
      else if (info.persisted === false) sub += " · persistent belum aktif";
      el.statFreeSub.textContent = sub;
    } else {
      el.statFree.textContent = "–";
      el.statFreeSub.textContent = "tidak tersedia di browser ini";
    }
  }

  function renderGallery(list) {
    releasePreviews();
    el.galleryGrid.replaceChildren();
    el.galleryCount.textContent = list.length ? `· ${list.length} video` : "";

    if (!list.length) {
      setGalleryState("empty");
      return;
    }

    // Terbaru lebih dulu
    const sorted = [...list].sort(
      (a, b) => (b.recordedAtMs || 0) - (a.recordedAtMs || 0) || b.sequence - a.sequence
    );

    if ("IntersectionObserver" in window) {
      previewObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              previewObserver.unobserve(entry.target);
              loadPreview(entry.target);
            }
          }
        },
        { rootMargin: "250px" }
      );
    }

    sorted.forEach((v) => {
      const card = createCard(v);
      el.galleryGrid.append(card);
      if (previewObserver) previewObserver.observe(card);
      else loadPreview(card);
    });

    setGalleryState("grid");
  }

  function createCard(v) {
    const title = `Video #${v.sequence}`;

    const video = h("video", { muted: true, playsinline: true, preload: "metadata", tabindex: "-1", "aria-hidden": "true" });
    video.muted = true;
    const placeholder = h("div", { class: "card__placeholder", text: "Memuat preview…" });

    const playBtn = h("button", {
      class: "card__play", type: "button", "aria-label": `Putar ${title}`,
      onclick: () => playVideo(v),
    }, h("span", {}, iconSpan("play").firstChild));

    const media = h("div", { class: "card__media" },
      video, placeholder, playBtn,
      h("span", { class: "badge badge--no", text: `#${v.sequence}` }),
      h("span", { class: "badge badge--dur", text: formatClock(v.durationMs) })
    );

    const body = h("div", { class: "card__body" },
      h("h3", { class: "card__title", text: title }),
      h("p", { class: "card__meta", text: `${formatDate(v.recordedAtMs)} · ${formatTime(v.recordedAtMs)}` }),
      h("p", { class: "card__meta", text: `${formatClock(v.durationMs)} · ${formatBytes(v.size)} · ${(v.extension || "").toUpperCase()}` }),
      h("p", { class: "card__file", text: v.fileName || v.id })
    );

    const actions = h("div", { class: "card__actions" },
      h("button", { class: "btn btn--primary", type: "button", text: "PUTAR", onclick: () => playVideo(v) }),
      h("button", { class: "btn btn--ghost", type: "button", text: "UNDUH", onclick: (e) => downloadVideo(v, e.currentTarget) }),
      h("button", { class: "btn btn--outline-danger", type: "button", text: "HAPUS", onclick: (e) => deleteVideoFlow(v, e.currentTarget.closest(".card")) })
    );

    const card = h("article", { class: "card" }, media, body, actions);
    card.dataset.id = v.id;
    return card;
  }

  async function loadPreview(card) {
    const video = card.querySelector("video");
    const placeholder = card.querySelector(".card__placeholder");
    const fail = () => { placeholder.textContent = "Preview tidak tersedia"; placeholder.hidden = false; };

    try {
      const rec = await DB.getVideo(card.dataset.id);
      if (!rec || !rec.blob || !card.isConnected) return;
      const url = URL.createObjectURL(rec.blob);
      previewUrls.push(url);
      video.addEventListener("loadeddata", () => { placeholder.hidden = true; }, { once: true });
      video.addEventListener("error", fail, { once: true });
      video.src = url + "#t=0.1";
    } catch (_) {
      fail();
    }
  }

  /* ---------- Aksi video ---------- */
  function playVideo(v) {
    openPlayer(`Video #${v.sequence}`, async () => {
      const rec = await DB.getVideo(v.id);
      if (!rec || !rec.blob) throw new Error("Video tidak ditemukan di penyimpanan.");
      return rec.blob;
    });
  }

  async function downloadVideo(v, btn) {
    btn.disabled = true;
    try {
      const rec = await DB.getVideo(v.id);
      if (!rec || !rec.blob) throw new Error("Video tidak ditemukan di penyimpanan.");
      const url = URL.createObjectURL(rec.blob);
      const a = h("a", { href: url, download: rec.fileName || `guestbook-${rec.sequence}.${rec.extension || "bin"}` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      showToast(`Mengunduh Video #${v.sequence}`);
    } catch (err) {
      showToast(err.message || "Gagal mengunduh video.", "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteVideoFlow(v, card) {
    const ok = await ask({
      title: `Hapus Video #${v.sequence}?`,
      message:
        `Video tanggal ${formatDate(v.recordedAtMs)} pukul ${formatTime(v.recordedAtMs)} ` +
        `(${formatClock(v.durationMs)}, ${formatBytes(v.size)}) akan dihapus permanen dari tablet ini. ` +
        `Tindakan ini tidak dapat dibatalkan. Unduh dulu jika perlu salinan.`,
      okLabel: "HAPUS VIDEO",
      danger: true,
    });
    if (!ok) return; // tanpa persetujuan, tidak ada yang dihapus

    if (card) card.classList.add("is-busy");
    try {
      const r = await DB.deleteVideo(v.id);
      showToast(r.deleted ? `Video #${v.sequence} dihapus` : "Video sudah tidak ada");
    } catch (err) {
      showToast(err.message || "Gagal menghapus video.", "error");
    } finally {
      await loadGallery({ silent: true });
    }
  }

  el.refreshBtn.addEventListener("click", () => loadGallery());
  el.galleryRetry.addEventListener("click", () => loadGallery());

  // Saat kembali ke tab ini, muat ulang diam-diam (mungkin ada rekaman baru dari layar tamu)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && unlocked && !views.gallery.hidden && !el.playerDialog.open) {
      loadGallery({ silent: true });
    }
  });

  /* =========================================================
     GANTI PIN
     ========================================================= */
  el.changePinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showMsg(el.pinChangeError, "");

    const cur = el.curPin.value.trim();
    const nw = el.newPin.value.trim();
    const cf = el.confirmPin.value.trim();

    if (!/^\d{4,8}$/.test(cur)) return showMsg(el.pinChangeError, "Masukkan PIN saat ini (4–8 angka).");
    if (!/^\d{4,8}$/.test(nw)) return showMsg(el.pinChangeError, "PIN baru harus 4–8 angka.");
    if (nw !== cf) return showMsg(el.pinChangeError, "Konfirmasi PIN baru tidak sama.");
    if (nw === cur) return showMsg(el.pinChangeError, "PIN baru harus berbeda dari PIN saat ini.");
    if (nw === CFG.defaultPin) return showMsg(el.pinChangeError, "Jangan memakai PIN default untuk PIN baru.");

    el.pinChangeBtn.disabled = true;
    try {
      const r = await verifyPin(cur);
      if (!r.ok) return showMsg(el.pinChangeError, "PIN saat ini salah.");
      await storePin(nw);
      el.changePinForm.reset();
      showToast("✓ PIN admin diganti");
      await refreshPinBanner();
    } catch (err) {
      showMsg(el.pinChangeError, err.message || "Gagal mengganti PIN.");
    } finally {
      el.pinChangeBtn.disabled = false;
    }
  });

  /* =========================================================
     PANEL APLIKASI (PWA & OFFLINE) — Tahap 6
     Data status berasal dari window.PWA (pwa.js).
     ========================================================= */
  const pwaEl = {
    chip: $("pwaChip"), details: $("pwaDetails"), error: $("pwaError"), hint: $("pwaHint"),
    installBtn: $("pwaInstallBtn"), checkBtn: $("pwaCheckBtn"), applyBtn: $("pwaApplyBtn"),
  };
  let pwaRenderToken = 0;

  async function renderPwaPanel() {
    const token = ++pwaRenderToken;
    const PWA = window.PWA;
    if (!PWA) {
      pwaEl.chip.textContent = "Tidak tersedia";
      pwaEl.chip.className = "chip";
      showMsg(pwaEl.error, "Modul PWA tidak termuat.");
      return;
    }

    const s = await PWA.getStatus();
    let storage = null;
    try { storage = await DB.getStorageInfo(); } catch (_) { /* diabaikan */ }
    if (token !== pwaRenderToken || views.app.hidden) return;

    // Penentu "siap offline" berdasarkan kondisi yang bisa diperiksa dari halaman ini
    let chipText, chipClass;
    if (!s.supported || !s.secure) { chipText = "Tidak didukung"; chipClass = "chip chip--none"; }
    else if (s.error) { chipText = "Bermasalah"; chipClass = "chip chip--none"; }
    else if (s.controlled && s.precacheComplete) { chipText = "Siap offline (perlu diuji)"; chipClass = "chip chip--ok"; }
    else if (s.registered) { chipText = "Menyiapkan cache…"; chipClass = "chip"; }
    else { chipText = "Belum terdaftar"; chipClass = "chip"; }
    pwaEl.chip.textContent = chipText;
    pwaEl.chip.className = chipClass;

    const yes = (v) => (v ? "Ya" : "Tidak");
    const rows = [
      ["Koneksi", s.online ? "Online" : "Offline"],
      ["Akses aman (HTTPS)", yes(s.secure)],
      ["Service Worker", !s.supported ? "Tidak didukung" : s.registered ? `Terdaftar · ${s.workerState || "?"}` : "Belum terdaftar"],
      ["Mengontrol halaman ini", yes(s.controlled)],
      ["Versi cache", s.version || "–"],
      ["Aset ter-cache", s.cachedCount != null ? `${s.cachedCount} dari ${s.expectedCount}${s.precacheComplete ? " (lengkap)" : " (belum lengkap)"}` : "–"],
      ["Mode tampilan", s.standalone ? "Terpasang (standalone)" : "Tab browser"],
      ["Penyimpanan persistent", storage && storage.persisted != null ? (storage.persisted ? "Aktif (diminta & dikabulkan)" : "Belum aktif") : "Tidak diketahui"],
    ];
    pwaEl.details.replaceChildren();
    rows.forEach(([k, v]) => pwaEl.details.append(h("dt", { text: k }), h("dd", { text: v })));

    showMsg(pwaEl.error, s.error || "");
    pwaEl.installBtn.hidden = !s.canInstall;
    pwaEl.applyBtn.hidden = !s.updateReady;
    pwaEl.hint.textContent = s.standalone
      ? "Aplikasi sedang berjalan dalam mode terpasang."
      : s.canInstall
        ? "Ketuk PASANG APLIKASI untuk menambahkannya ke layar utama."
        : "Belum terpasang. Gunakan menu ⋮ Chrome → Instal aplikasi / Tambahkan ke layar utama.";
  }

  if (window.PWA) window.PWA.subscribe(() => { if (!views.app.hidden) renderPwaPanel(); });

  pwaEl.installBtn.addEventListener("click", async () => {
    const outcome = await window.PWA.promptInstall();
    showToast(outcome === "accepted" ? "✓ Aplikasi dipasang" : "Pemasangan dibatalkan");
    renderPwaPanel();
  });

  pwaEl.checkBtn.addEventListener("click", async () => {
    pwaEl.checkBtn.disabled = true;
    try {
      const r = await window.PWA.checkForUpdate();
      const msg = {
        ready: "Versi baru siap — tekan PERBARUI SEKARANG",
        latest: "Sudah versi terbaru",
        offline: "Tidak ada koneksi untuk memeriksa pembaruan",
        unavailable: "Service Worker belum aktif",
        error: "Gagal memeriksa pembaruan",
      }[r] || "Selesai";
      showToast(msg, r === "error" ? "error" : undefined);
    } finally {
      pwaEl.checkBtn.disabled = false;
      renderPwaPanel();
    }
  });

  pwaEl.applyBtn.addEventListener("click", () => {
    window.PWA.applyUpdate(); // halaman dimuat ulang otomatis setelah versi baru aktif
  });

  /* =========================================================
     INISIALISASI
     ========================================================= */
  (async function init() {
    try {
      await DB.init();
    } catch (err) {
      showMsg(el.pinError, err.message || "Penyimpanan browser tidak dapat dibuka.");
    }

    if (sessionValid()) {
      await unlockApp();
    } else {
      el.pinInput.focus();
    }
  })();
})();
