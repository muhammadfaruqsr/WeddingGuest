/* =========================================================
   Wedding Video Guestbook — Tahap 4
   Penyimpanan otomatis ke IndexedDB (lewat db.js → window.VideoDB).

   Alur: Welcome → (kamera siap) → Intro (opsional) → Countdown 3-2-1
         → Rekam (maks 60 dtk) → SIMPAN OTOMATIS → Thank You → Welcome

   Tahap 6 (PWA/offline) hanya menambah: sinyal "idle" untuk pembaruan versi yang aman
   (window.GuestbookApp, event "guestbook:idle"), penghitung penyimpanan yang berjalan,
   dan batas waktu pada pengecekan intro agar tidak menggantung saat sinyal buruk.

   Arsitektur Tahap 1–3 dipertahankan. Perubahan Tahap 4:
   - rekaman otomatis disimpan permanen (id unik per rekaman, anti-duplikat)
   - video intro disimpan lokal di IndexedDB
   - pemeriksaan kapasitas & permintaan persistent storage
   ========================================================= */

(() => {
  "use strict";

  /* ---------- Konfigurasi ---------- */
  const CONFIG = {
    introVideoSrc: "assets/intro.mp4", // opsional; disalin ke IndexedDB saat tersedia
    introProbeTimeoutMs: 6000,         // batas menunggu video intro siap
    previewReadyTimeoutMs: 5000,       // batas menunggu gambar kamera muncul
    countdownFrom: 3,
    countdownStepMs: 1000,
    screenTransitionMs: 450,
    inputLockMs: 600,                  // abaikan ketukan beruntun tepat setelah pindah layar
    maxRecordSeconds: 60,
    timerTickMs: 200,
    thanksHoldSeconds: 15,             // jeda di Thank You (setelah video tersimpan) sebelum ke Welcome
    minFreeToStartBytes: 150 * 1024 * 1024, // di bawah ini, sesi baru tidak dimulai
    lowSpaceWarnBytes: 300 * 1024 * 1024,   // di bawah ini, tampilkan peringatan ruang menipis
    toastMs: 3500,
    // Urutan prioritas format: MP4 dulu, fallback WebM. Tidak ada yang dipaksakan.
    mimeCandidates: [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ],
  };

  /* ---------- Referensi elemen ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const screenEls = {};
  document.querySelectorAll("[data-screen]").forEach((el) => {
    screenEls[el.dataset.screen] = el;
  });

  const startBtn = $("#startBtn");
  const finishBtn = $("#finishBtn");
  const welcomeError = $("#welcomeError");
  const introVideo = $("#introVideo");
  const introPlayBtn = $("#introPlayBtn");
  const countdownNumber = $("#countdownNumber");
  const recTimer = $("#recTimer");
  const cameraPreview = $("#cameraPreview");
  const cameraPlaceholder = $("#cameraPlaceholder");
  const resultVideo = $("#resultVideo");
  const resultPlaceholder = $("#resultPlaceholder");
  const thanksHint = $("#thanksHint");
  const saveStatus = $("#saveStatus");
  const saveStatusText = $("#saveStatusText");
  const retrySaveBtn = $("#retrySaveBtn");
  const toast = $("#toast");

  const START_LABEL = startBtn.textContent;

  /* =========================================================
     STATE SESI
     idle → starting → intro → countdown → recording
          → finalizing → thanks → idle
     ========================================================= */
  let state = "idle";
  let sessionId = 0;

  /* ---------- Screen manager ---------- */
  let currentScreen = "welcome";
  let isTransitioning = false;
  let inputLockedUntil = 0;

  const hooks = {
    welcome:   { enter: enterWelcome, leave: () => {} },
    intro:     { enter: enterIntro, leave: leaveIntro },
    countdown: { enter: enterCountdown, leave: leaveCountdown },
    recording: { enter: enterRecording, leave: clearRecordingTimers },
    thanks:    { enter: enterThanks, leave: leaveThanks },
  };

  function goTo(name) {
    if (isTransitioning || name === currentScreen || !screenEls[name]) return;
    isTransitioning = true;

    const from = screenEls[currentScreen];
    const to = screenEls[name];

    hooks[currentScreen].leave();

    from.classList.add("is-leaving");
    from.classList.remove("is-active");

    setTimeout(() => {
      from.classList.remove("is-leaving");
      to.classList.add("is-active");
      currentScreen = name;
      document.body.dataset.screen = name; // dipakai CSS (luxury.css) & fx.js
      inputLockedUntil = performance.now() + CONFIG.inputLockMs;
      hooks[name].enter();
      isTransitioning = false;
      window.dispatchEvent(new CustomEvent("guestbook:screen", { detail: { name } }));
    }, CONFIG.screenTransitionMs);
  }

  function goToWhenReady(name) {
    if (isTransitioning) {
      setTimeout(() => goToWhenReady(name), 100);
      return;
    }
    goTo(name);
  }

  /* ---------- Sinyal idle (dipakai pwa.js untuk memasang versi baru dengan aman) ---------- */
  // Idle = layar sambutan, tidak ada sesi tamu, tidak ada penyimpanan video yang berjalan.
  function isIdle() {
    return state === "idle" && currentScreen === "welcome" && !isTransitioning && savesInFlight === 0;
  }
  function notifyIdle() {
    // Ditunda sedikit: saat dipanggil dari enterWelcome(), flag isTransitioning masih aktif.
    setTimeout(() => {
      if (isIdle()) window.dispatchEvent(new CustomEvent("guestbook:idle"));
    }, 60);
  }
  window.GuestbookApp = { isIdle };

  /* ---------- Util ---------- */
  function formatBytes(bytes) {
    if (bytes == null) return "?";
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
    return Math.max(1, Math.round(bytes / 1024 ** 2)) + " MB";
  }

  let toastTimer = null;
  let toastHideTimer = null;
  function showToast(text, kind) {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    toast.textContent = text;
    toast.classList.toggle("toast--error", kind === "error");
    toast.hidden = false;
    void toast.offsetWidth; // restart transisi
    toast.classList.add("show");
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      toastHideTimer = setTimeout(() => { toast.hidden = true; }, 450);
    }, CONFIG.toastMs);
  }

  /* =========================================================
     KAMERA (tidak diubah dari Tahap 2–3)
     ========================================================= */
  let mediaStream = null;

  function getUserMediaSupported() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
  }

  async function openCamera() {
    const preferred = {
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: { echoCancellation: true, noiseSuppression: true },
    };

    try {
      return await navigator.mediaDevices.getUserMedia(preferred);
    } catch (err) {
      if (err && (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError")) {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
      throw err;
    }
  }

  function attachPreview(stream) {
    cameraPreview.srcObject = stream;
    cameraPreview.hidden = false;
    cameraPlaceholder.hidden = true;
    const p = cameraPreview.play();
    if (p && p.catch) p.catch(() => {});
  }

  function waitForPreviewReady() {
    return new Promise((resolve) => {
      if (cameraPreview.readyState >= 2) return resolve(true);
      let timer = null;
      const done = (ok) => {
        clearTimeout(timer);
        cameraPreview.removeEventListener("loadeddata", onReady);
        cameraPreview.removeEventListener("playing", onReady);
        resolve(ok);
      };
      const onReady = () => done(true);
      cameraPreview.addEventListener("loadeddata", onReady);
      cameraPreview.addEventListener("playing", onReady);
      timer = setTimeout(() => done(cameraPreview.readyState >= 2), CONFIG.previewReadyTimeoutMs);
    });
  }

  // Hentikan SEMUA track (kamera + mikrofon) agar lampu kamera mati.
  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      mediaStream = null;
    }
    cameraPreview.pause();
    cameraPreview.srcObject = null;
    cameraPreview.hidden = true;
    cameraPlaceholder.hidden = false;
  }

  function onTrackEnded() {
    if (state === "recording") {
      stopRecording(); // simpan apa yang sudah terekam
    } else if (state === "intro" || state === "countdown") {
      abortToWelcome("Kamera atau mikrofon terputus. Silakan tekan MULAI untuk mencoba lagi.");
    }
  }

  function describeError(err) {
    if (err && err.name === "StorageError") return err.message;
    const name = err && err.name;
    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
      case "SecurityError":
        return "Izin kamera dan mikrofon ditolak. Ketuk ikon gembok di address bar Chrome → Izin → izinkan Kamera dan Mikrofon, lalu tekan MULAI lagi.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "Kamera atau mikrofon tidak ditemukan di perangkat ini.";
      case "NotReadableError":
      case "TrackStartError":
      case "AbortError":
        return "Kamera atau mikrofon sedang dipakai aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.";
      case "PreviewTimeout":
        return "Kamera belum menampilkan gambar. Pastikan lensa tidak tertutup dan tidak dipakai aplikasi lain, lalu tekan MULAI lagi.";
      default:
        return "Tidak dapat mengakses kamera dan mikrofon" + (name ? ` (${name})` : "") + ". Silakan coba lagi.";
    }
  }

  /* ---------- Error di Welcome ---------- */
  function showError(msg) {
    welcomeError.textContent = msg;
    welcomeError.hidden = false;
  }
  function hideError() {
    welcomeError.hidden = true;
    welcomeError.textContent = "";
  }

  /* =========================================================
     WELCOME & START
     ========================================================= */
  function enterWelcome() {
    // Bersihkan total: kamera mati, video tamu sebelumnya hilang.
    // (Penyimpanan yang masih berjalan di latar belakang tidak dibatalkan.)
    state = "idle";
    sessionId++;
    currentRecording = null;
    saveCtx = null;
    renderSaveStatus();
    stopCamera();
    clearResult();
    clearThanksTimer();
    setStartBusy(false);
    finishBtn.disabled = false;
    applyEventConfig(); // nama pengantin dari pengaturan admin
    notifyIdle();
  }

  function setStartBusy(busy, label) {
    startBtn.disabled = busy;
    startBtn.textContent = busy ? label || "MEMINTA IZIN…" : START_LABEL;
  }

  async function handleStart() {
    if (state !== "idle" || startBtn.disabled) return;
    hideError();

    if (typeof window.MediaRecorder === "undefined") {
      showError("Browser ini belum mendukung perekaman video (MediaRecorder). Gunakan Chrome versi terbaru.");
      return;
    }
    if (!window.isSecureContext || !getUserMediaSupported()) {
      showError("Kamera hanya dapat diakses lewat HTTPS atau localhost. Buka aplikasi melalui alamat yang aman.");
      return;
    }

    state = "starting";
    const id = ++sessionId;
    currentRecording = null;
    saveCtx = null;
    clearResult(); // pastikan tidak ada sisa video tamu sebelumnya
    setStartBusy(true, "MEMERIKSA…");

    try {
      // 1) Penyimpanan harus siap SEBELUM tamu merekam
      await window.VideoDB.init();
      const storage = await window.VideoDB.getStorageInfo();
      if (storage.supported && storage.free != null && storage.free < CONFIG.minFreeToStartBytes) {
        throw new window.VideoDB.StorageError(
          "LOW_SPACE",
          `Ruang penyimpanan tablet hampir penuh (sisa sekitar ${formatBytes(storage.free)}). Kosongkan ruang agar video tamu dapat tersimpan.`
        );
      }
      window.VideoDB.requestPersistence(); // permintaan saja; hasilnya tidak ditunggu
      if (id !== sessionId) return;

      // 2) Kamera & mikrofon
      setStartBusy(true, "MEMINTA IZIN…");
      stopCamera();
      const stream = await openCamera();

      if (id !== sessionId) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      mediaStream = stream;
      stream.getTracks().forEach((t) => (t.onended = onTrackEnded));
      attachPreview(stream);

      setStartBusy(true, "MENYIAPKAN…");

      const ready = await waitForPreviewReady();
      if (id !== sessionId) return;
      if (!ready) {
        const e = new Error("Preview kamera tidak siap");
        e.name = "PreviewTimeout";
        throw e;
      }

      // 3) Intro tersedia? Jika tidak, langsung ke countdown
      await refreshIntroIfChanged(); // ikuti perubahan dari dashboard admin
      if (id !== sessionId) return;
      const hasIntro = await probeIntro();
      if (id !== sessionId) return;

      if (hasIntro) {
        state = "intro";
        goToWhenReady("intro");
      } else {
        state = "countdown";
        goToWhenReady("countdown");
      }
    } catch (err) {
      if (id === sessionId) {
        state = "idle";
        stopCamera();
        showError(describeError(err));
      }
    } finally {
      if (id === sessionId) setStartBusy(false);
    }
  }

  /* =========================================================
     INTRO (disimpan juga di IndexedDB)
     ========================================================= */
  let introAvailability = null;   // null = belum diketahui
  let introSourcePromise = null;  // → URL objek video intro, atau null
  let introLoadedStamp = 0;       // savedAtMs video intro yang sedang dipakai

  function sameIntroSource(a, b) {
    if (!b.etag && !b.lastModified && !b.contentLength) return true; // server tanpa validator
    if (b.etag && b.etag !== (a.etag || "")) return false;
    if (b.lastModified && b.lastModified !== (a.lastModified || "")) return false;
    if (b.contentLength && b.contentLength !== (a.contentLength || 0)) return false;
    return true;
  }

  // Ambil video intro dari jaringan hanya bila belum tersimpan / berubah.
  async function fetchIntroIfChanged(stored) {
    let head = null;
    // Batas waktu 4 dtk: saat sinyal buruk/offline "setengah", jangan menggantung — pakai salinan lokal.
    const ctl = new AbortController();
    const abortTimer = setTimeout(() => ctl.abort(), 4000);
    try {
      head = await fetch(CONFIG.introVideoSrc, { method: "HEAD", cache: "no-cache", signal: ctl.signal });
    } catch (_) {
      return null; // tidak ada jaringan / timeout / file:// → pakai salinan lokal bila ada
    } finally {
      clearTimeout(abortTimer);
    }
    const headOk = head && head.ok;
    if (!headOk && stored) return null;

    const info = headOk
      ? {
          etag: head.headers.get("ETag") || "",
          lastModified: head.headers.get("Last-Modified") || "",
          contentLength: Number(head.headers.get("Content-Length") || 0),
        }
      : { etag: "", lastModified: "", contentLength: 0 };

    if (stored && sameIntroSource(stored.sourceInfo || {}, info)) return null;

    const res = await fetch(CONFIG.introVideoSrc, { cache: "no-cache" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;

    // Tolak respons yang bukan video (mis. halaman HTML pengganti 404)
    const sniffed = await window.VideoDB.sniffVideoFormat(blob);
    if (!sniffed) return null;

    const ct = res.headers.get("Content-Type") || "";
    return { blob, info, mimeType: ct.toLowerCase().startsWith("video/") ? ct : sniffed.mime };
  }

  // Siapkan sumber intro: pakai salinan IndexedDB; perbarui dari jaringan bila perlu.
  async function prepareIntro() {
    if (!CONFIG.introVideoSrc) return null;

    let stored = null;
    try { stored = await window.VideoDB.getIntro(); } catch (_) { /* lanjut tanpa salinan lokal */ }

    let blob = stored && stored.blob ? stored.blob : null;

    // Video intro yang diunggah admin tidak boleh ditimpa oleh file di assets/
    const adminOwned = !!(stored && stored.source === "admin");

    try {
      const fresh = adminOwned ? null : await fetchIntroIfChanged(stored);
      if (fresh) {
        blob = fresh.blob;
        try {
          await window.VideoDB.saveIntro(fresh.blob, { mimeType: fresh.mimeType, sourceInfo: fresh.info });
        } catch (err) {
          console.warn("[Guestbook] Video intro tidak dapat disimpan ke IndexedDB:", err.message);
        }
      }
    } catch (_) { /* gunakan salinan lokal bila ada */ }

    try {
      const latest = await window.VideoDB.getIntro();
      introLoadedStamp = latest && latest.savedAtMs ? latest.savedAtMs : 0;
    } catch (_) { /* diabaikan */ }

    return blob ? URL.createObjectURL(blob) : null;
  }

  // Jika admin mengganti video intro, tamu berikutnya langsung memakai versi terbaru (tanpa reload).
  async function refreshIntroIfChanged() {
    try {
      const latest = await window.VideoDB.getIntro();
      const stamp = latest && latest.savedAtMs ? latest.savedAtMs : 0;
      if (stamp === introLoadedStamp) return;
    } catch (_) {
      return;
    }

    const old = introSourcePromise;
    introAvailability = null;
    introSourcePromise = prepareIntro().catch(() => null);
    introVideo.removeAttribute("src");
    introVideo.load();
    try {
      const oldUrl = await old;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    } catch (_) { /* diabaikan */ }
  }

  // Cek apakah video intro ada & bisa dibaca. Tanpa video → intro dilewati.
  function probeIntro() {
    if (!CONFIG.introVideoSrc) return Promise.resolve(false);
    if (introAvailability !== null) return Promise.resolve(introAvailability);

    return new Promise((resolve) => {
      let timer = null;
      let finished = false;

      const finish = (ok, cache) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        introVideo.removeEventListener("loadedmetadata", onOk);
        introVideo.removeEventListener("error", onErr);
        if (cache) introAvailability = ok;
        if (!ok) {
          introVideo.removeAttribute("src");
          introVideo.load();
        }
        resolve(ok);
      };
      const onOk = () => finish(true, true);
      const onErr = () => finish(false, true);

      timer = setTimeout(() => finish(false, false), CONFIG.introProbeTimeoutMs);

      introSourcePromise.then((url) => {
        if (finished) return;
        if (!url) return finish(false, true);
        introVideo.addEventListener("loadedmetadata", onOk);
        introVideo.addEventListener("error", onErr);
        introVideo.src = url;
        introVideo.load();
      });
    });
  }

  function enterIntro() {
    if (state !== "intro") return;
    introPlayBtn.hidden = true;
    try { introVideo.currentTime = 0; } catch (_) { /* diabaikan */ }
    tryPlayIntro();
  }

  // Autoplay bisa diblokir Chrome → tampilkan tombol putar (LEWATI tetap tersedia).
  function tryPlayIntro() {
    let p;
    try { p = introVideo.play(); } catch (_) { p = null; }
    if (p && typeof p.then === "function") {
      p.then(() => { introPlayBtn.hidden = true; })
       .catch((err) => {
         if (state !== "intro") return;
         if (err && err.name === "NotAllowedError") {
           introPlayBtn.hidden = false;
         } else {
           advanceFromIntro();
         }
       });
    }
  }

  function leaveIntro() {
    introVideo.pause();
    introPlayBtn.hidden = true;
  }

  function advanceFromIntro() {
    if (state !== "intro") return; // cegah pemanggilan ganda (ended + LEWATI)
    state = "countdown";
    introVideo.pause();
    goToWhenReady("countdown");
  }

  introVideo.addEventListener("playing", () => { introPlayBtn.hidden = true; });
  introVideo.addEventListener("ended", advanceFromIntro);
  introVideo.addEventListener("error", () => {
    if (state === "intro") advanceFromIntro();
  });

  /* =========================================================
     COUNTDOWN
     ========================================================= */
  let countdownTimer = null;

  function enterCountdown() {
    if (state !== "countdown") return;

    if (!mediaStream || !mediaStream.active) {
      abortToWelcome("Kamera tidak aktif. Silakan tekan MULAI untuk mencoba lagi.");
      return;
    }

    const id = sessionId;
    let n = CONFIG.countdownFrom;
    showCountdownNumber(n);

    const step = () => {
      countdownTimer = setTimeout(() => {
        if (id !== sessionId || state !== "countdown") return;
        n -= 1;
        if (n > 0) {
          showCountdownNumber(n);
          step();
        } else {
          countdownTimer = null;
          state = "recording";
          goToWhenReady("recording");
        }
      }, CONFIG.countdownStepMs);
    };
    step();
  }

  function leaveCountdown() {
    if (countdownTimer) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  }

  function showCountdownNumber(n) {
    countdownNumber.textContent = n;
    countdownNumber.classList.remove("tick");
    void countdownNumber.offsetWidth;
    countdownNumber.classList.add("tick");
    window.dispatchEvent(new CustomEvent("guestbook:tick", { detail: { n } }));
  }

  /* =========================================================
     PEREKAMAN
     ========================================================= */
  let recorder = null;
  let chunks = [];
  let recordStart = 0;
  let recordedDurationMs = 0;
  let tickId = null;
  let autoStopId = null;
  let resultUrl = null;
  let currentRecording = null; // { id, startedAt } — id unik per rekaman (anti-duplikat)

  function pickMimeType() {
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    return CONFIG.mimeCandidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function enterRecording() {
    if (state !== "recording") return;
    finishBtn.disabled = false;
    renderTimer(0);
    startRecording();
  }

  function startRecording() {
    if (recorder) return; // jangan pernah memulai rekaman dua kali

    if (!mediaStream || !mediaStream.active) {
      abortToWelcome("Kamera tidak aktif. Silakan tekan MULAI untuk mencoba lagi.");
      return;
    }

    const mime = pickMimeType();
    chunks = [];

    try {
      recorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
    } catch (err) {
      recorder = null;
      abortToWelcome("Perekaman tidak dapat dimulai di browser ini. Coba gunakan Chrome versi terbaru.");
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => {
      abortToWelcome("Terjadi kesalahan saat merekam. Silakan coba lagi.");
    };
    recorder.onstop = handleRecorderStop;

    // ID unik dibuat sekali per rekaman; dipakai sebagai kunci di IndexedDB
    currentRecording = { id: window.VideoDB.newId(), startedAt: new Date() };

    try {
      recorder.start(1000);
    } catch (err) {
      recorder = null;
      currentRecording = null;
      abortToWelcome("Perekaman tidak dapat dimulai. Silakan coba lagi.");
      return;
    }

    recordStart = performance.now();
    tickId = setInterval(() => {
      const elapsed = (performance.now() - recordStart) / 1000;
      renderTimer(elapsed);
      if (elapsed >= CONFIG.maxRecordSeconds) stopRecording();
    }, CONFIG.timerTickMs);

    autoStopId = setTimeout(stopRecording, CONFIG.maxRecordSeconds * 1000);
  }

  function stopRecording() {
    if (state !== "recording" || !recorder || recorder.state === "inactive") return;
    state = "finalizing";
    finishBtn.disabled = true;
    clearRecordingTimers();
    // Durasi diambil dari timer perekaman (MediaRecorder tidak menulis durasi pada file WebM)
    recordedDurationMs = Math.round(Math.min(performance.now() - recordStart, CONFIG.maxRecordSeconds * 1000));
    renderTimer(recordedDurationMs / 1000);
    try {
      recorder.stop();
    } catch (err) {
      abortToWelcome("Gagal menghentikan rekaman. Silakan coba lagi.");
    }
  }

  function handleRecorderStop() {
    const rec = recorder;
    recorder = null;
    clearRecordingTimers();

    const info = currentRecording;
    currentRecording = null; // satu rekaman hanya diproses satu kali

    const type = (rec && rec.mimeType) || pickMimeType() || "video/webm";
    const blob = new Blob(chunks, { type });
    chunks = [];

    // Kamera & mikrofon langsung dimatikan begitu rekaman selesai
    stopCamera();

    if (blob.size === 0 || !info) {
      abortToWelcome("Rekaman kosong. Silakan coba lagi.");
      return;
    }

    revokeResultUrl();
    resultUrl = URL.createObjectURL(blob); // untuk pemutaran di Thank You

    // Simpan permanen ke IndexedDB, langsung tanpa menunggu layar berpindah
    saveCtx = {
      id: info.id,
      startedAt: info.startedAt,
      blob,
      mimeType: type,
      durationMs: recordedDurationMs,
      status: "saving",
      record: null,
      error: null,
      lowSpaceBytes: null,
      promise: null,
    };
    persistRecording(saveCtx);

    goToWhenReady("thanks");
  }

  function clearRecordingTimers() {
    if (tickId) { clearInterval(tickId); tickId = null; }
    if (autoStopId) { clearTimeout(autoStopId); autoStopId = null; }
  }

  function renderTimer(totalSeconds) {
    const t = Math.floor(totalSeconds);
    const m = String(Math.floor(t / 60)).padStart(2, "0");
    const s = String(t % 60).padStart(2, "0");
    recTimer.textContent = `${m}:${s}`;
    screenEls.recording.style.setProperty("--rec-progress", Math.min(1, totalSeconds / CONFIG.maxRecordSeconds).toFixed(3));
  }

  /* =========================================================
     PENYIMPANAN KE INDEXEDDB
     ========================================================= */
  let saveCtx = null; // konteks penyimpanan untuk rekaman terbaru
  let savesInFlight = 0; // jumlah penyimpanan ke IndexedDB yang masih berjalan (termasuk di latar belakang)

  function persistRecording(ctx) {
    if (ctx.promise) return ctx.promise;      // sedang menyimpan → jangan jalankan dua kali
    if (ctx.status === "saved") return Promise.resolve();

    ctx.status = "saving";
    ctx.error = null;
    renderSaveStatus(ctx);

    savesInFlight++;
    ctx.promise = (async () => {
      try {
        // id yang sama selalu menghasilkan satu data saja (anti-duplikat di db.js)
        const out = await window.VideoDB.saveVideo({
          id: ctx.id,
          blob: ctx.blob,
          mimeType: ctx.mimeType,
          durationMs: ctx.durationMs,
          recordedAt: ctx.startedAt,
        });
        ctx.record = out.record;
        ctx.status = "saved";
        ctx.lowSpaceBytes =
          out.freeAfterBytes != null && out.freeAfterBytes < CONFIG.lowSpaceWarnBytes ? out.freeAfterBytes : null;
        ctx.blob = null; // lepas referensi; salinan permanen ada di IndexedDB
        showToast(`✓ Video #${out.record.sequence} berhasil disimpan`);
      } catch (err) {
        ctx.status = "error";
        ctx.error = err;
        console.error("[Guestbook] Gagal menyimpan video:", err);
        showToast("Video belum tersimpan", "error");
      } finally {
        savesInFlight--;
        ctx.promise = null;
        renderSaveStatus(ctx);
        if (ctx.status === "saved") maybeStartThanksTimer();
        notifyIdle();
      }
    })();

    return ctx.promise;
  }

  function renderSaveStatus(ctx) {
    if (ctx !== undefined && ctx !== saveCtx) return; // abaikan konteks sesi lama
    const c = saveCtx;

    if (!c) {
      saveStatus.hidden = true;
      retrySaveBtn.hidden = true;
      return;
    }

    saveStatus.hidden = false;
    saveStatus.dataset.state = c.status;
    retrySaveBtn.hidden = c.status !== "error";

    if (c.status === "saving") {
      saveStatusText.textContent = "Menyimpan video";
    } else if (c.status === "saved") {
      let text = `✓ Video #${c.record.sequence} tersimpan di tablet ini.`;
      if (c.lowSpaceBytes != null) {
        text += ` Ruang penyimpanan tinggal sekitar ${formatBytes(c.lowSpaceBytes)}, mohon beri tahu panitia.`;
      }
      saveStatusText.textContent = text;
    } else {
      const reason = c.error && c.error.message ? c.error.message : "Terjadi kesalahan tidak dikenal.";
      saveStatusText.textContent =
        `Video belum tersimpan. ${reason} Jika kembali ke awal sekarang, video ini akan hilang.`;
    }
  }

  /* =========================================================
     THANK YOU
     ========================================================= */
  let thanksTimer = null;
  let thanksRemaining = 0;

  function enterThanks() {
    if (state !== "finalizing" || !resultUrl) return;
    state = "thanks";

    resultVideo.src = resultUrl;
    resultVideo.hidden = false;
    resultPlaceholder.hidden = true;
    const p = resultVideo.play();
    if (p && p.catch) p.catch(() => {});

    renderSaveStatus();
    maybeStartThanksTimer();
  }

  function leaveThanks() {
    clearThanksTimer();
  }

  // Hitung mundur kembali ke Welcome hanya berjalan setelah video TERSIMPAN,
  // dan tidak berjalan selama tamu menonton hasil videonya.
  function maybeStartThanksTimer() {
    if (state !== "thanks" || currentScreen !== "thanks") return;
    if (!saveCtx || saveCtx.status !== "saved") return;
    if (!resultVideo.paused && !resultVideo.ended) return;
    startThanksTimer();
  }

  function startThanksTimer() {
    clearThanksTimer();
    thanksRemaining = CONFIG.thanksHoldSeconds;
    renderThanksHint();
    thanksTimer = setInterval(() => {
      thanksRemaining -= 1;
      if (thanksRemaining <= 0) {
        clearThanksTimer();
        goToWhenReady("welcome");
      } else {
        renderThanksHint();
      }
    }, 1000);
  }

  function clearThanksTimer() {
    if (thanksTimer) {
      clearInterval(thanksTimer);
      thanksTimer = null;
    }
    thanksHint.hidden = true;
    thanksHint.textContent = "";
  }

  function renderThanksHint() {
    thanksHint.textContent = `Kembali ke awal dalam ${thanksRemaining} detik`;
    thanksHint.hidden = false;
  }

  resultVideo.addEventListener("play", () => {
    if (state === "thanks") clearThanksTimer();
  });
  resultVideo.addEventListener("pause", () => {
    if (!resultVideo.ended) maybeStartThanksTimer();
  });
  resultVideo.addEventListener("ended", maybeStartThanksTimer);

  function revokeResultUrl() {
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
  }

  function clearResult() {
    resultVideo.pause();
    resultVideo.removeAttribute("src");
    resultVideo.load();
    resultVideo.hidden = true;
    resultPlaceholder.hidden = false;
    revokeResultUrl();
  }

  /* =========================================================
     BATALKAN SESI & KEMBALI KE WELCOME
     ========================================================= */
  function abortToWelcome(message) {
    state = "idle";
    sessionId++;

    clearRecordingTimers();
    leaveCountdown();
    clearThanksTimer();
    introVideo.pause();

    if (recorder) {
      const r = recorder;
      recorder = null;
      r.ondataavailable = r.onstop = r.onerror = null;
      try { if (r.state !== "inactive") r.stop(); } catch (_) { /* diabaikan */ }
    }
    chunks = [];
    currentRecording = null; // rekaman yang dibatalkan tidak pernah disimpan

    stopCamera();
    clearResult();
    finishBtn.disabled = false;

    if (message) showError(message);
    goToWhenReady("welcome");
  }

  /* =========================================================
     AKSI TOMBOL
     ========================================================= */
  const actions = {
    start: handleStart,
    "intro-skip": advanceFromIntro,
    "intro-play": () => {
      introPlayBtn.hidden = true;
      tryPlayIntro();
    },
    finish: stopRecording,
    "retry-save": () => {
      if (saveCtx && saveCtx.status === "error") persistRecording(saveCtx);
    },
    restart: () => goToWhenReady("welcome"),
  };

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    if (isTransitioning || performance.now() < inputLockedUntil) return;

    const fn = actions[btn.dataset.action];
    if (fn) fn();
  });

  /* ---------- Pintu masuk admin tersembunyi: ketuk 3 kali di pojok kiri atas layar sambutan ---------- */
  const adminHotspot = $("#adminHotspot");
  const ADMIN_TAP_COUNT = 3;
  const ADMIN_TAP_WINDOW_MS = 900; // jeda maksimum antar ketukan
  let adminTaps = 0;
  let adminTapTimer = null;

  if (adminHotspot) {
    adminHotspot.addEventListener("click", () => {
      if (!isIdle()) return; // hanya aktif di layar sambutan saat tidak ada sesi tamu
      adminTaps += 1;
      clearTimeout(adminTapTimer);
      if (adminTaps >= ADMIN_TAP_COUNT) {
        adminTaps = 0;
        window.location.href = "admin.html"; // tetap meminta PIN admin
        return;
      }
      adminTapTimer = setTimeout(() => { adminTaps = 0; }, ADMIN_TAP_WINDOW_MS);
    });
  }

  window.addEventListener("pagehide", () => {
    stopCamera();
    revokeResultUrl();
  });

  document.addEventListener("contextmenu", (e) => e.preventDefault());

  /* =========================================================
     INISIALISASI
     ========================================================= */
  // Nama pengantin dari dashboard admin (jika belum diatur, tetap memakai teks bawaan di HTML)
  async function applyEventConfig() {
    try {
      const cfg = await window.VideoDB.getConfig("event");
      if (!cfg) return;
      const bride = (cfg.brideName || "").trim();
      const groom = (cfg.groomName || "").trim();
      if (bride) $(".names__bride").textContent = bride;
      if (groom) $(".names__groom").textContent = groom;
    } catch (_) { /* tetap memakai nama bawaan */ }
  }
  applyEventConfig();

  introSourcePromise = prepareIntro().catch(() => null);

  window.VideoDB.init()
    .then((r) => console.info("[Guestbook] IndexedDB siap. Persistent storage dikabulkan:", r.persisted))
    .catch((err) => showError(err.message));

  /* =========================================================
     ALAT BANTU PENGUJIAN (konsol DevTools; bukan dashboard)
     Gunakan lewat chrome://inspect pada tablet, contoh:
       await GuestbookDebug.list()      → tabel semua video tersimpan
       await GuestbookDebug.play(1)     → putar video nomor 1 dari IndexedDB
       await GuestbookDebug.download(1) → unduh file (cek ekstensi & isi)
       await GuestbookDebug.info()      → kapasitas & status persistent
     ========================================================= */
  async function findRecord(ref) {
    const list = await window.VideoDB.listVideos();
    const meta = typeof ref === "number" ? list.find((v) => v.sequence === ref) : list.find((v) => v.id === ref);
    if (!meta) throw new Error("Video tidak ditemukan: " + ref);
    return window.VideoDB.getVideo(meta.id);
  }

  window.GuestbookDebug = {
    async list() {
      const items = await window.VideoDB.listVideos();
      console.table(
        items.map((v) => ({
          no: v.sequence,
          file: v.fileName,
          mime: v.mimeType,
          "ukuran (MB)": +(v.size / 1048576).toFixed(2),
          "durasi (dtk)": v.durationMs == null ? null : +(v.durationMs / 1000).toFixed(1),
          waktu: v.recordedAt,
          id: v.id,
        }))
      );
      return items;
    },
    async info() {
      const i = await window.VideoDB.getStorageInfo();
      console.log({
        terpakai: formatBytes(i.usage),
        kuota: formatBytes(i.quota),
        sisa: formatBytes(i.free),
        persistent: i.persisted,
        jumlahVideo: await window.VideoDB.countVideos(),
      });
      return i;
    },
    async play(ref) {
      const rec = await findRecord(ref);
      const url = URL.createObjectURL(rec.blob);
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:16px";
      const v = document.createElement("video");
      v.src = url; v.controls = true; v.autoplay = true; v.playsInline = true;
      v.style.cssText = "max-width:100%;max-height:78%;background:#000";
      const b = document.createElement("button");
      b.textContent = "TUTUP";
      b.style.cssText = "font:600 18px sans-serif;padding:16px 40px;border-radius:999px;border:1px solid #cfb07a;background:#241812;color:#e6d2a6";
      b.onclick = () => { v.pause(); wrap.remove(); URL.revokeObjectURL(url); };
      wrap.append(v, b);
      document.body.appendChild(wrap);
      return rec.fileName;
    },
    async download(ref) {
      const rec = await findRecord(ref);
      const url = URL.createObjectURL(rec.blob);
      const a = document.createElement("a");
      a.href = url; a.download = rec.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return rec.fileName;
    },
  };
})();
