// ============================================================
// Bangkok Transport Cost Comparison - Main Application
// ============================================================

(function () {
  'use strict';

  // State
  let transportModes = [];
  let trainData = null;
  let map = null;
  let costChart = null;
  let timeChart = null;
  let selectedDistance = 10;
  let activeModeFilter = 'all';
  let trainLayers = {};
  let busRouteLayer = null;
  let busStopLayer = null;

  // ============================================================
  // Data Loading
  // ============================================================

  async function loadData() {
    try {
      const [modesRes, trainRes] = await Promise.all([
        fetch('data/transport-modes.json'),
        fetch('data/train-stations.json')
      ]);
      const modesData = await modesRes.json();
      transportModes = modesData.modes;
      trainData = await trainRes.json();

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
    loadBusRoutes();
  }

  function addTrainLines() {
    if (!trainData) return;

    const lineGroups = {};

    // Group stations by line
    for (const [code, station] of Object.entries(trainData.stations)) {
      const lineId = station.line;
      if (!lineGroups[lineId]) {
        lineGroups[lineId] = [];
      }
    }

    // Draw each line
    for (const [lineId, lineInfo] of Object.entries(trainData.lines)) {
      const lineStations = Object.entries(trainData.stations)
        .filter(([code, s]) => s.line === lineId)
        .sort((a, b) => {
          const numA = parseInt(a[0].replace(/[^\d]/g, '')) || 0;
          const numB = parseInt(b[0].replace(/[^\d]/g, '')) || 0;
          return numA - numB;
        });

      const layerGroup = L.layerGroup();

      // Draw line segments
      if (lineStations.length > 1) {
        const coords = lineStations.map(([, s]) => [s.lat, s.lng]);
        L.polyline(coords, {
          color: lineInfo.color,
          weight: 4,
          opacity: 0.8
        }).addTo(layerGroup);
      }

      // Add station markers
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
          if (feature.properties && feature.properties.name) {
            layer.bindPopup(`<b>Bus Route: ${feature.properties.name}</b>`);
          }
        }
      });
      // Don't add to map by default (too many routes)
      // User can toggle on via layers tab
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
              label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y} THB`
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
              label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y} min`
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'Distance (km)' } },
          y: { title: { display: true, text: 'Time (minutes)' }, beginAtZero: true }
        }
      }
    });

    // Add vertical line plugin for selected distance
    addDistanceLinePlugin(costChart);
    addDistanceLinePlugin(timeChart);
  }

  function addDistanceLinePlugin(chart) {
    chart.options.plugins.annotation = chart.options.plugins.annotation || {};
  }

  function updateCharts() {
    if (!costChart || !timeChart) return;

    // Update vertical line annotation (visual indicator at selected distance)
    // Highlight the selected distance in charts using point radius
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

    // Update mode cards with current distance fare
    updateModeCardFares();
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

    // Sort by fare at current distance
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

      card.innerHTML = `
        <div class="mode-color-dot" style="background:${mode.color}"></div>
        <div class="mode-card-info">
          <div class="mode-card-name">${mode.name}</div>
          <div class="mode-card-detail">${mode.description}</div>
          <div class="mode-card-detail">${mode.avgSpeedKmh} km/h avg | ~${time} min for ${selectedDistance} km</div>
        </div>
        <div class="mode-card-fare">
          <div class="fare-value">${fare} THB</div>
          <div class="fare-label">for ${selectedDistance} km</div>
        </div>
      `;

      card.addEventListener('click', () => toggleModeHighlight(mode.id));
      container.appendChild(card);
    }
  }

  function updateModeCardFares() {
    const cards = document.querySelectorAll('.mode-card');
    cards.forEach(card => {
      const modeId = card.dataset.modeId;
      const mode = transportModes.find(m => m.id === modeId);
      if (!mode) return;

      const fare = calculateFare(mode, selectedDistance);
      const time = Math.round(calculateTime(mode, selectedDistance));

      card.querySelector('.fare-value').textContent = `${fare} THB`;
      card.querySelector('.fare-label').textContent = `for ${selectedDistance} km`;
      card.querySelector('.mode-card-detail:last-child').textContent =
        `${mode.avgSpeedKmh} km/h avg | ~${time} min for ${selectedDistance} km`;
    });

    // Re-sort cards
    const container = document.getElementById('modeCards');
    const cardsArray = Array.from(container.children);
    cardsArray.sort((a, b) => {
      const modeA = transportModes.find(m => m.id === a.dataset.modeId);
      const modeB = transportModes.find(m => m.id === b.dataset.modeId);
      return calculateFare(modeA, selectedDistance) - calculateFare(modeB, selectedDistance);
    });
    cardsArray.forEach(card => container.appendChild(card));
  }

  function toggleModeHighlight(modeId) {
    const cards = document.querySelectorAll('.mode-card');
    cards.forEach(card => {
      card.classList.toggle('active', card.dataset.modeId === modeId && !card.classList.contains('active'));
    });

    // Highlight in charts
    const modeIndex = transportModes.findIndex(m => m.id === modeId);
    const isActive = document.querySelector(`.mode-card[data-mode-id="${modeId}"]`)?.classList.contains('active');

    costChart.data.datasets.forEach((ds, i) => {
      ds.borderWidth = isActive ? (i === modeIndex ? 4 : 1) : 2;
      ds.borderColor = isActive && i !== modeIndex
        ? transportModes[i].color + '30'
        : transportModes[i].color;
    });
    timeChart.data.datasets.forEach((ds, i) => {
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
    const trainContainer = document.getElementById('trainLayerToggles');
    const otherContainer = document.getElementById('otherLayerToggles');

    // Train lines
    for (const [lineId, data] of Object.entries(trainLayers)) {
      const btn = document.createElement('button');
      btn.className = 'layer-toggle active';
      btn.style.setProperty('--layer-color', data.info.color);
      btn.innerHTML = `<span class="dot" style="background:${data.info.color}"></span>${data.info.name}`;
      btn.addEventListener('click', () => {
        data.visible = !data.visible;
        btn.classList.toggle('active', data.visible);
        if (data.visible) {
          data.layer.addTo(map);
        } else {
          map.removeLayer(data.layer);
        }
      });
      trainContainer.appendChild(btn);
    }

    // Bus routes toggle
    const busBtn = document.createElement('button');
    busBtn.className = 'layer-toggle';
    busBtn.style.setProperty('--layer-color', '#FF9800');
    busBtn.innerHTML = '<span class="dot" style="background:#FF9800"></span>Bus Routes';
    let busVisible = false;
    busBtn.addEventListener('click', () => {
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

  // ============================================================
  // Event Listeners
  // ============================================================

  function setupEventListeners() {
    // Distance slider
    const slider = document.getElementById('distanceSlider');
    const valueDisplay = document.getElementById('distanceValue');
    slider.addEventListener('input', () => {
      selectedDistance = parseInt(slider.value);
      valueDisplay.textContent = `${selectedDistance} km`;
      updateCharts();
    });

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      });
    });

    // Type filters
    document.querySelectorAll('.type-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-filter').forEach(b => b.classList.remove('active'));
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
