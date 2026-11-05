// ============================================================
// Trip planner
// ============================================================
(function () {
  'use strict';

  var esc = BKK.esc, fmtMin = BKK.fmtMin, fmtKm = BKK.fmtKm;

  var EXAMPLES = [
    { label: 'Don Mueang Airport → Siam', o: [13.9133, 100.6040, 'Don Mueang Airport (DMK)'], d: [13.7456, 100.5341, 'Siam'] },
    { label: 'Suvarnabhumi → Asok', o: [13.6900, 100.7501, 'Suvarnabhumi Airport (BKK)'], d: [13.7370, 100.5603, 'Asok'] },
    { label: 'Khao San Road → Chatuchak Market', o: [13.7589, 100.4974, 'Khao San Road'], d: [13.7999, 100.5505, 'Chatuchak Weekend Market'] },
    { label: 'Nonthaburi Pier → ICONSIAM', o: [13.8418, 100.4934, 'Nonthaburi Pier'], d: [13.7266, 100.5103, 'ICONSIAM'] },
    { label: 'Bang Kapi → Silom', o: [13.7660, 100.6440, 'The Mall Bang Kapi'], d: [13.7286, 100.5340, 'Silom (Sala Daeng)'] },
  ];

  var PROFILE_LABELS = {
    balanced: { tag: 'Recommended', cls: '' },
    cheapest: { tag: 'Cheapest', cls: 'cheap' },
    fastest: { tag: 'Fastest', cls: '' },
  };

  var ROAD_MODES = ['taxi', 'grab_car', 'grab_bike', 'motorcycle', 'tuktuk'];

  var map, routeLayer, railLayer;
  var modes = [], modesById = {}, places = [];
  var points = { o: null, d: null };
  var markers = { o: null, d: null };
  var picking = 'o';
  var busMode = 'bus_ac';
  var results = [], selected = 0;

  // ---------------------------------------------------------------
  function init() {
    map = BKK.createMap('map');
    routeLayer = L.layerGroup().addTo(map);
    map.on('click', function (e) { setPoint(picking, e.latlng.lat, e.latlng.lng, null); });
    bindControls();
    readHash();

    Promise.all([
      BKK.getJSON('data/transport-modes.json'),
      BKK.getJSON('data/rail-network.json'),
      BKK.getJSON('data/rail-geometry.geojson'),
      TransitGraph.load(),
    ]).then(function (r) {
      modes = r[0].modes;
      modes.forEach(function (m) { modesById[m.id] = m; });
      applyBusMode();
      railLayer = BKK.drawRail(map, r[1], r[2], { weight: 3, opacity: 0.55, stationRadius: 3 });
      buildPlaces(r[1]);
      document.getElementById('faresNote').innerHTML =
        'Fares as of ' + esc(r[0].updated) + '. Bus and boat fares assume one ticket per boarding; ' +
        'rail fares follow each operator’s table. <a href="compare.html">See all fare tables</a>.';
      document.getElementById('loading').classList.add('hidden');
      renderExamples();
      compute();
    }).catch(function (err) {
      console.error(err);
      document.getElementById('loading').textContent = 'Could not load the network: ' + err.message;
    });
  }

  function applyBusMode() {
    var src = modesById[busMode];
    var list = modes.slice();
    list.push(Object.assign({}, src, { id: 'bus' }));   // routes in the network use fare id "bus"
    TransitGraph.setModes(list);
  }

  function buildPlaces(rail) {
    var seen = {};
    Object.keys(rail.stations).forEach(function (code) {
      var s = rail.stations[code];
      var key = s.name;
      if (seen[key]) return;
      seen[key] = 1;
      places.push({ label: s.name + ' (' + code + ')', th: s.nameTh, lat: s.lat, lng: s.lng, name: s.name });
    });
    var net = TransitGraph.network();
    net.stops.forEach(function (s) {
      if (s[2] === 'o' && s[3] && !seen['pier:' + s[3]]) {
        seen['pier:' + s[3]] = 1;
        places.push({ label: s[3], th: '', lat: s[0], lng: s[1], name: s[3] });
      }
    });
    EXAMPLES.forEach(function (ex) {
      [ex.o, ex.d].forEach(function (p) {
        if (!seen[p[2]]) { seen[p[2]] = 1; places.push({ label: p[2], th: '', lat: p[0], lng: p[1], name: p[2] }); }
      });
    });
    var dl = document.getElementById('placeList');
    dl.innerHTML = places.map(function (p) {
      return '<option value="' + esc(p.label) + '">' + esc(p.th) + '</option>';
    }).join('');
  }

  function findPlace(text) {
    var t = text.trim().toLowerCase();
    if (!t) return null;
    var exact = places.find(function (p) { return p.label.toLowerCase() === t || p.name.toLowerCase() === t || (p.th && p.th === text.trim()); });
    if (exact) return exact;
    return places.find(function (p) { return p.label.toLowerCase().indexOf(t) === 0; }) ||
      places.find(function (p) { return p.label.toLowerCase().indexOf(t) >= 0 || (p.th && p.th.indexOf(text.trim()) >= 0); }) || null;
  }

  // ---------------------------------------------------------------
  function bindControls() {
    ['o', 'd'].forEach(function (k) {
      var input = document.getElementById(k === 'o' ? 'originInput' : 'destInput');
      input.addEventListener('focus', function () { setPicking(k); });
      input.addEventListener('change', function () {
        var p = findPlace(input.value);
        if (p) { setPoint(k, p.lat, p.lng, p.name); map.panTo([p.lat, p.lng]); }
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { input.blur(); input.dispatchEvent(new Event('change')); }
      });
    });
    document.querySelectorAll('[data-clear]').forEach(function (b) {
      b.addEventListener('click', function () { clearPoint(b.dataset.clear); });
    });
    document.getElementById('swapBtn').addEventListener('click', function () {
      var o = points.o, d = points.d;
      points.o = null; points.d = null;
      if (d) setPoint('o', d.lat, d.lng, d.name, true); else clearPoint('o', true);
      if (o) setPoint('d', o.lat, o.lng, o.name, true); else clearPoint('d', true);
      compute();
    });
    document.getElementById('locateBtn').addEventListener('click', function () {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(function (pos) {
        setPoint('o', pos.coords.latitude, pos.coords.longitude, 'My location');
        map.setView([pos.coords.latitude, pos.coords.longitude], 14);
      }, function () { alert('Could not get your location.'); }, { timeout: 8000 });
    });
    document.querySelectorAll('#busType button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#busType button').forEach(function (x) { x.classList.toggle('active', x === b); });
        busMode = b.dataset.bus;
        applyBusMode();
        compute();
      });
    });
  }

  function setPicking(k) {
    picking = k;
    document.getElementById('originInput').classList.toggle('picking', k === 'o');
    document.getElementById('destInput').classList.toggle('picking', k === 'd');
    document.getElementById('mapHint').textContent = BKK.tapWord(points.o && points.d
      ? 'Drag a pin, or click the map to move the ' + (k === 'o' ? 'start' : 'destination')
      : k === 'o' ? 'Click the map to set your starting point' : 'Click the map to set your destination');
  }

  function setPoint(k, lat, lng, name, silent) {
    points[k] = { lat: lat, lng: lng, name: name || (lat.toFixed(4) + ', ' + lng.toFixed(4)) };
    var input = document.getElementById(k === 'o' ? 'originInput' : 'destInput');
    input.value = points[k].name;
    document.querySelector('[data-clear="' + k + '"]').classList.remove('hidden');
    if (markers[k]) markers[k].setLatLng([lat, lng]);
    else {
      markers[k] = L.marker([lat, lng], {
        draggable: true, zIndexOffset: 1000,
        icon: L.divIcon({ className: '', html: '<div class="map-pin ' + k + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(map);
      markers[k].on('dragend', function () {
        var p = markers[k].getLatLng();
        setPoint(k, p.lat, p.lng, null);
      });
    }
    if (!silent) {
      setPicking(k === 'o' && !points.d ? 'd' : (k === 'd' && !points.o ? 'o' : k));
      compute();
    }
  }

  function clearPoint(k, silent) {
    points[k] = null;
    if (markers[k]) { map.removeLayer(markers[k]); markers[k] = null; }
    document.getElementById(k === 'o' ? 'originInput' : 'destInput').value = '';
    document.querySelector('[data-clear="' + k + '"]').classList.add('hidden');
    setPicking(k);
    if (!silent) compute();
  }

  // ---------------------------------------------------------------
  function compute() {
    writeHash();
    var has = points.o && points.d;
    document.getElementById('examplesSection').classList.toggle('hidden', !!has);
    ['optionsSection', 'itinSection', 'roadSection'].forEach(function (id) {
      document.getElementById(id).classList.toggle('hidden', !has);
    });
    routeLayer.clearLayers();
    if (!has || !TransitGraph.network()) return;

    var o = points.o, d = points.d;
    var seen = {};
    results = [];
    ['balanced', 'cheapest', 'fastest'].forEach(function (p) {
      var r = TransitGraph.plan(o.lat, o.lng, d.lat, d.lng, p);
      if (!r) return;
      var sig = r.legs.map(function (l) { return l.type + (l.route ? l.route.id + l.from + l.to : ''); }).join('|');
      if (seen[sig]) { seen[sig].tags.push(p); return; }
      r.tags = [p];
      seen[sig] = r;
      results.push(r);
    });
    selected = 0;
    renderOptions();
    renderRoad();
    if (results.length) select(0, true);
    else {
      document.getElementById('itin').innerHTML =
        '<div class="empty"><strong>No public-transport route found</strong>One of the points may be too far from any stop. Try moving it closer to a road or station.</div>';
    }
  }

  function renderOptions() {
    var box = document.getElementById('options');
    if (!results.length) { box.innerHTML = ''; return; }
    box.innerHTML = results.map(function (r, i) {
      var tags = r.tags.map(function (t) {
        return '<span class="option-tag ' + PROFILE_LABELS[t].cls + '">' + PROFILE_LABELS[t].tag + '</span>';
      }).join(' · ');
      var strip = r.legs.filter(function (l) { return l.type !== 'walk' || l.km > 0.15; }).map(function (l) {
        if (l.type === 'walk') return '<span class="seg-pill walk">🚶 ' + Math.round(l.minutes) + '</span>';
        return '<span class="seg-pill" style="background:' + l.color + '">' + esc(BKK.shortLabel(l)) + '</span>';
      }).join('<span class="strip-arrow">›</span>');
      return '<button class="option' + (i === selected ? ' active' : '') + '" data-i="' + i + '">' +
        '<div class="option-top">' + tags +
        '<div class="option-stats"><span><span class="stat-big num">' + r.fare + '</span><span class="stat-unit">THB</span></span>' +
        '<span><span class="stat-big num">' + r.minutes + '</span><span class="stat-unit">min</span></span></div></div>' +
        '<div class="option-strip">' + strip + '</div>' +
        '<div class="option-meta">' + (r.transfers ? r.transfers + ' change' + (r.transfers > 1 ? 's' : '') + ' · ' : 'Direct · ') +
        fmtKm(r.walkKm) + ' walking</div></button>';
    }).join('');
    box.querySelectorAll('.option').forEach(function (b) {
      b.addEventListener('click', function () { select(+b.dataset.i); });
    });
  }

  function select(i, fit) {
    selected = i;
    document.querySelectorAll('#options .option').forEach(function (b, j) { b.classList.toggle('active', j === i); });
    var r = results[i];
    renderItinerary(r);
    drawRoute(r, fit !== false);
  }

  function legIcon(l) {
    if (l.type === 'walk') return '<div class="leg-ic walk">🚶</div>';
    var txt = l.type === 'bus' ? 'BUS' : l.type === 'boat' ? '⛴' : 'M';
    if (l.type === 'rail') txt = BKK.shortLabel(l).slice(0, 4);
    return '<div class="leg-ic" style="background:' + l.color + ';font-size:' + (txt.length > 3 ? 9 : 11) + 'px">' + esc(txt) + '</div>';
  }

  function renderItinerary(r) {
    var html = r.legs.map(function (l) {
      if (l.type === 'walk') {
        return '<div class="leg">' + legIcon(l) + '<div><div class="leg-title">Walk ' + fmtKm(l.km) + '</div>' +
          '<div class="leg-meta">about ' + fmtMin(l.minutes) + '</div></div><div class="leg-fare">—</div></div>';
      }
      var title, sub;
      if (l.type === 'rail') {
        title = l.lines.map(function (x) { return esc(x.n); }).join(' → ');
        sub = esc(l.from) + (l.fromCode ? ' <span class="muted">' + l.fromCode + '</span>' : '') +
          ' → ' + esc(l.to) + (l.toCode ? ' <span class="muted">' + l.toCode + '</span>' : '');
      } else if (l.type === 'bus') {
        title = 'Bus ' + esc(l.route.n);
        sub = (l.route.d ? 'towards ' + esc(l.route.d.split(' - ').pop()) + '<br>' : '') +
          esc(l.from) + ' → ' + esc(l.to);
      } else {
        title = esc(l.route.n);
        sub = esc(l.from) + ' → ' + esc(l.to);
      }
      var unit = l.type === 'rail' ? 'station' : 'stop';
      return '<div class="leg">' + legIcon(l) + '<div><div class="leg-title">' + title + '</div>' +
        '<div class="leg-sub">' + sub + '</div>' +
        '<div class="leg-meta">' + l.stops + ' ' + unit + (l.stops === 1 ? '' : 's') + ' · ' + fmtKm(l.km) +
        ' · ' + fmtMin(l.minutes) + ' incl. ~' + Math.round(l.wait) + ' min wait</div></div>' +
        '<div class="leg-fare num">' + Math.round(l.fare) + ' ฿' + (l.capNote ? '<small>' + esc(l.capNote) + '</small>' : '') + '</div></div>';
    }).join('');
    html += '<div class="total-row"><span>Total</span><span class="num">' + r.fare + ' THB · ' + fmtMin(r.minutes) + '</span></div>';
    if (r.saved) html += '<p class="note" style="margin-top:6px">Includes a ' + Math.round(r.saved) + ' THB joint-fare discount.</p>';
    document.getElementById('itin').innerHTML = html;
  }

  function drawRoute(r, fit) {
    routeLayer.clearLayers();
    var bounds = L.latLngBounds([]);
    r.legs.forEach(function (l) {
      if (l.type === 'walk') {
        L.polyline(l.path, { color: '#4b5262', weight: 3, dashArray: '2 7', lineCap: 'round', opacity: 0.9 }).addTo(routeLayer);
      } else {
        L.polyline(l.path, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(routeLayer);
        L.polyline(l.path, { color: l.color, weight: 5, opacity: 1 }).addTo(routeLayer);
        [l.path[0], l.path[l.path.length - 1]].forEach(function (p, i) {
          L.circleMarker(p, { radius: 5, color: l.color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
            .bindTooltip(esc(i ? l.to : l.from), { direction: 'top' }).addTo(routeLayer);
        });
      }
      l.path.forEach(function (p) { bounds.extend(p); });
    });
    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }

  function renderRoad() {
    var o = points.o, d = points.d;
    var rows = ROAD_MODES.map(function (id) {
      var m = modesById[id];
      if (!m) return '';
      var t = TransitGraph.roadTrip(m, o.lat, o.lng, d.lat, d.lng);
      var fare = m.fare.range ? Math.round(t.fare * m.fare.range[0]) + '–' + Math.round(t.fare * m.fare.range[1]) : t.fare;
      return '<tr><td><span class="dot" style="background:' + m.color + '"></span>' + esc(m.name) + '</td>' +
        '<td class="num">' + fare + ' ฿</td><td class="num muted">' + fmtMin(t.minutes) + '</td></tr>';
    }).join('');
    document.getElementById('roadTable').innerHTML = rows;
  }

  function renderExamples() {
    var box = document.getElementById('examples');
    box.innerHTML = EXAMPLES.map(function (ex, i) {
      return '<button class="chip" data-i="' + i + '">' + esc(ex.label) + '</button>';
    }).join('');
    box.querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var ex = EXAMPLES[+b.dataset.i];
        setPoint('o', ex.o[0], ex.o[1], ex.o[2], true);
        setPoint('d', ex.d[0], ex.d[1], ex.d[2], true);
        compute();
      });
    });
  }

  // ---------------------------------------------------------------
  // Shareable URL: #o=lat,lng,name&d=lat,lng,name
  function writeHash() {
    var parts = [];
    ['o', 'd'].forEach(function (k) {
      var p = points[k];
      if (p) parts.push(k + '=' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5) + ',' + encodeURIComponent(p.name));
    });
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname);
  }

  function readHash() {
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var m = kv.match(/^([od])=(-?[\d.]+),(-?[\d.]+)(?:,(.*))?$/);
      if (m) setPoint(m[1], +m[2], +m[3], m[4] ? decodeURIComponent(m[4]) : null, true);
    });
    if (points.o && !points.d) setPicking('d');
  }

  init();
})();
