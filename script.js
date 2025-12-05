// script.js (Optimized for performance — Balanced simplification ~5% assumed)
// Replace existing script.js with this file.

const URLs = {
  district: "https://ersyahempire.github.io/webgis/district.json",
  dun: "https://ersyahempire.github.io/webgis/dun.json",
  parliament: "https://ersyahempire.github.io/webgis/parliament.json"
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

// State
let map;
let markersBySite = new Map(); // SITE_NAME -> google.maps.Marker
let markersList = []; // array of markers (for iteration)
let allProjects = []; // array of normalized project objects
let areaIndex = new Map(); // areaName -> Set of SITE_NAME (fast filter)
let dataLayers = {};
let refreshIntervalMs = 60_000; // auto refresh every 60s
let batchSize = 300; // markers per chunk when rendering (tune if needed)
let hoverInfoWindow = new google.maps.InfoWindow(); // sms over effect


// Utility helpers
function showLoading(on) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.classList.toggle("show", !!on);
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function debounce(fn, wait=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; }

// GViz parse
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

// Fetch and parse a single sheet
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

// Normalize to expected keys and types; filter invalid coords
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
  }).filter(o => o.SITE_NAME && o.LATITUDE && o.LONGITUDE);
  return normalized;
}

// Build areaIndex for quick filtering (called after allProjects set)
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

// Marker creation / update
function createOrUpdateMarker(project) {
  const site = project.SITE_NAME;
  const cfg = TYPE_CFG[project._type] || { color: "#333", icon: "📍" };
  if (markersBySite.has(site)) {
    // update existing marker position & meta if changed
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
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 7,
        fillColor: cfg.color,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 1
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
      document.getElementById("selected-area").textContent = project.DISTRICT || project.DUN || project.PARLIAMENT || "Undefined";
    });
    marker._meta = project;
    markersBySite.set(site, marker);
    markersList.push(marker);
    return marker;
  }
}

// Batch render markers to avoid blocking UI
function renderMarkersInBatches(projects, onComplete) {
  // create/update but in chunks
  const total = projects.length;
  let i = 0;
  const runChunk = () => {
    const end = Math.min(i + batchSize, total);
    for (; i < end; i++) {
      const p = projects[i];
      createOrUpdateMarker(p);
    }
    // yield to browser
    if (i < total) {
      // prefer requestIdleCallback when available
      if (window.requestIdleCallback) window.requestIdleCallback(runChunk, { timeout: 200 });
      else setTimeout(runChunk, 50);
    } else {
      if (typeof onComplete === "function") onComplete();
    }
  };
  runChunk();
}

// Show/hide markers quickly using precomputed lists (fast)
function setMarkerVisibilityForArea(areaName) {
  if (!areaName) {
    // show all markers
    markersList.forEach(m => m.setVisible(true));
    updateDashboard(allProjects);
    return;
  }
  const normalized = String(areaName).trim();
  const siteSet = areaIndex.get(normalized) || new Set();
  // hide all then show those in set
  markersList.forEach(m => m.setVisible(siteSet.has(m._meta.SITE_NAME)));
  const filtered = allProjects.filter(p => siteSet.has(p.SITE_NAME));
  updateDashboard(filtered);
}

// Dashboard update (debounced)
const updateDashboard = debounce(function(filteredList) {
  const list = filteredList || allProjects || [];
  document.getElementById("total-projects").textContent = list.length;
  const counts = { menara:0, nadi:0, wifi:0, pop:0 };
  const statusCounts = {};
  list.forEach(p => {
    if (p._type === "BWA" || p._type === "TOWER") counts.menara++;
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
  Object.entries(statusCounts).forEach(([k,v]) => {
    const div = document.createElement("div");
    div.className = "status-item";
    div.innerHTML = `<div class="status-name">${k}</div><div class="status-count">${v}</div>`;
    statusEl.appendChild(div);
  });
}, 200);

// Load all sheets (concurrent)
async function loadAllSheetsAndNormalize() {
  const entries = Object.entries(SHEETS);
  const promises = entries.map(([k,id]) => fetchSheetObjectsSafe(k, id));
  const results = await Promise.all(promises);
  // flatten normalized
  const combined = results.flat();
  allProjects = combined;
  buildAreaIndex();
  return combined;
}

// Safe wrapper for sheet fetch + normalize
async function fetchSheetObjectsSafe(sheetKey, id) {
  try {
    const rows = await fetchSheetObjects(id);
    return normalizeRows(rows, sheetKey);
  } catch (e) {
    console.warn("sheet load fail", sheetKey, e);
    return [];
  }
}

// Wrapper to fetch sheet raw rows as objects (GViz)
async function fetchSheetObjects(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet fetch failed ${res.status}`);
  const text = await res.text();
  const json = parseGviz(text);
  if (!json || !json.table) return [];
  const cols = json.table.cols.map(c => c && c.label ? c.label : "");
  const rows = json.table.rows || [];
  return rows.map(r => {
    const o = {};
    cols.forEach((c,i) => o[c ? c.toUpperCase() : `COL${i}`] = (r.c && r.c[i] ? r.c[i].v : ""));
    return o;
  });
}

// GeoJSON load into google.maps.Data (with random colors, hover highlight + tooltip)
async function loadGeoJsonLayer(key, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`geojson fetch ${url} status ${res.status}`);
    const json = await res.json();

    const layer = new google.maps.Data({ map: map });
    layer.addGeoJson(json);

    // store random color per feature
    const randomColors = new Map();

    function getRandomColor(id) {
      if (randomColors.has(id)) return randomColors.get(id);
      const color = "#" + Math.floor(Math.random() * 16777215).toString(16);
      randomColors.set(id, color);
      return color;
    }

    // default style: random color
    layer.setStyle(feature => {
      const id = feature.getId() || feature.getProperty("NAME") || Math.random();
      const color = getRandomColor(id);
      return {
        fillColor: color,
        fillOpacity: 0.5,
        strokeColor: color,
        strokeWeight: 1
      };
    });

    // -------------------------
    // HOVER EFFECT
    // -------------------------
    layer.addListener("mouseover", e => {
      const id = e.feature.getId() || e.feature.getProperty("NAME");
      const color = getRandomColor(id);

      layer.overrideStyle(e.feature, {
        fillColor: color,
        fillOpacity: 0.8,
        strokeColor: "#000000",
        strokeWeight: 3
      });

      // Tooltip / Infowindow
      const props = ["NAME", "name", "DISTRICT", "DAERAH", "DUN", "PARLIAMENT", "PARLIAMEN"];
      let name = "Unknown Area";
      for (const k of props) {
        const v = e.feature.getProperty(k);
        if (v) { name = v; break; }
      }

      hoverInfoWindow.setContent(`
        <div style="font-size:14px; font-weight:bold;">
          ${name}
        </div>
      `);

      hoverInfoWindow.setPosition(e.latLng);
      hoverInfoWindow.open(map);
    });

    layer.addListener("mouseout", e => {
      hoverInfoWindow.close();
      layer.revertStyle(e.feature);
    });

    // -------------------------
    // CLICK to filter markers
    // -------------------------
    layer.addListener("click", e => {
      const props = ["NAME","name","DISTRICT","DAERAH","DUN","PARLIAMENT","PARLIAMEN"];
      let name = "Area";
      for (const k of props) {
        const v = e.feature.getProperty(k);
        if (v) { name = v; break; }
      }

      document.getElementById("selected-area").textContent = name;

      setMarkerVisibilityForArea(name);

      try {
        const bounds = new google.maps.LatLngBounds();
        e.feature.getGeometry().forEachLatLng(ll => bounds.extend(ll));
        map.fitBounds(bounds);
      } catch (_) {}
    });

    dataLayers[key] = layer;
    return layer;

  } catch (e) {
    console.warn("loadGeoJsonLayer error", key, e);
    return null;
  }
}



// Setup UI toggles
function setupToggles() {
  document.getElementById("toggle-menara").addEventListener("click", function(){
    this.classList.toggle("active");
    const visible = this.classList.contains("active");
    markersList.forEach(m => {
      const t = m._meta._type;
      if (t === "BWA" || t === "TOWER") m.setVisible(visible);
    });
    updateDashboard(markersList.filter(m => m.getVisible()).map(m => m._meta));
  });
  document.getElementById("toggle-nadi").addEventListener("click", function(){
    this.classList.toggle("active");
    const visible = this.classList.contains("active");
    markersList.forEach(m => { if (m._meta._type === "NADI") m.setVisible(visible); });
    updateDashboard(markersList.filter(m=>m.getVisible()).map(m=>m._meta));
  });
  document.getElementById("toggle-pop").addEventListener("click", function(){
    this.classList.toggle("active");
    const visible = this.classList.contains("active");
    markersList.forEach(m => { if (m._meta._type === "POP") m.setVisible(visible); });
    updateDashboard(markersList.filter(m=>m.getVisible()).map(m=>m._meta));
  });
  document.getElementById("toggle-wifi").addEventListener("click", function(){
    this.classList.toggle("active");
    // implement if wifi is in separate dataset
  });

  // boundary toggles
  document.getElementById("toggle-daerah").addEventListener("click", function(){
    this.classList.toggle("active");
    const show = this.classList.contains("active");
    if (dataLayers.district) dataLayers.district.setMap(show ? map : null);
    if (!show) { document.getElementById("selected-area").textContent = "Semua Sabah"; markersList.forEach(m=>m.setVisible(true)); updateDashboard(allProjects); }
  });
  document.getElementById("toggle-dun").addEventListener("click", function(){
    this.classList.toggle("active");
    const show = this.classList.contains("active");
    if (dataLayers.dun) dataLayers.dun.setMap(show ? map : null);
    if (!show) { document.getElementById("selected-area").textContent = "Semua Sabah"; markersList.forEach(m=>m.setVisible(true)); updateDashboard(allProjects); }
  });
  document.getElementById("toggle-parliament").addEventListener("click", function(){
    this.classList.toggle("active");
    const show = this.classList.contains("active");
    if (dataLayers.parliament) dataLayers.parliament.setMap(show ? map : null);
    if (!show) { document.getElementById("selected-area").textContent = "Semua Sabah"; markersList.forEach(m=>m.setVisible(true)); updateDashboard(allProjects); }
  });
}

// Auto-refresh that updates markers incrementally rather than recreate all
async function autoRefreshLoop() {
  try {
    const newProjects = await loadAllSheetsAndNormalize();
    // update allProjects and areaIndex
    // update existing markers & create new ones
    const existingSiteNames = new Set(allProjects.map(p => p.SITE_NAME));
    // update or add
    newProjects.forEach(np => {
      createOrUpdateMarker(np);
    });
    // remove markers that no longer exist
    const newSiteNames = new Set(newProjects.map(p => p.SITE_NAME));
    for (const [site,m] of markersBySite.entries()) {
      if (!newSiteNames.has(site)) {
        m.setMap(null);
        markersBySite.delete(site);
      }
    }
    // rebuild marker list
    markersList = Array.from(markersBySite.values());
    allProjects = newProjects;
    buildAreaIndex();
    updateDashboard(allProjects);
  } catch (e) {
    console.warn("autoRefreshLoop failed", e);
  }
}

// MAIN init (Google Maps callback)
async function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 5.9804, lng: 116.0735 },
    zoom: 8,
    mapTypeId: "satellite",
    streetViewControl: false,
    fullscreenControl: true
  });

  showLoading(true);
  try {
    // 1) load project sheets and normalize
    const projects = await loadAllSheetsAndNormalize();
    // 2) render markers in batches (non-blocking)
    renderMarkersInBatches(projects, () => {
      // after all markers created, ensure markersList is sync
      markersList = Array.from(markersBySite.values());
      updateDashboard(allProjects);
    });

    // 3) load geojson boundaries AFTER initial map idle -> smoother UX
    google.maps.event.addListenerOnce(map, "idle", async () => {
      await loadGeoJsonLayer("district", URLs.district, { strokeWeight: 2, strokeColor: "#FF0000", fillOpacity: 0.05, fillColor: "#FFCDD2" });
      await loadGeoJsonLayer("dun", URLs.dun, { strokeWeight: 2, strokeColor: "#00AA00", fillOpacity: 0.04, fillColor: "#C8E6C9" });
      await loadGeoJsonLayer("parliament", URLs.parliament, { strokeWeight: 2, strokeColor: "#2196F3", fillOpacity: 0.04, fillColor: "#BBDEFB" });
    });

    setupToggles();

    // 4) periodic background refresh (incremental)
    setInterval(() => {
      // run refresh but don't block UI
      autoRefreshLoop();
    }, refreshIntervalMs);

  } catch (e) {
    console.error("initMap main error", e);
    alert("Ralat load data — semak console (F12).");
  } finally {
    showLoading(false);
  }
}

// expose
window.initMap = initMap;
