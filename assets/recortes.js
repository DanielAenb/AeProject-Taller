/* ============================================================
   RECORTES · Lógica Completa (v5)
   - WebCodecs + Mediabunny (streaming a disco)
   - ZIP con fflate cuando hay >1 clip y no está "individual"
   - Reanudación tras cancelar (solo procesa pendientes)
   - Nombres editables + patrón global "Clip A (#)"
   - Edición de clips guardados
   - Exportación JSON de respaldo
   - Reanudar sesión por carpeta (auto-match)
   ============================================================ */

const LS_SESSION    = "recortes-session-v1";
const LS_EXPORT_SET = "recortes-export-settings-v1";

const state = {
  files: [],
  currentIndex: 0,
  markIn: 0,
  markOut: 0,
  audio: true,
  clips: [],
  screen: "empty",
  exporting: false,
  editingClipId: null,
  exportSettings: {
    baseName: "",
    saveIndividually: false,
  },
};

/* ============================================================
   HELPERS
   ============================================================ */
function newId() {
  return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

function fmtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtTimeMs(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function stripExt(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

function sanitizeFilename(name) {
  return stripExt(name).replace(/[^\w\-]+/g, "_").slice(0, 80);
}

/* Nombre visible de un clip (sin extensión) */
function clipDisplayName(clip, index) {
  const custom = (clip.customName || "").trim();
  if (custom) return custom;
  return stripExt(clip.fileName) || `Clip ${index + 1}`;
}

/* Nombre final con extensión */
function clipExportFilename(clip, index) {
  let rawName = (clip.customName || "").trim();
  
  // Si no hay nombre personalizado, usamos el original del archivo + el índice
  if (!rawName) {
    rawName = stripExt(clip.fileName) + " " + (index + 1);
  }
  
  // Aseguramos de que si el usuario puso ".mp4" en el input, se limpie
  rawName = stripExt(rawName);
  
  return sanitizeFilename(rawName) + ".mp4";
}

function toast(title, desc = "", variant = "brand") {
  const icons = {
    brand:   '<svg class="icon toast-icon" viewBox="0 0 24 24"><path d="M12 2v6l4 2"/><path d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0z"/></svg>',
    success: '<svg class="icon toast-icon" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    danger:  '<svg class="icon toast-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    info:    '<svg class="icon toast-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  };
  const el = document.createElement("div");
  el.className = `toast ${variant}`;
  el.innerHTML = `
    ${icons[variant] || icons.info}
    <div style="flex:1">
      <div class="toast-title">${escapeHTML(title)}</div>
      ${desc ? `<div class="toast-desc">${escapeHTML(desc)}</div>` : ""}
    </div>
    <button class="toast-close" aria-label="Cerrar">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  el.querySelector(".toast-close").addEventListener("click", () => el.remove());
  $("#toastHost").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/* ============================================================
   PERSISTENCIA
   ============================================================ */
function saveSession() {
  if (state.clips.length === 0) {
    localStorage.removeItem(LS_SESSION);
    return;
  }
  const payload = {
    updatedAt: new Date().toISOString(),
    clips: state.clips.map(c => ({
      id: c.id, fileId: c.fileId, fileName: c.fileName, fileSize: c.fileSize,
      name: c.name, start: c.start, end: c.end, audio: c.audio, duration: c.duration,
      customName: c.customName || "",
      exported: !!c.exported,
      exportedFilename: c.exportedFilename || "",
      exportError: c.exportError || "",
    })),
    files: state.files.map(f => ({ id: f.id, name: f.name, size: f.size })),
  };
  try { localStorage.setItem(LS_SESSION, JSON.stringify(payload)); } catch (e) {}
}

function loadSessionMeta() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearSession() { localStorage.removeItem(LS_SESSION); }

function saveExportSettings() {
  try { localStorage.setItem(LS_EXPORT_SET, JSON.stringify(state.exportSettings)); } catch {}
}

function loadExportSettings() {
  try {
    const raw = localStorage.getItem(LS_EXPORT_SET);
    if (raw) state.exportSettings = { ...state.exportSettings, ...JSON.parse(raw) };
  } catch {}
}

/* ============================================================
   COMPATIBILIDAD
   ============================================================ */
function webCodecsSupported() {
  return typeof VideoEncoder !== "undefined" &&
         typeof VideoDecoder !== "undefined" &&
         typeof VideoFrame !== "undefined";
}

/* ============================================================
   CARGA DINÁMICA DE MEDIABUNNY Y FFLATE
   ============================================================ */
let mediabunnyPromise = null;
async function ensureMediabunny() {
  if (window.Mediabunny && window.Mediabunny.Input) return window.Mediabunny;
  if (mediabunnyPromise) return mediabunnyPromise;
  mediabunnyPromise = (async () => {
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/mediabunny@latest/+esm");
      if (!mod || !mod.Input) throw new Error("El módulo no expone Input.");
      window.Mediabunny = mod;
      return mod;
    } catch (e) {
      mediabunnyPromise = null;
      console.error("Mediabunny load failed:", e);
      throw new Error("No se pudo cargar Mediabunny. Revisá tu conexión.");
    }
  })();
  return mediabunnyPromise;
}

let fflatePromise = null;
async function ensureFflate() {
  if (window.fflate) return window.fflate;
  if (fflatePromise) return fflatePromise;
  fflatePromise = (async () => {
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm");
      window.fflate = mod;
      return mod;
    } catch (e) {
      fflatePromise = null;
      throw new Error("No se pudo cargar fflate.");
    }
  })();
  return fflatePromise;
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
function showScreen(name) {
  if (name !== "editor") state.editingClipId = null;
  state.screen = name;
  $("#scrEmpty").hidden  = name !== "empty";
  $("#scrEditor").hidden = name !== "editor";
  $("#scrExport").hidden = name !== "export";
  $("#scrDone").hidden   = name !== "done";
}

/* ============================================================
   EDITOR
   ============================================================ */
function openEditorCurrent() {
  const f = state.files[state.currentIndex];
  if (!f) {
    if (state.clips.length > 0) showExport();
    else showScreen("empty");
    return;
  }

  const isEditing = !!state.editingClipId;

  showScreen("editor");
  if (isEditing) state.editingClipId = state.editingClipId; // mantener

  $("#etCounter").textContent = `Video ${state.currentIndex + 1} de ${state.files.length}`;
  $("#etFilename").textContent = f.name;

  // Badge "editando"
  const info = $(".editor-top .et-info");
  let badge = info.querySelector(".et-editing-badge");
  if (isEditing) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "et-editing-badge";
      badge.innerHTML = `Editando clip · <button id="btnCancelEdit">Cancelar</button>`;
      info.appendChild(badge);
      badge.querySelector("#btnCancelEdit").addEventListener("click", () => {
        state.editingClipId = null;
        openEditorCurrent();
      });
    }
  } else if (badge) {
    badge.remove();
  }

  const video = $("#video");
  video.src = f.url;
  video.currentTime = 0;
  video.muted = !state.audio;

  if (!isEditing) {
    state.markIn = 0;
    state.markOut = f.duration || 0;
  }
  // Si estamos editando, editClip() ya seteó markIn/markOut

  updateTimeline();
  updateMarksInfo();
  renderClipsList();
  updateAudioUI();

  video.onloadedmetadata = () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      f.duration = video.duration;
      if (!isEditing) state.markOut = video.duration;
    }
    updateTimeline();
    updateMarksInfo();
  };
}

function updateTimeline() {
  const f = state.files[state.currentIndex];
  if (!f) return;
  const dur = f.duration || 1;
  const pctIn = (state.markIn / dur) * 100;
  const pctOut = (state.markOut / dur) * 100;
  $("#tlRange").style.left = pctIn + "%";
  $("#tlRange").style.width = (pctOut - pctIn) + "%";
  $("#tlStart").style.left = pctIn + "%";
  $("#tlEnd").style.left = pctOut + "%";
}

function updatePlayhead() {
  const f = state.files[state.currentIndex];
  if (!f) return;
  const v = $("#video");
  const dur = f.duration || 1;
  const pct = (v.currentTime / dur) * 100;
  $("#tlPlayhead").style.left = pct + "%";
  $("#vsTime").textContent = fmtTimeMs(v.currentTime);
  $("#tpTime").textContent = fmtTime(v.currentTime);
}

function updateMarksInfo() {
  $("#badgeInTime").textContent = fmtTimeMs(state.markIn);
  $("#badgeOutTime").textContent = fmtTimeMs(state.markOut);
  $("#miStart").textContent = fmtTimeMs(state.markIn);
  $("#miEnd").textContent = fmtTimeMs(state.markOut);
  $("#miDur").textContent = fmtTimeMs(state.markOut - state.markIn);
}

function bindTimelineDrag() {
  const track = $("#tlTrack");
  const handleStart = $("#tlStart");
  const handleEnd = $("#tlEnd");

  function clientXToPct(clientX) {
    const rect = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    return x / rect.width;
  }

  function startDrag(which) {
    return (e) => {
      e.preventDefault();
      const el = which === "start" ? handleStart : handleEnd;
      el.classList.add("dragging");
      const f = state.files[state.currentIndex];
      if (!f) return;
      const dur = f.duration;

      const move = (ev) => {
        const pct = clientXToPct(ev.clientX);
        const t = pct * dur;
        if (which === "start") state.markIn = Math.min(t, state.markOut - 0.1);
        else state.markOut = Math.max(t, state.markIn + 0.1);
        updateTimeline();
        updateMarksInfo();
      };

      const up = () => {
        el.classList.remove("dragging");
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
  }

  handleStart.addEventListener("pointerdown", startDrag("start"));
  handleEnd.addEventListener("pointerdown", startDrag("end"));
}

function updateAudioUI() {
  const btn = $("#btnAudio");
  const label = $("#audioLabel");
  const on = $("#iconAudioOn");
  const off = $("#iconAudioOff");
  btn.setAttribute("aria-pressed", state.audio ? "true" : "false");
  label.textContent = state.audio ? "Audio" : "Mudo";
  on.hidden = !state.audio;
  off.hidden = state.audio;
  const v = $("#video");
  if (v) v.muted = !state.audio;
}

/* ============================================================
   CLIPS · lista + edición
   ============================================================ */
function renderClipsList() {
  const list = $("#clipsList");
  const count = $("#clipsCount");
  count.textContent = state.clips.length;

  if (state.clips.length === 0) {
    list.innerHTML = `<div class="clips-empty">Aún no has guardado clips.<br>Marca el inicio y el fin, y pulsa "Guardar y siguiente".</div>`;
    $("#btnGoExport").disabled = true;
    return;
  }

  $("#btnGoExport").disabled = false;
  list.innerHTML = state.clips.map((c, i) => `
    <div class="clip-card ${state.editingClipId === c.id ? "active" : ""}" data-clip="${c.id}">
      <span class="cc-edit-badge">editar</span>
      <div class="cc-title">${escapeHTML(c.customName || c.fileName)}</div>
      <div class="cc-meta">
        <span>${fmtTimeMs(c.start)} → ${fmtTimeMs(c.end)}</span>
        <span>${(c.end - c.start).toFixed(1)}s</span>
        ${c.audio ? "" : '<span>sin audio</span>'}
        ${c.exported ? '<span style="color:var(--success)">✓ exportado</span>' : ""}
      </div>
      <button class="cc-remove" data-remove="${c.id}" aria-label="Eliminar">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join("");

  $$("[data-clip]").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove]")) return;
      editClip(card.dataset.clip);
    });
  });
  $$("[data-remove]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    state.clips = state.clips.filter(x => x.id !== b.dataset.remove);
    if (state.editingClipId === b.dataset.remove) state.editingClipId = null;
    saveSession();
    renderClipsList();
  }));
}

/* Abrir clip existente en el editor */
function editClip(clipId) {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  const fileIdx = state.files.findIndex(f => f.id === clip.fileId);
  if (fileIdx < 0) {
    toast("Archivo no disponible", "Cargá de nuevo el video original para editar.", "danger");
    return;
  }

  state.editingClipId = clipId;
  state.currentIndex = fileIdx;
  state.markIn = clip.start;
  state.markOut = clip.end;
  state.audio = clip.audio;

  openEditorCurrent();
  updateTimeline();
  updateMarksInfo();
  updateAudioUI();
}

function saveCurrentClip() {
  const f = state.files[state.currentIndex];
  if (!f) return null;

  if (state.markOut - state.markIn < 0.1) {
    toast("Clip muy corto", "El rango es demasiado pequeño.", "danger");
    return null;
  }

  /* --------- Modo edición: actualizar el clip existente --------- */
  if (state.editingClipId) {
    const existing = state.clips.find(c => c.id === state.editingClipId);
    if (existing) {
      existing.start = state.markIn;
      existing.end = state.markOut;
      existing.audio = state.audio;
      existing.duration = state.markOut - state.markIn;
      existing.exported = false;         // forzar re-export
      existing.exportedFilename = "";
      existing.exportError = "";
      saveSession();
      toast("Clip actualizado", (existing.end - existing.start).toFixed(1) + "s", "success");
      const out = existing;
      state.editingClipId = null;
      return out;
    }
  }

  /* --------- Modo normal: crear nuevo clip --------- */
  const clip = {
    id: newId(), fileId: f.id, fileName: f.name, fileSize: f.size,
    name: f.name, start: state.markIn, end: state.markOut,
    audio: state.audio, duration: state.markOut - state.markIn,
    customName: "",
    exported: false,
    exportedFilename: "",
    exportError: "",
  };

  state.clips.push(clip);
  saveSession();
  toast("Clip guardado", (clip.end - clip.start).toFixed(1) + "s", "success");
  return clip;
}

function saveAndNext() {
  const wasEditing = !!state.editingClipId;
  const clip = saveCurrentClip();
  if (!clip) return;
  if (wasEditing) { showExport(); return; }
  state.currentIndex++;
  if (state.currentIndex >= state.files.length) showExport();
  else openEditorCurrent();
}

function addAnotherClip() {
  const wasEditing = !!state.editingClipId;
  const clip = saveCurrentClip();
  if (!clip) return;
  if (wasEditing) return; // si estaba editando, salir del modo edición
  const f = state.files[state.currentIndex];
  state.markIn = 0;
  state.markOut = f.duration;
  $("#video").currentTime = 0;
  updateTimeline();
  updateMarksInfo();
  renderClipsList();
  toast("Marcas reseteadas", "Marca el nuevo clip.", "info");
}

function skipVideo() {
  state.currentIndex++;
  if (state.currentIndex >= state.files.length) {
    if (state.clips.length > 0) showExport();
    else showScreen("empty");
  } else openEditorCurrent();
}

/* ============================================================
   EXPORT · pantalla
   ============================================================ */
function showExport() {
  showScreen("export");
  $("#exBaseName").value = state.exportSettings.baseName || "";
  $("#exSaveIndividually").checked = !!state.exportSettings.saveIndividually;
  renderExportList();
  updateExportSummary();
  $("#exportProgress").hidden = true;

  if (!webCodecsSupported()) {
    toast("WebCodecs no disponible", "Tu navegador no soporta exportación.", "danger");
    $("#btnDoExport").disabled = true;
    return;
  }

  ensureMediabunny().catch(() => {});
  ensureFflate().catch(() => {});
}

function updateExportSummary() {
  const total = state.clips.reduce((a, c) => a + c.duration, 0);
  const pending = state.clips.filter(c => !c.exported).length;
  const done = state.clips.length - pending;
  $("#exSummary").textContent =
    `${state.clips.length} clip${state.clips.length === 1 ? "" : "s"} · ${total.toFixed(1)}s en total · ` +
    `${pending} pendiente${pending === 1 ? "" : "s"}${done > 0 ? ` · ${done} exportado${done === 1 ? "" : "s"}` : ""}`;

  const btn = $("#btnDoExport");
  btn.disabled = pending === 0;
  btn.innerHTML = pending === 0
    ? `<svg class="icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Todo exportado`
    : `<svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg> Exportar ${pending} clip${pending === 1 ? "" : "s"}`;
}

function renderExportList() {
  const list = $("#exportList");
  if (state.clips.length === 0) {
    list.innerHTML = `<div class="empty-msg">No hay clips para exportar.</div>`;
    return;
  }
  list.innerHTML = state.clips.map((c, i) => {
    const status = c.exported ? "✓ listo" : (c.exportError ? "error" : "pendiente");
    const state_ = c.exported ? "exported" : (c.exportError ? "error" : "pending");
    return `
      <div class="ex-row" data-clip-id="${c.id}" data-state="${state_}">
        <span class="er-num">${i + 1}</span>
        <div class="er-body">
          <input class="er-name-input"
                 data-name-input="${c.id}"
                 value="${escapeHTML(c.customName || stripExt(c.fileName))}"
                 placeholder="Nombre del clip" />
          <div class="er-meta">
            ${fmtTime(c.start)} → ${fmtTime(c.end)} · ${c.duration.toFixed(1)}s ${c.audio ? "" : "· sin audio"}
            ${c.exportedFilename ? ` · <span style="color:var(--success)">${escapeHTML(c.exportedFilename)}</span>` : ""}
          </div>
        </div>
        <span class="er-status" data-clip-status="${c.id}">${status}</span>
        ${c.exported ? `
          <button class="btn btn-ghost btn-sm" data-reopen="${c.id}" title="Marcar como pendiente">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
          </button>
        ` : ""}
      </div>
    `;
  }).join("");

  $$("[data-name-input]").forEach(inp => {
    inp.addEventListener("input", () => {
      const c = state.clips.find(x => x.id === inp.dataset.nameInput);
      if (!c) return;
      c.customName = inp.value;
      saveSession();
    });
  });

  $$("[data-reopen]").forEach(b => b.addEventListener("click", () => {
    const c = state.clips.find(x => x.id === b.dataset.reopen);
    if (!c) return;
    c.exported = false;
    c.exportedFilename = "";
    c.exportError = "";
    saveSession();
    renderExportList();
    updateExportSummary();
    toast("Marcado como pendiente", c.customName || c.fileName, "info");
  }));
}

function setClipStatus(clipId, state_, label) {
  const el = document.querySelector(`[data-clip-id="${clipId}"]`);
  if (!el) return;
  el.dataset.state = state_;
  const s = el.querySelector(`[data-clip-status="${clipId}"]`);
  if (s) s.textContent = label;
}

/* ============================================================
   PROCESO · Mediabunny
   ============================================================ */
async function processClipMediabunny(clip, opts = {}) {
  const { writable = null } = opts;
  const f = state.files.find(x => x.id === clip.fileId);
  if (!f) throw new Error("Video original no encontrado");

  const mediabunny = await ensureMediabunny();
  const {
    Input, Output, Mp4OutputFormat, BufferTarget, StreamTarget,
    Conversion, BlobSource, ALL_FORMATS,
  } = mediabunny;

  const input = new Input({
    source: new BlobSource(f.file),
    formats: ALL_FORMATS,
  });

  const conversionOpts = {
    input,
    trim: { start: clip.start, end: clip.end },
    video: { hardwareAcceleration: "prefer-hardware" },
    audio: clip.audio ? undefined : { discard: true },
  };

  /* ---------- Modo 1: escribir a un WritableStream (picker) ---------- */
  if (writable) {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new StreamTarget(writable),
    });
    const conversion = await Conversion.init({ ...conversionOpts, output });
    if (!conversion.isValid) {
      try { await writable.abort(); } catch {}
      throw new Error("Pistas no soportadas para este clip.");
    }
    await conversion.execute();
    try { await writable.close(); } catch {}
    return { fileWritten: true };
  }

  /* ---------- Modo 2: generar Blob (ZIP o descarga directa) ---------- */
  // Preferimos OPFS para no cargar el archivo completo en RAM
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const tmpName = `clip_${clip.id}.mp4`;
      const tmpHandle = await root.getFileHandle(tmpName, { create: true });
      const stream = await tmpHandle.createWritable();

      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target: new StreamTarget(stream),
      });
      const conversion = await Conversion.init({ ...conversionOpts, output });
      if (!conversion.isValid) {
        try { await stream.abort(); } catch {}
        throw new Error("Pistas no soportadas para este clip.");
      }
      await conversion.execute();
      await stream.close();

      const file = await tmpHandle.getFile();
      setTimeout(async () => {
        try { await root.removeEntry(tmpName); } catch {}
      }, 120000);
      return { blob: file };
    } catch (e) {
      console.warn("OPFS falló, cayendo a memoria:", e);
    }
  }

  // Último recurso: en RAM
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const conversion = await Conversion.init({ ...conversionOpts, output });
  if (!conversion.isValid) throw new Error("Pistas no soportadas para este clip.");
  await conversion.execute();
  return { blob: new Blob([output.target.buffer], { type: "video/mp4" }) };
}

/* ============================================================
   EXPORTACIÓN completa
   ============================================================ */
async function doExport() {
  if (state.exporting) return;

  const pending = state.clips.filter(c => !c.exported);
  if (pending.length === 0) {
    toast("Nada pendiente", "Todos los clips ya están exportados.", "info");
    return;
  }

  if (!webCodecsSupported()) {
    toast("WebCodecs no disponible", "Tu navegador no soporta exportación.", "danger");
    return;
  }

  state.exporting = true;
  $("#btnDoExport").disabled = true;
  $("#btnBackEditor").disabled = true;
  $("#exportProgress").hidden = false;

  const total = pending.length;
  const epLabel = $("#epLabel");
  const epCount = $("#epCount");
  const epFill  = $("#epFill");
  const epSub   = $("#epSub");
  const individual = state.exportSettings.saveIndividually;
  const single = pending.length === 1;

  const setProgress = (i, label, sub) => {
    epLabel.textContent = label;
    epCount.textContent = `${i} / ${total}`;
    if (sub) epSub.textContent = sub;
    epFill.style.width = ((i / total) * 100) + "%";
  };

  try {
    /* ---------- MODO INDIVIDUAL ---------- */
    if (individual) {
      for (let i = 0; i < pending.length; i++) {
        const clip = pending[i];
        const filename = clipExportFilename(clip, state.clips.indexOf(clip));
        setProgress(i, `Guardando: ${filename}`, `${fmtTime(clip.start)} → ${fmtTime(clip.end)}`);
        setClipStatus(clip.id, "working", "guardando…");

        try {
          if (window.showSaveFilePicker) {
            const handle = await window.showSaveFilePicker({
              suggestedName: filename,
              types: [{ description: "Video MP4", accept: { "video/mp4": [".mp4"] } }],
            });
            const writable = await handle.createWritable();
            await processClipMediabunny(clip, { writable });
          } else {
            // Descarga directa
            const { blob } = await processClipMediabunny(clip);
            downloadBlob(blob, filename);
            await new Promise(r => setTimeout(r, 300));
          }
          clip.exported = true;
          clip.exportedFilename = filename;
          clip.exportError = "";
          saveSession();
          setClipStatus(clip.id, "exported", "✓ listo");
        } catch (e) {
          if (e.name === "AbortError") {
            setClipStatus(clip.id, "pending", "cancelado");
            throw new Error("Cancelado por el usuario");
          }
          clip.exportError = e.message || "error";
          saveSession();
          setClipStatus(clip.id, "error", "error");
          toast("Error en un clip", e.message, "danger");
        }
        await new Promise(r => setTimeout(r, 30));
      }

      finishExport(pending.length, 0);
      return;
    }

    /* ---------- MODO ZIP (o descarga directa si es 1 solo) ---------- */
    const blobs = [];
    for (let i = 0; i < pending.length; i++) {
      const clip = pending[i];
      setProgress(i, `Procesando: ${clip.fileName}`, `${fmtTime(clip.start)} → ${fmtTime(clip.end)}`);
      setClipStatus(clip.id, "working", "procesando…");

      try {
        const { blob } = await processClipMediabunny(clip);
        const filename = clipExportFilename(clip, state.clips.indexOf(clip));
        blobs.push({ blob, filename, clip });
        clip.exported = true;
        clip.exportedFilename = filename;
        clip.exportError = "";
        saveSession();
        setClipStatus(clip.id, "exported", "✓ listo");
      } catch (e) {
        clip.exportError = e.message || "error";
        saveSession();
        setClipStatus(clip.id, "error", "error");
        toast("Error en un clip", e.message, "danger");
      }
      await new Promise(r => setTimeout(r, 30));
    }

    if (blobs.length === 0) throw new Error("Ningún clip pudo procesarse");

    /* Descarga directa si es 1 solo */
    if (blobs.length === 1) {
      downloadBlob(blobs[0].blob, blobs[0].filename);
    } else {
      /* ZIP con fflate */
      setProgress(total, "Empaquetando ZIP…", "Comprimiendo sin pérdida…");
      const fflate = await ensureFflate();
      const zipChunks = [];
      const zip = new fflate.Zip((err, chunk) => {
        if (err) { console.error(err); return; }
        if (chunk) zipChunks.push(chunk);
      });

      for (const item of blobs) {
        const entry = new fflate.ZipDeflate(item.filename, { level: 0 });
        zip.add(entry);
        const reader = item.blob.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.push(value, false);
        }
        entry.push(new Uint8Array(0), true);
      }
      zip.end();

      const zipBlob = new Blob(zipChunks, { type: "application/zip" });
      const zipName = `recortes-${new Date().toISOString().slice(0, 10)}.zip`;
      downloadBlob(zipBlob, zipName);
    }

    finishExport(blobs.length, 0);
    clearSession();

  } catch (e) {
    if (e.message === "Cancelado por el usuario") {
      toast("Exportación cancelada", "Los clips exportados se conservan.", "info");
      updateExportSummary();
    } else {
      console.error("Export falló:", e);
      toast("Error exportando", e.message, "danger");
    }
  } finally {
    state.exporting = false;
    $("#btnDoExport").disabled = false;
    $("#btnBackEditor").disabled = false;
    updateExportSummary();
  }
}

function finishExport(count, singleDownloads) {
  cleanupURLs();
  showScreen("done");
  $("#doneDesc").textContent = `${count} clip${count === 1 ? "" : "s"} exportado${count === 1 ? "" : "s"}.`;
  toast("Exportación completa", `${count} clips`, "success");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function cleanupURLs() {
  state.files.forEach(f => { try { URL.revokeObjectURL(f.url); } catch {} });
}

function resetAll() {
  cleanupURLs();
  clearSession();
  state.files = [];
  state.clips = [];
  state.currentIndex = 0;
  state.markIn = 0;
  state.markOut = 0;
  state.audio = true;
  state.editingClipId = null;
  showScreen("empty");
  renderClipsList();
}

/* ============================================================
   EXPORTAR JSON (respaldo)
   ============================================================ */
function exportSessionJSON() {
  const payload = {
    version: 5,
    exportedAt: new Date().toISOString(),
    settings: state.exportSettings,
    files: state.files.map(f => ({ id: f.id, name: f.name, size: f.size })),
    clips: state.clips.map((c, i) => ({
      index: i + 1,
      name: clipDisplayName(c, i),
      customName: c.customName || "",
      fileName: c.fileName,
      fileSize: c.fileSize,
      fileId: c.fileId,
      start: c.start,
      end: c.end,
      duration: c.duration,
      audio: c.audio,
      exported: !!c.exported,
      exportedFilename: c.exportedFilename || "",
      exportError: c.exportError || "",
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(blob, `recortes-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast("JSON exportado", "Respaldo descargado", "success");
}

/* ============================================================
   SESIÓN REANUDABLE
   ============================================================ */
function renderSessionResume() {
  const meta = loadSessionMeta();
  if (!meta || !meta.clips || meta.clips.length === 0) {
    $("#sessionResume").hidden = true;
    return;
  }
  const clipsCount = meta.clips.length;
  const exportedCount = meta.clips.filter(c => c.exported).length;
  const body = $("#sessionResumeBody");
  body.innerHTML = `
    Tienes <strong>${clipsCount} clip${clipsCount === 1 ? "" : "s"}</strong>
    (${exportedCount} ya exportado${exportedCount === 1 ? "" : "s"}).
    <br><br>
    <strong>Selecciona ÚNICAMENTE los archivos originales que se usaron</strong> (no la carpeta entera):
    <ul>
      ${meta.files.slice(0, 6).map(f => `<li>· ${escapeHTML(f.name)}</li>`).join("")}
      ${meta.files.length > 6 ? `<li>· … y ${meta.files.length - 6} más</li>` : ""}
    </ul>
  `;
  $("#sessionResume").hidden = false;
}

async function resumeSession() {
  const meta = loadSessionMeta();
  if (!meta) return;

  const tmp = document.createElement("input");
  tmp.type = "file";
  tmp.accept = "video/*";
  tmp.multiple = true;
  // ⚠️ QUITAMOS webkitdirectory: así el navegador no se queja
  // ni escanea toda la carpeta. Solo abrimos el picker normal.
  tmp.style.display = "none";
  document.body.appendChild(tmp);

  tmp.onchange = async () => {
    const fileList = tmp.files;
    tmp.remove();
    if (!fileList || fileList.length === 0) return;

    const allFiles = [...fileList];

    const matched = [];
    const missing = [];
    for (const pendingFile of meta.files) {
      const m = allFiles.find(f => f.name === pendingFile.name && f.size === pendingFile.size);
      if (m) matched.push({ pendingFile, file: m });
      else missing.push(pendingFile);
    }

    if (matched.length === 0) {
      toast("Sin coincidencias", "No seleccionaste los archivos originales.", "danger");
      return;
    }

    state.files = [];
    for (const { pendingFile, file } of matched) {
      try {
        const url = URL.createObjectURL(file);
        const duration = await new Promise((res) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          const timer = setTimeout(() => res(0), 5000);
          v.onloadedmetadata = () => {
            clearTimeout(timer);
            res(Number.isFinite(v.duration) ? v.duration : 0);
          };
          v.onerror = () => { clearTimeout(timer); res(0); };
          v.src = url;
        });
        state.files.push({ id: pendingFile.id, file, name: file.name, size: file.size, duration, url });
      } catch {}
    }

    state.clips = meta.clips
      .filter(c => state.files.some(f => f.id === c.fileId))
      .map(c => ({
        ...c,
        customName: c.customName || "",
        exported: !!c.exported,
        exportedFilename: c.exportedFilename || "",
        exportError: c.exportError || "",
      }));

    saveSession();
    showExport();

    if (missing.length > 0) {
      toast(
        "Faltan archivos",
        `No encontré ${missing.length} archivo(s). Faltan clips por reanudar.`,
        "danger"
      );
    } else {
      toast("Sesión reanudada", `${state.clips.length} clips · ${state.files.length} videos`, "success");
    }
  };

  tmp.click();
}

/* ============================================================
   PROCESAR ARCHIVOS
   ============================================================ */
async function processVideoFiles(rawFiles) {
  const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|3gp|ogv|mpg|mpeg)$/i;
  const files = [...rawFiles].filter(f =>
    f.type.startsWith("video/") || VIDEO_EXT.test(f.name)
  );

  if (files.length === 0) {
    toast("No hay videos", "Selecciona archivos de video válidos.", "danger");
    return 0;
  }

  toast("Procesando videos…", "Leyendo duración", "info");

  let added = 0;
  for (const file of files) {
    try {
      const url = URL.createObjectURL(file);
      const duration = await new Promise((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        const timer = setTimeout(() => resolve(0), 5000);
        v.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve(Number.isFinite(v.duration) ? v.duration : 0);
        };
        v.onerror = () => { clearTimeout(timer); resolve(0); };
        v.src = url;
      });

      state.files.push({
        id: newId(), file, name: file.name,
        size: file.size, duration, url,
      });
      added++;
    } catch (err) {
      console.error("Error al leer archivo:", file.name, err);
      toast("Error con " + file.name, "No se pudo leer", "danger");
    }
  }

  if (added > 0) {
    state.currentIndex = 0;
    openEditorCurrent();
    toast("Videos cargados", `${added} archivo(s) listo(s)`, "success");
  }
  return added;
}

/* ============================================================
   Importar ARCHIVOS
   ============================================================ */
function importSessionJSON() {
  $("#jsonFileInput").click();
}

// Evento para leer el archivo JSON
$("#jsonFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.clips || !Array.isArray(data.clips)) {
        throw new Error("El archivo no tiene el formato de respaldo válido.");
      }
      
      // Sobrescribimos la sesión actual con el JSON importado
      const payload = {
        updatedAt: new Date().toISOString(),
        clips: data.clips,
        files: data.files || [],
      };
      
      localStorage.setItem(LS_SESSION, JSON.stringify(payload));
      
      // Recargamos la interfaz de sesión
      renderSessionResume();
      toast("Respaldo cargado", "Selecciona los videos para continuar.", "success");
      
    } catch (err) {
      console.error(err);
      toast("Archivo inválido", "No es un respaldo de Recortes válido.", "danger");
    }
  };
  reader.readAsText(file);
});

// Enganchar el botón
$("#btnImportJSON").addEventListener("click", importSessionJSON);

/* ============================================================
   EVENTOS
   ============================================================ */
(function bindFilePicker() {
  const input = $("#fileInput");
  if (!input) return;
  input.style.position = "absolute";
  input.style.width = "1px";
  input.style.height = "1px";
  input.style.opacity = "0";
  input.style.overflow = "hidden";
  input.style.zIndex = "-1";

  input.addEventListener("change", async (e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = [...fileList];
    e.target.value = "";
    await processVideoFiles(files);
  });

  const btnPick = $("#btnPick");
  if (btnPick) btnPick.addEventListener("click", () => input.click());
})();

const dz = $("#dropZone");
if (dz) {
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("over");
    if (e.dataTransfer.files.length > 0) {
      await processVideoFiles([...e.dataTransfer.files]);
    }
  });
}

$("#btnResumeSession").addEventListener("click", resumeSession);
$("#btnDiscardSession").addEventListener("click", () => {
  clearSession();
  $("#sessionResume").hidden = true;
  toast("Sesión descartada", "", "info");
});

$("#btnSkip").addEventListener("click", skipVideo);
$("#btnSaveNext").addEventListener("click", saveAndNext);
$("#btnAddAnother").addEventListener("click", addAnotherClip);
$("#btnResetMarks").addEventListener("click", () => {
  const f = state.files[state.currentIndex];
  if (!f) return;
  state.markIn = 0; state.markOut = f.duration;
  updateTimeline(); updateMarksInfo();
});
$("#btnMarkIn").addEventListener("click", () => {
  state.markIn = Math.min($("#video").currentTime, state.markOut - 0.1);
  updateTimeline(); updateMarksInfo();
});
$("#btnMarkOut").addEventListener("click", () => {
  state.markOut = Math.max($("#video").currentTime, state.markIn + 0.1);
  updateTimeline(); updateMarksInfo();
});
$("#btnAudio").addEventListener("click", () => {
  state.audio = !state.audio;
  updateAudioUI();
});

$("#ftBack1").addEventListener("click", () => { $("#video").currentTime = Math.max(0, $("#video").currentTime - 1); });
$("#ftBack01").addEventListener("click", () => { $("#video").currentTime = Math.max(0, $("#video").currentTime - 0.1); });
$("#ftFwd01").addEventListener("click", () => { $("#video").currentTime = Math.min($("#video").duration, $("#video").currentTime + 0.1); });
$("#ftFwd1").addEventListener("click", () => { $("#video").currentTime = Math.min($("#video").duration, $("#video").currentTime + 1); });

const video = $("#video");
$("#btnPlay").addEventListener("click", () => {
  if (video.paused) video.play(); else video.pause();
});
video.addEventListener("play", () => { $("#iconPlay").hidden = true; $("#iconPause").hidden = false; });
video.addEventListener("pause", () => { $("#iconPlay").hidden = false; $("#iconPause").hidden = true; });
video.addEventListener("timeupdate", () => { updatePlayhead(); });
video.addEventListener("loadedmetadata", () => { updatePlayhead(); });
$("#btnBack1").addEventListener("click", () => { video.currentTime = Math.max(0, video.currentTime - 1); });
$("#btnFwd1").addEventListener("click", () => { video.currentTime = Math.min(video.duration, video.currentTime + 1); });

$("#btnGoExport").addEventListener("click", showExport);
$("#btnDoExport").addEventListener("click", doExport);
$("#btnBackEditor").addEventListener("click", () => { state.currentIndex = 0; openEditorCurrent(); });
$("#btnStartOver").addEventListener("click", () => {
  resetAll();
  const input = $("#fileInput");
  if (input) setTimeout(() => input.click(), 100);
});
$("#btnReset").addEventListener("click", () => { if (confirm("¿Empezar de nuevo?")) resetAll(); });

/* Export settings */
$("#exBaseName").addEventListener("input", (e) => {
  state.exportSettings.baseName = e.target.value;
  saveExportSettings();
});
$("#exSaveIndividually").addEventListener("change", (e) => {
  state.exportSettings.saveIndividually = e.target.checked;
  saveExportSettings();
});
$("#btnApplyBaseName").addEventListener("click", () => {
  let pattern = ($("#exBaseName").value || "").trim();
  
  if (!pattern) {
    toast("Patrón vacío", "Escribí un nombre base para los clips.", "danger");
    return;
  }

  // Quitamos extensión si el usuario la escribió por error
  pattern = stripExt(pattern);

  // Si el usuario no puso #, se lo agregamos al final automáticamente
  if (!pattern.includes("#")) {
    pattern = pattern + " #";
  }

  state.clips.forEach((c, i) => {
    // Reemplazamos # por el número incrementado (1, 2, 3...)
    c.customName = pattern.replace(/#+/g, String(i + 1));
  });
  
  saveSession();
  renderExportList();
  toast("Nombres aplicados", `Patrón: "${pattern}"`, "success");
});

/* Atajos */
document.addEventListener("keydown", (e) => {
  if (state.screen !== "editor" || ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); $("#btnPlay").click(); }
  else if (e.key === "i" || e.key === "I") { e.preventDefault(); $("#btnMarkIn").click(); }
  else if (e.key === "o" || e.key === "O") { e.preventDefault(); $("#btnMarkOut").click(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 5 : 1)); }
  else if (e.key === "ArrowRight") { e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + (e.shiftKey ? 5 : 1)); }
  else if (e.key === "Enter") { e.preventDefault(); saveAndNext(); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); addAnotherClip(); }
});

/* Tema */
(function () {
  const KEY = "ae-theme";
  const saved = localStorage.getItem(KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", saved || (prefersDark ? "dark" : "light"));
  $("#themeToggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(KEY, next);
  });
})();

/* ============================================================
   INIT
   ============================================================ */
(async () => {
  bindTimelineDrag();
  loadExportSettings();
  renderSessionResume();
})();