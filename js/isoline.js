// ============================================================
// Reach map — fare / travel-time surface from any starting point
// ============================================================
(function () {
  'use strict';

  var esc = BKK.esc;

  var BOUNDS = { minLat: 13.48, maxLat: 14.08, minLng: 100.30, maxLng: 100.95 };
  var STEP = 0.004;            // grid cell (~440 m)
  var UPSAMPLE = 3;            // raster smoothing
  var EGRESS_KM = 1.0;         // walk from the last stop to the cell

  var BANDS = {
    cost: [15, 20, 25, 30, 40, 50, 70, 100, 150],
    time: [10, 15, 20, 30, 40, 50, 60, 90, 120],
  };
  var COLORS = ['#0f7b5f', '#3a9c6e', '#7cbf80', '#bddc93', '#f3e79b', '#f7c46c', '#f0904c', '#dd5a3b', '#b3302e'];

  var PRESETS = [
    ['Don Mueang Airport', 13.9133, 100.6040],
    ['Suvarnabhumi Airport', 13.6900, 100.7501],
    ['Siam', 13.7456, 100.5341],
    ['Khao San Road', 13.7589, 100.4974],
    ['Bang Kapi', 13.7660, 100.6440],
  ];

  var TRANSIT = [
    { id: 'all', label: 'All public transport', allow: null },
    { id: 'rail', label: 'Rail only', allow: function (r) { return r.k === 'r'; } },
    { id: 'bus', label: 'Bus only', allow: function (r) { return r.k === 'b'; } },
    { id: 'boat', label: 'Boat only', allow: function (r) { return r.k === 'o'; } },
  ];
  var ROAD = ['taxi', 'grab_car', 'grab_bike', 'motorcycle', 'tuktuk'];

  var map, overlay = null, originMarker, stationLayer;
  var modesById = {}, places = [], rail = null;
  var origin = { lat: PRESETS[0][1], lng: PRESETS[0][2], name: PRESETS[0][0] };
  var measure = 'cost', modeSel = 'all';
  var grid = null, nx, ny;

  function init() {
    nx = Math.round((BOUNDS.maxLng - BOUNDS.minLng) / STEP);
    ny = Math.round((BOUNDS.maxLat - BOUNDS.minLat) / STEP);
    map = BKK.createMap('map', { zoom: 11 });
    map.on('click', function (e) { setOrigin(e.latlng.lat, e.latlng.lng, null); });
    map.on('mousemove', hover);
    map.on('mouseout', function () { document.getElementById('hover').textContent = ''; });
    readHash();
    bind();

    Promise.all([
      BKK.getJSON('data/transport-modes.json'),
      BKK.getJSON('data/rail-network.json'),
      BKK.getJSON('data/rail-geometry.geojson'),
      TransitGraph.load(),
    ]).then(function (r) {
      r[0].modes.forEach(function (m) { modesById[m.id] = m; });
      var list = r[0].modes.slice();
      list.push(Object.assign({}, modesById.bus_ac, { id: 'bus' }));
      TransitGraph.setModes(list);
      rail = r[1];
      BKK.drawRail(map, rail, r[2], { weight: 2, opacity: 0.6, stations: false });
      stationLayer = L.layerGroup().addTo(map);
      buildPlaces();
      renderChips();
      document.getElementById('method').innerHTML =
        'Public transport: best route on the rail, BMTA bus and boat network, paying a fare each time you board, ' +
        'with up to 1 km of walking at each end. Road modes use straight-line distance × 1.35. Fares as of ' +
        esc(r[0].updated) + ' (air-con bus fares). <a href="index.html">Fare tables</a>';
      document.getElementById('loading').classList.add('hidden');
      setOrigin(origin.lat, origin.lng, origin.name);
    }).catch(function (err) {
      console.error(err);
      document.getElementById('loading').textContent = 'Could not load the network: ' + err.message;
    });
  }

  function buildPlaces() {
    var seen = {};
    PRESETS.forEach(function (p) { seen[p[0]] = 1; places.push({ label: p[0], name: p[0], lat: p[1], lng: p[2], th: '' }); });
    Object.keys(rail.stations).forEach(function (code) {
      var s = rail.stations[code];
      if (seen[s.name]) return;
      seen[s.name] = 1;
      places.push({ label: s.name + ' (' + code + ')', name: s.name, th: s.nameTh, lat: s.lat, lng: s.lng });
    });
    document.getElementById('placeList').innerHTML = places.map(function (p) {
      return '<option value="' + esc(p.label) + '">' + esc(p.th) + '</option>';
    }).join('');
  }

  function bind() {
    var input = document.getElementById('originInput');
    input.addEventListener('change', function () {
      var t = input.value.trim().toLowerCase();
      var p = places.find(function (x) { return x.label.toLowerCase() === t || x.name.toLowerCase() === t; }) ||
        places.find(function (x) { return x.label.toLowerCase().indexOf(t) >= 0 || (x.th && x.th.indexOf(input.value.trim()) >= 0); });
      if (p) { setOrigin(p.lat, p.lng, p.name); map.panTo([p.lat, p.lng]); }
    });
    document.querySelectorAll('#measure button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#measure button').forEach(function (x) { x.classList.toggle('active', x === b); });
        measure = b.dataset.m;
        recompute();
      });
    });
    document.getElementById('presets').innerHTML = PRESETS.map(function (p, i) {
      return '<button class="chip" data-i="' + i + '">' + esc(p[0]) + '</button>';
    }).join('');
    document.querySelectorAll('#presets .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = PRESETS[+b.dataset.i];
        setOrigin(p[1], p[2], p[0]);
        map.setView([p[1], p[2]], 11);
      });
    });
  }

  function renderChips() {
    document.getElementById('modeChips').innerHTML = TRANSIT.map(function (t) {
      return '<button class="chip' + (t.id === modeSel ? ' active' : '') + '" data-mode="' + t.id + '">' + esc(t.label) + '</button>';
    }).join('');
    document.getElementById('roadChips').innerHTML = ROAD.map(function (id) {
      var m = modesById[id];
      return '<button class="chip' + (id === modeSel ? ' active' : '') + '" data-mode="' + id + '"><span class="dot" style="background:' + m.color + '"></span>' + esc(m.name.replace(/ \(.*\)/, '')) + '</button>';
    }).join('');
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        modeSel = b.dataset.mode;
        document.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
        recompute();
      });
    });
  }

  function setOrigin(lat, lng, name) {
    origin = { lat: lat, lng: lng, name: name || (lat.toFixed(4) + ', ' + lng.toFixed(4)) };
    document.getElementById('originInput').value = origin.name;
    if (!originMarker) {
      originMarker = L.marker([lat, lng], {
        draggable: true, zIndexOffset: 1000,
        icon: L.divIcon({ className: '', html: '<div class="map-pin o"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(map);
      originMarker.on('dragend', function () { var p = originMarker.getLatLng(); setOrigin(p.lat, p.lng, null); });
    } else {
      originMarker.setLatLng([lat, lng]);
    }
    writeHash();
    recompute();
  }

  // ---------------------------------------------------------------
  function recompute() {
    if (!TransitGraph.network()) return;
    var busy = document.getElementById('busy');
    busy.classList.remove('hidden');
    updateLegend();
    setTimeout(function () {
      var t0 = performance.now();
      grid = ROAD.indexOf(modeSel) >= 0 ? roadGrid(modesById[modeSel]) : transitGrid();
      draw();
      busy.classList.add('hidden');
      console.log('reach grid ' + nx + 'x' + ny + ' in ' + Math.round(performance.now() - t0) + ' ms');
    }, 20);
  }

  function cellCenter(i, j) {
    return [BOUNDS.minLat + (j + 0.5) * STEP, BOUNDS.minLng + (i + 0.5) * STEP];
  }

  function roadGrid(mode) {
    var g = new Float32Array(nx * ny);
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var c = cellCenter(i, j);
        var t = TransitGraph.roadTrip(mode, origin.lat, origin.lng, c[0], c[1]);
        g[j * nx + i] = measure === 'cost' ? t.fare : t.minutes;
      }
    }
    return { values: g, stops: null };
  }

  function transitGrid() {
    var sel = TRANSIT.find(function (t) { return t.id === modeSel; });
    var isCost = measure === 'cost';
    var reach = TransitGraph.reachFrom(origin.lat, origin.lng, isCost ? 'cheapest' : 'fastest', sel.allow, 240);
    var net = TransitGraph.network();
    var g = new Float32Array(nx * ny).fill(Infinity);
    var walkMin = TransitGraph.walkMin;

    function splat(lat, lng, base, maxKm) {
      var rad = Math.ceil(maxKm / (STEP * 105)) + 1;
      var ci = Math.floor((lng - BOUNDS.minLng) / STEP), cj = Math.floor((lat - BOUNDS.minLat) / STEP);
      for (var dj = -rad; dj <= rad; dj++) {
        var j = cj + dj;
        if (j < 0 || j >= ny) continue;
        for (var di = -rad; di <= rad; di++) {
          var i = ci + di;
          if (i < 0 || i >= nx) continue;
          var c = cellCenter(i, j);
          var d = TransitGraph.haversineKm(lat, lng, c[0], c[1]);
          if (d > maxKm) continue;
          var v = isCost ? base : base + walkMin(d);
          var k = j * nx + i;
          if (v < g[k]) g[k] = v;
        }
      }
    }
    splat(origin.lat, origin.lng, 0, 1.5);          // walking from the origin itself
    var vals = isCost ? reach.fare : reach.time;
    for (var s = 0; s < net.stops.length; s++) {
      if (isFinite(vals[s])) splat(net.stops[s][0], net.stops[s][1], vals[s], EGRESS_KM);
    }
    return { values: g, stops: vals };
  }

  // ---------------------------------------------------------------
  function bandOf(v) {
    var b = BANDS[measure];
    for (var i = 0; i < b.length; i++) if (v <= b[i]) return i;
    return -1;
  }

  // bilinear sample in grid coordinates (cell centres at integer + 0.5)
  function sample(fx, fy) {
    var x = fx - 0.5, y = fy - 0.5;
    var x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    var vals = grid.values, acc = 0, w = 0, nearest = Infinity, nd = 9;
    for (var dy = 0; dy <= 1; dy++) {
      for (var dx = 0; dx <= 1; dx++) {
        var i = x0 + dx, j = y0 + dy;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        var v = vals[j * nx + i];
        var ww = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        var dd = Math.abs(dx - tx) + Math.abs(dy - ty);
        if (dd < nd) { nd = dd; nearest = v; }
        if (isFinite(v)) { acc += v * ww; w += ww; }
      }
    }
    if (!isFinite(nearest)) return Infinity;
    return w > 0.5 ? acc / w : nearest;
  }

  function draw() {
    var W = nx * UPSAMPLE, H = ny * UPSAMPLE;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(W, H);
    var rgb = COLORS.map(function (c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; });
    for (var py = 0; py < H; py++) {
      var fy = (H - py - 0.5) / UPSAMPLE;      // canvas row 0 = north edge
      for (var px = 0; px < W; px++) {
        var v = sample((px + 0.5) / UPSAMPLE, fy);
        var b = isFinite(v) ? bandOf(v) : -1;
        if (b < 0) continue;
        var o = (py * W + px) * 4;
        img.data[o] = rgb[b][0]; img.data[o + 1] = rgb[b][1]; img.data[o + 2] = rgb[b][2]; img.data[o + 3] = 125;
      }
    }
    ctx.putImageData(img, 0, 0);
    var url = canvas.toDataURL();
    var bounds = [[BOUNDS.minLat, BOUNDS.minLng], [BOUNDS.minLat + ny * STEP, BOUNDS.minLng + nx * STEP]];
    if (overlay) overlay.setUrl(url);
    else overlay = L.imageOverlay(url, bounds, { opacity: 1, interactive: false }).addTo(map);
    drawStations();
  }

  function drawStations() {
    stationLayer.clearLayers();
    var net = TransitGraph.network();
    var unit = measure === 'cost' ? 'THB' : 'min';
    var rows = [];
    Object.keys(net.codes).forEach(function (idx) {
      var code = net.codes[idx], s = rail.stations[code];
      var v = grid.stops ? grid.stops[idx] : sample((s.lng - BOUNDS.minLng) / STEP, (s.lat - BOUNDS.minLat) / STEP);
      var b = isFinite(v) ? bandOf(v) : -1;
      L.circleMarker([s.lat, s.lng], {
        radius: 3.5, weight: 1.5, color: '#fff',
        fillColor: b >= 0 ? COLORS[b] : '#9aa1ad', fillOpacity: 1,
      }).bindTooltip('<b>' + esc(s.name) + '</b> ' + code + '<br>' +
        (isFinite(v) ? Math.round(v) + ' ' + unit : 'not reachable'), { direction: 'top' })
        .addTo(stationLayer);
      if (isFinite(v)) rows.push({ name: s.name, v: v });
    });
    rows.sort(function (a, b) { return a.v - b.v; });
    var seen = {};
    var uniq = rows.filter(function (r) { if (seen[r.name]) return false; seen[r.name] = 1; return true; });
    var total = {};
    Object.keys(rail.stations).forEach(function (c) { total[rail.stations[c].name] = 1; });
    document.getElementById('countNote').textContent = uniq.length + ' of ' + Object.keys(total).length + ' stations reachable';
    var bands = BANDS[measure], groups = [];
    bands.forEach(function (lim, i) {
      var inBand = uniq.filter(function (r) { return r.v <= lim && (i === 0 || r.v > bands[i - 1]); });
      if (inBand.length) groups.push({ band: i, lim: lim, n: inBand.length, ex: inBand.slice(0, 3) });
    });
    document.getElementById('summary').innerHTML = groups.map(function (g) {
      return '<div class="rank-row" style="cursor:default"><div class="rank-name"><span class="dot" style="background:' + COLORS[g.band] + '"></span>' +
        '<span>' + g.ex.map(function (e) { return esc(e.name); }).join(', ') + (g.n > 3 ? ' +' + (g.n - 3) + ' more' : '') + '</span></div>' +
        '<div class="rank-val num">≤ ' + g.lim + '<small>' + unit + '</small></div></div>';
    }).join('') || '<div class="empty">No stations reachable with this mode from here.</div>';
  }

  function updateLegend() {
    var sel = TRANSIT.find(function (t) { return t.id === modeSel; });
    var name = sel ? sel.label.toLowerCase() : modesById[modeSel].name;
    document.getElementById('legendTitle').textContent =
      (measure === 'cost' ? 'Fare (THB)' : 'Door-to-door minutes') + ' — ' + name;
    document.getElementById('legendScale').innerHTML = COLORS.map(function (c) { return '<span style="background:' + c + '"></span>'; }).join('');
    document.getElementById('legendLabels').innerHTML = BANDS[measure].map(function (b) { return '<span>' + b + '</span>'; }).join('');
  }

  function hover(e) {
    if (!grid) return;
    var v = sample((e.latlng.lng - BOUNDS.minLng) / STEP, (e.latlng.lat - BOUNDS.minLat) / STEP);
    document.getElementById('hover').textContent = isFinite(v)
      ? 'Under cursor: ≈ ' + Math.round(v) + (measure === 'cost' ? ' THB' : ' min')
      : 'Under cursor: not reachable';
  }

  function writeHash() {
    history.replaceState(null, '', '#o=' + origin.lat.toFixed(5) + ',' + origin.lng.toFixed(5) + ',' + encodeURIComponent(origin.name));
  }
  function readHash() {
    var m = location.hash.match(/o=(-?[\d.]+),(-?[\d.]+)(?:,([^&]*))?/);
    if (m) origin = { lat: +m[1], lng: +m[2], name: m[3] ? decodeURIComponent(m[3]) : (m[1] + ', ' + m[2]) };
  }

  init();
})();
