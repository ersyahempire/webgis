// SAMBUNG KE GOOGLE SHEET
async function loadSheet(sheetID) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetID}/gviz/tq?tqx=out:json`;
    const res = await fetch(url);
    const text = await res.text();
    const json = JSON.parse(text.substr(47).slice(0, -2));
    return json.table.rows.map(r => {
        return {
            SITE_NAME: r.c[0]?.v,
            DISTRICT: r.c[1]?.v,
            DUN: r.c[2]?.v,
            PARLIAMENT: r.c[3]?.v,
            LATITUDE: parseFloat(r.c[4]?.v),
            LONGITUDE: parseFloat(r.c[5]?.v),
            STATUS: r.c[6]?.v
        };
    });
}

Promise.all([
    loadSheet("1594VRWEs0PF56KXeSPudZTWkbGuS5UZmxXGrKqo4bUU"), // BWA
    loadSheet("1WyZiw72LOVytssXAuymJS_TIgckLCUqY56pB0QhawZU"), // PIM
    loadSheet("1JLqLtZPa4Kd6hEbRA2wgMgADX2h2-tdsXnG-YivSgU8"), // POP
    loadSheet("1b0Aipp0MQvP8HWc-z28dugkGn5sWdNAx6ZE5-Mu13-0"), // Tower
]).then(data => {
    addProjectsToMap(data);
});


// LAYER MAP
fetch('district.json')
  .then(res => res.json())
  .then(data => L.geoJSON(data, {
      style: { color: "#FF0000", weight: 2 }
  }).addTo(map));

fetch('dun.json')
  .then(res => res.json())
  .then(data => L.geoJSON(data, {
      style: { color: "#00FF00", weight: 2 }
  }).addTo(map));

fetch('parliament.json')
  .then(res => res.json())
  .then(data => L.geoJSON(data, {
      style: { color: "#0000FF", weight: 2 }
  }).addTo(map));

// PAGE INTERAKTIF
onEachFeature: function(feature, layer) {
    layer.on('click', function() {
        updateDashboard(feature.properties.NAME);
    });
}
