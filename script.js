// script.js - WebGIS Sabah (Google Maps + GeoJSON + Google Sheets)
// Ensure index.html calls Google Maps with callback=initMap

/* CONFIG: change if necessary */
const API_KEY = "AIzaSyDRKvwm2qw29P6nRe6AFk0UMlSv356qMI0"; // already in index.html; kept here for reference
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

/* STATE */
let map;
let markers = []; // google.maps.Marker[]
let allProjects = []; // normalized data
let dataLayers = { district: null, dun: null, parliament: null };
let refreshInterval = 60 * 1000; // auto-refresh every 60s

/* Utils */
function showLoading(on) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.classList.toggle("show", !!on);
}
function escapeHtml(s){ return String(s||"").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* GVIZ parse helper */
function parseGviz(text) {
  // extract JSON object inside response
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const jsonText = text.substring(start, end + 1);
    return JSON.parse(jsonText);
  } catch (e) {
    console.error("parseGviz error", e);
    return null;
  }
}

/* Load a single Google Sheet via gviz */
async function loadSheet(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Sheet fetch failed: " + url + " status:" + resp.status);
  const text = await resp.text();
  const g = parseGviz(text);
  if (!g || !g.table) return [];
  const cols = g.table.cols.map(c => (c && c.label) ? c.label : "");
  const rows = g.table.rows || [];
  return rows.map(r => {
    const obj = {};
    cols.forEach((c,i) => obj[c ? c.toUpperCase() : `COL${i}`] = (r.c[i] ? r.c[i].v : ""));
    return obj;
  });
}

/* Normalize rows from sheets to expected fields */
function normalizeRows(rows, sheetKey) {
  return rows.map(r => {
    const get = k => (r[k] !== undefined ? r[k] : (r[k.toLowerCase()] !== undefined ? r[k.toLowerCase()] : ""));
    // attempt common header names
    const site = get("SITE_NAME") || get("SITE NAME") || get("SITE") || get("SITE_NAME");
    const district = get("DISTRICT") || get("DAERAH") || get("DISTRIK") || get("DISTRIK");
    const dun = get("DUN") || get("D.A.N") || get("Dewan") || get("Dun");
    const parliament = get("PARLIAMENT") || get("PARLIAMEN") || get("PARLIAMENT_NAME") || get("PARLIAMENT");
    const lat = parseFloat(get("LATITUDE") || get("LAT") || get("LATITUDE_DEC") || 0) || 0;
    const lng = parseFloat(get("LONGITUDE") || get("LON") || get("LONG") || 0) || 0;
    const status = get("STATUS") || get("KETERANGAN") || get("STATE") || "";
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
  }).filter(o => o.LATITUDE && o.LONGITUDE);
}

/* Load all sheets */
async function loadAllSheets() {
  const entries = Object.entries(SHEETS);
  const results = await Promise.all(entries.map(([k,id]) => loadSheet(id).then(rows => ({ k, rows })).catch(e => { console.error("sheet load fail", k, e); return { k, rows: [] }; })));
  const combined = [];
  results.forEach(r => {
    const norm = normalizeRows(r.rows, r.k);
    norm.forEach(n => combined.push(n));
  });
  allProjects = combined;
  return combined;
}

/* Marker management */
function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function createMarker(project) {
  const cfg = TYPE_CFG[project._type] || { color: "#333", icon: "📍" };
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
  marker._meta = project;
  const infowindow = new google.maps.InfoWindow({
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
    infowindow.open(map, marker);
    // when marker clicked, set selected-area to its district (prefer district then dun then parliament)
    const name = project.DISTRICT || project.DUN || project.PARLIAMENT || "Undefined";
    document.getElementById("selected-area").textContent = name;
    // optionally pan map mildly
    map.panTo(marker.getPosition());
  });
  return marker;
}

function renderMarkers(list) {
  clearMarkers();
  list.forEach(p => {
    const m = createMarker(p);
    markers.push(m);
  });
}

/* Dashboard updates */
function updateDashboard(filteredList) {
  const list = filteredList || allProjects || [];
  document.getElementById("total-projects").textContent = list.length;

  const counts = { menara: 0, nadi: 0, wifi: 0, pop: 0 };
  const statusCounts = {};
  list.forEach(p => {
    const t = p._type;
    if (t === "BWA" || t === "TOWER") counts.menara++;
    if (t === "NADI") counts.nadi++;
    if (t === "POP") counts.pop++;
    // wifi may be part of POP or other: leave 0 unless specified
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
}

/* Load GeoJSON into google.maps.Data */
async function loadGeoJSONIntoData(key, url, style) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("geojson fetch failed " + url);
    const json = await resp.json();
    const dataLayer = new google.maps.Data({ map: map });
    try {
      dataLayer.addGeoJson(json);
    } catch(e) {
      // some geojson may already be in feature collection; try manual add
      console.warn("addGeoJson failed, attempting single feature add", e);
    }
    dataLayer.setStyle(feature => style);
    dataLayer.addListener("click", evt => {
      // try several property names for the area name
      const propKeys = ["NAME","Name","name","DISTRICT","DAERAH","DUN","PARLIAMENT","PARLAMENT","PARLIAMENT_N","NAME_1"];
      let name = "Area";
      for (const k of propKeys) {
        try {
          const v = evt.feature.getProperty(k);
          if (v) { name = v; break; }
        } catch(_) {}
      }
      document.getElementById("selected-area").textContent = name;
      // filter projects by matching name in any of the three fields
      filterMarkersByArea(name);
      // optional: zoom to feature bound
      try {
        const bounds = new google.maps.LatLngBounds();
        evt.feature.getGeometry().forEachLatLng && evt.feature.getGeometry().forEachLatLng(ll => bounds.extend(ll));
        map.fitBounds(bounds);
      } catch(e){}
    });
    dataLayers[key] = dataLayer;
    return dataLayer;
  } catch(e) {
    console.warn("loadGeoJSONIntoData error", e);
    return null;
  }
}

/* Filter markers by area name */
function filterMarkersByArea(name) {
  const filtered = allProjects.filter(p => {
    return [p.DISTRICT, p.DUN, p.PARLIAMENT].some(x => String(x||"").trim() === String(name||"").trim());
  });
  // hide all then show matching
  markers.forEach(m => {
    const keep = filtered.some(f => f.SITE_NAME === m._meta.SITE_NAME);
    m.setVisible(keep);
  });
  updateDashboard(filtered);
}

/* Toggles handling */
function setupToggles() {
  // category toggles
  document.getElementById("toggle-menara").addEventListener("click", function(){
    this.classList.toggle("active");
    const on = this.classList.contains("active");
    markers.forEach(m => {
      const t = m._meta._type;
      if (t === "BWA" || t === "TOWER") m.setVisible(on);
    });
    updateDashboard(markers.filter(m => m.getVisible()).map(m => m._meta));
  });
  document.getElementById("toggle-nadi").addEventListener("click", function(){
    this.classList.toggle("active");
    const on = this.classList.contains("active");
    markers.forEach(m => { if (m._meta._type === "NADI") m.setVisible(on); });
    updateDashboard(markers.filter(m => m.getVisible()).map(m => m._meta));
  });
  document.getElementById("toggle-pop").addEventListener("click", function(){
    this.classList.toggle("active");
    const on = this.classList.contains("active");
    markers.forEach(m => { if (m._meta._type === "POP") m.setVisible(on); });
    updateDashboard(markers.filter(m => m.getVisible()).map(m => m._meta));
  });
  document.getElementById("toggle-wifi").addEventListener("click", function(){
    this.classList.toggle("active");
    // If Wifi is in separate sheet you can implement; currently no distinct wifi sheet
  });

  // boundary toggles - show/hide data layers
  document.getElementById("toggle-daerah").addEventListener("click", function(){
    this.classList.toggle("active");
    const show = this.classList.contains("active");
    if (dataLayers.district) dataLayers.district.setMap(show ? map : null);
    if (!show) {
      document.getElementById("selected-area").textContent = "Semua Sabah";
      markers.forEach(m => m.setVisible(true));
      updateDashboard(allProjects);
    }
  });
  document.getElementById("toggle-dun").addEventListener("click", function(){
    this.classList.toggle("active");
    const show = this.classList.contains("active");
    if (dataLayers.dun) dataLayers.dun.setMap(show ? map : null);
    if (!show) { document.getElementById("selected-area").textContent = "Semua Sabah"; markers.forEach(m=>m.setVisible(true)); updateDashboard(allProjects); }
  });
  document.getElementById("toggle-parliament").addEventListener("click", function(){
    this.classList.toggle("active");
    const show = this.classList.contains("active");
    if (dataLayers.parliament) dataLayers.parliament.setMap(show ? map : null);
    if (!show) { document.getElementById("selected-area").textContent = "Semua Sabah"; markers.forEach(m=>m.setVisible(true)); updateDashboard(allProjects); }
  });
}

/* MAIN INIT - called by Google Maps callback (index.html) */
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
    // load sheets then geojson
    const projects = await loadAllSheets();
    renderMarkers(projects);
    updateDashboard(projects);

    // Load district/dun/parliament as GeoJSON Data layers
    await loadGeoJSONIntoData("district", URLs.district, {
      strokeWeight: 2, strokeColor: "#FF0000", fillOpacity: 0.06, fillColor: "#FFCDD2"
    });
    await loadGeoJSONIntoData("dun", URLs.dun, {
      strokeWeight: 2, strokeColor: "#00AA00", fillOpacity: 0.05, fillColor: "#C8E6C9"
    });
    await loadGeoJSONIntoData("parliament", URLs.parliament, {
      strokeWeight: 2, strokeColor: "#2196F3", fillOpacity: 0.05, fillColor: "#BBDEFB"
    });

    setupToggles();

    // auto refresh sheets every X ms (safe small interval)
    setInterval(async () => {
      try {
        const refreshed = await loadAllSheets();
        // re-render markers but try to preserve visible state toggles
        const visibilityMap = new Map();
        markers.forEach(m => visibilityMap.set(m._meta.SITE_NAME, m.getVisible()));
        renderMarkers(refreshed);
        // restore visibility
        markers.forEach(m => {
          const prev = visibilityMap.get(m._meta.SITE_NAME);
          if (prev === false) m.setVisible(false);
        });
        updateDashboard(refreshed);
      } catch(e){ console.warn("auto-refresh fail", e); }
    }, refreshInterval);

  } catch(e) {
    console.error("initMap error", e);
    alert("Ralat: gagal load data. Semak console (F12).");
  } finally {
    showLoading(false);
  }
}

/* Expose initMap globally (callback) */
window.initMap = initMap;
