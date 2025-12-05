// script.js (Menggunakan Data Tempatan JSON)

// ---------- CONFIG ----------
// Menggunakan fail JSON yang berada dalam direktori yang sama
const URLs = {
  district: "district.json",
  dun: "dun.json",
  parliament: "parliament.json"
};

const SHEETS = {
  db_bwa: "1594VRWEs0PF56KXeSPudZTWkbGuS5UZmxXGrKqo4bUU",
  db_pim: "1WyZiw72LOVytssXAuymJS_TIgckLCUqY56pB0QhawZU",
  db_POP: "1JLqLtZPa4Kd6hEbRA2wgMgADX2h2-tdsXnG-YivSgU8",
  tower: "1b0Aipp0MQvP8HWc-z28dugkGn5sWdNAx6ZE5-Mu13-0"
};

const SHEET_TYPE = {
  db_bwa: "BWA",
  db_pim: "NADI",
  db_POP: "POP",
  tower: "TOWER"
};

const TYPE_CFG = {
  BWA: { color: "#FF5722", icon: "🗼" },
  NADI: { color: "#2196F3", icon: "📡" },
  POP: { color: "#FF9800", icon: "🌐" },
  TOWER: { color: "#4CAF50", icon: "📶" }
};

// ---------- STATE ----------
let map;
let markersBySite = new Map();
let markersList = [];
let allProjects = [];
let areaIndex = new Map();
let dataLayers = { district: null, dun: null, parliament: null }; 
let currentBoundaryKey = null; 
let hoverInfoWindow = null;
let refreshIntervalMs = 60_000;
let batchSize = 300;

// ---------- UTIL ----------
function showLoading(on) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.classList.toggle("show", !!on);
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function debounce(fn, wait=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; }
function randomHexColor(){ return "#" + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'); }

// ---------- GVIZ parse ----------
function parseGviz(text) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(text.substring(start, end+1));
  } catch(e) {
    console.error("parseGviz failed", e);
    return null;
  }
}

// ---------- Google Sheets fetch & normalize ----------
async function fetchSheetObjects(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch ${sheetId} failed (${res.status})`);
  const text = await res.text();
  const json = parseGviz(text);
  if (!json || !json.table) return [];
  const cols = json.table.cols.map(c => (c && c.label) ? c.label : "");
  const rows = json.table.rows || [];
  return rows.map(r => {
    const obj = {};
    cols.forEach((c, i) => obj[c ? c.toUpperCase() : `COL${i}`] = (r.c && r.c[i] ? r.c[i].v : ""));
    return obj;
  });
}

function normalizeRows(rows, sheetKey) {
  const normalized = rows.map(r => {
    const get = k => (r[k] !== undefined ? r[k] : (r[k.toLowerCase()] !== undefined ? r[k.toLowerCase()] : ""));
    const site = get("SITE_NAME") || get("SITE NAME") || get("SITE") || "";
    const district = get("DISTRICT") || get("DAERAH") || "";
    const dun = get("DUN") || "";
    const parliament = get("PARLIAMENT") || get("PARLIAMENT_NAME") || "";
    const lat = parseFloat(get("LATITUDE") || get("LAT") || get("LATITUDE_DEC") || 0) || 0;
    const lng = parseFloat(get("LONGITUDE") || get("LON") || get("LNG") || 0) || 0;
    const status = get("STATUS") || get("STATUS_1") || "";
    
    return {
      SITE_NAME: String(site || "").trim(),
      DISTRICT: String(district || "").trim(),
      DUN: String(dun || "").trim(),
      PARLIAMENT: String(parliament || "").trim(),
      LATITUDE: lat,
      LONGITUDE: lng,
      STATUS: String(status || "").trim(),
      _sheet: sheetKey,
      _type: SHEET_TYPE[sheetKey] || "UNKNOWN"
    };
  }).filter(o => o.SITE_NAME && o.LATITUDE !== 0 && o.LONGITUDE !== 0);
  return normalized;
}

function buildAreaIndex() {
  areaIndex.clear();
  allProjects.forEach(p => {
    [p.DISTRICT, p.DUN, p.PARLIAMENT].forEach(k => {
      if (!k) return;
      const key = String(k).trim();
      if (!areaIndex.has(key)) areaIndex.set(key, new Set());
      areaIndex.get(key).add(p.SITE_NAME);
    });
  });
}

// ---------- MARKERS ----------
function createOrUpdateMarker(project) {
  const site = project.SITE_NAME;
  const cfg = TYPE_CFG[project._type] || { color: "#333", icon: "📍" };
  
  if (markersBySite.has(site)) {
    const m = markersBySite.get(site);
    const pos = m.getPosition();
    if (!pos || pos.lat().toFixed(6) !== Number(project.LATITUDE).toFixed(6) || pos.lng().toFixed(6) !== Number(project.LONGITUDE).toFixed(6)) {
      m.setPosition({ lat: Number(project.LATITUDE), lng: Number(project.LONGITUDE) });
    }
    m._meta = project;
    return m;
  } else {
    const marker = new google.maps.Marker({
      position: { lat: Number(project.LATITUDE), lng: Number(project.LONGITUDE) },
      map: map,
      title: project.SITE_NAME || "",
      visible: false, // Default hidden
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: cfg.color,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 1.5
      }
    });

    const infowin = new google.maps.InfoWindow({
      content: `
        <div class="info-popup">
          <div class="info-title">${cfg.icon} ${escapeHtml(project.SITE_NAME)}</div>
          <div class="info-row"><div class="info-label">Daerah:</div><div class="info-value">${escapeHtml(project.DISTRICT)}</div></div>
          <div class="info-row"><div class="info-label">DUN:</div><div class="info-value">${escapeHtml(project.DUN)}</div></div>
          <div class="info-row"><div class="info-label">Parlimen:</div><div class="info-value">${escapeHtml(project.PARLIAMENT)}</div></div>
          <div class="info-row"><div class="info-label">Status:</div><div class="info-value">${escapeHtml(project.STATUS)}</div></div>
        </div>
      `
    });

    marker.addListener("click", () => {
      infowin.open(map, marker);
      document.getElementById("selected-area").textContent = project.DISTRICT || "Undefined";
    });

    marker._meta = project;
    markersBySite.set(site, marker);
    markersList.push(marker);
    return marker;
  }
}

function renderMarkersInBatches(projects, onComplete) {
  const total = projects.length;
  let i = 0;
  if (total === 0) {
      if (typeof onComplete === "function") onComplete();
      return;
  }

  const runChunk = () => {
    const end = Math.min(i + batchSize, total);
    for (; i < end; i++) {
      const p = projects[i];
      createOrUpdateMarker(p);
    }
    if (i < total) {
      if (window.requestIdleCallback) window.requestIdleCallback(runChunk, { timeout: 200 });
      else setTimeout(runChunk, 50);
    } else {
      if (typeof onComplete === "function") onComplete();
    }
  };
  runChunk();
}

// ---------- DASHBOARD ----------
const updateDashboard = debounce(function(filteredList) {
  const list = filteredList || allProjects || [];
  document.getElementById("total-projects").textContent = list.length;
  const counts = { menara:0, nadi:0, wifi:0, pop:0 };
  const statusCounts = {};
  
  list.forEach(p => {
    if (p._type === "BWA" || p._type === "TOWER") counts.menara++;
    if (p._type === "NADI") counts.nadi++;
    if (p._type === "POP") counts.pop++;
    if (p._type === "BWA") counts.wifi++; // Andaian BWA sebagai WiFi juga? Sesuaikan jika perlu
    
    // Kira status untuk semua projek dalam list
    statusCounts[p.STATUS] = (statusCounts[p.STATUS] || 0) + 1;
  });
  
  document.getElementById("menara-count").textContent = counts.menara || 0;
  document.getElementById("nadi-count").textContent = counts.nadi || 0;
  document.getElementById("wifi-count").textContent = counts.wifi || 0;
  document.getElementById("pop-count").textContent = counts.pop || 0;

  const statusEl = document.getElementById("status-list");
  statusEl.innerHTML = "";
  Object.entries(statusCounts).forEach(([k,v]) => {
    if (!k) return;
    const div = document.createElement("div");
    div.className = "status-item";
    div.innerHTML = `<div class="status-name">${k}</div><div class="status-count">${v}</div>`;
    statusEl.appendChild(div);
  });
}, 200);

// ---------- LOAD SHEETS ----------
async function loadAllSheetsAndNormalize() {
  const entries = Object.entries(SHEETS);
  const promises = entries.map(([k,id]) => fetchSheetObjectsSafe(k, id));
  const results = await Promise.all(promises);
  const combined = results.flat();
  allProjects = combined;
  buildAreaIndex();
  return combined;
}
async function fetchSheetObjectsSafe(sheetKey, id) {
  try {
    const rows = await fetchSheetObjects(id);
    return normalizeRows(rows, sheetKey);
  } catch (e) {
    console.warn("sheet load fail", sheetKey, e);
    return [];
  }
}

// ---------- GEOJSON BOUNDARY LAYERS ----------
async function loadGeoJsonLayer(key, url, baseStyle = {}) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("geojson fetch failed " + url);
    const json = await resp.json();

    const layer = new google.maps.Data({ map: null });
    layer.addGeoJson(json);

    // Style lalai (telus/tidak berwarna kuat)
    layer.setStyle(feature => {
      const s = layer._currentStyle || {
        strokeWeight: baseStyle.strokeWeight || 1,
        strokeColor: baseStyle.strokeColor || "#888888",
        fillOpacity: (baseStyle.fillOpacity !== undefined ? baseStyle.fillOpacity : 0.0),
        fillColor: (baseStyle.fillColor || "#CCCCCC")
      };
      return s;
    });

    // Hover effect
    layer.addListener("mouseover", e => {
      if (!layer.getMap()) return;
      const hoverStyle = {
        strokeWeight: 2,
        strokeColor: "#ffffff",
        fillOpacity: 0.8,
        fillColor: (layer._currentStyle && layer._currentStyle.fillColor) ? layer._currentStyle.fillColor : "#FFFF00"
      };
      layer.overrideStyle(e.feature, hoverStyle);

      if (!hoverInfoWindow) hoverInfoWindow = new google.maps.InfoWindow();
      const props = ["NAME","name","DISTRICT","DAERAH","DUN","PARLIAMENT","PARLIAMEN"];
      let title = "Area";
      for (const k of props) {
        try {
          const v = e.feature.getProperty(k);
          if (v) { title = v; break; }
        } catch(_) {}
      }
      hoverInfoWindow.setContent(`<div style="padding:5px; font-weight:700;">${escapeHtml(title)}</div>`);
      if (e.latLng) hoverInfoWindow.setPosition(e.latLng);
      hoverInfoWindow.open(map);
    });

    layer.addListener("mouseout", e => {
      if (!layer.getMap()) return;
      try { layer.revertStyle(e.feature); } catch(_) {}
      if (hoverInfoWindow) hoverInfoWindow.close();
    });

    // Click: Select Area & Zoom
    layer.addListener("click", e => {
      const props = ["NAME","name","DISTRICT","DAERAH","DUN","PARLIAMENT","PARLIAMEN"];
      let name = "Area";
      for (const k of props) {
        try {
          const v = e.feature.getProperty(k);
          if (v) { name = v; break; }
        } catch(_) {}
      }
      document.getElementById("selected-area").textContent = name;
      activateBoundaryLayer(key, layer, e.feature);
      
      try {
        const bounds = new google.maps.LatLngBounds();
        e.feature.getGeometry().forEachLatLng && e.feature.getGeometry().forEachLatLng(ll => bounds.extend(ll));
        map.fitBounds(bounds);
      } catch(_) {}
    });

    dataLayers[key] = layer;
    return layer;
  } catch (e) {
    console.warn("loadGeoJsonLayer error", key, e);
    return null;
  }
}

function activateBoundaryLayer(key, layerObj, clickedFeature = null) {
  // Matikan layer lain
  Object.keys(dataLayers).forEach(k => {
    const dl = dataLayers[k];
    if (!dl) return;
    if (k !== key) {
      dl.setMap(null);
      dl._currentStyle = { strokeWeight: 1, strokeColor: "#888888", fillOpacity: 0.0, fillColor: "#CCCCCC" };
      dl.setStyle(feature => dl._currentStyle);
    }
  });

  // Hidupkan layer terpilih
  if (!layerObj) layerObj = dataLayers[key];
  if (!layerObj) return;
  layerObj.setMap(map);

  // Warna rawak untuk layer aktif
  const col = randomHexColor();
  layerObj._currentStyle = {
    strokeWeight: 2,
    strokeColor: col,
    fillOpacity: 0.5,
    fillColor: col
  };

  // Efek fade-in ringkas
  layerObj.setStyle(feature => {
    return { ...layerObj._currentStyle, fillOpacity: 0.0 };
  });
  
  setTimeout(() => {
    try {
      layerObj.setStyle(feature => layerObj._currentStyle);
    } catch (_) {}
  }, 60);

  updateToggleButtonsUI(key);
  currentBoundaryKey = key;
}

function updateToggleButtonsUI(activeKey) {
  const mapping = { district: "toggle-daerah", dun: "toggle-dun", parliament: "toggle-parliament" };
  Object.keys(mapping).forEach(k => {
    const btn = document.getElementById(mapping[k]);
    if (!btn) return;
    if (k === activeKey) btn.classList.add("active");
    else btn.classList.remove("active");
  });
}

// ---------- UI TOGGLES SETUP ----------
function setupToggles() {
  document.getElementById("toggle-menara").addEventListener("click", function(){
    this.classList.toggle("active");
    const visible = this.classList.contains("active");
    markersList.forEach(m => {
      const t = m._meta._type;
      if (t === "BWA" || t === "TOWER") m.setVisible(visible);
    });
    // Kemaskini dashboard
    const visibleMarkers = markersList.filter(m => m.getVisible()).map(m => m._meta);
    updateDashboard(visibleMarkers.length > 0 ? visibleMarkers : (visible ? [] : allProjects)); 
  });

  document.getElementById("toggle-nadi").addEventListener("click", function(){
    this.classList.toggle("active");
    const visible = this.classList.contains("active");
    markersList.forEach(m => { if (m._meta._type === "NADI") m.setVisible(visible); });
    const visibleMarkers = markersList.filter(m => m.getVisible()).map(m => m._meta);
    updateDashboard(visibleMarkers.length > 0 ? visibleMarkers : allProjects);
  });

  document.getElementById("toggle-pop").addEventListener("click", function(){
    this.classList.toggle("active");
    const visible = this.classList.contains("active");
    markersList.forEach(m => { if (m._meta._type === "POP") m.setVisible(visible); });
    const visibleMarkers = markersList.filter(m => m.getVisible()).map(m => m._meta);
    updateDashboard(visibleMarkers.length > 0 ? visibleMarkers : allProjects);
  });

  document.getElementById("toggle-wifi").addEventListener("click", function(){
    this.classList.toggle("active");
    // Tambah logik wifi jika ada data khusus
  });

  document.getElementById("toggle-daerah").addEventListener("click", function(){
    const layer = dataLayers.district;
    if (!layer) return;
    activateBoundaryLayer("district", layer);
  });
  document.getElementById("toggle-dun").addEventListener("click", function(){
    const layer = dataLayers.dun;
    if (!layer) return;
    activateBoundaryLayer("dun", layer);
  });
  document.getElementById("toggle-parliament").addEventListener("click", function(){
    const layer = dataLayers.parliament;
    if (!layer) return;
    activateBoundaryLayer("parliament", layer);
  });
}

// ---------- AUTO REFRESH ----------
async function autoRefreshLoop() {
  try {
    const newProjects = await loadAllSheetsAndNormalize();
    newProjects.forEach(np => createOrUpdateMarker(np));
    
    // Buang marker lama
    const newSiteNames = new Set(newProjects.map(p => p.SITE_NAME));
    for (const [site,m] of markersBySite.entries()) {
      if (!newSiteNames.has(site)) {
        m.setMap(null);
        markersBySite.delete(site);
      }
    }
    markersList = Array.from(markersBySite.values());
    allProjects = newProjects;
    buildAreaIndex();
    
    // Kekalkan status butang aktif
    const menaraActive = document.getElementById("toggle-menara").classList.contains("active");
    const nadiActive = document.getElementById("toggle-nadi").classList.contains("active");
    const popActive = document.getElementById("toggle-pop").classList.contains("active");

    markersList.forEach(m => {
        const t = m._meta._type;
        if (t === "BWA" || t === "TOWER") m.setVisible(menaraActive);
        else if (t === "NADI") m.setVisible(nadiActive);
        else if (t === "POP") m.setVisible(popActive);
    });

    updateDashboard(allProjects);
  } catch (e) {
    console.warn("autoRefreshLoop failed", e);
  }
}

// ---------- INIT MAP (callback) ----------
async function initMap() {
  const mapDiv = document.getElementById("map");
  if(!mapDiv) {
      console.error("Map DIV not found");
      return;
  }

  map = new google.maps.Map(mapDiv, {
    center: { lat: 5.9804, lng: 116.0735 }, // Sabah
    zoom: 8,
    mapTypeId: "satellite",
    streetViewControl: false,
    fullscreenControl: true,
    mapTypeControlOptions: {
        position: google.maps.ControlPosition.TOP_LEFT
    }
  });
  showLoading(true);

  try {
    const projects = await loadAllSheetsAndNormalize();

    renderMarkersInBatches(projects, () => {
      markersList = Array.from(markersBySite.values());
      // Default: Hidden
      markersList.forEach(m => m.setVisible(false));
      updateDashboard(allProjects);
    });

    // Load boundaries dari fail TEMPATAN
    const pDistrict = loadGeoJsonLayer("district", URLs.district, { strokeWeight: 1, strokeColor: "#FF0000", fillOpacity: 0.0, fillColor: "#FFCDD2" });
    const pDun = loadGeoJsonLayer("dun", URLs.dun, { strokeWeight: 1, strokeColor: "#00AA00", fillOpacity: 0.0, fillColor: "#C8E6C9" });
    const pPar = loadGeoJsonLayer("parliament", URLs.parliament, { strokeWeight: 1, strokeColor: "#2196F3", fillOpacity: 0.0, fillColor: "#BBDEFB" });

    google.maps.event.addListenerOnce(map, "idle", async () => {
      const ld = await pDistrict;
      await pDun;
      await pPar;

      // Default: Paparkan Daerah
      if (ld) {
        activateBoundaryLayer("district", ld);
      }
      setupToggles();
    });

    setInterval(() => { autoRefreshLoop(); }, refreshIntervalMs);

  } catch (e) {
    console.error("initMap main error", e);
    alert("Gagal memuatkan data. Sila semak console (F12) untuk ralat.");
  } finally {
    showLoading(false);
  }
}

window.initMap = initMap;
