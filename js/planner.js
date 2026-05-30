// ============================================================
// Journey Planner — multi-modal route planning
// Uses TransitGraph (graph.js) for client-side Dijkstra
// ============================================================

(function () {
  'use strict';

  var map = null;
  var originMarker = null;
  var destMarker = null;
  var routeLayer = null;
  var interchangeLayer = null;

  var originLatLng = null;
  var destLatLng = null;
  var inputMode = 'origin'; // 'origin' or 'dest'
  var optimize = 'distance';
  var currentRoute = null;

  var LINE_COLORS = {
    'blue': '#1565C0', 'purple': '#7B1FA2',
    'green_sukhumvit': '#4CAF50', 'green_silom': '#8BC34A',
    'airport': '#D32F2F', 'yellow': '#FFD600',
    'pink': '#E91E93', 'red_north': '#C62828',
    'red_west': '#C62828', 'gold': '#BF9B30',
  };

  var MODE_ICONS = {
    'rail': '\u{1F686}',
    'bus': '\u{1F68C}',
    'boat': '⛴',
    'walk': '\u{1F6B6}',
  };

  // ============================================================
  // Init
  // ============================================================

  async function init() {
    initMap();
    setupControls();

    try {
      var modesResp = await fetch('data/transport-modes.json');
      var modesData = await modesResp.json();
      TransitGraph.setTransportModes(modesData.modes);

      await TransitGraph.loadGraph();
      renderInterchanges();

      document.getElementById('planner-loading').classList.add('hidden');
    } catch (err) {
      console.error('Failed to load:', err);
      document.getElementById('planner-loading').textContent = 'Failed to load data. ' + err.message;
    }
  }

  function initMap() {
    map = L.map('planner-map', {
      center: [13.75, 100.52],
      zoom: 12,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map);

    routeLayer = L.layerGroup().addTo(map);
    interchangeLayer = L.layerGroup().addTo(map);

    map.on('click', function (e) {
      if (inputMode === 'origin') {
        setOrigin(e.latlng.lat, e.latlng.lng);
      } else {
        setDestination(e.latlng.lat, e.latlng.lng);
      }
    });
  }

  // ============================================================
  // Origin / Destination
  // ============================================================

  function setOrigin(lat, lng, name) {
    originLatLng = [lat, lng];
    if (originMarker) map.removeLayer(originMarker);

    originMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;background:#4CAF50;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      draggable: true,
    }).addTo(map);

    originMarker.on('dragend', function () {
      var pos = originMarker.getLatLng();
      originLatLng = [pos.lat, pos.lng];
      updateInputDisplay();
      computeIfReady();
    });

    var originInput = document.getElementById('originInput');
    originInput.textContent = name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
    originInput.classList.remove('active');
    originInput.classList.add('set');

    inputMode = 'dest';
    document.getElementById('destInput').classList.add('active');

    computeIfReady();
  }

  function setDestination(lat, lng, name) {
    destLatLng = [lat, lng];
    if (destMarker) map.removeLayer(destMarker);

    destMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;background:#F44336;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      draggable: true,
    }).addTo(map);

    destMarker.on('dragend', function () {
      var pos = destMarker.getLatLng();
      destLatLng = [pos.lat, pos.lng];
      updateInputDisplay();
      computeIfReady();
    });

    var destInput = document.getElementById('destInput');
    destInput.textContent = name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
    destInput.classList.remove('active');
    destInput.classList.add('set');

    inputMode = 'origin';
    document.getElementById('originInput').classList.add('active');

    computeIfReady();
  }

  function updateInputDisplay() {
    if (originLatLng) {
      document.getElementById('originInput').textContent =
        originLatLng[0].toFixed(4) + ', ' + originLatLng[1].toFixed(4);
    }
    if (destLatLng) {
      document.getElementById('destInput').textContent =
        destLatLng[0].toFixed(4) + ', ' + destLatLng[1].toFixed(4);
    }
  }

  function computeIfReady() {
    if (!originLatLng || !destLatLng) return;
    if (!TransitGraph.getGraph()) return;

    var route = TransitGraph.computeRoute(
      originLatLng[0], originLatLng[1],
      destLatLng[0], destLatLng[1],
      optimize
    );

    currentRoute = route;
    renderResults(route);
    drawRoute(route);
  }

  // ============================================================
  // Render results
  // ============================================================

  function renderResults(route) {
    var container = document.getElementById('results');
    var emptyState = document.getElementById('emptyState');

    if (!route) {
      container.innerHTML = '';
      var noRoute = document.createElement('div');
      noRoute.className = 'planner-empty';
      noRoute.textContent = 'No transit route found. The destination may be too far from any transit stop.';
      container.appendChild(noRoute);
      return;
    }

    container.innerHTML = '';

    // Summary bar
    var summary = document.createElement('div');
    summary.className = 'route-summary';
    summary.innerHTML =
      '<div class="summary-item"><div class="summary-value">' + route.totalFare + '</div><div class="summary-label">THB</div></div>' +
      '<div class="summary-item"><div class="summary-value">' + route.totalTime + '</div><div class="summary-label">min</div></div>' +
      '<div class="summary-item"><div class="summary-value">' + route.totalKm + '</div><div class="summary-label">km</div></div>';
    container.appendChild(summary);

    // Leg cards
    for (var i = 0; i < route.legs.length; i++) {
      var leg = route.legs[i];
      var card = document.createElement('div');
      card.className = 'leg-card';

      var iconColor = leg.modeColor || '#888';
      var icon = MODE_ICONS[leg.type] || '';

      var iconEl = document.createElement('div');
      iconEl.className = 'leg-icon';
      iconEl.style.background = iconColor;
      iconEl.textContent = icon;
      card.appendChild(iconEl);

      var details = document.createElement('div');
      details.className = 'leg-details';

      if (leg.type === 'walk') {
        details.innerHTML =
          '<div class="leg-title">Walk ' + leg.km + 'm</div>' +
          '<div class="leg-meta"><span>' + leg.time + ' min</span></div>';
      } else if (leg.type === 'rail') {
        details.innerHTML =
          '<div class="leg-title">' + leg.modeName + '</div>' +
          '<div class="leg-subtitle">' + leg.from + ' → ' + leg.to + '</div>' +
          '<div class="leg-meta">' +
            '<span>' + leg.stations + ' stations</span>' +
            '<span>' + leg.km + ' km</span>' +
            '<span>' + leg.time + ' min</span>' +
            '<span class="leg-fare">' + leg.fare + ' THB</span>' +
          '</div>';
      } else if (leg.type === 'bus') {
        details.innerHTML =
          '<div class="leg-title">Bus</div>' +
          '<div class="leg-subtitle">' + leg.stops + ' stops · ' + leg.km + ' km</div>' +
          '<div class="leg-meta">' +
            '<span>' + leg.time + ' min</span>' +
            '<span class="leg-fare">' + leg.fare + ' THB</span>' +
          '</div>';
      } else if (leg.type === 'boat') {
        details.innerHTML =
          '<div class="leg-title">' + leg.modeName + '</div>' +
          '<div class="leg-subtitle">' + leg.km + ' km</div>' +
          '<div class="leg-meta">' +
            '<span>' + leg.time + ' min</span>' +
            '<span class="leg-fare">' + leg.fare + ' THB</span>' +
          '</div>';
      }

      card.appendChild(details);
      container.appendChild(card);
    }
  }

  // ============================================================
  // Draw route on map
  // ============================================================

  function drawRoute(route) {
    routeLayer.clearLayers();
    if (!route || !route.segments) return;

    var graph = TransitGraph.getGraph();
    var bounds = [];

    for (var s = 0; s < route.segments.length; s++) {
      var seg = route.segments[s];
      var coords = [];
      for (var n = 0; n < seg.nodeIndices.length; n++) {
        var node = graph.nodes[seg.nodeIndices[n]];
        coords.push([node[0], node[1]]);
        bounds.push([node[0], node[1]]);
      }

      if (coords.length < 2) continue;

      var color = '#9E9E9E';
      var weight = 3;
      var dashArray = null;

      if (seg.mode === 'r') {
        color = LINE_COLORS[seg.line] || '#1565C0';
        weight = 5;
      } else if (seg.mode === 'b') {
        color = '#FF9800';
        weight = 4;
      } else if (seg.mode === 'o') {
        color = '#00BCD4';
        weight = 4;
      } else {
        dashArray = '6, 8';
        weight = 3;
      }

      L.polyline(coords, {
        color: color,
        weight: weight,
        opacity: 0.85,
        dashArray: dashArray,
      }).addTo(routeLayer);
    }

    // Origin/dest walk legs
    if (originLatLng && route.path && route.path.length > 0) {
      var firstNode = graph.nodes[route.path[0]];
      L.polyline([originLatLng, [firstNode[0], firstNode[1]]], {
        color: '#9E9E9E', weight: 3, dashArray: '6, 8', opacity: 0.7,
      }).addTo(routeLayer);
      bounds.push(originLatLng);
    }
    if (destLatLng && route.path && route.path.length > 0) {
      var lastNode = graph.nodes[route.path[route.path.length - 1]];
      L.polyline([[lastNode[0], lastNode[1]], destLatLng], {
        color: '#9E9E9E', weight: 3, dashArray: '6, 8', opacity: 0.7,
      }).addTo(routeLayer);
      bounds.push(destLatLng);
    }

    // Station markers along route
    for (var p = 0; p < route.path.length; p++) {
      var rNode = graph.nodes[route.path[p]];
      if (rNode[2] === 'r' && rNode[3]) {
        var lineColor = LINE_COLORS[rNode[4]] || '#333';
        L.circleMarker([rNode[0], rNode[1]], {
          radius: 5, fillColor: '#fff', color: lineColor,
          weight: 2.5, fillOpacity: 1,
        }).bindPopup('<b>' + rNode[3] + '</b><br>' + (rNode[4] || ''))
          .addTo(routeLayer);
      }
    }

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  // ============================================================
  // Interchanges
  // ============================================================

  function renderInterchanges() {
    var graphData = TransitGraph.getGraph();
    if (!graphData || !graphData.interchanges) return;

    var container = document.getElementById('interchangeChips');
    container.innerHTML = '';

    var top = graphData.interchanges.slice(0, 25);
    for (var i = 0; i < top.length; i++) {
      var ix = top[i];
      var chip = document.createElement('span');
      chip.className = 'interchange-chip';
      chip.textContent = ix.name + ' (' + ix.busRoutes + ')';
      chip.dataset.lat = ix.lat;
      chip.dataset.lng = ix.lng;
      chip.dataset.name = ix.name;
      chip.addEventListener('click', function (e) {
        var lat = parseFloat(e.target.dataset.lat);
        var lng = parseFloat(e.target.dataset.lng);
        var name = e.target.dataset.name;
        setOrigin(lat, lng, name);
        map.setView([lat, lng], 14);
      });
      container.appendChild(chip);
    }

    // Show interchange markers on map
    for (var j = 0; j < graphData.interchanges.length; j++) {
      var interchange = graphData.interchanges[j];
      if (interchange.busRoutes < 10) continue;
      L.circleMarker([interchange.lat, interchange.lng], {
        radius: Math.min(3 + interchange.busRoutes / 10, 8),
        fillColor: '#1a237e',
        color: '#fff',
        weight: 1.5,
        fillOpacity: 0.6,
      }).bindPopup(
        '<b>' + interchange.name + '</b><br>' +
        interchange.busStops + ' bus stops<br>' +
        interchange.busRoutes + ' bus routes'
      ).addTo(interchangeLayer);
    }
  }

  // ============================================================
  // Controls
  // ============================================================

  function setupControls() {
    document.getElementById('originInput').addEventListener('click', function () {
      inputMode = 'origin';
      document.getElementById('originInput').classList.add('active');
      document.getElementById('destInput').classList.remove('active');
    });

    document.getElementById('destInput').addEventListener('click', function () {
      inputMode = 'dest';
      document.getElementById('destInput').classList.add('active');
      document.getElementById('originInput').classList.remove('active');
    });

    document.querySelectorAll('.optimize-toggle button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.optimize-toggle button').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        optimize = btn.dataset.opt;
        computeIfReady();
      });
    });
  }

  // ============================================================
  // Start
  // ============================================================

  init();

})();
