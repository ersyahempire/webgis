// ============================
// INITIALIZE MAP
// ============================

const map = L.map('map').setView([5.5, 116.5], 8); // Sabah view

// Google Satellite Basemap
L.gridLayer.googleMutant({
  maxZoom: 24,
  type: 'satellite'
}).addTo(map);


// ============================
// LOAD GOOGLE SHEET
// ============================

async function loadSheet(sheetID) {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${sheetID}/gviz/tq?tqx=out:json`;
    const res = await fetch(url);
    const text = await res.text();
    const json = JSON.parse(text.substr(47).slice(0, -2));

    return json.table.rows.map(r => ({
      SITE_NAME: r.c[0]?.v,
      DISTRICT: r.c[1]?.v,
      DUN: r.c[2]?.v,
      PARLIAMENT: r.c[3]?.v,
      LATITUDE: parseFloat(r.c[4]?.v),
      LONGITUDE: parseFloat(r.c[5]?.v),
      STATUS: r.c[6]?.v
    }));

  } catch (e) {
    console.error("Error loading sheet:", sheetID, e);
    return [];
  }
}


// ============================
// LOAD ALL PROJECT SHEETS
// ============================

Promise.all([
  loadSheet("1594VRWEs0PF56KXeSPudZTWkbGuS5UZmxXGrKqo4bUU"), // BWA / tower
  loadSheet("1WyZiw72LOVytssXAuymJS_TIgckLCUqY56pB0QhawZU"), // PIM / NADI
  loadSheet("1JLqLtZPa4Kd6hEbRA2wgMgADX2h2-tdsXnG-YivSgU8"), // POP / Wifi
  loadSheet("1b0Aipp0MQvP8HWc-z28dugkGn5sWdNAx6ZE5-Mu13-0")  // Tower
]).then(datasets => {
  
  const allData = [
    ...datasets[0].map(d => ({ ...d, type: "BWA" })),
    ...datasets[1].map(d => ({ ...d, type: "NADI" })),
    ...datasets[2].map(d => ({ ...d, type: "POP" })),
    ...datasets[3].map(d => ({ ...d, type: "TOWER" })),
  ];

  addProjectsToMap(allData);
  updateDashboard(allData);
});


// ============================
// ADD MARKERS TO MAP
// ============================

function getColor(type) {
  return {
    "BWA": "#ff5252",
    "NADI": "#ffa726",
    "POP": "#29b6f6",
    "TOWER": "#66bb6a"
  }[type] || "#ffffff";
}

function addProjectsToMap(data) {
  data.forEach(site => {
    if (!site.LATITUDE || !site.LONGITUDE) return;

    const marker = L.circleMarker([site.LATITUDE, site.LONGITUDE], {
      radius: 7,
      color: getColor(site.type),
      fillColor: getColor(site.type),
      fillOpacity: 0.9
    }).addTo(map);

    marker.bindPopup(`
      <b>${site.SITE_NAME}</b><br>
      ${site.DISTRICT}, ${site.DUN}<br>
      Parlimen: ${site.PARLIAMENT}<br>
      Status: <b>${site.STATUS}</b>
    `);
  });
}


// ============================
// DASHBOARD UPDATE
// ============================

function updateDashboard(data) {
  document.getElementById("totalProjects").innerText = data.length;

  const statusCount = {};

  data.forEach(d => {
    statusCount[d.STATUS] = (statusCount[d.STATUS] || 0) + 1;
  });

  const statusList = document.getElementById("statusList");
  statusList.innerHTML = "";

  Object.keys(statusCount).forEach(st => {
    statusList.innerHTML += `
      <div class="status-item">
        <div class="status-name">${st}</div>
        <div class="status-count">${statusCount[st]}</div>
      </div>
    `;
  });
}


// ============================
// LOAD BOUNDARIES
// ============================

function loadBoundary(file, color) {
  fetch(file)
    .then(res => res.json())
    .then(json => {
      L.geoJSON(json, {
        style: { color: color, weight: 2, fillOpacity: 0.05 },
        onEachFeature: function(feature, layer) {
          layer.on("click", function() {
            filterByArea(feature.properties.NAME);
          });
        }
      }).addTo(map);
    });
}

loadBoundary("district.json", "#ff0000");
loadBoundary("dun.json", "#00ff00");
loadBoundary("parliament.json", "#0000ff");


// ============================
// FILTER DASHBOARD BY AREA
// ============================

async function filterByArea(area) {
  const datasets = await Promise.all([
    loadSheet("1594VRWEs0PF56KXeSPudZTWkbGuS5UZmxXGrKqo4bUU"),
    loadSheet("1WyZiw72LOVytssXAuymJS_TIgckLCUqY56pB0QhawZU"),
    loadSheet("1JLqLtZPa4Kd6hEbRA2wgMgADX2h2-tdsXnG-YivSgU8"),
    loadSheet("1b0Aipp0MQvP8HWc-z28dugkGn5sWdNAx6ZE5-Mu13-0")
  ]);

  let all = [
    ...datasets[0], ...datasets[1], 
    ...datasets[2], ...datasets[3]
  ];

  const filtered = all.filter(d =>
    d.DISTRICT === area || d.DUN === area || d.PARLIAMENT === area
  );

  updateDashboard(filtered);
}
