/* =========================================================
   Wedding Video Guestbook — Tahap 6: Service Worker
   -------------------------------------------------------
   Tugas : menyimpan seluruh aset aplikasi (HTML, CSS, JS, font, ikon)
           ke Cache Storage agar aplikasi dapat dibuka tanpa internet.

   TIDAK  : - menyentuh IndexedDB (video tamu, intro, konfigurasi, PIN).
              Service Worker ini sama sekali tidak membuka database,
              dan membersihkan cache lama TIDAK memengaruhi IndexedDB.
            - menyimpan video / blob / permintaan Range ke Cache Storage.
            - menyimpan assets/intro.mp4 (disalin aplikasi ke IndexedDB).

   PEMBARUAN VERSI
   Naikkan VERSION setiap kali ada berkas aplikasi yang berubah.
   Browser membandingkan sw.js byte-per-byte; versi baru akan
   di-install di latar belakang lalu MENUNGGU (tidak langsung aktif),
   supaya sesi tamu yang sedang berjalan tidak terganggu. Halaman
   (pwa.js) mengaktifkannya saat aplikasi idle di layar sambutan.
   ========================================================= */

"use strict";

const VERSION = "TEST-C";
const CACHE_PREFIX = "wedding-guestbook-";
const CACHE_NAME = CACHE_PREFIX + VERSION;

// Semua jalur relatif terhadap lokasi sw.js (aman untuk GitHub Pages di subfolder /nama-repo/).
const PRECACHE = [
  "./",
  "index.html",
  "admin.html",
  "style.css",
  "luxury.css",
  "admin.css",
  "pwa.css",
  "db.js",
  "app.js",
  "fx.js",
  "admin.js",
  "pwa.js",
  "manifest.webmanifest",
  "fonts/fonts.css",
  "fonts/cormorant-garamond-latin-500-normal.woff2",
  "fonts/cormorant-garamond-latin-600-normal.woff2",
  "fonts/cormorant-garamond-latin-500-italic.woff2",
  "fonts/montserrat-latin-400-normal.woff2",
  "fonts/montserrat-latin-500-normal.woff2",
  "fonts/montserrat-latin-600-normal.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

const PRECACHE_URLS = PRECACHE.map((p) => new URL(p, self.registration.scope).href);
const PRECACHE_SET = new Set(PRECACHE_URLS);
const INDEX_URL = new URL("index.html", self.registration.scope).href;

/* ---------- Install: simpan semua aset (atomik) ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // cache: "reload" → selalu ambil dari jaringan, bukan dari cache HTTP browser.
      // Jika satu berkas saja gagal, install dibatalkan dan versi lama tetap dipakai.
      await cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })));
    })()
  );
  // Sengaja TANPA self.skipWaiting(): versi baru menunggu sampai aman diaktifkan.
});

/* ---------- Activate: hapus cache versi lama (hanya Cache Storage) ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim(); // halaman yang sudah terbuka langsung dikontrol
    })()
  );
});

/* ---------- Fetch ---------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tidak mengintervensi lintas-origin
  if (req.headers.has("range")) return;            // streaming video/audio: biarkan browser
  if (req.destination === "video" || req.destination === "audio") return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req, url));
    return;
  }

  // Hanya aset yang ada di daftar precache. Yang lain (mis. assets/intro.mp4)
  // tidak diintervensi sehingga tetap lewat jaringan biasa dan gagal normal saat offline.
  const key = url.origin + url.pathname;
  if (PRECACHE_SET.has(key)) {
    event.respondWith(cacheFirst(req, key));
  }
});

async function matchPrecache(urlString) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(urlString, { ignoreSearch: true });
}

async function cacheFirst(req, key) {
  const hit = await matchPrecache(key);
  if (hit) return hit;
  return fetch(req); // belum ter-cache (mis. cache dibersihkan sistem) → coba jaringan
}

// Navigasi: selalu dari cache (cepat & berfungsi offline). Jalur yang tidak dikenal
// (mis. /repo/apa-saja) diarahkan ke index.html.
async function handleNavigation(req, url) {
  const key = url.origin + url.pathname;

  const direct = PRECACHE_SET.has(key) ? await matchPrecache(key) : null;
  if (direct) return direct;

  const fallback = await matchPrecache(INDEX_URL);
  if (fallback) return fallback;

  try {
    return await fetch(req);
  } catch (_) {
    return new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
        "<body style='font-family:sans-serif;background:#1c120d;color:#f7f1e3;padding:32px'>" +
        "<h1>Aplikasi belum tersimpan untuk mode offline</h1>" +
        "<p>Hubungkan perangkat ke internet, buka aplikasi sekali, lalu coba lagi.</p></body>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

/* ---------- Pesan dari halaman ---------- */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (data.type === "GET_INFO" && port) {
    event.waitUntil(
      (async () => {
        let cachedCount = 0;
        let complete = false;
        try {
          const cache = await caches.open(CACHE_NAME);
          const keys = await cache.keys();
          const have = new Set(keys.map((k) => k.url));
          cachedCount = keys.length;
          complete = PRECACHE_URLS.every((u) => have.has(u));
        } catch (_) { /* diabaikan */ }
        port.postMessage({
          version: VERSION,
          cacheName: CACHE_NAME,
          cachedCount,
          expectedCount: PRECACHE_URLS.length,
          precacheComplete: complete,
        });
      })()
    );
  }
});
