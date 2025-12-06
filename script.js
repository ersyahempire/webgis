// script.js (FIXED: Filter logic removed to match total sheet count)

// ---------- CONFIG ----------
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

function cleanFloat(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const str = String(val).replace(',', '.').trim();
    return parseFloat(str) || 0;
}

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

function resetAllLayerStyles() {
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
  if (!json || !json.table) return { rows: [], cols: [] };

  const rawCols = json.table.cols.map(c => (c && c.label) ? c.label.toUpperCase() : "");
  const rows = json.table.rows || [];
  
  const processedRows = rows.map(r => {
    const obj = {};
    rawCols.forEach((c, i) => obj[c ? c : `COL${i}`] = (r.c && r.c[i] ? r.c[i].v : ""));
    return obj;
  });
  
  return { rows: processedRows, cols: rawCols.filter(c => c && !c.startsWith("COL")) }; 
}

function normalizeRows(rows, sheetKey, rawCols) {
  const normalizedKeys = new Set(["SITE_NAME", "SITE NAME", "SITE", "DISTRICT", "DAERAH", "DUN", "PARLIAMENT", "PARLIAMENT_NAME", "LATITUDE", "LAT", "LONGITUDE", "LON", "LNG", "STATUS", "STATUS_1"]);
  
  const normalized = rows.map((r, i) => {
    const get = k => (r[k] !== undefined ? r[k] : (r[k.toLowerCase()] !== undefined ? r[k.toLowerCase()] : ""));
    const site = get("SITE_NAME") || get("SITE NAME") || get("SITE") || "";
    const district = get("DISTRICT") || get("DAERAH") || "";
    const dun = get("DUN") || "";
    const parliament = get("PARLIAMENT") || get("PARLIAMENT_NAME") || "";
    
    // Walaupun koordinat mungkin 0, kita masih simpan nilainya.
    const lat = cleanFloat(get("LATITUDE") || get("LAT") || get("LATITUDE_DEC"));
    const lng = cleanFloat(get("LONGITUDE") || get("LON") || get("LNG"));
    
    const status = get("STATUS") || get("STATUS_1") || "";
    
    // Extract raw details
    const rawDetails = [];
    let count = 0;
    for(let colIndex=0; colIndex < rawCols.length && count < 15; colIndex++) {
        const key = rawCols[colIndex]; 
        if (normalizedKeys.has(key)) continue;
        const value = r[key];
        if (value !== null && value !== "" && value !== undefined) {
            rawDetails.push({ label: key, value: String(value).trim() });
            count++;
        }
    }
    
    return {
      // Kunci unik berdasarkan sheet dan nombor baris dikekalkan
      _id: `${sheetKey}_row_${i}`, 
      SITE_NAME: String(site || "").trim(),
      DISTRICT: String(district || "").trim(),
      DUN: String(dun || "").trim(),
      PARLIAMENT: String(parliament || "").trim(),
      LATITUDE: lat,
      LONGITUDE: lng,
      STATUS: String(status || "").trim(),
      _sheet: sheetKey,
      _type: SHEET_TYPE[sheetKey] || "UNKNOWN",
      _raw_details: rawDetails 
    };
  // PEMBETULAN UTAMA: Hanya tapis baris jika SITE_NAME benar-benar kosong.
  // Tidak lagi menapis berdasarkan LATITUDE/LONGITUDE 0 untuk memastikan kiraan total betul.
  }).filter(o => o.SITE_NAME); 
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
  // Gunakan ID Unik (_id) yang dijana dari nombor baris
  const uniqueKey = project._id;
  
  const cfg = TYPE_CFG[project._type] || { color: "#333", icon: "📍" };
  
  if (markersBySite.has(uniqueKey)) {
    const m = markersBySite.get(uniqueKey);
    const pos = m.getPosition();
    if (!pos || pos.lat().toFixed(6) !== Number(project.LATITUDE).toFixed(6) || pos.lng().toFixed(6) !== Number(project.LONGITUDE).toFixed(6)) {
      m.setPosition({ lat: Number(project.LATITUDE), lng: Number(project.LONGITUDE) });
    }
    m._meta = project;
    return m;
  } else {
    
    let rawDetailsHtml = project._raw_details.map(detail => 
        `<div class="info-row"><div class="info-label">${escapeHtml(detail.label)}:</div><div class="info-value">${escapeHtml(detail.value)}</div></div>`
    ).join('');

    if (rawDetailsHtml) {
        rawDetailsHtml = `<div class="info-section-title" style="margin-top: 10px; font-weight: bold; border-top: 1px solid #eee; padding-top: 5px;">Maklumat Terperinci (Max 15 Lajur Pertama)</div>` + rawDetailsHtml;
    } else {
        rawDetailsHtml = `<div style="margin-top: 10px; padding-top: 5px; font-style: italic; color: #777; border-top: 1px solid #eee;">Tiada lajur tambahan (selain Site, Kawasan, Koord., & Status) ditemui untuk dipaparkan.</div>`;
    }
    
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
          
          <div class="info-row"><div class="info-label">Latitude:</div><div class="info-value">${project.LATITUDE.toFixed(6)}</div></div>
          <div class="info-row"><div class="info-label">Longitude:</div><div class="info-value">${project.LONGITUDE.toFixed(6)}</div></div>
          
          ${rawDetailsHtml} 
        </div>
      `
    });

    marker.addListener("click", () => {
      infowin.open(map, marker);
    });

    marker._meta = project;
    markersBySite.set(uniqueKey, marker); // Guna uniqueKey (_id)
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

function filterAndDisplayMarkers() {
    const menaraActive = document.getElementById("toggle-menara")?.classList.contains("active");
    const nadiActive = document.getElementById("toggle-nadi")?.classList.contains("active");
    const popActive = document.getElementById("toggle-pop")?.classList.contains("active");
    const wifiActive = document.getElementById("toggle-wifi")?.classList.contains("active");

    let filteredList = allProjects;
    
    // Tapis mengikut kawasan
    if (activeFeature && currentBoundaryKey) {
        let areaName = extractFeatureName(activeFeature);
        
        filteredList = allProjects.filter(p => {
            if (currentBoundaryKey === 'district') return p.DISTRICT === areaName;
            if (currentBoundaryKey === 'dun') return p.DUN === areaName;
            if (currentBoundaryKey === 'parliament') return p.PARLIAMENT === areaName;
            return false;
        });
    }

    updateDashboard(filteredList);
    
    // Tapis marker yang akan dipaparkan di peta (Perlu Lat/Lng bukan 0 untuk dipaparkan dengan betul)
    const visibleProjectKeys = new Set(
        filteredList
            .filter(p => p.LATITUDE !== 0 && p.LONGITUDE !== 0) // Hanya kira yang boleh dipetakan
            .map(p => p._id) // Guna ID unik
    );

    markersList.forEach(m => {
        const type = m._meta._type;
        let isCategoryActive = false;

        if (type === "TOWER") isCategoryActive = menaraActive;
        else if (type === "BWA") isCategoryActive = wifiActive;
        else if (type === "NADI") isCategoryActive = nadiActive;
        else if (type === "POP") isCategoryActive = popActive;

        const isVisible = visibleProjectKeys.has(m._meta._id) && isCategoryActive;
        m.setVisible(isVisible);
    });
}

const updateDashboard = debounce(function(list) {
  const displayList = list || allProjects || [];
  
  // Dashboard count kini mengambil kira SEMUA baris dalam sheet (selain baris kosong)
  document.getElementById("total-projects").textContent = displayList.length; 
  
  const counts = { menara:0, nadi:0, wifi:0, pop:0 };
  const statusCounts = {};
  
  displayList.forEach(p => {
    if (p._type === "TOWER") counts.menara++;
    if (p._type === "BWA") counts.wifi++;
    if (p._type === "NADI") counts.nadi++;
    if (p._type === "POP") counts.pop++;
    
    statusCounts[p.STATUS] = (statusCounts[p.STATUS] || 0) + 1;
  });
  
  document.getElementById("menara-count").textContent = counts.menara || 0;
  document.getElementById("nadi-count").textContent = counts.nadi || 0;
  document.getElementById("wifi-count").textContent = counts.wifi || 0;
  document.getElementById("pop-count").textContent = counts.pop || 0;

  const statusEl = document.getElementById("status-list");
  statusEl.innerHTML = "";
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
    const data = await fetchSheetObjects(id); 
    return normalizeRows(data.rows, sheetKey, data.cols);
  } catch (e) {
    console.warn("sheet load fail", sheetKey, e);
    return [];
  }
}

async function loadGeoJsonLayer(key, url, baseStyle = {}) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("geojson fetch failed " + url);
    const json = await resp.json();

    const layer = new google.maps.Data({ map: null });
    layer.addGeoJson(json);
    
    layer._baseStyle = { 
        strokeWeight: baseStyle.strokeWeight || 1,
        strokeColor: baseStyle.strokeColor || "#888888",
        fillOpacity: 0.0,
        fillColor: (baseStyle.fillColor || "#CCCCCC")
    };
    layer.setStyle(feature => layer._baseStyle);

    layer.addListener("mouseover", e => {
      if (!layer.getMap()) return;
      if (activeFeature === e.feature) return;

      const hoverStyle = {
        strokeWeight: 2,
        strokeColor: "#ffffff",
        fillOpacity: 0.2,
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
      if (activeFeature !== e.feature) {
          try { layer.revertStyle(e.feature); } catch(_) {}
      }
      if (hoverInfoWindow) hoverInfoWindow.close();
    });

    layer.addListener("click", e => {
      const featureName = extractFeatureName(e.feature);
      document.getElementById("selected-area").textContent = featureName;
      
      handleFeatureClick(key, e.feature);
      
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

function handleFeatureClick(key, feature) {
    const layerObj = dataLayers[key];
    if (!layerObj) return;

    toggleBoundaryLayerVisibility(key); 
    resetAllLayerStyles(); 

    const col = randomHexColor();
    const activeStyle = {
        strokeWeight: 3,
        strokeColor: "#ffffff",
        fillOpacity: 0.6,
        fillColor: col
    };
    layerObj.overrideStyle(feature, activeStyle);

    activeFeature = feature;
    activeLayer = layerObj;
    currentBoundaryKey = key;
    
    filterAndDisplayMarkers();
}

function toggleBoundaryLayerVisibility(key) {
    Object.keys(dataLayers).forEach(k => {
        const dl = dataLayers[k];
        if (dl) dl.setMap(k === key ? map : null);
    });
    
    if (currentBoundaryKey !== key) {
        resetAllLayerStyles();
    }
    
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

function setupToggles() {
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

async function autoRefreshLoop() {
  try {
    const newProjects = await loadAllSheetsAndNormalize();
    newProjects.forEach(np => createOrUpdateMarker(np));
    
    // Guna ID unik dalam set
    const newKeys = new Set(newProjects.map(p => p._id));
    for (const [key,m] of markersBySite.entries()) {
      if (!newKeys.has(key)) {
        m.setMap(null);
        markersBySite.delete(key);
      }
    }
    markersList = Array.from(markersBySite.values());
    allProjects = newProjects;
    buildAreaIndex();
    
    filterAndDisplayMarkers();

  } catch (e) {
    console.warn("autoRefreshLoop failed", e);
  }
}

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

    const pDistrict = loadGeoJsonLayer("district", URLs.district);
    const pDun = loadGeoJsonLayer("dun", URLs.dun);
    const pPar = loadGeoJsonLayer("parliament", URLs.parliament);

    google.maps.event.addListenerOnce(map, "idle", async () => {
      const ld = await pDistrict;
      await pDun;
      await pPar;

      if (ld) {
        toggleBoundaryLayerVisibility("district");
      }
      setupToggles();
    });

    setInterval(() => { autoRefreshLoop(); }, refreshIntervalMs);

  } catch (e) {
    console.error("initMap main error", e);
    console.log("Gagal memuatkan data. Sila semak console (F12) untuk ralat.");
  } finally {
    showLoading(false);
  }
}

window.initMap = initMap;
