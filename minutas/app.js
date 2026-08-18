const $ = id => document.getElementById(id);
const ESTADOS = ['Pendiente', 'Programado', 'En curso', 'Observado', 'Completado'];
const GEMINI_MODEL = 'gemini-2.5-flash';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const genId = () => Math.random().toString(36).slice(2, 10);

// ---------- Almacenamiento local (este navegador) ----------
// Modelo: proyecto -> tipo de reunión (serie) -> acuerdos (seguimiento) + minutas (archivo)

const LS = {
  key: () => localStorage.getItem('scribe_gemini_key') || '',
  setKey: v => localStorage.setItem('scribe_gemini_key', v),
  firma: () => localStorage.getItem('scribe_firma') || '',
  setFirma: v => localStorage.setItem('scribe_firma', v),
  projects: () => JSON.parse(localStorage.getItem('scribe_projects') || '[]'),
  setProjects: p => localStorage.setItem('scribe_projects', JSON.stringify(p)),
  series: () => JSON.parse(localStorage.getItem('scribe_series') || '[]'),
  setSeries: s => localStorage.setItem('scribe_series', JSON.stringify(s)),
  acuerdos: sid => JSON.parse(localStorage.getItem('scribe_acuerdos_' + sid) || '[]'),
  setAcuerdos: (sid, a) => localStorage.setItem('scribe_acuerdos_' + sid, JSON.stringify(a)),
  minutas: sid => JSON.parse(localStorage.getItem('scribe_minutas_' + sid) || '[]'),
  setMinutas: (sid, m) => localStorage.setItem('scribe_minutas_' + sid, JSON.stringify(m)),
};

// Migración v1 (proyecto con stakeholders + acuerdos por proyecto) -> v2 (con series)
function migrar() {
  if (localStorage.getItem('scribe_schema') === '2') return;
  const viejos = LS.projects();
  if (viejos.length && viejos[0].stakeholders !== undefined) {
    const nuevosProj = [];
    const series = [];
    viejos.forEach(op => {
      nuevosProj.push({ id: op.id, nombre: op.nombre });
      const sid = genId();
      series.push({ id: sid, projectId: op.id, nombre: 'General', stakeholders: op.stakeholders || [] });
      const ac = localStorage.getItem('scribe_acuerdos_' + op.id);
      if (ac) { localStorage.setItem('scribe_acuerdos_' + sid, ac); localStorage.removeItem('scribe_acuerdos_' + op.id); }
    });
    LS.setProjects(nuevosProj);
    LS.setSeries(series);
  }
  localStorage.setItem('scribe_schema', '2');
}

// Carga inicial: en una instalación nueva (sin datos) deja listos los tipos de reunión base
function seedInicial() {
  if (LS.projects().length) return;
  const pid = genId();
  LS.setProjects([{ id: pid, nombre: 'PMO Antamina' }]);
  LS.setSeries([
    { id: genId(), projectId: pid, nombre: 'Weekly', stakeholders: [] },
    { id: genId(), projectId: pid, nombre: 'Comité de gestión de la OTA', stakeholders: [] },
  ]);
}

let projects = [];
let series = [];
let adjuntos = []; // {name, type, b64} de la minuta actual (no se persisten)

// ---------- Toasts ----------

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 4200);
}

// ---------- Barra de pasos ----------

function setStep(n) {
  document.querySelectorAll('.step').forEach(s => {
    const step = +s.dataset.step;
    s.classList.toggle('is-active', step === n);
    s.classList.toggle('is-done', step < n);
  });
}

// ---------- Fechas (zona horaria de Lima) ----------

function hoyISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });
}

function lunesDeLaSemana(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function fechaLarga(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' });
}

function visibleEnMinuta(a, lunesSemana) {
  if (a.estado !== 'Completado') return true;
  return Boolean(a.fecha_cierre && a.fecha_cierre >= lunesSemana);
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Configuración de API key ----------

function refreshKeyStatus() {
  $('keyStatus').textContent = LS.key() ? 'API key configurada en este navegador.' : 'Aún no hay API key configurada.';
}

$('btnConfig').addEventListener('click', () => {
  $('panelConfig').classList.toggle('hidden');
  $('apiKey').value = LS.key();
  $('firmaInput').value = LS.firma();
  refreshKeyStatus();
});

$('btnGuardarKey').addEventListener('click', () => {
  LS.setKey($('apiKey').value.trim());
  refreshKeyStatus();
  if (LS.key()) toast('API key guardada en este navegador.');
});

$('btnGuardarFirma').addEventListener('click', () => {
  LS.setFirma($('firmaInput').value.trim());
  toast('Firma guardada.');
});

// ---------- Proyectos y series ----------

function cargarProyectos(selPid) {
  projects = LS.projects();
  series = LS.series();
  const sel = $('projectSelect');
  sel.innerHTML = projects.length
    ? projects.map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')
    : '<option value="">— Crea un proyecto —</option>';
  if (selPid) sel.value = selPid;
  cargarSeries();
}

function seriesDeProyecto(pid) {
  return series.filter(s => s.projectId === pid);
}

function cargarSeries(selSid) {
  const pid = $('projectSelect').value;
  const lista = seriesDeProyecto(pid);
  const sel = $('seriesSelect');
  sel.innerHTML = lista.length
    ? lista.map(s => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('')
    : '<option value="">— Crea un tipo de reunión —</option>';
  if (selSid) sel.value = selSid;
  actualizarHint();
  if (!$('panelHistorial').classList.contains('hidden')) renderHistorial();
}

function proyectoActual() { return projects.find(p => p.id === $('projectSelect').value); }
function serieActual() { return series.find(s => s.id === $('seriesSelect').value); }

$('projectSelect').addEventListener('change', () => cargarSeries());
$('seriesSelect').addEventListener('change', () => { actualizarHint(); if (!$('panelHistorial').classList.contains('hidden')) renderHistorial(); });

function chipHtml(correo, invalido) {
  return `<span class="chip${invalido ? ' invalid' : ''}">${esc(correo)}</span>`;
}

function actualizarHint() {
  const s = serieActual();
  const box = $('stakeholdersHint');
  if (s) {
    box.innerHTML = s.stakeholders.length
      ? '<span class="lead">Para</span>' + s.stakeholders.map(c => chipHtml(c, !EMAIL_RE.test(c))).join('')
      : '<span class="lead">Para</span><span class="none">sin correos configurados — usa ✎ Editar</span>';
  } else {
    box.innerHTML = '';
  }
  actualizarContinuidad();
}

// Muestra cuántos acuerdos de minutas anteriores se enlazarán en la nueva minuta
function actualizarContinuidad() {
  const s = serieActual();
  const box = $('continuidadHint');
  box.classList.remove('warn');
  if (!s) { box.classList.remove('show'); box.innerHTML = ''; return; }
  const abiertos = LS.acuerdos(s.id).filter(a => a.estado !== 'Completado').length;
  const nMin = LS.minutas(s.id).length;
  box.classList.add('show');
  if (abiertos > 0) {
    box.innerHTML = `<span class="cont-dot"></span>Esta minuta se enlaza con las anteriores de <b>${esc(s.nombre)}</b>: Se considerarán <b>${abiertos}</b> acuerdo(s) abierto(s) para actualizar su estado y no duplicarlos.`;
  } else if (nMin > 0) {
    box.innerHTML = `<span class="cont-dot"></span>Sin acuerdos abiertos por arrastrar de reuniones anteriores de <b>${esc(s.nombre)}</b> (todos cerrados).`;
  } else {
    box.innerHTML = `<span class="cont-dot"></span>Primera minuta de <b>${esc(s.nombre)}</b>: aún no hay acuerdos previos que enlazar. Recuerda <b>Guardar seguimiento</b> para que la próxima los contemple.`;
  }
}

// ---------- Modal genérico (proyecto / serie) ----------

let modalCfg = null;
let modalEmails = [];

function renderChips() {
  $('chipsList').innerHTML = modalEmails.map((c, i) =>
    `<span class="chip${EMAIL_RE.test(c) ? '' : ' invalid'}" data-i="${i}">${esc(c)} <span class="x" data-i="${i}">×</span></span>`
  ).join('');
}

function addEmails(raw) {
  raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).forEach(c => { if (!modalEmails.includes(c)) modalEmails.push(c); });
  renderChips();
}

function abrirModal(cfg) {
  modalCfg = cfg;
  modalEmails = cfg.emails ? [...cfg.emails] : [];
  $('modalTitle').textContent = cfg.title;
  $('modalNombreField').style.display = cfg.showName ? '' : 'none';
  $('modalNombreLabel').textContent = cfg.nameLabel || 'Nombre';
  $('modalNombre').value = cfg.nombre || '';
  $('modalNombre').placeholder = cfg.placeholder || 'Nombre';
  $('chipsField').style.display = cfg.showChips ? '' : 'none';
  $('chipEntry').value = '';
  renderChips();
  $('projectModal').classList.remove('hidden');
  setTimeout(() => (cfg.showName ? $('modalNombre') : $('chipEntry')).focus(), 50);
}

function cerrarModal() { $('projectModal').classList.add('hidden'); }

$('chipEntry').addEventListener('keydown', e => {
  if (['Enter', ',', ';', ' '].includes(e.key)) {
    e.preventDefault();
    if (e.target.value.trim()) { addEmails(e.target.value); e.target.value = ''; }
  } else if (e.key === 'Backspace' && !e.target.value && modalEmails.length) { modalEmails.pop(); renderChips(); }
});
$('chipEntry').addEventListener('blur', e => { if (e.target.value.trim()) { addEmails(e.target.value); e.target.value = ''; } });
$('chipEntry').addEventListener('paste', e => { e.preventDefault(); addEmails((e.clipboardData || window.clipboardData).getData('text')); });
$('chipsInput').addEventListener('click', () => $('chipEntry').focus());
$('chipsList').addEventListener('click', e => { const x = e.target.closest('.x'); if (x) { modalEmails.splice(+x.dataset.i, 1); renderChips(); } });
$('modalCancel').addEventListener('click', cerrarModal);
$('projectModal').addEventListener('click', e => { if (e.target.id === 'projectModal') cerrarModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarModal(); });

$('modalSave').addEventListener('click', () => {
  if (modalCfg.showChips && $('chipEntry').value.trim()) { addEmails($('chipEntry').value); $('chipEntry').value = ''; }
  if (modalCfg.showChips) {
    const invalidos = modalEmails.filter(c => !EMAIL_RE.test(c));
    if (invalidos.length && !confirm(`Hay correos con formato inválido:\n${invalidos.join('\n')}\n\n¿Guardar de todas formas?`)) return;
  }
  const nombre = modalCfg.showName ? $('modalNombre').value.trim() : null;
  if (modalCfg.showName && !nombre) return toast('Escribe el nombre.', 'error');
  modalCfg.onSave(nombre, modalEmails);
  cerrarModal();
});

// Nuevo proyecto (nombre) -> crea también una serie "General"
$('btnNuevoProyecto').addEventListener('click', () => abrirModal({
  title: 'Nuevo proyecto', showName: true, nameLabel: 'Nombre del proyecto', placeholder: 'Ej: Despliegue Bitlocker', showChips: false,
  onSave: (nombre) => {
    const pid = genId(), sid = genId();
    LS.setProjects([...LS.projects(), { id: pid, nombre }]);
    LS.setSeries([...LS.series(), { id: sid, projectId: pid, nombre: 'General', stakeholders: [] }]);
    cargarProyectos(pid); cargarSeries(sid);
    toast('Proyecto creado. Añade tipos de reunión con "+ Tipo".');
  }
}));

// Nueva serie (tipo de reunión): nombre + correos
$('btnNuevaSerie').addEventListener('click', () => {
  const p = proyectoActual();
  if (!p) return toast('Crea o selecciona un proyecto primero.', 'error');
  abrirModal({
    title: `Nuevo tipo de reunión · ${p.nombre}`, showName: true, nameLabel: 'Nombre del tipo de reunión',
    placeholder: 'Ej: Weekly, Comité de gestión OTA...', showChips: true, emails: [],
    onSave: (nombre, emails) => {
      const sid = genId();
      LS.setSeries([...LS.series(), { id: sid, projectId: p.id, nombre, stakeholders: emails }]);
      cargarProyectos(p.id); cargarSeries(sid);
      toast('Tipo de reunión creado.');
    }
  });
});

// Editar serie: nombre + correos
$('btnEditarSerie').addEventListener('click', () => {
  const s = serieActual();
  if (!s) return toast('Crea o selecciona un tipo de reunión primero.', 'error');
  abrirModal({
    title: `Editar · ${s.nombre}`, showName: true, nameLabel: 'Nombre del tipo de reunión',
    nombre: s.nombre, showChips: true, emails: s.stakeholders,
    onSave: (nombre, emails) => {
      const all = LS.series();
      const t = all.find(x => x.id === s.id);
      t.nombre = nombre; t.stakeholders = emails;
      LS.setSeries(all);
      cargarProyectos(s.projectId); cargarSeries(s.id);
      toast('Tipo de reunión actualizado.');
    }
  });
});

// ---------- Generación con Gemini ----------

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fecha_reunion: { type: 'STRING' },
    participantes: { type: 'ARRAY', items: { type: 'STRING' } },
    proxima_reunion: { type: 'STRING', nullable: true },
    acuerdos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', nullable: true },
          item: { type: 'STRING', nullable: true },
          accion: { type: 'STRING' },
          responsable: { type: 'STRING' },
          estado: { type: 'STRING', enum: ESTADOS },
          fecha_comprometida: { type: 'STRING' },
          critico: { type: 'BOOLEAN' },
          fecha_cierre: { type: 'STRING', nullable: true },
        },
        required: ['accion', 'responsable', 'estado', 'fecha_comprometida', 'critico'],
      },
    },
  },
  required: ['fecha_reunion', 'participantes', 'acuerdos'],
};

function buildSystemPrompt(projectName, serieName, hoy, lunesSemana) {
  return `Eres el asistente de la PMO de Antamina para el proyecto "${projectName}" en Antamina, tipo de reunión "${serieName}".

Con base en la transcripción de una reunión de Teams y la lista de acuerdos históricos de este mismo tipo de reunión, genera una minuta accionable de seguimiento para enviar por correo a los participantes e involucrados.

Fecha actual: ${hoy}. La semana actual inicia el lunes ${lunesSemana}.

Instrucciones:
- Identifica la fecha de la reunión, los participantes y la próxima reunión programada, si se mencionan.
- Extrae todos los acuerdos, acciones y compromisos de la transcripción.
- Cruza la transcripción con los ACUERDOS ABIERTOS: si uno se menciona como avanzado, completado, reprogramado u observado, actualiza su estado/fecha conservando su id. Los que no se mencionan se mantienen igual (mismo id, mismo estado).
- Revisa también los ACUERDOS YA CERRADOS ANTERIORMENTE: si en la transcripción se vuelve a plantear una actividad que ya fue cerrada antes, no la dupliques como nueva; menciónalo en el texto de la acción (ej.: "Reabrir / dar continuidad a ... (ya cerrado el [fecha])").
- Los acuerdos nuevos llevan id null.
- Asigna a cada acuerdo un código de "item" jerárquico agrupando por tema (ej.: "1.1", "1.2", "2.1", "2.1.1"). Agrupa por líneas de trabajo (movilización, documentación, procura, operaciones, seguimiento, etc.). MANTÉN el mismo código item de los acuerdos históricos; los nuevos reciben el siguiente código dentro de su grupo.
- Redacta en lenguaje formal, claro y accionable (verbo + entregable + contexto).
- Si una fecha no está indicada, usa "Por definir".
- Estados permitidos: Pendiente, Programado, En curso, Observado, Completado.
- Si un acuerdo se cerró en la reunión, marca Completado y fecha_cierre con la fecha de la reunión.
- critico=true solo en acuerdos que bloquean el avance, tienen riesgo alto o urgencia explícita.
- No inventes acuerdos, responsables ni fechas sin sustento en la transcripción o los históricos.`;
}

async function callGemini(system, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': LS.key() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0.2 },
    }),
  });
  if (!r.ok) {
    if ([400, 401, 403].includes(r.status)) throw new Error('API key inválida o sin permisos. Revisa la configuración (botón ⚙ API key).');
    if (r.status === 503) throw new Error('Gemini está con alta demanda ahora mismo. Espera unos segundos e inténtalo de nuevo.');
    throw new Error(`Error de Gemini (${r.status}). Inténtalo de nuevo.`);
  }
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error(`Gemini no devolvió contenido (${data.candidates?.[0]?.finishReason || 'sin detalle'})`);
  const minuta = JSON.parse(text);
  minuta.proxima_reunion = minuta.proxima_reunion || null;
  minuta.acuerdos = (minuta.acuerdos || []).map(a => ({ ...a, id: a.id || null, item: a.item || '', fecha_cierre: a.fecha_cierre || null }));
  return minuta;
}

$('transcript').addEventListener('input', e => {
  $('transcriptCounter').textContent = `${e.target.value.length.toLocaleString('es-PE')} caracteres`;
});

$('btnGenerar').addEventListener('click', async () => {
  const p = proyectoActual();
  const s = serieActual();
  if (!p || !s) return setStatus('status', 'Selecciona un proyecto y un tipo de reunión (o créalos).', true);
  if (!LS.key()) {
    $('panelConfig').classList.remove('hidden');
    refreshKeyStatus();
    return setStatus('status', 'Configura tu API key de Gemini primero (botón ⚙).', true);
  }
  const transcript = $('transcript').value.trim();
  if (!transcript) return setStatus('status', 'Pega la transcripción primero.', true);

  const hoy = hoyISO();
  const lunesSemana = lunesDeLaSemana(hoy);
  const todos = LS.acuerdos(s.id);
  const abiertos = todos.filter(a => a.estado !== 'Completado');
  const cerrados = todos.filter(a => a.estado === 'Completado').slice(-25);
  const system = buildSystemPrompt(p.nombre, s.nombre, hoy, lunesSemana);
  const userMessage =
`ACUERDOS ABIERTOS DE ESTE TIPO DE REUNIÓN (JSON):
${JSON.stringify(abiertos.map(({ id, item, accion, responsable, estado, fecha_comprometida, critico }) => ({ id, item, accion, responsable, estado, fecha_comprometida, critico })), null, 2)}

ACUERDOS YA CERRADOS ANTERIORMENTE (referencia para no duplicar):
${JSON.stringify(cerrados.map(({ accion, responsable, fecha_cierre }) => ({ accion, responsable, fecha_cierre })), null, 2)}

TRANSCRIPCIÓN DE LA REUNIÓN:
${transcript}`;

  const btn = $('btnGenerar');
  btn.classList.add('loading');
  setStatus('status', 'Generando la minuta...');
  try {
    const minuta = await callGemini(system, userMessage);
    minuta.acuerdos = minuta.acuerdos.filter(a => visibleEnMinuta(a, lunesSemana));
    pintarMinuta(minuta);
    adjuntos = []; renderAdjuntos();
    setStatus('status', '');
    toast(`Minuta generada: ${minuta.acuerdos.length} acuerdo(s).`);
    $('paso2').classList.remove('hidden');
    setStep(2);
    $('paso2').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setStatus('status', e.message, true);
    toast(e.message, 'error');
  } finally {
    btn.classList.remove('loading');
  }
});

function setStatus(id, msg, isError) {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle('error', Boolean(isError));
}

// ---------- Tabla editable ----------

function pintarMinuta(m) {
  $('fechaReunion').value = /^\d{4}-\d{2}-\d{2}$/.test(m.fecha_reunion) ? m.fecha_reunion : '';
  $('participantes').value = (m.participantes || []).join(', ');
  $('proximaReunion').value = m.proxima_reunion || '';
  const tbody = $('tablaAcuerdos').querySelector('tbody');
  tbody.innerHTML = '';
  (m.acuerdos || []).forEach(a => tbody.appendChild(crearFila(a)));
  renumerar();
}

function crearFila(a = {}) {
  const tr = document.createElement('tr');
  tr.dataset.id = a.id || '';
  tr.dataset.fechaCierre = a.fecha_cierre || '';
  tr.dataset.createdAt = a.created_at || '';
  if (a.critico) tr.classList.add('critico');
  tr.innerHTML = `
    <td class="num"><input class="f-item" value="${esc(a.item || '')}" placeholder=""></td>
    <td><textarea class="f-accion">${esc(a.accion || '')}</textarea></td>
    <td><input class="f-responsable" value="${esc(a.responsable || '')}"></td>
    <td><select class="f-estado">${ESTADOS.map(e => `<option ${e === a.estado ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
    <td><input class="f-fecha" value="${esc(a.fecha_comprometida || 'Por definir')}"></td>
    <td class="center"><input type="checkbox" class="f-critico" ${a.critico ? 'checked' : ''}></td>
    <td class="center"><button class="btn-del" title="Eliminar">✕</button></td>`;
  tr.querySelector('.f-critico').addEventListener('change', e => tr.classList.toggle('critico', e.target.checked));
  tr.querySelector('.btn-del').addEventListener('click', () => { tr.remove(); renumerar(); });
  return tr;
}

function renumerar() {
  [...$('tablaAcuerdos').querySelectorAll('tbody tr')].forEach((tr, i) => {
    const it = tr.querySelector('.f-item');
    if (it) it.placeholder = String(i + 1);
  });
}

$('btnAgregarFila').addEventListener('click', () => {
  $('tablaAcuerdos').querySelector('tbody').appendChild(crearFila());
  renumerar();
});

function leerMinuta() {
  const acuerdos = [...$('tablaAcuerdos').querySelectorAll('tbody tr')].map(tr => ({
    id: tr.dataset.id || null,
    item: tr.querySelector('.f-item').value.trim(),
    accion: tr.querySelector('.f-accion').value.trim(),
    responsable: tr.querySelector('.f-responsable').value.trim() || 'Por definir',
    estado: tr.querySelector('.f-estado').value,
    fecha_comprometida: tr.querySelector('.f-fecha').value.trim() || 'Por definir',
    critico: tr.querySelector('.f-critico').checked,
    fecha_cierre: tr.querySelector('.f-estado').value === 'Completado' ? (tr.dataset.fechaCierre || hoyISO()) : null,
    created_at: tr.dataset.createdAt || undefined,
  })).filter(a => a.accion);

  return {
    fecha_reunion: $('fechaReunion').value || hoyISO(),
    participantes: $('participantes').value.split(',').map(s => s.trim()).filter(Boolean),
    proxima_reunion: $('proximaReunion').value.trim() || null,
    acuerdos,
  };
}

// ---------- Guardar seguimiento + archivar minuta ----------

function guardar() {
  const s = serieActual();
  const m = leerMinuta();
  const hoy = hoyISO();

  // 1) Actualizar el seguimiento vivo de la serie
  const existentes = LS.acuerdos(s.id);
  const idsActualizados = new Set();
  const actualizados = m.acuerdos.map(a => {
    const id = a.id || genId();
    if (a.id) idsActualizados.add(a.id);
    return { ...a, id, updated_at: hoy, created_at: a.created_at || hoy };
  });
  const noTocados = existentes.filter(a => !idsActualizados.has(a.id));
  LS.setAcuerdos(s.id, [...noTocados, ...actualizados]);

  // 2) Archivar la minuta (upsert por fecha de reunión)
  const minutas = LS.minutas(s.id);
  const snapshot = {
    id: genId(),
    fecha_reunion: m.fecha_reunion,
    saved_at: hoy,
    participantes: m.participantes,
    proxima_reunion: m.proxima_reunion,
    acuerdos: actualizados.map(({ id, item, accion, responsable, estado, fecha_comprometida, critico, fecha_cierre }) =>
      ({ id, item, accion, responsable, estado, fecha_comprometida, critico, fecha_cierre })),
  };
  const idx = minutas.findIndex(x => x.fecha_reunion === m.fecha_reunion);
  if (idx >= 0) { snapshot.id = minutas[idx].id; minutas[idx] = snapshot; } else { minutas.push(snapshot); }
  LS.setMinutas(s.id, minutas);

  actualizarContinuidad();
  return m;
}

$('btnGuardar').addEventListener('click', () => {
  guardar();
  toast('Seguimiento guardado y minuta archivada en el historial.');
});

// ---------- Render del correo (diseño Antamina · Status Report) ----------

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];

function fechaCorta(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || 'Por definir';
  const [, mo, d] = iso.split('-');
  return `${d}-${MESES[+mo - 1]}`;
}

// Semáforo de días de retraso, al estilo del Status Report de Antamina
function semaforo(a, hoy) {
  if (a.estado === 'Completado') return { color: '#1f9d57', dias: 0 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.fecha_comprometida || '')) return { color: a.critico ? '#d21f3c' : '#e0a400', dias: null };
  const dias = Math.floor((new Date(hoy + 'T12:00:00') - new Date(a.fecha_comprometida + 'T12:00:00')) / 86400000);
  if (dias > 0) return { color: '#d21f3c', dias };
  if (a.critico || a.estado === 'Observado') return { color: '#e0a400', dias: 0 };
  return { color: '#1f9d57', dias: 0 };
}

function estadoStyle(estado) {
  const map = {
    'Completado': 'background:#e3f4ec;color:#1f7a4d',
    'Programado': 'background:#e6f2f4;color:#00727a',
    'En curso': 'background:#e9edf7;color:#2e4a8f',
    'Pendiente': 'background:#eef0f2;color:#5a6875',
    'Observado': 'background:#fdf1dd;color:#9a6100',
  };
  return map[estado] || 'background:#eef0f2;color:#5a6875';
}

function subjectFor(m, projectName, serieName) {
  return `Status Report | ${projectName} · ${serieName} | ${fechaCorta(m.fecha_reunion || hoyISO())}`;
}

function renderMinutaHtml(minuta, projectName, serieName) {
  const hoy = hoyISO();
  const filas = minuta.acuerdos.map((a, i) => {
    const sem = semaforo(a, hoy);
    const item = (a.item && a.item.trim()) || String(i + 1);
    const accion = a.critico ? `<b style="color:#C00000">${esc(a.accion)}</b>` : esc(a.accion);
    const dot = `<span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${sem.color};vertical-align:middle"></span>`;
    const diasTxt = sem.dias === null ? '' : `&nbsp;<span style="color:${sem.color};font-weight:bold">${sem.dias}</span>`;
    return `<tr>
      <td style="border:1px solid #D8DEE3;padding:7px 9px;text-align:center;font-weight:bold;color:#00565c;white-space:nowrap">${esc(item)}</td>
      <td style="border:1px solid #D8DEE3;padding:7px 9px;color:#2b3640">${accion}</td>
      <td style="border:1px solid #D8DEE3;padding:7px 9px;color:#2b3640;white-space:nowrap">${esc(a.responsable)}</td>
      <td style="border:1px solid #D8DEE3;padding:7px 9px;text-align:center;white-space:nowrap"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:9pt;font-weight:bold;${estadoStyle(a.estado)}">${esc(a.estado)}</span></td>
      <td style="border:1px solid #D8DEE3;padding:7px 9px;text-align:center;color:#2b3640;white-space:nowrap">${esc(fechaCorta(a.fecha_comprometida))}</td>
      <td style="border:1px solid #D8DEE3;padding:7px 9px;text-align:center;white-space:nowrap">${dot}${diasTxt}</td>
    </tr>`;
  }).join('\n');

  const participantes = (minuta.participantes || []).length
    ? `<p style="margin:3px 0;color:#4a5661;font-size:10.5pt;"><b style="color:#00565c">Participantes:</b> ${esc(minuta.participantes.join(', '))}</p>` : '';
  const proxima = minuta.proxima_reunion
    ? `<p style="margin:3px 0;color:#4a5661;font-size:10.5pt;"><b style="color:#00565c">Próxima reunión programada:</b> ${esc(minuta.proxima_reunion)}</p>` : '';
  const firma = (LS.firma() || '').trim();
  const firmaHtml = firma ? esc(firma).replace(/\n/g, '<br>') : '';

  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#2b3640;max-width:920px;">
  <table role="presentation" width="100%" style="border-collapse:collapse;background:linear-gradient(90deg,#00565c,#009ca6);border-radius:8px 8px 0 0;">
    <tr><td style="padding:16px 20px;">
      <div style="font-size:9pt;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#bfeef0;">Status Report · Seguimiento de acuerdos</div>
      <div style="font-size:16pt;font-weight:bold;color:#ffffff;margin-top:2px;">${esc(projectName)}</div>
      <div style="font-size:10.5pt;color:#d9f4f5;margin-top:1px;">${esc(serieName)} &nbsp;·&nbsp; ${esc(fechaLarga(minuta.fecha_reunion))}</div>
    </td></tr>
  </table>
  <div style="border:1px solid #D8DEE3;border-top:none;border-radius:0 0 8px 8px;padding:16px 20px;">
    <p style="margin:0 0 8px 0;">Estimados, buenas tardes:</p>
    <p style="margin:0 0 10px 0;">Como parte del seguimiento a los acuerdos del proyecto <b>${esc(projectName)}</b> (${esc(serieName)}), comparto el detalle actualizado de acuerdos, responsables y compromisos.</p>
    ${participantes}
    ${proxima}
    <p style="margin:14px 0 6px 0;font-weight:bold;color:#00565c;">Detalle de seguimiento:</p>
    <table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:10.5pt;width:100%;">
      <tr style="background-color:#00565c;color:#FFFFFF;">
        <th style="border:1px solid #00565c;padding:8px 9px;text-align:center;">Ítem</th>
        <th style="border:1px solid #00565c;padding:8px 9px;text-align:left;">Acuerdo / Compromiso</th>
        <th style="border:1px solid #00565c;padding:8px 9px;text-align:left;">Responsable</th>
        <th style="border:1px solid #00565c;padding:8px 9px;text-align:center;">Estado</th>
        <th style="border:1px solid #00565c;padding:8px 9px;text-align:center;">Fecha comprometida</th>
        <th style="border:1px solid #00565c;padding:8px 9px;text-align:center;">Días de retraso</th>
      </tr>
      ${filas}
    </table>
    <p style="margin:8px 0 0 0;font-size:9pt;color:#6b7a85;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1f9d57;vertical-align:middle"></span> A tiempo &nbsp;&nbsp; <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#e0a400;vertical-align:middle"></span> Alerta &nbsp;&nbsp; <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#d21f3c;vertical-align:middle"></span> Retrasado (días)</p>
    <p style="margin-top:16px;">Agradeceré su apoyo con la atención de las acciones pendientes, programadas y retrasadas según las fechas comprometidas.</p>
    <p style="margin:8px 0 0 0;">Quedo atento a cualquier comentario o actualización.</p>
    <p style="margin:14px 0 2px 0;">Un saludo,</p>
    ${firmaHtml ? `<p style="margin:0;color:#00565c;font-weight:bold;">${firmaHtml}</p>` : ''}
  </div>
</div>`;
}

$('btnPreview').addEventListener('click', () => {
  const p = proyectoActual(), s = serieActual();
  const m = leerMinuta();
  if (!m.acuerdos.length) return toast('No hay acuerdos para incluir en la minuta.', 'error');
  $('previewRecipients').innerHTML = s.stakeholders.length
    ? s.stakeholders.map(c => chipHtml(c, !EMAIL_RE.test(c))).join('')
    : '<span class="none">Sin destinatarios — configúralos con ✎ Editar</span>';
  $('previewSubject').textContent = subjectFor(m, p.nombre, s.nombre);
  $('previewFrame').srcdoc = renderMinutaHtml(m, p.nombre, s.nombre);
  $('paso3').classList.remove('hidden');
  setStep(3);
  $('paso3').scrollIntoView({ behavior: 'smooth' });
});

// ---------- Envío ----------

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function htmlToText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.innerText.replace(/\n{3,}/g, '\n\n').trim();
}

function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Copia la minuta conservando el formato (varios métodos, del más fiable al de respaldo)
async function copiarMinuta(html) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([htmlToText(html)], { type: 'text/plain' }),
    })]);
    return true;
  } catch { /* sigue */ }
  try {
    const h = document.createElement('div');
    h.contentEditable = 'true';
    h.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:normal;';
    h.innerHTML = html;
    document.body.appendChild(h);
    const r = document.createRange(); r.selectNodeContents(h);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const ok = document.execCommand('copy');
    sel.removeAllRanges(); h.remove();
    if (ok) return true;
  } catch { /* sigue */ }
  try { await navigator.clipboard.writeText(htmlToText(html)); return true; } catch { return false; }
}

// ---------- Adjuntos ----------

function renderAdjuntos() {
  $('adjuntosList').innerHTML = adjuntos.map((a, i) =>
    `<span class="chip" data-i="${i}">📎 ${esc(a.name)} <span class="x" data-i="${i}">×</span></span>`
  ).join('');
}

$('btnAddAdjunto').addEventListener('click', () => $('adjuntoFile').click());
$('adjuntoFile').addEventListener('change', async e => {
  for (const file of [...e.target.files]) {
    if (file.size > 12 * 1024 * 1024) { toast(`"${file.name}" supera 12 MB y se omitió.`, 'error'); continue; }
    const buf = await file.arrayBuffer();
    adjuntos.push({ name: file.name, type: file.type || 'application/octet-stream', b64: abToB64(buf) });
  }
  renderAdjuntos();
  e.target.value = '';
});
$('adjuntosList').addEventListener('click', e => {
  const x = e.target.closest('.x');
  if (x) { adjuntos.splice(+x.dataset.i, 1); renderAdjuntos(); }
});

// Construye el .eml (multipart si hay adjuntos)
function buildEml(to, subject, html) {
  const headers = [`To: ${to}`, `Subject: =?utf-8?B?${b64utf8(subject)}?=`, 'X-Unsent: 1', 'MIME-Version: 1.0'];
  const body = `<html><body>${html}</body></html>`;
  const htmlPart = b64utf8(body).replace(/(.{76})/g, '$1\r\n');
  if (!adjuntos.length) {
    return [...headers, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', htmlPart].join('\r\n');
  }
  const boundary = 'scribe_' + genId();
  const parts = [
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', htmlPart,
  ];
  adjuntos.forEach(a => {
    parts.push(`--${boundary}`,
      `Content-Type: ${a.type}; name="${a.name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.name}"`,
      '', a.b64.replace(/(.{76})/g, '$1\r\n'));
  });
  parts.push(`--${boundary}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}

$('btnEml').addEventListener('click', () => {
  const p = proyectoActual(), s = serieActual();
  if (!s.stakeholders.length && !confirm('Este tipo de reunión no tiene correos configurados. ¿Descargar el .eml sin destinatarios?')) return;
  const m = guardar();
  const html = renderMinutaHtml(m, p.nombre, s.nombre);
  const eml = buildEml(s.stakeholders.join('; '), subjectFor(m, p.nombre, s.nombre), html);
  const [y, mo, d] = m.fecha_reunion.split('-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }));
  a.download = `Minuta ${p.nombre} ${s.nombre} ${d}-${mo}-${y}.eml`;
  a.click();
  URL.revokeObjectURL(a.href);
  const conAdj = adjuntos.length ? ` con ${adjuntos.length} adjunto(s)` : '';
  setStatus('status3', `Seguimiento guardado y .eml${conAdj} descargado. Ábrelo con Outlook: saldrá como borrador listo para enviar.`);
  toast('.eml descargado.');
});

$('btnOutlookWeb').addEventListener('click', async () => {
  const p = proyectoActual(), s = serieActual();
  const m = guardar();
  const html = renderMinutaHtml(m, p.nombre, s.nombre);
  const subject = subjectFor(m, p.nombre, s.nombre);
  const copiado = await copiarMinuta(html);
  const url = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(s.stakeholders.join(';'))}&subject=${encodeURIComponent(subject)}`;
  window.open(url, '_blank', 'noopener');
  let msg = copiado
    ? 'Minuta copiada con formato. En Outlook web, clic en el cuerpo del correo y pega con Ctrl+V.'
    : 'Se abrió Outlook web con destinatarios y asunto. Usa "Descargar .eml" si necesitas el cuerpo con formato.';
  if (adjuntos.length) msg += ` Recuerda adjuntar a mano en Outlook web: ${adjuntos.map(a => a.name).join(', ')}.`;
  setStatus('status3', msg);
  toast(copiado ? 'Minuta copiada — pega con Ctrl+V en Outlook web.' : 'Outlook web abierto.');
});

// ---------- Historial y búsqueda ----------

$('btnHistorial').addEventListener('click', () => {
  const panel = $('panelHistorial');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) { renderHistorial(); panel.scrollIntoView({ behavior: 'smooth' }); }
});

function estadoBadge(a) {
  if (a.critico) return '<span class="hi-estado critico">Crítico</span>';
  if (a.estado === 'Completado') return '<span class="hi-estado completado">Completado</span>';
  return `<span class="hi-estado">${esc(a.estado)}</span>`;
}

function highlight(txt, q) {
  const i = txt.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(txt);
  return esc(txt.slice(0, i)) + '<mark>' + esc(txt.slice(i, i + q.length)) + '</mark>' + esc(txt.slice(i + q.length));
}

function buscar(q) {
  const res = [];
  const projById = Object.fromEntries(LS.projects().map(p => [p.id, p.nombre]));
  LS.series().forEach(s => {
    LS.minutas(s.id).forEach(min => {
      (min.acuerdos || []).forEach(a => {
        const hay = (a.accion + ' ' + a.responsable).toLowerCase().includes(q.toLowerCase());
        if (hay) res.push({ proyecto: projById[s.projectId] || '—', serie: s.nombre, fecha: min.fecha_reunion, a });
      });
    });
  });
  res.sort((x, y) => (y.fecha || '').localeCompare(x.fecha || ''));
  return res.slice(0, 60);
}

$('histSearch').addEventListener('input', e => {
  const q = e.target.value.trim();
  const box = $('histResults');
  if (q.length < 2) { box.innerHTML = ''; return; }
  const res = buscar(q);
  if (!res.length) { box.innerHTML = '<div class="hist-empty">Sin coincidencias en las minutas archivadas.</div>'; return; }
  box.innerHTML = res.map(r => `
    <div class="hist-item">
      <div class="hi-top">
        <span class="hi-badge">${esc(r.proyecto)} · ${esc(r.serie)}</span>
        ${estadoBadge(r.a)}
        <span class="hi-fecha">${esc(r.fecha)}</span>
      </div>
      <div class="hi-accion">${highlight(r.a.accion, q)}</div>
      <div class="hi-meta">Responsable: ${esc(r.a.responsable)} · Fecha comprometida: ${esc(r.a.fecha_comprometida || 'Por definir')}${r.a.fecha_cierre ? ' · Cerrado: ' + esc(r.a.fecha_cierre) : ''}</div>
    </div>`).join('');
});

let histScope = 'serie'; // 'serie' | 'proyecto'

function filaMinuta(m, sid, conSerie) {
  const abiertos = (m.acuerdos || []).filter(a => a.estado !== 'Completado').length;
  const serieTag = conSerie ? `<span class="mr-info">${(m.acuerdos || []).length} acuerdo(s) · ${abiertos} abierto(s)</span>` : `<span class="mr-info">${(m.acuerdos || []).length} acuerdo(s) · ${abiertos} abierto(s)</span>`;
  return `<div class="minuta-row" data-id="${m.id}" data-sid="${sid}">
    <span class="mr-fecha">${esc(fechaLarga(m.fecha_reunion))}</span>
    ${serieTag}
    <span class="mr-actions">
      <button class="link" data-act="ver" data-id="${m.id}" data-sid="${sid}">Ver minuta</button>
      <button class="link danger" data-act="del" data-id="${m.id}" data-sid="${sid}">Eliminar</button>
    </span>
  </div>`;
}

function renderHistorial() {
  const p = proyectoActual();
  const s = serieActual();
  const box = $('serieMinutas');
  $('histPreview').classList.add('hidden');
  if (!p) { $('serieMinutasLabel').textContent = 'Minutas archivadas'; box.innerHTML = '<div class="hist-empty">Selecciona un proyecto.</div>'; return; }

  if (histScope === 'proyecto') {
    $('serieMinutasLabel').textContent = `Minutas archivadas · Proyecto ${p.nombre}`;
    const grupos = seriesDeProyecto(p.id).map(se => {
      const minutas = LS.minutas(se.id).slice().sort((a, b) => (b.fecha_reunion || '').localeCompare(a.fecha_reunion || ''));
      if (!minutas.length) return '';
      return `<div class="hist-group"><div class="hg-head">${esc(se.nombre)} <span class="hg-count">${minutas.length} minuta(s)</span></div>${minutas.map(m => filaMinuta(m, se.id, true)).join('')}</div>`;
    }).filter(Boolean).join('');
    box.innerHTML = grupos || '<div class="hist-empty">Aún no hay minutas archivadas en este proyecto. Se archivan al guardar o descargar el correo.</div>';
    return;
  }

  $('serieMinutasLabel').textContent = s ? `Minutas archivadas · ${s.nombre}` : 'Minutas archivadas';
  if (!s) { box.innerHTML = '<div class="hist-empty">Selecciona un tipo de reunión.</div>'; return; }
  const minutas = LS.minutas(s.id).slice().sort((a, b) => (b.fecha_reunion || '').localeCompare(a.fecha_reunion || ''));
  if (!minutas.length) { box.innerHTML = '<div class="hist-empty">Aún no hay minutas archivadas de este tipo de reunión. Se archivan al guardar o descargar el correo.</div>'; return; }
  box.innerHTML = minutas.map(m => filaMinuta(m, s.id, false)).join('');
}

document.querySelectorAll('#scopeSerie, #scopeProyecto').forEach(b => b.addEventListener('click', () => {
  histScope = b.dataset.scope;
  $('scopeSerie').classList.toggle('scope-on', histScope === 'serie');
  $('scopeProyecto').classList.toggle('scope-on', histScope === 'proyecto');
  renderHistorial();
}));

$('serieMinutas').addEventListener('click', e => {
  const btn = e.target.closest('.link');
  if (!btn) return;
  const p = proyectoActual();
  const se = series.find(x => x.id === btn.dataset.sid);
  if (!se) return;
  const minutas = LS.minutas(se.id);
  const m = minutas.find(x => x.id === btn.dataset.id);
  if (!m) return;
  if (btn.dataset.act === 'ver') {
    const frame = $('histPreview');
    frame.srcdoc = renderMinutaHtml(m, p.nombre, se.nombre);
    frame.classList.remove('hidden');
    frame.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if (btn.dataset.act === 'del') {
    if (!confirm('¿Eliminar esta minuta del archivo? (no afecta el seguimiento de acuerdos)')) return;
    LS.setMinutas(se.id, minutas.filter(x => x.id !== m.id));
    renderHistorial();
    toast('Minuta eliminada del archivo.');
  }
});

// ---------- Respaldo exportar / importar ----------

$('btnExport').addEventListener('click', () => {
  const data = { app: 'scribe', version: 2, exported_at: new Date().toISOString(), firma: LS.firma(), projects: LS.projects(), series: LS.series(), acuerdos: {}, minutas: {} };
  LS.series().forEach(s => { data.acuerdos[s.id] = LS.acuerdos(s.id); data.minutas[s.id] = LS.minutas(s.id); });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `Minutas PMO Antamina respaldo ${hoyISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Respaldo descargado.');
});

$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'scribe' || !Array.isArray(data.projects)) throw new Error('Archivo no válido');
      if (!confirm('Esto reemplazará TODOS los proyectos, tipos de reunión, acuerdos y minutas de este navegador por los del respaldo. ¿Continuar?')) return;
      // Limpiar datos scribe actuales (menos la API key)
      Object.keys(localStorage).filter(k => k.startsWith('scribe_') && k !== 'scribe_gemini_key').forEach(k => localStorage.removeItem(k));
      LS.setProjects(data.projects);
      LS.setSeries(data.series || []);
      Object.entries(data.acuerdos || {}).forEach(([sid, a]) => LS.setAcuerdos(sid, a));
      Object.entries(data.minutas || {}).forEach(([sid, m]) => LS.setMinutas(sid, m));
      if (typeof data.firma === 'string') LS.setFirma(data.firma);
      localStorage.setItem('scribe_schema', '2');
      cargarProyectos();
      toast('Respaldo importado correctamente.');
    } catch (err) {
      toast('No se pudo importar: ' + err.message, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

// ---------- Init ----------

migrar();
seedInicial();
cargarProyectos();
setStep(1);
if (!LS.key()) { $('panelConfig').classList.remove('hidden'); refreshKeyStatus(); }
