/* RALLY TRIPMETER — app.js */

const STORE = {
  pin: 'rt_pin',
  mode: 'rt_mode',
  tripA: 'rt_tripA',
  tripB: 'rt_tripB',
  stageA: 'rt_stageA',
  stageB: 'rt_stageB',
  calib: 'rt_calib',
  units: 'rt_units',
  limitsOn: 'rt_limitsOn',
  wakeOn: 'rt_wakeOn',
};

const state = {
  mode: localStorage.getItem(STORE.mode) || 'recce',
  tripA: parseFloat(localStorage.getItem(STORE.tripA)) || 0,
  tripB: parseFloat(localStorage.getItem(STORE.tripB)) || 0,
  stageA: parseFloat(localStorage.getItem(STORE.stageA)) || 0,
  stageB: parseFloat(localStorage.getItem(STORE.stageB)) || 0,
  calib: parseFloat(localStorage.getItem(STORE.calib)) || 1.000,
  units: localStorage.getItem(STORE.units) || 'km',
  limitsOn: localStorage.getItem(STORE.limitsOn) !== 'false',
  wakeOn: localStorage.getItem(STORE.wakeOn) !== 'false',
  speed: 0,         // km/h
  avgSpeed: 0,
  maxSpeed: 0,
  heading: null,
  altitude: 0,
  limit: null,
  limitFetchedAt: 0,
  limitFetchedPos: null,
  lastPos: null,    // {lat, lon, t}
  running: false,
  sumSpeed: 0,
  sampleCount: 0,
  wakeLock: null,
};

/* ================= LOGIN ================= */
const pinEl = document.getElementById('pinDisplay');
const pinMsg = document.getElementById('pinMsg');
let pinBuf = '';

function savedPin() {
  return localStorage.getItem(STORE.pin) || '1234';
}

function refreshPinDots() {
  const dots = pinEl.querySelectorAll('span');
  dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuf.length));
}

function handleKey(k) {
  if (k === 'clear') pinBuf = '';
  else if (k === 'del') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += k;
  refreshPinDots();
  if (pinBuf.length === 4) {
    if (pinBuf === savedPin()) {
      pinMsg.textContent = 'OK';
      pinMsg.className = 'msg ok';
      setTimeout(showApp, 150);
    } else {
      pinMsg.textContent = 'WRONG PIN';
      pinMsg.className = 'msg';
      pinBuf = '';
      setTimeout(refreshPinDots, 250);
    }
  } else {
    pinMsg.textContent = '';
  }
}

document.querySelectorAll('.keypad button').forEach(b => {
  b.addEventListener('click', () => handleKey(b.dataset.k));
});

/* ================= APP SHOW ================= */
function showApp() {
  document.getElementById('login').classList.remove('active');
  document.getElementById('app').classList.add('active');
  state.running = true;
  startGPS();
  startClock();
  if (state.wakeOn) acquireWakeLock();
  renderAll();
}

function logout() {
  state.running = false;
  stopGPS();
  releaseWakeLock();
  pinBuf = '';
  refreshPinDots();
  pinMsg.textContent = '';
  document.getElementById('app').classList.remove('active');
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('login').classList.add('active');
}

/* ================= MODE ================= */
document.getElementById('btnRecce').addEventListener('click', () => setMode('recce'));
document.getElementById('btnRace').addEventListener('click', () => setMode('race'));

function setMode(m) {
  state.mode = m;
  localStorage.setItem(STORE.mode, m);
  document.getElementById('btnRecce').classList.toggle('active', m === 'recce');
  document.getElementById('btnRace').classList.toggle('active', m === 'race');
  document.getElementById('raceSetup').style.display = m === 'race' ? 'block' : 'none';
  renderTrips();
}

/* ================= GPS ================= */
let watchId = null;

function startGPS() {
  if (!navigator.geolocation) {
    gpsBadge(false, 'NO GEO');
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true,
    maximumAge: 500,
    timeout: 15000,
  });
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function gpsBadge(ok, txt) {
  const el = document.getElementById('gpsStatus');
  el.classList.toggle('ok', ok);
  el.classList.toggle('bad', !ok);
  el.textContent = txt || (ok ? 'GPS' : 'GPS');
}

function onPosErr(err) {
  gpsBadge(false, 'GPS ERR');
}

function onPos(pos) {
  const { latitude, longitude, speed, heading, altitude, accuracy } = pos.coords;
  const t = pos.timestamp;
  gpsBadge(true, accuracy ? `±${Math.round(accuracy)}m` : 'GPS');

  // Speed: use provided (m/s) if available, else compute from positions
  let kmh = 0;
  if (typeof speed === 'number' && !isNaN(speed) && speed >= 0) {
    kmh = speed * 3.6;
  } else if (state.lastPos) {
    const d = haversine(state.lastPos.lat, state.lastPos.lon, latitude, longitude);
    const dt = (t - state.lastPos.t) / 1000;
    if (dt > 0) kmh = (d / dt) * 3.6;
  }

  // Distance increment from last position
  if (state.lastPos && kmh >= 1.5) {
    const dKm = haversine(state.lastPos.lat, state.lastPos.lon, latitude, longitude) / 1000;
    const adj = dKm * state.calib;
    applyTripDelta(adj);
  }

  state.lastPos = { lat: latitude, lon: longitude, t };
  state.speed = kmh;
  state.altitude = altitude || 0;
  if (typeof heading === 'number' && !isNaN(heading)) state.heading = heading;

  // Stats
  if (kmh > 2) {
    state.sumSpeed += kmh;
    state.sampleCount++;
    state.avgSpeed = state.sumSpeed / state.sampleCount;
    if (kmh > state.maxSpeed) state.maxSpeed = kmh;
  }

  // Speed limit fetch (throttled by distance + time)
  if (state.limitsOn && shouldFetchLimit(latitude, longitude, t)) {
    fetchSpeedLimit(latitude, longitude).catch(() => {});
  }

  renderLive();
  persistTrips();
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function applyTripDelta(dKm) {
  if (state.mode === 'recce') {
    state.tripA += dKm;
    state.tripB += dKm;
  } else {
    state.tripA = Math.max(0, state.tripA - dKm);
    state.tripB = Math.max(0, state.tripB - dKm);
  }
}

/* ================= SPEED LIMIT (OSM Overpass) ================= */
function shouldFetchLimit(lat, lon, t) {
  if (!state.limitFetchedPos) return true;
  if (t - state.limitFetchedAt < 15000) return false;
  const d = haversine(state.limitFetchedPos.lat, state.limitFetchedPos.lon, lat, lon);
  return d > 80;
}

async function fetchSpeedLimit(lat, lon) {
  state.limitFetchedAt = Date.now();
  state.limitFetchedPos = { lat, lon };
  const q = `[out:json][timeout:8];way(around:40,${lat},${lon})[highway][maxspeed];out tags 1;`;
  const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q);
  try {
    const r = await fetch(url);
    if (!r.ok) throw 0;
    const j = await r.json();
    const w = j.elements && j.elements[0];
    if (w && w.tags && w.tags.maxspeed) {
      const v = parseInt(w.tags.maxspeed, 10);
      if (!isNaN(v)) {
        state.limit = v;
        renderLimit();
        return;
      }
    }
    state.limit = null;
    renderLimit();
  } catch (e) {
    // keep previous limit
  }
}

/* ================= RENDER ================= */
function fmtTrip(n) {
  return n.toFixed(2);
}

function renderLive() {
  document.getElementById('speed').textContent = Math.round(state.speed);
  document.getElementById('avgSpeed').textContent = Math.round(state.avgSpeed);
  document.getElementById('maxSpeed').textContent = Math.round(state.maxSpeed);
  document.getElementById('altitude').textContent = Math.round(state.altitude) + ' m';
  document.getElementById('heading').textContent =
    state.heading == null ? '---°' : Math.round(state.heading) + '°';
  renderTrips();
  renderLimit();
}

function renderTrips() {
  const a = document.getElementById('tripA');
  const b = document.getElementById('tripB');
  a.textContent = fmtTrip(state.tripA);
  b.textContent = fmtTrip(state.tripB);
  a.classList.toggle('done', state.mode === 'race' && state.tripA === 0 && state.stageA > 0);
  b.classList.toggle('done', state.mode === 'race' && state.tripB === 0 && state.stageB > 0);

  const sa = document.getElementById('tripAStage');
  const sb = document.getElementById('tripBStage');
  if (state.mode === 'race') {
    sa.classList.remove('hidden');
    sb.classList.remove('hidden');
    sa.querySelector('span').textContent = fmtTrip(state.stageA);
    sb.querySelector('span').textContent = fmtTrip(state.stageB);
  } else {
    sa.classList.add('hidden');
    sb.classList.add('hidden');
  }
}

function renderLimit() {
  const box = document.getElementById('limitBox');
  const el = document.getElementById('limit');
  if (state.limit == null) {
    el.textContent = '--';
    box.classList.remove('over');
  } else {
    el.textContent = state.limit;
    box.classList.toggle('over', state.speed > state.limit + 3);
  }
}

function renderAll() {
  setMode(state.mode);
  renderLive();
}

/* ================= TRIP RESET ================= */
document.querySelectorAll('.trip-action').forEach(btn => {
  btn.addEventListener('click', () => resetTrip(btn.dataset.trip));
});

function resetTrip(which) {
  if (state.mode === 'recce') {
    if (which === 'A') state.tripA = 0;
    else state.tripB = 0;
  } else {
    if (which === 'A') state.tripA = state.stageA;
    else state.tripB = state.stageB;
  }
  persistTrips();
  renderTrips();
}

function persistTrips() {
  localStorage.setItem(STORE.tripA, state.tripA.toFixed(4));
  localStorage.setItem(STORE.tripB, state.tripB.toFixed(4));
}

/* ================= CLOCK ================= */
function startClock() {
  const tick = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    document.getElementById('clock').textContent = `${hh}:${mm}`;
  };
  tick();
  setInterval(tick, 15000);
}

/* ================= WAKE LOCK ================= */
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (e) {}
}
function releaseWakeLock() {
  try { state.wakeLock && state.wakeLock.release(); } catch (e) {}
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.wakeOn && state.running) acquireWakeLock();
});

/* ================= MENU ================= */
const menu = document.getElementById('menu');
document.getElementById('btnMenu').addEventListener('click', () => openMenu());
document.getElementById('closeMenu').addEventListener('click', () => menu.classList.add('hidden'));
document.getElementById('logout').addEventListener('click', logout);

function openMenu() {
  document.getElementById('stageA').value = state.stageA;
  document.getElementById('stageB').value = state.stageB;
  document.getElementById('calib').value = state.calib;
  document.getElementById('units').value = state.units;
  document.getElementById('wakeLock').checked = state.wakeOn;
  document.getElementById('limitsOn').checked = state.limitsOn;
  document.getElementById('raceSetup').style.display = state.mode === 'race' ? 'block' : 'none';
  menu.classList.remove('hidden');
}

document.getElementById('applyStage').addEventListener('click', () => {
  state.stageA = parseFloat(document.getElementById('stageA').value) || 0;
  state.stageB = parseFloat(document.getElementById('stageB').value) || 0;
  localStorage.setItem(STORE.stageA, state.stageA);
  localStorage.setItem(STORE.stageB, state.stageB);
  state.tripA = state.stageA;
  state.tripB = state.stageB;
  persistTrips();
  renderTrips();
  menu.classList.add('hidden');
});

document.getElementById('calib').addEventListener('change', e => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0.5 && v < 1.5) {
    state.calib = v;
    localStorage.setItem(STORE.calib, v);
  }
});

document.getElementById('units').addEventListener('change', e => {
  state.units = e.target.value;
  localStorage.setItem(STORE.units, state.units);
});

document.getElementById('wakeLock').addEventListener('change', e => {
  state.wakeOn = e.target.checked;
  localStorage.setItem(STORE.wakeOn, state.wakeOn);
  if (state.wakeOn) acquireWakeLock(); else releaseWakeLock();
});

document.getElementById('limitsOn').addEventListener('change', e => {
  state.limitsOn = e.target.checked;
  localStorage.setItem(STORE.limitsOn, state.limitsOn);
  if (!state.limitsOn) { state.limit = null; renderLimit(); }
});

document.getElementById('savePin').addEventListener('click', () => {
  const v = document.getElementById('newPin').value;
  if (/^\d{4}$/.test(v)) {
    localStorage.setItem(STORE.pin, v);
    document.getElementById('newPin').value = '';
    alert('PIN updated');
  } else {
    alert('PIN must be 4 digits');
  }
});

/* ================= SERVICE WORKER (offline) ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
