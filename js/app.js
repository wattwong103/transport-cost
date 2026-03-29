// ============================================================
// Bangkok Transport Cost Comparison - Main Application
// ============================================================

(function () {
  'use strict';

  // State
  let transportModes = [];
  let trainData = null;
  let railGeoJSON = null;
  let boatGeoJSON = null;
  let map = null;
  let costChart = null;
  let timeChart = null;
  let selectedDistance = 10;
  let activeModeFilter = 'all';
  let trainLayers = {};
  let boatLayers = {};
  let busRouteLayer = null;

  // ============================================================
  // Data Loading
  // ============================================================

  async function loadData() {
    try {
      const [modesRes, trainRes, railRes, boatRes] = await Promise.all([
        fetch('data/transport-modes.json'),
        fetch('data/train-stations.json'),
        fetch('data/osm-rail-routes.geojson'),
        fetch('data/osm-boat-routes.geojson')
      ]);
      const modesData = await modesRes.json();
      transportModes = modesData.modes;
      trainData = await trainRes.json();
      railGeoJSON = await railRes.json();
      boatGeoJSON = await boatRes.json();

      hideLoading();
      initMap();
      initCharts();
      renderModeCards();
      renderLayerToggles();
      updateCharts();
    } catch (err) {
      console.error('Failed to load data:', err);
      document.getElementById('loading').textContent = 'Failed to load data. Please refresh.';
    }
  }

  function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
  }

  // ============================================================
  // Fare Calculation
  // ============================================================

  function calculateFare(mode, distanceKm) {
    if (mode.fareFormula === 'flat') {
      return mode.fareTable[0].fare;
    }

    if (mode.fareFormula === 'distance-based') {
      for (const tier of mode.fareTable) {
        if (distanceKm <= tier.maxKm) {
          return tier.fare;
        }
      }
      return mode.fareTable[mode.fareTable.length - 1].fare;
    }

    if (mode.fareFormula === 'metered' || mode.fareFormula === 'per-km') {
      let fare = mode.baseFare;
      let remaining = distanceKm;
      let prevMax = 0;

      for (const tier of mode.perKmRate) {
        const tierDist = Math.min(remaining, tier.maxKm - prevMax);
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
    return (distanceKm / mode.avgSpeedKmh) * 60; // minutes
  }

  // ============================================================
  // Map Initialization
  // ============================================================

  function initMap() {
    map = L.map('map', {
      center: [13.7563, 100.5018],
      zoom: 12,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18
    }).addTo(map);

    addTrainLines();
    addBoatRoutes();
    loadBusRoutes();
  }

  function addTrainLines() {
    if (!trainData) return;

    // Draw each line
    for (const [lineId, lineInfo] of Object.entries(trainData.lines)) {
      const layerGroup = L.layerGroup();

      // Try to use OSM GeoJSON geometry first
      const osmFeature = railGeoJSON && railGeoJSON.features.find(
        f => f.properties.lineId === lineId
      );

      if (osmFeature && osmFeature.geometry.coordinates.length > 0) {
        // Use real OSM route geometry
        const coords = osmFeature.geometry.coordinates.map(c => [c[1], c[0]]);
        L.polyline(coords, {
          color: lineInfo.color,
          weight: 4,
          opacity: 0.8
        }).addTo(layerGroup);
      } else {
        // Fallback: straight lines between stations
        const lineStations = Object.entries(trainData.stations)
          .filter(([, s]) => s.line === lineId)
          .sort((a, b) => {
            const numA = parseInt(a[0].replace(/[^\d]/g, '')) || 0;
            const numB = parseInt(b[0].replace(/[^\d]/g, '')) || 0;
            return numA - numB;
          });

        if (lineStations.length > 1) {
          const coords = lineStations.map(([, s]) => [s.lat, s.lng]);
          L.polyline(coords, {
            color: lineInfo.color,
            weight: 4,
            opacity: 0.8
          }).addTo(layerGroup);
        }
      }

      // Add station markers
      const lineStations = Object.entries(trainData.stations)
        .filter(([, s]) => s.line === lineId);

      for (const [code, station] of lineStations) {
        const marker = L.circleMarker([station.lat, station.lng], {
          radius: 5,
          fillColor: lineInfo.color,
          color: '#fff',
          weight: 2,
          fillOpacity: 1
        });

        marker.bindPopup(`
          <div class="station-popup">
            <h3>${station.name}</h3>
            <div>${station.nameTh || ''}</div>
            <span class="line-badge" style="background:${lineInfo.color}">${lineInfo.name}</span>
            <div class="detail">Station: ${code.toUpperCase()}</div>
          </div>
        `);

        marker.addTo(layerGroup);
      }

      layerGroup.addTo(map);
      trainLayers[lineId] = { layer: layerGroup, visible: true, info: lineInfo };
    }
  }

  function addBoatRoutes() {
    if (!boatGeoJSON) return;

    const boatRouteConfigs = {
      chao_phraya: { name: 'Chao Phraya Express Boat', color: '#00BCD4' },
      khlong: { name: 'Khlong Saen Saep Boat', color: '#009688' },
    };

    // Group features by route
    const routeFeatures = {};
    const piers = [];

    for (const feature of boatGeoJSON.features) {
      if (feature.properties.type === 'pier') {
        piers.push(feature);
      } else if (feature.properties.routeId) {
        const rid = feature.properties.routeId;
        if (!routeFeatures[rid]) routeFeatures[rid] = [];
        routeFeatures[rid].push(feature);
      }
    }

    // Create layers for each boat route
    for (const [routeId, config] of Object.entries(boatRouteConfigs)) {
      const layerGroup = L.layerGroup();

      // Add route line(s)
      const features = routeFeatures[routeId] || [];
      for (const feature of features) {
        if (feature.geometry.type === 'LineString') {
          const coords = feature.geometry.coordinates.map(c => [c[1], c[0]]);
          L.polyline(coords, {
            color: config.color,
            weight: 3,
            opacity: 0.7,
            dashArray: '8, 6'
          }).addTo(layerGroup);
        }
      }

      // Add pier markers near this route's area
      for (const pier of piers) {
        const [lng, lat] = pier.geometry.coordinates;
        // Assign piers to routes based on location
        const isChaoPhrayaPier = lng < 100.52; // West of center = river
        const isThisRoute = (routeId === 'chao_phraya' && isChaoPhrayaPier) ||
                            (routeId === 'khlong' && !isChaoPhrayaPier);

        if (isThisRoute) {
          const marker = L.circleMarker([lat, lng], {
            radius: 4,
            fillColor: config.color,
            color: '#fff',
            weight: 1.5,
            fillOpacity: 1
          });

          marker.bindPopup(`
            <div class="station-popup">
              <h3>${pier.properties.name || 'Pier'}</h3>
              <div>${pier.properties.nameTh || ''}</div>
              <span class="line-badge" style="background:${config.color}">${config.name}</span>
            </div>
          `);

          marker.addTo(layerGroup);
        }
      }

      layerGroup.addTo(map);
      boatLayers[routeId] = { layer: layerGroup, visible: true, info: config };
    }
  }

  async function loadBusRoutes() {
    try {
      const res = await fetch('longdo data/longdomap-bus-gtfs/routes.geojson');
      const geojson = await res.json();

      busRouteLayer = L.geoJSON(geojson, {
        style: {
          color: '#FF9800',
          weight: 1.5,
          opacity: 0.4
        },
        onEachFeature: function (feature, layer) {
          if (feature.properties && feature.properties.route_name) {
            layer.bindPopup('<b>Bus Route: ' + feature.properties.route_name + '</b>');
          }
        }
      });
      // Don't add to map by default
    } catch (err) {
      console.warn('Could not load bus routes GeoJSON:', err);
    }
  }

  // ============================================================
  // Charts
  // ============================================================

  function initCharts() {
    const distances = [];
    for (let d = 1; d <= 30; d++) distances.push(d);

    const costCtx = document.getElementById('costChart').getContext('2d');
    costChart = new Chart(costCtx, {
      type: 'line',
      data: {
        labels: distances,
        datasets: transportModes.map(mode => ({
          label: mode.name,
          data: distances.map(d => calculateFare(mode, d)),
          borderColor: mode.color,
          backgroundColor: mode.color + '20',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1.5,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + ' THB'
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'Distance (km)' } },
          y: { title: { display: true, text: 'Fare (THB)' }, beginAtZero: true }
        }
      }
    });

    const timeCtx = document.getElementById('timeChart').getContext('2d');
    timeChart = new Chart(timeCtx, {
      type: 'line',
      data: {
        labels: distances,
        datasets: transportModes.map(mode => ({
          label: mode.name,
          data: distances.map(d => Math.round(calculateTime(mode, d))),
          borderColor: mode.color,
          backgroundColor: mode.color + '20',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1.5,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + ' min'
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'Distance (km)' } },
          y: { title: { display: true, text: 'Time (minutes)' }, beginAtZero: true }
        }
      }
    });
  }

  function updateCharts() {
    if (!costChart || !timeChart) return;

    costChart.data.datasets.forEach((ds, i) => {
      const mode = transportModes[i];
      ds.pointRadius = costChart.data.labels.map(d => d === selectedDistance ? 6 : 0);
      ds.pointBackgroundColor = mode.color;
    });

    timeChart.data.datasets.forEach((ds, i) => {
      const mode = transportModes[i];
      ds.pointRadius = timeChart.data.labels.map(d => d === selectedDistance ? 6 : 0);
      ds.pointBackgroundColor = mode.color;
    });

    costChart.update();
    timeChart.update();

    renderModeCards();
  }

  // ============================================================
  // Mode Cards
  // ============================================================

  function renderModeCards() {
    const container = document.getElementById('modeCards');
    container.innerHTML = '';

    const filteredModes = activeModeFilter === 'all'
      ? transportModes
      : transportModes.filter(m => m.type === activeModeFilter);

    const sorted = [...filteredModes].sort((a, b) =>
      calculateFare(a, selectedDistance) - calculateFare(b, selectedDistance)
    );

    for (const mode of sorted) {
      const fare = calculateFare(mode, selectedDistance);
      const time = Math.round(calculateTime(mode, selectedDistance));

      const card = document.createElement('div');
      card.className = 'mode-card';
      card.style.setProperty('--mode-color', mode.color);
      card.dataset.modeId = mode.id;

      card.innerHTML = '<div class="mode-color-dot" style="background:' + mode.color + '"></div>' +
        '<div class="mode-card-info">' +
          '<div class="mode-card-name">' + mode.name + '</div>' +
          '<div class="mode-card-detail">' + mode.description + '</div>' +
          '<div class="mode-card-detail">' + mode.avgSpeedKmh + ' km/h avg | ~' + time + ' min for ' + selectedDistance + ' km</div>' +
        '</div>' +
        '<div class="mode-card-fare">' +
          '<div class="fare-value">' + fare + ' THB</div>' +
          '<div class="fare-label">for ' + selectedDistance + ' km</div>' +
        '</div>';

      card.addEventListener('click', function() { toggleModeHighlight(mode.id); });
      container.appendChild(card);
    }
  }

  function toggleModeHighlight(modeId) {
    const cards = document.querySelectorAll('.mode-card');
    cards.forEach(function(card) {
      card.classList.toggle('active', card.dataset.modeId === modeId && !card.classList.contains('active'));
    });

    const modeIndex = transportModes.findIndex(function(m) { return m.id === modeId; });
    var el = document.querySelector('.mode-card[data-mode-id="' + modeId + '"]');
    var isActive = el && el.classList.contains('active');

    costChart.data.datasets.forEach(function(ds, i) {
      ds.borderWidth = isActive ? (i === modeIndex ? 4 : 1) : 2;
      ds.borderColor = isActive && i !== modeIndex
        ? transportModes[i].color + '30'
        : transportModes[i].color;
    });
    timeChart.data.datasets.forEach(function(ds, i) {
      ds.borderWidth = isActive ? (i === modeIndex ? 4 : 1) : 2;
      ds.borderColor = isActive && i !== modeIndex
        ? transportModes[i].color + '30'
        : transportModes[i].color;
    });

    costChart.update();
    timeChart.update();
  }

  // ============================================================
  // Layer Toggles
  // ============================================================

  function renderLayerToggles() {
    var trainContainer = document.getElementById('trainLayerToggles');
    var boatContainer = document.getElementById('boatLayerToggles');
    var otherContainer = document.getElementById('otherLayerToggles');

    // Train lines
    for (const [lineId, data] of Object.entries(trainLayers)) {
      var btn = document.createElement('button');
      btn.className = 'layer-toggle active';
      btn.style.setProperty('--layer-color', data.info.color);
      btn.innerHTML = '<span class="dot" style="background:' + data.info.color + '"></span>' + data.info.name;
      btn.addEventListener('click', (function(d, b) {
        return function() {
          d.visible = !d.visible;
          b.classList.toggle('active', d.visible);
          if (d.visible) { d.layer.addTo(map); } else { map.removeLayer(d.layer); }
        };
      })(data, btn));
      trainContainer.appendChild(btn);
    }

    // Boat routes
    if (boatContainer) {
      for (const [routeId, data] of Object.entries(boatLayers)) {
        var btn2 = document.createElement('button');
        btn2.className = 'layer-toggle active';
        btn2.style.setProperty('--layer-color', data.info.color);
        btn2.innerHTML = '<span class="dot" style="background:' + data.info.color + '"></span>' + data.info.name;
        btn2.addEventListener('click', (function(d, b) {
          return function() {
            d.visible = !d.visible;
            b.classList.toggle('active', d.visible);
            if (d.visible) { d.layer.addTo(map); } else { map.removeLayer(d.layer); }
          };
        })(data, btn2));
        boatContainer.appendChild(btn2);
      }
    }

    // Bus routes toggle
    if (otherContainer) {
      var busBtn = document.createElement('button');
      busBtn.className = 'layer-toggle';
      busBtn.style.setProperty('--layer-color', '#FF9800');
      busBtn.innerHTML = '<span class="dot" style="background:#FF9800"></span>Bus Routes';
      var busVisible = false;
      busBtn.addEventListener('click', function() {
        busVisible = !busVisible;
        busBtn.classList.toggle('active', busVisible);
        if (busVisible && busRouteLayer) {
          busRouteLayer.addTo(map);
        } else if (busRouteLayer) {
          map.removeLayer(busRouteLayer);
        }
      });
      otherContainer.appendChild(busBtn);
    }
  }

  // ============================================================
  // Event Listeners
  // ============================================================

  function setupEventListeners() {
    var slider = document.getElementById('distanceSlider');
    var valueDisplay = document.getElementById('distanceValue');
    if (slider) {
      slider.addEventListener('input', function() {
        selectedDistance = parseInt(slider.value);
        valueDisplay.textContent = selectedDistance + ' km';
        updateCharts();
      });
    }

    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      });
    });

    document.querySelectorAll('.type-filter').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.type-filter').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeModeFilter = btn.dataset.type;
        renderModeCards();
      });
    });
  }

  // ============================================================
  // Initialize
  // ============================================================

  setupEventListeners();
  loadData();

})();
