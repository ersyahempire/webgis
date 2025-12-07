// Projek Web GIS - Updated UI/UX Logic
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
  BWA: { color: "#4CAF50", icon: "📶", label: "WiFi" },
  NADI: { color: "#2196F3", icon: "📡", label: "NADI" },
  POP: { color: "#FF9800", icon: "🌐", label: "POP" },
  TOWER: { color: "#FF5722", icon: "🗼", label: "Menara" }
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
let searchTerm = ""; // Untuk fungsi carian

// ---------- UTIL ----------
function showLoading(on) {
  const el = document.getElementById("loading");
  if (!el) return;
  if(on) el.classList.remove("hide");
  else el.classList.add("hide");
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
    
    const lat = cleanFloat(get("LATITUDE") || get("LAT") || get("LATITUDE_DEC"));
    const lng = cleanFloat(get("LONGITUDE") || get("LON") || get("LNG"));
    
    // Normalize status untuk memastikan data konsisten untuk filtering
    const rawStatus = get("STATUS") || get("STATUS_1") || "Tiada Status";
    
    // Extract raw details - Limit to first 15 distinct columns that are NOT main keys
    const rawDetails = [];
    let count = 0;
    
    // Iterate all cols to find first 15 valid additional properties
    for(let colIndex=0; colIndex < rawCols.length && count < 15; colIndex++) {
        const key = rawCols[colIndex]; 
        if (normalizedKeys.has(key)) continue; // Skip main keys
        
        const value = r[key];
        if (value !== null && value !== "" && value !== undefined) {
            rawDetails.push({ label: key, value: String(value).trim() });
            count++;
        }
    }
    
    return {
      _id: `${sheetKey}_row_${i}`, 
      SITE_NAME: String(site || "").trim(),
      DISTRICT: String(district || "").trim(),
      DUN: String(dun || "").trim(),
      PARLIAMENT: String(parliament || "").trim(),
      LATITUDE: lat,
      LONGITUDE: lng,
      STATUS: String(rawStatus).trim(),
      _sheet: sheetKey,
      _type: SHEET_TYPE[sheetKey] || "UNKNOWN",
      _raw_details: rawDetails 
    };
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
    
    // Jana HTML untuk 15 column tambahan
    let rawDetailsHtml = project._raw_details.map(detail => 
        `<div class="info-row"><span class="info-label">${escapeHtml(detail.label)}</span><span class="info-val">${escapeHtml(detail.value)}</span></div>`
    ).join('');

    if(rawDetailsHtml) {
        rawDetailsHtml = `<div class="section-header">Maklumat Tambahan</div>` + rawDetailsHtml;
    }

    const marker = new google.maps.Marker({
      position: { lat: Number(project.LATITUDE), lng: Number(project.LONGITUDE) },
      map: map,
      title: project.SITE_NAME || "",
      visible: false, // Default: Hidden (OFF)
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: cfg.color,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2
      }
    });

    // Kemaskini InfoWindow mengikut permintaan (Main info explicitly listed)
    const infowin = new google.maps.InfoWindow({
      content: `
        <div class="info-popup">
          <div class="info-header">${cfg.icon} ${escapeHtml(project.SITE_NAME)}</div>
          <div class="info-body">
            <div class="section-header">Maklumat Utama</div>
            <div class="info-row"><span class="info-label">Kategori</span><span class="info-val">${cfg.label}</span></div>
            <div class="info-row"><span class="info-label">Daerah</span><span class="info-val">${escapeHtml(project.DISTRICT)}</span></div>
            <div class="info-row"><span class="info-label">DUN</span><span class="info-val">${escapeHtml(project.DUN)}</span></div>
            <div class="info-row"><span class="info-label">Parlimen</span><span class="info-val">${escapeHtml(project.PARLIAMENT)}</span></div>
            <div class="info-row"><span class="info-label">Status</span><span class="info-val" style="color:${cfg.color}">${escapeHtml(project.STATUS)}</span></div>
            <div class="info-row"><span class="info-label">Latitude</span><span class="info-val">${project.LATITUDE.toFixed(5)}</span></div>
            <div class="info-row"><span class="info-label">Longitude</span><span class="info-val">${project.LONGITUDE.toFixed(5)}</span></div>
            
            ${rawDetailsHtml} 
          </div>
        </div>
      `
    });

    marker.addListener("click", () => {
      infowin.open(map, marker);
    });

    marker._meta = project;
    markersBySite.set(uniqueKey, marker);
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
    // Check toggle status from DOM class 'active'
    const menaraActive = document.getElementById("toggle-menara")?.classList.contains("active");
    const nadiActive = document.getElementById("toggle-nadi")?.classList.contains("active");
    const popActive = document.getElementById("toggle-pop")?.classList.contains("active");
    const wifiActive = document.getElementById("toggle-wifi")?.classList.contains("active");

    let filteredList = allProjects;
    
    // Tapis mengikut kawasan (Sempadan)
    if (activeFeature && currentBoundaryKey) {
        let areaName = extractFeatureName(activeFeature);
        filteredList = allProjects.filter(p => {
            if (currentBoundaryKey === 'district') return p.DISTRICT === areaName;
            if (currentBoundaryKey === 'dun') return p.DUN === areaName;
            if (currentBoundaryKey === 'parliament') return p.PARLIAMENT === areaName;
            return false;
        });
    }

    // Tapis mengikut Carian (Search)
    if (searchTerm && searchTerm.length > 0) {
      const term = searchTerm.toLowerCase();
      filteredList = filteredList.filter(p => 
        (p.SITE_NAME && p.SITE_NAME.toLowerCase().includes(term)) ||
        (p.DISTRICT && p.DISTRICT.toLowerCase().includes(term)) ||
        (p.PARLIAMENT && p.PARLIAMENT.toLowerCase().includes(term))
      );
    }

    updateDashboard(filteredList);
    
    const visibleProjectKeys = new Set(
        filteredList
            .filter(p => p.LATITUDE !== 0 && p.LONGITUDE !== 0) 
            .map(p => p._id) 
    );

    markersList.forEach(m => {
        const type = m._meta._type;
        let isCategoryActive = false;

        if (type === "TOWER") isCategoryActive = menaraActive;
        else if (type === "BWA") isCategoryActive = wifiActive;
        else if (type === "NADI") isCategoryActive = nadiActive;
        else if (type === "POP") isCategoryActive = popActive;

        // Logic: Marker visible ONLY if category button is ACTIVE AND project is in filtered list
        const isVisible = visibleProjectKeys.has(m._meta._id) && isCategoryActive;
        m.setVisible(isVisible);
    });
}

const updateDashboard = debounce(function(list) {
  const displayList = list || allProjects || [];
  
  // Animate numbers
  animateValue("total-projects", parseInt(document.getElementById("total-projects").textContent), displayList.length, 500);
  
  const counts = { menara:0, nadi:0, wifi:0, pop:0 };
  const statusCounts = { "SIAP": 0, "PEMBINAAN": 0, "PERANCANGAN": 0 }; // Hanya 3 status ini
  
  displayList.forEach(p => {
    // Category Counts
    if (p._type === "TOWER") counts.menara++;
    if (p._type === "BWA") counts.wifi++;
    if (p._type === "NADI") counts.nadi++;
    if (p._type === "POP") counts.pop++;
    
    // Status Counts - Logic Pemadanan Ketat (Strict Mapping)
    const s = (p.STATUS || "").toUpperCase();
    if (s.includes("SIAP")) statusCounts["SIAP"]++;
    else if (s.includes("BINA") || s.includes("IMPLEMENTATION") || s.includes("PELAKSANAAN")) statusCounts["PEMBINAAN"]++;
    else if (s.includes("RANCANG") || s.includes("PLANNING") || s.includes("BARU")) statusCounts["PERANCANGAN"]++;
    // Status lain diabaikan dalam kiraan status dashboard, tetapi masih dikira dalam jumlah projek
  });
  
  document.getElementById("menara-count").textContent = counts.menara;
  document.getElementById("nadi-count").textContent = counts.nadi;
  document.getElementById("wifi-count").textContent = counts.wifi;
  document.getElementById("pop-count").textContent = counts.pop;

  // Render Status Bars - Fixed Order (UPDATED FOR PERCENTAGE AND VISUAL APPEAL)
  const statusEl = document.getElementById("status-list");
  statusEl.innerHTML = "";
  
  const validStatuses = ["SIAP", "PEMBINAAN", "PERANCANGAN"];

  validStatuses.forEach((k) => {
    const v = statusCounts[k];
    const percent = displayList.length > 0 ? Math.round((v / displayList.length) * 100) : 0;
    const barWidth = percent; 
    
    // Define gradient colors based on status
    let startColor = "#ccc", endColor = "#999";
    
    if(k === "SIAP") { startColor = "#81c784"; endColor = "#4CAF50"; } // Green
    if(k === "PEMBINAAN") { startColor = "#64b5f6"; endColor = "#2196F3"; } // Blue
    if(k === "PERANCANGAN") { startColor = "#ffb74d"; endColor = "#FF9800"; } // Orange

    const div = document.createElement("div");
    div.className = "status-item";
    div.innerHTML = `
      <div class="status-header">
        <span class="status-name">${escapeHtml(k)}</span>
        <div>
            <span class="status-percent" style="color: ${endColor};">${percent}%</span>
            <span class="status-count">(${v})</span>
        </div>
      </div>
      <div class="progress-bg">
        <div class="progress-fill" style="width: ${barWidth}%; background: linear-gradient(90deg, ${startColor}, ${endColor});"></div>
      </div>
    `;
    statusEl.appendChild(div);
  });
}, 200);

// Helper util for smooth number transition
function animateValue(id, start, end, duration) {
    if (start === end) return;
    const range = end - start;
    let current = start;
    const increment = end > start ? 1 : -1;
    const stepTime = Math.abs(Math.floor(duration / range));
    const obj = document.getElementById(id);
    if (!obj) return;
    
    const timer = setInterval(function() {
        current += increment;
        obj.innerHTML = current;
        if (current == end) {
            clearInterval(timer);
        }
    }, Math.max(stepTime, 10)); // Min 10ms
}


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
        strokeColor: baseStyle.strokeColor || "#666",
        fillOpacity: 0.05,
        fillColor: (baseStyle.fillColor || "#FFF")
    };
    layer.setStyle(feature => layer._baseStyle);

    layer.addListener("mouseover", e => {
      if (!layer.getMap()) return;
      if (activeFeature === e.feature) return;

      const hoverStyle = {
        strokeWeight: 2,
        strokeColor: "#4F46E5",
        fillOpacity: 0.3,
        fillColor: "#818cf8"
      };
      layer.overrideStyle(e.feature, hoverStyle);

      if (!hoverInfoWindow) hoverInfoWindow = new google.maps.InfoWindow();
      const title = extractFeatureName(e.feature);
      hoverInfoWindow.setContent(`<div style="padding:8px 12px; font-weight:600; color:#4F46E5;">${escapeHtml(title)}</div>`);
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

    const activeStyle = {
        strokeWeight: 2,
        strokeColor: "#4338ca",
        fillOpacity: 0.5,
        fillColor: "#4338ca"
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
  const categories = ["menara", "nadi", "pop", "wifi"];
  categories.forEach(cat => {
      document.getElementById(`toggle-${cat}`).addEventListener("click", function(){
        this.classList.toggle("active");
        filterAndDisplayMarkers();
      });
  });
  
  const boundaries = [
      {id: "toggle-daerah", key: "district"},
      {id: "toggle-dun", key: "dun"},
      {id: "toggle-parliament", key: "parliament"}
  ];

  boundaries.forEach(b => {
      document.getElementById(b.id).addEventListener("click", function(){
        // Jika sudah aktif, matikan (toggle off)
        if(this.classList.contains('active') && currentBoundaryKey === b.key) {
            this.classList.remove('active');
            dataLayers[b.key].setMap(null);
            currentBoundaryKey = null;
            activeFeature = null;
            document.getElementById("selected-area").textContent = "SELURUH SABAH";
        } else {
            toggleBoundaryLayerVisibility(b.key);
            document.getElementById("selected-area").textContent = "SABAH (" + b.key.toUpperCase() + ")";
        }
        filterAndDisplayMarkers(); 
      });
  });

  // Setup Search Listener
  const searchInput = document.getElementById("search-input");
  if(searchInput) {
      searchInput.addEventListener("input", (e) => {
          searchTerm = e.target.value;
          filterAndDisplayMarkers();
      });
  }
}

async function autoRefreshLoop() {
  try {
    const newProjects = await loadAllSheetsAndNormalize();
    newProjects.forEach(np => createOrUpdateMarker(np));
    
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

  // Google Maps Style: Clean & Modern (Silver/Grayscale)
  const silverStyle = [
    { elementType: "geometry", stylers: [{ color: "#f5f5f5" }] },
    { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#f5f5f5" }] },
    { featureType: "administrative.land_parcel", elementType: "labels.text.fill", stylers: [{ color: "#bdbdbd" }] },
    { featureType: "poi", elementType: "geometry", stylers: [{ color: "#eeeeee" }] },
    { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "road.arterial", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#dadada" }] },
    { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9c9c9" }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#9e9e9e" }] }
  ];

  map = new google.maps.Map(mapDiv, {
    center: { lat: 5.9804, lng: 116.0735 }, // Sabah
    zoom: 8,
    mapTypeId: "roadmap", 
    styles: silverStyle,
    disableDefaultUI: false, 
    streetViewControl: false,
    mapTypeControl: true,
    mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT, style: google.maps.MapTypeControlStyle.DROPDOWN_MENU },
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM }
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
      
      // Default View Logic:
      // Hanya aktifkan layer daerah (district)
      if (ld) {
        dataLayers['district'].setMap(map);
        currentBoundaryKey = 'district';
      }
      
      // Pastikan fungsi toggle menghormati kelas 'active' di HTML
      setupToggles();
      
      // Filter awal - semak butang 'active' (sekarang semua OFF default untuk markers)
      filterAndDisplayMarkers();
    });

    setInterval(() => { autoRefreshLoop(); }, refreshIntervalMs);

  } catch (e) {
    console.error("initMap main error", e);
    alert("Gagal memuatkan data. Sila semak sambungan internet.");
  } finally {
    showLoading(false);
  }
}

window.initMap = initMap;
