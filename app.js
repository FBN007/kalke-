/* =========================================================
   Kalke · FPV route planner
   Leaflet 1.9 + Leaflet-Geoman for drawing/editing, plus a
   custom freehand tool, tracing-paper overlay, flight stats
   and GeoJSON / KML / PNG export.
   ========================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------
     Configuration
     --------------------------------------------------------- */
  const CONFIG = {
    storageKey: 'kalke.fpv.v1',
    // Esri imagery has native tiles down to zoom 19 in most populated areas.
    // If you see grey "Map data not yet available" tiles when zoomed right in,
    // lower this to 18 (the map then upscales the last available level).
    imageryMaxNativeZoom: 19,
    maxZoom: 22,
    defaultView: { center: [48.5, 10.0], zoom: 4 },
    rangeWarnShare: 0.85, // warn when a point is beyond 85% of the link range
  };

  const INKS = ['#ffd84a', '#ff5fa2', '#ff8a3d', '#42d9ff', '#8dff6a', '#b98cff'];
  const INK_NAMES = {
    '#ffd84a': 'Yellow', '#ff5fa2': 'Pink', '#ff8a3d': 'Orange',
    '#42d9ff': 'Cyan', '#8dff6a': 'Green', '#b98cff': 'Violet',
  };

  // Icon paths are 24×24 SVG strokes, shared by the map markers (HTML) and the PNG export (Path2D).
  const MARKER_TYPES = {
    takeoff: { label: 'Takeoff', color: '#8dff6a', key: '1', path: 'M12 18V6M7 11l5-5 5 5M6 20.5h12' },
    landing: { label: 'Landing', color: '#42d9ff', key: '2', path: 'M12 4v12M7 11l5 5 5-5M6 20.5h12' },
    dive:    { label: 'Dive',    color: '#ff5fa2', key: '3', path: 'M7 5l5 5 5-5M7 12l5 5 5-5' },
    gap:     { label: 'Gap',     color: '#ffd84a', key: '4', path: 'M7 19V6M17 19V6M5 6h14' },
    hazard:  { label: 'Hazard',  color: '#ff6b5a', key: '5', path: 'M12 4.5 20 18.5H4zM12 10v3.5M12 16.2v.01' },
    note:    { label: 'Note',    color: '#ecebe2', key: '6', path: 'M12 11v6M12 7.3v.01' },
  };

  const TINTS = {
    vellum: { paper: '#f2f0e6', mark: '#3b4048' },
    frost:  { paper: '#e8eff4', mark: '#34404c' },
    night:  { paper: '#121519', mark: '#9ba1aa' },
  };

  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const ESRI_ATTR = 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community';

  function esriLayer(service, extra) {
    return L.tileLayer(ESRI + service + '/MapServer/tile/{z}/{y}/{x}', Object.assign({
      maxZoom: CONFIG.maxZoom,
      maxNativeZoom: CONFIG.imageryMaxNativeZoom,
      crossOrigin: 'anonymous', // lets the PNG export read the tiles
      attribution: ESRI_ATTR,
    }, extra));
  }

  const BASEMAPS = {
    satellite: { credit: 'Imagery © Esri, Maxar, Earthstar Geographics', make: () => [esriLayer('World_Imagery')] },
    hybrid: {
      credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
      make: () => [
        esriLayer('World_Imagery'),
        esriLayer('Reference/World_Transportation', { attribution: '' }),
        esriLayer('Reference/World_Boundaries_and_Places', { attribution: '' }),
      ],
    },
    topo: {
      credit: 'Map © Esri and its data providers',
      make: () => [esriLayer('World_Topo_Map', { attribution: 'Map &copy; <a href="https://www.esri.com/">Esri</a> and its data providers' })],
    },
    osm: {
      credit: '© OpenStreetMap contributors',
      make: () => [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: CONFIG.maxZoom,
        maxNativeZoom: 19,
        crossOrigin: 'anonymous',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      })],
    },
  };

  const DEFAULT_SETTINGS = {
    basemap: 'satellite',
    kalkeOn: true,
    paper: 0.3,
    tint: 'vellum',
    inkOpacity: 0.95,
    weight: 4,
    labels: true,
    ring: true,
    flow: false,
    units: 'metric',
    speedKmh: 50,
    packMin: 4,
    reservePct: 20,
    rangeM: 1200,
  };

  // Things that never belong to the plan itself (decorations, location dot, temp lines).
  const IGNORE = { pmIgnore: true, snapIgnore: true, interactive: false };

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  const state = {
    tool: null, // 'line' | 'freehand' | 'edit' | 'move' | 'erase' | 'marker:<type>'
    ink: INKS[0],
    planName: '',
    settings: Object.assign({}, DEFAULT_SETTINGS),
  };
  const items = new Map(); // id -> { data, layer }
  const history = { undo: [], redo: [], current: null };
  let restoring = false;

  /* ---------------------------------------------------------
     Small helpers
     --------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const r7 = (v) => Math.round(v * 1e7) / 1e7;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const newId = () => Math.random().toString(36).slice(2, 10);
  const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

  // Finger-first device (phone, tablet) and phone-width layout
  const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
  const mobileQuery = window.matchMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)');
  const isTouch = () => touchQuery.matches;
  const onMediaChange = (mq, fn) => (mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn));

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => c !== null && c !== undefined && node.append(c));
    return node;
  }

  const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

  function flatLatLngs(layer) {
    let ll = layer.getLatLngs();
    while (Array.isArray(ll) && Array.isArray(ll[0])) ll = ll[0];
    return ll;
  }

  function pathLength(latlngs) {
    let d = 0;
    for (let i = 1; i < latlngs.length; i++) d += latlngs[i - 1].distanceTo(latlngs[i]);
    return d;
  }

  function pointAlong(latlngs, fraction) {
    const total = pathLength(latlngs);
    if (!total) return latlngs[0];
    let target = total * fraction;
    for (let i = 1; i < latlngs.length; i++) {
      const a = latlngs[i - 1], b = latlngs[i];
      const seg = a.distanceTo(b);
      if (target <= seg && seg > 0) {
        const t = target / seg;
        return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
      }
      target -= seg;
    }
    return latlngs[latlngs.length - 1];
  }

  // Screen angle of a segment in degrees. Web Mercator keeps angles at every zoom.
  function segmentAngle(a, b) {
    const p1 = map.project(a, 18), p2 = map.project(b, 18);
    return Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
  }

  function fmtDist(m) {
    if (!isFinite(m)) return '–';
    if (state.settings.units === 'imperial') {
      const ft = m * 3.28084;
      if (ft < 1000) return `${Math.round(ft)} ft`;
      const mi = m / 1609.344;
      return `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
    }
    if (m < 1000) return `${Math.round(m)} m`;
    const km = m / 1000;
    return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
  }

  function fmtDuration(sec) {
    const s = Math.round(sec);
    if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fileBase() {
    const slug = (state.planName || '').toLowerCase().normalize('NFKD')
      .replace(/[̀-ͯ]/g, '').replace(/[æ]/g, 'ae').replace(/[ø]/g, 'o').replace(/[å]/g, 'a')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const date = new Date().toISOString().slice(0, 10);
    return `${slug || 'fpv-route-plan'}-${date}`;
  }

  function download(content, filename, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // On phones, hand files to the share sheet (save to Photos/Files, send to a friend) when the browser can.
  async function deliver(blob, filename) {
    if (isTouch() && navigator.canShare && typeof File === 'function') {
      try {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: state.planName || 'FPV route plan' });
          return 'shared';
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        // anything else: fall back to a normal download
      }
    }
    download(blob, filename);
    return 'saved';
  }

  let toastTimer = null;
  function toast(message, action) {
    const box = $('#toast');
    box.replaceChildren(el('span', {}, message));
    if (action) {
      box.append(el('button', {
        type: 'button',
        onclick: () => { box.hidden = true; action.fn(); },
      }, action.label));
    }
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, action ? 6500 : 3500);
  }

  /* ---------------------------------------------------------
     Map
     --------------------------------------------------------- */
  const mapEl = $('#map');
  const map = L.map(mapEl, {
    zoomControl: false,
    maxZoom: CONFIG.maxZoom,
    worldCopyJump: true,
  });
  L.control.zoom({ position: 'topright' }).addTo(map);

  let scaleControl = null;
  function setScaleControl() {
    if (scaleControl) scaleControl.remove();
    const metric = state.settings.units !== 'imperial';
    scaleControl = L.control.scale({ position: 'bottomleft', metric, imperial: !metric, maxWidth: 140 }).addTo(map);
  }

  const decor = L.layerGroup([], { pmIgnore: true }).addTo(map);      // arrows, labels, range rings
  const locLayer = L.layerGroup([], { pmIgnore: true }).addTo(map);   // "my location" dot

  let baseLayers = [];
  function setBasemap(key) {
    const def = BASEMAPS[key] || BASEMAPS.satellite;
    baseLayers.forEach((l) => l.remove());
    baseLayers = def.make();
    baseLayers.forEach((l) => l.addTo(map));
    state.settings.basemap = BASEMAPS[key] ? key : 'satellite';
  }

  // Geoman: we drive it from the sidebar, so its own toolbar stays hidden.
  map.pm.setGlobalOptions({
    snappable: true,
    snapDistance: 16,
    tooltips: false,
    allowSelfIntersection: true,
    limitMarkersToCount: 30,
    exitModeOnEscape: false,
  });

  /* ---------------------------------------------------------
     Item factory
     --------------------------------------------------------- */
  function routeStyle(color) {
    const s = state.settings;
    return { color, weight: s.weight, opacity: s.inkOpacity, lineCap: 'round', lineJoin: 'round', className: 'route' };
  }

  function markerIcon(type) {
    const t = MARKER_TYPES[type] || MARKER_TYPES.note;
    return L.divIcon({
      className: 'kmarker',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      tooltipAnchor: [0, -15],
      html: `<span class="kmarker-badge" style="--c:${t.color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.path}"/></svg></span>`,
    });
  }

  function nextName(prefix) {
    const taken = new Set([...items.values()].map((it) => it.data.name));
    let n = 1;
    while (taken.has(`${prefix} ${n}`)) n++;
    return `${prefix} ${n}`;
  }

  function attach(data, layer) {
    layer._kalkeId = data.id;
    items.set(data.id, { data, layer });
    layer.on('pm:edit pm:dragend dragend', scheduleCommit);
    layer.on('pm:change pm:drag drag', scheduleLive);
    layer.on('click', () => { if (!state.tool) flashItem(data.id); });
    return layer;
  }

  function buildLayer(data) {
    if (data.kind === 'route') {
      return L.polyline(data.coords.map((c) => L.latLng(c[0], c[1])), routeStyle(data.color));
    }
    return L.marker(L.latLng(data.coords[0], data.coords[1]), { icon: markerIcon(data.type), riseOnHover: true });
  }

  function addItem(raw) {
    const data = {
      id: raw.id || newId(),
      kind: raw.kind === 'marker' ? 'marker' : 'route',
      name: raw.name,
      visible: raw.visible !== false,
    };
    if (data.kind === 'route') {
      data.color = isHex(raw.color) ? raw.color.toLowerCase() : state.ink;
      data.mode = raw.mode === 'freehand' ? 'freehand' : 'line';
    } else {
      data.type = MARKER_TYPES[raw.type] ? raw.type : 'note';
    }
    if (!data.name) data.name = nextName(data.kind === 'route' ? 'Route' : MARKER_TYPES[data.type].label);
    const layer = buildLayer(Object.assign({}, data, { coords: raw.coords }));
    attach(data, layer);
    if (data.visible) layer.addTo(map);
    return layer;
  }

  function serializeItems() {
    return [...items.values()].map(({ data, layer }) => {
      const out = Object.assign({}, data);
      if (data.kind === 'route') out.coords = flatLatLngs(layer).map((ll) => [r7(ll.lat), r7(ll.lng)]);
      else { const ll = layer.getLatLng(); out.coords = [r7(ll.lat), r7(ll.lng)]; }
      return out;
    });
  }

  function routeLength(it) { return pathLength(flatLatLngs(it.layer)); }

  /* ---------------------------------------------------------
     History, autosave
     --------------------------------------------------------- */
  const snapshot = () => JSON.stringify(serializeItems());

  function commit() {
    if (restoring) return;
    const snap = snapshot();
    if (snap !== history.current) {
      if (history.current !== null) {
        history.undo.push(history.current);
        if (history.undo.length > 200) history.undo.shift();
      }
      history.redo.length = 0;
      history.current = snap;
    }
    save();
    renderAll();
  }

  let commitTimer = null;
  function scheduleCommit() {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 0);
  }

  let liveFrame = 0;
  function scheduleLive() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0;
      renderDecorations();
      renderStats();
    });
  }

  function restore(snap) {
    const tool = state.tool;
    setTool(null, { discard: true });
    restoring = true;
    items.forEach(({ layer }) => layer.remove());
    items.clear();
    JSON.parse(snap).forEach(addItem);
    restoring = false;
    history.current = snap;
    save();
    renderAll();
    if (tool) setTool(tool);
  }

  function undo() {
    if (lineVertexCount() > 0) { removeLastVertex(); return; }
    if (!history.undo.length) return;
    history.redo.push(history.current);
    restore(history.undo.pop());
  }

  function redo() {
    if (!history.redo.length) return;
    history.undo.push(history.current);
    restore(history.redo.pop());
  }

  function save() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify({
        v: 1,
        planName: state.planName,
        ink: state.ink,
        settings: state.settings,
        items: JSON.parse(history.current || '[]'),
        view: { center: map.getCenter(), zoom: map.getZoom() },
      }));
    } catch (err) { /* storage full or blocked: the plan still works, it just won't persist */ }
  }

  let saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(CONFIG.storageKey)); } catch (err) { return null; }
  }

  /* ---------------------------------------------------------
     Tools
     --------------------------------------------------------- */
  function lineVertexCount() {
    const d = map.pm.Draw.Line;
    if (map.pm.Draw.getActiveShape() !== 'Line' || !d._layer) return 0;
    return flatLatLngs(d._layer).length;
  }

  function finishLine() {
    if (lineVertexCount() >= 2) map.pm.Draw.Line._finishShape();
  }

  function removeLastVertex() {
    if (lineVertexCount() > 1) map.pm.Draw.Line._removeLastVertex();
    else { map.pm.disableDraw(); startLineDraw(); }
    updateLineBar();
    updateHistoryUI();
  }

  function startLineDraw() {
    const s = state.settings;
    map.pm.enableDraw('Line', {
      pathOptions: routeStyle(state.ink),
      templineStyle: { color: state.ink, weight: s.weight, opacity: 0.9 },
      hintlineStyle: { color: state.ink, weight: 2, opacity: 0.85, dashArray: '4 7' },
      continueDrawing: true,
      snappable: true,
      snapDistance: isTouch() ? 26 : 16,
      tooltips: false,
      finishOn: null,
    });
  }

  function startMarkerDraw(type) {
    map.pm.enableDraw('Marker', {
      markerStyle: { icon: markerIcon(type), draggable: false },
      continueDrawing: true,
      snappable: true,
      tooltips: false,
    });
  }

  function setTool(tool, opts) {
    const discard = opts && opts.discard;
    closeMarkerSheet();
    if (!discard) finishLine();
    map.pm.disableDraw();
    if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
    if (map.pm.globalDragModeEnabled()) map.pm.disableGlobalDragMode();
    if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
    freehand.disable();
    setLive('');

    state.tool = tool || null;
    switch (true) {
      case tool === 'line': startLineDraw(); break;
      case tool === 'freehand': freehand.enable(); break;
      case tool === 'edit':
        // On touch there is no hover to reveal nearby points, and no right-click: show every point, tap one to delete it.
        map.pm.enableGlobalEditMode({
          limitMarkersToCount: isTouch() ? -1 : 30,
          removeVertexOn: isTouch() ? 'click' : 'contextmenu',
          snappable: true,
          allowSelfIntersection: true,
        });
        break;
      case tool === 'move': map.pm.enableGlobalDragMode(); break;
      case tool === 'erase': map.pm.enableGlobalRemovalMode(); break;
      case typeof tool === 'string' && tool.startsWith('marker:'): startMarkerDraw(tool.slice(7)); break;
      default: break;
    }
    updateToolUI();
    updateHint();
    updateHistoryUI();
    updateLineBar();
  }

  function toggleTool(tool) {
    setTool(state.tool === tool ? null : tool);
    if (state.tool && mobileQuery.matches) setPanel(false);
  }

  // Geoman finished a line or placed a marker
  map.on('pm:create', (e) => {
    const layer = e.layer;
    if (e.shape === 'Line') {
      if (flatLatLngs(layer).length < 2) { layer.remove(); return; }
      attach({ id: newId(), kind: 'route', name: nextName('Route'), color: layer.options.color || state.ink, mode: 'line', visible: true }, layer);
    } else if (e.shape === 'Marker') {
      const type = state.tool && state.tool.startsWith('marker:') ? state.tool.slice(7) : 'note';
      layer.setIcon(markerIcon(type));
      attach({ id: newId(), kind: 'marker', type, name: nextName(MARKER_TYPES[type].label), visible: true }, layer);
    } else {
      layer.remove();
      return;
    }
    setLive('');
    scheduleCommit();
    setTimeout(updateLineBar, 0); // Geoman starts the next line right after this event
  });

  // Erase tool
  map.on('pm:remove', (e) => {
    const id = e.layer && e.layer._kalkeId;
    if (!id || !items.has(id)) return;
    const name = items.get(id).data.name;
    items.delete(id);
    scheduleCommit();
    toast(`Erased ${name}`, { label: 'Undo', fn: undo });
  });

  // Live length while drawing a line (deferred a frame so Geoman has moved its snapping hint marker).
  // Fingers don't hover, so on touch the bar shows the length so far instead.
  let liveLineFrame = 0;
  map.on('mousemove', (e) => {
    if (state.tool !== 'line' || liveLineFrame || isTouch()) return;
    liveLineFrame = requestAnimationFrame(() => {
      liveLineFrame = 0;
      const d = map.pm.Draw.Line;
      if (state.tool !== 'line' || !d._layer) return;
      const ll = flatLatLngs(d._layer);
      if (!ll.length) return;
      const cursor = (d._hintMarker && d._hintMarker.getLatLng()) || e.latlng;
      const leg = ll[ll.length - 1].distanceTo(cursor);
      updateLineBar(fmtDist(pathLength(ll) + leg), `+${fmtDist(leg)}`);
    });
  });
  // Geoman reports new points on the line being drawn, not on the map
  map.on('pm:drawstart', (e) => {
    if (e.shape === 'Line' && e.workingLayer) {
      e.workingLayer.on('pm:vertexadded', () => { updateHistoryUI(); updateLineBar(); });
    }
  });

  /* ---------------------------------------------------------
     Freehand tool (custom: pointer events + smoothing)
     --------------------------------------------------------- */
  const freehand = (() => {
    let active = false, drawing = false, panning = false, multi = false;
    let pointerId = null, pts = [], temp = null;
    const down = new Set(); // pointers currently pressed on the map

    function enable() {
      if (active) return;
      active = true;
      map.dragging.disable();
      map.doubleClickZoom.disable();
      mapEl.classList.add('is-freehand');
      mapEl.style.touchAction = 'none';
      mapEl.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointerup', onRelease, true);
      window.addEventListener('pointercancel', onRelease, true);
    }

    function disable() {
      if (!active) return;
      cancel();
      active = false;
      panning = false;
      multi = false;
      down.clear();
      mapEl.classList.remove('is-freehand', 'is-panning');
      mapEl.style.touchAction = '';
      mapEl.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
      map.dragging.enable();
      map.doubleClickZoom.enable();
    }

    function setPanning(on) {
      if (!active || drawing || panning === on) return;
      panning = on;
      mapEl.classList.toggle('is-panning', on);
      if (on) map.dragging.enable(); else map.dragging.disable();
    }

    function onRelease(e) {
      down.delete(e.pointerId);
      if (!down.size) multi = false;
    }

    function onDown(e) {
      if (e.target.closest && e.target.closest('.leaflet-control')) return;
      down.add(e.pointerId);
      if (down.size > 1) {
        // A second finger hands the gesture to the map: pinch to zoom, move both fingers to pan.
        // A stroke that was already under way is kept; a tiny one was just the first finger landing.
        if (drawing) finishStroke(strokePx() > 60);
        multi = true;
        return;
      }
      if (multi || panning || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      drawing = true;
      pointerId = e.pointerId;
      try { mapEl.setPointerCapture(pointerId); } catch (err) { /* not critical */ }
      const p = map.mouseEventToContainerPoint(e);
      pts = [p];
      temp = L.polyline([map.containerPointToLatLng(p)], Object.assign(routeStyle(state.ink), IGNORE, { className: 'route-temp' })).addTo(map);
      mapEl.addEventListener('pointermove', onMove);
      mapEl.addEventListener('pointerup', onUp);
      mapEl.addEventListener('pointercancel', onUp);
    }

    function onMove(e) {
      if (!drawing || e.pointerId !== pointerId) return;
      const events = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
      events.forEach((ev) => {
        const p = map.mouseEventToContainerPoint(ev);
        if (p.distanceTo(pts[pts.length - 1]) >= 2.5) {
          pts.push(p);
          temp.addLatLng(map.containerPointToLatLng(p));
        }
      });
      setLive(fmtDist(pathLength(temp.getLatLngs())));
    }

    function onUp(e) {
      if (!drawing || e.pointerId !== pointerId) return;
      finishStroke(e.type === 'pointerup' || strokePx() > 60);
    }

    function strokePx() {
      let d = 0;
      for (let i = 1; i < pts.length; i++) d += pts[i].distanceTo(pts[i - 1]);
      return d;
    }

    function finishStroke(keep) {
      const raw = pts;
      const px = strokePx();
      cancel();
      setLive('');
      if (!keep || raw.length < 3 || px < 12) return;
      const latlngs = smoothPath(raw).map((p) => map.containerPointToLatLng(p));
      const layer = L.polyline(latlngs, routeStyle(state.ink)).addTo(map);
      attach({ id: newId(), kind: 'route', name: nextName('Route'), color: state.ink, mode: 'freehand', visible: true }, layer);
      scheduleCommit();
    }

    function cancel() {
      drawing = false;
      if (temp) { temp.remove(); temp = null; }
      if (pointerId !== null) { try { mapEl.releasePointerCapture(pointerId); } catch (err) { /* ignore */ } }
      pointerId = null;
      pts = [];
      mapEl.removeEventListener('pointermove', onMove);
      mapEl.removeEventListener('pointerup', onUp);
      mapEl.removeEventListener('pointercancel', onUp);
    }

    return { enable, disable, setPanning, get active() { return active; } };
  })();

  // Simplify the raw pointer trail, then round off the corners (Chaikin) for a flowing line.
  function smoothPath(points) {
    let p = L.LineUtil.simplify(points, 2);
    if (p.length > 2) p = chaikin(p, 2);
    return L.LineUtil.simplify(p, 0.6);
  }

  function chaikin(pts, iterations) {
    for (let k = 0; k < iterations; k++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        out.push(L.point(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
        out.push(L.point(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  /* ---------------------------------------------------------
     Rendering
     --------------------------------------------------------- */
  function renderAll() {
    applyLayers();
    renderDecorations();
    renderStats();
    renderList();
    updateHistoryUI();
    updateHint();
  }

  function applyLayers() {
    const s = state.settings;
    items.forEach(({ data, layer }) => {
      const onMap = map.hasLayer(layer);
      if (data.visible && !onMap) layer.addTo(map);
      else if (!data.visible && onMap) layer.remove();

      if (data.kind === 'route') {
        layer.setStyle({ color: data.color, weight: s.weight, opacity: s.inkOpacity });
      } else {
        layer.setOpacity(Math.max(s.inkOpacity, 0.35));
        layer.unbindTooltip();
        layer.bindTooltip(escapeHtml(data.name), {
          permanent: s.labels,
          direction: 'top',
          offset: [0, -4],
          className: 'kmarker-label',
          opacity: 1,
        });
      }
    });
  }

  function arrowIcon(color, angle) {
    return L.divIcon({
      className: 'route-arrow',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      html: `<div style="--c:${color};transform:rotate(${angle.toFixed(1)}deg)"><svg viewBox="0 0 18 18"><path d="M3 3.5 16 9 3 14.5 6 9z"/></svg></div>`,
    });
  }

  function labelIcon(name, length, color) {
    return L.divIcon({
      className: 'route-label',
      iconSize: [0, 0],
      html: `<span style="--c:${color}">${escapeHtml(name)}<b>${fmtDist(length)}</b></span>`,
    });
  }

  function renderDecorations() {
    const s = state.settings;
    decor.clearLayers();
    items.forEach(({ data, layer }) => {
      if (!data.visible) return;
      if (data.kind === 'route') {
        const ll = flatLatLngs(layer);
        if (ll.length < 2) return;
        decor.addLayer(L.circleMarker(ll[0], Object.assign({
          radius: 4.5, color: data.color, weight: 2.5, opacity: s.inkOpacity,
          fillColor: '#15181c', fillOpacity: s.inkOpacity,
        }, IGNORE)));
        decor.addLayer(L.marker(ll[ll.length - 1], Object.assign({
          icon: arrowIcon(data.color, segmentAngle(ll[ll.length - 2], ll[ll.length - 1])),
          keyboard: false, opacity: s.inkOpacity,
        }, IGNORE)));
        if (s.labels) {
          decor.addLayer(L.marker(pointAlong(ll, 0.5), Object.assign({
            icon: labelIcon(data.name, pathLength(ll), data.color), keyboard: false,
          }, IGNORE)));
        }
      } else if (data.type === 'takeoff' && s.ring) {
        decor.addLayer(L.circle(layer.getLatLng(), Object.assign({
          radius: s.rangeM, color: MARKER_TYPES.takeoff.color, weight: 1.6, opacity: 0.9,
          dashArray: '6 8', fill: false,
        }, IGNORE)));
      }
    });
  }

  function computeStats() {
    const s = state.settings;
    const all = [...items.values()];
    const routes = all.filter((it) => it.data.kind === 'route');
    const visibleRoutes = routes.filter((it) => it.data.visible);
    const total = visibleRoutes.reduce((sum, it) => sum + routeLength(it), 0);
    const speed = s.speedKmh / 3.6;
    const time = total > 0 && speed > 0 ? total / speed : 0;
    const pack = s.packMin * 60;
    const battery = pack > 0 ? (time / pack) * 100 : 0;
    const usable = pack * (1 - s.reservePct / 100);
    const runs = time > 0 ? Math.floor(usable / time) : null;

    const takeoffs = all.filter((it) => it.data.kind === 'marker' && it.data.type === 'takeoff' && it.data.visible)
      .map((it) => it.layer.getLatLng());
    let furthest = null;
    if (takeoffs.length) {
      const targets = [];
      visibleRoutes.forEach((it) => targets.push(...flatLatLngs(it.layer)));
      all.forEach((it) => {
        if (it.data.kind === 'marker' && it.data.visible && ['dive', 'gap', 'hazard', 'note'].includes(it.data.type)) targets.push(it.layer.getLatLng());
      });
      // The furthest point of a straight segment from the pilot is always one of its ends,
      // so checking vertices is enough.
      furthest = 0;
      targets.forEach((p) => {
        const nearest = Math.min(...takeoffs.map((t) => t.distanceTo(p)));
        if (nearest > furthest) furthest = nearest;
      });
    }
    return { routes, visibleRoutes, total, time, battery, runs, takeoffs, furthest };
  }

  function renderStats() {
    const s = state.settings;
    const st = computeStats();
    const hidden = st.routes.length - st.visibleRoutes.length;

    $('#total-distance').textContent = fmtDist(st.total);
    $('#total-caption').textContent = st.visibleRoutes.length
      ? `Total of ${st.visibleRoutes.length} route${st.visibleRoutes.length > 1 ? 's' : ''}${hidden ? `, ${hidden} hidden` : ''}`
      : (hidden ? `${hidden} hidden route${hidden > 1 ? 's' : ''}` : 'No routes yet');

    const timeEl = $('#stat-time'), batEl = $('#stat-battery'), runsEl = $('#stat-runs'), rangeEl = $('#stat-range');
    const usableShare = 100 - s.reservePct;
    const batClass = st.battery > 100 ? 'bad' : st.battery > usableShare ? 'warn' : '';

    timeEl.textContent = st.total ? fmtDuration(st.time) : '–';
    batEl.textContent = st.total ? `${Math.round(st.battery)}%` : '–';
    batEl.className = st.total ? batClass : '';
    runsEl.textContent = st.runs === null ? '–' : String(st.runs);
    runsEl.className = st.runs === 0 ? 'bad' : '';

    const fill = $('#battery-fill');
    fill.style.width = `${clamp(st.battery, 0, 100)}%`;
    fill.className = `battery-fill ${batClass}`;
    $('#battery-reserve').style.width = `${clamp(s.reservePct, 0, 100)}%`;

    let rangeClass = '';
    if (st.furthest === null) {
      rangeEl.textContent = '–';
    } else {
      rangeEl.textContent = fmtDist(st.furthest);
      rangeClass = st.furthest > s.rangeM ? 'bad' : st.furthest > s.rangeM * CONFIG.rangeWarnShare ? 'warn' : '';
    }
    rangeEl.className = rangeClass;

    const note = $('#flight-note');
    let text = '', bad = false;
    if (rangeClass === 'bad') {
      text = `Part of the plan is ${fmtDist(st.furthest - s.rangeM)} beyond your ${fmtDist(s.rangeM)} link range.`;
      bad = true;
    } else if (st.total && st.battery > usableShare) {
      text = `This route needs ${Math.round(st.battery)}% of a pack, more than the ${usableShare}% you allow before the reserve.`;
      bad = true;
    } else if (rangeClass === 'warn') {
      text = `Close to the edge of your ${fmtDist(s.rangeM)} link range.`;
    } else if (st.furthest === null) {
      text = 'Place a takeoff marker to check your range.';
    } else {
      text = `Everything is inside your ${fmtDist(s.rangeM)} link range.`;
    }
    note.textContent = text;
    note.classList.toggle('bad', bad);

    // Phone summary chip
    $('#chip-dist').textContent = fmtDist(st.total);
    const sub = $('#chip-sub');
    if (rangeClass === 'bad') sub.textContent = 'Beyond link range';
    else if (st.total) sub.replaceChildren(el('span', {}, fmtDuration(st.time)), el('span', {}, `${Math.round(st.battery)}% pack`));
    else sub.textContent = hidden ? 'All routes hidden' : 'No routes yet';
    const chip = $('#stats-chip');
    const chipBad = rangeClass === 'bad' || batClass === 'bad';
    chip.classList.toggle('bad', chipBad);
    chip.classList.toggle('warn', !chipBad && (rangeClass === 'warn' || batClass === 'warn'));
  }

  function renderList() {
    const list = $('#item-list');
    const active = document.activeElement;
    // Don't rebuild under someone who is typing a name.
    if (active && list.contains(active) && active.classList.contains('item-name')) return;

    const s = state.settings;
    const takeoffs = [...items.values()].filter((it) => it.data.kind === 'marker' && it.data.type === 'takeoff' && it.data.visible)
      .map((it) => it.layer.getLatLng());
    const ordered = [...items.values()].sort((a, b) => (a.data.kind === b.data.kind ? 0 : a.data.kind === 'route' ? -1 : 1));

    list.replaceChildren(...ordered.map(({ data, layer }) => {
      const isRoute = data.kind === 'route';
      let meta = '';
      if (isRoute) meta = fmtDist(pathLength(flatLatLngs(layer)));
      else if (data.type !== 'takeoff' && takeoffs.length) {
        meta = fmtDist(Math.min(...takeoffs.map((t) => t.distanceTo(layer.getLatLng()))));
      }

      const swatch = isRoute
        ? el('button', {
            class: 'item-color', type: 'button', style: `--c:${data.color}`,
            title: `Ink: ${INK_NAMES[data.color] || data.color}. Click to change`,
            'aria-label': `Change ink colour of ${data.name}`,
            onclick: () => { data.color = INKS[(INKS.indexOf(data.color) + 1) % INKS.length]; commit(); },
          })
        : el('span', {
            class: 'badge', style: `--c:${MARKER_TYPES[data.type].color}`, title: MARKER_TYPES[data.type].label,
            html: `<svg viewBox="0 0 24 24"><path d="${MARKER_TYPES[data.type].path}"/></svg>`,
          });

      const name = el('input', {
        class: 'item-name', type: 'text', value: data.name, 'aria-label': 'Name', spellcheck: 'false',
        oninput: (e) => { data.name = e.target.value; scheduleLive(); },
        onchange: (e) => { data.name = e.target.value.trim() || data.name; commit(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
      });

      const actions = el('div', { class: 'item-actions' },
        el('button', {
          type: 'button', title: data.visible ? 'Hide' : 'Show', 'aria-label': `${data.visible ? 'Hide' : 'Show'} ${data.name}`,
          html: icon(data.visible ? 'i-eye' : 'i-eye-off'),
          onclick: () => { data.visible = !data.visible; commit(); },
        }),
        isRoute ? el('button', {
          type: 'button', title: 'Reverse direction', 'aria-label': `Reverse ${data.name}`, html: icon('i-reverse'),
          onclick: () => { layer.setLatLngs(flatLatLngs(layer).slice().reverse()); commit(); },
        }) : el('span', { class: 'spacer', 'aria-hidden': 'true' }),
        el('button', {
          type: 'button', title: 'Zoom to', 'aria-label': `Zoom to ${data.name}`, html: icon('i-focus'),
          onclick: () => focusItem(data.id),
        }),
        el('button', {
          type: 'button', class: 'del', title: 'Delete', 'aria-label': `Delete ${data.name}`, html: icon('i-trash'),
          onclick: () => deleteItem(data.id),
        }),
      );

      return el('li', {
        class: `item${data.visible ? '' : ' is-hidden'}`,
        'data-id': data.id,
        onmouseenter: () => highlight(data.id, true),
        onmouseleave: () => highlight(data.id, false),
      }, swatch, name, el('span', {
        class: 'item-meta',
        title: isRoute ? 'Route length' : meta ? 'Distance from takeoff' : null,
      }, meta), actions);
    }));

    $('#item-count').textContent = items.size ? String(items.size) : '';
    $('#items-empty').hidden = items.size > 0;
  }

  function highlight(id, on) {
    const it = items.get(id);
    if (!it || !it.data.visible) return;
    if (it.data.kind === 'route') it.layer.setStyle({ weight: state.settings.weight + (on ? 3 : 0) });
    else if (it.layer._icon) it.layer._icon.style.filter = on ? 'brightness(1.25) drop-shadow(0 0 6px rgba(255,255,255,.7))' : '';
  }

  function flashItem(id) {
    const li = document.querySelector(`.item[data-id="${id}"]`);
    if (!li) return;
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  }

  function focusItem(id) {
    const it = items.get(id);
    if (!it) return;
    if (!it.data.visible) { it.data.visible = true; commit(); }
    if (it.data.kind === 'route') map.fitBounds(it.layer.getBounds(), { padding: [60, 60], maxZoom: 19 });
    else map.setView(it.layer.getLatLng(), Math.max(map.getZoom(), 17));
  }

  function deleteItem(id) {
    const it = items.get(id);
    if (!it) return;
    it.layer.remove();
    items.delete(id);
    commit();
    toast(`Deleted ${it.data.name}`, { label: 'Undo', fn: undo });
  }

  function clearAll() {
    if (!items.size) return;
    const n = items.size;
    setTool(null, { discard: true });
    items.forEach(({ layer }) => layer.remove());
    items.clear();
    commit();
    toast(`Cleared ${n} item${n > 1 ? 's' : ''} from the sheet`, { label: 'Undo', fn: undo });
  }

  /* ---------------------------------------------------------
     Toolbar UI, hint bar
     --------------------------------------------------------- */
  function buildToolbars() {
    const inkRow = $('#ink-row');
    INKS.forEach((c) => {
      inkRow.append(el('button', {
        class: 'swatch', type: 'button', role: 'radio', style: `--c:${c}`,
        'data-ink': c, title: INK_NAMES[c], 'aria-label': `${INK_NAMES[c]} ink`,
        onclick: () => {
          state.ink = c;
          updateToolUI();
          saveSoon();
          if (state.tool === 'line' && lineVertexCount() === 0) startLineDraw();
        },
      }));
    });

    const grid = $('#marker-grid');
    Object.entries(MARKER_TYPES).forEach(([type, t]) => {
      grid.append(el('button', {
        class: 'tool compact marker-tool', type: 'button', 'data-tool': `marker:${type}`, 'aria-pressed': 'false',
        title: `Place ${t.label.toLowerCase()} marker (${t.key})`,
        html: `<span class="badge" style="--c:${t.color}"><svg viewBox="0 0 24 24"><path d="${t.path}"/></svg></span><span>${t.label}</span><kbd>${t.key}</kbd>`,
      }));
    });

    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => toggleTool(btn.dataset.tool));
    });
  }

  function updateToolUI() {
    document.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === state.tool));
    });
    document.querySelectorAll('.swatch').forEach((sw) => {
      sw.setAttribute('aria-checked', String(sw.dataset.ink === state.ink));
    });
    const mt = state.tool && state.tool.startsWith('marker:') ? state.tool.slice(7) : null;
    $('#dock-marker').setAttribute('aria-pressed', String(!!mt));
    $('#dock-marker-ico').innerHTML = mt ? badgeHtml(mt) : icon('i-pin');
    $('#dock-marker-label').textContent = mt ? MARKER_TYPES[mt].label : 'Marker';
    document.querySelectorAll('.sheet-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.marker === mt)));
  }

  function updateHistoryUI() {
    $('#undo-btn').disabled = !history.undo.length && lineVertexCount() === 0;
    $('#redo-btn').disabled = !history.redo.length;
    $('#clear-btn').disabled = items.size === 0;
    $('#dock-undo').disabled = $('#undo-btn').disabled;
  }

  const HINTS = {
    line: ['Line', 'Click to add points. Double-click or <kbd>Enter</kbd> to finish, <kbd>Backspace</kbd> removes the last point.'],
    freehand: ['Freehand', 'Press and drag to draw a smooth path. Hold <kbd>Space</kbd> to pan.'],
    edit: ['Edit points', 'Drag a point to reshape. Drag a midpoint to add one, right-click a point to remove it.'],
    move: ['Move', 'Drag a route or marker to a new spot.'],
    erase: ['Erase', 'Click a route or marker to erase it.'],
  };
  const TOUCH_HINTS = {
    line: ['Line', 'Tap to add points. Tap the last point or Finish to end the line.'],
    freehand: ['Freehand', 'Draw with one finger. Use two fingers to move and zoom the map.'],
    edit: ['Edit points', 'Drag a point to reshape, drag a midpoint to add one, tap a point to delete it.'],
    move: ['Move', 'Drag a route or marker to a new spot.'],
    erase: ['Erase', 'Tap a route or marker to erase it.'],
  };

  let liveText = '';
  function setLive(main, sub) {
    liveText = main ? `${main}${sub ? ` <small>${sub}</small>` : ''}` : '';
    const live = document.querySelector('#hint .hint-live');
    if (live) live.innerHTML = liveText;
  }

  // The bar shown while drawing a line: running length, Undo point and Finish.
  function updateLineBar(total, leg) {
    const bar = $('#line-bar');
    bar.hidden = state.tool !== 'line';
    if (bar.hidden) return;
    const n = lineVertexCount();
    if (total === undefined) {
      total = fmtDist(n ? pathLength(flatLatLngs(map.pm.Draw.Line._layer)) : 0);
      leg = n ? `${n} point${n > 1 ? 's' : ''}` : `${isTouch() ? 'Tap' : 'Click'} the map to start`;
    }
    $('#line-total').textContent = total;
    $('#line-leg').textContent = leg || '';
    $('#line-undo').disabled = n === 0;
    $('#line-finish').disabled = n < 2;
  }

  function updateHint() {
    const hint = $('#hint');
    const touch = isTouch();
    const hints = touch ? TOUCH_HINTS : HINTS;
    let title = '', text = '';
    if (state.tool && hints[state.tool]) [title, text] = hints[state.tool];
    else if (state.tool && state.tool.startsWith('marker:')) {
      const t = MARKER_TYPES[state.tool.slice(7)];
      title = t.label;
      text = `${touch ? 'Tap' : 'Click'} the map to place a ${t.label.toLowerCase()} marker.`;
    } else if (!items.size) {
      text = mobileQuery.matches
        ? 'Search for your spot under <b>More</b>, then pick <b>Line</b> or <b>Freehand</b> to trace a route.'
        : 'Find your spot, then pick <b>Line</b> or <b>Freehand</b> to start tracing a route.';
    }
    if (!text) { hint.hidden = true; return; }
    if (state.tool) text += touch ? ' Tap the tool again to stop.' : ' <kbd>Esc</kbd> to stop.';
    hint.innerHTML = `${title ? `<span class="hint-tool">${title}</span>` : ''}<span class="hint-text">${text}</span><span class="hint-live">${liveText}</span>`;
    hint.hidden = false;
  }

  /* ---------------------------------------------------------
     Tracing paper and settings controls
     --------------------------------------------------------- */
  function applyKalke() {
    const s = state.settings;
    const tint = TINTS[s.tint] || TINTS.vellum;
    document.body.classList.toggle('kalke-on', s.kalkeOn);
    document.body.classList.toggle('flow-on', s.flow);
    document.documentElement.style.setProperty('--paper', tint.paper);
    document.documentElement.style.setProperty('--mark', tint.mark);
    map.getPane('tilePane').style.opacity = s.kalkeOn ? String(1 - s.paper) : '1';
  }

  function speedToDisplay(kmh) { return state.settings.units === 'imperial' ? Math.round(kmh / 1.609344) : Math.round(kmh); }
  function rangeToDisplay(m) { return state.settings.units === 'imperial' ? Math.round(m * 3.28084 / 10) * 10 : Math.round(m); }

  function syncControls() {
    const s = state.settings;
    $('#plan-name').value = state.planName;
    $('#basemap-select').value = s.basemap;
    $('#kalke-toggle').checked = s.kalkeOn;
    $('#paper-range').value = Math.round(s.paper * 100);
    $('#paper-out').textContent = `${Math.round(s.paper * 100)}%`;
    $('#ink-range').value = Math.round(s.inkOpacity * 100);
    $('#ink-out').textContent = `${Math.round(s.inkOpacity * 100)}%`;
    $('#weight-range').value = s.weight;
    $('#weight-out').textContent = `${s.weight} px`;
    $('#labels-toggle').checked = s.labels;
    $('#ring-toggle').checked = s.ring;
    $('#flow-toggle').checked = s.flow;
    document.querySelectorAll('[data-tint]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tint === s.tint)));
    document.querySelectorAll('[data-units]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.units === s.units)));
    $('#speed-input').value = speedToDisplay(s.speedKmh);
    $('#speed-unit').textContent = s.units === 'imperial' ? 'mph' : 'km/h';
    $('#pack-input').value = s.packMin;
    $('#reserve-input').value = s.reservePct;
    $('#range-input').value = rangeToDisplay(s.rangeM);
    $('#range-unit').textContent = s.units === 'imperial' ? 'ft' : 'm';
  }

  function settingChanged() {
    applyKalke();
    renderAll();
    saveSoon();
  }

  function bindControls() {
    const s = state.settings;

    $('#plan-name').addEventListener('input', (e) => { state.planName = e.target.value; saveSoon(); });
    $('#basemap-select').addEventListener('change', (e) => { setBasemap(e.target.value); saveSoon(); });

    $('#kalke-toggle').addEventListener('change', (e) => { s.kalkeOn = e.target.checked; settingChanged(); });
    $('#paper-range').addEventListener('input', (e) => {
      s.paper = Number(e.target.value) / 100;
      $('#paper-out').textContent = `${e.target.value}%`;
      if (!s.kalkeOn && s.paper > 0) { s.kalkeOn = true; $('#kalke-toggle').checked = true; }
      applyKalke();
      saveSoon();
    });
    $('#ink-range').addEventListener('input', (e) => {
      s.inkOpacity = Number(e.target.value) / 100;
      $('#ink-out').textContent = `${e.target.value}%`;
      applyLayers();
      renderDecorations();
      saveSoon();
    });
    $('#weight-range').addEventListener('input', (e) => {
      s.weight = Number(e.target.value);
      $('#weight-out').textContent = `${s.weight} px`;
      applyLayers();
      if (state.tool === 'line' && lineVertexCount() === 0) startLineDraw();
      saveSoon();
    });
    $('#labels-toggle').addEventListener('change', (e) => { s.labels = e.target.checked; settingChanged(); });
    $('#ring-toggle').addEventListener('change', (e) => { s.ring = e.target.checked; settingChanged(); });
    $('#flow-toggle').addEventListener('change', (e) => { s.flow = e.target.checked; settingChanged(); });

    document.querySelectorAll('[data-tint]').forEach((b) => b.addEventListener('click', () => {
      s.tint = b.dataset.tint;
      if (!s.kalkeOn) s.kalkeOn = true;
      syncControls();
      settingChanged();
    }));

    document.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
      s.units = b.dataset.units;
      syncControls();
      setScaleControl();
      settingChanged();
    }));

    const numberInput = (sel, apply) => $(sel).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!isFinite(v) || v < 0) return;
      apply(v);
      renderStats();
      renderDecorations();
      saveSoon();
    });
    numberInput('#speed-input', (v) => { if (v > 0) s.speedKmh = s.units === 'imperial' ? v * 1.609344 : v; });
    numberInput('#pack-input', (v) => { if (v > 0) s.packMin = v; });
    numberInput('#reserve-input', (v) => { s.reservePct = clamp(v, 0, 95); });
    numberInput('#range-input', (v) => { if (v > 0) s.rangeM = s.units === 'imperial' ? v / 3.28084 : v; });

    $('#undo-btn').addEventListener('click', undo);
    $('#redo-btn').addEventListener('click', redo);
    $('#clear-btn').addEventListener('click', clearAll);

    $('#export-geojson').addEventListener('click', exportGeoJSON);
    $('#export-kml').addEventListener('click', exportKML);
    $('#export-png').addEventListener('click', exportImage);
    $('#import-btn').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importFile(file);
      e.target.value = '';
    });

    $('#panel-open').addEventListener('click', () => setPanel(!document.body.classList.contains('panel-open')));
    $('#panel-close').addEventListener('click', () => setPanel(false));
    $('#backdrop').addEventListener('click', () => setPanel(false));
    $('#stats-chip').addEventListener('click', () => setPanel(true, '#h-flight'));
    $('#line-undo').addEventListener('click', removeLastVertex);
    $('#line-finish').addEventListener('click', finishLine);
    $('#map-locate').addEventListener('click', locateMe);
    onMediaChange(mobileQuery, () => { setPanel(false); updateHint(); });
    onMediaChange(touchQuery, updateHint);

    bindSearch();
  }

  /* ---------------------------------------------------------
     Search and location
     --------------------------------------------------------- */
  function bindSearch() {
    const form = $('#search-form'), input = $('#search-input'), results = $('#search-results');
    const hide = () => { results.hidden = true; };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;

      const coord = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (coord) {
        const lat = parseFloat(coord[1]), lng = parseFloat(coord[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          map.setView([lat, lng], 17);
          hide();
          return;
        }
      }

      results.replaceChildren(el('li', { class: 'muted' }, 'Searching…'));
      results.hidden = false;
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.length) {
          results.replaceChildren(el('li', { class: 'muted' }, 'No places found. Try a town name or paste coordinates.'));
          return;
        }
        results.replaceChildren(...data.map((r) => {
          const [first, ...rest] = r.display_name.split(', ');
          return el('li', {}, el('button', {
            type: 'button',
            onclick: () => {
              const bb = r.boundingbox && r.boundingbox.map(Number);
              if (bb && bb.every(isFinite)) map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17 });
              else map.setView([Number(r.lat), Number(r.lon)], 16);
              hide();
            },
          }, first, el('small', {}, rest.join(', '))));
        }));
      } catch (err) {
        results.replaceChildren(el('li', { class: 'muted' }, 'Search is unavailable right now. Check your connection, or paste coordinates as lat, lon.'));
      }
    });

    document.addEventListener('click', (e) => { if (!form.contains(e.target)) hide(); });

    $('#locate-btn').addEventListener('click', locateMe);
  }

  /* ---------------------------------------------------------
     Export: GeoJSON, KML
     --------------------------------------------------------- */
  function toGeoJSON() {
    const st = computeStats();
    const s = state.settings;
    return {
      type: 'FeatureCollection',
      name: state.planName || 'FPV route plan',
      kalke: {
        generator: 'Kalke FPV route planner',
        exported: new Date().toISOString(),
        total_length_m: Math.round(st.total * 10) / 10,
        estimate: {
          speed_kmh: s.speedKmh, pack_minutes: s.packMin, reserve_percent: s.reservePct,
          flight_time_s: Math.round(st.time), link_range_m: Math.round(s.rangeM),
        },
      },
      features: [...items.values()].map(({ data, layer }) => {
        if (data.kind === 'route') {
          const ll = flatLatLngs(layer);
          return {
            type: 'Feature',
            properties: {
              name: data.name, kind: 'route', mode: data.mode, color: data.color,
              stroke: data.color, 'stroke-width': s.weight, visible: data.visible,
              length_m: Math.round(pathLength(ll) * 10) / 10,
            },
            geometry: { type: 'LineString', coordinates: ll.map((p) => [r7(p.lng), r7(p.lat)]) },
          };
        }
        const p = layer.getLatLng();
        return {
          type: 'Feature',
          properties: {
            name: data.name, kind: 'marker', markerType: data.type,
            'marker-color': MARKER_TYPES[data.type].color, visible: data.visible,
          },
          geometry: { type: 'Point', coordinates: [r7(p.lng), r7(p.lat)] },
        };
      }),
    };
  }

  async function exportGeoJSON() {
    if (!items.size) { toast('Nothing to export yet. Draw a route or place a marker first.'); return; }
    const blob = new Blob([JSON.stringify(toGeoJSON(), null, 2)], { type: 'application/geo+json' });
    if (await deliver(blob, `${fileBase()}.geojson`) === 'saved') toast('Saved GeoJSON file');
  }

  // KML colours are aabbggrr
  function kmlColor(hex, alpha) {
    const a = Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, '0');
    return `${a}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toLowerCase();
  }

  const KML_ICONS = {
    takeoff: 'grn-circle', landing: 'blu-circle', dive: 'pink-circle',
    gap: 'ylw-circle', hazard: 'red-diamond', note: 'wht-blank',
  };

  function toKML() {
    const s = state.settings;
    const x = escapeHtml;
    const data = (name, value) => `<Data name="${name}"><value>${x(value)}</value></Data>`;
    const placemarks = [...items.values()].map(({ data: d, layer }) => {
      if (d.kind === 'route') {
        const ll = flatLatLngs(layer);
        const coords = ll.map((p) => `${r7(p.lng)},${r7(p.lat)},0`).join(' ');
        return `    <Placemark>
      <name>${x(d.name)}</name>
      <visibility>${d.visible ? 1 : 0}</visibility>
      <description>${x(`Length ${fmtDist(pathLength(ll))}`)}</description>
      <Style><LineStyle><color>${kmlColor(d.color, s.inkOpacity)}</color><width>${s.weight}</width></LineStyle></Style>
      <ExtendedData>${data('kind', 'route')}${data('mode', d.mode)}${data('color', d.color)}${data('length_m', Math.round(pathLength(ll)))}</ExtendedData>
      <LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${coords}</coordinates></LineString>
    </Placemark>`;
      }
      const p = layer.getLatLng();
      return `    <Placemark>
      <name>${x(d.name)}</name>
      <visibility>${d.visible ? 1 : 0}</visibility>
      <description>${x(MARKER_TYPES[d.type].label)}</description>
      <Style><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/paddle/${KML_ICONS[d.type]}.png</href></Icon></IconStyle></Style>
      <ExtendedData>${data('kind', 'marker')}${data('markerType', d.type)}</ExtendedData>
      <Point><coordinates>${r7(p.lng)},${r7(p.lat)},0</coordinates></Point>
    </Placemark>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${x(state.planName || 'FPV route plan')}</name>
    <description>${x(`Exported from Kalke on ${new Date().toLocaleString()}. Total ${fmtDist(computeStats().total)}.`)}</description>
${placemarks.join('\n')}
  </Document>
</kml>
`;
  }

  async function exportKML() {
    if (!items.size) { toast('Nothing to export yet. Draw a route or place a marker first.'); return; }
    const blob = new Blob([toKML()], { type: 'application/vnd.google-earth.kml+xml' });
    if (await deliver(blob, `${fileBase()}.kml`) === 'saved') toast('Saved KML file');
  }

  /* ---------------------------------------------------------
     Import: GeoJSON, KML
     --------------------------------------------------------- */
  function fromGeoJSON(obj) {
    const out = [];
    const feats = obj.type === 'FeatureCollection' ? obj.features
      : obj.type === 'Feature' ? [obj]
      : obj.type ? [{ type: 'Feature', properties: {}, geometry: obj }] : [];

    const addGeom = (g, p) => {
      if (!g) return;
      const color = isHex(p.color) ? p.color : isHex(p.stroke) ? p.stroke : null;
      const route = (coords) => {
        const c = coords.filter((xy) => isFinite(xy[0]) && isFinite(xy[1])).map((xy) => [xy[1], xy[0]]);
        if (c.length >= 2) out.push({ kind: 'route', name: p.name, color: color || INKS[out.length % INKS.length], mode: p.mode, visible: p.visible, coords: c });
      };
      const point = (xy) => {
        if (!isFinite(xy[0]) || !isFinite(xy[1])) return;
        out.push({ kind: 'marker', name: p.name, type: p.markerType || guessType(p.name), visible: p.visible, coords: [xy[1], xy[0]] });
      };
      switch (g.type) {
        case 'LineString': route(g.coordinates); break;
        case 'MultiLineString': g.coordinates.forEach(route); break;
        case 'Polygon': if (g.coordinates[0]) route(g.coordinates[0]); break;
        case 'MultiPolygon': g.coordinates.forEach((poly) => poly[0] && route(poly[0])); break;
        case 'Point': point(g.coordinates); break;
        case 'MultiPoint': g.coordinates.forEach(point); break;
        case 'GeometryCollection': g.geometries.forEach((gg) => addGeom(gg, p)); break;
        default: break;
      }
    };
    feats.forEach((f) => f && addGeom(f.geometry, f.properties || {}));
    return out;
  }

  function guessType(name) {
    const n = String(name || '').toLowerCase();
    return Object.keys(MARKER_TYPES).find((t) => n.includes(t)) || 'note';
  }

  function fromKML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This KML file could not be read.');
    const out = [];
    const childText = (node, tag) => {
      const n = [...node.children].find((c) => c.localName === tag);
      return n ? n.textContent.trim() : '';
    };
    const parseCoords = (t) => t.trim().split(/\s+/).map((s) => s.split(',').map(Number))
      .filter((a) => isFinite(a[0]) && isFinite(a[1])).map((a) => [a[1], a[0]]);

    [...doc.getElementsByTagName('Placemark')].forEach((pm) => {
      const name = childText(pm, 'name');
      const ext = {};
      [...pm.getElementsByTagName('Data')].forEach((d) => {
        const v = d.getElementsByTagName('value')[0];
        if (v) ext[d.getAttribute('name')] = v.textContent.trim();
      });
      let color = isHex(ext.color) ? ext.color : null;
      const lc = pm.querySelector('LineStyle > color');
      if (!color && lc && /^[0-9a-f]{8}$/i.test(lc.textContent.trim())) {
        const c = lc.textContent.trim();
        color = `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}`.toLowerCase();
      }
      const visible = childText(pm, 'visibility') !== '0';

      [...pm.getElementsByTagName('LineString'), ...pm.getElementsByTagName('LinearRing')].forEach((ls) => {
        const c = ls.getElementsByTagName('coordinates')[0];
        const coords = c ? parseCoords(c.textContent) : [];
        if (coords.length >= 2) out.push({ kind: 'route', name, color: color || INKS[out.length % INKS.length], mode: ext.mode, visible, coords });
      });
      [...pm.getElementsByTagName('Point')].forEach((pt) => {
        const c = pt.getElementsByTagName('coordinates')[0];
        const coords = c ? parseCoords(c.textContent) : [];
        if (coords.length) out.push({ kind: 'marker', name, type: ext.markerType || guessType(name), visible, coords: coords[0] });
      });
    });
    return out;
  }

  async function importFile(file) {
    try {
      const text = await file.text();
      const parsed = text.trim().startsWith('<') ? fromKML(text) : fromGeoJSON(JSON.parse(text));
      if (!parsed.length) { toast(`${file.name} has no lines or points to open.`); return; }
      setTool(null);
      const layers = parsed.map((raw) => addItem(raw));
      commit();
      const bounds = L.latLngBounds([]);
      layers.forEach((l) => bounds.extend(l.getBounds ? l.getBounds() : l.getLatLng()));
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 18 });
      if (!state.planName) {
        state.planName = file.name.replace(/\.(geo)?json$|\.kml$/i, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
        $('#plan-name').value = state.planName;
        saveSoon();
      }
      toast(`Opened ${parsed.length} item${parsed.length > 1 ? 's' : ''} from ${file.name}`);
    } catch (err) {
      toast(`Could not open ${file.name}. Use a GeoJSON or KML file.`);
    }
  }

  /* ---------------------------------------------------------
     Export: PNG image of the current view
     --------------------------------------------------------- */
  async function exportImage() {
    const btn = $('#export-png');
    btn.disabled = true;
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const size = map.getSize();
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      const ctx = canvas.getContext('2d');

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSheet(ctx, size, true);
      let blob, withoutImagery = false;
      try {
        blob = await canvasToBlob(canvas);
      } catch (err) {
        // A tile server without CORS headers "taints" the canvas. Draw the ink on plain paper instead.
        withoutImagery = true;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawSheet(ctx, size, false);
        blob = await canvasToBlob(canvas);
      }
      const how = await deliver(blob, `${fileBase()}.png`);
      if (withoutImagery && how !== 'cancelled') toast('The image has no map imagery: the tile server blocked access. Try the Satellite base map.');
      else if (how === 'saved') toast('Saved image of the current view');
    } catch (err) {
      toast('Could not create the image. Try again once the map has finished loading.');
    } finally {
      btn.disabled = false;
    }
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('empty'))), 'image/png');
      } catch (err) { reject(err); }
    });
  }

  function drawSheet(ctx, size, withTiles) {
    const s = state.settings;
    const tint = TINTS[s.tint] || TINTS.vellum;
    ctx.fillStyle = s.kalkeOn ? tint.paper : '#1b1e22';
    ctx.fillRect(0, 0, size.x, size.y);

    if (withTiles) {
      const box = mapEl.getBoundingClientRect();
      ctx.globalAlpha = s.kalkeOn ? 1 - s.paper : 1;
      mapEl.querySelectorAll('.leaflet-tile-pane .leaflet-layer').forEach((layerEl) => {
        const levels = [...layerEl.querySelectorAll('.leaflet-tile-container')]
          .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
        levels.forEach((level) => {
          level.querySelectorAll('img.leaflet-tile-loaded').forEach((img) => {
            const r = img.getBoundingClientRect();
            if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return;
            ctx.drawImage(img, r.left - box.left, r.top - box.top, r.width, r.height);
          });
        });
      });
      ctx.globalAlpha = 1;
    }

    drawInk(ctx);
    drawLegend(ctx, size);
  }

  function drawInk(ctx) {
    const s = state.settings;
    const pt = (ll) => map.latLngToContainerPoint(ll);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Range rings
    if (s.ring) {
      items.forEach(({ data, layer }) => {
        if (data.kind !== 'marker' || data.type !== 'takeoff' || !data.visible) return;
        const ll = layer.getLatLng();
        const b = ll.toBounds(s.rangeM * 2);
        const c = pt(ll);
        const rx = Math.abs(pt(b.getNorthEast()).x - pt(b.getSouthWest()).x) / 2;
        ctx.save();
        ctx.setLineDash([6, 8]);
        ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.beginPath(); ctx.arc(c.x, c.y, rx, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.6; ctx.strokeStyle = MARKER_TYPES.takeoff.color;
        ctx.beginPath(); ctx.arc(c.x, c.y, rx, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      });
    }

    // Routes
    const labels = [];
    items.forEach(({ data, layer }) => {
      if (data.kind !== 'route' || !data.visible) return;
      const ll = flatLatLngs(layer);
      if (ll.length < 2) return;
      const pts = ll.map(pt);
      const trace = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };

      ctx.save();
      ctx.globalAlpha = s.inkOpacity;
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = s.weight + 2.6; trace(); ctx.stroke();
      ctx.strokeStyle = data.color; ctx.lineWidth = s.weight; trace(); ctx.stroke();

      // start ring
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#15181c'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = data.color; ctx.stroke();

      // end arrow
      const end = pts[pts.length - 1];
      const ang = segmentAngle(ll[ll.length - 2], ll[ll.length - 1]) * Math.PI / 180;
      ctx.translate(end.x, end.y); ctx.rotate(ang); ctx.translate(-9, -9);
      const arrow = new Path2D('M3 3.5 16 9 3 14.5 6 9z');
      ctx.fillStyle = data.color; ctx.fill(arrow);
      ctx.lineWidth = 1.4; ctx.strokeStyle = '#15181c'; ctx.stroke(arrow);
      ctx.restore();

      if (s.labels) labels.push({ at: pt(pointAlong(ll, 0.5)), name: data.name, value: fmtDist(pathLength(ll)), color: data.color });
    });

    // Markers
    items.forEach(({ data, layer }) => {
      if (data.kind !== 'marker' || !data.visible) return;
      const t = MARKER_TYPES[data.type];
      const p = pt(layer.getLatLng());
      ctx.save();
      ctx.globalAlpha = Math.max(s.inkOpacity, 0.35);
      ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 16.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
      ctx.fillStyle = '#15181c'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = t.color; ctx.fill();
      ctx.translate(p.x - 9, p.y - 9); ctx.scale(0.75, 0.75);
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#15181c'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(t.path));
      ctx.restore();
      if (s.labels) labels.push({ at: L.point(p.x, p.y - 30), name: data.name, value: '', color: null });
    });

    // Labels on top of everything
    labels.forEach((lb) => drawPill(ctx, lb));
  }

  function drawPill(ctx, { at, name, value, color }) {
    ctx.save();
    ctx.font = '500 12px Barlow, system-ui, sans-serif';
    const nameW = ctx.measureText(name).width;
    ctx.font = '600 12px Barlow, system-ui, sans-serif';
    const valW = value ? ctx.measureText(value).width + 6 : 0;
    const w = nameW + valW + (color ? 18 : 14), h = 20;
    const x = at.x - w / 2, y = at.y - h / 2;
    ctx.fillStyle = 'rgba(21,24,28,.88)';
    roundRect(ctx, x, y, w, h, 3); ctx.fill();
    if (color) { ctx.fillStyle = color; ctx.fillRect(x, y, 3, h); }
    ctx.fillStyle = '#ecebe2';
    ctx.textBaseline = 'middle';
    ctx.font = '500 12px Barlow, system-ui, sans-serif';
    ctx.fillText(name, x + (color ? 10 : 7), at.y + 0.5);
    if (value) { ctx.font = '600 12px Barlow, system-ui, sans-serif'; ctx.fillText(value, x + (color ? 10 : 7) + nameW + 6, at.y + 0.5); }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function niceScale(maxMeters) {
    const imperial = state.settings.units === 'imperial';
    const unit = imperial ? (maxMeters * 3.28084 > 5280 ? 1609.344 : 0.3048) : (maxMeters >= 1000 ? 1000 : 1);
    const maxUnits = maxMeters / unit;
    const pow = Math.pow(10, Math.floor(Math.log10(maxUnits)));
    const d = maxUnits / pow;
    const n = (d >= 5 ? 5 : d >= 2 ? 2 : 1) * pow;
    const label = imperial ? `${n} ${unit === 0.3048 ? 'ft' : 'mi'}` : `${n} ${unit === 1 ? 'm' : 'km'}`;
    return { meters: n * unit, label };
  }

  function drawLegend(ctx, size) {
    const st = computeStats();
    const s = state.settings;
    const title = state.planName || 'FPV route plan';
    const lines = [];
    if (st.total) {
      lines.push(`${fmtDist(st.total)} total, about ${fmtDuration(st.time)} at ${speedToDisplay(s.speedKmh)} ${s.units === 'imperial' ? 'mph' : 'km/h'}`);
      lines.push(`${Math.round(st.battery)}% of a ${s.packMin} min pack per run${st.runs !== null ? `, ${st.runs} run${st.runs === 1 ? '' : 's'} per pack` : ''}`);
    }
    if (st.furthest !== null) lines.push(`Furthest from takeoff ${fmtDist(st.furthest)} (link range ${fmtDist(s.rangeM)})`);
    lines.push(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));

    ctx.save();
    ctx.font = '600 16px Barlow, system-ui, sans-serif';
    let w = ctx.measureText(title).width;
    ctx.font = '400 12.5px Barlow, system-ui, sans-serif';
    lines.forEach((l) => { w = Math.max(w, ctx.measureText(l).width); });
    w += 28;
    const h = 22 + 20 + lines.length * 18;
    ctx.fillStyle = 'rgba(34,38,44,.92)';
    roundRect(ctx, 14, 14, w, h, 8); ctx.fill();
    ctx.fillStyle = '#ffd84a';
    ctx.fillRect(14, 14, 4, h);
    ctx.fillStyle = '#ecebe2';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 16px Barlow, system-ui, sans-serif';
    ctx.fillText(title, 28, 38);
    ctx.font = '400 12.5px Barlow, system-ui, sans-serif';
    lines.forEach((l, i) => {
      ctx.fillStyle = i === lines.length - 1 ? '#9ba1aa' : '#ecebe2';
      ctx.fillText(l, 28, 58 + i * 18);
    });

    // Scale bar
    const y = size.y - 22;
    const a = map.containerPointToLatLng([20, y]);
    const b = map.containerPointToLatLng([120, y]);
    const mpp = a.distanceTo(b) / 100;
    if (isFinite(mpp) && mpp > 0) {
      const sc = niceScale(mpp * 150);
      const px = sc.meters / mpp;
      ctx.fillStyle = 'rgba(21,24,28,.8)';
      roundRect(ctx, 14, y - 22, px + 20, 30, 5); ctx.fill();
      ctx.strokeStyle = '#ecebe2'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(24, y - 4); ctx.lineTo(24, y); ctx.lineTo(24 + px, y); ctx.lineTo(24 + px, y - 4); ctx.stroke();
      ctx.fillStyle = '#ecebe2'; ctx.font = '500 11.5px Barlow, system-ui, sans-serif';
      ctx.fillText(sc.label, 24, y - 9);
    }

    // North arrow
    const nx = size.x - 30, ny = 34;
    ctx.fillStyle = 'rgba(21,24,28,.8)';
    ctx.beginPath(); ctx.arc(nx, ny, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ecebe2';
    ctx.beginPath(); ctx.moveTo(nx, ny - 11); ctx.lineTo(nx + 6, ny + 5); ctx.lineTo(nx, ny + 2); ctx.lineTo(nx - 6, ny + 5); ctx.closePath(); ctx.fill();
    ctx.font = '600 10px Barlow, system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('N', nx, ny + 28 + 0);

    // Credit
    const credit = `${(BASEMAPS[s.basemap] || BASEMAPS.satellite).credit}  |  Leaflet`;
    ctx.textAlign = 'right';
    ctx.font = '400 10.5px Barlow, system-ui, sans-serif';
    const cw = ctx.measureText(credit).width;
    ctx.fillStyle = 'rgba(21,24,28,.75)';
    ctx.fillRect(size.x - cw - 16, size.y - 18, cw + 16, 18);
    ctx.fillStyle = '#c9ccd1';
    ctx.fillText(credit, size.x - 8, size.y - 5);
    ctx.restore();
  }

  /* ---------------------------------------------------------
     Phone layout: tool dock, marker sheet, drawer, live location
     --------------------------------------------------------- */
  function badgeHtml(type) {
    const t = MARKER_TYPES[type];
    return `<span class="badge" style="--c:${t.color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.path}"/></svg></span>`;
  }

  function buildDock() {
    const sheet = $('#marker-sheet');
    Object.entries(MARKER_TYPES).forEach(([type, t]) => {
      sheet.append(el('button', {
        type: 'button', class: 'sheet-btn', 'data-marker': type, 'aria-pressed': 'false',
        html: `${badgeHtml(type)}<span>${t.label}</span>`,
        onclick: () => {
          closeMarkerSheet();
          setTool(state.tool === `marker:${type}` ? null : `marker:${type}`); // tap the active one again to stop
        },
      }));
    });
    $('#dock-marker').addEventListener('click', () => (sheet.hidden ? openMarkerSheet() : closeMarkerSheet()));
    $('#dock-undo').addEventListener('click', undo);
    document.addEventListener('pointerdown', (e) => {
      if (sheet.hidden || sheet.contains(e.target) || $('#dock-marker').contains(e.target)) return;
      closeMarkerSheet();
    }, true);
  }

  function openMarkerSheet() {
    $('#marker-sheet').hidden = false;
    $('#dock-marker').setAttribute('aria-expanded', 'true');
  }

  function closeMarkerSheet() {
    const sheet = $('#marker-sheet');
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    $('#dock-marker').setAttribute('aria-expanded', 'false');
  }

  function setPanel(open, sectionSel) {
    const on = !!open && mobileQuery.matches;
    document.body.classList.toggle('panel-open', on);
    $('#backdrop').hidden = !on;
    $('#panel-open').setAttribute('aria-expanded', String(on));
    if (!on) return;
    closeMarkerSheet();
    const target = sectionSel && $(sectionSel);
    if (target) target.closest('.panel').scrollIntoView({ block: 'start' });
  }

  // "Go to my location": centre once, then keep a live dot on the map while you walk the spot.
  const loc = { watching: false, last: null, centerNext: false };

  function locateMe() {
    if (loc.last) map.setView(loc.last, Math.max(map.getZoom(), 17));
    else loc.centerNext = true;
    if (!loc.watching) {
      loc.watching = true;
      map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 10000 });
    }
  }

  function setLocateUI() {
    document.querySelectorAll('#locate-btn, #map-locate').forEach((b) => b.setAttribute('aria-pressed', String(loc.watching && !!loc.last)));
  }

  map.on('locationfound', (e) => {
    loc.last = e.latlng;
    locLayer.clearLayers();
    locLayer.addLayer(L.circle(e.latlng, Object.assign({ radius: e.accuracy, color: '#42d9ff', weight: 1, fillOpacity: 0.08 }, IGNORE)));
    locLayer.addLayer(L.marker(e.latlng, Object.assign({
      icon: L.divIcon({ className: 'loc-dot', iconSize: [14, 14], html: '<span></span>' }),
      keyboard: false,
    }, IGNORE)));
    if (loc.centerNext) {
      loc.centerNext = false;
      map.setView(e.latlng, Math.max(map.getZoom(), 17));
    }
    setLocateUI();
  });

  map.on('locationerror', (e) => {
    if (loc.last && e.code !== 1) return; // a hiccup while tracking: keep the last known position
    map.stopLocate();
    loc.watching = false;
    loc.centerNext = false;
    setLocateUI();
    toast('Your location is not available. Allow location access for this page in your browser or phone settings.');
  });

  /* ---------------------------------------------------------
     Keyboard
     --------------------------------------------------------- */
  const KEY_TOOLS = { l: 'line', f: 'freehand', e: 'edit', m: 'move', x: 'erase' };

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = (t.tagName === 'INPUT' && !['checkbox', 'range', 'radio', 'button'].includes(t.type))
      || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;

    if (e.key === 'Escape') {
      if (!$('#search-results').hidden) { $('#search-results').hidden = true; return; }
      if (!$('#marker-sheet').hidden) { closeMarkerSheet(); return; }
      if (document.body.classList.contains('panel-open')) { setPanel(false); return; }
      if (!typing) setTool(null);
      return;
    }
    if (typing) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;

    if (e.key === ' ' && freehand.active) { e.preventDefault(); freehand.setPanning(true); return; }
    if (e.key === 'Enter' && state.tool === 'line') { e.preventDefault(); finishLine(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.tool === 'line' && lineVertexCount() > 0) {
      e.preventDefault();
      removeLastVertex();
      return;
    }
    if (KEY_TOOLS[key]) { e.preventDefault(); toggleTool(KEY_TOOLS[key]); return; }
    if (key === 'k') {
      state.settings.kalkeOn = !state.settings.kalkeOn;
      $('#kalke-toggle').checked = state.settings.kalkeOn;
      settingChanged();
      return;
    }
    const markerType = Object.keys(MARKER_TYPES).find((type) => MARKER_TYPES[type].key === e.key);
    if (markerType) { e.preventDefault(); toggleTool(`marker:${markerType}`); }
  });

  document.addEventListener('keyup', (e) => { if (e.key === ' ') freehand.setPanning(false); });
  window.addEventListener('blur', () => freehand.setPanning(false));

  /* ---------------------------------------------------------
     Start-up
     --------------------------------------------------------- */
  function init() {
    const saved = loadSaved();
    if (saved && saved.settings) Object.assign(state.settings, DEFAULT_SETTINGS, saved.settings);
    if (saved && typeof saved.planName === 'string') state.planName = saved.planName;
    if (saved && INKS.includes(saved.ink)) state.ink = saved.ink;

    if (saved && saved.view && saved.view.center) map.setView(saved.view.center, saved.view.zoom || 15);
    else map.setView(CONFIG.defaultView.center, CONFIG.defaultView.zoom);

    setBasemap(state.settings.basemap);
    setScaleControl();

    restoring = true;
    (saved && Array.isArray(saved.items) ? saved.items : []).forEach((raw) => {
      try { addItem(raw); } catch (err) { /* skip a damaged item rather than losing the plan */ }
    });
    restoring = false;
    history.current = snapshot();

    buildToolbars();
    buildDock();
    bindControls();
    syncControls();
    applyKalke();
    updateToolUI();
    renderAll();

    map.on('moveend', saveSoon);
  }

  init();

  // Handy for debugging from the browser console.
  window.kalke = { map, items, state, toGeoJSON, toKML, setTool };
})();
