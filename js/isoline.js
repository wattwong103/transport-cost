// ============================================================
// DMK Airport Isoline Map - Realistic Network-Based
// ============================================================

(function () {
  'use strict';

  var DMK = [13.9133, 100.5957];
  var DMK_STATION = 'rdn6'; // Don Mueang station on Red Line

  var COST_BANDS = [15, 25, 35, 50, 75, 100, 150, 200, 300];
  var TIME_BANDS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

  var COLORS = [
    '#1a9850', '#66bd63', '#a6d96a', '#d9ef8b',
    '#fee08b', '#fdae61', '#f46d43', '#d73027', '#a50026'
  ];

  // Grid parameters
  var GRID_SIZE = 60;
  var GRID_BOUNDS = {
    minLat: 13.45, maxLat: 14.10,
    minLng: 100.30, maxLng: 100.90
  };

  // Walking speed for last-mile
  var WALK_SPEED_KMH = 5;
  // Max walking distance to consider a station reachable (km)
  var MAX_WALK_KM = 2;

  // Road circuity factors by direction from DMK (degrees)
  // Models Bangkok's road network: good highways south (Vibhavadi),
  // east (motorway), poorer west (cross-river)
  var ROAD_CIRCUITY = [
    { angle: 0,   factor: 1.25 },  // North - toward Rangsit
    { angle: 45,  factor: 1.35 },  // NE
    { angle: 90,  factor: 1.15 },  // East - motorway
    { angle: 135, factor: 1.30 },  // SE
    { angle: 180, factor: 1.10 },  // South - Vibhavadi highway
    { angle: 225, factor: 1.50 },  // SW - cross river
    { angle: 270, factor: 1.50 },  // West - cross river
    { angle: 315, factor: 1.35 },  // NW
  ];

  var transportModes = [];
  var trainStations = {};
  var trainEdges = [];
  var stationDistances = {}; // Dijkstra results: stationId -> {km, time_min}
  var map = null;
  var isolineLayer = null;
  var stationLayer = null;
  var transitLayer = null;
  var selectedMode = null;
  var viewType = 'cost';
  var showTransitStops = false;

  // Pre-computed transit reachability data
  var transitData = null;  // raw JSON from dmk-transit-reach.json
  var busGrid = null;      // spatial index of bus stops
  var boatGrid = null;     // spatial index of boat piers
  var motoDensity = null;  // 60x60 grid of motorcycle taxi density (0-1)

  // ============================================================
  // Geo utilities
  // ============================================================

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getCircuityFactor(fromLat, fromLng, toLat, toLng) {
    var dy = toLat - fromLat;
    var dx = toLng - fromLng;
    var angle = Math.atan2(dy, dx) * 180 / Math.PI; // -180 to 180
    angle = ((angle % 360) + 360) % 360; // normalize to 0-360
    // Convert from math angle to compass bearing
    angle = (90 - angle + 360) % 360;

    // Interpolate between defined factors
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
    return 1.3; // default
  }

  // ============================================================
  // Transit spatial index (for bus/boat stop lookup)
  // ============================================================

  function buildTransitGrid(stops, cellDeg) {
    // stops: array of [lat, lng, km, time_min]
    // Returns grid: { "r,c" -> [indices into stops] }
    cellDeg = cellDeg || 0.005;
    var grid = {};
    for (var i = 0; i < stops.length; i++) {
      var r = Math.floor(stops[i][0] / cellDeg);
      var c = Math.floor(stops[i][1] / cellDeg);
      var key = r + ',' + c;
      if (!grid[key]) grid[key] = [];
      grid[key].push(i);
    }
    return grid;
  }

  function findNearestStop(spatialGrid, stops, lat, lng, maxKm) {
    // Returns { km, time } of nearest reachable stop, or null
    var cellDeg = 0.005;
    var r = Math.floor(lat / cellDeg);
    var c = Math.floor(lng / cellDeg);
    var bestDist = Infinity;
    var bestKm = 0;
    var bestTime = 0;

    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        var key = (r + dr) + ',' + (c + dc);
        var bucket = spatialGrid[key];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var s = stops[bucket[i]];
          var walkKm = haversineKm(lat, lng, s[0], s[1]);
          if (walkKm > maxKm) continue;
          // Total distance = transit distance from DMK + walking
          var totalKm = s[2] + walkKm;
          if (totalKm < bestDist) {
            bestDist = totalKm;
            bestKm = s[2];
            bestTime = s[3];
          }
        }
      }
    }

    if (bestDist === Infinity) return null;
    var walkKmFinal = bestDist - bestKm;
    return {
      transitKm: bestKm,
      walkKm: walkKmFinal,
      totalKm: bestDist,
      transitTime: bestTime,
      walkTime: (walkKmFinal / WALK_SPEED_KMH) * 60
    };
  }

  // ============================================================
  // Fare Calculation
  // ============================================================

  function calculateFare(mode, distanceKm) {
    if (mode.fareFormula === 'flat') {
      return mode.fareTable[0].fare;
    }
    if (mode.fareFormula === 'distance-based') {
      for (var i = 0; i < mode.fareTable.length; i++) {
        if (distanceKm <= mode.fareTable[i].maxKm) return mode.fareTable[i].fare;
      }
      return mode.fareTable[mode.fareTable.length - 1].fare;
    }
    if (mode.fareFormula === 'metered' || mode.fareFormula === 'per-km') {
      var fare = mode.baseFare;
      var remaining = distanceKm;
      var prevMax = 0;
      for (var j = 0; j < mode.perKmRate.length; j++) {
        var tier = mode.perKmRate[j];
        var tierDist = Math.min(remaining, tier.maxKm - prevMax);
        if (tierDist > 0) {
          fare += tierDist * tier.rate;
          remaining -= tierDist;
        }
        prevMax = tier.maxKm;
        if (remaining <= 0) break;
      }
      return Math.round(fare);
    }
    return mode.baseFare;
  }

  function calculateTime(mode, distanceKm) {
    return (distanceKm / mode.avgSpeedKmh) * 60;
  }

  // ============================================================
  // Rail Network Dijkstra
  // ============================================================

  function buildRailGraph() {
    var graph = {}; // adjacency list: stationId -> [{to, km}]

    for (var i = 0; i < trainEdges.length; i++) {
      var e = trainEdges[i];
      var from = e.from;
      var to = e.to;

      if (!trainStations[from] || !trainStations[to]) continue;

      var km = haversineKm(
        trainStations[from].lat, trainStations[from].lng,
        trainStations[to].lat, trainStations[to].lng
      );

      // Connection (interchange) adds walking penalty
      var penalty = e.type === 'connection' ? 0.3 : 0;

      if (!graph[from]) graph[from] = [];
      if (!graph[to]) graph[to] = [];
      graph[from].push({ to: to, km: km + penalty });
      graph[to].push({ to: from, km: km + penalty }); // bidirectional
    }

    return graph;
  }

  function dijkstra(graph, startNode) {
    var dist = {};
    var visited = {};

    // Also add DMK airport itself as a start (walk from DMK to rdn6)
    var dmkToStation = 0;
    if (startNode === 'rdn6' && trainStations['rdn6']) {
      dmkToStation = haversineKm(DMK[0], DMK[1], trainStations['rdn6'].lat, trainStations['rdn6'].lng);
    }

    // Initialize
    for (var node in graph) {
      dist[node] = Infinity;
    }
    // Also consider dmk node
    if (trainStations['dmk'] && graph['dmk']) {
      dist['dmk'] = haversineKm(DMK[0], DMK[1], trainStations['dmk'].lat, trainStations['dmk'].lng);
    }
    dist[startNode] = dmkToStation;

    // Simple Dijkstra (fine for ~200 nodes)
    while (true) {
      var u = null;
      var minDist = Infinity;
      for (var n in dist) {
        if (!visited[n] && dist[n] < minDist) {
          minDist = dist[n];
          u = n;
        }
      }
      if (u === null || minDist === Infinity) break;

      visited[u] = true;
      var neighbors = graph[u] || [];
      for (var j = 0; j < neighbors.length; j++) {
        var neighbor = neighbors[j];
        var newDist = dist[u] + neighbor.km;
        if (newDist < (dist[neighbor.to] || Infinity)) {
          dist[neighbor.to] = newDist;
        }
      }
    }

    return dist;
  }

  function computeStationDistances() {
    var graph = buildRailGraph();
    stationDistances = dijkstra(graph, DMK_STATION);
  }

  // ============================================================
  // Grid Cost Computation
  // ============================================================

  function computeGridCost(mode) {
    var grid = [];
    var latStep = (GRID_BOUNDS.maxLat - GRID_BOUNDS.minLat) / GRID_SIZE;
    var lngStep = (GRID_BOUNDS.maxLng - GRID_BOUNDS.minLng) / GRID_SIZE;
    var isRail = mode.type === 'rail';
    var isBus = mode.type === 'bus' && transitData;
    var isBoat = mode.type === 'boat' && transitData;

    for (var r = 0; r < GRID_SIZE; r++) {
      grid[r] = [];
      var lat = GRID_BOUNDS.minLat + (r + 0.5) * latStep;
      for (var c = 0; c < GRID_SIZE; c++) {
        var lng = GRID_BOUNDS.minLng + (c + 0.5) * lngStep;

        var straightKm = haversineKm(DMK[0], DMK[1], lat, lng);

        if (isRail) {
          // For rail: find best station near this point
          var bestCost = Infinity;
          var bestTime = Infinity;

          for (var sid in stationDistances) {
            var s = trainStations[sid];
            if (!s) continue;
            var walkKm = haversineKm(lat, lng, s.lat, s.lng);
            if (walkKm > MAX_WALK_KM) continue;

            var railKm = stationDistances[sid];
            if (railKm === Infinity) continue;

            var fare = calculateFare(mode, railKm);
            var walkTimeMins = (walkKm / WALK_SPEED_KMH) * 60;
            var railTimeMins = calculateTime(mode, railKm);
            var totalTime = walkTimeMins + railTimeMins;

            if (viewType === 'cost') {
              if (fare < bestCost) bestCost = fare;
            } else {
              if (totalTime < bestTime) bestTime = totalTime;
            }
          }

          grid[r][c] = viewType === 'cost' ? bestCost : bestTime;

        } else if (isBus) {
          // Bus: use pre-computed nearest reachable stop
          var busStop = findNearestStop(busGrid, transitData.bus_stops, lat, lng, MAX_WALK_KM);
          if (busStop) {
            if (viewType === 'cost') {
              grid[r][c] = calculateFare(mode, busStop.transitKm);
            } else {
              grid[r][c] = busStop.transitTime + busStop.walkTime;
            }
          } else {
            grid[r][c] = Infinity;
          }

        } else if (isBoat) {
          // Boat: use pre-computed nearest reachable pier
          var pier = findNearestStop(boatGrid, transitData.boat_piers, lat, lng, MAX_WALK_KM);
          if (pier) {
            if (viewType === 'cost') {
              grid[r][c] = calculateFare(mode, pier.transitKm);
            } else {
              grid[r][c] = pier.transitTime + pier.walkTime;
            }
          } else {
            grid[r][c] = Infinity;
          }

        } else {
          // Road modes: apply directional circuity
          var circuity = getCircuityFactor(DMK[0], DMK[1], lat, lng);
          // Modulate with motorcycle density (dense areas = slightly lower circuity)
          if (motoDensity && motoDensity[r] && motoDensity[r][c] > 0) {
            circuity *= (1 - 0.15 * motoDensity[r][c]);
          }
          var roadKm = straightKm * circuity;

          if (viewType === 'cost') {
            grid[r][c] = calculateFare(mode, roadKm);
          } else {
            grid[r][c] = calculateTime(mode, roadKm);
          }
        }
      }
    }
    return grid;
  }

  function computeMultiModalGrid() {
    // For each cell, find the minimum cost/time across all modes
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
  // Contour polygon extraction (Marching Squares)
  // ============================================================

  function extractContourPolygons(grid, threshold) {
    // Find all cells below threshold, build a filled polygon
    var latStep = (GRID_BOUNDS.maxLat - GRID_BOUNDS.minLat) / GRID_SIZE;
    var lngStep = (GRID_BOUNDS.maxLng - GRID_BOUNDS.minLng) / GRID_SIZE;

    // Collect all cells within threshold
    var cells = [];
    for (var r = 0; r < GRID_SIZE; r++) {
      for (var c = 0; c < GRID_SIZE; c++) {
        if (grid[r][c] <= threshold) {
          cells.push([r, c]);
        }
      }
    }

    if (cells.length === 0) return null;

    // Build boundary edges using a grid-boundary approach
    var cellSet = {};
    for (var i = 0; i < cells.length; i++) {
      cellSet[cells[i][0] + ',' + cells[i][1]] = true;
    }

    // Collect boundary segments
    var edges = [];
    for (var j = 0; j < cells.length; j++) {
      var cr = cells[j][0];
      var cc = cells[j][1];
      var lat0 = GRID_BOUNDS.minLat + cr * latStep;
      var lat1 = lat0 + latStep;
      var lng0 = GRID_BOUNDS.minLng + cc * lngStep;
      var lng1 = lng0 + lngStep;

      // Check each of 4 directions
      if (!cellSet[(cr - 1) + ',' + cc]) edges.push([[lat0, lng0], [lat0, lng1]]); // top
      if (!cellSet[(cr + 1) + ',' + cc]) edges.push([[lat1, lng0], [lat1, lng1]]); // bottom
      if (!cellSet[cr + ',' + (cc - 1)]) edges.push([[lat0, lng0], [lat1, lng0]]); // left
      if (!cellSet[cr + ',' + (cc + 1)]) edges.push([[lat0, lng1], [lat1, lng1]]); // right
    }

    if (edges.length === 0) return null;

    // Chain boundary edges into a polygon
    var polygon = chainEdges(edges);
    return polygon;
  }

  function chainEdges(edges) {
    if (edges.length === 0) return [];

    // Build adjacency: point -> [connected points]
    var adj = {};
    var ptKey = function(p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); };

    for (var i = 0; i < edges.length; i++) {
      var k1 = ptKey(edges[i][0]);
      var k2 = ptKey(edges[i][1]);
      if (!adj[k1]) adj[k1] = [];
      if (!adj[k2]) adj[k2] = [];
      adj[k1].push({ pt: edges[i][1], key: k2 });
      adj[k2].push({ pt: edges[i][0], key: k1 });
    }

    // Walk the chain to form polygon
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

    // Draw from outermost to innermost
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

    // Show reachable stations for rail modes
    if (selectedMode.type === 'rail' || isMultiModal) {
      drawReachableStations(bands);
    }

    // Show transit stops overlay
    if (showTransitStops && transitData) {
      if (selectedMode.type === 'bus' || isMultiModal) {
        drawTransitStops(transitData.bus_stops, bands, 2, '#2196F3');
      }
      if (selectedMode.type === 'boat' || isMultiModal) {
        drawTransitStops(transitData.boat_piers, bands, 3, '#00897B');
      }
    }
  }

  function drawReachableStations(bands) {
    if (!stationLayer) return;
    var maxBand = bands[bands.length - 1];

    for (var sid in stationDistances) {
      var s = trainStations[sid];
      if (!s || stationDistances[sid] === Infinity) continue;

      var railKm = stationDistances[sid];
      var value;
      if (viewType === 'cost') {
        value = calculateFare(selectedMode, railKm);
      } else {
        value = calculateTime(selectedMode, railKm);
      }

      if (value > maxBand) continue;

      // Find color band
      var colorIdx = 0;
      for (var b = 0; b < bands.length; b++) {
        if (value <= bands[b]) { colorIdx = b; break; }
      }

      var marker = L.circleMarker([s.lat, s.lng], {
        radius: 4,
        fillColor: COLORS[colorIdx],
        color: '#333',
        weight: 1,
        fillOpacity: 0.9
      });

      var lbl = viewType === 'cost'
        ? Math.round(value) + ' THB'
        : Math.round(value) + ' min';
      marker.bindPopup('<b>' + (s.name || sid) + '</b><br>' +
        (s.nameTh || '') + '<br>' +
        'From DMK: ' + railKm.toFixed(1) + ' km rail | ' + lbl);
      marker.addTo(stationLayer);
    }
  }

  function drawTransitStops(stops, bands, radius, color) {
    if (!transitLayer) return;
    var maxBand = bands[bands.length - 1];

    for (var i = 0; i < stops.length; i++) {
      var s = stops[i]; // [lat, lng, km, time]
      var value;
      if (viewType === 'cost') {
        value = selectedMode.id === 'multimodal' ? s[2] * 3 : calculateFare(selectedMode, s[2]);
      } else {
        value = s[3];
      }
      if (value > maxBand) continue;

      var colorIdx = 0;
      for (var b = 0; b < bands.length; b++) {
        if (value <= bands[b]) { colorIdx = b; break; }
      }

      var marker = L.circleMarker([s[0], s[1]], {
        radius: radius,
        fillColor: color,
        color: '#333',
        weight: 0.5,
        fillOpacity: 0.7
      });
      var lbl = viewType === 'cost' ? Math.round(value) + ' THB' : Math.round(value) + ' min';
      marker.bindPopup('Transit stop<br>From DMK: ' + s[2].toFixed(1) + ' km | ' + lbl);
      marker.addTo(transitLayer);
    }
  }

  // ============================================================
  // Data Loading
  // ============================================================

  async function loadData() {
    try {
      var results = await Promise.all([
        fetch('data/transport-modes.json').then(function(r) { return r.json(); }),
        fetch('data/train-stations.json').then(function(r) { return r.json(); }),
        fetch('data/train-edges.json').then(function(r) { return r.json(); })
      ]);

      transportModes = results[0].modes;
      trainStations = results[1].stations;
      trainEdges = results[2];

      computeStationDistances();

      // Load pre-computed transit reachability (graceful fallback)
      try {
        var transitResp = await fetch('data/dmk-transit-reach.json');
        if (transitResp.ok) {
          transitData = await transitResp.json();
          busGrid = buildTransitGrid(transitData.bus_stops);
          boatGrid = buildTransitGrid(transitData.boat_piers);
          motoDensity = transitData.moto_density;
          console.log('Transit data loaded: ' +
            transitData.bus_stops.length + ' bus stops, ' +
            transitData.boat_piers.length + ' boat piers');
        }
      } catch (e) {
        console.warn('Transit data not available, using fallback:', e.message);
      }

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
      center: DMK,
      zoom: 11,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map);

    L.marker(DMK).addTo(map).bindPopup(
      '<b>Don Mueang Airport (DMK)</b><br>ท่าอากาศยานดอนเมือง'
    ).openPopup();

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
        if (!m) m = modeId === 'multimodal' ? { id: 'multimodal' } : null;
        if (m) {
          selectedMode = m;
          setActiveMode(modeId);
          drawIsolines();
          updateLegend();
        }
      });
      container.appendChild(btn);
    }

    // Add Multi-modal button
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
  }

  // ============================================================
  // Init
  // ============================================================

  setupControls();
  loadData();

})();
