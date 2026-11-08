// Abre do cache na hora e atualiza em segundo plano: versão nova vale na próxima abertura.
const CACHE = 'gastos-v1';
const ARQUIVOS = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/app.js',
  'src/backup.js',
  'src/categorias.js',
  'src/db.js',
  'src/envelope.js',
  'src/importador.js',
  'src/inter-fatura.js',
  'src/inter-ofx.js',
  'src/lancamento.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const salvo = await cache.match(e.request, { ignoreSearch: true });
      const rede = fetch(e.request)
        .then((r) => {
          if (r.ok) cache.put(e.request, r.clone());
          return r;
        })
        .catch(() => salvo);
      return salvo || rede;
    }),
  );
});
