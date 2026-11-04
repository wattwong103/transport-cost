// ============================================================
// Transit routing engine — client-side, fare-aware, multimodal
// Shared by planner.js and isoline.js
//
// The network (data/transit-network.json) is expanded into:
//   stop nodes   0 .. P-1          street level (bus stop, pier, station)
//   route nodes  P .. N-1          "on board route r at position j"
// Edges: walk (stop↔stop), board (stop→route), alight (route→stop),
//        ride (route j → j±1), xfer (rail platform change inside one
//        fare system, e.g. BTS Siam, without paying again).
// Each boarding starts a fare leg; the leg fare is recomputed from the
// mode's fare table (by km or by stations) as the passenger rides on.
// ============================================================

var TransitGraph = (function () {
  'use strict';

  var CFG = {
    walkSpeedKmh: 4.5,
    walkDetour: 1.3,          // street network vs straight line
    transferWalkM: 400,       // max walk between two stops
    accessWalkM: 1000,        // max walk from origin / to destination
    accessWalkMaxM: 2000,     // fallback when nothing is within accessWalkM
    xferMin: 3,               // platform change inside a fare system
    dwellMin: { r: 0.5, b: 0.35, o: 0.4 },
    accessMin: { r: 3, b: 0, o: 1 },   // stairs, ticket gates, pier gangway (on boarding)
  };

  // Generalized-cost profiles: cost = fare*fare + minutes*time (+ walking surcharge)
  var PROFILES = {
    cheapest: { fare: 1, time: 0.15, walk: 0.15 },
    balanced: { fare: 1, time: 1.2, walk: 0.8 },
    fastest:  { fare: 0.02, time: 1, walk: 0.3 },
  };

  var net = null;           // raw JSON
  var modes = {};           // fare id -> mode object (transport-modes.json)
  var P = 0, N = 0;
  var nodeStop, nodeRoute, nodePos, routeStart;
  var eOff, eTo, eType, eKm;   // CSR adjacency
  var grid = null;
  var CELL = 0.005;

  var T_WALK = 0, T_BOARD = 1, T_ALIGHT = 2, T_RIDE = 3, T_XFER = 4;

  // ---------------------------------------------------------------
  // Geo
  // ---------------------------------------------------------------
  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------------------------------------------------------------
  // Fares
  // ---------------------------------------------------------------
  function stepFare(table, x) {
    for (var i = 0; i < table.length; i++) if (x <= table[i].upTo) return table[i].fare;
    return table[table.length - 1].fare;
  }

  // Fare for one leg. trip: {km, stops, minutes}
  function legFare(mode, trip) {
    if (!mode || !mode.fare) return 0;
    var f = mode.fare, km = trip.km || 0;
    switch (f.kind) {
      case 'flat': return f.fare;
      case 'free': return 0;
      case 'stations': return stepFare(f.table, trip.stops || 0);
      case 'km': return stepFare(f.table, km);
      case 'meter': {
        // Bangkok taxi: flag fall covers the first baseKm, then tiered per-km
        var fare = f.base, done = f.baseKm || 0;
        for (var i = 0; i < f.tiers.length && km > done; i++) {
          var seg = Math.min(km, f.tiers[i].upTo) - done;
          if (seg > 0) { fare += seg * f.tiers[i].rate; done += seg; }
        }
        if (f.perMinIdle && trip.minutes) fare += f.perMinIdle * trip.minutes * (f.idleShare || 0);
        return Math.round(fare);
      }
      case 'linear':
        return Math.min(f.max, Math.round(f.base + km * f.perKm));
      case 'distance': {
        // ride-hailing / motorcycle taxi estimate: base covers baseKm, then per-km (flat or tiered)
        var v = f.base, d0 = f.baseKm || 0;
        if (f.tiers) {
          for (var j = 0; j < f.tiers.length && km > d0; j++) {
            var s2 = Math.min(km, f.tiers[j].upTo) - d0;
            if (s2 > 0) { v += s2 * f.tiers[j].rate; d0 += s2; }
          }
        } else {
          v += Math.max(0, km - d0) * (f.perKm || 0);
        }
        v += (f.perMin || 0) * (trip.minutes || 0);
        if (f.min) v = Math.max(v, f.min);
        return Math.round(v);
      }
    }
    return 0;
  }

  function setModes(list) {
    modes = {};
    list.forEach(function (m) { modes[m.id] = m; });
  }

  function getMode(id) { return modes[id] || null; }

  function speedFor(fareId, kind) {
    var m = modes[fareId];
    if (m && m.speedKmh) return m.speedKmh;
    return kind === 'r' ? 35 : kind === 'b' ? 14 : 15;
  }

  function waitFor(fareId, kind) {
    var m = modes[fareId];
    if (m && m.waitMin != null) return m.waitMin;
    return kind === 'r' ? 4 : kind === 'b' ? 10 : 10;
  }

  // ---------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------
  function load(url) {
    return fetch(url || 'data/transit-network.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { build(data); return net; });
  }

  function build(data) {
    net = data;
    var stops = net.stops, routes = net.routes;
    P = stops.length;
    routeStart = new Int32Array(routes.length);
    N = P;
    for (var r = 0; r < routes.length; r++) { routeStart[r] = N; N += routes[r].s.length; }
    nodeStop = new Int32Array(N); nodeRoute = new Int32Array(N); nodePos = new Int32Array(N);
    for (var i = 0; i < P; i++) { nodeStop[i] = i; nodeRoute[i] = -1; }
    for (r = 0; r < routes.length; r++) {
      var s = routes[r].s;
      for (var j = 0; j < s.length; j++) {
        var n = routeStart[r] + j;
        nodeStop[n] = s[j]; nodeRoute[n] = r; nodePos[n] = j;
      }
    }

    // spatial grid over stops
    grid = {};
    for (i = 0; i < P; i++) {
      var key = Math.floor(stops[i][0] / CELL) + ',' + Math.floor(stops[i][1] / CELL);
      (grid[key] || (grid[key] = [])).push(i);
    }

    var E = [];   // [from, to, type, km]
    function add(a, b, t, km) { E.push(a, b, t, km); }

    // walking between nearby stops
    var maxKm = CFG.transferWalkM / 1000;
    for (i = 0; i < P; i++) {
      var near = nearbyStops(stops[i][0], stops[i][1], maxKm);
      for (var k = 0; k < near.length; k++) {
        if (near[k].idx > i) {
          add(i, near[k].idx, T_WALK, near[k].km);
          add(near[k].idx, i, T_WALK, near[k].km);
        }
      }
    }
    // explicit rail interchanges (may exceed transferWalkM)
    (net.railTransfers || []).forEach(function (t) {
      var km = t[2] / 1000 / CFG.walkDetour;  // walk_m already includes detour
      add(t[0], t[1], T_WALK, km); add(t[1], t[0], T_WALK, km);
    });

    // route edges
    var byStopFare = {};
    for (r = 0; r < routes.length; r++) {
      var rt = routes[r], seq = rt.s, base = routeStart[r];
      var bidir = rt.k !== 'b';   // GTFS bus trips are one direction each
      for (j = 0; j < seq.length; j++) {
        var node = base + j;
        add(seq[j], node, T_BOARD, 0);
        add(node, seq[j], T_ALIGHT, 0);
        if (j + 1 < seq.length && seq[j + 1] !== seq[j]) {
          var a = stops[seq[j]], b = stops[seq[j + 1]];
          var km = haversineKm(a[0], a[1], b[0], b[1]) * (rt.k === 'r' ? 1.05 : 1.2);
          add(node, node + 1, T_RIDE, km);
          if (bidir) add(node + 1, node, T_RIDE, km);
        }
        if (rt.k === 'r') {
          var sk = seq[j] + '|' + rt.f;
          (byStopFare[sk] || (byStopFare[sk] = [])).push(node);
        }
      }
    }
    // free platform changes within one rail fare system (BTS Siam, Blue Line loop at Tha Phra)
    for (var sk2 in byStopFare) {
      var list = byStopFare[sk2];
      for (var x = 0; x < list.length; x++)
        for (var y = 0; y < list.length; y++)
          if (x !== y) add(list[x], list[y], T_XFER, 0);
    }

    // CSR
    var M = E.length / 4;
    var deg = new Int32Array(N + 1);
    for (var e = 0; e < M; e++) deg[E[e * 4] + 1]++;
    for (i = 0; i < N; i++) deg[i + 1] += deg[i];
    eOff = deg;
    eTo = new Int32Array(M); eType = new Uint8Array(M); eKm = new Float32Array(M);
    var fill = new Int32Array(N);
    for (e = 0; e < M; e++) {
      var from = E[e * 4], pos2 = eOff[from] + fill[from]++;
      eTo[pos2] = E[e * 4 + 1]; eType[pos2] = E[e * 4 + 2]; eKm[pos2] = E[e * 4 + 3];
    }
    console.log('Transit network: ' + P + ' stops, ' + routes.length + ' routes, ' +
      N + ' nodes, ' + M + ' edges');
  }

  function nearbyStops(lat, lng, maxKm) {
    var r0 = Math.floor(lat / CELL), c0 = Math.floor(lng / CELL);
    var rad = Math.ceil(maxKm / (CELL * 108)) + 1;
    var out = [];
    for (var dr = -rad; dr <= rad; dr++) {
      for (var dc = -rad; dc <= rad; dc++) {
        var b = grid[(r0 + dr) + ',' + (c0 + dc)];
        if (!b) continue;
        for (var i = 0; i < b.length; i++) {
          var s = net.stops[b[i]];
          var d = haversineKm(lat, lng, s[0], s[1]);
          if (d <= maxKm) out.push({ idx: b[i], km: d });
        }
      }
    }
    return out;
  }

  function walkMin(km) { return km * CFG.walkDetour / CFG.walkSpeedKmh * 60; }

  // ---------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n > 0) {
      var i = 0;
      while (true) {
        var l = 2 * i + 1, r = l + 1, m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  };
  Heap.prototype.size = function () { return this.k.length; };

  // options: {profile, allow: function(route)->bool, maxMinutes}
  // sources: [{stop, walkKm}]
  function search(sources, options) {
    options = options || {};
    var prof = PROFILES[options.profile] || PROFILES.balanced;
    var allow = options.allow || null;
    var maxMin = options.maxMinutes || Infinity;
    var routes = net.routes;

    var cost = new Float64Array(N).fill(Infinity);
    var time = new Float32Array(N);
    var fare = new Float32Array(N);
    var walkKm = new Float32Array(N);
    var legBase = new Float32Array(N);
    var legKm = new Float32Array(N);
    var legStops = new Int16Array(N);
    var prev = new Int32Array(N).fill(-1);
    var done = new Uint8Array(N);
    var heap = new Heap();

    var routeOk = new Uint8Array(routes.length);
    for (var r = 0; r < routes.length; r++) routeOk[r] = !allow || allow(routes[r]) ? 1 : 0;

    sources.forEach(function (s) {
      var t = walkMin(s.walkKm);
      var c = t * (prof.time + prof.walk);
      if (c < cost[s.stop]) {
        cost[s.stop] = c; time[s.stop] = t; fare[s.stop] = 0; walkKm[s.stop] = s.walkKm;
        prev[s.stop] = -2;
        heap.push(c, s.stop);
      }
    });

    while (heap.size()) {
      var u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (time[u] > maxMin) continue;
      var ru = nodeRoute[u];
      var rtU = ru >= 0 ? routes[ru] : null;
      for (var e = eOff[u]; e < eOff[u + 1]; e++) {
        var v = eTo[e];
        if (done[v]) continue;
        var type = eType[e], km = eKm[e];
        var nt = time[u], nf = fare[u], nw = walkKm[u];
        var lb = legBase[u], lk = legKm[u], ls = legStops[u];
        var extra = 0;
        if (type === T_WALK) {
          var wm = walkMin(km);
          nt += wm; nw += km; extra = wm * prof.walk;
        } else if (type === T_BOARD) {
          var rv = nodeRoute[v];
          if (!routeOk[rv]) continue;
          var rt = routes[rv];
          nt += waitFor(rt.f, rt.k) + (CFG.accessMin[rt.k] || 0);
          lb = nf; lk = 0; ls = 0;
          nf = lb + legFare(modes[rt.f], { km: 0, stops: 0 });
        } else if (type === T_RIDE) {
          lk += km; ls += 1;
          nt += km / speedFor(rtU.f, rtU.k) * 60 + (CFG.dwellMin[rtU.k] || 0.5);
          nf = lb + legFare(modes[rtU.f], { km: lk, stops: ls });
        } else if (type === T_XFER) {
          if (!routeOk[nodeRoute[v]]) continue;
          nt += CFG.xferMin;
        }
        // T_ALIGHT: no change
        var nc = nf * prof.fare + nt * prof.time + (cost[u] - fare[u] * prof.fare - time[u] * prof.time) + extra;
        if (nc < cost[v] - 1e-9) {
          cost[v] = nc; time[v] = nt; fare[v] = nf; walkKm[v] = nw;
          legBase[v] = lb; legKm[v] = lk; legStops[v] = ls;
          prev[v] = u;
          heap.push(nc, v);
        }
      }
    }
    return { cost: cost, time: time, fare: fare, walkKm: walkKm, prev: prev, profile: prof };
  }

  function sourcesNear(lat, lng) {
    var near = nearbyStops(lat, lng, CFG.accessWalkM / 1000);
    if (!near.length) near = nearbyStops(lat, lng, CFG.accessWalkMaxM / 1000);
    return near.map(function (n) { return { stop: n.idx, walkKm: n.km }; });
  }

  // ---------------------------------------------------------------
  // Itineraries
  // ---------------------------------------------------------------
  function stopName(i) {
    var s = net.stops[i];
    return s[3] || (s[2] === 'b' ? 'Bus stop' : s[2] === 'o' ? 'Pier' : 'Station');
  }

  function buildLegs(res, endStop) {
    var chain = [];
    for (var n = endStop; n >= 0; n = res.prev[n]) chain.push(n);
    chain.reverse();
    var legs = [];
    var i = 0;
    while (i < chain.length - 1) {
      var a = chain[i], b = chain[i + 1];
      if (nodeRoute[a] < 0 && nodeRoute[b] < 0) {
        // walking between stops; merge consecutive walks
        var km = 0, j = i;
        var path = [net.stops[a]];
        while (j < chain.length - 1 && nodeRoute[chain[j]] < 0 && nodeRoute[chain[j + 1]] < 0) {
          var s1 = net.stops[chain[j]], s2 = net.stops[chain[j + 1]];
          km += haversineKm(s1[0], s1[1], s2[0], s2[1]);
          path.push(s2); j++;
        }
        legs.push({ type: 'walk', km: km, minutes: walkMin(km), path: path.map(ll) });
        i = j;
      } else if (nodeRoute[a] < 0 && nodeRoute[b] >= 0) {
        // board: ride until alight (xfer within a fare system keeps the leg)
        var r = nodeRoute[b], startStop = a;
        var segs = [{ route: r, nodes: [b] }];
        j = i + 1;
        while (j < chain.length - 1 && nodeRoute[chain[j + 1]] >= 0) {
          var nxt = chain[j + 1];
          if (nodeRoute[nxt] !== segs[segs.length - 1].route || nodeStop[nxt] === nodeStop[chain[j]]) {
            segs.push({ route: nodeRoute[nxt], nodes: [nxt] });
          } else {
            segs[segs.length - 1].nodes.push(nxt);
          }
          j++;
        }
        var endS = j + 1 < chain.length ? chain[j + 1] : nodeStop[chain[j]];
        var legStopsN = 0, legKmN = 0, pts = [];
        segs.forEach(function (sg) {
          for (var q = 0; q < sg.nodes.length; q++) {
            var st = net.stops[nodeStop[sg.nodes[q]]];
            if (pts.length) {
              var last = pts[pts.length - 1];
              var dd = haversineKm(last[0], last[1], st[0], st[1]);
              if (dd > 0.001) { legKmN += dd; legStopsN++; }
            }
            pts.push([st[0], st[1]]);
          }
        });
        var rt0 = net.routes[r];
        var mode = modes[rt0.f];
        var lines = [];
        segs.forEach(function (sg) {
          var rr = net.routes[sg.route];
          if (!lines.length || lines[lines.length - 1].id !== rr.id) lines.push(rr);
        });
        var tEnd = res.time[chain[j]], tStart = res.time[a];
        legs.push({
          type: rt0.k === 'r' ? 'rail' : rt0.k === 'b' ? 'bus' : 'boat',
          fareId: rt0.f,
          mode: mode,
          route: rt0,
          lines: lines,
          from: stopName(startStop),
          to: stopName(endS),
          fromCode: net.codes[startStop] || null,
          toCode: net.codes[endS] || null,
          stops: legStopsN,
          km: legKmN,
          minutes: tEnd - tStart,
          wait: waitFor(rt0.f, rt0.k) + (CFG.accessMin[rt0.k] || 0),
          fare: res.fare[chain[j]] - res.fare[a],
          path: pts,
          color: rt0.c || (mode && mode.color) || '#666',
        });
        i = j + 1;
      } else {
        i++;
      }
    }
    return legs;
  }

  function ll(s) { return [s[0], s[1]]; }

  // Transfer discounts between fare systems (e.g. the MRT entry fee is charged
  // once when changing between Blue and Purple). Applied to consecutive rail
  // legs after the search.
  function applyCaps(legs) {
    var saved = 0, prevRail = null;
    legs.forEach(function (l) {
      if (l.type === 'walk') return;
      if (l.type !== 'rail') { prevRail = null; return; }
      if (prevRail) {
        var td = (modes[l.fareId] || {}).transferDiscount;
        var tdPrev = (modes[prevRail.fareId] || {}).transferDiscount;
        var hit = (td && td.with.indexOf(prevRail.fareId) >= 0) ? td :
          (tdPrev && tdPrev.with.indexOf(l.fareId) >= 0) ? tdPrev : null;
        if (hit) {
          var cut = Math.min(hit.amount, l.fare);
          l.fare -= cut;
          l.capNote = '−' + cut + ' ฿ transfer: ' + hit.note;
          saved += cut;
        }
      }
      prevRail = l;
    });
    return saved;
  }

  // Plan a trip between two points. Returns null if unreachable.
  function plan(oLat, oLng, dLat, dLng, profile, allow) {
    var src = sourcesNear(oLat, oLng);
    if (!src.length) return null;
    var res = search(src, { profile: profile, allow: allow });
    var dst = nearbyStops(dLat, dLng, CFG.accessWalkM / 1000);
    if (!dst.length) dst = nearbyStops(dLat, dLng, CFG.accessWalkMaxM / 1000);
    var prof = res.profile, best = -1, bestC = Infinity;
    dst.forEach(function (d) {
      if (!isFinite(res.cost[d.idx])) return;
      var wm = walkMin(d.km);
      var c = res.cost[d.idx] + wm * (prof.time + prof.walk);
      if (c < bestC) { bestC = c; best = d; }
    });
    // walking the whole way can beat transit for short trips
    var directKm = haversineKm(oLat, oLng, dLat, dLng);
    var directMin = walkMin(directKm);
    var directC = directMin * (prof.time + prof.walk);
    if ((best === -1 || directC <= bestC) && directKm <= CFG.accessWalkMaxM / 1000 * 1.5) {
      return summarize([{ type: 'walk', km: directKm, minutes: directMin, path: [[oLat, oLng], [dLat, dLng]] }]);
    }
    if (best === -1) return null;

    var legs = buildLegs(res, best.idx);
    var first = net.stops[firstStop(res, best.idx)];
    var oKm = haversineKm(oLat, oLng, first[0], first[1]);
    if (legs.length && legs[0].type === 'walk') {
      legs[0].km += oKm; legs[0].minutes = walkMin(legs[0].km); legs[0].path.unshift([oLat, oLng]);
    } else {
      legs.unshift({ type: 'walk', km: oKm, minutes: walkMin(oKm), path: [[oLat, oLng], [first[0], first[1]]] });
    }
    var last = net.stops[best.idx];
    if (legs[legs.length - 1].type === 'walk') {
      var L = legs[legs.length - 1];
      L.km += best.km; L.minutes = walkMin(L.km); L.path.push([dLat, dLng]);
    } else {
      legs.push({ type: 'walk', km: best.km, minutes: walkMin(best.km), path: [[last[0], last[1]], [dLat, dLng]] });
    }
    legs = legs.filter(function (l) { return l.type !== 'walk' || l.km > 0.02; });
    var trip = summarize(legs);
    if (directKm <= CFG.accessWalkMaxM / 1000 && directMin <= trip.minutes) {
      return summarize([{ type: 'walk', km: directKm, minutes: directMin, path: [[oLat, oLng], [dLat, dLng]] }]);
    }
    return trip;
  }

  function firstStop(res, n) {
    var f = n;
    while (res.prev[f] >= 0) f = res.prev[f];
    return nodeStop[f];
  }

  function summarize(legs) {
    var saved = applyCaps(legs);
    var out = { legs: legs, fare: 0, minutes: 0, km: 0, walkKm: 0, transfers: -1, saved: saved };
    legs.forEach(function (l) {
      out.fare += l.fare || 0;
      out.minutes += l.minutes;
      out.km += l.km;
      if (l.type === 'walk') out.walkKm += l.km; else out.transfers++;
    });
    out.transfers = Math.max(0, out.transfers);
    out.fare = Math.round(out.fare);
    out.minutes = Math.round(out.minutes);
    return out;
  }

  // Door-to-door estimate for a road mode
  function roadTrip(mode, oLat, oLng, dLat, dLng) {
    var km = haversineKm(oLat, oLng, dLat, dLng) * (mode.circuity || 1.35);
    var minutes = km / mode.speedKmh * 60 + (mode.waitMin || 0);
    return { km: km, minutes: minutes, fare: legFare(mode, { km: km, minutes: minutes }) };
  }

  // Isoline support: best (fare, minutes) at every stop from a point
  function reachFrom(lat, lng, profile, allow, maxMinutes) {
    var src = sourcesNear(lat, lng);
    var res = search(src, { profile: profile, allow: allow, maxMinutes: maxMinutes });
    var fareAt = new Float32Array(P).fill(Infinity), timeAt = new Float32Array(P).fill(Infinity);
    for (var i = 0; i < P; i++) {
      if (isFinite(res.cost[i])) { fareAt[i] = res.fare[i]; timeAt[i] = res.time[i]; }
    }
    return { fare: fareAt, time: timeAt };
  }

  return {
    load: load,
    setModes: setModes,
    getMode: getMode,
    legFare: legFare,
    plan: plan,
    roadTrip: roadTrip,
    reachFrom: reachFrom,
    nearbyStops: nearbyStops,
    haversineKm: haversineKm,
    walkMin: walkMin,
    network: function () { return net; },
    CFG: CFG,
    PROFILES: PROFILES,
  };
})();
