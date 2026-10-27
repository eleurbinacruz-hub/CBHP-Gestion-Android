/* Solo habilita instalación en Android; no cambia la aplicación de gestión. */
'use strict';
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch(() => { /* El panel seguirá funcionando en modo web. */ });
  });
}
