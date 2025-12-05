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

// ---------- STATE (Updated) ----------
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

// State untuk pengurusan poligon aktif
let activeFeature = null;
let activeLayer = null;

// ---------- UTIL ----------
function showLoading(on) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.classList.toggle("show", !!on);
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function debounce(fn, wait=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; };
function randomHexColor(){ return "#" + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'); }

/**
 * Mendapatkan nama kawasan dari GeoJSON Feature.
 * @param {google.maps.Data.Feature} feature
 * @returns {string}
 */
function extractFeatureName(feature) {
  const props = ["NAME","name","DISTRICT","DAERAH","DUN","PARLIAMENT","PARLIAMEN"];
  let name = "Sabah";
  for (const k of props) {
    try {
      const v = feature.getProperty(k);
      if (v) { name = v; break; }
    } catch(_) {}
  }
  return String(name).trim();
}

/**
 * Menyahaktifkan gaya poligon aktif dari mana-mana lapisan.
 */
function resetAllLayerStyles() {
    // FIX: Menggunakan revertStyle() tanpa argumen untuk membatalkan semua penimpaan gaya.
    Object.keys(dataLayers).forEach(k => {
        const dl = dataLayers[k];
        if (dl) dl.revertStyle(); 
    });
    activeFeature = null;
    activeLayer = null;
}

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
      // Tiada perubahan pada selected-area, ia akan diupdate oleh klik poligon
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

/**
 * Menapis projek berdasarkan kawasan aktif dan kategori aktif.
 * Mengemas kini Dashboard dan visibility Marker.
 */
function filterAndDisplayMarkers() {
    const menaraActive = document.getElementById("toggle-menara")?.classList.contains("active");
    const nadiActive = document.getElementById("toggle-nadi")?.classList.contains("active");
    const popActive = document.getElementById("toggle-pop")?.classList.contains("active");
    
    let filteredList = allProjects;
    
    // 1. Tapis mengikut kawasan yang dipilih (jika ada)
    if (activeFeature && currentBoundaryKey) {
        let areaName = extractFeatureName(activeFeature);
        
        filteredList = allProjects.filter(p => {
            if (currentBoundaryKey === 'district') return p.DISTRICT === areaName;
            if (currentBoundaryKey === 'dun') return p.DUN === areaName;
            if (currentBoundaryKey === 'parliament') return p.PARLIAMENT === areaName;
            return false;
        });
    }

    // 2. Kemaskini Dashboard berdasarkan penapis kawasan
    updateDashboard(filteredList);

    // 3. Kemaskini visibility Marker berdasarkan penapis kategori DAN penapis kawasan
    const visibleSiteNames = new Set(filteredList.map(p => p.SITE_NAME));

    markersList.forEach(m => {
        const type = m._meta._type;
        let isCategoryActive = false;

        // Check if marker category is toggled on
        if (type === "BWA" || type === "TOWER") isCategoryActive = menaraActive;
        else if (type === "NADI") isCategoryActive = nadiActive;
        else if (type === "POP") isCategoryActive = popActive;

        // Marker hanya kelihatan jika ia berada di kawasan yang ditapis DAN kategorinya aktif
        const isVisible = visibleSiteNames.has(m._meta.SITE_NAME) && isCategoryActive;
        m.setVisible(isVisible);
    });
}

// ---------- DASHBOARD ----------
const updateDashboard = debounce(function(list) {
  const displayList = list || allProjects || [];
  document.getElementById("total-projects").textContent = displayList.length;
  const counts = { menara:0, nadi:0, wifi:0, pop:0 };
  const statusCounts = {};
  
  displayList.forEach(p => {
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
  // Sort status by count (descending)
  Object.entries(statusCounts)
    .sort(([, a], [, b]) => b - a)
    .forEach(([k,v]) => {
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
    
    // Tentukan base style lutsinar (default tidak berwarna)
    layer._baseStyle = { 
        strokeWeight: baseStyle.strokeWeight || 1,
        strokeColor: baseStyle.strokeColor || "#888888",
        fillOpacity: 0.0, // Default: telus
        fillColor: (baseStyle.fillColor || "#CCCCCC")
    };
    layer.setStyle(feature => layer._baseStyle); // Apply base transparent style

    // Hover effect
    layer.addListener("mouseover", e => {
      if (!layer.getMap()) return;
      // Jangan override jika sudah aktif
      if (activeFeature === e.feature) return;

      const hoverStyle = {
        strokeWeight: 2,
        strokeColor: "#ffffff",
        fillOpacity: 0.2, // Opacity hover yang ringan
        fillColor: (activeLayer && activeLayer._baseStyle && activeLayer._baseStyle.fillColor) ? activeLayer._baseStyle.fillColor : "#CCCCCC"
      };
      layer.overrideStyle(e.feature, hoverStyle);

      if (!hoverInfoWindow) hoverInfoWindow = new google.maps.InfoWindow();
      const title = extractFeatureName(e.feature);
      hoverInfoWindow.setContent(`<div style="padding:5px; font-weight:700;">${escapeHtml(title)}</div>`);
      if (e.latLng) hoverInfoWindow.setPosition(e.latLng);
      hoverInfoWindow.open(map);
    });

    layer.addListener("mouseout", e => {
      if (!layer.getMap()) return;
      // Revert style hanya jika feature tidak aktif
      if (activeFeature !== e.feature) {
          try { layer.revertStyle(e.feature); } catch(_) {}
      }
      if (hoverInfoWindow) hoverInfoWindow.close();
    });

    // Click: Select Area & Zoom & Set Active Feature (NEW LOGIC)
    layer.addListener("click", e => {
      const featureName = extractFeatureName(e.feature);
      document.getElementById("selected-area").textContent = featureName;
      
      handleFeatureClick(key, e.feature); // Panggil logik baru
      
      // Zoom logic
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

/**
 * Menguruskan klik pada GeoJSON feature (poligon).
 * Menetapkan gaya aktif dan mengemas kini dashboard.
 * @param {string} key - Kunci layer ('district', 'dun', 'parliament')
 * @param {google.maps.Data.Feature} feature - Feature yang diklik
 */
function handleFeatureClick(key, feature) {
    const layerObj = dataLayers[key];
    if (!layerObj) return;

    // 1. Pastikan hanya layer yang betul kelihatan
    toggleBoundaryLayerVisibility(key); 

    // 2. Clear gaya poligon aktif dari semua lapisan
    resetAllLayerStyles(); 

    // 3. Apply the new color to the clicked feature (60% opacity)
    const col = randomHexColor();
    const activeStyle = {
        strokeWeight: 3,
        strokeColor: "#ffffff",
        fillOpacity: 0.6, // Requested 60% opacity
        fillColor: col
    };
    layerObj.overrideStyle(feature, activeStyle);

    // 4. Update global state
    activeFeature = feature;
    activeLayer = layerObj;
    currentBoundaryKey = key;
    
    // 5. Update Dashboard and Markers for the selected area
    filterAndDisplayMarkers();
}

/**
 * Mengawal visibility layer (untuk butang toggle di UI).
 * @param {string} key - Kunci layer ('district', 'dun', 'parliament')
 */
function toggleBoundaryLayerVisibility(key) {
    // 1. Matikan layer lain
    Object.keys(dataLayers).forEach(k => {
        const dl = dataLayers[k];
        if (dl) dl.setMap(k === key ? map : null);
    });
    
    // 2. Reset gaya aktif jika layer ditukar melalui butang UI
    // Ini penting jika pengguna menekan butang layer (Daerah/DUN/Parlimen) 
    // tanpa mengklik sebarang poligon baru.
    if (currentBoundaryKey !== key) {
        resetAllLayerStyles();
    }
    
    // 3. Update UI buttons
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
  
  // Marker Toggles - Panggil filterAndDisplayMarkers untuk filter marker mengikut kawasan dan kategori
  document.getElementById("toggle-menara").addEventListener("click", function(){
    this.classList.toggle("active");
    filterAndDisplayMarkers();
  });

  document.getElementById("toggle-nadi").addEventListener("click", function(){
    this.classList.toggle("active");
    filterAndDisplayMarkers();
  });

  document.getElementById("toggle-pop").addEventListener("click", function(){
    this.classList.toggle("active");
    filterAndDisplayMarkers();
  });

  document.getElementById("toggle-wifi").addEventListener("click", function(){
    this.classList.toggle("active");
    filterAndDisplayMarkers();
  });
  
  // Boundary Toggles - Hanya tukar layer visibility (reset active polygon and filter to all projects)
  document.getElementById("toggle-daerah").addEventListener("click", function(){
    toggleBoundaryLayerVisibility("district");
    document.getElementById("selected-area").textContent = "Sabah";
    filterAndDisplayMarkers(); 
  });
  document.getElementById("toggle-dun").addEventListener("click", function(){
    toggleBoundaryLayerVisibility("dun");
    document.getElementById("selected-area").textContent = "Sabah";
    filterAndDisplayMarkers(); 
  });
  document.getElementById("toggle-parliament").addEventListener("click", function(){
    toggleBoundaryLayerVisibility("parliament");
    document.getElementById("selected-area").textContent = "Sabah";
    filterAndDisplayMarkers(); 
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
    
    // Kekalkan status butang aktif, tapis mengikut status semasa
    filterAndDisplayMarkers();

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
    const pDistrict = loadGeoJsonLayer("district", URLs.district);
    const pDun = loadGeoJsonLayer("dun", URLs.dun);
    const pPar = loadGeoJsonLayer("parliament", URLs.parliament);

    google.maps.event.addListenerOnce(map, "idle", async () => {
      const ld = await pDistrict;
      await pDun;
      await pPar;

      // Default: Paparkan Daerah (tanpa mewarnakan apa-apa)
      if (ld) {
        toggleBoundaryLayerVisibility("district");
      }
      setupToggles();
    });

    setInterval(() => { autoRefreshLoop(); }, refreshIntervalMs);

  } catch (e) {
    console.error("initMap main error", e);
    // Gantikan alert() dengan cara yang lebih lembut dalam UI jika perlu
    console.log("Gagal memuatkan data. Sila semak console (F12) untuk ralat.");
  } finally {
    showLoading(false);
  }
}

window.initMap = initMap;
