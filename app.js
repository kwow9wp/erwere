/* ============================================================
   Atlas — Yandex Maps Edition
   - Yandex JS API 2.1 (full vector maps with house numbers)
   - Yandex Geocoder REST API for address search (key #2)
   - Open-Elevation API for altitude
   - Open-Meteo for weather
   ============================================================ */

// JS API key for map tiles (must have JavaScript API enabled)
// Geocoder key for address search (must have Geocoder API enabled)
const YANDEX_GEOCODER_KEY = '98d421af-8892-45fe-bce2-7f4fba36b611';

let map;
let clickPlacemark = null;
let userPlacemark = null;
let userAccuracyCircle = null;
let measureLine = null;
let measurePoints = [];
let measurePointPlacemarks = [];
let lastElevFetch = 0;
let mouseElevTimer = null;
let pinLayout = null;
let geoLayout = null;
let bookmarkLayout = null;

if (typeof ymaps !== 'undefined') {
  ymaps.ready(() => {
    init();
  });
}

function init() {
  map = new ymaps.Map('map', {
    center: [55.7558, 37.6173],
    zoom: 11,
    type: 'yandex#hybrid',
    controls: []
  });

  map.events.add('click', onMapClick);
  map.events.add('mousemove', onMapMove);
  map.events.add('boundschange', syncHash);
  map.events.add('dblclick', () => clearMeasure());

  // Fully custom marker layouts (no default Yandex icon → no blue dot)
  pinLayout = ymaps.templateLayoutFactory.createClass(
    '<div class="atlas-pin"><div class="atlas-pin-shadow"></div><div class="atlas-pin-body"></div></div>'
  );
  geoLayout = ymaps.templateLayoutFactory.createClass(
    '<div class="atlas-geo"><div class="atlas-geo-pulse"></div><div class="atlas-geo-dot"></div></div>'
  );
  bookmarkLayout = ymaps.templateLayoutFactory.createClass(
    '<div class="atlas-bm"><div class="atlas-bm-pin"></div></div>'
  );

  initUI();
  restoreBookmarks();
  loadHash();

  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
    setTimeout(() => loadingOverlay.remove(), 500);
  }, 300);
}

// ===== State =====
const state = {
  currentStyle: 'yandex#hybrid',
  measureMode: false,
  bookmarks: [],
  theme: localStorage.getItem('atlas_theme') || 'dark',
  currentPlace: null
};

// ===== Helpers =====
const $ = (id) => document.getElementById(id);

const panel = $('sidepanel');
const overlay = $('panelOverlay');
const panelClose = $('panelClose');
const panelHandle = $('panelHandle');
let currentTab = 'info';

document.body.dataset.theme = state.theme;

function openPanel(tabName = 'info') {
  switchTab(tabName);
  panel.classList.add('open');
  document.body.classList.add('panel-open');
  if (window.innerWidth <= 768) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
  }
}

function closePanel() {
  panel.classList.remove('open');
  document.body.classList.remove('panel-open');
  overlay.classList.remove('open');
  panel.style.transform = '';
}

function togglePanel(tabName) {
  if (panel.classList.contains('open') && currentTab === tabName) {
    closePanel();
  } else {
    openPanel(tabName);
  }
}

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.panel-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  const info = $('tabInfo');
  const bms = $('tabBookmarks');
  if (tabName === 'info') {
    info.classList.add('active');
    bms.classList.remove('active');
  } else {
    info.classList.remove('active');
    bms.classList.add('active');
    renderBookmarks();
  }
}

panelClose.addEventListener('click', closePanel);
overlay.addEventListener('click', closePanel);

document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Swipe-to-dismiss bottom sheet (mobile) — velocity aware, with flick-to-close
let isDragging = false, startY = 0, lastY = 0, lastT = 0, velocity = 0;
function dragStart(e) {
  isDragging = true;
  startY = lastY = e.touches[0].clientY;
  lastT = Date.now();
  velocity = 0;
  panel.style.transition = 'none';
}
function dragMove(e) {
  if (!isDragging) return;
  const y = e.touches[0].clientY;
  const now = Date.now();
  if (now > lastT) velocity = (y - lastY) / (now - lastT);
  lastY = y; lastT = now;
  let dy = y - startY;
  if (dy < 0) dy = 0;                 // can't drag above the open position
  panel.style.transform = `translateY(${dy}px)`;
}
function dragEnd() {
  if (!isDragging) return;
  isDragging = false;
  panel.style.transition = '';
  const dy = lastY - startY;
  panel.style.transform = '';
  if (dy > 110 || velocity > 0.55) closePanel();  // distance OR fast flick
}
if (panelHandle) {
  panelHandle.addEventListener('touchstart', dragStart, { passive: true });
  panel.addEventListener('touchmove', dragMove, { passive: true });
  panel.addEventListener('touchend', dragEnd);
  panel.addEventListener('touchcancel', dragEnd);
}

window.addEventListener('resize', () => {
  panel.style.transform = '';
});

// Tap a toast to dismiss it immediately
$('toast').addEventListener('click', hideToast);

function showToast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  void t.offsetWidth;            // force reflow so the enter transition plays
  t.classList.add('show');
  clearTimeout(t._timer);
  clearTimeout(t._hideTimer);
  t._timer = setTimeout(hideToast, 2800);
}

function hideToast() {
  const t = $('toast');
  if (t.hidden) return;
  clearTimeout(t._timer);
  t.classList.remove('show');
  t._hideTimer = setTimeout(() => { t.hidden = true; }, 340);
}

function fmtCoord(n, pos, neg) {
  const d = Math.abs(n);
  return `${d.toFixed(4)}° ${n >= 0 ? pos : neg}`;
}

function fmtCoords(lng, lat) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  children.flat().forEach((c) => e.append(c.nodeType ? c : document.createTextNode(c)));
  return e;
}

// ===== Loading overlay =====
const loadingOverlay = el('div', { class: 'loading-overlay' },
  el('div', { class: 'loading-logo' }, (() => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.innerHTML = '<path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12c0-4.42-3.58-8-8-8z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10" r="3" fill="currentColor"/>';
    return s;
  })()),
  el('div', { class: 'loading-text' }, 'Загружаем карту…'),
  el('div', { class: 'loading-dots' }, el('span'), el('span'), el('span'))
);
document.body.appendChild(loadingOverlay);
loadingOverlay.id = 'loadingOverlay';

// ===== Map click =====
function onMapClick(e) {
  const coords = e.get('coords'); // [lat, lng]
  if (e.get('shiftKey')) {
    state.measureMode = true;
    document.body.classList.add('measuring');
    handleMeasureClick(coords[0], coords[1]);
    return;
  }
  if (state.measureMode) {
    handleMeasureClick(coords[0], coords[1]);
    return;
  }
  loadPlace(coords[1], coords[0], true);
}

function onMapMove(e) {
  const coords = e.get('coords');
  $('coordPill').textContent = `${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}`;
  const lat = coords[0];
  const lng = coords[1];
  const ck = cacheKey(lng, lat, 'elev');
  const cached = apiCache.get(ck);
  if (cached !== undefined) {
    $('elevPill').textContent = cached !== null ? cached + ' м' : '';
    clearTimeout(mouseElevTimer);
    return;
  }
  const now = Date.now();
  if (now - lastElevFetch < 600) return;
  lastElevFetch = now;
  clearTimeout(mouseElevTimer);
  mouseElevTimer = setTimeout(() => {
    fetchElevation(lat, lng).then(d => {
      if (d !== null && d !== undefined) $('elevPill').textContent = d + ' м';
    });
  }, 150);
}

// ===== API cache =====
const apiCache = new Map();
function cacheKey(lng, lat, type) {
  const prec = type === 'addr' ? 5 : type === 'weather' ? 3 : 4;
  return `${type}:${lat.toFixed(prec)},${lng.toFixed(prec)}`;
}

function fetchWithTimeout(url, timeoutMs = 5000, options = {}) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
  ]);
}

async function fetchElevation(lat, lng) {
  const ck = cacheKey(lng, lat, 'elev');
  let d = apiCache.get(ck);
  if (d !== undefined) return d;
  try {
    const res = await fetchWithTimeout(`https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`, 4000, { referrer: '' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    d = data.results && data.results[0] ? Math.round(data.results[0].elevation) : null;
  } catch (err) {
    try {
      const res2 = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, 4000, { referrer: '' });
      if (!res2.ok) throw new Error('HTTP ' + res2.status);
      const data2 = await res2.json();
      d = data2.elevation && data2.elevation[0] ? Math.round(data2.elevation[0]) : null;
    } catch (err2) { d = null; }
  }
  apiCache.set(ck, d);
  return d;
}

// ===== Yandex Geocoder REST API (JSONP to bypass CORS) =====
function yandexGeocodeJSONP(lng, lat, apikey) {
  return new Promise((resolve, reject) => {
    const callbackName = 'ym_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    const script = document.createElement('script');
    script.referrerPolicy = 'no-referrer';
    script.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Timeout')); }, 6000);
    function cleanup() {
      clearTimeout(timeout);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[callbackName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Script error')); };
    script.src = `https://geocode-maps.yandex.ru/1.x/?format=json&geocode=${lng},${lat}&apikey=${encodeURIComponent(apikey)}&callback=${callbackName}&lang=ru_RU&results=1`;
    document.head.appendChild(script);
  });
}

function yandexSearchJSONP(query, apikey) {
  return new Promise((resolve, reject) => {
    const callbackName = 'ym_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    const script = document.createElement('script');
    script.referrerPolicy = 'no-referrer';
    script.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Timeout')); }, 6000);
    function cleanup() {
      clearTimeout(timeout);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[callbackName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Script error')); };
    script.src = `https://geocode-maps.yandex.ru/1.x/?format=json&geocode=${encodeURIComponent(query)}&apikey=${encodeURIComponent(apikey)}&callback=${callbackName}&lang=ru_RU&results=7`;
    document.head.appendChild(script);
  });
}

function parseYandexAddress(data) {
  try {
    const geo = data.response.GeoObjectCollection.featureMember[0].GeoObject;
    const meta = geo.metaDataProperty.GeocoderMetaData;
    const addr = meta.Address;
    const comps = addr.Components || [];
    const find = (k) => comps.find(c => c.kind === k)?.name || '';
    const street = find('street') || find('district') || find('locality') || '';
    const house = find('house');
    const city = find('locality') || find('area') || find('province') || '';
    const country = find('country');
    const display = addr.formatted || meta.text || '';
    return { street, house, city, country, display, lat: geo.Point.pos.split(' ')[1], lon: geo.Point.pos.split(' ')[0] };
  } catch (e) { return null; }
}

function parseYandexSearchResults(data) {
  try {
    const members = data.response.GeoObjectCollection.featureMember;
    return members.map(m => {
      const geo = m.GeoObject;
      const meta = geo.metaDataProperty.GeocoderMetaData;
      const addr = meta.Address;
      const pos = geo.Point.pos.split(' ');
      return {
        name: geo.name,
        display_name: meta.text,
        lat: parseFloat(pos[1]),
        lon: parseFloat(pos[0]),
        class: meta.kind
      };
    });
  } catch (e) { return []; }
}

// ===== Current-point pin =====
function placeCurrentMarker(lat, lng) {
  if (clickPlacemark) map.geoObjects.remove(clickPlacemark);
  clickPlacemark = new ymaps.Placemark([lat, lng], {}, {
    iconLayout: pinLayout,
    iconShape: { type: 'Rectangle', coordinates: [[-12, -44], [12, 2]] }
  });
  map.geoObjects.add(clickPlacemark);
}

// ===== Place info loader =====
async function loadPlace(lng, lat, fly = false, marker = true) {
  state.currentPlace = { lng, lat };
  if (marker) placeCurrentMarker(lat, lng);
  if (fly) {
    map.setCenter([lat, lng], Math.max(map.getZoom(), 15), { duration: 1000 });
  }

  openPanel('info');
  $('panelEmpty').hidden = true;
  $('panelContent').hidden = false;

  $('statLat').textContent = fmtCoord(lat, 'с.ш.', 'ю.ш.');
  $('statLon').textContent = fmtCoord(lng, 'в.д.', 'з.д.');
  $('placeTitle').textContent = 'Загрузка…';
  $('placeSubtitle').textContent = fmtCoords(lng, lat);
  $('statElev').innerHTML = `<span class="loading-dot-inline"></span> <span class="unit">м</span>`;
  $('statAcc').textContent = '—';
  $('addrStreet').textContent = '—';
  $('addrCity').textContent = '—';
  $('addrCountry').textContent = '—';

  const ckElev = cacheKey(lng, lat, 'elev');
  const ckWeather = cacheKey(lng, lat, 'weather');

  const cachedElev = apiCache.get(ckElev);
  if (cachedElev !== undefined) {
    $('statElev').innerHTML = `${cachedElev} <span class="unit">м</span>`;
    $('elevPill').textContent = cachedElev + ' м';
  } else {
    $('statElev').innerHTML = `— <span class="unit">м</span>`;
  }
  fetchElevation(lat, lng).then(d => {
    if (d !== null && d !== undefined) {
      $('statElev').innerHTML = `${d} <span class="unit">м</span>`;
      $('elevPill').textContent = d + ' м';
    }
  });

  // Reverse geocode: Nominatim first (no errors in Firefox), Yandex as fallback
  let addrFound = false;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=ru&layer=address`, { referrer: '' });
    const data = await res.json();
    if (data && data.address) {
      const a = data.address;
      const street = a.road || a.pedestrian || a.path || '';
      const houseNum = a.house_number ? `, ${a.house_number}` : '';
      $('addrStreet').textContent = (street ? street : '—') + houseNum;
      $('addrCity').textContent = [a.suburb, a.city || a.town || a.village, a.state].filter((v, i, arr) => v && arr.indexOf(v) === i).join(', ') || '—';
      $('addrCountry').textContent = a.country || '—';
      $('placeTitle').textContent = (street ? street + (houseNum ? `, ${a.house_number}` : '') : a.city || a.town || a.village || a.country) || 'Точка';
      $('placeSubtitle').textContent = data.display_name.split(',').slice(0, 3).join(',');
      addrFound = true;
    }
  } catch (e) {}

  if (!addrFound) {
    try {
      const res = await ymaps.geocode([lat, lng], { kind: 'house', results: 1 });
      const obj = res.geoObjects.get(0);
      if (obj) {
        const meta = obj.properties.get('metaDataProperty.GeocoderMetaData');
        const addr = meta.Address;
        const comps = addr.Components || [];
        const find = (k) => comps.find(c => c.kind === k)?.name || '';
        const street = find('street');
        const house = find('house');
        const city = find('locality') || find('province') || find('area');
        const country = find('country');
        const houseNum = house ? `, ${house}` : '';
        $('addrStreet').textContent = (street ? street : '—') + houseNum;
        $('addrCity').textContent = city || '—';
        $('addrCountry').textContent = country || '—';
        $('placeTitle').textContent = (street ? street + (houseNum ? `, ${house}` : '') : city || addr.formatted || 'Точка') || 'Точка';
        $('placeSubtitle').textContent = addr.formatted || '';
        addrFound = true;
      }
    } catch (e) { /* Yandex geocoder may be blocked */ }
  }

  if (!addrFound) {
    $('placeTitle').textContent = 'Неизвестная точка';
    $('addrStreet').textContent = 'Адрес не найден';
  }

  // Weather
  let w = apiCache.get(ckWeather);
  if (!w) {
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto`, { referrer: '' });
      const data = await res.json();
      if (data.current) {
        w = {
          t: Math.round(data.current.temperature_2m),
          code: data.current.weather_code,
          wind: Math.round(data.current.wind_speed_10m),
          hum: data.current.relative_humidity_2m
        };
        apiCache.set(ckWeather, w);
      }
    } catch (err) { w = null; }
  }
  if (w) {
    $('wTemp').textContent = `${w.t > 0 ? '+' : ''}${w.t}°`;
    $('wCond').textContent = weatherCodeToText(w.code);
    $('wExtra').textContent = `Ветер ${w.wind} км/ч · Влажность ${w.hum}%`;
    $('wIcon').textContent = weatherCodeToEmoji(w.code);
  } else {
    $('wTemp').textContent = '—°';
    $('wCond').textContent = 'Нет данных';
    $('wExtra').textContent = '';
    $('wIcon').textContent = '';
  }

  // Approx accuracy by pixel
  const pxPerMeter = (Math.cos(lat * Math.PI / 180) * 156543.03) / Math.pow(2, map.getZoom());
  $('statAcc').textContent = `~${Math.round(50 / pxPerMeter)} м`;
}

function weatherCodeToText(code) {
  const map = {
    0: 'Ясно', 1: 'Преим. ясно', 2: 'Переменная облачность', 3: 'Пасмурно',
    45: 'Туман', 48: 'Изморозь',
    51: 'Лёгкая морось', 53: 'Морось', 55: 'Сильная морось',
    61: 'Слабый дождь', 63: 'Дождь', 65: 'Сильный дождь',
    71: 'Слабый снег', 73: 'Снег', 75: 'Сильный снег',
    77: 'Снежные зёрна',
    80: 'Слабый ливень', 81: 'Ливень', 82: 'Сильный ливень',
    85: 'Снегопад', 86: 'Сильный снегопад',
    95: 'Гроза', 96: 'Гроза с градом', 99: 'Сильная гроза'
  };
  return map[code] || '—';
}

function weatherCodeToEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '⛈️';
  if (code <= 86) return '🌨️';
  return '⚡';
}

// ===== Search =====
const searchInput = $('searchInput');
const searchBox = $('searchBox');
const searchResults = $('searchResults');
let searchTimer = null;
let selectedResult = -1;
let lastResults = [];
let searchSeq = 0;

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  searchBox.classList.toggle('has-value', !!searchInput.value);
  clearTimeout(searchTimer);
  if (q.length < 2) { searchSeq++; searchResults.classList.remove('active'); lastResults = []; selectedResult = -1; return; }
  searchTimer = setTimeout(() => doSearch(q), 200);
});

searchInput.addEventListener('focus', () => {
  if (lastResults.length) searchResults.classList.add('active');
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (selectedResult >= 0 && lastResults[selectedResult]) {
      pickResult(lastResults[selectedResult]);
    } else if (lastResults[0]) {
      pickResult(lastResults[0]);
    } else if (searchInput.value.trim()) {
      doSearch(searchInput.value.trim());
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (lastResults.length) { selectedResult = Math.min(selectedResult + 1, lastResults.length - 1); renderResults(); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (lastResults.length) { selectedResult = Math.max(selectedResult - 1, 0); renderResults(); }
  } else if (e.key === 'Escape') {
    searchResults.classList.remove('active');
  }
});

$('searchClear').addEventListener('click', () => {
  searchInput.value = '';
  searchBox.classList.remove('has-value');
  searchResults.classList.remove('active');
  searchSeq++;
  lastResults = [];
  selectedResult = -1;
  searchInput.focus();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) searchResults.classList.remove('active');
});

// Classify a Photon feature into our icon classes
function photonClass(p) {
  const t = p.type;
  if (t === 'street' || p.osm_key === 'highway') return 'street';
  if (t === 'house' || p.housenumber) return 'house';
  if (['city', 'town', 'village', 'hamlet', 'locality', 'district', 'county', 'state', 'region', 'country'].includes(t) || p.osm_key === 'place') return 'locality';
  return 'addr';
}

// Parse Photon (komoot) GeoJSON → unified result objects
function parsePhoton(data) {
  const feats = (data && data.features) || [];
  const out = [];
  for (const f of feats) {
    if (!f.geometry || !f.geometry.coordinates) continue;
    const p = f.properties || {};
    const c = f.geometry.coordinates; // [lon, lat]
    let name = p.name;
    if (!name) name = [p.street, p.housenumber].filter(Boolean).join(', ');
    if (!name) name = p.city || p.county || p.state || p.country || '—';
    const locality = p.city || p.town || p.village || p.locality;
    const parts = [];
    if (p.street && p.street !== name) parts.push(p.housenumber ? `${p.street}, ${p.housenumber}` : p.street);
    if (locality && locality !== name) parts.push(locality);
    if (p.district && p.district !== name && p.district !== locality) parts.push(p.district);
    if (p.county && p.county !== name && p.county !== locality) parts.push(p.county);
    if (p.state && p.state !== name) parts.push(p.state);
    if (p.country && p.country !== name) parts.push(p.country);
    out.push({
      name,
      display_name: parts.join(', ') || p.country || '',
      lat: c[1],
      lon: c[0],
      class: photonClass(p)
    });
  }
  return out;
}

function showSearchLoading() {
  searchResults.innerHTML = '<div class="search-loading"><span class="loading-dot-inline"></span> Поиск…</div>';
  searchResults.classList.add('active');
}

async function doSearch(q) {
  const seq = ++searchSeq;
  showSearchLoading();
  let results = [];
  const center = map.getCenter(); // [lat, lon] — bias results to the current view

  // 1) Photon — true type-ahead / prefix matching ("кинешм" → Кинешма)
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=default&limit=8&lat=${center[0]}&lon=${center[1]}`;
    const res = await fetchWithTimeout(url, 5000, { referrer: '' });
    if (res.ok) results = parsePhoton(await res.json());
  } catch (e) {}

  // 2) Yandex geocoder (JSONP) — strong on Russian addresses
  if (!results.length) {
    try {
      results = parseYandexSearchResults(await yandexSearchJSONP(q, YANDEX_GEOCODER_KEY));
    } catch (e) {}
  }

  // 3) Nominatim — last-resort fallback
  if (!results.length) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=7&addressdetails=1&accept-language=ru`, { referrer: '' });
      const data = await res.json();
      results = (data || []).map(r => ({
        name: r.display_name.split(',')[0],
        display_name: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        class: r.class === 'highway' ? 'street' : r.class === 'building' ? 'house' : r.class === 'place' ? 'locality' : 'addr'
      }));
    } catch (e) {}
  }

  if (seq !== searchSeq) return; // a newer query superseded this one
  lastResults = results;
  selectedResult = lastResults.length ? 0 : -1;
  renderResults();
}

function renderResults() {
  if (!lastResults.length) {
    searchResults.innerHTML = '<div class="search-empty">Ничего не найдено</div>';
    searchResults.classList.add('active');
    return;
  }
  searchResults.innerHTML = lastResults.map((r, i) => {
    const cls = r.class === 'street' || r.class === 'route' ? 'route' : r.class === 'house' || r.class === 'building' ? 'home' : r.class === 'locality' || r.class === 'province' ? 'place' : 'addr';
    const icon = cls === 'route' ? '🛣️' : cls === 'home' ? '🏢' : cls === 'place' ? '📍' : '📫';
    return `<div class="search-result ${i === selectedResult ? 'selected' : ''}" data-i="${i}">
      <div class="search-result-icon">${icon}</div>
      <div class="search-result-body">
        <div class="search-result-title">${escapeHTML(r.name)}</div>
        <div class="search-result-sub">${escapeHTML(r.display_name)}</div>
      </div>
      <div class="search-result-coords">${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}</div>
    </div>`;
  }).join('');
  searchResults.classList.add('active');
  searchResults.querySelectorAll('.search-result').forEach((node) => {
    node.addEventListener('click', () => pickResult(lastResults[+node.dataset.i]));
  });
}

function pickResult(r) {
  const lat = r.lat, lon = r.lon;
  searchInput.value = r.name;
  searchBox.classList.add('has-value');
  searchResults.classList.remove('active');
  const zoom = r.class === 'house' || r.class === 'building' ? 18 : r.class === 'street' ? 16 : 14;
  map.setCenter([lat, lon], zoom, { duration: 1000 });
  setTimeout(() => loadPlace(lon, lat), 600);
}

// ===== Layers menu =====
$('layersBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('layersMenu').hidden = !$('layersMenu').hidden;
});

document.querySelectorAll('.layer-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    const s = btn.dataset.style;
    state.currentStyle = s;
    map.setType(s);
    document.querySelectorAll('.layer-opt').forEach((b) => b.classList.toggle('active', b === btn));
    $('layersMenu').hidden = true;
    const name = btn.querySelector('span').textContent;
    showToast('Стиль: ' + name);
  });
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.layers-menu') && !e.target.closest('#layersBtn')) {
    $('layersMenu').hidden = true;
  }
});

// ===== Theme =====
$('themeBtn').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = state.theme;
  localStorage.setItem('atlas_theme', state.theme);
  $('themeIcon').innerHTML = state.theme === 'dark'
    ? '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
    : '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
});

// ===== Locate =====
function setUserPosition(lat, lon, accuracy = 0, source = 'gps') {
  if (userPlacemark) map.geoObjects.remove(userPlacemark);
  if (userAccuracyCircle) map.geoObjects.remove(userAccuracyCircle);
  userPlacemark = new ymaps.Placemark([lat, lon], {}, {
    iconLayout: geoLayout,
    iconShape: { type: 'Circle', coordinates: [0, 0], radius: 10 }
  });
  map.geoObjects.add(userPlacemark);
  if (accuracy > 0) {
    userAccuracyCircle = new ymaps.Circle([[lat, lon], accuracy], {}, {
      fillColor: 'rgba(34,211,238,0.12)',
      strokeColor: 'rgba(34,211,238,0.4)',
      strokeWidth: 1
    });
    map.geoObjects.add(userAccuracyCircle);
  }
  map.setCenter([lat, lon], 16, { duration: 1000 });
  if (source === 'gps') showToast(`Точность: ${Math.round(accuracy)} м`);
  else showToast('Местоположение по IP (приблизительно)');
  loadPlace(lon, lat, false, false);
}

async function fallbackIpLocation() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://ipapi.co/json/', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('ipapi failed');
    const data = await res.json();
    if (data.latitude && data.longitude) {
      setUserPosition(data.latitude, data.longitude, 5000, 'ip');
      return true;
    }
  } catch (e) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch('https://ipinfo.io/json', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('ipinfo failed');
      const data = await res.json();
      if (data.loc) {
        const [lat, lon] = data.loc.split(',').map(Number);
        setUserPosition(lat, lon, 5000, 'ip');
        return true;
      }
    } catch (e2) {}
  }
  return false;
}

function requestGeolocation() {
  if (!navigator.geolocation) {
    fallbackIpLocation().then(ok => {
      if (!ok) showToast('Геолокация недоступна', 'error');
    });
    return;
  }

  const geoTimeout = setTimeout(() => {
    showToast('GPS медленно отвечает, пробую по IP…');
    fallbackIpLocation();
  }, 10000);

  navigator.geolocation.getCurrentPosition((pos) => {
    clearTimeout(geoTimeout);
    const { latitude, longitude, accuracy } = pos.coords;
    setUserPosition(latitude, longitude, accuracy, 'gps');
  }, (err) => {
    clearTimeout(geoTimeout);
    let msg = 'Не удалось определить местоположение';
    if (err.code === 1) msg = 'Нет разрешения на геолокацию. Включите доступ в настройках браузера';
    else if (err.code === 2) msg = 'GPS выключен или сигнал недоступен';
    else if (err.code === 3) msg = 'Превышен таймаут GPS';
    showToast(msg, 'error');
    fallbackIpLocation().then(ok => {
      if (!ok) showToast('IP-геолокация тоже недоступна', 'error');
    });
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

$('locateBtn').addEventListener('click', requestGeolocation);

// Auto-locate on first visit if permission already granted
if (navigator.geolocation && navigator.permissions) {
  navigator.permissions.query({ name: 'geolocation' }).then(result => {
    if (result.state === 'granted') requestGeolocation();
  }).catch(() => {});
}

// ===== Bookmarks =====
function restoreBookmarks() {
  const raw = JSON.parse(localStorage.getItem('atlas_bm') || '[]');
  state.bookmarks = raw.map(b => ({ ...b, placemark: null }));
  state.bookmarks.forEach(bm => createBookmarkPlacemark(bm));
  updateBookmarkCount();
}

function createBookmarkPlacemark(bm) {
  const pm = new ymaps.Placemark([bm.lat, bm.lon], {
    hintContent: bm.name
  }, {
    iconLayout: bookmarkLayout,
    iconShape: { type: 'Rectangle', coordinates: [[-17, -38], [17, 2]] }
  });
  pm.events.add('click', () => {
    map.setCenter([bm.lat, bm.lon], 15, { duration: 1000 });
    loadPlace(bm.lon, bm.lat, false, false);
  });
  map.geoObjects.add(pm);
  bm.placemark = pm;
}

function saveBookmarks() {
  const serializable = state.bookmarks.map(b => ({ name: b.name, lat: b.lat, lon: b.lon }));
  localStorage.setItem('atlas_bm', JSON.stringify(serializable));
  updateBookmarkCount();
  renderBookmarks();
}

function updateBookmarkCount() {
  const badge = $('bmCount');
  if (badge) badge.textContent = state.bookmarks.length;
}

function renderBookmarks() {
  const list = $('bmList');
  if (!state.bookmarks.length) {
    list.innerHTML = '<div class="bm-empty">Пока пусто. Откройте место и нажмите «В закладки».</div>';
    return;
  }
  list.innerHTML = '';
  state.bookmarks.forEach((bm, i) => {
    const item = el('div', { class: 'bm-item' },
      el('div', { class: 'bm-color' }),
      el('div', { class: 'bm-body' },
        el('div', { class: 'bm-name' }, bm.name),
        el('div', { class: 'bm-coords' }, `${bm.lat.toFixed(4)}, ${bm.lon.toFixed(4)}`)
      ),
      el('button', { class: 'bm-remove', title: 'Удалить', onclick: (e) => {
        e.stopPropagation();
        if (bm.placemark) map.geoObjects.remove(bm.placemark);
        state.bookmarks.splice(i, 1);
        saveBookmarks();
      } }, (() => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
        s.innerHTML = '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
        return s;
      })())
    );
    item.addEventListener('click', () => {
      map.setCenter([bm.lat, bm.lon], 15, { duration: 1000 });
      loadPlace(bm.lon, bm.lat, false, false);
      switchTab('info');
    });
    list.appendChild(item);
  });
}

$('saveMark').addEventListener('click', () => {
  if (!state.currentPlace) return;
  const p = state.currentPlace;
  const name = $('placeTitle').textContent || 'Точка';
  const bm = { name, lat: p.lat, lon: p.lng };
  createBookmarkPlacemark(bm);
  state.bookmarks.push(bm);
  saveBookmarks();
  showToast('Сохранено в закладки');
});

$('bmBtn').addEventListener('click', () => {
  togglePanel('bookmarks');
});

// ===== Zoom controls =====
$('zoomIn').addEventListener('click', () => map.setZoom(map.getZoom() + 1, { duration: 300 }));
$('zoomOut').addEventListener('click', () => map.setZoom(map.getZoom() - 1, { duration: 300 }));
$('compassBtn').addEventListener('click', () => map.setCenter([55.7558, 37.6173], 11, { duration: 1000 }));

// ===== Copy / Share =====
$('copyCoords').addEventListener('click', () => {
  if (!state.currentPlace) return;
  const t = `${state.currentPlace.lat.toFixed(6)}, ${state.currentPlace.lng.toFixed(6)}`;
  navigator.clipboard.writeText(t).then(() => showToast('Координаты скопированы'));
});
$('copyAddr').addEventListener('click', () => {
  const addr = `${$('addrStreet').textContent}, ${$('addrCity').textContent}`;
  navigator.clipboard.writeText(addr).then(() => showToast('Адрес скопирован'));
});
$('shareBtn').addEventListener('click', async () => {
  if (!state.currentPlace) return;
  const url = `${location.origin}${location.pathname}#${map.getZoom().toFixed(2)}/${state.currentPlace.lat.toFixed(5)}/${state.currentPlace.lng.toFixed(5)}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Atlas', text: $('placeTitle').textContent, url }); } catch {}
  } else {
    navigator.clipboard.writeText(url).then(() => showToast('Ссылка скопирована'));
  }
});

// ===== Measure =====
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function handleMeasureClick(lat, lng) {
  measurePoints.push([lat, lng]);
  const pm = new ymaps.Placemark([lat, lng], {}, {
    preset: 'islands#circleDotIcon',
    iconColor: '#7c5cff'
  });
  measurePointPlacemarks.push(pm);
  map.geoObjects.add(pm);

  if (measurePoints.length >= 2) {
    if (measureLine) map.geoObjects.remove(measureLine);
    let total = 0;
    for (let i = 1; i < measurePoints.length; i++) {
      total += haversine(
        { lat: measurePoints[i - 1][0], lng: measurePoints[i - 1][1] },
        { lat: measurePoints[i][0], lng: measurePoints[i][1] }
      );
    }
    measureLine = new ymaps.Polyline(measurePoints, {}, {
      strokeColor: '#7c5cff',
      strokeWidth: 4,
      strokeStyle: '1 2'
    });
    map.geoObjects.add(measureLine);
    const km = total / 1000;
    const label = km >= 1 ? `${km.toFixed(2)} км` : `${Math.round(total)} м`;
    showToast(`Расстояние: ${label}`);
  }

  if (measurePoints.length >= 3) {
    let area = 0;
    for (let i = 0; i < measurePoints.length; i++) {
      const [x1, y1] = measurePoints[i];
      const [x2, y2] = measurePoints[(i + 1) % measurePoints.length];
      area += (x1 * y2 - x2 * y1);
    }
    area = Math.abs(area) / 2 * (111319.5 ** 2) * Math.cos(measurePoints[0][0] * Math.PI / 180) / 1e6;
    if (area > 0.01) showToast(`Площадь: ${area.toFixed(3)} км²`);
  }
}

function clearMeasure() {
  state.measureMode = false;
  document.body.classList.remove('measuring');
  measurePoints = [];
  measurePointPlacemarks.forEach(pm => map.geoObjects.remove(pm));
  measurePointPlacemarks = [];
  if (measureLine) { map.geoObjects.remove(measureLine); measureLine = null; }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePanel(); clearMeasure(); } });

// ===== Map hash sync =====
function syncHash() {
  const c = map.getCenter();
  const z = map.getZoom().toFixed(2);
  history.replaceState(null, '', `#${z}/${c[0].toFixed(5)}/${c[1].toFixed(5)}`);
}

function loadHash() {
  const m = location.hash.match(/^#([\d.]+)\/([\d.-]+)\/([\d.-]+)$/);
  if (m) {
    map.setCenter([parseFloat(m[2]), parseFloat(m[3])], parseFloat(m[1]), { duration: 0 });
    setTimeout(() => loadPlace(parseFloat(m[3]), parseFloat(m[2])), 800);
  }
}

function initUI() {
  // All UI listeners are attached globally above; this is a hook for post-init if needed.
}

console.log('%c🗺️ Atlas Yandex Maps', 'background:linear-gradient(135deg,#7c5cff,#22d3ee);color:#fff;padding:4px 10px;border-radius:6px;font-weight:700');
