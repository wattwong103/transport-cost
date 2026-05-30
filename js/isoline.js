// ============================================================
// Isoline Map — From-Anywhere Reachability
// Uses TransitGraph (graph.js) for client-side multimodal Dijkstra
// ============================================================

(function () {
  'use strict';

  var DMK = [13.9133, 100.5957];

  var COST_BANDS = [15, 25, 35, 50, 75, 100, 150, 200, 300];
  var TIME_BANDS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

  var COLORS = [
    '#1a9850', '#66bd63', '#a6d96a', '#d9ef8b',
    '#fee08b', '#fdae61', '#f46d43', '#d73027', '#a50026'
  ];

  var GRID_SIZE = 60;
  var GRID_BOUNDS = {
    minLat: 13.45, maxLat: 14.10,
    minLng: 100.30, maxLng: 100.90
  };
  var MAX_WALK_KM = 2;
  var WALK_SPEED_KMH = 5;

  var ROAD_CIRCUITY = [
    { angle: 0,   factor: 1.25 },
    { angle: 45,  factor: 1.35 },
    { angle: 90,  factor: 1.15 },
    { angle: 135, factor: 1.30 },
    { angle: 180, factor: 1.10 },
    { angle: 225, factor: 1.50 },
    { angle: 270, factor: 1.50 },
    { angle: 315, factor: 1.35 },
  ];

  var transportModes = [];
  var map = null;
  var isolineLayer = null;
  var stationLayer = null;
  var transitLayer = null;
  var selectedMode = null;
  var viewType = 'cost';
  var showTransitStops = false;

  // Origin state
  var origin = DMK.slice();
  var originMarker = null;
  var originName = 'DMK Airport';

  // Graph-based Dijkstra results
  var dijkstraResult = null;  // {dist, time, prev}
  var motoDensity = null;

  // ============================================================
  // Geo utilities
  // ============================================================

  function getCircuityFactor(fromLat, fromLng, toLat, toLng) {
    var dy = toLat - fromLat;
    var dx = toLng - fromLng;
    var angle = Math.atan2(dy, dx) * 180 / Math.PI;
    angle = ((angle % 360) + 360) % 360;
    angle = (90 - angle + 360) % 360;

    var n = ROAD_CIRCUITY.length;
    for (var i = 0; i < n; i++) {
      var a1 = ROAD_CIRCUITY[i].angle;
      var a2 = ROAD_CIRCUITY[(i + 1) % n].angle;
      var f1 = ROAD_CIRCUITY[i].factor;
      var f2 = ROAD_CIRCUITY[(i + 1) % n].factor;
      if (a2 <= a1) a2 += 360;
      var checkAngle = angle;
      if (checkAngle < a1) checkAngle += 360;
      if (checkAngle >= a1 && checkAngle < a2) {
        var t = (checkAngle - a1) / (a2 - a1);
        return f1 + t * (f2 - f1);
      }
    }
    return 1.3;
  }

  // ============================================================
  // Origin management
  // ============================================================

  function setOrigin(lat, lng, name) {
    origin = [lat, lng];
    originName = name || (lat.toFixed(4) + ', ' + lng.toFixed(4));

    var label = document.getElementById('originLabel');
    var resetBtn = document.getElementById('resetOrigin');
    if (label) label.textContent = originName;
    if (resetBtn) {
      resetBtn.style.display = (lat === DMK[0] && lng === DMK[1]) ? 'none' : 'inline-block';
    }

    if (originMarker) {
      originMarker.setLatLng([lat, lng]);
      originMarker.setPopupContent('<b>' + originName + '</b>');
    }

    recomputeFromOrigin();
  }

  function recomputeFromOrigin() {
    if (!TransitGraph.getGraph()) return;

    var loadingEl = document.getElementById('isoline-loading');
    if (loadingEl) {
      loadingEl.textContent = 'Computing reachability...';
      loadingEl.classList.remove('hidden');
    }

    requestAnimationFrame(function () {
      dijkstraResult = TransitGraph.dijkstraFromPoint(origin[0], origin[1], MAX_WALK_KM, 'distance');
      drawIsolines();

      if (loadingEl) loadingEl.classList.add('hidden');
    });
  }

  // ============================================================
  // Grid cost computation
  // ============================================================

  function findBestTransitNode(lat, lng) {
    if (!dijkstraResult) return null;
    var graph = TransitGraph.getGraph();
    var nearby = TransitGraph.findNearbyNodes(lat, lng, MAX_WALK_KM);
    var bestDist = Infinity;
    var bestTime = Infinity;
    var bestMode = null;
    var bestLine = null;
    var bestWalkKm = 0;

    for (var i = 0; i < nearby.length; i++) {
      var n = nearby[i];
      var nodeDist = dijkstraResult.dist[n.idx];
      if (nodeDist === Infinity) continue;
      var total = nodeDist + n.km;
      if (total < bestDist) {
        bestDist = total;
        bestTime = dijkstraResult.time[n.idx] + (n.km / WALK_SPEED_KMH) * 60;
        bestMode = graph.nodes[n.idx][2];
        bestLine = graph.nodes[n.idx][4] || null;
        bestWalkKm = n.km;
      }
    }

    if (bestDist === Infinity) return null;
    return {
      totalKm: bestDist,
      totalTime: bestTime,
      mode: bestMode,
      line: bestLine,
      walkKm: bestWalkKm,
      transitKm: bestDist - bestWalkKm,
    };
  }

  function computeGridCost(mode) {
    var grid = [];
    var latStep = (GRID_BOUNDS.maxLat - GRID_BOUNDS.minLat) / GRID_SIZE;
    var lngStep = (GRID_BOUNDS.maxLng - GRID_BOUNDS.minLng) / GRID_SIZE;
    var isRoad = mode.type === 'road';

    for (var r = 0; r < GRID_SIZE; r++) {
      grid[r] = [];
      var lat = GRID_BOUNDS.minLat + (r + 0.5) * latStep;
      for (var c = 0; c < GRID_SIZE; c++) {
        var lng = GRID_BOUNDS.minLng + (c + 0.5) * lngStep;

        if (isRoad) {
          var straightKm = TransitGraph.haversineKm(origin[0], origin[1], lat, lng);
          var circuity = getCircuityFactor(origin[0], origin[1], lat, lng);
          if (motoDensity && motoDensity[r] && motoDensity[r][c] > 0) {
            circuity *= (1 - 0.15 * motoDensity[r][c]);
          }
          var roadKm = straightKm * circuity;
          if (viewType === 'cost') {
            grid[r][c] = TransitGraph.calculateFare(mode, roadKm);
          } else {
            grid[r][c] = TransitGraph.calculateTime(mode, roadKm);
          }
        } else {
          // Transit modes: use graph Dijkstra
          var best = findBestTransitNodeForMode(lat, lng, mode);
          if (best !== null) {
            if (viewType === 'cost') {
              grid[r][c] = best.fare;
            } else {
              grid[r][c] = best.time;
            }
          } else {
            grid[r][c] = Infinity;
          }
        }
      }
    }
    return grid;
  }

  function findBestTransitNodeForMode(lat, lng, mode) {
    if (!dijkstraResult) return null;
    var graph = TransitGraph.getGraph();
    var nearby = TransitGraph.findNearbyNodes(lat, lng, MAX_WALK_KM);
    var bestVal = Infinity;
    var bestResult = null;

    // Which node modes match this transport mode?
    var modeFilter;
    if (mode.type === 'rail') {
      modeFilter = 'r';
    } else if (mode.type === 'bus') {
      modeFilter = 'b';
    } else if (mode.type === 'boat') {
      modeFilter = 'o';
    } else {
      return null;
    }

    for (var i = 0; i < nearby.length; i++) {
      var n = nearby[i];
      var nodeMode = graph.nodes[n.idx][2];
      if (nodeMode !== modeFilter) continue;

      var nodeDist = dijkstraResult.dist[n.idx];
      if (nodeDist === Infinity) continue;

      var transitKm = nodeDist;
      var walkKm = n.km;
      var walkTime = (walkKm / WALK_SPEED_KMH) * 60;
      var transitTime = dijkstraResult.time[n.idx];

      var fare, totalTime;
      if (mode.type === 'rail') {
        var nodeLine = graph.nodes[n.idx][4] || '';
        var lineMode = TransitGraph.getModeForLine(nodeLine);
        fare = TransitGraph.calculateFare(lineMode || mode, transitKm);
        totalTime = transitTime + walkTime;
      } else {
        fare = TransitGraph.calculateFare(mode, transitKm);
        totalTime = transitTime + walkTime;
      }

      var val = viewType === 'cost' ? fare : totalTime;
      if (val < bestVal) {
        bestVal = val;
        bestResult = { fare: fare, time: totalTime, transitKm: transitKm, walkKm: walkKm };
      }
    }

    return bestResult;
  }

  function computeMultiModalGrid() {
    var grid = [];
    var modeGrids = [];
    for (var m = 0; m < transportModes.length; m++) {
      modeGrids.push(computeGridCost(transportModes[m]));
    }
    for (var r = 0; r < GRID_SIZE; r++) {
      grid[r] = [];
      for (var c = 0; c < GRID_SIZE; c++) {
        var best = Infinity;
        for (var mg = 0; mg < modeGrids.length; mg++) {
          if (modeGrids[mg][r][c] < best) {
            best = modeGrids[mg][r][c];
          }
        }
        grid[r][c] = best;
      }
    }
    return grid;
  }

  // ============================================================
  // Contour polygon extraction
  // ============================================================

  function extractContourPolygons(grid, threshold) {
    var latStep = (GRID_BOUNDS.maxLat - GRID_BOUNDS.minLat) / GRID_SIZE;
    var lngStep = (GRID_BOUNDS.maxLng - GRID_BOUNDS.minLng) / GRID_SIZE;

    var cells = [];
    for (var r = 0; r < GRID_SIZE; r++) {
      for (var c = 0; c < GRID_SIZE; c++) {
        if (grid[r][c] <= threshold) {
          cells.push([r, c]);
        }
      }
    }

    if (cells.length === 0) return null;

    var cellSet = {};
    for (var i = 0; i < cells.length; i++) {
      cellSet[cells[i][0] + ',' + cells[i][1]] = true;
    }

    var edges = [];
    for (var j = 0; j < cells.length; j++) {
      var cr = cells[j][0], cc = cells[j][1];
      var lat0 = GRID_BOUNDS.minLat + cr * latStep;
      var lat1 = lat0 + latStep;
      var lng0 = GRID_BOUNDS.minLng + cc * lngStep;
      var lng1 = lng0 + lngStep;

      if (!cellSet[(cr - 1) + ',' + cc]) edges.push([[lat0, lng0], [lat0, lng1]]);
      if (!cellSet[(cr + 1) + ',' + cc]) edges.push([[lat1, lng0], [lat1, lng1]]);
      if (!cellSet[cr + ',' + (cc - 1)]) edges.push([[lat0, lng0], [lat1, lng0]]);
      if (!cellSet[cr + ',' + (cc + 1)]) edges.push([[lat0, lng1], [lat1, lng1]]);
    }

    if (edges.length === 0) return null;
    return chainEdges(edges);
  }

  function chainEdges(edges) {
    if (edges.length === 0) return [];
    var adj = {};
    var ptKey = function(p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); };

    for (var i = 0; i < edges.length; i++) {
      var k1 = ptKey(edges[i][0]), k2 = ptKey(edges[i][1]);
      if (!adj[k1]) adj[k1] = [];
      if (!adj[k2]) adj[k2] = [];
      adj[k1].push({ pt: edges[i][1], key: k2 });
      adj[k2].push({ pt: edges[i][0], key: k1 });
    }

    var visited = {};
    var start = ptKey(edges[0][0]);
    var current = start;
    var polygon = [edges[0][0]];
    visited[start] = true;

    for (var step = 0; step < edges.length * 2; step++) {
      var neighbors = adj[current];
      if (!neighbors) break;
      var found = false;
      for (var n = 0; n < neighbors.length; n++) {
        if (!visited[neighbors[n].key]) {
          visited[neighbors[n].key] = true;
          polygon.push(neighbors[n].pt);
          current = neighbors[n].key;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return polygon;
  }

  // ============================================================
  // Visualization
  // ============================================================

  function drawIsolines() {
    if (!isolineLayer || !selectedMode) return;
    isolineLayer.clearLayers();
    if (stationLayer) stationLayer.clearLayers();
    if (transitLayer) transitLayer.clearLayers();

    var isMultiModal = selectedMode.id === 'multimodal';
    var grid = isMultiModal ? computeMultiModalGrid() : computeGridCost(selectedMode);
    var bands = viewType === 'cost' ? COST_BANDS : TIME_BANDS;

    for (var i = bands.length - 1; i >= 0; i--) {
      var polygon = extractContourPolygons(grid, bands[i]);
      if (polygon && polygon.length > 2) {
        var poly = L.polygon(polygon, {
          color: COLORS[i],
          fillColor: COLORS[i],
          fillOpacity: 0.25,
          weight: 1.5,
          opacity: 0.7
        });
        var label = viewType === 'cost' ? bands[i] + ' THB' : bands[i] + ' min';
        poly.bindTooltip(label, { sticky: true });
        poly.addTo(isolineLayer);
      }
    }

    // Show reachable rail stations
    if ((selectedMode.type === 'rail' || isMultiModal) && dijkstraResult) {
      drawReachableStations(bands);
    }

    // Show transit stops overlay
    if (showTransitStops && dijkstraResult) {
      if (selectedMode.type === 'bus' || isMultiModal) {
        drawTransitNodes('b', bands, 2, '#2196F3');
      }
      if (selectedMode.type === 'boat' || isMultiModal) {
        drawTransitNodes('o', bands, 3, '#00897B');
      }
    }
  }

  function drawReachableStations(bands) {
    if (!stationLayer || !dijkstraResult) return;
    var graph = TransitGraph.getGraph();
    var maxBand = bands[bands.length - 1];

    for (var idx = 0; idx < graph.nodes.length; idx++) {
      var n = graph.nodes[idx];
      if (n[2] !== 'r') continue;  // only rail
      if (dijkstraResult.dist[idx] === Infinity) continue;

      var railKm = dijkstraResult.dist[idx];
      var nodeLine = n[4] || '';
      var lineMode = TransitGraph.getModeForLine(nodeLine);

      var value;
      if (viewType === 'cost') {
        value = TransitGraph.calculateFare(lineMode || selectedMode, railKm);
      } else {
        value = dijkstraResult.time[idx];
      }
      if (value > maxBand) continue;

      var colorIdx = 0;
      for (var b = 0; b < bands.length; b++) {
        if (value <= bands[b]) { colorIdx = b; break; }
      }

      var marker = L.circleMarker([n[0], n[1]], {
        radius: 4,
        fillColor: COLORS[colorIdx],
        color: '#333',
        weight: 1,
        fillOpacity: 0.9
      });

      var lbl = viewType === 'cost'
        ? Math.round(value) + ' THB'
        : Math.round(value) + ' min';
      marker.bindPopup('<b>' + (n[3] || 'Station') + '</b><br>' +
        'Line: ' + nodeLine + '<br>' +
        'From origin: ' + railKm.toFixed(1) + ' km | ' + lbl);
      marker.addTo(stationLayer);
    }
  }

  function drawTransitNodes(modeChar, bands, radius, color) {
    if (!transitLayer || !dijkstraResult) return;
    var graph = TransitGraph.getGraph();
    var maxBand = bands[bands.length - 1];

    for (var idx = 0; idx < graph.nodes.length; idx++) {
      var n = graph.nodes[idx];
      if (n[2] !== modeChar) continue;
      if (dijkstraResult.dist[idx] === Infinity) continue;

      var km = dijkstraResult.dist[idx];
      var value;
      if (viewType === 'cost') {
        value = km * 3;
      } else {
        value = dijkstraResult.time[idx];
      }
      if (value > maxBand) continue;

      var colorIdx = 0;
      for (var b = 0; b < bands.length; b++) {
        if (value <= bands[b]) { colorIdx = b; break; }
      }

      var marker = L.circleMarker([n[0], n[1]], {
        radius: radius,
        fillColor: color,
        color: '#333',
        weight: 0.5,
        fillOpacity: 0.7
      });
      var lbl = viewType === 'cost' ? Math.round(value) + ' THB' : Math.round(value) + ' min';
      marker.bindPopup('Transit stop<br>From origin: ' + km.toFixed(1) + ' km | ' + lbl);
      marker.addTo(transitLayer);
    }
  }

  // ============================================================
  // Data Loading
  // ============================================================

  async function loadData() {
    try {
      var modesResp = await fetch('data/transport-modes.json');
      var modesData = await modesResp.json();
      transportModes = modesData.modes;

      TransitGraph.setTransportModes(transportModes);

      await TransitGraph.loadGraph();
      var graphData = TransitGraph.getGraph();
      motoDensity = graphData.motoDensity || null;

      dijkstraResult = TransitGraph.dijkstraFromPoint(origin[0], origin[1], MAX_WALK_KM, 'distance');

      document.getElementById('isoline-loading').classList.add('hidden');
      initMap();
      renderModeButtons();
      selectedMode = transportModes[0];
      setActiveMode(selectedMode.id);
      drawIsolines();
      updateLegend();
    } catch (err) {
      console.error('Failed to load data:', err);
      document.getElementById('isoline-loading').textContent = 'Failed to load data. ' + err.message;
    }
  }

  // ============================================================
  // Map
  // ============================================================

  function initMap() {
    map = L.map('isoline-map', {
      center: origin,
      zoom: 11,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map);

    originMarker = L.marker(origin, { draggable: true }).addTo(map);
    originMarker.bindPopup('<b>' + originName + '</b>').openPopup();

    originMarker.on('dragend', function () {
      var pos = originMarker.getLatLng();
      setOrigin(pos.lat, pos.lng, null);
    });

    map.on('click', function (e) {
      setOrigin(e.latlng.lat, e.latlng.lng, null);
    });

    isolineLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    transitLayer = L.layerGroup().addTo(map);
  }

  // ============================================================
  // Controls
  // ============================================================

  function renderModeButtons() {
    var container = document.getElementById('modeButtons');
    container.innerHTML = '';

    for (var i = 0; i < transportModes.length; i++) {
      var mode = transportModes[i];
      var btn = document.createElement('button');
      btn.className = 'mode-btn';
      btn.style.setProperty('--btn-color', mode.color);
      btn.textContent = mode.name;
      btn.dataset.modeId = mode.id;
      btn.addEventListener('click', function(e) {
        var modeId = e.target.dataset.modeId;
        var m = transportModes.find(function(x) { return x.id === modeId; });
        if (m) {
          selectedMode = m;
          setActiveMode(modeId);
          drawIsolines();
          updateLegend();
        }
      });
      container.appendChild(btn);
    }

    var mmBtn = document.createElement('button');
    mmBtn.className = 'mode-btn';
    mmBtn.style.setProperty('--btn-color', '#FF6F00');
    mmBtn.textContent = 'Multi-modal';
    mmBtn.dataset.modeId = 'multimodal';
    mmBtn.addEventListener('click', function() {
      selectedMode = { id: 'multimodal', name: 'Multi-modal (Optimal)' };
      setActiveMode('multimodal');
      drawIsolines();
      updateLegend();
    });
    container.appendChild(mmBtn);
  }

  function setActiveMode(modeId) {
    document.querySelectorAll('.mode-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.modeId === modeId);
    });
  }

  function updateLegend() {
    var bands = viewType === 'cost' ? COST_BANDS : TIME_BANDS;
    var unit = viewType === 'cost' ? ' THB' : ' min';

    var barEl = document.getElementById('legendBar');
    var labelsEl = document.getElementById('legendLabels');
    barEl.innerHTML = '';
    labelsEl.innerHTML = '';

    for (var i = 0; i < COLORS.length; i++) {
      var swatch = document.createElement('div');
      swatch.className = 'legend-swatch';
      swatch.style.background = COLORS[i];
      barEl.appendChild(swatch);
    }

    for (var j = 0; j < bands.length; j++) {
      var label = document.createElement('span');
      label.textContent = bands[j] + unit;
      labelsEl.appendChild(label);
    }
  }

  function setupControls() {
    document.querySelectorAll('.view-toggle button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.view-toggle button').forEach(function(b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        viewType = btn.dataset.view;
        drawIsolines();
        updateLegend();
      });
    });

    var transitToggle = document.getElementById('transitToggle');
    if (transitToggle) {
      transitToggle.addEventListener('change', function() {
        showTransitStops = transitToggle.checked;
        drawIsolines();
      });
    }

    var resetBtn = document.getElementById('resetOrigin');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        setOrigin(DMK[0], DMK[1], 'DMK Airport');
        if (map) map.setView(DMK, 11);
      });
    }
  }

  // ============================================================
  // Init
  // ============================================================

  setupControls();
  loadData();

})();
