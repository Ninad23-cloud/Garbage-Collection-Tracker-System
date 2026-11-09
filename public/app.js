/* Pune Waste Routes: the page.
   All routing is done by the C++ backend (GET /api/towns once, GET /api/plan on every change).
   This file draws the result on a real street map (Leaflet + OpenStreetMap tiles), snaps each route to actual
   roads with the public OSRM routing service when it can reach it, and replays the day.

   Sections: setup, server, map, markers, list, panels (summary, trucks, compare, alerts), popup,
             routes and road geometry, day replay, loop, events, boot. */
(() => {
'use strict';

/* ---------- setup ---------- */
const API = location.protocol === 'file:' ? 'http://localhost:8080' : '';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SPEEDS = [30, 60, 120, 240, 480];   /* simulated minutes per real second */
const SPEED_LABEL = ['½ h/s', '1 h/s', '2 h/s', '4 h/s', '8 h/s'];
const TIER_COL = ['var(--tg)', 'var(--ta)', 'var(--tr)'];
const TIER_NAME = ['On track', 'Approaching', 'Critical'];
let START_MIN = 360;                      /* the day starts at 06:00 (the server confirms this) */
const clock = (min) => {
  const m = Math.round(START_MIN + min);
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
const fmtDur = (min) => { const m = Math.round(min); return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; };
const fmtH = (h) => h.toFixed(1) + ' h';
const fmtInr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const fmtRun = (ms) => (ms * 1000 < 1000 ? (ms * 1000).toFixed(1) + ' µs' : ms.toFixed(2) + ' ms');
const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

const CHK = '<svg class="chk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7.2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const YARD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="currentColor"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';
const REPLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2.5L7.5 6 12 9.5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" fill="currentColor"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ARROW = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 10.5L6 1.2l4.5 9.3L6 8.2z" fill="currentColor" stroke="var(--panel)" stroke-width="1.1" stroke-linejoin="round"/></svg>';

const mapwrap = $('mapwrap'), popupEl = $('popup');

let TOWNS = [], ALGOS = [], N = 0;
let CONST = { speedKmh: 38, stopMinutes: 10, fuelLPerKm: 0.35, dieselInrPerL: 92, co2KgPerL: 2.68 };

const S = { seed: 1, thr: 50, crit: 80, warn: 60, cap: 10, fleet: 6, shift: 10, balance: false, algo: 'gk-lc',
            show: 'all', sort: 'fill', q: '', tab: 'towns', sel: -1, focus: -1, pop: null, announce: false };
let view = null;                  /* the latest plan from the server */
let info = {};                    /* town -> { k: truck, s: stop number, arrive, leave } in minutes after 06:00 */
let unsMap = {};                  /* town -> reason, for towns that could not be served */
let drain = {};                   /* town -> 0..1, how emptied it is during the replay */
const sim = { t: 0, total: 0, playing: false, speed: 1, trucks: [] };
let itemEls = [], R = [];

/* ---------- the C++ server ---------- */
function getJSON(path) {
  return fetch(API + path).then(
    (r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }),
    () => { const e = new Error('Network error'); e.network = true; throw e; }
  );
}
const planQuery = () => 'seed=' + S.seed + '&thr=' + S.thr + '&cap=' + S.cap + '&algo=' + encodeURIComponent(S.algo) +
  '&crit=' + S.crit + '&warn=' + S.warn + '&fleet=' + S.fleet + '&shift=' + S.shift + '&balance=' + (S.balance ? 1 : 0);

function setStatus(kind, text, title) {
  const s = $('status');
  s.className = 'engine ' + kind;
  s.querySelector('span').textContent = text;
  s.title = title || '';
}

let retryTimer = 0;
function onError(err) {
  if (err && err.network) {
    setStatus('bad', 'Offline', 'The C++ server cannot be reached');
    $('offline').hidden = false;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => (N ? schedulePlan() : boot()), 3000);
  } else {
    setStatus('bad', 'Error', err && err.message);
    toast(err && err.message ? err.message : 'Something went wrong');
    if (window.console) console.error(err);
  }
}

let busy = false, again = false, firstPlan = true;
function schedulePlan() {
  if (!N) return;
  if (busy) { again = true; return; }
  busy = true;
  const t0 = performance.now();
  getJSON('/api/plan?' + planQuery()).then((d) => {
    busy = false;
    $('offline').hidden = true;
    applyPlan(d, performance.now() - t0);
    if (again) { again = false; schedulePlan(); }
  }).catch((e) => { busy = false; again = false; onError(e); });
}

/* ---------- the map ---------- */
let map, tileLayer, cluster, markers = [], tileFailed = false;
const theme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
const TILES = {
  light: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
           opt: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'} },
  dark: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          opt: { subdomains: 'abcd', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' } }
};

function setTiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  const t = TILES[theme()];
  tileLayer = L.tileLayer(t.url, t.opt).addTo(map);
  tileLayer.on('tileerror', () => {
    if (tileFailed) return;
    tileFailed = true;
    toast('Map tiles could not load (offline?). Towns and routes still work.');
  });
}

function initMap() {
  map = L.map('lmap', { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 7, maxZoom: 17,
                        zoomAnimation: !REDUCED, markerZoomAnimation: !REDUCED, fadeAnimation: !REDUCED });
  const b = L.latLngBounds(TOWNS.map((t) => [t.lat, t.lon]));
  map.fitBounds(b, fitOpts());
  setTiles();
  cluster = L.markerClusterGroup({
    maxClusterRadius: 40, disableClusteringAtZoom: 11, showCoverageOnHover: false, spiderfyOnMaxZoom: false,
    animate: !REDUCED,
    iconCreateFunction: (c) => {
      const kids = c.getAllChildMarkers();
      let w = 0;
      kids.forEach((m) => { w = Math.max(w, view ? view.tiers[m.options.tid] : 0); });
      return L.divIcon({ html: '<div class="cl t' + w + '" title="' + kids.length + ' towns, zoom in to separate them"><b>' + kids.length + '</b></div>', className: 'clw', iconSize: [42, 42] });
    }
  });
  map.addLayer(cluster);
  map.on('zoomend', onZoom);
  map.on('move zoom', positionPopup);
  map.on('click', () => { if (S.sel >= 0 || S.pop) select(-1); });
  onZoom();
}

function fitOpts(animate) {
  const narrow = mapwrap.clientWidth < 560;
  return { paddingTopLeft: [narrow ? 20 : 40, 70], paddingBottomRight: [narrow ? 20 : 70, narrow ? 150 : 200], animate: !!animate && !REDUCED, duration: 0.9 };
}
function fitAll(animate) { map.fitBounds(L.latLngBounds(TOWNS.map((t) => [t.lat, t.lon])), fitOpts(animate)); }

function onZoom() {
  const z = map.getZoom(), el = $('lmap');
  el.style.setProperty('--m', clamp(0.62 + (z - 9) * 0.14, 0.62, 1.06).toFixed(3));
  el.classList.toggle('compact', z < 10);
  el.classList.toggle('zoomed', z >= 11);
  el.style.setProperty('--rw', clamp(2.2 + (z - 8) * 0.4, 2.2, 5).toFixed(2) + 'px');
  refreshLines();
}

/* ---------- town markers ---------- */
function initials(name) {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).replace(/^./, (c0) => c0.toUpperCase());
}
const isUnserved = (i) => Object.prototype.hasOwnProperty.call(unsMap, i);

/* Paints one marker element from the current state. Used when the marker is created and whenever state changes,
   so a marker that was hidden inside a cluster always comes back looking right. */
function paintEl(el, i) {
  const t = TOWNS[i];
  if (t.depot || !view) return;
  const inf = info[i], fill = view.fills[i], p = drain[i] || 0, shown = Math.round(fill * (1 - p)), done = !!inf && p >= 1;
  const tier = view.tiers[i], uns = isUnserved(i), cl = el.classList;
  el.style.setProperty('--c', TIER_COL[tier]);
  el.style.setProperty('--tc', inf ? 'var(--t' + (inf.k % 6) + ')' : 'var(--muted2)');
  el.style.setProperty('--fill', shown);
  cl.toggle('on', !!inf);
  cl.toggle('off', !inf && !uns);
  cl.toggle('unserved', uns);
  cl.toggle('done', done);
  cl.remove('t0', 't1', 't2');
  cl.add('t' + tier);
  cl.toggle('sel', S.sel === i);
  cl.toggle('dim', S.focus >= 0 && !(inf && inf.k === S.focus));
  setText(el.querySelector('.mk-pill b'), shown + '%');
  setText(el.querySelector('.mk-ord'), inf ? String(inf.s) : uns ? '!' : '');
}

const TownIcon = L.DivIcon.extend({
  createIcon(old) {
    const el = L.DivIcon.prototype.createIcon.call(this, old);
    paintEl(el, this.options.tid);
    return el;
  }
});

function buildMarkers() {
  markers = [];
  TOWNS.forEach((t, i) => {
    const inner = t.depot
      ? '<i class="radar"></i><i class="radar r2"></i><div class="mk-badge">' + YARD + '</div>'
      : '<div class="mk-badge"><span>' + esc(initials(t.name)) + '</span>' + CHK + '</div><div class="mk-ord"></div><div class="mk-pill"><i></i><b>0%</b></div>';
    const icon = new TownIcon({
      className: 'mk pop off' + (t.depot ? ' depot' : ''), iconSize: [0, 0], iconAnchor: [0, 0], tid: i,
      html: '<div class="mk-in" style="--i:' + i + '">' + inner + '<div class="mk-name">' + esc(t.name) + '</div></div>'
    });
    const m = L.marker([t.lat, t.lon], { icon, tid: i, title: t.name, alt: t.name, zIndexOffset: t.depot ? 400 : 0 });
    m.on('click', () => select(i));
    m.on('mouseover', () => hover(i, true));
    m.on('mouseout', () => hover(i, false));
    markers[i] = m;
    if (t.depot) m.addTo(map); else cluster.addLayer(m);
  });
}

function paintMarker(i) {
  const m = markers[i];
  if (!m) return;
  if (view && !TOWNS[i].depot) m.setZIndexOffset(view.tiers[i] * 100 + (info[i] ? 50 : 0));
  if (m._icon) paintEl(m._icon, i);
}
function hover(i, on) {
  if (markers[i] && markers[i]._icon) markers[i]._icon.classList.toggle('hov', on);
  if (itemEls[i]) itemEls[i].classList.toggle('hov', on);
}
function burst(i) {
  const el = markers[i] && markers[i]._icon;
  if (!el) return;
  el.classList.remove('burst'); void el.offsetWidth; el.classList.add('burst');
  setTimeout(() => el.classList.remove('burst'), 950);
}

/* ---------- the town list ---------- */
function buildItems() {
  const ul = $('list');
  ul.innerHTML = '';
  itemEls = [];
  TOWNS.forEach((t, i) => {
    if (t.depot) { itemEls[i] = null; return; }
    const li = document.createElement('li');
    li.className = 'town off';
    li.dataset.i = i; li.tabIndex = 0; li.setAttribute('role', 'button'); li.title = t.name + ', ' + t.note;
    li.innerHTML = '<div class="ava"><span>' + esc(initials(t.name)) + '</span>' + CHK + '</div>' +
      '<div class="tt"><div class="name">' + esc(t.name) + '</div><div class="meta"><span>' + t.bins + ' bins</span><i class="sep">•</i><span class="st"></span></div></div>' +
      '<div class="rc"><b class="pct">0%</b><span class="tchip">–</span></div>';
    li.addEventListener('click', () => select(i, { scroll: false }));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i, { scroll: false }); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const vis = itemEls.filter((x) => x && !x.hidden), at = vis.indexOf(li), nx = vis[at + (e.key === 'ArrowDown' ? 1 : -1)];
        if (nx) { nx.focus(); select(+nx.dataset.i, { scroll: false }); }
      }
    });
    li.addEventListener('mouseenter', () => hover(i, true));
    li.addEventListener('mouseleave', () => hover(i, false));
    ul.appendChild(li);
    itemEls[i] = li;
  });
  if (!REDUCED) {
    itemEls.filter(Boolean).forEach((li, n) => li.animate(
      [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }],
      { duration: 520, delay: 250 + n * 30, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
    ));
  }
}

const dist2yard = (t) => map.distance([t.lat, t.lon], [TOWNS[0].lat, TOWNS[0].lon]);
const sorters = {
  fill: (a, b) => view.fills[b.id] - view.fills[a.id],
  route: (a, b) => {
    const ia = info[a.id], ib = info[b.id];
    if (ia && ib) return ia.k - ib.k || ia.s - ib.s;
    if (ia) return -1;
    if (ib) return 1;
    return view.fills[b.id] - view.fills[a.id];
  },
  yard: (a, b) => dist2yard(a) - dist2yard(b),
  bins: (a, b) => b.bins - a.bins,
  name: (a, b) => a.name.localeCompare(b.name)
};

function renderList() {
  if (!view) return;
  const q = S.q.trim().toLowerCase();
  const arr = TOWNS.filter((t) => {
    if (t.depot) return false;
    if (q && !(t.name.toLowerCase().includes(q) || t.note.toLowerCase().includes(q))) return false;
    const inf = info[t.id], tier = view.tiers[t.id];
    return S.show === 'all' || (S.show === 'collected' && inf) || (S.show === 'skipped' && !inf) ||
      (S.show === 'red' && tier === 2) || (S.show === 'amber' && tier === 1) || (S.show === 'unserved' && isUnserved(t.id));
  }).sort(sorters[S.sort]);

  const ul = $('list'), before = new Map();
  itemEls.forEach((el, i) => { if (el && !el.hidden) before.set(i, el.getBoundingClientRect().top); });
  const show = new Set(arr.map((t) => t.id));
  let ref = ul.firstElementChild;
  arr.forEach((t) => {
    const el = itemEls[t.id];
    if (el === ref) ref = ref.nextElementSibling; else ul.insertBefore(el, ref);
  });
  itemEls.forEach((el, i) => {
    if (!el) return;
    const vis = show.has(i), was = !el.hidden;
    el.hidden = !vis;
    if (vis && !was && !REDUCED) el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'ease-out' });
  });
  if (!REDUCED) {
    arr.forEach((t) => {
      const el = itemEls[t.id], b = before.get(t.id);
      if (b == null) return;
      const dy = b - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) el.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }
  $('listEmpty').hidden = arr.length > 0;
}

function stateText(i) {
  const inf = info[i];
  if (isUnserved(i)) return 'Not served · ' + (unsMap[i].indexOf('fleet') === 0 ? 'fleet limit' : 'too big for a truck');
  if (!inf) return 'Not collected · under ' + S.thr + '%';
  return (drain[i] || 0) >= 1 ? 'Emptied ' + clock(inf.leave) : 'Truck ' + (inf.k + 1) + ' · ETA ' + clock(inf.arrive);
}

function paintItem(i) {
  const li = itemEls[i];
  if (!li || !view) return;
  const inf = info[i], fill = view.fills[i], p = drain[i] || 0, shown = Math.round(fill * (1 - p)), done = !!inf && p >= 1, tier = view.tiers[i];
  li.style.setProperty('--c', TIER_COL[tier]);
  li.style.setProperty('--tc', inf ? 'var(--t' + (inf.k % 6) + ')' : 'var(--muted2)');
  li.style.setProperty('--fill', shown);
  li.classList.toggle('on', !!inf);
  li.classList.toggle('off', !inf);
  li.classList.toggle('done', done);
  li.classList.remove('t0', 't1', 't2');
  li.classList.add('t' + tier);
  li.classList.toggle('sel', S.sel === i);
  setText(li.querySelector('.st'), stateText(i));
  setText(li.querySelector('.pct'), shown + '%');
  setText(li.querySelector('.tchip'), inf ? String(inf.k + 1) : isUnserved(i) ? '!' : '–');
}
function paintTown(i) { paintMarker(i); paintItem(i); }

/* ---------- sidebar: summary numbers ---------- */
function countTo(el, to, dec) {
  const from = parseFloat(el.dataset.v || '0');
  el.dataset.v = to;
  cancelAnimationFrame(el._r);
  const out = (v) => (dec ? v.toFixed(dec) : Math.round(v).toLocaleString('en-IN'));
  if (REDUCED || Math.abs(from - to) < 1e-9) { el.textContent = out(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = ease(clamp((now - t0) / 650, 0, 1));
    el.textContent = out(lerp(from, to, k));
    if (k < 1) el._r = requestAnimationFrame(step);
  };
  el._r = requestAnimationFrame(step);
}
function sub(id, text, cls) { const el = $(id); setText(el, text); el.className = cls || ''; }

function renderKpis() {
  const r = view.cur, base = view.baseline, n = N - 1;
  countTo($('kDist'), r.km, 0);
  countTo($('kFuel'), r.fuelL, 0);
  countTo($('kCo2'), r.co2AvoidedKg, 0);
  countTo($('kTowns'), r.served, 0);
  countTo($('kTrucks'), r.trucks, 0);
  countTo($('kUtil'), r.util, 0);
  $('kTownsOf').textContent = 'of ' + n;
  $('kTrucksOf').textContent = 'of ' + S.fleet;

  sub('kDistSub', r.served ? (r.savedKm > 0 ? '−' + r.savedPct.toFixed(0) + '% vs one truck per town' : 'same as one truck per town') : 'nothing to collect', r.savedKm > 0 ? 'good' : '');
  sub('kFuelSub', fmtInr(r.fuelCost) + ' at ₹' + CONST.dieselInrPerL + '/L');
  sub('kCo2Sub', 'emits ' + Math.round(r.co2Kg).toLocaleString('en-IN') + ' kg CO₂', '');
  updateTownsSub();
  sub('kTrucksSub', r.trucks >= 2 ? 'longest drives ' + r.longestShare.toFixed(0) + '% of km' : r.trucks ? 'single route' : 'none leave the yard', r.trucks >= 2 && r.longestShare > 55 && !S.balance ? 'bad' : '');
  const tons = r.rows.reduce((a, row) => a + row.load, 0);
  sub('kUtilSub', tons.toFixed(1) + ' t of ' + (r.trucks * S.cap) + ' t capacity', '');

  $('kpiDist').title = 'Baseline: every collected town gets its own truck round trip from the yard (' + r.directKm.toFixed(0) + ' km). ' +
    'The planned routes cover the same towns in ' + r.km.toFixed(0) + ' km, so ' + r.savedKm.toFixed(0) + ' km is saved. ' +
    'Collecting all ' + n + ' towns with this method instead would be ' + base.km.toFixed(0) + ' km with ' + base.trucks + ' trucks.';
  $('kpiFuel').title = 'Fuel = planned km × ' + CONST.fuelLPerKm + ' L/km (assumed diesel truck), cost at ₹' + CONST.dieselInrPerL + ' per litre. Demo assumptions, not measured values.';
  $('kpiCo2').title = 'CO₂ not emitted compared with the one-truck-per-town baseline: ' + r.savedFuelL.toFixed(0) + ' L of diesel × ' + CONST.co2KgPerL + ' kg CO₂ per litre (saves ' + fmtInr(r.savedCost) + ').';
  $('kpiTowns').title = r.served + ' towns are on the run. ' + (n - view.collected.length) + ' are below the ' + S.thr + '% cut-off and wait. ' + r.unserved.length + ' could not be served.';
  $('kpiTrucks').title = 'Trucks needed for this plan, out of the ' + S.fleet + ' the depot owns.';
  $('kpiUtil').title = 'Average load per truck compared with its ' + S.cap + ' t capacity.';
}

function updateTownsSub() {
  if (!view) return;
  const r = view.cur, waiting = (N - 1) - view.collected.length;
  const total = Object.keys(info).length;
  let done = 0;
  Object.keys(info).forEach((n) => { if ((drain[n] || 0) >= 1) done++; });
  if (sim.t > 0 && total) sub('kTownsSub', done + ' emptied · ' + (total - done) + ' to go', 'good');
  else sub('kTownsSub', waiting + ' waiting' + (r.unserved.length ? ' · ' + r.unserved.length + ' unserved' : ''), r.unserved.length ? 'bad' : '');
}

/* ---------- sidebar: trucks ---------- */
function renderTrucks() {
  const rows = view.cur.rows, box = $('trucks');
  renderBalance();
  if (!rows.length) {
    box.innerHTML = '<p class="empty">No town is on today\'s run, so no truck leaves the yard. Lower the cut-off in Settings.</p>';
    return;
  }
  box.innerHTML = rows.map((row, k) => {
    const tr = sim.trucks[k], over = row.hours > S.shift + 1e-9;
    const legs = ['<li class="start"><span>Central yard</span><em>' + clock(0) + '</em></li>']
      .concat(row.stops.map((st) => '<li><span>' + esc(TOWNS[st.id].name) + '</span><em>' + clock(st.arr) + ' · ' + view.q[st.id].toFixed(1) + ' t</em></li>'))
      .concat(['<li class="end"><span>Back at the yard</span><em>' + clock(row.returnMin) + '</em></li>']).join('');
    return '<article class="tcard c' + (k % 6) + '" data-k="' + k + '" role="button" tabindex="0" aria-pressed="' + (S.focus === k) + '">' +
      '<header><span class="tbadge">' + (k + 1) + '</span><div><h3>Truck ' + (k + 1) + (over ? '<span class="tag">overtime</span>' : '') + '</h3><p>' + row.km.toFixed(0) + ' km · ' + fmtDur(row.hours * 60) + ' · ' + row.nodes.length + (row.nodes.length === 1 ? ' stop' : ' stops') + '</p></div>' +
      '<span class="tload mono" title="Tonnes on board now / planned for the day (truck capacity ' + S.cap + ' t)"></span></header>' +
      '<div class="tstat" data-s></div>' +
      '<div class="load"><i class="plan" style="width:' + Math.min(100, row.load / S.cap * 100).toFixed(1) + '%"></i><i class="now" style="width:0"></i></div>' +
      '<div class="tm"><div><small>Fuel</small><b>' + row.fuelL.toFixed(0) + ' L</b></div><div><small>Cost</small><b>' + fmtInr(row.fuelCost) + '</b></div>' +
      '<div><small>CO₂</small><b>' + row.co2Kg.toFixed(0) + ' kg</b></div><div><small>Load</small><b>' + Math.round(row.load / S.cap * 100) + '%</b></div></div>' +
      '<ol class="legs">' + legs + '</ol></article>';
  }).join('');
  updateTruckCards();
}

function renderBalance() {
  const r = view.cur, box = $('balanceBox');
  if (r.trucks < 2) { box.hidden = true; return; }
  box.hidden = false;
  const seg = r.rows.map((row, k) => '<i class="c' + (k % 6) + '" style="flex-grow:' + Math.max(0.5, row.km).toFixed(1) + '" title="Truck ' + (k + 1) + ': ' + row.km.toFixed(0) + ' km"></i>').join('');
  const hrs = r.rows.map((row) => row.hours);
  let msg = 'Truck ' + (r.longestTruck + 1) + ' drives ' + r.longestShare.toFixed(0) + '% of the distance. Longest day ' + fmtH(Math.max(...hrs)) + ', shortest ' + fmtH(Math.min(...hrs)) + ' (limit ' + S.shift + ' h).';
  const bn = view.balanceNote;
  if (S.balance && bn) {
    const dk = r.km - bn.kmWithout;
    msg += ' Splitting long routes changed the longest day from ' + fmtH(bn.makespanWithout) + ' to ' + fmtH(r.makespan) + ', using ' + r.trucks + ' trucks instead of ' + bn.trucksWithout + ' (' + (dk >= 0 ? '+' : '') + dk.toFixed(0) + ' km).';
  } else if (!S.balance && r.longestShare > 55) {
    msg += ' The split looks uneven; try Balance workload.';
  }
  box.innerHTML = '<h3>Workload balance</h3><div class="sbar">' + seg + '</div><p>' + esc(msg) + '</p>' +
    '<button class="btn" id="balBtn" type="button" aria-pressed="' + S.balance + '">Balance workload: ' + (S.balance ? 'on' : 'off') + '</button>';
}

function truckStatus(k) {
  const tr = sim.trucks[k];
  if (!tr) return '';
  const t = sim.t, row = tr.row;
  if (t <= 0) return 'At the yard, leaves ' + clock(0);
  if (t >= row.returnMin) return 'Back at the yard ' + clock(row.returnMin);
  for (let j = 0; j < row.stops.length; j++) {
    const st = row.stops[j], name = TOWNS[st.id].name;
    if (t < st.arr) return 'Driving to ' + name + ', ETA ' + clock(st.arr);
    if (t < st.dep) return 'Collecting at ' + name + ', ' + view.q[st.id].toFixed(1) + ' t, leaves ' + clock(st.dep);
  }
  return 'Returning to the yard, ETA ' + clock(row.returnMin);
}

function updateTruckCards() {
  const box = $('trucks');
  sim.trucks.forEach((tr, k) => {
    const carried = tr.carried || 0, card = box.querySelector('[data-k="' + k + '"]');
    if (card) {
      card.querySelector('.now').style.width = Math.min(100, carried / S.cap * 100).toFixed(1) + '%';
      setText(card.querySelector('.tload'), carried.toFixed(1) + ' / ' + tr.row.load.toFixed(1) + ' t');
      setText(card.querySelector('[data-s]'), truckStatus(k));
    }
  });
  document.querySelectorAll('#liveList li').forEach((li) => setText(li.querySelector('span'), truckStatus(+li.dataset.k)));
}

/* ---------- sidebar: compare ---------- */
function renderCompare() {
  const box = $('compare'), w = view.winner;
  const maxKm = Math.max(...ALGOS.map((a) => view.results[a.id].km), 1);
  const win = '<div class="win"><span class="k">Best plan today</span><h3>' + esc(w.name) + '</h3><ul>' + w.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
  const rows = ALGOS.map((a) => {
    const r = view.results[a.id], isW = a.id === w.id, tot = r.served + r.unserved.length;
    const vs = r.vsWorstPct == null ? '–' : (r.vsWorstPct > 0 ? '−' + r.vsWorstPct.toFixed(1) + '%' : '0%');
    const m = (label, val, cls) => '<div><small>' + label + '</small><b' + (cls ? ' class="' + cls + '"' : '') + '>' + val + '</b></div>';
    return '<div class="cmp-row' + (isW ? ' best' : '') + '" role="button" tabindex="0" data-a="' + a.id + '" aria-pressed="' + (a.id === S.algo) + '" title="Click to use this method">' +
      '<b>' + esc(a.name) + (isW ? '<span class="badge-best">Winner</span>' : '') + '</b><span class="v">' + r.km.toFixed(1) + ' km</span>' +
      '<span class="bar"><i data-w="' + (r.km / maxKm * 100).toFixed(1) + '"></i></span>' +
      '<div class="mx">' +
      m('Truck time', fmtH(r.hours)) + m('Longest day', fmtH(r.makespan), r.shiftViolations ? 'bad' : '') + m('Trucks', r.trucks) +
      m('Towns served', r.served + '/' + tot, r.unserved.length ? 'bad' : '') + m('Overloaded', r.capViolations, r.capViolations ? 'bad' : 'good') + m('Overtime', r.shiftViolations, r.shiftViolations ? 'bad' : 'good') +
      m('Run time', fmtRun(r.execMs)) + m('B&B nodes', r.bbNodes.toLocaleString('en-IN') + (r.bbCapped ? '+' : ''), r.bbCapped ? 'bad' : '') + m('vs longest', vs, r.vsWorstPct > 0 ? 'good' : '') +
      '</div></div>';
  }).join('');
  const cur = view.cur;
  box.innerHTML = win + rows +
    '<p class="cmp-note">All four methods run on the same towns and limits. Overloaded = trucks carrying more than ' + S.cap + ' t. Overtime = routes longer than ' + S.shift + ' h. ' +
    'Run time is the mean of up to 5 runs in C++. B&B nodes = search-tree nodes Branch and Bound examined (FIFO, LIFO and LC give the same tour when the search finishes; a + means it hit the node limit). "vs longest" compares with the longest plan serving the same towns.</p>' +
    '<p class="cmp-note">Lower bound for the selected plan: ' + cur.lowerBoundKm.toFixed(0) + ' km (minimum spanning tree of the yard and served towns). ' +
    'It ignores trucks returning to the yard, so it is loose and only shows that no plan can be shorter than that. Click a method to switch to it.</p>';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    box.querySelectorAll('.bar i').forEach((i) => i.style.setProperty('--w', i.dataset.w + '%'));
  }));
}

/* ---------- sidebar: alerts ---------- */
function renderAlerts() {
  const ws = view.warnings, ul = $('alerts');
  const n = ws.filter((x) => x.level !== 'info').length, hasErr = ws.some((x) => x.level === 'error');
  const badge = $('alertCount');
  badge.hidden = n === 0;
  badge.textContent = n;
  badge.classList.toggle('amber', !hasErr);
  if (!ws.length) {
    ul.innerHTML = '<li class="ok">No warnings. Every critical town is served, no truck is overloaded and no route runs past the ' + S.shift + ' h shift.</li>';
    return;
  }
  const ICON = { error: '!', warn: '!', info: 'i' };
  ul.innerHTML = ws.map((x, n2) =>
    '<li><button type="button" class="alert" data-n="' + n2 + '" data-l="' + x.level + '"><span class="ico">' + ICON[x.level] + '</span><span><p>' + esc(x.msg) + '</p>' +
    '<small>' + (x.town != null ? 'Click to see the town' : x.truck != null ? 'Click to see the route' : '') + '</small></span></button></li>'
  ).join('');
}

/* ---------- sidebar chips and tabs ---------- */
function renderChips() {
  const box = $('chips');
  box.innerHTML = view.cur.rows.map((row, k) =>
    '<button type="button" class="chip c' + (k % 6) + '" data-k="' + k + '" aria-pressed="' + (S.focus === k) + '" title="Truck ' + (k + 1) + ': ' + row.nodes.length + ' stops, ' + row.km.toFixed(0) + ' km. Click to inspect." style="animation-delay:' + (400 + k * 80) + 'ms"><i>' + (k + 1) + '</i>Truck ' + (k + 1) + '<span>' + row.km.toFixed(0) + ' km</span></button>'
  ).join('');
}

function renderLegend() {
  $('legend').innerHTML =
    '<span><i class="dot r"></i>Critical ≥ ' + S.crit + '%</span><span><i class="dot a"></i>Approaching ≥ ' + S.warn + '%</span><span><i class="dot g"></i>On track</span>' +
    '<span class="muted">ring = bin fill · number = stop order</span>';
  $('liveList').innerHTML = view.cur.rows.map((row, k) =>
    '<li data-k="' + k + '" class="c' + (k % 6) + '"><i>' + (k + 1) + '</i><span></span></li>').join('');
}

function placeInk() {
  const b = document.querySelector('.tabs [aria-selected="true"]'), ink = $('tabInk');
  if (!b) return;
  ink.style.width = b.offsetWidth + 'px';
  ink.style.transform = 'translateX(' + b.offsetLeft + 'px)';
}
const TABS = ['towns', 'trucks', 'compare', 'alerts'];
function switchTab(name) {
  S.tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
    $('panel-' + b.dataset.tab).hidden = !on;
  });
  $('panels').scrollTop = 0;
  placeInk();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- selecting a town / a route, and the popup card ---------- */
function select(i, opts) {
  opts = opts || {};
  S.sel = i;
  S.pop = i >= 0 ? { type: 'town', i } : null;
  TOWNS.forEach((t, j) => { if (!t.depot && (j === i || markers[j]._icon && markers[j]._icon.classList.contains('sel'))) paintTown(j); });
  if (i < 0) { popupEl.hidden = true; return; }
  showPopup();
  if (opts.fly !== false) {
    map.flyTo([TOWNS[i].lat, TOWNS[i].lon], Math.max(map.getZoom(), 11.5), { duration: REDUCED ? 0 : 0.9 });
  }
  if (opts.scroll !== false && itemEls[i] && !itemEls[i].hidden && S.tab === 'towns') {
    const sc = $('panels'), r = itemEls[i].getBoundingClientRect(), pr = sc.getBoundingClientRect();
    if (sc.scrollHeight > sc.clientHeight + 2) {
      const b = REDUCED ? 'auto' : 'smooth';
      if (r.top < pr.top) sc.scrollBy({ top: r.top - pr.top - 8, behavior: b });
      else if (r.bottom > pr.bottom) sc.scrollBy({ top: r.bottom - pr.bottom + 8, behavior: b });
    }
  }
}

function townPopup(i) {
  const t = TOWNS[i];
  if (t.depot) {
    const n = view.cur.rows.length;
    return '<div class="pop-head"><div class="ava" style="--fill:100;--c:var(--accent)"><span>' + YARD.replace('<svg ', '<svg width="22" height="22" ') + '</span></div><div><h2>' + esc(t.name) + '</h2><p>Where every truck starts and ends</p></div><button class="x" data-act="close" aria-label="Close">' + CLOSE + '</button></div>' +
      '<h3 class="pop-h">' + (n ? n + ' truck' + (n > 1 ? 's' : '') + ' leave at ' + clock(0) : 'No truck leaves today') + '</h3>' +
      '<ul class="pop-list"><li>Distances are measured from here</li><li>' + S.fleet + ' trucks available, ' + S.cap + ' t each</li></ul>';
  }
  const inf = info[i], fill = view.fills[i], tons = view.q[i], cap = t.capT, p = drain[i] || 0, done = !!inf && p >= 1, tier = view.tiers[i];
  let heading, bullets, acts;
  if (inf) {
    const row = view.cur.rows[inf.k], st = row.stops[inf.s - 1];
    heading = done ? 'Emptied at ' + clock(inf.leave) : 'Pickup planned for ' + clock(inf.arrive);
    bullets = ['Truck ' + (inf.k + 1) + ', stop ' + inf.s + ' of ' + row.nodes.length,
      'Stays ' + CONST.stopMinutes + ' minutes (' + clock(inf.arrive) + ' to ' + clock(inf.leave) + ')',
      'Takes ' + tons.toFixed(1) + ' t out of ' + cap.toFixed(1) + ' t',
      'Truck then carries ' + st.loadAfter.toFixed(1) + ' t of its ' + S.cap + ' t'];
    acts = '<button class="btn primary" data-act="jump" type="button">Jump to pickup</button><button class="btn" data-act="focus" type="button">Inspect route</button>';
  } else if (isUnserved(i)) {
    heading = 'Could not be served today';
    bullets = ['Bins are ' + fill + '% full (' + TIER_NAME[tier].toLowerCase() + ')', unsMap[i],
      tier === 2 ? 'This is a critical town. Add a truck or a longer shift.' : 'It had the lowest fill among the towns on the run.'];
    acts = '<button class="btn primary" data-act="morefleet" type="button">Allow one more truck</button>';
  } else {
    heading = 'Not on today\'s run';
    bullets = ['Bins are ' + fill + '% full and the cut-off is ' + S.thr + '%', 'Holds up to ' + cap.toFixed(1) + ' t when full', 'Lower the cut-off to ' + fill + '% to add it'];
    acts = '<button class="btn primary" data-act="include" type="button">Collect it too</button>';
  }
  return '<div class="pop-head"><div class="ava" style="--fill:' + Math.round(fill * (1 - p)) + ';--c:' + TIER_COL[tier] + '"><span>' + esc(initials(t.name)) + '</span>' + CHK + '</div>' +
    '<div><h2>' + esc(t.name) + '<span class="tag' + (tier === 2 ? ' red' : '') + '"' + (tier === 0 ? ' hidden' : '') + '>' + TIER_NAME[tier] + '</span></h2><p>' + esc(t.note) + '</p></div><button class="x" data-act="close" aria-label="Close">' + CLOSE + '</button></div>' +
    '<div class="stats"><div><small>Full</small><b>' + Math.round(fill * (1 - p)) + '%</b></div><div><small>Bins</small><b>' + t.bins + '</b></div><div><small>Waste</small><b>' + (tons * (1 - p)).toFixed(1) + ' t</b></div></div>' +
    '<h3 class="pop-h">' + heading + '</h3>' +
    '<ul class="pop-list">' + bullets.map((b) => '<li>' + esc(b) + '</li>').join('') + '</ul>' +
    '<div class="pop-act">' + acts + '</div>';
}

function routePopup(k) {
  const row = view.cur.rows[k], r = R[k];
  const over = row.hours > S.shift + 1e-9;
  const real = r && r.realKm ? ' · map roads ' + r.realKm.toFixed(0) + ' km' : '';
  const stops = row.stops.map((st) => '<li>' + esc(TOWNS[st.id].name) + ' <span class="mono">' + clock(st.arr) + ' · ' + view.q[st.id].toFixed(1) + ' t · ' + view.fills[st.id] + '%</span></li>').join('');
  return '<div class="pop-head"><span class="tbadge" style="background:var(--t' + (k % 6) + ')">' + (k + 1) + '</span><div><h2>Truck ' + (k + 1) + (over ? '<span class="tag">overtime</span>' : '') + '</h2><p>' + row.nodes.length + ' stops · planner ' + row.km.toFixed(0) + ' km' + real + '</p></div><button class="x" data-act="close" aria-label="Close">' + CLOSE + '</button></div>' +
    '<div class="stats"><div><small>Day</small><b>' + fmtH(row.hours) + '</b></div><div><small>Load</small><b>' + row.load.toFixed(1) + ' t</b></div><div><small>Fuel</small><b>' + row.fuelL.toFixed(0) + ' L</b></div></div>' +
    '<h3 class="pop-h">Leaves ' + clock(0) + ', back ' + clock(row.returnMin) + '</h3>' +
    '<ul class="pop-list">' + stops + '</ul>' +
    '<div class="pop-act"><button class="btn primary" data-act="zoomroute" type="button">Zoom to route</button><button class="btn" data-act="tabtrucks" type="button">Details</button></div>';
}

function showPopup(silent) {
  if (!S.pop) { popupEl.hidden = true; return; }
  popupEl.hidden = false;
  let c = 'var(--muted2)';
  if (S.pop.type === 'town') { c = TIER_COL[view.tiers[S.pop.i]]; popupEl.innerHTML = townPopup(S.pop.i); }
  else { c = 'var(--t' + (S.pop.k % 6) + ')'; popupEl.innerHTML = routePopup(S.pop.k); }
  popupEl.style.setProperty('--c', c);
  popupEl.classList.toggle('done', S.pop.type === 'town' && !!info[S.pop.i] && (drain[S.pop.i] || 0) >= 1);
  if (!silent) { popupEl.classList.remove('in'); void popupEl.offsetWidth; popupEl.classList.add('in'); }
  positionPopup();
}
function popupAnchor() {
  if (!S.pop) return null;
  if (S.pop.type === 'town') return [TOWNS[S.pop.i].lat, TOWNS[S.pop.i].lon];
  return S.pop.ll || null;
}
function positionPopup() {
  const ll = popupAnchor();
  if (popupEl.hidden || !ll || !map) return;
  const cw = mapwrap.clientWidth, ch = mapwrap.clientHeight;
  if (cw < 560) {  /* phones: a card above the dock instead of beside the marker */
    popupEl.style.width = (cw - 24) + 'px';
    popupEl.style.left = '12px';
    popupEl.style.top = Math.max(12, ch - popupEl.offsetHeight - 90) + 'px';
    return;
  }
  popupEl.style.width = '';
  const p = map.latLngToContainerPoint(ll), w = popupEl.offsetWidth, h = popupEl.offsetHeight;
  let left = p.x + 38, top = p.y - h / 2;
  if (left + w > cw - 12) left = p.x - 38 - w;
  if (left < 12) left = clamp((cw - w) / 2, 12, cw);
  top = clamp(top, 60, Math.max(60, ch - h - 100));
  popupEl.style.left = left.toFixed(0) + 'px';
  popupEl.style.top = top.toFixed(0) + 'px';
}

/* ---------- routes: lines on the map, direction arrows, real road geometry ---------- */
const legCache = new Map();       /* "a>b" -> { pts: [[lat,lng],...], dist: metres } from OSRM */
let roadTimer = 0, roadToken = 0, roadOk = 0, roadFail = 0;

function legObj(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + L.latLng(pts[i - 1]).distanceTo(L.latLng(pts[i])));
  return { pts, cum, len: cum[cum.length - 1] };
}
function pointAt(leg, d) {
  const c = leg.cum, n = c.length;
  if (leg.len <= 0 || n < 2) return { ll: leg.pts[0], bearing: 0 };
  d = clamp(d, 0, leg.len);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= d) lo = mid; else hi = mid; }
  const a = leg.pts[lo], b = leg.pts[hi], f = c[hi] > c[lo] ? (d - c[lo]) / (c[hi] - c[lo]) : 0;
  const rad = Math.PI / 180, dl = (b[1] - a[1]) * rad;
  const y = Math.sin(dl) * Math.cos(b[0] * rad), x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos(dl);
  return { ll: [lerp(a[0], b[0], f), lerp(a[1], b[1], f)], bearing: (Math.atan2(y, x) / rad + 360) % 360 };
}

function offsetLine(pts, px) {
  if (!px || pts.length < 2) return pts;
  const z = map.getZoom(), P = pts.map((p) => map.project(p, z)), out = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    out.push(map.unproject(L.point(P[i].x - dy / len * px, P[i].y + dx / len * px), z));
  }
  return out;
}

function makeRoute(row, k) {
  const seq = [0].concat(row.nodes, [0]);
  const legs = [];
  for (let j = 0; j < seq.length - 1; j++) legs.push(legObj([[TOWNS[seq[j]].lat, TOWNS[seq[j]].lon], [TOWNS[seq[j + 1]].lat, TOWNS[seq[j + 1]].lon]]));
  const cls = ' c' + (k % 6);
  const r = { k, row, seq, legs, pts: [], source: 'straight', realKm: 0, arrows: L.layerGroup().addTo(map) };
  r.casing = L.polyline([], { className: 'rt-case' + cls, interactive: false, smoothFactor: 1.4 }).addTo(map);
  r.main = L.polyline([], { className: 'rt-main tmp' + cls, interactive: false, smoothFactor: 1.4 }).addTo(map);
  r.hit = L.polyline([], { className: 'rt-hit' + cls, smoothFactor: 1.4 }).addTo(map);
  r.hit.on('click', (e) => { L.DomEvent.stopPropagation(e); inspectRoute(k, e.latlng); });
  r.hit.on('mouseover', () => r.main.getElement() && r.main.getElement().classList.add('hov'));
  r.hit.on('mouseout', () => r.main.getElement() && r.main.getElement().classList.remove('hov'));
  r.truck = L.marker(legs[0].pts[0], {
    icon: L.divIcon({ className: 'tk c' + (k % 6), html: '<div class="tk-in">' + (k + 1) + '</div>', iconSize: [0, 0], iconAnchor: [0, 0] }),
    interactive: false, keyboard: false, zIndexOffset: 1000
  }).addTo(map);
  return r;
}

function refreshRoute(r) {
  const pts = [];
  r.legs.forEach((leg, j) => leg.pts.forEach((p, i) => { if (j === 0 || i > 0) pts.push(p); }));
  r.pts = pts;
  const off = (r.k - (R.length - 1) / 2) * 2.4, shifted = offsetLine(pts, off);
  r.casing.setLatLngs(shifted); r.main.setLatLngs(shifted); r.hit.setLatLngs(shifted);
}
function refreshLines() { R.forEach(refreshRoute); }

function buildArrows(r) {
  r.arrows.clearLayers();
  r.legs.forEach((leg) => {
    if (leg.len < 8000) return;
    const n = leg.len > 60000 ? 2 : 1;
    for (let i = 1; i <= n; i++) {
      const at = pointAt(leg, leg.len * i / (n + 1));
      L.marker(at.ll, {
        icon: L.divIcon({ className: 'arwm c' + (r.k % 6), html: '<div style="transform:rotate(' + at.bearing.toFixed(0) + 'deg)">' + ARROW + '</div>', iconSize: [11, 11], iconAnchor: [5, 5] }),
        interactive: false, keyboard: false, zIndexOffset: -200
      }).addTo(r.arrows);
    }
  });
  applyFocus();
}

function drawIn(r) {
  if (REDUCED) return;
  const el = r.main.getElement();
  if (!el || !el.getTotalLength) return;
  const len = el.getTotalLength();
  if (!len) return;
  el.style.transition = 'none';
  el.style.strokeDasharray = len + ' ' + len;
  el.style.strokeDashoffset = len;
  el.getBoundingClientRect();
  el.style.transition = 'stroke-dashoffset 1.1s ease, opacity .35s, stroke-width .2s';
  el.style.strokeDashoffset = 0;
  setTimeout(() => { el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; el.style.transition = ''; }, 1250);
}

function rebuildRoutes() {
  R.forEach((r) => { [r.casing, r.main, r.hit, r.truck, r.arrows].forEach((l) => map.removeLayer(l)); });
  R = [];
  R = view.cur.rows.map(makeRoute);
  R.forEach((r) => { refreshRoute(r); buildArrows(r); });
}

function setGeometry(r, legs, source, km) {
  r.legs = legs.map((g) => legObj(g));
  r.source = source;
  r.realKm = km || 0;
  const el = r.main.getElement();
  if (el) { el.classList.remove('tmp'); el.classList.toggle('fallback', source === 'straight'); }
  refreshRoute(r);
  buildArrows(r);
  if (source === 'osrm') drawIn(r);
  if (S.pop && S.pop.type === 'route' && S.pop.k === r.k) showPopup(true);
}

/* Real road geometry from the public OSRM demo server. If it cannot be reached the page keeps
   straight lines between stops and says so; the planner's numbers do not depend on this. */
function osrmRoute(seq) {
  const coords = seq.map((n) => TOWNS[n].lon.toFixed(5) + ',' + TOWNS[n].lat.toFixed(5)).join(';');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  return fetch(OSRM + coords + '?overview=false&steps=true&geometries=geojson', { signal: ctl.signal })
    .then((res) => { if (!res.ok) throw new Error('OSRM ' + res.status); return res.json(); })
    .then((d) => {
      clearTimeout(timer);
      if (d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error('OSRM ' + d.code);
      return d.routes[0].legs.map((lg) => {
        const pts = [];
        lg.steps.forEach((st) => st.geometry.coordinates.forEach((c) => {
          const p = [c[1], c[0]], last = pts[pts.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
        }));
        if (pts.length < 2) throw new Error('empty leg');
        return { pts, dist: lg.distance };
      });
    }, (e) => { clearTimeout(timer); throw e; });
}

function roadPill(text, warn) {
  const el = $('roadPill');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('warn', !!warn);
}

function scheduleRoads() {
  clearTimeout(roadTimer);
  const tok = ++roadToken;
  if (!R.length) { roadPill(''); return; }
  roadPill('Snapping routes to real roads…');
  roadTimer = setTimeout(() => fetchRoads(tok), 400);
}

async function fetchRoads(tok) {
  let ok = 0, fail = 0;
  for (const r of R.slice()) {
    if (tok !== roadToken) return;
    const keys = r.seq.slice(0, -1).map((a, j) => a + '>' + r.seq[j + 1]);
    try {
      if (!keys.every((k) => legCache.has(k))) {
        const legs = await osrmRoute(r.seq);
        legs.forEach((g, j) => legCache.set(keys[j], g));
      }
      if (tok !== roadToken) return;
      const got = keys.map((k) => legCache.get(k));
      setGeometry(r, got.map((g) => g.pts), 'osrm', got.reduce((a, g) => a + g.dist, 0) / 1000);
      ok++;
    } catch (e) {
      if (tok !== roadToken) return;
      fail++;
      const el = r.main.getElement();
      if (el) { el.classList.remove('tmp'); el.classList.add('fallback'); }
      if (window.console) console.warn('Road geometry for truck ' + (r.k + 1) + ' unavailable:', e.message);
    }
  }
  roadOk = ok; roadFail = fail;
  if (!fail) roadPill('Routes follow real roads (OSRM). Planner km use straight line × 1.25.');
  else if (!ok) roadPill('Road service unreachable: showing straight lines between stops', true);
  else roadPill('Some routes show straight lines (road service busy)', true);
}

function inspectRoute(k, ll) {
  S.sel = -1;
  S.pop = { type: 'route', k, ll: ll ? [ll.lat, ll.lng] : null };
  if (!S.pop.ll) { const m = R[k].pts[Math.floor(R[k].pts.length / 2)]; S.pop.ll = m; }
  if (S.focus !== k) { S.focus = k; applyFocus(); }
  showPopup();
}

/* ---------- focusing one truck ---------- */
function applyFocus() {
  R.forEach((r, k) => {
    const dim = S.focus >= 0 && S.focus !== k;
    [r.casing, r.main].forEach((l) => { const el = l.getElement(); if (el) { el.classList.toggle('dim', dim); el.classList.toggle('sel', S.focus === k); } });
    const tel = r.truck._icon;
    if (tel) tel.classList.toggle('dim', dim);
    r.arrows.eachLayer((m) => { if (m._icon) { m._icon.classList.toggle('dim', dim); m._icon.classList.toggle('on', S.focus === k); } });
    if (S.focus === k) { r.casing.bringToFront(); r.main.bringToFront(); r.hit.bringToFront(); }
  });
  TOWNS.forEach((t, i) => { if (!t.depot) paintMarker(i); });
  document.querySelectorAll('#chips .chip, #trucks .tcard').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.k === S.focus));
}
function focusRoute(k, zoom) {
  S.focus = S.focus === k && !zoom ? -1 : k;
  applyFocus();
  if (S.focus < 0) { fitAll(true); return; }
  const r = R[S.focus];
  if (r && r.pts.length) map.flyToBounds(L.latLngBounds(r.pts), Object.assign(fitOpts(true), { maxZoom: 12 }));
}

/* ---------- replaying the day ---------- */
function buildSim() {
  const rows = view.cur.rows;
  sim.trucks = [];
  info = {};
  unsMap = {};
  view.cur.unserved.forEach((u) => { unsMap[u.id] = u.reason; });
  let total = 0;
  rows.forEach((row, k) => {
    const segs = [];
    let prev = 0;
    row.stops.forEach((st, j) => {
      segs.push({ type: 'drive', leg: j, t0: prev, t1: st.arr });
      segs.push({ type: 'dwell', leg: j, t0: st.arr, t1: st.dep });
      info[st.id] = { k, s: j + 1, arrive: st.arr, leave: st.dep };
      prev = st.dep;
    });
    segs.push({ type: 'drive', leg: row.stops.length, t0: prev, t1: row.returnMin });
    sim.trucks.push({ k, row, segs, carried: 0 });
    total = Math.max(total, row.returnMin);
  });
  sim.total = total;
}

function truckLL(k, t) {
  const tr = sim.trucks[k], r = R[k];
  if (!tr || !r) return null;
  const segs = tr.segs;
  if (t <= 0) return r.legs[0].pts[0];
  if (t >= tr.row.returnMin) { const l = r.legs[r.legs.length - 1]; return l.pts[l.pts.length - 1]; }
  let s = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i++) if (t < segs[i].t1) { s = segs[i]; break; }
  const leg = r.legs[s.leg];
  if (!leg) return null;
  if (s.type === 'dwell') return leg.pts[leg.pts.length - 1];
  const f = s.t1 > s.t0 ? clamp((t - s.t0) / (s.t1 - s.t0), 0, 1) : 1;
  return pointAt(leg, leg.len * f).ll;
}

function setDrain(node, p) {
  const prev = drain[node] || 0;
  if (p === prev) return;
  drain[node] = p;
  paintTown(node);
  if (p >= 1 && prev < 1) {
    if (sim.playing) burst(node);
    if (S.pop && S.pop.type === 'town' && S.pop.i === node) showPopup(true);
  } else if (p < 1 && prev >= 1 && S.pop && S.pop.type === 'town' && S.pop.i === node) showPopup(true);
}

function updateClockUI() {
  setText($('clock'), clock(sim.t));
  const total = Object.keys(info).length;
  let done = 0;
  Object.keys(info).forEach((n) => { if ((drain[n] || 0) >= 1) done++; });
  setText($('clockSub'), !total ? 'No towns on today\'s run'
    : sim.t <= 0 ? 'Trucks ready · all home by ' + clock(sim.total)
    : sim.t >= sim.total ? 'All trucks back at the yard'
    : done + ' of ' + total + ' towns emptied · home by ' + clock(sim.total));
  updateTownsSub();
}
function updatePlayIcon() {
  const b = $('play');
  const atEnd = sim.total > 0 && sim.t >= sim.total;
  b.innerHTML = sim.playing ? PAUSE : atEnd ? REPLAY : PLAY;
  b.setAttribute('aria-label', sim.playing ? 'Pause' : atEnd ? 'Replay the day' : sim.t > 0 ? 'Resume' : 'Play the day');
  b.classList.toggle('idle', !sim.playing && sim.t === 0 && sim.total > 0);
  b.disabled = !sim.total;
  $('reset').disabled = !sim.total;
  $('scrub').disabled = !sim.total;
}
function setPlaying(on) {
  if (on && sim.t >= sim.total) sim.t = 0;
  sim.playing = !!on && sim.total > 0;
  updatePlayIcon();
}
function applySimState() {
  const t = sim.t;
  sim.trucks.forEach((tr, k) => {
    let carried = 0;
    tr.row.stops.forEach((st) => {
      const p = clamp((t - st.arr) / (st.dep - st.arr), 0, 1);
      setDrain(st.id, p);
      carried += view.q[st.id] * p;
    });
    tr.carried = carried;
    const ll = truckLL(k, t);
    if (ll && R[k]) R[k].truck.setLatLng(ll);
  });
  $('scrub').value = sim.total ? Math.round(t / sim.total * 1000) : 0;
  updateClockUI();
  updateTruckCards();
}

/* ---------- a new plan from the server ---------- */
function applyPlan(d, rtt) {
  view = d;
  view.cur = d.results[S.algo];
  START_MIN = CONST.startMin || START_MIN;
  if (S.pop && S.pop.type === 'route') S.pop = null;
  buildSim();
  drain = {};
  sim.t = 0;
  sim.playing = false;
  if (S.focus >= view.cur.rows.length) S.focus = -1;
  rebuildRoutes();
  TOWNS.forEach((t, i) => { if (!t.depot) paintTown(i); });
  cluster.refreshClusters();
  renderList(); renderTrucks(); renderCompare(); renderKpis(); renderChips(); renderAlerts(); renderLegend();
  applyFocus();
  applySimState();
  updatePlayIcon();
  if (S.pop) showPopup(true);
  syncSettings();
  $('dayLbl').textContent = 'Sample day ' + S.seed;
  setStatus('ok', 'C++ ' + d.computeMs.toFixed(2) + ' ms', 'Computed by the C++ backend in ' + d.computeMs.toFixed(3) + ' ms. Round trip ' + Math.round(rtt) + ' ms.');
  scheduleRoads();
  const cur = view.cur, summary = 'Day ' + S.seed + ' · ' + cur.served + ' of ' + (N - 1) + ' towns · ' + cur.trucks + ' trucks · ' + cur.km.toFixed(0) + ' km' + (cur.unserved.length ? ' · ' + cur.unserved.length + ' unserved' : '');
  if (firstPlan) {
    firstPlan = false;
    setTimeout(() => toast(summary), 700);
  } else if (S.lastToast !== summary && S.announce) {
    toast(summary);
  }
  S.announce = false;
  S.lastToast = summary;
}

/* ---------- the animation loop ---------- */
let lastNow = performance.now();
function frame(now) {
  const dt = Math.min(64, now - lastNow);
  lastNow = now;
  if (sim.playing) {
    sim.t += dt / 1000 * SPEEDS[sim.speed];
    if (sim.t >= sim.total) { sim.t = sim.total; sim.playing = false; updatePlayIcon(); }
    applySimState();
  }
  requestAnimationFrame(frame);
}

/* ---------- settings panel ---------- */
function syncSettings() {
  $('thr').value = S.thr; $('thrVal').textContent = S.thr + '%';
  $('crit').value = S.crit; $('critVal').textContent = S.crit + '%';
  $('warn').value = S.warn; $('warn').max = S.crit; $('warnVal').textContent = S.warn + '%';
  $('cap').value = S.cap; $('capVal').textContent = S.cap + ' t';
  $('fleet').value = S.fleet; $('fleetVal').textContent = S.fleet;
  $('shift').value = S.shift; $('shiftVal').textContent = S.shift + ' h';
  $('balance').checked = S.balance;
  syncAlgoPills();
}
function syncAlgoPills() {
  document.querySelectorAll('#algoSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.a === S.algo));
}
function changed(announce) { S.announce = !!announce; schedulePlan(); }

/* ---------- events ---------- */
function bindEvents() {
  const pickAlgo = (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    S.algo = b.dataset.a;
    syncAlgoPills();
    changed(true);
  };
  $('algoSeg').addEventListener('click', pickAlgo);
  $('compare').addEventListener('click', pickAlgo);
  $('compare').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAlgo(e); } });

  const slider = (id, key, fmt, extra) => $(id).addEventListener('input', (e) => {
    S[key] = +e.target.value;
    $(id + 'Val').textContent = fmt(S[key]);
    if (extra) extra();
    changed(false);
  });
  slider('thr', 'thr', (v) => v + '%');
  slider('crit', 'crit', (v) => v + '%', () => { if (S.warn > S.crit) S.warn = S.crit; $('warn').max = S.crit; $('warn').value = S.warn; $('warnVal').textContent = S.warn + '%'; });
  slider('warn', 'warn', (v) => v + '%');
  slider('cap', 'cap', (v) => v + ' t');
  slider('fleet', 'fleet', (v) => String(v));
  slider('shift', 'shift', (v) => v + ' h');
  $('balance').addEventListener('change', (e) => { S.balance = e.target.checked; changed(true); });
  $('newDay').addEventListener('click', () => { S.seed++; $('dayLbl').textContent = 'Sample day ' + S.seed; changed(true); });
  $('exportBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = API + '/api/export?' + planQuery();
    a.download = 'pune-collection-plan-day' + S.seed + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Plan downloaded as CSV');
  });

  $('search').addEventListener('input', (e) => { S.q = e.target.value; renderList(); });
  $('show').addEventListener('change', (e) => { S.show = e.target.value; renderList(); });
  $('sort').addEventListener('change', (e) => { S.sort = e.target.value; renderList(); });
  $('filtersBtn').addEventListener('click', () => {
    const open = !$('drawer').classList.contains('open');
    $('drawer').classList.toggle('open', open);
    $('drawerIn').inert = !open;
    $('filtersBtn').setAttribute('aria-expanded', open);
  });
  $('sumBtn').addEventListener('click', () => {
    const open = $('kpis').hidden;
    $('kpis').hidden = !open;
    $('sumBtn').setAttribute('aria-expanded', open);
  });

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const at = TABS.indexOf(S.tab), nx = TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    switchTab(nx);
    $('tab-' + nx).focus();
  });

  $('trucks').addEventListener('click', (e) => { const c = e.target.closest('.tcard'); if (c) focusRoute(+c.dataset.k); });
  $('trucks').addEventListener('keydown', (e) => {
    const c = e.target.closest('.tcard');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusRoute(+c.dataset.k); }
  });
  $('balanceBox').addEventListener('click', (e) => {
    if (!e.target.closest('#balBtn')) return;
    S.balance = !S.balance;
    $('balance').checked = S.balance;
    changed(true);
  });
  $('chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { focusRoute(+c.dataset.k, true); inspectRoute(+c.dataset.k); } });
  $('alerts').addEventListener('click', (e) => {
    const b = e.target.closest('.alert');
    if (!b) return;
    const w = view.warnings[+b.dataset.n];
    if (w.town != null) select(w.town);
    else if (w.truck != null) { focusRoute(w.truck, true); inspectRoute(w.truck); }
  });

  popupEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, i = S.sel;
    if (act === 'close') { if (S.pop && S.pop.type === 'route') { S.pop = null; popupEl.hidden = true; } else select(-1); }
    else if (act === 'focus' && info[i]) { focusRoute(info[i].k, true); inspectRoute(info[i].k); }
    else if (act === 'jump' && info[i]) {
      sim.t = Math.max(0, info[i].arrive - 25);
      setPlaying(true);
      applySimState();
    } else if (act === 'include') {
      S.thr = Math.min(S.thr, view.fills[i]);
      changed(true);
    } else if (act === 'morefleet') {
      S.fleet = Math.min(10, S.fleet + 1);
      changed(true);
    } else if (act === 'zoomroute' && S.pop) focusRoute(S.pop.k, true);
    else if (act === 'tabtrucks') switchTab('trucks');
  });

  $('play').addEventListener('click', () => { setPlaying(!sim.playing); if (sim.playing) applySimState(); });
  $('reset').addEventListener('click', () => { sim.t = 0; setPlaying(false); drain = {}; TOWNS.forEach((t, i) => { if (!t.depot) paintTown(i); }); applySimState(); });
  $('scrub').addEventListener('input', (e) => {
    sim.t = (+e.target.value / 1000) * sim.total;
    sim.playing = false;
    updatePlayIcon();
    applySimState();
  });
  $('speed').addEventListener('click', () => {
    sim.speed = (sim.speed + 1) % SPEEDS.length;
    $('speed').textContent = SPEED_LABEL[sim.speed];
  });

  $('zin').addEventListener('click', () => map.zoomIn());
  $('zout').addEventListener('click', () => map.zoomOut());
  $('zfit').addEventListener('click', () => { S.focus = -1; applyFocus(); fitAll(true); });
  $('labelsBtn').addEventListener('click', () => {
    const on = !$('lmap').classList.contains('labels');
    $('lmap').classList.toggle('labels', on);
    $('labelsBtn').setAttribute('aria-pressed', on);
  });
  $('theme').addEventListener('click', () => {
    const next = theme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('pwr-theme', next); } catch (err) { /* storage can be blocked */ }
    tileFailed = false;
    setTiles();
  });
  const togglePanel = () => {
    const full = !$('app').classList.contains('full');
    $('app').classList.toggle('full', full);
    $('panelBtn').setAttribute('aria-pressed', full);
    $('panelBtn').setAttribute('aria-label', full ? 'Show the side panel' : 'Hide the side panel for a full-screen map');
    setTimeout(() => { map.invalidateSize(); positionPopup(); }, 60);
  };
  $('panelBtn').addEventListener('click', togglePanel);
  $('retry').addEventListener('click', () => { clearTimeout(retryTimer); N ? schedulePlan() : boot(); });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); }
    else if ((e.key === 'f' || e.key === 'F') && !typing && !e.ctrlKey && !e.metaKey) togglePanel();
    else if (e.key === 'Escape') {
      if (typing) e.target.blur();
      else if (S.focus >= 0 || S.pop) { S.focus = -1; S.pop = null; S.sel = -1; popupEl.hidden = true; applyFocus(); TOWNS.forEach((t, i) => { if (!t.depot) paintTown(i); }); fitAll(true); }
    } else if (e.key === ' ' && !typing && tag !== 'button' && !e.target.closest('[role="button"]')) {
      e.preventDefault();
      $('play').click();
    }
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (map) { map.invalidateSize(); positionPopup(); } placeInk(); }).observe(mapwrap);
  }
  window.addEventListener('resize', placeInk);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeInk);
}

/* ---------- boot ---------- */
function boot() {
  getJSON('/api/towns').then((d) => {
    TOWNS = d.towns; ALGOS = d.algos;
    CONST = Object.assign(CONST, d.constants || {});
    START_MIN = CONST.startMin || START_MIN;
    N = TOWNS.length;
    TOWNS.forEach((t, i) => { t.id = i; });
    initMap();
    buildMarkers(); buildItems();
    $('algoSeg').innerHTML = ALGOS.map((a) => '<button type="button" data-a="' + a.id + '" aria-pressed="false">' + esc(a.name) + '</button>').join('');
    syncSettings();
    $('speed').textContent = SPEED_LABEL[sim.speed];
    updatePlayIcon();
    schedulePlan();
  }).catch(onError);
}

bindEvents();
placeInk();
requestAnimationFrame(frame);
boot();
})();
