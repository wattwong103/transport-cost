// ============================================================
// Transit Graph Engine — client-side multimodal Dijkstra
// Shared by isoline.js and planner.js
// ============================================================

var TransitGraph = (function () {
  'use strict';

  var graph = null;    // raw JSON
  var adj = null;      // adjacency list: nodeIdx -> [{to, km, type}]
  var spatialGrid = null;
  var CELL_DEG = 0.005;

  // Mode speeds (km/h)
  var SPEED = { r: 35, b: 12, o: 15, w: 5 };

  // ============================================================
  // Loading
  // ============================================================

  function loadGraph(url) {
    url = url || 'data/transit-graph.json';
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        graph = data;
        buildAdjacency();
        buildSpatialGrid();
        console.log('Graph loaded: ' + graph.nodes.length + ' nodes, ' +
                     graph.edges.length + ' edges, ' +
                     graph.interchanges.length + ' interchanges');
        return graph;
      });
  }

  function buildAdjacency() {
    adj = new Array(graph.nodes.length);
    for (var i = 0; i < adj.length; i++) adj[i] = [];

    for (var e = 0; e < graph.edges.length; e++) {
      var edge = graph.edges[e];
      var from = edge[0], to = edge[1], km = edge[2] / 1000, type = edge[3];
      adj[from].push({ to: to, km: km, type: type });
      adj[to].push({ to: from, km: km, type: type });
    }
  }

  function buildSpatialGrid() {
    spatialGrid = {};
    for (var i = 0; i < graph.nodes.length; i++) {
      var n = graph.nodes[i];
      var r = Math.floor(n[0] / CELL_DEG);
      var c = Math.floor(n[1] / CELL_DEG);
      var key = r + ',' + c;
      if (!spatialGrid[key]) spatialGrid[key] = [];
      spatialGrid[key].push(i);
    }
  }

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

  // ============================================================
  // Spatial lookups
  // ============================================================

  function findNearbyNodes(lat, lng, maxKm) {
    var r = Math.floor(lat / CELL_DEG);
    var c = Math.floor(lng / CELL_DEG);
    var results = [];
    var searchRadius = Math.ceil(maxKm / (CELL_DEG * 111));

    for (var dr = -searchRadius; dr <= searchRadius; dr++) {
      for (var dc = -searchRadius; dc <= searchRadius; dc++) {
        var key = (r + dr) + ',' + (c + dc);
        var bucket = spatialGrid[key];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var idx = bucket[i];
          var n = graph.nodes[idx];
          var d = haversineKm(lat, lng, n[0], n[1]);
          if (d <= maxKm) {
            results.push({ idx: idx, km: d });
          }
        }
      }
    }
    return results;
  }

  function getNode(idx) {
    var n = graph.nodes[idx];
    return { lat: n[0], lng: n[1], mode: n[2], name: n[3] || null, line: n[4] || null };
  }

  function getNodeCount() {
    return graph ? graph.nodes.length : 0;
  }

  // ============================================================
  // Dijkstra
  // ============================================================

  function dijkstra(startEntries, optimize) {
    // startEntries: [{idx, km, time}] or [{lat, lng, maxWalkKm}]
    // optimize: 'distance' or 'time'
    var N = graph.nodes.length;
    var dist = new Float64Array(N);
    var time = new Float64Array(N);
    var prev = new Int32Array(N);

    for (var i = 0; i < N; i++) {
      dist[i] = Infinity;
      time[i] = Infinity;
      prev[i] = -1;
    }

    // Binary heap (min-heap by priority)
    var heap = [];
    function heapPush(pri, idx) {
      heap.push([pri, idx]);
      var i = heap.length - 1;
      while (i > 0) {
        var parent = (i - 1) >> 1;
        if (heap[parent][0] <= heap[i][0]) break;
        var tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
        i = parent;
      }
    }
    function heapPop() {
      var top = heap[0];
      var last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        var i = 0;
        while (true) {
          var left = 2 * i + 1, right = 2 * i + 2, smallest = i;
          if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
          if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
          if (smallest === i) break;
          var tmp = heap[smallest]; heap[smallest] = heap[i]; heap[i] = tmp;
          i = smallest;
        }
      }
      return top;
    }

    for (var s = 0; s < startEntries.length; s++) {
      var entry = startEntries[s];
      var idx = entry.idx;
      if (idx < 0 || idx >= N) continue;
      var initKm = entry.km || 0;
      var initTime = entry.time || ((initKm / SPEED.w) * 60);
      if (initKm < dist[idx]) {
        dist[idx] = initKm;
        time[idx] = initTime;
        var pri = optimize === 'time' ? initTime : initKm;
        heapPush(pri, idx);
      }
    }

    var visited = new Uint8Array(N);

    while (heap.length > 0) {
      var top = heapPop();
      var d = top[0], u = top[1];
      if (visited[u]) continue;
      visited[u] = true;

      var neighbors = adj[u];
      for (var n = 0; n < neighbors.length; n++) {
        var nb = neighbors[n];
        var v = nb.to;
        if (visited[v]) continue;

        var edgeKm = nb.km;
        var uMode = graph.nodes[u][2];
        var vMode = graph.nodes[v][2];
        var edgeType = nb.type;

        var edgeTime;
        if (edgeType === 'w' || uMode !== vMode) {
          edgeTime = (edgeKm / SPEED.w) * 60;
        } else {
          edgeTime = (edgeKm / (SPEED[vMode] || 12)) * 60;
        }

        var newKm = dist[u] + edgeKm;
        var newTime = time[u] + edgeTime;

        var newPri = optimize === 'time' ? newTime : newKm;
        var oldPri = optimize === 'time' ? time[v] : dist[v];

        if (newPri < oldPri) {
          dist[v] = newKm;
          time[v] = newTime;
          prev[v] = u;
          heapPush(newPri, v);
        }
      }
    }

    return { dist: dist, time: time, prev: prev };
  }

  // ============================================================
  // Path reconstruction
  // ============================================================

  function extractPath(prev, targetIdx) {
    if (prev[targetIdx] === -1 && targetIdx >= 0) return [];
    var path = [];
    var cur = targetIdx;
    while (cur !== -1) {
      path.push(cur);
      cur = prev[cur];
    }
    path.reverse();
    return path;
  }

  function segmentPath(path) {
    if (path.length < 2) return [];
    var segments = [];
    var curMode = graph.nodes[path[0]][2];
    var curLine = graph.nodes[path[0]][4] || null;
    var segStart = 0;

    for (var i = 1; i < path.length; i++) {
      var mode = graph.nodes[path[i]][2];
      var line = graph.nodes[path[i]][4] || null;

      // New segment when mode changes or rail line changes
      var modeChanged = mode !== curMode;
      var lineChanged = (curMode === 'r' && mode === 'r' && line !== curLine);

      if (modeChanged || lineChanged) {
        segments.push({
          mode: curMode,
          line: curLine,
          nodeIndices: path.slice(segStart, i),
        });
        segStart = i;
        curMode = mode;
        curLine = line;
      }
    }
    segments.push({
      mode: curMode,
      line: curLine,
      nodeIndices: path.slice(segStart),
    });

    return segments;
  }

  // ============================================================
  // Fare calculation
  // ============================================================

  var _transportModes = null;
  var _modesByLine = {};

  function setTransportModes(modes) {
    _transportModes = modes;
    _modesByLine = {};

    var lineMap = {
      'blue': 'mrt_blue', 'purple': 'mrt_purple',
      'green_sukhumvit': 'bts', 'green_silom': 'bts',
      'airport': 'arl', 'yellow': 'mrt_yellow',
      'pink': 'mrt_pink', 'red_north': 'srt_red',
      'red_west': 'srt_red', 'gold': 'gold',
    };

    for (var lineId in lineMap) {
      var modeId = lineMap[lineId];
      for (var m = 0; m < modes.length; m++) {
        if (modes[m].id === modeId) {
          _modesByLine[lineId] = modes[m];
          break;
        }
      }
    }
  }

  function getModeForLine(line) {
    return _modesByLine[line] || null;
  }

  function calculateFare(mode, distanceKm) {
    if (!mode) return 0;
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
    return mode.baseFare || 0;
  }

  function calculateTime(mode, distanceKm) {
    if (!mode) return (distanceKm / 12) * 60;
    return (distanceKm / mode.avgSpeedKmh) * 60;
  }

  function computeSegmentDistance(segment) {
    var km = 0;
    var indices = segment.nodeIndices;
    for (var i = 1; i < indices.length; i++) {
      var a = graph.nodes[indices[i - 1]];
      var b = graph.nodes[indices[i]];
      km += haversineKm(a[0], a[1], b[0], b[1]);
    }
    return km;
  }

  function computePathFare(segments) {
    var totalFare = 0;
    var legs = [];

    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      var km = computeSegmentDistance(seg);

      if (seg.mode === 'r') {
        var mode = getModeForLine(seg.line);
        var fare = calculateFare(mode, km);
        var t = mode ? calculateTime(mode, km) : (km / 35) * 60;
        var firstNode = getNode(seg.nodeIndices[0]);
        var lastNode = getNode(seg.nodeIndices[seg.nodeIndices.length - 1]);
        legs.push({
          type: 'rail',
          line: seg.line,
          modeName: mode ? mode.name : seg.line,
          modeColor: mode ? mode.color : '#888',
          from: firstNode.name || 'Station',
          to: lastNode.name || 'Station',
          stations: seg.nodeIndices.length,
          km: Math.round(km * 10) / 10,
          time: Math.round(t),
          fare: fare,
        });
        totalFare += fare;
      } else if (seg.mode === 'b') {
        var busModes = _transportModes ? _transportModes.filter(function (m) { return m.id === 'bus_nonac'; }) : [];
        var busMode = busModes[0] || { baseFare: 8, fareFormula: 'flat', fareTable: [{ maxKm: 99, fare: 8 }], avgSpeedKmh: 12 };
        var busFare = calculateFare(busMode, km);
        legs.push({
          type: 'bus',
          modeName: 'Bus',
          modeColor: '#FF9800',
          stops: seg.nodeIndices.length,
          km: Math.round(km * 10) / 10,
          time: Math.round((km / 12) * 60),
          fare: busFare,
        });
        totalFare += busFare;
      } else if (seg.mode === 'o') {
        var boatModes = _transportModes ? _transportModes.filter(function (m) { return m.type === 'boat'; }) : [];
        var boatMode = boatModes[0] || { baseFare: 19, fareFormula: 'flat', fareTable: [{ maxKm: 99, fare: 19 }], avgSpeedKmh: 15 };
        var boatFare = calculateFare(boatMode, km);
        legs.push({
          type: 'boat',
          modeName: boatMode.name || 'Boat',
          modeColor: '#00BCD4',
          km: Math.round(km * 10) / 10,
          time: Math.round((km / 15) * 60),
          fare: boatFare,
        });
        totalFare += boatFare;
      } else {
        // Walking segment
        legs.push({
          type: 'walk',
          modeName: 'Walk',
          modeColor: '#9E9E9E',
          km: Math.round(km * 1000),
          time: Math.round((km / 5) * 60),
          fare: 0,
        });
      }
    }

    return { legs: legs, totalFare: totalFare };
  }

  // ============================================================
  // Convenience: compute route between two lat/lng points
  // ============================================================

  function computeRoute(originLat, originLng, destLat, destLng, optimize) {
    optimize = optimize || 'distance';
    var maxWalk = 2; // km

    var originNodes = findNearbyNodes(originLat, originLng, maxWalk);
    if (originNodes.length === 0) return null;

    var startEntries = originNodes.map(function (n) {
      return { idx: n.idx, km: n.km, time: (n.km / SPEED.w) * 60 };
    });

    var result = dijkstra(startEntries, optimize);

    var destNodes = findNearbyNodes(destLat, destLng, maxWalk);
    if (destNodes.length === 0) return null;

    var bestIdx = -1;
    var bestTotal = Infinity;
    var bestWalkKm = 0;

    for (var d = 0; d < destNodes.length; d++) {
      var dn = destNodes[d];
      var val = optimize === 'time'
        ? result.time[dn.idx] + (dn.km / SPEED.w) * 60
        : result.dist[dn.idx] + dn.km;
      if (val < bestTotal) {
        bestTotal = val;
        bestIdx = dn.idx;
        bestWalkKm = dn.km;
      }
    }

    if (bestIdx === -1 || result.dist[bestIdx] === Infinity) return null;

    var path = extractPath(result.prev, bestIdx);
    var segments = segmentPath(path);
    var fareResult = computePathFare(segments);

    // Add initial walk from origin
    var firstNode = graph.nodes[path[0]];
    var originWalkKm = haversineKm(originLat, originLng, firstNode[0], firstNode[1]);
    if (originWalkKm > 0.05) {
      fareResult.legs.unshift({
        type: 'walk', modeName: 'Walk', modeColor: '#9E9E9E',
        km: Math.round(originWalkKm * 1000),
        time: Math.round((originWalkKm / 5) * 60),
        fare: 0,
      });
    }

    // Add final walk to destination
    if (bestWalkKm > 0.05) {
      fareResult.legs.push({
        type: 'walk', modeName: 'Walk', modeColor: '#9E9E9E',
        km: Math.round(bestWalkKm * 1000),
        time: Math.round((bestWalkKm / 5) * 60),
        fare: 0,
      });
    }

    var totalTime = 0;
    for (var l = 0; l < fareResult.legs.length; l++) {
      totalTime += fareResult.legs[l].time;
    }

    return {
      legs: fareResult.legs,
      totalFare: fareResult.totalFare,
      totalTime: totalTime,
      totalKm: Math.round((result.dist[bestIdx] + originWalkKm + bestWalkKm) * 10) / 10,
      path: path,
      segments: segments,
    };
  }

  // ============================================================
  // Convenience: run Dijkstra from a lat/lng origin
  // ============================================================

  function dijkstraFromPoint(lat, lng, maxWalkKm, optimize) {
    maxWalkKm = maxWalkKm || 2;
    optimize = optimize || 'distance';
    var nearby = findNearbyNodes(lat, lng, maxWalkKm);
    var entries = nearby.map(function (n) {
      return { idx: n.idx, km: n.km, time: (n.km / SPEED.w) * 60 };
    });
    return dijkstra(entries, optimize);
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    loadGraph: loadGraph,
    getNode: getNode,
    getNodeCount: getNodeCount,
    findNearbyNodes: findNearbyNodes,
    dijkstra: dijkstra,
    dijkstraFromPoint: dijkstraFromPoint,
    extractPath: extractPath,
    segmentPath: segmentPath,
    computePathFare: computePathFare,
    computeRoute: computeRoute,
    setTransportModes: setTransportModes,
    getModeForLine: getModeForLine,
    calculateFare: calculateFare,
    calculateTime: calculateTime,
    haversineKm: haversineKm,
    getGraph: function () { return graph; },
    getAdj: function () { return adj; },
    getSpatialGrid: function () { return spatialGrid; },
    SPEED: SPEED,
  };
})();
