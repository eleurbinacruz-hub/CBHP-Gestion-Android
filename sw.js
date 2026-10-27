/* CBHP Gestión para Android
 * Sin cache de datos: por seguridad los nombres, cedulas y fotos se consultan
 * siempre en el servidor protegido por Cloudflare Access.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
// Intencionalmente: sin cache ni interceptar solicitudes de red.
