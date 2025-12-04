// -------------------------------
// script.js for WebGIS Sabah
// -------------------------------

let map;
let markers = []; // keep references
let boundaryLayers = {
  district: null,
  dun: null,
  parliament: null
};

const sheetIDs = {
  db_bwa: "1594VRWEs0PF56KXeSPudZTWkbGuS5UZmxXGrKqo4bUU",
  db_pim: "1WyZiw72LOVytssXAuymJS_TIgckLCUqY56pB0QhawZU",
  db_POP: "1JLqLtZPa4Kd6hEbRA2wgMgADX2h2-tdsXnG-YivSgU8",
  tower: "1b0Aipp0MQvP8HWc-z28dugkGn5sWdNAx6ZE5-Mu13-0"
};

const projectTypeForSheet = {
  db_bwa: "BWA",
  db_pim: "NADI",
  db_POP: "POP",
  tower: "TOWER"
};

const typeConfig = {
  BWA: { color: "#FF5722", icon: "🗼" },
  NADI: { color: "#2196F3", icon: "📡" },
  POP: { color: "#4CAF50", icon: "🌐" },
  TOWER: { color: "#FF9800", icon: "📶" } // you can switch icons
};

let allProjects = []; // full list
let active = {
  menara: true,
  nadi: true,
  wifi: true,
  pop: true,
  district: true,
  dun: true,
  parliament: true
};

// INIT MAP (callback for Google Maps API)
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 5.9804, lng: 116.0735 },
    zoom: 8,
    mapTypeId: "satellite",
    mapTypeControl: true,
    streetViewControl: false,
    fullscreenControl: true
  });

  showLoading(true);
  Promise.all([
    loadAllSheets(),
    loadGeoJsonLayer("district.json", "district"),
    loadGeoJsonLayer("dun.json", "dun"),
    loadGeoJsonLayer("parliament.json", "parliament")
  ]).then(([projects]) => {
    // projects is array from loadAllSheets
    addProjectsToMap(projects);
    updateDashboard(projects);
    showLoading(false);
    setupButtons();
  }).catch(err => {
    console.error(err);
    showLoading(false);
    alert("Ralat: gagal load data, semak console.");
  });
}

// Show / hide loading overlay
function showLoading(on) {
  const el = document.getElementById("loading");
  el.classList.toggle("show", !!on);
}

// LOAD GOOGLE SHEETS (gviz JSON)
async function loadSheet(sheetID) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetID}/gviz/tq?tqx=out:json`;
  const res = await fetch(url);
  const text = await res.text();
  // gviz response needs trimming
  const json = JSON.parse(text.substring(47, text.length - 2));
  const cols = json.table.cols.map(c => (c && c.label) ? c.label : "");
  const rows = json.table.rows || [];
  // produce array of objects with column names (case-insensitive)
  const result = rows.map(r => {
    const obj = {};
    cols.forEach((col, i) => {
      const key = (col || `col${i}`).toUpperCase();
      obj[key] = r.c[i] ? r.c[i].v : "";
    });
    return obj;
  });
  return result;
}

// load all sheets and unify into single array (adds TYPE)
async function loadAllSheets() {
  const promises = Object.entries(sheetIDs).map(([k,id]) => loadSheet(id).then(rows => {
    return rows.map(r => {
      // Normalize keys to expected columns (SITE_NAME, DISTRICT, DUN, PARLIAMENT, LATITUDE, LONGITUDE, STATUS)
      return {
        SITE_NAME: r.SITE_NAME || r.site_name || r["SITE NAME"] || r["SITE"] || "",
        DISTRICT: r.DISTRICT || r.district || r["DAERAH"] || "",
        DUN: r.DUN || r.dun || r["DUN"] || "",
        PARLIAMENT: r.PARLIAMENT || r.parliament || r["PARLIAMENT"] || r["PARLIMEN"] || "",
        LATITUDE: parseFloat(r.LATITUDE || r.latitude || r.Latitude || r.lat || 0) || 0,
        LONGITUDE: parseFloat(r.LONGITUDE || r.longitude || r.Longitude || r.lng || 0) || 0,
        STATUS: r.STATUS || r.status || "",
        _source_sheet: k,
        _type: projectTypeForSheet[k] || "UNKNOWN"
      };
    });
  }));
  const arrays = await Promise.all(promises);
  allProjects = arrays.flat();
  // filter out rows without coords
  allProjects = allProjects.filter(p => p.LATITUDE && p.LONGITUDE);
  return allProjects;
}

// ADD MARKERS
function addProjectsToMap(projects) {
  // clear old markers
  markers.forEach(m => m.setMap && m.setMap(null));
  markers = [];

  projects.forEach(p => {
    // map project type to config color/icon; adjust mapping if needed
    const cfg = typeConfig[p._type] || { color: "#000000", icon: "📍" };

    const marker = new google.maps.Marker({
      position: { lat: Number(p.LATITUDE), lng: Number(p.LONGITUDE) },
      map: map,
      title: p.SITE_NAME || "",
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
      content: infoWindowHtml(p, cfg)
    });

    marker.addListener("click", () => {
      infowin.open(map, marker);
    });

    marker._meta = p; // save for filtering
    markers.push(marker);
  });
}

// create info window html
function infoWindowHtml(p, cfg) {
  return `
    <div class="info-popup">
      <div class="info-title">${cfg.icon} ${escapeHtml(p.SITE_NAME)}</div>
      <div class="info-row"><div class="info-label">Daerah:</div><div class="info-value">${escapeHtml(p.DISTRICT)}</div></div>
      <div class="info-row"><div class="info-label">DUN:</div><div class="info-value">${escapeHtml(p.DUN)}</div></div>
      <div class="info-row"><div class="info-label">Parliament:</div><div class="info-value">${escapeHtml(p.PARLIAMENT)}</div></div>
      <div class="info-row"><div class="info-label">Status:</div><div class="info-value">${escapeHtml(p.STATUS)}</div></div>
      <div class="info-row"><div class="info-label">Koordinat:</div><div class="info-value">${p.LATITUDE}, ${p.LONGITUDE}</div></div>
    </div>
  `;
}

function escapeHtml(s) { return String(s || "").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// DASHBOARD
function updateDashboard(data) {
  const list = data || allProjects;
  document.getElementById("total-projects").textContent = list.length;

  // counts by type
  const counts = { menara:0, nadi:0, wifi:0, pop:0, TOWER:0, BWA:0, NADI:0, POP:0 };
  const statusCounts = {};
  list.forEach(p => {
    const t = p._type;
    counts[t] = (counts[t] || 0) + 1;
    // map to UI counters:
    if (t === "BWA" || t === "TOWER") counts.menara++;
    if (t === "NADI") counts.nadi++;
    if (t === "POP") counts.pop++;
    // assuming wifi possibly in POP sheet or other, leave wifi count empty unless explicitly in sheet
    statusCounts[p.STATUS] = (statusCounts[p.STATUS] || 0) + 1;
  });

  document.getElementById("menara-count").textContent = counts.menara || 0;
  document.getElementById("nadi-count").textContent = counts.nadi || 0;
  document.getElementById("wifi-count").textContent = counts.wifi || 0;
  document.getElementById("pop-count").textContent = counts.pop || 0;

  const statusList = document.getElementById("status-list");
  statusList.innerHTML = "";
  Object.entries(statusCounts).forEach(([s,c]) => {
    const div = document.createElement("div");
    div.className = "status-item";
    div.innerHTML = `<div class="status-name">${s}</div><div class="status-count">${c}</div>`;
    statusList.appendChild(div);
  });
}

// LOAD GEOJSON LAYER (DISTRICT / DUN / PARLIAMENT)
// expects that geojson file has feature.properties.NAME or similar
function loadGeoJsonLayer(url, key) {
  return new Promise((resolve, reject) => {
    fetch(url).then(r => r.json()).then(geojson => {
      // Convert to google maps Data layer
      const dataLayer = new google.maps.Data({ map: map });
      // If geojson is KML-like, try to extract features; else load directly
      try {
        dataLayer.addGeoJson(geojson);
      } catch (e) {
        // fallback: if geojson not valid, fail gracefully
        console.error("addGeoJson failed for", url, e);
      }
      // Styling for each layer
      const styleObj = {
        strokeWeight: 2,
        fillOpacity: 0.08,
        visible: true
      };
      if (key === "district") {
        styleObj.strokeColor = "#FF0000";
        styleObj.fillColor = "#FFCDD2";
      } else if (key === "dun") {
        styleObj.strokeColor = "#00AA00";
        styleObj.fillColor = "#C8E6C9";
      } else if (key === "parliament") {
        styleObj.strokeColor = "#2196F3";
        styleObj.fillColor = "#BBDEFB";
      }

      dataLayer.setStyle(feature => {
        return styleObj;
      });

      // click handler
      dataLayer.addListener("click", e => {
        const props = e.feature.getProperties ? e.feature.getProperties() : null;
        // property keys vary; try common names
        const name = props && (props.NAME || props.name || props.DISTRICT || props.DUN || props.PARLAMENT || props.PARLIAMENT || props.parliament) || "Undefined Area";
        document.getElementById("selected-area").textContent = name;
        // filter projects by area name if matches any of the area fields
        const filtered = allProjects.filter(p => (p.DISTRICT === name) || (p.DUN === name) || (p.PARLIAMENT === name));
        // adjust markers visibility to show only filtered
        markers.forEach(m => {
          const show = filtered.some(f => f.SITE_NAME === m._meta.SITE_NAME);
          m.setVisible(show);
        });
        updateDashboard(filtered);
        // zoom to bounds of clicked feature (if geometry exists)
        try {
          const bounds = new google.maps.LatLngBounds();
          e.feature.getGeometry().forEachLatLng && e.feature.getGeometry().forEachLatLng(latlng => {
            bounds.extend(latlng);
          });
          map.fitBounds(bounds);
        } catch (err) {
          // ignore
        }
      });

      boundaryLayers[key] = dataLayer;
      resolve(dataLayer);
    }).catch(err => {
      console.error("Fail load geojson", url, err);
      reject(err);
    });
  });
}

// SETUP BUTTONS (toggle boundaries & categories)
function setupButtons() {
  // category toggles: use marker._meta._type to control
  document.getElementById("toggle-menara").addEventListener("click", () => toggleCategory("menara"));
  document.getElementById("toggle-nadi").addEventListener("click", () => toggleCategory("nadi"));
  document.getElementById("toggle-wifi").addEventListener("click", () => toggleCategory("wifi"));
  document.getElementById("toggle-pop").addEventListener("click", () => toggleCategory("pop"));

  // boundary toggles
  document.getElementById("toggle-daerah").addEventListener("click", () => toggleBoundary("district", "toggle-daerah"));
  document.getElementById("toggle-dun").addEventListener("click", () => toggleBoundary("dun", "toggle-dun"));
  document.getElementById("toggle-parliament").addEventListener("click", () => toggleBoundary("parliament", "toggle-parliament"));
}

function toggleCategory(cat) {
  const btn = document.getElementById(`toggle-${cat}`);
  btn.classList.toggle("active");
  active[cat] = !active[cat];
  // show/hide markers based on type mapping
  markers.forEach(m => {
    const t = m._meta._type || "";
    let show = true;
    if ((t === "BWA" || t === "TOWER") && !active.menara) show = false;
    if (t === "NADI" && !active.nadi) show = false;
    if (t === "POP" && !active.pop) show = false;
    // wifi mapping depends on which sheet; adjust if you have specific
    m.setVisible(show);
  });
  // update dashboard to reflect visible markers
  const visible = markers.filter(m => m.getVisible()).map(m => m._meta);
  updateDashboard(visible);
}

function toggleBoundary(key, btnId) {
  const btn = document.getElementById(btnId);
  btn.classList.toggle("active");
  active[key === "district" ? "district" : key] = !active[key];
  const layer = boundaryLayers[key];
  if (!layer) return;
  const visible = btn.classList.contains("active");
  // Google Maps Data layer does not have simple visibility toggle; we remove/add to map
  if (visible) {
    layer.setMap(map);
  } else {
    layer.setMap(null);
    // reset dashboard to full
    updateDashboard(allProjects);
    markers.forEach(m => m.setVisible(true));
    document.getElementById("selected-area").textContent = "Semua Sabah";
  }
}

// On page load: nothing — initMap called by Google Maps API callback (in index.html)
