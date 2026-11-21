// Service worker: cache vỏ app để mở được như app cài sẵn. KHÔNG bao giờ đụng tới request sang API/CDN.
const CACHE = 'vqs-shell-v1'; // đổi số khi phát hành bản mới
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'src/web/styles.css', 'src/web/app.js', 'src/web/audio-pcm.js', 'src/web/job-store.js', 'src/web/video-frames.js',
  'src/web/whisper-client.js', 'src/web/whisper-worker.js',
  'src/core/constants.js', 'src/core/claude-client.js', 'src/core/cost.js', 'src/core/cross-check.js',
  'src/core/extract-questions.js', 'src/core/frame-dedupe.js', 'src/core/pipeline.js', 'src/core/solve-questions.js',
  'src/core/speech-to-text.js', 'src/core/transcript-format.js',
  'vendor/ffmpeg/index.js', 'vendor/ffmpeg/classes.js', 'vendor/ffmpeg/const.js', 'vendor/ffmpeg/errors.js',
  'vendor/ffmpeg/types.js', 'vendor/ffmpeg/utils.js', 'vendor/ffmpeg/worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Mạng trước, cache sau: có mạng thì luôn lấy bản mới nhất, mất mạng vẫn mở được vỏ app.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response.ok) return response;
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit ?? Response.error())),
  );
});
