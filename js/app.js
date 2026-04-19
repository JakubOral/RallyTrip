/* RALLY TRIPMETER — app.js (Monit + Waze style) */

const STORE = {
  pin: 'rt_pin',
  mode: 'rt_mode',
  tripA: 'rt_tripA',
  tripB: 'rt_tripB',
  stageA: 'rt_stageA',
  stageB: 'rt_stageB',
  calib: 'rt_calib',
  limitsOn: 'rt_limitsOn',
  wakeOn: 'rt_wakeOn',
  alertSound: 'rt_alertSound',
  alertVibe: 'rt_alertVibe',
  tolerance: 'rt_tolerance',
  maxGauge: 'rt_maxGauge',
};

const state = {
  mode: localStorage.getItem(STORE.mode) || 'recce',
  tripA: parseFloat(localStorage.getItem(STORE.tripA)) || 0,
  tripB: parseFloat(localStorage.getItem(STORE.tripB)) || 0,
  stageA: parseFloat(localStorage.getItem(STORE.stageA)) || 0,
  stageB: parseFloat(localStorage.getItem(STORE.stageB)) || 0,
  calib: parseFloat(localStorage.getItem(STORE.calib)) || 1.000,
  limitsOn: localStorage.getItem(STORE.limitsOn) !== 'false',
  wakeOn: localStorage.getItem(STORE.wakeOn) !== 'false',
  alertSound: localStorage.getItem(STORE.alertSound) !== 'false',
  alertVibe: localStorage.getItem(STORE.alertVibe) !== 'false',
  tolerance: parseInt(localStorage.getItem(STORE.tolerance), 10),
  maxGauge: parseInt(localStorage.getItem(STORE.maxGauge), 10) || 180,
  speed: 0, avgSpeed: 0, maxSpeed: 0,
  heading: null, altitude: 0,
  limit: null,
  limitFetchedAt: 0, limitFetchedPos: null,
  lastPos: null,
  running: false,
  sumSpeed: 0, sampleCount: 0,
  wakeLock: null,
  overSince: 0,
  lastBeepAt: 0,
  wasOver: false,
  sideClrCycle: 0,
};
if (isNaN(state.tolerance)) state.tolerance = 3;

/* ================= LOGIN ================= */
const pinEl = document.getElementById('pinDisplay');
const pinMsg = document.getElementById('pinMsg');
let pinBuf = '';

const savedPin = () => localStorage.getItem(STORE.pin) || '1234';

function refreshPinDots() {
  pinEl.querySelectorAll('span').forEach((d, i) => d.classList.toggle('filled', i < pinBuf.length));
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
  } else pinMsg.textContent = '';
}

document.querySelectorAll('.keypad button').forEach(b => {
  b.addEventListener('click', () => handleKey(b.dataset.k));
});

/* ================= APP SHOW ================= */
function showApp() {
  document.getElementById('login').classList.remove('active');
  document.getElementById('app').classList.add('active');
  state.running = true;
  primeAudio();
  startGPS();
  startClock();
  if (state.wakeOn) acquireWakeLock();
  renderAll();
  requestAnimationFrame(fitTripDigits);
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
document.getElementById('btnModeSide').addEventListener('click',
  () => setMode(state.mode === 'recce' ? 'race' : 'recce'));

function setMode(m) {
  state.mode = m;
  localStorage.setItem(STORE.mode, m);
  document.getElementById('btnRecce').classList.toggle('active', m === 'recce');
  document.getElementById('btnRace').classList.toggle('active', m === 'race');
  document.getElementById('raceSetup').style.display = m === 'race' ? 'block' : 'none';
  document.getElementById('iconMode').textContent = m === 'race' ? '▼ RACE' : '▲ RECCE';
  renderTrips();
}

/* Side CLR button cycles A → B → both */
document.getElementById('btnClr').addEventListener('click', () => {
  const target = ['A', 'B', 'AB'][state.sideClrCycle % 3];
  state.sideClrCycle++;
  if (target === 'A') resetTrip('A');
  else if (target === 'B') resetTrip('B');
  else { resetTrip('A'); resetTrip('B'); }
});

/* Tap on a trip row directly to reset it */
document.getElementById('tripAWrap').addEventListener('click', () => resetTrip('A'));
document.getElementById('tripBWrap').addEventListener('click', () => resetTrip('B'));

/* ================= GPS ================= */
let watchId = null;

function startGPS() {
  if (!navigator.geolocation) { gpsBadge(false, 'NO GEO'); return; }
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true, maximumAge: 500, timeout: 15000,
  });
}
function stopGPS() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}
function gpsBadge(ok, txt) {
  const el = document.getElementById('gpsStatus');
  el.classList.toggle('ok', ok);
  el.classList.toggle('bad', !ok);
  el.textContent = txt || 'GPS';
}
function onPosErr() { gpsBadge(false, 'GPS ERR'); }

function onPos(pos) {
  const { latitude, longitude, speed, heading, altitude, accuracy } = pos.coords;
  const t = pos.timestamp;
  gpsBadge(true, accuracy ? `±${Math.round(accuracy)}m` : 'GPS');

  let kmh = 0;
  if (typeof speed === 'number' && !isNaN(speed) && speed >= 0) {
    kmh = speed * 3.6;
  } else if (state.lastPos) {
    const d = haversine(state.lastPos.lat, state.lastPos.lon, latitude, longitude);
    const dt = (t - state.lastPos.t) / 1000;
    if (dt > 0) kmh = (d / dt) * 3.6;
  }

  if (state.lastPos && kmh >= 1.5) {
    const dKm = haversine(state.lastPos.lat, state.lastPos.lon, latitude, longitude) / 1000;
    const adj = dKm * state.calib;
    applyTripDelta(adj);
  }

  state.lastPos = { lat: latitude, lon: longitude, t };
  state.speed = kmh;
  state.altitude = altitude || 0;
  if (typeof heading === 'number' && !isNaN(heading)) state.heading = heading;

  if (kmh > 2) {
    state.sumSpeed += kmh;
    state.sampleCount++;
    state.avgSpeed = state.sumSpeed / state.sampleCount;
    if (kmh > state.maxSpeed) state.maxSpeed = kmh;
  }

  if (state.limitsOn && shouldFetchLimit(latitude, longitude, t)) {
    fetchSpeedLimit(latitude, longitude).catch(() => {});
  }

  checkOverLimit();
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

/* ================= SPEED LIMIT ================= */
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
    if (!r.ok) return;
    const j = await r.json();
    const w = j.elements && j.elements[0];
    if (w && w.tags && w.tags.maxspeed) {
      const v = parseInt(w.tags.maxspeed, 10);
      if (!isNaN(v)) { state.limit = v; renderLimit(); return; }
    }
    state.limit = null;
    renderLimit();
  } catch (e) { /* keep previous */ }
}

/* ================= OVER-LIMIT ALERT ================= */
function checkOverLimit() {
  if (state.limit == null) { state.wasOver = false; return; }
  const over = state.speed > state.limit + state.tolerance;
  if (over && !state.wasOver) {
    triggerAlert(true);            // crossed the line → beep
    state.overSince = Date.now();
    state.lastBeepAt = Date.now();
  } else if (over) {
    if (Date.now() - state.lastBeepAt > 4000) {
      triggerAlert(false);         // still over → soft beep every 4s
      state.lastBeepAt = Date.now();
    }
  }
  state.wasOver = over;
}

/* Web Audio beep + vibration */
let audioCtx = null;
function primeAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
function beep(freq, ms, gain) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g); g.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + ms / 1000);
}
function triggerAlert(firstCross) {
  if (state.alertSound) {
    primeAudio();
    if (firstCross) {
      beep(1200, 180, 0.25);
      setTimeout(() => beep(1600, 220, 0.25), 220);
    } else {
      beep(1400, 120, 0.18);
    }
  }
  if (state.alertVibe && navigator.vibrate) {
    navigator.vibrate(firstCross ? [120, 60, 120, 60, 180] : [80]);
  }
}

/* ================= RENDER ================= */
const fmtTrip = n => n.toFixed(2);

function renderLive() {
  document.getElementById('speed').textContent = Math.round(state.speed);
  document.getElementById('avgSpeed').textContent = Math.round(state.avgSpeed);
  document.getElementById('maxSpeed').textContent = Math.round(state.maxSpeed);
  document.getElementById('altitude').textContent = Math.round(state.altitude) + ' m';
  document.getElementById('heading').textContent =
    state.heading == null ? '---°' : Math.round(state.heading) + '°';

  // Speed ring progress (0 → maxGauge)
  const ring = document.getElementById('speedRing');
  const circ = 339.3; // 2π·54
  const pct = Math.max(0, Math.min(1, state.speed / state.maxGauge));
  ring.setAttribute('stroke-dashoffset', (circ * (1 - pct)).toFixed(1));

  // Over-limit visual
  const over = state.limit != null && state.speed > state.limit + state.tolerance;
  document.getElementById('speedCircle').classList.toggle('over', over);

  renderTrips();
  renderLimit();
}

function renderTrips() {
  const a = document.getElementById('tripA');
  const b = document.getElementById('tripB');
  a.textContent = fmtTrip(state.tripA);
  b.textContent = fmtTrip(state.tripB);
  const aDone = state.mode === 'race' && state.tripA === 0 && state.stageA > 0;
  const bDone = state.mode === 'race' && state.tripB === 0 && state.stageB > 0;
  a.classList.toggle('done', aDone);
  b.classList.toggle('done', bDone);
  fitTripDigits();
}

/* Auto-fit each trip digit row: biggest font-size that fits width AND height */
function fitTripDigits() {
  ['tripA', 'tripB'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const row = el.parentElement;
    const w = row.clientWidth;
    const h = row.clientHeight;
    if (!w || !h) return;
    // Monospace Courier: ~0.6em per char after tight letter-spacing. "99.99" = 5 chars.
    // Cap height ~0.72em. Use 0.8 for safety to avoid vertical clipping.
    const fsByWidth  = w / (5 * 0.60);
    const fsByHeight = h / 0.80;
    const fs = Math.max(24, Math.min(fsByWidth, fsByHeight));
    el.style.fontSize = fs + 'px';
  });
}

window.addEventListener('resize', fitTripDigits);
window.addEventListener('orientationchange', () => setTimeout(fitTripDigits, 150));

function renderLimit() {
  const el = document.getElementById('limit');
  const sign = document.getElementById('limitSign');
  if (state.limit == null) {
    el.textContent = '--';
    sign.classList.add('off');
  } else {
    el.textContent = state.limit;
    sign.classList.remove('off');
  }
}

function renderAll() {
  setMode(state.mode);
  renderLive();
}

/* ================= TRIP RESET ================= */
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
  document.getElementById('wakeLock').checked = state.wakeOn;
  document.getElementById('limitsOn').checked = state.limitsOn;
  document.getElementById('alertSound').checked = state.alertSound;
  document.getElementById('alertVibe').checked = state.alertVibe;
  document.getElementById('tolerance').value = state.tolerance;
  document.getElementById('maxGauge').value = state.maxGauge;
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

function bindToggle(id, key, field, onChange) {
  document.getElementById(id).addEventListener('change', e => {
    state[field] = e.target.checked;
    localStorage.setItem(key, state[field]);
    if (onChange) onChange();
  });
}
bindToggle('wakeLock', STORE.wakeOn, 'wakeOn',
  () => state.wakeOn ? acquireWakeLock() : releaseWakeLock());
bindToggle('limitsOn', STORE.limitsOn, 'limitsOn',
  () => { if (!state.limitsOn) { state.limit = null; renderLimit(); } });
bindToggle('alertSound', STORE.alertSound, 'alertSound', primeAudio);
bindToggle('alertVibe', STORE.alertVibe, 'alertVibe');

document.getElementById('tolerance').addEventListener('change', e => {
  const v = parseInt(e.target.value, 10);
  if (!isNaN(v) && v >= 0 && v <= 30) {
    state.tolerance = v;
    localStorage.setItem(STORE.tolerance, v);
  }
});

document.getElementById('maxGauge').addEventListener('change', e => {
  const v = parseInt(e.target.value, 10);
  if (!isNaN(v) && v >= 60 && v <= 300) {
    state.maxGauge = v;
    localStorage.setItem(STORE.maxGauge, v);
    renderLive();
  }
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

/* ================= SERVICE WORKER ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ================= AUTO-START (PIN disabled) ================= */
window.addEventListener('DOMContentLoaded', () => {
  showApp();
  // Prime audio context on first user interaction (iOS requirement)
  const prime = () => { primeAudio(); document.removeEventListener('touchstart', prime); document.removeEventListener('click', prime); };
  document.addEventListener('touchstart', prime, { once: true });
  document.addEventListener('click', prime, { once: true });
});
