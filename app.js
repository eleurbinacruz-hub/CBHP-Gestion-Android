'use strict';
const $ = id => document.getElementById(id);
const state = { page: 1, items: [], total: 0, busy: false, editId: null, lastFocus: null, deletePerson: null, deleting: false, deleteLastFocus: null, photoBlob: null, photoObjectUrl: null, photoHadSaved: false, photoRemoveRequested: false, cameraStream: null, cameraStarting: false };
function alertUser(message, good = false) {
  const el = $('alert'); el.textContent = message; el.classList.remove('hidden'); el.classList.toggle('success', good);
}
function clearAlert() { $('alert').classList.add('hidden'); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error del servidor (${response.status})`);
  return data;
}
const text = (tag, value, className) => {
  const el = document.createElement(tag); el.textContent = value ?? '';
  if (className) el.className = className;
  return el;
};
function setLoading(on) { state.busy = on; $('refreshBtn').disabled = on; $('addBtn').disabled = on; }
async function load() {
  if (state.busy) return;
  setLoading(true); clearAlert();
  $('bodyRows').replaceChildren(); const row = document.createElement('tr'); const cell = text('td', 'Consultando la base de datos…', 'empty'); cell.colSpan = 6; row.append(cell); $('bodyRows').append(row);
  try {
    const params = new URLSearchParams({ q: $('q').value.trim(), estado: $('estado').value, page: String(state.page) });
    const result = await api('/api/personal?' + params);
    state.items = result.personal || []; state.total = result.encontrados || 0;
    $('total').textContent = String(result.stats.total);
    $('activos').textContent = String(result.stats.activos);
    $('inactivos').textContent = String(result.stats.inactivos);
    renderRows();
    const start = state.total ? (state.page - 1) * result.limit + 1 : 0;
    const end = Math.min(state.total, state.page * result.limit);
    $('countLabel').textContent = `Mostrando ${start}–${end} de ${state.total} resultado(s)`;
    $('pageLabel').textContent = `Página ${state.page}`;
    $('prevBtn').disabled = state.page <= 1;
    $('nextBtn').disabled = state.page * result.limit >= state.total;
    $('sessionStatus').textContent = 'Conectado al registro institucional';
  } catch (error) {
    $('bodyRows').replaceChildren();
    const r = document.createElement('tr'); const c = text('td', 'No se pudo cargar el personal. Revisa el mensaje superior.', 'empty'); c.colSpan = 6; r.append(c); $('bodyRows').append(r);
    alertUser(error.message); $('sessionStatus').textContent = 'Conexión pendiente';
    $('countLabel').textContent = 'No hay datos disponibles'; $('prevBtn').disabled = true; $('nextBtn').disabled = true;
  } finally { setLoading(false); }
}
function renderRows() {
  const tbody = $('bodyRows'); tbody.replaceChildren();
  if (!state.items.length) {
    const tr = document.createElement('tr'); const td = text('td', 'No se encontraron registros con esos filtros.', 'empty'); td.colSpan = 6; tr.append(td); tbody.append(tr); return;
  }
  state.items.forEach(person => {
    const tr = document.createElement('tr');
    const personCell = document.createElement('td');
    const personBox = document.createElement('div'); personBox.className = 'person-with-photo';
    if (person.tiene_foto) {
      const avatar = document.createElement('img'); avatar.className = 'person-avatar';
      avatar.src = `/api/personal/${person.id}/foto`;
      avatar.alt = 'Foto de ' + person.nombre; avatar.loading = 'lazy';
      personBox.append(avatar);
    } else {
      const placeholder = text('span', '◎', 'person-avatar person-avatar-empty');
      placeholder.setAttribute('aria-hidden', 'true'); personBox.append(placeholder);
    }
    personBox.append(text('span', person.nombre, 'person-name')); personCell.append(personBox);
    const rangoRol = document.createElement('td');
    rangoRol.append(text('div', person.rango));
    if (person.rol) rangoRol.append(text('div', 'Rol: ' + person.rol, 'person-role'));
    tr.append(personCell, text('td', person.cedula, 'person-id'), rangoRol);
    const sc = document.createElement('td'); sc.append(text('span', person.estado, 'pill ' + (person.estado === 'Activo' ? 'active' : 'inactive'))); tr.append(sc);
    const actions = document.createElement('td'); const group = document.createElement('div'); group.className = 'row-actions';
    const edit = text('button', 'Editar'); edit.type = 'button'; edit.addEventListener('click', () => openDialog(person));
    const deactivate = person.estado === 'Activo';
    const toggle = text('button', deactivate ? 'Desactivar' : 'Activar', deactivate ? 'switch-off' : 'switch-on'); toggle.type = 'button';
    toggle.addEventListener('click', () => toggleStatus(person));
    const remove = text('button', 'Eliminar', 'delete-action');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Eliminar a ' + person.nombre);
    remove.addEventListener('click', () => openDeleteDialog(person));
    group.append(edit, toggle); actions.append(group); tr.append(actions);
    const deleteCell = document.createElement('td');
    deleteCell.className = 'delete-cell';
    deleteCell.append(remove);
    tbody.append(tr);
    tr.append(deleteCell);
  });
}
// La foto se convierte en JPEG retrato de 450×600 para evitar imágenes pesadas
// en D1 (Cloudflare establece un límite de 2 MB por valor BLOB).
function showPhoto(source) {
  if (state.photoObjectUrl) { URL.revokeObjectURL(state.photoObjectUrl); state.photoObjectUrl = null; }
  const img = $('photoPreviewImage');
  if (!source) { img.removeAttribute('src'); img.classList.add('hidden'); $('photoPlaceholder').classList.remove('hidden'); return; }
  if (source instanceof Blob) {
    state.photoObjectUrl = URL.createObjectURL(source);
    img.src = state.photoObjectUrl;
  } else img.src = source;
  img.classList.remove('hidden'); $('photoPlaceholder').classList.add('hidden');
}
function syncRemovePhoto() {
  $('removePhotoBtn').classList.toggle('hidden', !state.photoBlob && (!state.photoHadSaved || state.photoRemoveRequested));
}
async function makeSmallJpeg(source) {
  const src = source instanceof Blob ? URL.createObjectURL(source) : null;
  try {
    let width, height, draw;
    if (source instanceof HTMLVideoElement) {
      width = source.videoWidth; height = source.videoHeight;
      draw = (ctx, sx, sy, sw, sh) => ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 450, 600);
    } else {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('No se pudo abrir esa imagen.')); img.src = src; });
      width = img.naturalWidth; height = img.naturalHeight;
      draw = (ctx, sx, sy, sw, sh) => ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 450, 600);
    }
    if (!width || !height) throw new Error('La imagen está vacía o no es compatible.');
    const aspect = 3 / 4;
    const sourceWidth = Math.min(width, height * aspect);
    const sourceHeight = Math.min(height, width / aspect);
    const x = (width - sourceWidth) / 2, y = (height - sourceHeight) / 2;
    const canvas = document.createElement('canvas'); canvas.width = 450; canvas.height = 600;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('No se pudo procesar la imagen.');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 450, 600);
    draw(ctx, x, y, sourceWidth, sourceHeight);
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (jpeg && jpeg.size > 0 && jpeg.size <= 450000) return jpeg;
    }
    throw new Error('La foto no pudo reducirse a menos de 450 KB. Prueba otra imagen.');
  } finally { if (src) URL.revokeObjectURL(src); }
}
async function setSelectedPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) throw new Error('Selecciona un archivo de imagen JPG, PNG o WebP.');
  if (file.size > 15 * 1024 * 1024) throw new Error('El archivo original supera 15 MB. Usa una foto más pequeña.');
  state.photoBlob = await makeSmallJpeg(file);
  state.photoRemoveRequested = false;
  showPhoto(state.photoBlob);
  syncRemovePhoto();
  $('photoHelp').textContent = `Foto lista para guardar · ${Math.ceil(state.photoBlob.size / 1024)} KB`;
}
async function stopCamera() {
  if (state.cameraStream) { state.cameraStream.getTracks().forEach(track => track.stop()); state.cameraStream = null; }
  $('cameraVideo').srcObject = null;
  $('cameraBox').classList.add('hidden');
}
async function startCamera() {
  if (state.cameraStarting) return;
  if (!navigator.mediaDevices?.getUserMedia) { $('photoCaptureInput').click(); return; }
  state.cameraStarting = true;
  try {
    await stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } } });
    // Si se cerró el formulario durante la solicitud de permisos, detener cámara.
    if ($('dialogBackdrop').classList.contains('hidden')) { stream.getTracks().forEach(track => track.stop()); return; }
    state.cameraStream = stream;
    $('cameraVideo').srcObject = stream;
    $('cameraBox').classList.remove('hidden');
    await $('cameraVideo').play();
  } catch (err) {
    await stopCamera();
    $('photoHelp').textContent = 'No se pudo abrir la cámara; puedes tomar una foto con tu teléfono o subir un archivo.';
    $('photoCaptureInput').click();
  } finally { state.cameraStarting = false; }
}
async function sendPhoto(id, blob) {
  const response = await fetch(`/api/personal/${id}/foto`, {
    method: 'PUT', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Accept': 'application/json', 'Content-Type': 'image/jpeg' }, body: blob,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `No se pudo subir la fotografía (${response.status})`);
}
function openDialog(person = null) {
  state.lastFocus = document.activeElement;
  state.editId = person?.id ?? null;
  $('dialogTitle').textContent = person ? 'Editar bombero' : 'Agregar bombero';
  $('saveBtn').textContent = person ? 'Guardar cambios' : 'Guardar registro';
  $('personForm').reset();
  $('nameInput').value = person?.nombre || '';
  $('cedulaInput').value = person?.cedula || '';
  $('rangoInput').value = person?.rango || '';
  $('rolInput').value = person?.rol || '';
  $('statusInput').value = person?.estado || 'Activo';
  state.photoBlob = null;
  state.photoHadSaved = Boolean(person?.tiene_foto);
  state.photoRemoveRequested = false;
  $('photoHelp').textContent = 'Se aceptan JPG, PNG y WebP. La fotografía se adapta automáticamente.';
  stopCamera();
  showPhoto(state.photoHadSaved ? `/api/personal/${person.id}/foto` : null);
  syncRemovePhoto();
  $('photoFileInput').value = '';
  $('photoCaptureInput').value = '';
  $('formError').classList.add('hidden');
  $('dialogBackdrop').classList.remove('hidden'); $('dialogBackdrop').setAttribute('aria-hidden', 'false');
  $('nameInput').focus();
}
function closeDialog() {
  stopCamera();
  showPhoto(null);
  $('dialogBackdrop').classList.add('hidden'); $('dialogBackdrop').setAttribute('aria-hidden', 'true');
  if (state.lastFocus?.isConnected) state.lastFocus.focus();
}
async function toggleStatus(person) {
  const nuevo = person.estado === 'Activo' ? 'Inactivo' : 'Activo';
  if (!confirm(`¿Cambiar a ${nuevo} el estado de ${person.nombre}?\n\nEl registro no será eliminado.`)) return;
  try {
    const response = await api(`/api/personal/${person.id}/estado`, { method: 'PATCH', body: JSON.stringify({ estado: nuevo }) });
    await load(); alertUser(response.mensaje, true);
  } catch (error) { alertUser(error.message); }
}
// La palabra no se autocompleta ni se convierte a mayúsculas: debe escribirla
// manualmente y de manera exacta. El servidor la comprueba de nuevo.
function openDeleteDialog(person) {
  state.deletePerson = { id: person.id, nombre: person.nombre, cedula: person.cedula };
  state.deleteLastFocus = document.activeElement;
  $('deletePersonName').textContent = person.nombre;
  $('deletePersonCedula').textContent = person.cedula;
  $('deleteConfirmInput').value = '';
  $('deleteFormError').textContent = '';
  $('deleteFormError').classList.add('hidden');
  $('confirmDeleteBtn').disabled = true;
  $('confirmDeleteBtn').textContent = 'Eliminar definitivamente';
  $('deleteBackdrop').classList.remove('hidden');
  $('deleteBackdrop').setAttribute('aria-hidden', 'false');
  $('deleteConfirmInput').focus();
}
function closeDeleteDialog() {
  if (state.deleting) return;
  $('deleteBackdrop').classList.add('hidden');
  $('deleteBackdrop').setAttribute('aria-hidden', 'true');
  state.deletePerson = null;
  if (state.deleteLastFocus?.isConnected) state.deleteLastFocus.focus();
}
$('deleteConfirmInput').addEventListener('input', () => {
  $('confirmDeleteBtn').disabled = $('deleteConfirmInput').value !== 'ELIMINAR' || state.deleting;
  $('deleteFormError').classList.add('hidden');
});
$('deleteCloseBtn').addEventListener('click', closeDeleteDialog);
$('deleteCancelBtn').addEventListener('click', closeDeleteDialog);
$('deleteBackdrop').addEventListener('click', event => {
  if (event.target === $('deleteBackdrop')) closeDeleteDialog();
});
$('deleteForm').addEventListener('submit', async event => {
  event.preventDefault();
  const person = state.deletePerson;
  if (!person || state.deleting) return;
  if ($('deleteConfirmInput').value !== 'ELIMINAR') {
    $('deleteFormError').textContent = 'Debes escribir ELIMINAR exactamente en mayúsculas.';
    $('deleteFormError').classList.remove('hidden');
    return;
  }
  state.deleting = true;
  $('confirmDeleteBtn').disabled = true;
  $('deleteCancelBtn').disabled = true;
  $('deleteCloseBtn').disabled = true;
  $('confirmDeleteBtn').textContent = 'Eliminando…';
  try {
    const response = await api(`/api/personal/${person.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmacion: 'ELIMINAR', cedula: person.cedula }),
    });
    state.deleting = false;
    $('deleteBackdrop').classList.add('hidden');
    $('deleteBackdrop').setAttribute('aria-hidden', 'true');
    state.deletePerson = null;
    if (state.items.length === 1 && state.page > 1) state.page--;
    await load();
    alertUser(response.mensaje, true);
  } catch (error) {
    $('deleteFormError').textContent = error.message;
    $('deleteFormError').classList.remove('hidden');
  } finally {
    state.deleting = false;
    $('deleteCancelBtn').disabled = false;
    $('deleteCloseBtn').disabled = false;
    $('confirmDeleteBtn').textContent = 'Eliminar definitivamente';
    $('confirmDeleteBtn').disabled = $('deleteConfirmInput').value !== 'ELIMINAR';
  }
});
$('personForm').addEventListener('submit', async event => {
  event.preventDefault();
  const cedula = $('cedulaInput').value.replace(/\D/g, '');
  if (!/^\d{11}$/.test(cedula)) { $('formError').textContent = 'La cédula debe contener exactamente 11 dígitos.'; $('formError').classList.remove('hidden'); return; }
  const data = { nombre: $('nameInput').value.trim(), cedula, rango: $('rangoInput').value.trim(), rol: $('rolInput').value.trim(), estado: $('statusInput').value };
  $('formError').classList.add('hidden'); $('saveBtn').disabled = true; $('saveBtn').textContent = 'Guardando…';
  let savedRecord = false;
  try {
    const editId = state.editId;
    const response = await api(editId ? `/api/personal/${editId}` : '/api/personal', {
      method: editId ? 'PUT' : 'POST', body: JSON.stringify(data),
    });
    savedRecord = true;
    const id = editId || response.id;
    if (state.photoBlob || (state.photoRemoveRequested && editId)) {
      try {
        if (!id) throw new Error('No se recibió el identificador del registro nuevo.');
        if (state.photoBlob) await sendPhoto(id, state.photoBlob);
        else await api(`/api/personal/${id}/foto`, { method: 'DELETE' });
      } catch (photoError) {
        closeDialog(); state.page = 1; await load();
        alertUser('El registro se guardó correctamente, pero la fotografía no: ' + photoError.message + '. Puedes editar el registro para intentarlo de nuevo.');
        return;
      }
    }
    closeDialog(); state.page = 1; await load();
    alertUser(response.mensaje + (state.photoBlob ? ' Fotografía guardada.' : ''), true);
  } catch (error) {
    $('formError').textContent = savedRecord ? 'El registro se guardó, pero ocurrió un problema posterior: ' + error.message : error.message;
    $('formError').classList.remove('hidden');
  }
  finally { $('saveBtn').disabled = false; $('saveBtn').textContent = state.editId ? 'Guardar cambios' : 'Guardar registro'; }
});
$('uploadPhotoBtn').addEventListener('click', () => $('photoFileInput').click());
$('takePhotoBtn').addEventListener('click', startCamera);
$('stopCameraBtn').addEventListener('click', stopCamera);
$('capturePhotoBtn').addEventListener('click', async () => {
  try {
    const video = $('cameraVideo');
    if (!video.videoWidth || !video.videoHeight) throw new Error('La cámara todavía no está lista.');
    state.photoBlob = await makeSmallJpeg(video);
    state.photoRemoveRequested = false;
    showPhoto(state.photoBlob); syncRemovePhoto();
    $('photoHelp').textContent = 'Foto capturada y lista para guardar.';
    await stopCamera();
  } catch (e) { $('formError').textContent = e.message; $('formError').classList.remove('hidden'); }
});
for (const inputId of ['photoFileInput', 'photoCaptureInput']) {
  $(inputId).addEventListener('change', async event => {
    try { await setSelectedPhoto(event.target.files?.[0]); $('formError').classList.add('hidden'); }
    catch (err) { $('formError').textContent = err.message; $('formError').classList.remove('hidden'); }
    event.target.value = '';
  });
}
$('removePhotoBtn').addEventListener('click', () => {
  state.photoBlob = null;
  state.photoRemoveRequested = state.photoHadSaved;
  showPhoto(null); syncRemovePhoto();
  $('photoHelp').textContent = state.photoHadSaved ? 'La foto actual se quitará cuando guardes los cambios.' : 'Foto descartada.';
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
$('addBtn').addEventListener('click', () => openDialog());
$('closeBtn').addEventListener('click', closeDialog);
$('cancelBtn').addEventListener('click', closeDialog);
$('dialogBackdrop').addEventListener('click', event => { if (event.target === $('dialogBackdrop')) closeDialog(); });
document.addEventListener('keydown', event => {
  const deleting = !$('deleteBackdrop').classList.contains('hidden');
  const editing = !$('dialogBackdrop').classList.contains('hidden');
  if (!deleting && !editing) return;
  if (event.key === 'Escape') {
    if (deleting) closeDeleteDialog(); else closeDialog();
    return;
  }
  if (event.key === 'Tab') {
    const backdrop = deleting ? $('deleteBackdrop') : $('dialogBackdrop');
    const focusables = [...backdrop.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
    const i = focusables.indexOf(document.activeElement);
    if (!focusables.length) { event.preventDefault(); return; }
    if (event.shiftKey && i === 0) { focusables.at(-1).focus(); event.preventDefault(); }
    else if (!event.shiftKey && i === focusables.length - 1) { focusables[0].focus(); event.preventDefault(); }
  }
});
$('searchForm').addEventListener('submit', e => { e.preventDefault(); state.page = 1; load(); });
$('estado').addEventListener('change', () => { state.page = 1; load(); });
$('refreshBtn').addEventListener('click', load);
$('prevBtn').addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
$('nextBtn').addEventListener('click', () => { if (state.page * 20 < state.total) { state.page++; load(); } });
load();
