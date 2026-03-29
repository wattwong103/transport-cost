// ============================================================
// DMK Airport Isoline Map
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

  var transportModes = [];
  var map = null;
  var ringLayer = null;
  var selectedMode = null;
  var viewType = 'cost'; // 'cost' or 'time'

  // ============================================================
  // Fare Calculation (duplicated from app.js for standalone use)
  // ============================================================

  function calculateFare(mode, distanceKm) {
    if (mode.fareFormula === 'flat') {
      return mode.fareTable[0].fare;
    }
    if (mode.fareFormula === 'distance-based') {
      for (var i = 0; i < mode.fareTable.length; i++) {
        if (distanceKm <= mode.fareTable[i].maxKm) {
          return mode.fareTable[i].fare;
        }
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

  function getDistanceForFare(mode, targetFare) {
    // Binary search for the distance that gives this fare
    var lo = 0, hi = 60;
    for (var i = 0; i < 30; i++) {
      var mid = (lo + hi) / 2;
      if (calculateFare(mode, mid) <= targetFare) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function getDistanceForTime(mode, targetMinutes) {
    return targetMinutes * mode.avgSpeedKmh / 60;
  }

  // ============================================================
  // Data Loading
  // ============================================================

  async function loadData() {
    try {
      var res = await fetch('data/transport-modes.json');
      var data = await res.json();
      transportModes = data.modes;

      document.getElementById('isoline-loading').classList.add('hidden');
      initMap();
      renderModeButtons();
      selectedMode = transportModes[0];
      setActiveMode(selectedMode.id);
      drawRings();
      updateLegend();
    } catch (err) {
      console.error('Failed to load data:', err);
      document.getElementById('isoline-loading').textContent = 'Failed to load data.';
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

    // DMK marker
    L.marker(DMK).addTo(map).bindPopup(
      '<b>Don Mueang Airport (DMK)</b><br>ท่าอากาศยานดอนเมือง'
    ).openPopup();

    ringLayer = L.layerGroup().addTo(map);
  }

  function drawRings() {
    if (!ringLayer || !selectedMode) return;
    ringLayer.clearLayers();

    var bands = viewType === 'cost' ? COST_BANDS : TIME_BANDS;

    // Draw from outermost to innermost so inner rings paint over outer
    for (var i = bands.length - 1; i >= 0; i--) {
      var distKm;
      if (viewType === 'cost') {
        distKm = getDistanceForFare(selectedMode, bands[i]);
      } else {
        distKm = getDistanceForTime(selectedMode, bands[i]);
      }

      if (distKm < 0.1) continue;

      var circle = L.circle(DMK, {
        radius: distKm * 1000,
        color: COLORS[i],
        fillColor: COLORS[i],
        fillOpacity: 0.2,
        weight: 2,
        opacity: 0.6
      });

      var label = viewType === 'cost'
        ? bands[i] + ' THB'
        : bands[i] + ' min';
      circle.bindTooltip(label, { sticky: true });
      circle.addTo(ringLayer);
    }
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
          drawRings();
          updateLegend();
        }
      });
      container.appendChild(btn);
    }
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
    // View toggle
    document.querySelectorAll('.view-toggle button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.view-toggle button').forEach(function(b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        viewType = btn.dataset.view;
        drawRings();
        updateLegend();
      });
    });
  }

  // ============================================================
  // Init
  // ============================================================

  setupControls();
  loadData();

})();
