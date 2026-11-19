/* =========================================================
   Wedding Video Guestbook — Tahap 4
   Modul penyimpanan IndexedDB  →  window.VideoDB

   Database : "wedding-guestbook"
   Store    : videos  (id, sequence, blob, mimeType, extension, size,
                       durationMs, recordedAt, recordedAtMs, savedAtMs, fileName)
              assets  (key "intro" → video pembuka pengantin)
              meta    (counter nomor urut video)

   Catatan jujur tentang keamanan data:
   - Data disimpan di penyimpanan browser (origin-bound: skema + host + port).
   - Browser/OS tetap dapat menghapusnya (bersihkan data situs, ruang penuh,
     mode penyamaran, uninstall). navigator.storage.persist() hanya MEMINTA
     perlindungan tambahan, bukan jaminan.
   - Lakukan ekspor/backup video secara berkala pada tahap berikutnya.
   ========================================================= */

(function (global) {
  "use strict";

  const DB_NAME = "wedding-guestbook";
  const DB_VERSION = 1;
  const STORE_VIDEOS = "videos";
  const STORE_ASSETS = "assets";
  const STORE_META = "meta";
  const SEQ_KEY = "videoSequence";
  const INTRO_KEY = "intro";

  // Ruang sisa minimum di atas ukuran file yang akan disimpan
  const SPACE_MARGIN_BYTES = 50 * 1024 * 1024;

  /* ---------- Error dengan pesan yang mudah dipahami ---------- */
  class StorageError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = "StorageError";
      this.code = code;
      this.cause = cause;
    }
  }

  function toStorageError(err) {
    if (err instanceof StorageError) return err;
    const name = err && err.name;
    switch (name) {
      case "QuotaExceededError":
        return new StorageError("QUOTA", "Penyimpanan tablet penuh. Kosongkan ruang penyimpanan lalu coba lagi.", err);
      case "InvalidStateError":
      case "SecurityError":
      case "UnknownError":
        return new StorageError(
          "UNAVAILABLE",
          "Penyimpanan browser tidak dapat dipakai (mungkin mode penyamaran atau data situs diblokir). Gunakan Chrome mode normal.",
          err
        );
      case "AbortError":
        return new StorageError("ABORTED", "Proses penyimpanan terhenti. Silakan coba lagi.", err);
      case "VersionError":
        return new StorageError("VERSION", "Versi database tidak cocok. Muat ulang halaman lalu coba lagi.", err);
      default:
        return new StorageError(
          "UNKNOWN",
          "Terjadi kesalahan pada penyimpanan" + (name ? ` (${name})` : "") + ". Silakan coba lagi.",
          err
        );
    }
  }

  /* ---------- Util ---------- */
  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    const b = new Uint8Array(16);
    global.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  const pad = (n, len = 2) => String(n).padStart(len, "0");

  function makeFileName(sequence, date, ext) {
    return (
      `guestbook-${pad(sequence, 4)}-` +
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${ext}`
    );
  }

  function baseMime(mime) {
    return (mime || "").split(";")[0].trim().toLowerCase();
  }

  function extensionForMime(mime) {
    switch (baseMime(mime)) {
      case "video/mp4": return "mp4";
      case "video/webm": return "webm";
      case "video/x-matroska": return "mkv";
      case "video/quicktime": return "mov";
      case "video/ogg": return "ogv";
      default: return "bin";
    }
  }

  // Deteksi format sebenarnya dari byte awal file (bukan hanya dari label MIME).
  async function sniffVideoFormat(blob) {
    try {
      const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
        return { mime: "video/mp4", ext: "mp4" }; // "ftyp"
      }
      if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
        return { mime: "video/webm", ext: "webm" }; // EBML (WebM/Matroska)
      }
    } catch (_) { /* diabaikan */ }
    return null;
  }

  // Pastikan label MIME & ekstensi sesuai isi file yang sebenarnya.
  async function normalizeFormat(blob, declaredMime) {
    const declaredBase = baseMime(declaredMime || blob.type);
    const sniffed = await sniffVideoFormat(blob);
    let mimeType = declaredMime || blob.type || "";
    let out = blob;

    if (sniffed && sniffed.mime !== declaredBase) {
      mimeType = sniffed.mime;
      out = blob.slice(0, blob.size, sniffed.mime);
    } else if (!mimeType && sniffed) {
      mimeType = sniffed.mime;
    }
    return { blob: out, mimeType: mimeType || "application/octet-stream" };
  }

  /* ---------- Koneksi database ---------- */
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new StorageError("UNSUPPORTED", "Browser ini tidak mendukung penyimpanan IndexedDB."));
        return;
      }

      let req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(toStorageError(e));
        return;
      }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
          const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: "id" });
          videos.createIndex("sequence", "sequence", { unique: true });
          videos.createIndex("recordedAtMs", "recordedAtMs", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ASSETS)) {
          db.createObjectStore(STORE_ASSETS, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        // Jika koneksi ditutup/diganti, buka ulang otomatis pada pemanggilan berikutnya
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(toStorageError(req.error));
      req.onblocked = () => reject(new StorageError("BLOCKED", "Database sedang dipakai tab lain. Tutup tab lain lalu muat ulang."));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });

    return dbPromise;
  }

  /**
   * Menjalankan satu transaksi. Promise baru selesai pada `tx.oncomplete`,
   * yaitu ketika data benar-benar ter-commit — bukan hanya saat request berhasil.
   * `work(tx, setResult)` hanya boleh memakai request IndexedDB (tidak ada await di dalamnya).
   */
  function runTx(storeNames, mode, work) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          let tx;
          try {
            tx = db.transaction(storeNames, mode, { durability: "strict" }); // tulis ke disk sebelum "complete"
          } catch (_) {
            try {
              tx = db.transaction(storeNames, mode);
            } catch (e2) {
              reject(toStorageError(e2));
              return;
            }
          }

          let result = null;
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(toStorageError(tx.error));
          tx.onabort = () => reject(toStorageError(tx.error || new DOMException("Transaksi dibatalkan", "AbortError")));

          try {
            work(tx, (v) => { result = v; });
          } catch (e) {
            try { tx.abort(); } catch (_) { /* diabaikan */ }
            reject(toStorageError(e));
          }
        })
    );
  }

  /* ---------- Kapasitas & persistensi ---------- */
  async function getStorageInfo() {
    const info = { supported: false, usage: null, quota: null, free: null, persisted: null };
    const s = global.navigator && global.navigator.storage;
    if (s && typeof s.estimate === "function") {
      try {
        const { usage, quota } = await s.estimate();
        info.supported = true;
        info.usage = usage || 0;
        info.quota = quota || 0;
        info.free = Math.max(0, info.quota - info.usage);
      } catch (_) { /* diabaikan */ }
    }
    if (s && typeof s.persisted === "function") {
      try { info.persisted = await s.persisted(); } catch (_) { /* diabaikan */ }
    }
    return info;
  }

  async function checkSpace(bytes) {
    const info = await getStorageInfo();
    if (info.supported && info.quota > 0 && info.free < bytes + SPACE_MARGIN_BYTES) {
      throw new StorageError(
        "QUOTA",
        "Ruang penyimpanan tablet tidak cukup untuk menyimpan video ini. Kosongkan ruang penyimpanan lalu coba lagi."
      );
    }
    return info;
  }

  // Hanya MEMINTA persistent storage; hasilnya bukan jaminan data tidak bisa terhapus.
  async function requestPersistence() {
    const s = global.navigator && global.navigator.storage;
    if (!s || typeof s.persist !== "function") return { supported: false, persisted: false };
    try {
      let persisted = typeof s.persisted === "function" ? await s.persisted() : false;
      if (!persisted) persisted = await s.persist();
      return { supported: true, persisted: !!persisted };
    } catch (_) {
      return { supported: true, persisted: false };
    }
  }

  async function init() {
    await openDB();
    const p = await requestPersistence();
    return { persistSupported: p.supported, persisted: p.persisted };
  }

  /* ---------- Video tamu ---------- */
  function toMeta(record) {
    if (!record) return null;
    const meta = Object.assign({}, record);
    delete meta.blob;
    return meta;
  }

  /**
   * Simpan satu rekaman.
   * Anti-duplikat: `id` bersifat unik per rekaman. Jika id yang sama dikirim lagi
   * (event terpanggil ulang / tombol coba lagi), data tidak ditulis ulang.
   * Nomor urut diambil dari counter di transaksi yang sama (atomik).
   */
  async function saveVideo(input) {
    if (!input || !(input.blob instanceof Blob) || input.blob.size === 0) {
      throw new StorageError("INVALID", "Data video kosong atau tidak valid.");
    }

    try {
      const id = input.id || newId();

      // Pemeriksaan async dilakukan SEBELUM transaksi dibuka
      const storage = await checkSpace(input.blob.size);
      const { blob, mimeType } = await normalizeFormat(input.blob, input.mimeType);
      const extension = extensionForMime(mimeType);

      let recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
      if (Number.isNaN(recordedAt.getTime())) recordedAt = new Date();
      const durationMs = Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : null;

      const out = await runTx([STORE_VIDEOS, STORE_META], "readwrite", (tx, setResult) => {
        const videos = tx.objectStore(STORE_VIDEOS);
        const meta = tx.objectStore(STORE_META);

        const getExisting = videos.get(id);
        getExisting.onsuccess = () => {
          if (getExisting.result) {
            setResult({ record: getExisting.result, duplicate: true });
            return;
          }
          const getSeq = meta.get(SEQ_KEY);
          getSeq.onsuccess = () => {
            const sequence = ((getSeq.result && getSeq.result.value) || 0) + 1;
            meta.put({ key: SEQ_KEY, value: sequence });

            const record = {
              id,
              sequence,
              blob,
              mimeType,
              extension,
              size: blob.size,
              durationMs,
              recordedAt: recordedAt.toISOString(),
              recordedAtMs: recordedAt.getTime(),
              savedAtMs: Date.now(),
              fileName: makeFileName(sequence, recordedAt, extension),
            };
            videos.add(record);
            setResult({ record, duplicate: false });
          };
        };
      });

      // Verifikasi: baca ulang dari database setelah commit
      const stored = await getVideo(out.record.id);
      if (!stored || !stored.blob || stored.blob.size !== out.record.size) {
        throw new StorageError("VERIFY", "Video tidak terverifikasi tersimpan. Silakan coba lagi.");
      }

      return {
        record: toMeta(stored),
        duplicate: out.duplicate,
        freeAfterBytes: storage.free != null ? Math.max(0, storage.free - (out.duplicate ? 0 : blob.size)) : null,
      };
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async function getVideo(id) {
    try {
      return await runTx([STORE_VIDEOS], "readonly", (tx, setResult) => {
        const req = tx.objectStore(STORE_VIDEOS).get(id);
        req.onsuccess = () => setResult(req.result || null);
      });
    } catch (err) {
      throw toStorageError(err);
    }
  }

  // Daftar metadata (tanpa blob), urut berdasarkan nomor urut video
  async function listVideos() {
    try {
      return await runTx([STORE_VIDEOS], "readonly", (tx, setResult) => {
        const items = [];
        const req = tx.objectStore(STORE_VIDEOS).index("sequence").openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            items.push(toMeta(cursor.value));
            cursor.continue();
          } else {
            setResult(items);
          }
        };
      });
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async function countVideos() {
    try {
      return await runTx([STORE_VIDEOS], "readonly", (tx, setResult) => {
        const req = tx.objectStore(STORE_VIDEOS).count();
        req.onsuccess = () => setResult(req.result);
      });
    } catch (err) {
      throw toStorageError(err);
    }
  }

  /* ---------- Video pembuka pengantin (intro) ---------- */
  async function saveIntro(blob, info) {
    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new StorageError("INVALID", "Video pembuka kosong atau tidak valid.");
    }
    try {
      await checkSpace(blob.size);
      const norm = await normalizeFormat(blob, info && info.mimeType);
      await runTx([STORE_ASSETS], "readwrite", (tx) => {
        tx.objectStore(STORE_ASSETS).put({
          key: INTRO_KEY,
          blob: norm.blob,
          mimeType: norm.mimeType,
          extension: extensionForMime(norm.mimeType),
          size: norm.blob.size,
          sourceInfo: (info && info.sourceInfo) || {},
          source: (info && info.source) || "network", // "admin" = diunggah lewat dashboard
          fileName: (info && info.fileName) || "",
          savedAtMs: Date.now(),
        });
      });
      return true;
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async function getIntro() {
    try {
      return await runTx([STORE_ASSETS], "readonly", (tx, setResult) => {
        const req = tx.objectStore(STORE_ASSETS).get(INTRO_KEY);
        req.onsuccess = () => setResult(req.result || null);
      });
    } catch (err) {
      throw toStorageError(err);
    }
  }

  /* ---------- Hapus video (hanya dipanggil dari dashboard setelah konfirmasi) ---------- */
  // Nomor urut tidak dipakai ulang: counter di store "meta" tidak diubah.
  async function deleteVideo(id) {
    try {
      return await runTx([STORE_VIDEOS], "readwrite", (tx, setResult) => {
        const store = tx.objectStore(STORE_VIDEOS);
        const req = store.get(id);
        req.onsuccess = () => {
          if (!req.result) {
            setResult({ deleted: false });
            return;
          }
          const sequence = req.result.sequence;
          store.delete(id);
          setResult({ deleted: true, sequence });
        };
      });
    } catch (err) {
      throw toStorageError(err);
    }
  }

  /* ---------- Konfigurasi lokal (nama pengantin, PIN admin) ----------
     Disimpan di store "meta" yang sudah ada dengan kunci "config:<nama>",
     sehingga TIDAK perlu mengubah versi/skema database maupun memigrasikan data lama. */
  async function getConfig(name) {
    try {
      return await runTx([STORE_META], "readonly", (tx, setResult) => {
        const req = tx.objectStore(STORE_META).get("config:" + name);
        req.onsuccess = () => setResult(req.result ? req.result.value : null);
      });
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async function setConfig(name, value) {
    try {
      await runTx([STORE_META], "readwrite", (tx) => {
        tx.objectStore(STORE_META).put({ key: "config:" + name, value });
      });
      return true;
    } catch (err) {
      throw toStorageError(err);
    }
  }

  /* ---------- API publik ---------- */
  global.VideoDB = {
    init,
    requestPersistence,
    getStorageInfo,
    saveVideo,
    getVideo,
    listVideos,
    countVideos,
    saveIntro,
    getIntro,
    deleteVideo,
    getConfig,
    setConfig,
    newId,
    extensionForMime,
    sniffVideoFormat,
    StorageError,
  };
})(window);
