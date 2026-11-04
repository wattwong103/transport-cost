// ============================================================
// Compare modes — fare and time for a trip of a given length
// ============================================================
(function () {
  'use strict';

  var esc = BKK.esc;
  var GROUPS = [
    { id: 'rail', label: 'Rail' },
    { id: 'bus', label: 'Bus' },
    { id: 'boat', label: 'Boat' },
    { id: 'road', label: 'Road' },
  ];
  // boats that only cover short or fixed stretches are left out of the distance comparison
  var SKIP = { ferry: 1, khlong_padung: 1, khlong_bangkok_yai: 1, cp_yellow: 1, cp_green: 1, cp_local: 1, cp_tourist: 1, smart_ferry: 1 };
  var DEFAULT_CHART = ['bts', 'mrt_blue', 'srt_red', 'bus_ac', 'bus_nonac', 'cp_orange', 'taxi', 'grab_car', 'motorcycle'];

  var modes = [], data = null, rail = null, spacing = {};
  var km = 10, sortBy = 'fare', chartMetric = 'fare', chart = null, openId = null;
  var chartSet = {};
  var map, layers = {};

  function load() {
    Promise.all([
      BKK.getJSON('data/transport-modes.json'),
      BKK.getJSON('data/rail-network.json'),
      BKK.getJSON('data/rail-geometry.geojson'),
      BKK.getJSON('data/osm-boat-routes.geojson'),
    ]).then(function (r) {
      data = r[0];
      modes = data.modes.filter(function (m) { return !SKIP[m.id]; });
      TransitGraph.setModes(data.modes);
      rail = r[1];
      computeSpacing();
      DEFAULT_CHART.forEach(function (id) { chartSet[id] = 1; });
      initMap(r[2], r[3]);
      renderNotes();
      render();
      document.getElementById('loading').classList.add('hidden');
    }).catch(function (err) {
      console.error(err);
      document.getElementById('loading').textContent = 'Could not load data: ' + err.message;
    });
  }

  // average km between stations per fare system, to turn "km" into "stations"
  function computeSpacing() {
    var sum = {}, n = {};
    rail.lines.forEach(function (l) {
      for (var i = 1; i < l.stations.length; i++) {
        var a = rail.stations[l.stations[i - 1]], b = rail.stations[l.stations[i]];
        var d = TransitGraph.haversineKm(a.lat, a.lng, b.lat, b.lng) * 1.05;
        sum[l.fare] = (sum[l.fare] || 0) + d; n[l.fare] = (n[l.fare] || 0) + 1;
      }
    });
    for (var f in sum) spacing[f] = sum[f] / n[f];
  }

  function trip(mode, dist) {
    var stops = 0, minutes;
    if (mode.type === 'rail') {
      stops = Math.max(1, Math.round(dist / (spacing[mode.id] || 1.2)));
      minutes = dist / mode.speedKmh * 60 + stops * 0.5 + mode.waitMin + 3;
    } else if (mode.type === 'bus') {
      minutes = dist / mode.speedKmh * 60 + dist / 0.45 * 0.35 + mode.waitMin;
    } else if (mode.type === 'boat') {
      minutes = dist / mode.speedKmh * 60 + mode.waitMin + 1;
    } else {
      minutes = dist / mode.speedKmh * 60 + mode.waitMin;
    }
    var fare = TransitGraph.legFare(mode, { km: dist, stops: stops, minutes: minutes });
    var range = mode.fare.range ? [Math.round(fare * mode.fare.range[0]), Math.round(fare * mode.fare.range[1])] : null;
    var note = '';
    if (mode.type === 'rail') note = '≈ ' + stops + ' station' + (stops > 1 ? 's' : '');
    var maxKm = lineLength(mode.id);
    var outOfRange = maxKm && dist > maxKm + 0.5;
    return { fare: fare, minutes: minutes, range: range, note: note, outOfRange: outOfRange, maxKm: maxKm };
  }

  // longest possible single ride on a rail system (km)
  function lineLength(fareId) {
    var best = 0;
    rail.lines.forEach(function (l) {
      if (l.fare !== fareId) return;
      var d = 0;
      for (var i = 1; i < l.stations.length; i++) {
        var a = rail.stations[l.stations[i - 1]], b = rail.stations[l.stations[i]];
        d += TransitGraph.haversineKm(a.lat, a.lng, b.lat, b.lng) * 1.05;
      }
      best = Math.max(best, d);
    });
    if (fareId === 'bts' || fareId === 'srt_red') best *= 1.6;   // two lines in one fare system
    if (fareId === 'cp_orange') best = 25;
    if (fareId === 'khlong') best = 18;
    return best || 0;
  }

  // ---------------------------------------------------------------
  function render() {
    document.getElementById('kmValue').textContent = km + ' km';
    var rows = modes.map(function (m) { return { m: m, t: trip(m, km) }; });
    var key = sortBy === 'fare' ? function (r) { return r.t.fare; } : function (r) { return r.t.minutes; };
    var maxV = Math.max.apply(null, rows.filter(function (r) { return !r.t.outOfRange; }).map(key));
    var html = '';
    GROUPS.forEach(function (g) {
      var list = rows.filter(function (r) { return r.m.type === g.id; }).sort(function (a, b) {
        return (a.t.outOfRange - b.t.outOfRange) || key(a) - key(b);
      });
      if (!list.length) return;
      html += '<div class="rank-group">' + g.label + '</div>';
      list.forEach(function (r) {
        var t = r.t, m = r.m;
        var fareTxt = t.range ? t.range[0] + '–' + t.range[1] : t.fare;
        var val = sortBy === 'fare'
          ? fareTxt + ' ฿<small>' + Math.round(t.minutes) + ' min</small>'
          : Math.round(t.minutes) + ' min<small>' + fareTxt + ' ฿</small>';
        if (t.outOfRange) val = '<span class="muted" style="font-weight:500">longest ride ≈ ' + Math.round(t.maxKm) + ' km</span>';
        var pct = t.outOfRange ? 0 : Math.max(2, key(r) / maxV * 100);
        html += '<button class="rank-row' + (openId === m.id ? ' active' : '') + '" data-id="' + m.id + '">' +
          '<div class="rank-name"><span class="dot" style="background:' + m.color + ';' + (chartSet[m.id] ? '' : 'opacity:.35') + '"></span><span>' + esc(m.name) + '</span></div>' +
          '<div class="rank-val num">' + val + '</div>' +
          '<div class="rank-bar"><i style="width:' + pct + '%;background:' + m.color + '"></i></div></button>';
        if (openId === m.id) html += detail(m, t);
      });
    });
    var box = document.getElementById('rank');
    box.innerHTML = html;
    box.querySelectorAll('.rank-row').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var id = b.dataset.id;
        if (e.target.classList.contains('dot')) {          // dot toggles the chart line
          if (chartSet[id]) delete chartSet[id]; else chartSet[id] = 1;
        } else {
          openId = openId === id ? null : id;
          if (openId) chartSet[id] = 1;
        }
        render();
      });
    });
    renderChart();
  }

  function detail(m, t) {
    var f = m.fare, table = '';
    if (f.kind === 'stations' || f.kind === 'km') {
      var unit = f.kind === 'stations' ? 'stations' : 'km';
      var prev = 0;
      table = '<table class="fare-table"><tr><th>' + (unit === 'km' ? 'Distance' : 'Stations travelled') + '</th><th>Fare</th></tr>' +
        f.table.map(function (r) {
          var lbl = r.upTo >= 999 ? (prev + 1) + '+' : (prev + 1 === r.upTo ? r.upTo : (prev + (unit === 'km' ? 0 : 1)) + '–' + r.upTo);
          if (unit === 'km') lbl = r.upTo >= 999 ? 'over ' + prev + ' km' : 'up to ' + r.upTo + ' km';
          prev = r.upTo;
          return '<tr><td>' + lbl + '</td><td class="num">' + r.fare + ' ฿</td></tr>';
        }).join('') + '</table>';
    } else if (f.kind === 'meter') {
      table = '<table class="fare-table"><tr><th>Meter</th><th>Rate</th></tr><tr><td>First ' + f.baseKm + ' km</td><td>' + f.base + ' ฿</td></tr>' +
        f.tiers.map(function (r, i) {
          var from = i ? f.tiers[i - 1].upTo : f.baseKm;
          return '<tr><td>' + from + (r.upTo > 999 ? '+ km' : '–' + r.upTo + ' km') + '</td><td>' + r.rate.toFixed(2) + ' ฿/km</td></tr>';
        }).join('') + (f.perMinIdle ? '<tr><td>Standstill traffic</td><td>' + f.perMinIdle + ' ฿/min</td></tr>' : '') + '</table>';
    } else if (f.kind === 'linear') {
      table = '<table class="fare-table"><tr><td>' + f.base + ' ฿ + ' + f.perKm.toFixed(2) + ' ฿/km</td><td>max ' + f.max + ' ฿</td></tr></table>';
    } else if (f.kind === 'distance') {
      table = '<table class="fare-table"><tr><td>First ' + f.baseKm + ' km</td><td>' + f.base + ' ฿</td></tr>' +
        (f.tiers ? f.tiers.map(function (r, i) {
          var from = i ? f.tiers[i - 1].upTo : f.baseKm;
          return '<tr><td>' + from + (r.upTo > 999 ? '+ km' : '–' + r.upTo + ' km') + '</td><td>' + r.rate + ' ฿/km</td></tr>';
        }).join('') : '<tr><td>Each extra km</td><td>' + f.perKm + ' ฿</td></tr>') +
        (f.perMin ? '<tr><td>Per minute</td><td>' + f.perMin + ' ฿</td></tr>' : '') + '</table>';
    } else if (f.kind === 'flat') {
      table = '<table class="fare-table"><tr><td>Any distance</td><td>' + f.fare + ' ฿</td></tr></table>';
    }
    var src = (m.sources || []).map(function (s) {
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + '</a> <span class="muted">(' + esc(s.date) + ')</span></li>';
    }).join('');
    return '<div class="mode-detail"><h3>' + esc(m.name) + ' <span class="muted" style="font-weight:500">' + esc(m.nameTh) + '</span></h3>' +
      '<p class="leg-sub" style="margin-top:4px">' + esc(m.description) + '</p>' +
      (m.accuracy ? '<p class="note" style="margin-top:6px;color:var(--warn)">' + esc(m.accuracy) + '</p>' : '') +
      table +
      '<p class="note" style="margin-top:8px">Hours: ' + esc(m.hours) + ' · average ' + m.speedKmh + ' km/h · typical wait ' + m.waitMin + ' min</p>' +
      (src ? '<ul class="note" style="margin-top:6px;padding-left:16px">' + src + '</ul>' : '') + '</div>';
  }

  function renderChart() {
    var xs = [];
    for (var d = 1; d <= 40; d++) xs.push(d);
    var sets = modes.filter(function (m) { return chartSet[m.id]; }).map(function (m) {
      return {
        label: m.name,
        data: xs.map(function (d) {
          var t = trip(m, d);
          if (t.outOfRange) return null;
          return chartMetric === 'fare' ? t.fare : Math.round(t.minutes);
        }),
        borderColor: m.color, backgroundColor: m.color,
        borderWidth: openId === m.id ? 3.5 : 2, pointRadius: 0, pointHoverRadius: 4,
        stepped: chartMetric === 'fare' && m.fare.kind !== 'meter' && m.fare.kind !== 'distance' && m.fare.kind !== 'linear' ? 'before' : false,
        spanGaps: false,
      };
    });
    var cfg = {
      type: 'line',
      data: { labels: xs, datasets: sets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
          tooltip: { callbacks: { title: function (c) { return c[0].label + ' km'; },
            label: function (c) { return c.dataset.label + ': ' + c.parsed.y + (chartMetric === 'fare' ? ' ฿' : ' min'); } } },
        },
        scales: {
          x: { title: { display: true, text: 'km' }, ticks: { maxTicksLimit: 9 }, grid: { display: false } },
          y: chartMetric === 'fare'
            ? { type: 'logarithmic', min: 5, title: { display: true, text: 'THB (log scale)' },
                afterBuildTicks: function (ax) { ax.ticks = [5, 10, 20, 50, 100, 200, 500].filter(function (v) { return v <= ax.max * 1.05; }).map(function (v) { return { value: v }; }); },
                ticks: { callback: function (v) { return v; } } }
            : { beginAtZero: true, title: { display: true, text: 'minutes' } },
        },
      },
    };
    if (chart) { chart.data = cfg.data; chart.options = cfg.options; chart.update(); }
    else chart = new Chart(document.getElementById('chart'), cfg);
  }

  function renderNotes() {
    document.getElementById('notes').innerHTML =
      '<li>Fares checked ' + esc(data.updated) + '.</li>' +
      data.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
      '<li>Rail trips are converted from km to stations using each line’s average station spacing. Road distances are along the road.</li>';
  }

  // ---------------------------------------------------------------
  function initMap(railGeo, boatGeo) {
    map = BKK.createMap('map');
    var r = BKK.drawRail(map, rail, railGeo);
    rail.lines.forEach(function (l) {
      if (r.byLine[l.id]) layers[l.id] = { name: l.name, color: l.color, layer: r.byLine[l.id], on: true, group: r.group };
    });
    var boats = L.layerGroup();
    boatGeo.features.forEach(function (f) {
      var g = f.geometry;
      if (g.type === 'Point') {
        L.circleMarker([g.coordinates[1], g.coordinates[0]], { radius: 3, color: '#fff', weight: 1, fillColor: '#0E7C86', fillOpacity: 1 })
          .bindPopup('<div class="pop-title">' + esc(f.properties.name || 'Pier') + '</div>').addTo(boats);
      } else {
        var parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
        parts.forEach(function (p) {
          L.polyline(p.map(function (c) { return [c[1], c[0]]; }), { color: '#0E7C86', weight: 2.5, opacity: 0.7, dashArray: '6 5' })
            .bindPopup(esc(f.properties.name || 'Boat route')).addTo(boats);
        });
      }
    });
    boats.addTo(map);
    layers.boats = { name: 'Boats', color: '#0E7C86', layer: boats, on: true };
    layers.bus = { name: 'Bus routes', color: '#E67E22', layer: null, on: false };
    renderLayerChips();
  }

  function renderLayerChips() {
    var box = document.getElementById('layerChips');
    box.innerHTML = Object.keys(layers).map(function (k) {
      var l = layers[k];
      return '<button class="chip' + (l.on ? ' active' : '') + '" data-l="' + k + '"><span class="dot" style="background:' + l.color + '"></span>' + esc(l.name) + '</button>';
    }).join('');
    box.querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () { toggleLayer(b.dataset.l); });
    });
  }

  function toggleLayer(k) {
    var l = layers[k];
    l.on = !l.on;
    if (k === 'bus' && !l.layer) {
      BKK.getJSON('longdo data/longdomap-bus-gtfs/routes.geojson').then(function (gj) {
        l.layer = L.geoJSON(gj, { style: { color: '#E67E22', weight: 1.2, opacity: 0.35 },
          onEachFeature: function (f, lay) { lay.bindPopup('Bus ' + esc(f.properties.route_name || '')); } });
        if (l.on) l.layer.addTo(map);
      });
    } else if (l.layer) {
      var parent = l.group || map;
      if (l.on) parent.addLayer(l.layer); else parent.removeLayer(l.layer);
    }
    renderLayerChips();
  }

  // ---------------------------------------------------------------
  document.getElementById('kmSlider').addEventListener('input', function (e) { km = +e.target.value; render(); });
  document.querySelectorAll('#sortBy button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#sortBy button').forEach(function (x) { x.classList.toggle('active', x === b); });
      sortBy = b.dataset.s; render();
    });
  });
  document.querySelectorAll('#chartMetric button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#chartMetric button').forEach(function (x) { x.classList.toggle('active', x === b); });
      chartMetric = b.dataset.c; renderChart();
    });
  });
  load();
})();
