// ============================================================
// Shared helpers for all pages
// ============================================================
var BKK = (function () {
  'use strict';

  var CENTER = [13.7500, 100.5300];

  // Touch screens get "Tap" instead of "Click" in hints and placeholders
  var TOUCH = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  function tapWord(text) {
    return TOUCH ? text.replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap') : text;
  }
  if (TOUCH) {
    document.documentElement.classList.add('touch');
    document.querySelectorAll('.map-hint').forEach(function (el) { el.textContent = tapWord(el.textContent); });
    document.querySelectorAll('input[placeholder]').forEach(function (el) { el.placeholder = tapWord(el.placeholder); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMin(m) {
    m = Math.round(m);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }

  function fmtKm(km) {
    return km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : (Math.round(km * 10) / 10) + ' km';
  }

  function createMap(el, opts) {
    var map = L.map(el, Object.assign({ center: CENTER, zoom: 12, zoomControl: true, preferCanvas: true }, opts || {}));
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19, className: 'soft-tiles',
    }).addTo(map);
    return map;
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
      return r.json();
    });
  }

  // Draw rail lines (OSM geometry) and stations. Returns {group, byLine}.
  function drawRail(map, rail, geo, opts) {
    opts = opts || {};
    var group = L.layerGroup(), byLine = {};
    var lineById = {};
    rail.lines.forEach(function (l) { lineById[l.id] = l; });
    (geo.features || []).forEach(function (f) {
      var lid = f.properties.lineId, line = lineById[lid];
      if (!line) return;
      var lg = byLine[lid] || (byLine[lid] = L.layerGroup().addTo(group));
      var coords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
      coords.forEach(function (part) {
        L.polyline(part.map(function (c) { return [c[1], c[0]]; }), {
          color: line.color, weight: opts.weight || 4, opacity: opts.opacity || 0.9, interactive: false,
        }).addTo(lg);
      });
    });
    if (opts.stations !== false) {
      Object.keys(rail.stations).forEach(function (code) {
        var s = rail.stations[code];
        var first = lineById[s.lines[0]];
        var multi = s.lines.length > 1;
        var m = L.circleMarker([s.lat, s.lng], {
          radius: opts.stationRadius || 4, color: first.color, weight: 2,
          fillColor: '#fff', fillOpacity: 1,
        });
        m.bindPopup(stationPopup(code, s, lineById));
        m.addTo(byLine[s.lines[0]] || group);
        if (multi) m.setStyle({ color: '#151922' });
      });
    }
    group.addTo(map);
    return { group: group, byLine: byLine, lineById: lineById };
  }

  function stationPopup(code, s, lineById) {
    return '<div class="pop-title">' + esc(s.name) + '</div>' +
      '<div class="pop-th">' + esc(s.nameTh) + '</div>' +
      s.lines.map(function (lid) {
        var l = lineById[lid];
        return '<span class="pop-badge" style="background:' + l.color + '">' + esc(l.name) + '</span>';
      }).join('') +
      '<div class="pop-meta">Station code ' + esc(code) + '</div>';
  }

  // Short label used on itinerary pills: "BTS", "MRT", bus number, "Boat"
  function shortLabel(leg) {
    if (leg.type === 'walk') return 'Walk';
    if (leg.type === 'bus') return leg.route.n;
    if (leg.type === 'boat') return 'Boat';
    var n = leg.lines[0].n;
    if (/^BTS/.test(n)) return 'BTS';
    if (/^MRT (\w+)/.test(n)) return n.replace(/^MRT (\w+).*/, '$1');
    if (/^SRT/.test(n)) return 'Red';
    if (/^Airport/.test(n)) return 'ARL';
    if (/^Gold/.test(n)) return 'Gold';
    return n;
  }

  return {
    CENTER: CENTER, TOUCH: TOUCH, tapWord: tapWord, esc: esc, fmtMin: fmtMin, fmtKm: fmtKm,
    createMap: createMap, getJSON: getJSON, drawRail: drawRail, shortLabel: shortLabel,
  };
})();
