/* CBHP | Backend Cloudflare Pages (Advanced Mode).
 * La única puerta de acceso es la aplicación Cloudflare Access de
 * admin.cbhp.org.do (la política debe cubrir todas las rutas, incluida /api/*).
 * SIN validación de tokens JWT dentro de este Worker, según lo solicitado.
 * Todas las demás direcciones, incluidas *.pages.dev, se bloquean en código.
 */
const ADMIN_HOST = 'admin.cbhp.org.do';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, private',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
/* La autorización se aplica en el borde por la aplicación Cloudflare Access
 * que protege admin.cbhp.org.do completo (incluido /api/*).
 * No se analiza, decodifica ni verifica ningún JWT en este Worker.
 * IMPORTANTE: Solo desplegar con la política Access activa y restrictiva.
 */
function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function fail(message, status = 400) { return reply({ error: message }, status); }
function validCedula(value) { return typeof value === 'string' && /^\d{11}$/.test(value); }
function cleanText(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit + 1) : ''; }
async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('Debes enviar JSON');
  const raw = await request.text();
  if (raw.length > 12_000) throw Error('Datos demasiado largos');
  const body = JSON.parse(raw);
  if (body === null || Array.isArray(body) || typeof body !== 'object') throw Error('Datos inválidos');
  return body;
}
function parseRecord(body) {
  const cedula = typeof body.cedula === 'string' ? body.cedula.replace(/\D/g, '') : '';
  const nombre = cleanText(body.nombre, 120);
  const rango = cleanText(body.rango, 80);
  const rol = cleanText(body.rol || '', 100);
  const estado = body.estado;
  if (!validCedula(cedula)) throw Error('La cédula debe tener 11 dígitos');
  if (!nombre || nombre.length > 120) throw Error('Escribe un nombre válido (máximo 120 caracteres)');
  if (!rango || rango.length > 80) throw Error('Escribe un rango válido (máximo 80 caracteres)');
  if (rol.length > 100) throw Error('Rol demasiado largo (máximo 100 caracteres)');
  if (estado !== 'Activo' && estado !== 'Inactivo') throw Error('Estado inválido');
  return { cedula, nombre, rango, rol, estado };
}
// D1 guarda una foto JPEG compacta por persona. La tabla se crea al primer uso
// sin alterar las columnas existentes de `personal` ni el Worker público.
async function ensurePhotoTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS personal_fotos (
    personal_id INTEGER PRIMARY KEY,
    mime TEXT NOT NULL,
    imagen BLOB NOT NULL,
    actualizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}
async function listRecords(url, db) {
  await ensurePhotoTable(db);
  const estado = url.searchParams.get('estado') || 'Todos';
  if (!['Todos', 'Activo', 'Inactivo'].includes(estado)) return fail('Filtro de estado inválido');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const limit = 20;
  const where = [], params = [];
  if (estado !== 'Todos') { where.push('estado = ?'); params.push(estado); }
  if (q) { where.push('(nombre LIKE ? OR cedula LIKE ? OR rango LIKE ? OR rol LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const [stats, filtered, records] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN estado = 'Activo' THEN 1 ELSE 0 END) AS activos, SUM(CASE WHEN estado = 'Inactivo' THEN 1 ELSE 0 END) AS inactivos FROM personal").first(),
    db.prepare('SELECT COUNT(*) AS n FROM personal' + whereSql).bind(...params).first(),
    db.prepare('SELECT id, cedula, nombre, rango, rol, estado, creado_en, EXISTS (SELECT 1 FROM personal_fotos WHERE personal_id = personal.id) AS tiene_foto FROM personal' + whereSql + ' ORDER BY nombre COLLATE NOCASE ASC, id DESC LIMIT ? OFFSET ?').bind(...params, limit, (page - 1) * limit).all(),
  ]);
  return reply({ personal: records.results || [], stats: { total: stats?.total || 0, activos: stats?.activos || 0, inactivos: stats?.inactivos || 0 }, page, limit, encontrados: filtered?.n || 0 });
}
async function createRecord(request, db) {
  const body = parseRecord(await readBody(request));
  const existing = await db.prepare('SELECT id FROM personal WHERE cedula = ? LIMIT 1').bind(body.cedula).first();
  if (existing) return fail('Ya existe un bombero registrado con esa cédula.', 409);
  const result = await db.prepare('INSERT INTO personal (cedula, nombre, rango, rol, estado) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM personal WHERE cedula = ?)')
    .bind(body.cedula, body.nombre, body.rango, body.rol, body.estado, body.cedula).run();
  if (result.meta?.changes === 0) return fail('Ya existe un bombero registrado con esa cédula.', 409);
  return reply({ ok: true, id: result.meta?.last_row_id, mensaje: 'Bombero agregado correctamente.' }, 201);
}
async function updateRecord(request, db, id) {
  const body = parseRecord(await readBody(request));
  const current = await db.prepare('SELECT id FROM personal WHERE id = ?').bind(id).first();
  if (!current) return fail('Registro no encontrado.', 404);
  const existing = await db.prepare('SELECT id FROM personal WHERE cedula = ? AND id <> ? LIMIT 1').bind(body.cedula, id).first();
  if (existing) return fail('Esa cédula pertenece a otro registro.', 409);
  const r = await db.prepare('UPDATE personal SET cedula = ?, nombre = ?, rango = ?, rol = ?, estado = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM personal WHERE cedula = ? AND id <> ?)')
    .bind(body.cedula, body.nombre, body.rango, body.rol, body.estado, id, body.cedula, id).run();
  if (r.meta?.changes === 0) return fail('No se pudo actualizar el registro.', 409);
  return reply({ ok: true, mensaje: 'Datos actualizados correctamente.' });
}
async function changeStatus(request, db, id) {
  const body = await readBody(request);
  if (body.estado !== 'Activo' && body.estado !== 'Inactivo') return fail('Estado inválido');
  const r = await db.prepare('UPDATE personal SET estado = ? WHERE id = ?').bind(body.estado, id).run();
  if (r.meta?.changes === 0) return fail('Registro no encontrado.', 404);
  return reply({ ok: true, mensaje: 'Estado cambiado a ' + body.estado + '.' });
}
// Eliminación definitiva: exige la palabra EXACTA y que la cédula coincida
// con el registro seleccionado. No se admite una petición sin confirmación.
async function deleteRecord(request, db, id) {
  const body = await readBody(request);
  if (body.confirmacion !== 'ELIMINAR') {
    return fail('Para eliminar debes escribir ELIMINAR exactamente en mayúsculas.', 400);
  }
  if (!validCedula(body.cedula)) return fail('Confirmación del registro inválida.', 400);
  const current = await db.prepare('SELECT id, cedula FROM personal WHERE id = ? LIMIT 1').bind(id).first();
  if (!current) return fail('Este registro ya no existe.', 404);
  if (current.cedula !== body.cedula) {
    return fail('El registro cambió. Actualiza el listado antes de eliminar.', 409);
  }
  const result = await db.prepare('DELETE FROM personal WHERE id = ? AND cedula = ?')
    .bind(id, current.cedula).run();
  if (result.meta?.changes !== 1) return fail('No se pudo eliminar. Actualiza el listado.', 409);
  await ensurePhotoTable(db);
  await db.prepare('DELETE FROM personal_fotos WHERE personal_id = ?').bind(id).run();
  return reply({ ok: true, mensaje: 'Registro y fotografía eliminados definitivamente.' });
}
// Fotos accesibles solo dentro del subdominio administrativo protegido por Access.
// El formulario convierte todas las imágenes a JPEG pequeño antes del envío.
const PHOTO_LIMIT = 450_000;
const PHOTO_HEADERS = {
  'content-type': 'image/jpeg',
  'cache-control': 'no-store, private',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};
async function getPhoto(db, id) {
  await ensurePhotoTable(db);
  const photo = await db.prepare('SELECT f.imagen FROM personal_fotos f JOIN personal p ON p.id = f.personal_id WHERE f.personal_id = ?').bind(id).first();
  if (!photo?.imagen) return fail('No hay foto para este bombero.', 404);
  // D1 convierte los BLOB a arreglos de octetos al leerlos.
  return new Response(Uint8Array.from(photo.imagen), { status: 200, headers: PHOTO_HEADERS });
}
async function savePhoto(request, db, id) {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/jpeg')
    return fail('La imagen debe estar en JPEG.', 415);
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > PHOTO_LIMIT) return fail('La imagen es demasiado grande.', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > PHOTO_LIMIT) return fail('La foto debe ocupar menos de 450 KB.', 413);
  // Comprobar cabecera y marcador de final JPEG; no confiar solo en Content-Type.
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)
    return fail('El archivo no parece ser un JPEG válido.', 415);
  const exists = await db.prepare('SELECT id FROM personal WHERE id = ? LIMIT 1').bind(id).first();
  if (!exists) return fail('Bombero no encontrado.', 404);
  await ensurePhotoTable(db);
  await db.prepare(`INSERT INTO personal_fotos (personal_id, mime, imagen, actualizado_en)
    VALUES (?, 'image/jpeg', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(personal_id) DO UPDATE SET mime='image/jpeg', imagen=excluded.imagen, actualizado_en=CURRENT_TIMESTAMP`)
    .bind(id, bytes).run();
  return reply({ ok: true, mensaje: 'Fotografía guardada correctamente.' });
}
async function deletePhoto(db, id) {
  await ensurePhotoTable(db);
  await db.prepare('DELETE FROM personal_fotos WHERE personal_id = ?').bind(id).run();
  return reply({ ok: true, mensaje: 'Fotografía eliminada.' });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Restringir TODO el panel al nombre público protegido por Access.
    // De esta manera, *.pages.dev y los enlaces de preview no exponen la API
    // aunque la política de Access de esas direcciones esté mal configurada.
    if (url.hostname !== ADMIN_HOST || url.protocol !== 'https:') {
      return fail('Este panel solo está disponible en https://admin.cbhp.org.do.', 403);
    }
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) return fail('Método no permitido.', 405);
      return env.ASSETS.fetch(request);
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return fail('Método no permitido.', 405);
    // Protección CSRF independiente de Cloudflare Access: la API no permite
    // que formularios de otras webs ejecuten operaciones de escritura.
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin !== 'https://' + ADMIN_HOST) return fail('Origen no permitido.', 403);
      const fetchSite = request.headers.get('sec-fetch-site');
      if (fetchSite && fetchSite !== 'same-origin') return fail('Solicitud externa no permitida.', 403);
    }
    if (!env.BD) return fail('No se encontró el binding BD de la base de datos.', 503);
    if (url.pathname === '/api/sesion' && request.method === 'GET') return reply({ ok: true, modo: 'Cloudflare Access' });
    try {
      const photoMatch = url.pathname.match(/^\/api\/personal\/(\d+)\/foto$/);
      if (photoMatch) {
        const photoId = Number(photoMatch[1]);
        if (!Number.isSafeInteger(photoId) || photoId < 1) return fail('Identificador inválido.');
        if (request.method === 'GET') return await getPhoto(env.BD, photoId);
        if (request.method === 'PUT') return await savePhoto(request, env.BD, photoId);
        if (request.method === 'DELETE') return await deletePhoto(env.BD, photoId);
      }
      if (url.pathname === '/api/personal') {
        if (request.method === 'GET') return await listRecords(url, env.BD);
        if (request.method === 'POST') return await createRecord(request, env.BD);
      }
      const match = url.pathname.match(/^\/api\/personal\/(\d+)(\/estado)?$/);
      if (match) {
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id < 1) return fail('Identificador inválido.');
        if (!match[2] && request.method === 'PUT') return await updateRecord(request, env.BD, id);
        if (!match[2] && request.method === 'DELETE') return await deleteRecord(request, env.BD, id);
        if (match[2] && request.method === 'PATCH') return await changeStatus(request, env.BD, id);
      }
      return fail('Ruta no encontrada.', 404);
    } catch (e) {
      if (e instanceof SyntaxError || (e instanceof Error && /JSON|válid|dígitos|nombre|rango|Rol|rol|Estado|Datos|demasiado|enviar/.test(e.message))) {
        return fail(e.message || 'Datos inválidos');
      }
      // No exponer detalles de D1 al navegador.
      return fail('No se pudo completar la operación. Revisa la configuración y los registros del proyecto.', 500);
    }
  },
};
