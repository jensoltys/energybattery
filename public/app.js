// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
'use strict';

// The tab (or day) the user was on before they hit refresh. history.state
// survives a reload of the same entry, but init() replaceState()s an
// auth-landing entry over it before enterApp() ever runs — and the hub-handoff
// replaceState above can too — so it has to be captured HERE, at module load,
// before anything touches history. Without it, refreshing anywhere but the
// default tab bounced the user back to the default.
const BOOT_VIEW = (history.state || {}).view || null;
// Same idea for the logged-out side: a refresh on the sign-up form or on the
// guest sample check-in should land back there, not on the default.
const BOOT_ENTRY = (() => { const st = history.state || {}; return { authView: st.authView || null, guestView: st.guestView || null }; })();

// =============================================================================
// Energy Battery — frontend app.js
// Extracted from inline <script> blocks in index.html so the CSP can drop
// 'unsafe-inline' from script-src. All onclick/oninput/onsubmit attributes
// have been replaced with addEventListener wiring at the bottom of this file.
// =============================================================================

// -----------------------------------------------------------------------------
// 1) Cross-app Pro handoff from app-hub — MUST run first (captures ?hubpro=...)
// -----------------------------------------------------------------------------
let HUB_ARRIVAL = false;
(function captureHubPro() {
  const qs = new URLSearchParams(location.search);
  const hubpro = qs.get('hubpro');
  if (hubpro) {
    // A fresh hubpro in the URL means the user just arrived via the hub and may
    // be a different identity than whoever was last logged in here. Drop the
    // local session so the bootstrap path will re-run hub-sso against the new
    // JWT instead of silently keeping the previous user signed in. The session
    // is an HttpOnly cookie now, so "drop" means: skip the /api/me check and
    // let hub-sso replace the cookie. Any pre-cookie localStorage token goes too.
    HUB_ARRIVAL = true;
    try { localStorage.removeItem('eb_token'); } catch {}
    localStorage.setItem('hub_pro_jwt', hubpro);
    qs.delete('hubpro');
    const newQs = qs.toString();
    history.replaceState({}, '', location.pathname + (newQs ? '?' + newQs : ''));
  }
})();

// -----------------------------------------------------------------------------
// 1.2) Boot gate.
// #auth-screen is hidden in the markup, so the logged-out card cannot paint over
// a session that is seconds from resolving. Arriving from the hub with ?hubpro=
// used to show the Log In / Sign Up tabs, the email field and the password field
// for about half a second while hub-sso ran, on the one journey whose whole
// promise is that you never see a second sign-in.
// The call is made here, synchronously, before any network request.
// -----------------------------------------------------------------------------
function showAuthScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.style.display = 'none';
  const auth = document.getElementById('auth-screen');
  if (auth) auth.style.display = 'flex';
}
function hideBootScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.style.display = 'none';
}
// The session is an HttpOnly cookie the page can't read, so the boot screen
// stays up until init() asks GET /api/me (401 = show the login card). A
// logged-in user never sees the login card flash, and a logged-out one sees
// the boot screen for one round trip.
(function bootGate() {
  const msg = document.getElementById('boot-msg');
  if (msg) msg.textContent = HUB_ARRIVAL ? 'Signing you in from the hub…' : 'Opening your battery…';
})();

// -----------------------------------------------------------------------------
// 1.5) Pro-required modal. Every Go Pro link opens it.
// -----------------------------------------------------------------------------
const PRO_FROM = 'battery';
// Starts false so nothing sells Pro before /api/pro-status answers. It turns true
// only when this copy has a Pro hub connected (pro_available:true).
let proAvailable=false;
// From the server's UPGRADE_URL and PRO_PRICE_TEXT (only sent when a hub is connected).
let proUpgradeUrl='';
let proPriceText='';
// The feedback button shows only when the server has FEEDBACK_WEBHOOK_URL set.
let feedbackAvailable=false;
let feedbackWanted=false;
function applyProAvail(){
  document.querySelectorAll('[data-pro-on]').forEach(el=>{el.hidden=!proAvailable;});
  document.querySelectorAll('[data-pro-off]').forEach(el=>{el.hidden=proAvailable;});
  const price=document.getElementById('pro-required-price');
  if(price){price.textContent=proPriceText;price.hidden=!(proAvailable&&proPriceText);}
}
// Every Go Pro link opens the Pro popup. With a hub it carries the upgrade link,
// without one it explains that Pro lives on the hosted version.
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('[data-go-pro]');
  if(!b)return;
  e.preventDefault();
  showProRequired(b.getAttribute('data-go-pro')||'');
});
const PRO_FEATURE_COPY = {
  'unlimited-history': { title: 'Full check-in history', desc: 'Free shows the last 7 days. Pro shows everything you\'ve logged.' },
  'pattern-insights': { title: 'Pattern insights', desc: 'See what charges and drains your energy across days, times, and activities.' },
};
function showProRequired(feature) {
  let copy = PRO_FEATURE_COPY[feature] || { title: 'Pro feature', desc: 'This is part of Pro.' };
  // This copy has no Pro hub: Pro only exists on the hosted version, so say that plainly.
  if (!proAvailable) copy = { title: copy.title, desc: "Pro isn't available on this copy of Energy Battery. It's part of the hosted version at energybattery.app. A battery there starts fresh, nothing moves over from here." };
  const url = !proAvailable ? 'https://energybattery.app' : !proUpgradeUrl ? '#' : proUpgradeUrl + (feature ? (proUpgradeUrl.includes('?') ? '&' : '?') + 'feature=' + encodeURIComponent(feature) : '');
  const modal = document.getElementById('pro-required-modal');
  if (!modal) return;
  modal.querySelector('#pro-required-title').textContent = copy.title;
  modal.querySelector('#pro-required-desc').textContent = copy.desc;
  const cta = modal.querySelector('#pro-required-cta');
  cta.href = url;
  cta.textContent = proAvailable ? 'Go Pro' : 'Open energybattery.app';
  cta.hidden = proAvailable && !proUpgradeUrl;
  openOverlay('pro-required-modal');
}
function closeProRequired(fromHistory) { closeOverlay('pro-required-modal', fromHistory); }
document.addEventListener('click', (e) => {
  if (e.target?.dataset?.action === 'close-pro-modal') closeProRequired();
});

// -----------------------------------------------------------------------------
// 1.5) Overlay stack — one owner for "which overlay is on screen"
// -----------------------------------------------------------------------------
// The worked reference for overlays. Every modal here used to set its own .style.display, which is two
// bugs in one habit:
//   1. Nothing pushed a history entry, so a free user who hit the Pro gate and
//      pressed Back left the site. The 2026-07 retrofit covered tabs and auth
//      steps but not overlays; popstate -> closeAllOverlays() was already
//      wired, it just never had an entry to pop.
//   2. Nothing hid the layer underneath, so one dialog could render on top of
//      another (stacked dialogs).
//
// Opening B now hides A (display only, so any half-filled form keeps its
// values) and closing B restores it. Depth counts PUSHED layers, not stack
// length, so a push-free gate underneath doesn't shift the number popstate
// compares against.
//
// Gates — first-run onboarding and the timezone picker — are blocking states
// shown at the landing view with nothing behind them, so they push nothing and
// Back from one leaves the app like any other landing view.
let overlayStack = []; // [{ id, pushed }] bottom -> top
function overlayPushedCount() { let n = 0; for (const o of overlayStack) if (o.pushed) n++; return n; }
function setOverlayShown(id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? 'flex' : 'none'; }

function openOverlay(id, { gate = false } = {}) {
  const top = overlayStack[overlayStack.length - 1];
  if (top && top.id === id) return;          // already the visible layer
  if (top) setOverlayShown(top.id, false);   // one dialog at a time
  setOverlayShown(id, true);
  overlayStack.push({ id, pushed: !gate });
  if (!gate) history.pushState({ ...(history.state || {}), ebOverlay: overlayPushedCount() }, '', location.pathname + location.search);
}
// teardown=false is the consumeOverlay() path, where the layer's own handler
// already settled its state.
function popOverlayLayer(teardown = true) {
  const layer = overlayStack.pop();
  if (!layer) return;
  setOverlayShown(layer.id, false);
  if (teardown && layer.id === 'celeb-overlay') document.querySelectorAll('.dep-popup').forEach(el => el.remove());
  // The tour has no overlay element of its own — it paints a ring plus a pinned
  // box straight onto the body — so its layer popping is what tears it down.
  if (layer.id === 'tour-layer') endTour(true);
  const restore = overlayStack[overlayStack.length - 1];
  if (restore) setOverlayShown(restore.id, true);
}
// Returns true when the close was handed to history — popstate does the hiding
// in that case, so the caller must NOT also hide the element or the on-screen
// button and browser Back fall out of sync (dead presses). fromHistory=true
// means popstate is already unwinding; hide directly or history.back() loops.
function closeOverlay(id, fromHistory) {
  const idx = overlayStack.map(o => o.id).lastIndexOf(id);
  if (idx === -1) { setOverlayShown(id, false); return false; }
  if (!fromHistory && overlayStack[idx].pushed && (history.state || {}).ebOverlay) { history.back(); return true; }
  while (overlayStack.length > idx) popOverlayLayer();
  return false;
}
// An action completed INSIDE an overlay consumes its history entry instead of
// leaving a dead one behind — the modal is gone, so Back must skip past it.
function consumeOverlay(id) {
  const idx = overlayStack.map(o => o.id).lastIndexOf(id);
  if (idx === -1) { setOverlayShown(id, false); return; }
  const pushed = overlayStack[idx].pushed;
  while (overlayStack.length > idx) popOverlayLayer(false);
  if (pushed) history.replaceState({ view: currentTab }, '', location.pathname + location.search);
}
// Pops only as many layers as the popped entry gives back. Gates below the
// target survive, which is what makes Back out of a modal opened over another
// land on the one underneath rather than on the bare app.
function unwindOverlaysTo(depth) {
  let guard = overlayStack.length + 1;
  while (overlayPushedCount() > depth && guard-- > 0) popOverlayLayer();
}

// -----------------------------------------------------------------------------
// 2) Module state
// -----------------------------------------------------------------------------
const API = location.origin;
// Signed in = currentUser is set. The session itself lives in the HttpOnly
// eb_session cookie, which page scripts can't read.
let currentUser = null;
let authMode = 'login';
// Back-button state trackers. currentTab starts null (not a valid tab) so
// goTab()'s no-op guard can never fire before landTab() establishes the real
// landing tab — landing is always a replaceState, never a stray pushState.
let currentTab = null;
let currentAuthView = 'login';
let checkins = [];
let patterns = null;
const TAGS = ['exercise','sleep','food','work','social','outdoors','creative','rest','caffeine','alcohol','screen_time','meditation'];
const TAG_LABELS = {exercise:'Exercise',sleep:'Sleep',food:'Food',work:'Work',social:'Social',outdoors:'Outdoors',creative:'Creative',rest:'Rest',caffeine:'Caffeine',alcohol:'Alcohol',screen_time:'Screen Time',meditation:'Meditation'};
let selectedTags = [];

// ── Onboarding "What do you want to track?" (UX fixes 2026-11) ──────────────
// Replaced the timezone step (the zone is detected now). Each answer floats its
// tags to the front of the check-in form. Nothing is pre-ticked: a tag only
// means something when the person taps it for that moment.
const TRACK_KEYS = ['work', 'sleep', 'food', 'people'];
const TRACK_LABELS = { work: 'Work', sleep: 'Sleep', food: 'Food', people: 'People' };
const TRACK_TAGS = { work: ['work', 'screen_time'], sleep: ['sleep', 'rest'], food: ['food', 'caffeine', 'alcohol'], people: ['social'] };
let trackFocus = null; // null = never answered; [] = answered with nothing picked
function orderedTags() {
  if (!Array.isArray(trackFocus) || !trackFocus.length) return TAGS;
  const front = [];
  for (const k of TRACK_KEYS) if (trackFocus.includes(k)) for (const t of TRACK_TAGS[k]) if (!front.includes(t)) front.push(t);
  return front.concat(TAGS.filter(t => !front.includes(t)));
}

// ── Guest sample check-in (UX fixes 2026-11) ────────────────────────────────
// A logged-out visitor does ONE check-in before any sign-up form. It never
// touches the server while they're a guest: it sits in localStorage and goes
// through the normal authed POST /api/checkins (same validation as every other
// check-in) right after they sign up or log in. Everything read back out of
// storage is re-validated here, because anything on the device can edit it.
const GUEST_KEY = 'eb_guest_ci';
// 2 hours: an unsaved sample on a shared device expires
// instead of landing in the next person's account.
const GUEST_MAX_AGE_MS = 2 * 3600000;
function readGuestCheckin() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null'); } catch { g = null; }
  if (!g || typeof g !== 'object') { clearGuestCheckin(); return null; }
  const today = getTodayDate();
  const ok = g.v === 1
    && Number.isInteger(g.energy) && g.energy >= 1 && g.energy <= 10
    && ['morning', 'afternoon', 'evening'].includes(g.time)
    && typeof g.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.date)
    && g.date <= today && g.date >= shiftDays(today, -MAX_BACKFILL_DAYS)
    && typeof g.at === 'number' && Date.now() - g.at < GUEST_MAX_AGE_MS && g.at <= Date.now() + 60000
    && Array.isArray(g.tags) && g.tags.length <= TAGS.length;
  if (!ok) { clearGuestCheckin(); return null; }
  const tags = [...new Set(g.tags.filter(t => typeof t === 'string' && TAGS.includes(t)))];
  return { v: 1, energy: g.energy, time: g.time, date: g.date, at: g.at, tags };
}
function saveGuestCheckin(g) { try { localStorage.setItem(GUEST_KEY, JSON.stringify(g)); } catch {} }
function clearGuestCheckin() { try { localStorage.removeItem(GUEST_KEY); } catch {} }
// Armed only by an interactive sign-up, verify or log-in on this page, never by
// a silent boot session, so a sample left behind on a shared device can't slip
// into whoever's account happens to be signed in next.
let carryGuestOnEntry = false;
async function carryGuestCheckin() {
  const g = readGuestCheckin();
  if (!g) return;
  try {
    await api('/api/checkins', { method: 'POST', body: JSON.stringify({ energy_level: g.energy, time_of_day: g.time, checkin_date: g.date, tags: g.tags.length ? g.tags : undefined }) });
    clearGuestCheckin();
    // It was their first check-in, so the "first spark" milestone is spent.
    try { const hit = JSON.parse(localStorage.getItem('eb_milestones') || '[]'); if (!hit.includes('first-log')) { hit.push('first-log'); localStorage.setItem('eb_milestones', JSON.stringify(hit)); } } catch {}
    toast('Your sample check-in is saved to your account.');
  } catch (e) {
    // The server said no to the data itself: drop it rather than retry forever.
    // A dropped connection, a rate limit or a 5xx keeps it for the next sign-in.
    if (e && e.status >= 400 && e.status < 500 && e.status !== 429) clearGuestCheckin();
  }
}
// Default time-of-day from the user's local clock (they can still change it).
// Bands: morning 5-11, afternoon 12-16, evening 17-4.
function defaultTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  return 'evening';
}
let selectedTime = defaultTimeOfDay();
function syncTimeButtons() {
  document.querySelectorAll('.time-btn').forEach(b => b.classList.toggle('active', b.dataset.time === selectedTime));
}
let userTimezone = localStorage.getItem('eb_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;

function getTodayDate() {
  const tz = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// Parse 'YYYY-MM-DD' as a LOCAL date. new Date('YYYY-MM-DD') parses as UTC
// midnight, which renders as yesterday for anyone west of Greenwich.
function parseLocalDate(s) {
  const [y, m, d] = String(s).split('-');
  return new Date(+y, +m - 1, +d);
}

// ── Which day is this check-in for? ─────────────────────────────────────────
// Defaults to today. Yesterday is a single tap because that's the day people
// actually miss; the date input covers anything older. Capped at 30 days back
// so the form can't quietly rewrite a month of history, and the Worker enforces
// the same window (it allows one extra day of timezone slack).
const MAX_BACKFILL_DAYS = 30;
let checkinDay = 'today';   // 'today' | 'yesterday' | 'other'
let customDate = '';        // 'YYYY-MM-DD', only read when checkinDay === 'other'

// toISOString() would give the UTC day, which is the wrong one for half the
// clock. These stay in the user's local calendar, same as getTodayDate().
function fmtLocalDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shiftDays(iso, n) {
  const d = parseLocalDate(iso);
  d.setDate(d.getDate() + n);
  return fmtLocalDate(d);
}
// The date this check-in will be filed under.
function getCheckinDate() {
  if (checkinDay === 'yesterday') return shiftDays(getTodayDate(), -1);
  if (checkinDay === 'other' && customDate) return customDate;
  return getTodayDate();
}
function isBackdated() { return getCheckinDate() !== getTodayDate(); }
function prettyDate(iso) {
  return parseLocalDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
// A readable label for a zone the curated list doesn't carry, e.g.
// "Europe/Madrid" -> "Madrid (GMT+2)".
function tzLabel(tz) {
  // Etc/GMT+12 is actually UTC-12 (POSIX signs are inverted), so showing the
  // raw segment next to the true offset reads as a contradiction. Use the
  // offset alone for those.
  if (/^Etc\//.test(tz) || tz === 'UTC' || tz === 'GMT') {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || tz;
    } catch { return tz; }
  }
  const city = tz.split('/').pop().replace(/_/g, ' ');
  let offset = '';
  try {
    offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
  } catch {}
  return offset ? `${city} (${offset})` : city;
}
// Makes sure `tz` is selectable, adding it if the curated list doesn't have it,
// then selects it. Returns false when the zone isn't a real IANA id.
function ensureTzOption(sel, tz) {
  if (!tz) return false;
  for (const opt of sel.options) { if (opt.value === tz) { opt.selected = true; return true; } }
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return false; }
  const opt = document.createElement('option');
  opt.value = tz; opt.textContent = tzLabel(tz);
  sel.appendChild(opt); opt.selected = true;
  return true;
}
// fromSettings: dismissable and cancellable. First run: a gate, because the app
// has nothing to show until it knows which day "today" is.
function showTzModal(fromSettings) {
  const sel = document.getElementById('tz-select');
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Both have to be offerable. The stored one so the picker opens on the truth,
  // and the browser's so someone who has actually moved can pick where they now
  // are — otherwise a person who relocates outside the curated 13 is stuck with
  // the zone they signed up in, which is the bug this whole control exists to fix.
  ensureTzOption(sel, browserTz);
  if (!ensureTzOption(sel, fromSettings ? userTimezone : null)) ensureTzOption(sel, browserTz);
  const cancel = document.getElementById('tz-cancel-btn');
  if (cancel) cancel.hidden = !fromSettings;
  openOverlay('tz-modal', { gate: !fromSettings });
}
function openTzSettings() { showTzModal(true); }
function closeTzModal() { closeOverlay('tz-modal'); }
// The zone decides which day every check-in files under and what counts as
// today for the streak, so a change has to re-pull from the server rather than
// just re-render what's already in memory.
function renderAcctTz() {
  const el = document.getElementById('acct-tz');
  if (el) el.textContent = userTimezone || 'not set';
}
async function confirmTz() {
  const tz = document.getElementById('tz-select').value;
  const changed = userTimezone !== tz;
  userTimezone = tz;
  localStorage.setItem('eb_timezone', tz);
  // Applied locally either way, so a failed save can never trap someone behind
  // the first-run gate. But it used to fail silently, which left the app showing
  // a zone the server had not accepted; say so instead.
  let saved = true;
  try { await api('/api/profile', { method: 'PUT', body: JSON.stringify({ timezone: tz }) }); }
  catch { saved = false; }
  if (!saved) toast("Saved on this device, but we couldn't save it to your account. Try again later.");
  consumeOverlay('tz-modal');
  renderAcctTz();
  // Today, the streak and the date picker's range all move with the zone.
  if (changed && currentUser) { try { await loadCheckins(); } catch {} }
  syncCheckinDay();
  renderAll();
}

// ── What do you want to track? ──────────────────────────────────────────────
// First run: a gate (pushes nothing), same as the timezone step it replaced.
// From Account settings: a normal pushed overlay with a Cancel.
function renderAcctTrack(){
  const el=document.getElementById('acct-track');
  if(el)el.textContent=Array.isArray(trackFocus)&&trackFocus.length?trackFocus.map(k=>TRACK_LABELS[k]).join(', '):'not set';
}
function showTrackModal(fromSettings){
  document.querySelectorAll('.track-opt[data-track]').forEach(b=>b.setAttribute('aria-pressed',String(Array.isArray(trackFocus)&&trackFocus.includes(b.dataset.track))));
  const cancel=document.getElementById('track-cancel-btn');
  if(cancel)cancel.hidden=!fromSettings;
  openOverlay('track-modal',{gate:!fromSettings});
}
async function confirmTrack(){
  const picked=TRACK_KEYS.filter(k=>{const b=document.querySelector(`.track-opt[data-track="${k}"]`);return b&&b.getAttribute('aria-pressed')==='true';});
  const btn=document.getElementById('track-confirm-btn');
  if(btn)btn.disabled=true;
  try{
    await api('/api/profile',{method:'PUT',body:JSON.stringify({track_focus:picked})});
  }catch(e){
    // Applied here either way so a failed save can't trap anyone behind the gate.
    if(!e.sessionEnded)toast("Saved for now, but we couldn't save it to your account. Try again from Account settings.");
  }finally{if(btn)btn.disabled=false;}
  trackFocus=picked;
  renderAcctTrack();
  initTagPills();
  consumeOverlay('track-modal');
}

// Watt lines
const WATT_LINES = [
  "i'm literally running on<br>whatever you had for lunch.",
  "log your energy.<br>i feed on your data.",
  "stop poking me<br>and go drink some water.",
  "i'm at like 47%.<br>same tbh.",
  "meetings drain me too.<br>and i'm literally a light.",
  "exercise? never heard of her.<br>...wait, that WORKS?",
  "your patterns are showing.<br>and they're... interesting.",
  "i've seen your 3pm slumps.<br>we need to talk.",
  "click me again and<br>i'll fizzle out.",
  "sleep is just charging<br>for humans. do more of it.",
  "i carry your energy data<br>in my tail. it's a whole thing.",
  "another check-in?<br>*glows with joy*",
];
const WATT_PROGRESS = [
  {min:0,max:0,line:"no check-ins today.<br>i'm in the dark here."},
  {min:1,max:2,line:"rough day, huh?<br>let's find out why."},
  {min:3,max:4,line:"running a bit low.<br>what drained you?"},
  {min:5,max:6,line:"middle of the road.<br>could go either way."},
  {min:7,max:8,line:"looking charged up!<br>keep that energy."},
  {min:9,max:10,line:"FULLY CHARGED.<br>you absolute powerhouse."},
];

// Tiers (streak-based)
const TIERS = [
  {name:'Dead Battery',min:0,color:'#9BB3AE'},
  {name:'Flickering',min:3,color:'#FFB09F'},
  {name:'Warming Up',min:7,color:'#FF7F66'},
  {name:'Steady Current',min:14,color:'#FFC247'},
  {name:'Power Surge',min:30,color:'#6EE7B7'},
  {name:'Lightning Rod',min:60,color:'#5CD6F0'},
  {name:'Nuclear Fusion',min:100,color:'#C3A6FF'},
];
// Inline SVG bolt badge used for tier/milestone visuals (brand is SVG, never emoji)
function boltSVG(color,size){return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="${color}"/></svg>`}
function getTier(streak){for(let i=TIERS.length-1;i>=0;i--)if(streak>=TIERS[i].min)return TIERS[i];return TIERS[0]}
const IRIS_COLORS={0:'#FF5A6E',3:'#FFB09F',5:'#FF7F66',7:'#6EE7B7',9:'#5CD6F0'};
function getIrisColor(e){let c='#FF5A6E';for(const[t,col] of Object.entries(IRIS_COLORS))if(e>=+t)c=col;return c}
function getEnergyColor(e){if(e<=2)return'var(--red)';if(e<=4)return'var(--orange)';if(e<=6)return'var(--amber)';if(e<=8)return'var(--green)';return'var(--cyan)'}

// Milestones
const MILESTONES=[
  {key:'first-log',check:(s,c)=>c>=1,title:'FIRST SPARK!',msg:'Your first check-in. The battery is alive.'},
  {key:'week-streak',check:s=>s>=7,title:'ONE WEEK STREAK!',msg:'7 days of tracking. Patterns are forming.'},
  {key:'ten-checkins',check:(s,c)=>c>=10,title:'DOUBLE DIGITS!',msg:'10 check-ins. Your data is getting interesting.'},
  {key:'two-week',check:s=>s>=14,title:'STEADY CURRENT!',msg:'14-day streak. You really know yourself now.'},
  {key:'month-streak',check:s=>s>=30,title:'POWER SURGE!',msg:'30 days straight. Your patterns are crystal clear.'},
  {key:'fifty',check:(s,c)=>c>=50,title:'HALF CENTURY!',msg:'50 check-ins. Self-awareness machine.'},
  {key:'hundred',check:(s,c)=>c>=100,title:'NUCLEAR FUSION!',msg:'100 check-ins. Total self-knowledge, achieved.'},
];

// ---------------------------------------------------------------------------
// TIPS and NUDGES are deliberately SEPARATE. Help with the app
// is not a promo and must never take a promo's slot, or the promo surface just
// isn't one that day. TIPS teach the app. NUDGES sell something.
// ---------------------------------------------------------------------------
// App help. Rotates daily in #app-tip, above the promo card. No links, no
// labels, nothing to disclose. `act` runs a small in-app action.
const TIPS = [
  { text: 'Two or three check-ins a day beats one. One says today was a 6; three say you were a 3 by noon and an 8 after lunch.', cta: 'Log a check-in', act: 'go-checkin' },
  { text: 'The battery is today\'s average across your check-ins, not your last one. A rough morning and a good evening land in the middle.', cta: 'See my battery', act: 'go-battery' },
  { text: 'Your streak counts days you logged anything at all. A 2 out of 10 day still keeps it alive, and those days are the most useful data you have.', cta: 'See my battery', act: 'go-battery' },
  { text: 'Tag what really happened. If caffeine and screen time were involved, tap them. The tags only tell you something if they are true.', cta: 'Log a check-in', act: 'go-checkin' },
  { text: 'The charged and drained boxes are optional, but they are where the specific stuff lives that tags cannot hold.', cta: 'Log a check-in', act: 'go-checkin' },
  { text: 'Glow dims and brightens with your day. Click her when you want an opinion.', cta: 'Poke Glow', act: 'poke-watt' },
  { text: 'Everything in the app is explained in one place, with pictures.', cta: 'Open how it works', act: 'open-help' },
];
function renderAppTip(){
  const slot = document.getElementById('app-tip');
  if (!slot) return;
  const t = TIPS[Math.floor(Date.now()/86400000) % TIPS.length];
  slot.innerHTML = `<div class="tip-card help-tip"><div class="tip-text">${esc(t.text)}</div>`+
    `<button type="button" class="tip-cta" data-action="tip-act" data-tip-act="${esc(t.act)}">${esc(t.cta)} &rarr;</button></div>`;
}
// The CTA on an app-help tip. Never navigates off-site; that is what a promo does.
function runTipAction(act){
  switch(act){
    case 'go-checkin': goCheckinTappedAt=Date.now(); goTab('checkin'); break;
    // The tip card lives on the Battery panel, so "See my battery" is usually
    // clicked while already there and goTab() no-ops. Scroll to the battery
    // itself so the button always does something visible.
    case 'go-battery': { goTab('battery'); const b=document.getElementById('battery-wrap'); if(b)b.scrollIntoView({block:'center',behavior:'smooth'}); break; }
    case 'poke-watt': { const w=document.getElementById('wattWrap'); if(w){w.scrollIntoView({block:'center',behavior:'smooth'});w.click();} break; }
    case 'open-help': openHelp(); break;
  }
}

// Promos only: Jen Built It's own apps and posts. Swap in your own.
const GENERAL_NUDGES=[
  {text:'Your energy patterns show what habits work. Track those habits too with Dopamine Dealer, the fun habit tracker.',link:'https://dopaminedealerhabits.com/',cta:'Try Dopamine Dealer'},
  {text:'Knowing your patterns is half the battle. Building daily habits is the other half.',link:'https://dopaminedealerhabits.com/',cta:'Build habits with Dopamine Dealer'},
  {text:'Cancelling unused subscriptions frees up mental energy too. See how much you\'re wasting.',link:'https://subscriptiongraveyard.app',cta:'Try Subscription Graveyard'},
  {text:'Side hustle income can fund the lifestyle that keeps your energy high.',link:'https://sidehustlegarden.com/',cta:'Try Side Hustle Garden'},
  {text:'An emergency fund removes financial stress, one of the biggest energy drains.',link:'https://emergencyfundaquarium.com',cta:'Try Emergency Fund Aquarium'},
  {text:'Battery stuck low for days? Jen, the app\'s maker, wrote about climbing out of a funk with one small fix in each part of life at once.',link:'https://seedingserendipity.com/how-to-get-out-of-a-funk/',cta:'Read: out of a funk'},
  {text:'If your job is draining your battery faster than anything else, the path off it usually starts with a tighter resume.',link:'https://resumeprune.com/',cta:'Try Resume Prune'},
  {text:'A low battery does not mean you are done for the day. Here is how to keep going when you are tired.',link:'https://seedingserendipity.com/how-to-be-consistent-when-tired/',cta:'Read: consistent when tired'},
  {text:'Running low and feeling behind everyone else? Read this before you push harder.',link:'https://seedingserendipity.com/what-to-do-when-you-feel-behind/',cta:'Read: feeling behind'},
  {text:'The drains that wreck a day usually start small. Jen, the app\'s maker, wrote up how to catch them before they spiral.',link:'https://seedingserendipity.com/low-vibration-habits/',cta:'Read: catch the drains'},
  {text:'A low-battery day is a good day for set-it-once work. Build a link in bio and leave it running.',link:'https://buildabio.com',cta:'Try Build a Bio'},
];
function isAff(url){if(!url)return false;const own=['dopaminedealerhabits.com','sidehustlegarden.com','subscriptiongraveyard.app','emergencyfundaquarium.com','energybattery.app','jen8ndirectory.com','resumeprune.com','jenbuiltit.com','jen8n.com','seedingserendipity.com','jentriedit.com','buildabio.com','giveawaywidget.com','porchpile.com','adminarcade.com','recipecolumncards.com','questmytasks.com'];return !own.some(d=>url.includes(d));}
// No nudge on 'first-log' — the first-ever check-in celebration stays promo-free.
const MILESTONE_NUDGES={
  'week-streak':{text:'7-day streak! You clearly know how to stay consistent. Track your habits too.',link:'https://dopaminedealerhabits.com/',cta:'Try Dopamine Dealer'},
  'month-streak':{text:'30 days! Your patterns are clear. Turn your best energy habits into a daily routine.',link:'https://dopaminedealerhabits.com/',cta:'Lock in habits with Dopamine Dealer'},
};

// Helpers
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function toast(msg){const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000)}
function syncStatus(state){
  const dot=document.getElementById('sync-dot'),txt=document.getElementById('sync-txt');
  if(state==='syncing'){dot.style.background='var(--volt)';txt.textContent='Syncing...';}
  else if(state==='error'){dot.style.background='var(--blood)';txt.textContent='Error';}
  else{dot.style.background='var(--green)';txt.textContent='Synced';}
}
async function api(path,opts={}){
  syncStatus('syncing');
  try{
    const hubPro=localStorage.getItem('hub_pro_jwt');
    const r=await fetch(API+path,{...opts,credentials:'same-origin',headers:{'Content-Type':'application/json',...(hubPro?{'X-Hub-Pro':hubPro}:{}),...opts.headers}});
    const d=await r.json().catch(()=>({}));
    // Auth endpoints handle their own 401s (wrong password must show an inline
    // error, not silently reload the page). Only treat 401 as an expired or
    // revoked session on non-auth routes, and end it in place with one plain
    // message instead of reloading over a stale app.
    if(r.status===401&&!path.startsWith('/api/auth/')){sessionEnded();const err=new Error(SESSION_ENDED_MSG);err.sessionEnded=true;throw err;}
    if(!r.ok){const err=new Error(d.error||(r.status>=500?'Something went wrong on our end. Try again in a minute.':'Something went wrong. Try again.'));err.status=r.status;if(d.code)err.code=d.code;if(d.email)err.email=d.email;throw err;}
    syncStatus('ok');return d;
  }catch(e){
    // An expected Pro gate (402) is not a sync failure — keep the dot green.
    if(e&&e.status===402)syncStatus('ok');
    else syncStatus('error');
    // fetch() rejects with "Failed to fetch" / "NetworkError ..." when the
    // connection drops, and that raw string reached the user through
    // toast(e.message) — verified live by cutting the network mid-check-in.
    // Translate connection failures into something actionable; real API
    // error messages pass through untouched.
    if(e instanceof TypeError||/failed to fetch|networkerror|load failed/i.test((e&&e.message)||'')){
      const ne=new Error(NET_ERR);
      ne.offline=true; ne.network=true; throw ne;
    }
    throw e;
  }
}
const NET_ERR="Couldn't reach the server. Check your connection and try again.";
const SESSION_ENDED_MSG='Your session ended. Log in again.';
// A session that is no longer good (expired, or revoked by a password change or
// reset elsewhere) ends in place: every overlay closed, the login screen shown,
// one plain message. No reload, so the message survives and a session cookie the
// server already rejected is cleared, not replayed.
let sessionEnding=false;
function sessionEnded(){
  if(!currentUser||sessionEnding)return;
  sessionEnding=true;
  try{closeAllOverlays();}catch{/* nothing open */}
  currentUser=null;
  // The dead cookie is HttpOnly, so only the server can clear it.
  fetch(API+'/api/auth/logout',{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{});
  try{localStorage.removeItem('eb_token');}catch{}
  localStorage.removeItem('hub_pro_jwt');
  hideFeedbackWidget();
  document.getElementById('app-outer').style.display='none';
  document.getElementById('auth-screen').style.display='';
  showLoadBanner('');
  currentAuthView='login';
  authTab('login',true);
  pushAuthView('login',true);
  const el=document.getElementById('auth-err');el.textContent=SESSION_ENDED_MSG;el.style.display='block';
  document.getElementById('auth-suc').style.display='none';
  sessionEnding=false;
}
function showLoadBanner(msg){
  const b=document.getElementById('load-banner'),t=document.getElementById('load-banner-msg');
  if(!b||!t)return;
  t.textContent=msg;b.style.display=msg?'flex':'none';
}

let proFiltered=false;
// Free stats served by /api/checkins — streak and total are NOT Pro features.
let stats={current_streak:0,total_checkins:0};
let isProUser=false;

// ---------------------------------------------------------------------------
// Hub Pro token refresh. Stripe renewals cap the hub JWT's exp at the billing
// period end, so a renewing subscriber's cached token dies right when they
// renew. On-demand only (init + one retry on a gated 402), never polled.
// ---------------------------------------------------------------------------
let proRefreshTried=false;   // at most one refresh+retry per gated 402 session
let proPaused=false;         // previously-Pro token failed to refresh
function decodeJwtPayload(t){
  try{
    const p=String(t).split('.')[1];
    const s=p.replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(atob(s+'='.repeat((4-s.length%4)%4)));
  }catch{return null;}
}
// Returns 'refreshed' | 'invalid' | 'error'. On 'error' (network/429/5xx) we
// leave the stored token alone — current behavior, nothing gets worse.
async function refreshHubToken(){
  const t=localStorage.getItem('hub_pro_jwt');
  if(!t)return 'error';
  try{
    const r=await fetch(API+'/api/pro-refresh',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});
    if(r.status===429||r.status>=500)return 'error';
    const d=await r.json().catch(()=>null);
    if(d&&d.valid===true&&typeof d.token==='string'){localStorage.setItem('hub_pro_jwt',d.token);proPaused=false;return 'refreshed';}
    if(d&&d.valid===false){
      // Hub says no entitlement: drop the dead token, fall back to free.
      const payload=decodeJwtPayload(t);
      const wasPro=!!(payload&&payload.pro_until)||!!localStorage.getItem('eb_was_pro');
      localStorage.removeItem('hub_pro_jwt');
      proPaused=wasPro;
      return 'invalid';
    }
    return 'error';
  }catch{return 'error';}
}
// Init-time check: if the stored hub token is expired or within 60s of it,
// refresh before hub-sso / pro-status ever see it.
async function ensureFreshHubToken(){
  const t=localStorage.getItem('hub_pro_jwt');
  if(!t)return;
  const payload=decodeJwtPayload(t);
  const exp=payload&&typeof payload.exp==='number'?payload.exp:0;
  if(exp-Math.floor(Date.now()/1000)>60)return; // still fresh
  await refreshHubToken();
}
async function loadCheckins(){
  const data=await api('/api/checkins?days=90');
  // Backend returns {items, pro_filtered, current_streak, total_checkins}
  checkins=Array.isArray(data)?data:(data.items||[]);
  proFiltered=!!data.pro_filtered;
  stats.current_streak=Number(data.current_streak)||0;stats.backup=data.backup||null;
  stats.total_checkins=Number(data.total_checkins)||checkins.length;
  return data;
}
function lockedPatterns(){
  return {locked:true,current_streak:stats.current_streak,total_checkins:stats.total_checkins};
}
// The Recharge Menu rides on the Pro state loadPatterns() has already settled,
// so it never needs its own refresh-and-retry dance.
let rechargeMenu = null;
async function loadRechargeMenu(){
  if(!isProUser){rechargeMenu={locked:true};return;}
  try{ rechargeMenu=await api('/api/recharge-menu'); }
  catch(e){
    if(e.status===402||/Pro required/i.test(e.message||'')){rechargeMenu={locked:true};return;}
    rechargeMenu={error:true};
  }
}
async function loadPatterns(){
  // Patterns is Pro-gated. Free users skip the call entirely (a 402 here is
  // expected, not an error) — streak/totals come from the check-ins response.
  if(!isProUser){patterns=lockedPatterns();return;}
  try{
    patterns=await api('/api/patterns');
  }catch(e){
    if(e.status===402||/Pro required/i.test(e.message||'')){
      // Pro-rejected WITH a token present (this path only runs for users we
      // believed were Pro): one refresh + retry, then stop.
      if(e.status===402&&localStorage.getItem('hub_pro_jwt')&&!proRefreshTried){
        proRefreshTried=true;
        if(await refreshHubToken()==='refreshed'){
          try{patterns=await api('/api/patterns');return;}
          catch(e2){if(e2.status!==402&&!/Pro required/i.test(e2.message||''))throw e2;}
        }
      }
      // Still gated: treat as free for the rest of the session so no further
      // expected-402 calls fire (free users must never call /api/patterns).
      isProUser=false;
      proPaused=true;
      patterns=lockedPatterns();
      hydrateProStatus();
    }
    else throw e;
  }
}

async function hydrateProStatus(){
  try{
    const hubPro=localStorage.getItem('hub_pro_jwt');
    const r=await fetch(API+'/api/pro-status',{credentials:'same-origin',headers:{...(hubPro?{'X-Hub-Pro':hubPro}:{})}});
    const data=await r.json();
    isProUser=!!data.is_pro;
    proAvailable=data.pro_available===true;
    proUpgradeUrl=(proAvailable&&typeof data.upgrade_url==='string'&&/^https?:\/\//i.test(data.upgrade_url))?data.upgrade_url:'';
    proPriceText=(proAvailable&&typeof data.pro_price_text==='string')?data.pro_price_text:'';
    applyProAvail();
    feedbackAvailable=data.feedback_available===true;
    if(feedbackAvailable&&feedbackWanted)showFeedbackWidget();
    const proRegion=document.getElementById('pro-badge-region');
    const unlockBtn=document.getElementById('unlock-pro-btn');
    if(!proRegion||!unlockBtn)return;
    if(data.is_pro){
      proPaused=false;
      try{localStorage.setItem('eb_was_pro','1');}catch{}
      proRegion.classList.add('show');
      unlockBtn.style.display='none';
      if(data.pro_until){
        document.getElementById('pro-until-text').textContent='through '+new Date(data.pro_until).toLocaleDateString();
      }
    }else{
      proRegion.classList.remove('show');
      unlockBtn.style.display=(proAvailable&&!proUpgradeUrl)?'none':'inline-block';
    }
  }catch(e){console.error('Pro hydrate failed:',e);}
}

// Auth
// Single history-state helper for the pre-auth screen (login/signup toggle +
// verify-code step). `replace` is true only for the initial landing (wired in
// init()) so the very first Back still leaves the site.
function pushAuthView(view,replace){
  const state={authView:view,mode:authMode,email:pendingVerifyEmail};
  const url=location.pathname+location.search;
  if(replace)history.replaceState(state,'',url);else history.pushState(state,'',url);
}
// authTab() is the choke point for the pre-auth login/signup toggle — it also
// doubles as the "back to normal" reset from the verify-code step (existing
// behavior, unchanged). `fromHistory` is set only by the popstate handler
// below (restoring a prior step) — it skips the pushState call so restoring
// never re-pushes (loop guard).
function authTab(mode,fromHistory){
  if(!fromHistory&&mode===currentAuthView)return; // no-op: already on this tab
  showGuestBox(false);
  currentAuthView=mode;
  authMode=mode;
  document.querySelectorAll('.auth-tab').forEach((t,i)=>t.classList.toggle('active',(mode==='login'?i===0:i===1)));
  document.getElementById('auth-submit-btn').textContent=mode==='login'?'Log In':'Sign Up';
  document.getElementById('auth-err').style.display='none';
  document.getElementById('auth-suc').style.display='none';
  // Confirm-password only matters on sign up. Hide + clear it on login so a
  // stale value can't block a later sign up.
  const pw2Wrap=document.getElementById('auth-pw2-wrap');
  if(pw2Wrap)pw2Wrap.style.display=mode==='signup'?'block':'none';
  const pw2=document.getElementById('auth-pw2');
  if(pw2&&mode==='login')pw2.value='';
  const pwHint=document.getElementById('auth-pw-hint');
  if(pwHint)pwHint.style.display=mode==='signup'?'block':'none';
  const consent=document.getElementById('signup-consent');
  if(consent)consent.style.display=mode==='signup'?'block':'none';
  document.getElementById('auth-pw').autocomplete=mode==='login'?'current-password':'new-password';
  // Restore password form if a code prompt was open.
  document.getElementById('auth-form').style.display='';
  const cb=document.getElementById('code-box');if(cb)cb.style.display='none';
  const fb=document.getElementById('forgot-btn');if(fb)fb.style.display='';
  if(!fromHistory)pushAuthView(mode);
}
// ── Guest views ('try' -> 'result') ─────────────────────────────────────────
// Same history pattern as the auth steps: replaceState for the landing view,
// pushState per move in, popstate restores through showGuest(view, fromHistory).
let guestView=null;
let guestTags=[];
function showGuestBox(on){
  const g=document.getElementById('guest-box'),a=document.getElementById('auth-box');
  if(g)g.hidden=!on;if(a)a.hidden=on;
  if(!on){
    guestView=null;
    const pending=!!readGuestCheckin();
    const note=document.getElementById('guest-carry-note');if(note)note.hidden=!pending;
    const link=document.getElementById('guest-try-link');if(link)link.hidden=pending;
  }
}
function showGuest(view,opts={}){
  const {replace=false,fromHistory=false}=opts;
  if(view!=='try'&&view!=='result')view='try';
  if(view==='result'&&!readGuestCheckin())view='try';
  if(!fromHistory&&!replace&&view===guestView)return; // no-op: already here
  showGuestBox(true);
  guestView=view;
  document.getElementById('guest-try').hidden=view!=='try';
  document.getElementById('guest-result').hidden=view!=='result';
  if(view==='try')renderGuestTry();else renderGuestResult();
  if(!fromHistory){
    const st={guestView:view},url=location.pathname+location.search;
    if(replace)history.replaceState(st,'',url);else history.pushState(st,'',url);
  }
}
function renderGuestTry(){
  const pills=document.getElementById('guest-tag-pills');
  if(pills)pills.innerHTML=TAGS.map(t=>`<button type="button" class="tag-pill${guestTags.includes(t)?' active':''}" data-action="guest-tag" data-tag="${esc(t)}" aria-pressed="${guestTags.includes(t)}">${TAG_LABELS[t]}</button>`).join('');
  syncGuestSlider();
}
function syncGuestSlider(){
  const v=+document.getElementById('guest-energy').value||5;
  const el=document.getElementById('guest-energy-val');el.textContent=v;el.style.color=getEnergyColor(v);
  document.getElementById('guest-glow-try').innerHTML=glowSvg(v/10,'gtry',72,108);
}
function toggleGuestTag(el,tag){
  if(!TAGS.includes(tag))return;
  guestTags=guestTags.includes(tag)?guestTags.filter(t=>t!==tag):guestTags.concat(tag);
  el.classList.toggle('active',guestTags.includes(tag));
  el.setAttribute('aria-pressed',String(guestTags.includes(tag)));
}
function guestFill(){
  const energy=Math.min(10,Math.max(1,parseInt(document.getElementById('guest-energy').value,10)||5));
  saveGuestCheckin({v:1,energy,tags:guestTags.filter(t=>TAGS.includes(t)),time:defaultTimeOfDay(),date:getTodayDate(),at:Date.now()});
  showGuest('result');
}
function renderGuestResult(){
  const g=readGuestCheckin();if(!g)return;
  const fill=document.getElementById('guest-battery-fill');
  fill.style.background=batteryGradient(g.energy);
  fill.style.height='0%';
  // Two frames so the browser paints the empty battery before it fills.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{fill.style.height=(g.energy*10)+'%';}));
  const pct=document.getElementById('guest-battery-pct');pct.textContent=g.energy+' / 10';pct.style.color=getEnergyColor(g.energy);
  document.getElementById('guest-glow-result').innerHTML=glowSvg(g.energy/10,'gres',72,108);
  const lines=glowReaction({energy:g.energy,date:g.date,time:g.time,tags:g.tags},[]);
  document.getElementById('guest-bubble').textContent=lines.join(' ');
  if(g.energy>=7){const r=fill.getBoundingClientRect();setTimeout(()=>burst(r.left+r.width/2,r.top,10),500);}
}
// Change my answer: back to the form with what they picked last time.
function guestRedo(){
  const g=readGuestCheckin();
  if(g){document.getElementById('guest-energy').value=g.energy;guestTags=g.tags.slice();}
  showGuest('try');
}
// Out of the guest flow into the auth card. Clearing currentAuthView defeats
// authTab()'s no-op guard so the move always gets its own history entry.
function leaveGuestTo(mode){
  currentAuthView=null;
  authTab(mode==='signup'?'signup':'login');
}
// Landing on the auth card itself (replaceState, so Back still leaves the site).
function landAuth(mode){
  currentAuthView=null;
  authTab(mode,true);
  pushAuthView(mode,true);
}

// Email pending code verification (set when signup/login asks for a code).
let pendingVerifyEmail='';
// Password typed at signup/login, kept in memory ONLY (never localStorage or
// sessionStorage) so verify-code can send it with the code. The server needs
// both: the code proves the inbox, the password proves who set the account
// up. After a reload it's gone, so the code box shows its own password field.
let pendingVerifyPw='';
function syncCodePwField(){
  const w=document.getElementById('code-pw-wrap');if(!w)return;
  w.style.display=pendingVerifyPw?'none':'block';
  if(pendingVerifyPw)document.getElementById('code-pw').value='';
}
// Show the 6-digit code box and hide the password form. Same fromHistory/
// no-op-guard/push pattern as authTab() above — this is the verify-code step.
const MAIL_FAIL_MSG="We couldn't send your code right now. Try Resend code in a minute, or contact support.";
function showCodeBox(email,msg,fromHistory,mailFailed){
  if(!fromHistory&&currentAuthView==='verify')return; // no-op: already showing verify
  showGuestBox(false);
  currentAuthView='verify';
  pendingVerifyEmail=email;
  document.getElementById('auth-form').style.display='none';
  const fb=document.getElementById('forgot-btn');if(fb)fb.style.display='none';
  document.getElementById('code-box').style.display='block';
  syncCodePwField();
  const s=document.getElementById('auth-suc');const errEl=document.getElementById('auth-err');
  // mailFailed is set only when Resend refused the message; say so instead of
  // promising an inbox that has nothing in it.
  if(mailFailed){errEl.textContent=MAIL_FAIL_MSG;errEl.style.display='block';s.style.display='none';}
  else{s.textContent=msg||('We sent a 6-digit code to '+email+'. Enter it below.');s.style.display='block';errEl.style.display='none';}
  const c=document.getElementById('auth-code');c.value='';c.focus();
  if(!fromHistory)pushAuthView('verify');
}
async function authSubmit(e){
  e.preventDefault();const btn=document.getElementById('auth-submit-btn');const errEl=document.getElementById('auth-err');
  btn.disabled=true;errEl.style.display='none';
  try{
    const email=document.getElementById('auth-email').value;
    const body={email,password:document.getElementById('auth-pw').value};
    // Inline validation (form is novalidate so errors render in-page, not as
    // browser-native tooltips).
    if(!email.trim()||!body.password){
      errEl.textContent='Please enter your email and password.';errEl.style.display='block';btn.disabled=false;return;
    }
    if(authMode==='signup'&&(body.password.length<10||body.password.length>200)){
      errEl.textContent='Password must be 10–200 characters.';errEl.style.display='block';btn.disabled=false;return;
    }
    if(authMode==='signup'&&body.password!==(document.getElementById('auth-pw2')||{}).value){
      errEl.textContent='Passwords do not match. Please re-type them.';errEl.style.display='block';btn.disabled=false;return;
    }
    const d=await api(`/api/auth/${authMode}`,{method:'POST',body:JSON.stringify(body)});
    if(d.awaiting_verification)pendingVerifyPw=body.password;
    // The login response may carry a hub Pro token (Pro follows the account,
    // not the browser) — same localStorage slot as the ?hubpro= hand-off.
    if(d&&d.hub_pro_token)localStorage.setItem('hub_pro_jwt',d.hub_pro_token);
    if(d.user){currentUser=d.user;carryGuestOnEntry=true;enterApp(authMode==='signup');}
    else if(d.awaiting_verification){showCodeBox(d.email||email,undefined,false,d.email_sent===false);}
    else{const s=document.getElementById('auth-suc')||errEl;s.textContent=d.message||'If that email is new, check your inbox for a verification code.';s.style.display='block';}
  }catch(e){
    if(e.code==='email_not_verified'){pendingVerifyPw=document.getElementById('auth-pw').value;showCodeBox(e.email||document.getElementById('auth-email').value,'Please verify your email. Enter the 6-digit code we sent you.');}
    else{errEl.textContent=e.message;errEl.style.display='block';}
  }
  btn.disabled=false;
}
async function submitCode(){
  const btn=document.getElementById('verify-code-btn');const errEl=document.getElementById('auth-err');
  const code=document.getElementById('auth-code').value.replace(/\D/g,'');
  errEl.style.display='none';
  if(code.length!==6){errEl.textContent='Enter the 6-digit code from your email.';errEl.style.display='block';return;}
  const pwBox=document.getElementById('code-pw');
  const password=pendingVerifyPw||(pwBox?pwBox.value:'');
  if(!password){syncCodePwField();errEl.textContent='Enter your password along with the code.';errEl.style.display='block';if(pwBox)pwBox.focus();return;}
  btn.disabled=true;
  try{
    const d=await api('/api/auth/verify-code',{method:'POST',body:JSON.stringify({email:pendingVerifyEmail,code,password})});
    pendingVerifyPw='';
    if(d&&d.hub_pro_token)localStorage.setItem('hub_pro_jwt',d.hub_pro_token);
    if(d.user){currentUser=d.user;carryGuestOnEntry=true;enterApp(true);}
  }catch(e){
    // Wrong password: drop the remembered one and show the field so they can retype it.
    if(/password/i.test(e.message||'')){pendingVerifyPw='';syncCodePwField();}
    errEl.textContent=e.message;errEl.style.display='block';
  }
  btn.disabled=false;
}
async function resendCode(){
  const errEl=document.getElementById('auth-err');errEl.style.display='none';
  try{
    const d=await api('/api/auth/resend-code',{method:'POST',body:JSON.stringify({email:pendingVerifyEmail})});
    const s=document.getElementById('auth-suc');
    if(d&&d.email_sent===false){errEl.textContent=MAIL_FAIL_MSG;errEl.style.display='block';s.style.display='none';return;}
    s.textContent='A new code is on its way. Check your inbox.';s.style.display='block';
  }catch(e){errEl.textContent=e.message;errEl.style.display='block';}
}
function forgotPw(){
  const email=document.getElementById('auth-email').value;
  if(!email){const e=document.getElementById('auth-err');e.textContent='Enter your email first';e.style.display='block';return;}
  api('/api/auth/reset-request',{method:'POST',body:JSON.stringify({email})});
  const s=document.getElementById('auth-suc');s.textContent='If that email exists, a reset link has been sent.';s.style.display='block';
}
// Reset token comes from the PATH (/reset/<token>). The old ?reset=<token>
// form is still read so links already sitting in inboxes keep working, but it
// is not what we send any more — see the QP note in the worker.
function getResetToken(){
  const m = location.pathname.match(/^\/reset\/([A-Za-z0-9._-]{16,256})\/?$/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get('reset');
}
async function confirmReset(){
  const pw=document.getElementById('reset-pw').value;const resetToken=getResetToken();
  try{const d=await api('/api/auth/reset-confirm',{method:'POST',body:JSON.stringify({token:resetToken,password:pw})});
    if(d&&d.hub_pro_token)localStorage.setItem('hub_pro_jwt',d.hub_pro_token);
    currentUser=d.user;document.getElementById('reset-screen').style.display='none';enterApp(false);
  }catch(e){const el=document.getElementById('reset-err');el.textContent=e.message;el.style.display='block';}
}
// The hub Pro token is a credential too: init() exchanges it for a session
// through hub-sso, so leaving it behind meant "log out" silently logged the
// user straight back in on the next load.
function logout(){currentUser=null;
  clearGuestCheckin();
  try{localStorage.removeItem('eb_token');}catch{}
  localStorage.removeItem('hub_pro_jwt');hideFeedbackWidget();
  // The server clears the HttpOnly cookie (the page can't). keepalive lets
  // it finish even if the user closes the tab right after. The reload waits
  // for it: reloading first would let the boot /api/me see the old cookie
  // and sign the user straight back in.
  fetch(API+'/api/auth/logout',{method:'POST',credentials:'same-origin',keepalive:true}).catch(()=>{}).finally(()=>location.reload());
}

// Enter App
async function enterApp(isNew){
  hideBootScreen();
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app-outer').style.display='grid';
  showFeedbackWidget();
  await loadAppData(isNew);
}
// The first data load. When it fails for any reason other than the session
// ending, the shell is not left half-rendered with a red sync dot and nothing
// else: a banner says what happened and Retry runs this again.
async function loadAppData(isNew){
  try{
    showLoadBanner('');
    currentUser=await api('/api/profile');
    // Footer "Account settings" — show who's signed in
    const acctEmailEl=document.getElementById('acct-email');
    if(acctEmailEl&&currentUser.email)acctEmailEl.textContent=currentUser.email;
    // Load timezone from profile
    if(currentUser.timezone){userTimezone=currentUser.timezone;localStorage.setItem('eb_timezone',userTimezone);}
    // New accounts are created on the server's default zone. The browser knows
    // the real one, so use it instead of asking. Account settings can change it.
    if(isNew){
      const browserTz=Intl.DateTimeFormat().resolvedOptions().timeZone;
      let tzOk=false;try{new Intl.DateTimeFormat('en-US',{timeZone:browserTz});tzOk=!!browserTz;}catch{}
      if(tzOk&&browserTz!==currentUser.timezone){
        userTimezone=browserTz;localStorage.setItem('eb_timezone',browserTz);
        try{await api('/api/profile',{method:'PUT',body:JSON.stringify({timezone:browserTz})});currentUser.timezone=browserTz;}catch{}
      }
    }
    renderAcctTz();
    trackFocus=Array.isArray(currentUser.track_focus)?currentUser.track_focus:null;
    renderAcctTrack();
    if(carryGuestOnEntry){carryGuestOnEntry=false;await carryGuestCheckin();}
    await hydrateProStatus();
    await loadCheckins();
    await loadPatterns();
    await loadRechargeMenu();
    if(isNew){
      openOverlay('onboard-overlay', { gate: true });
    } else if(!localStorage.getItem('eb_timezone')){
      showTzModal();
    } else {
      // Gates are done for this user, so the tour has the screen to itself.
      setTimeout(maybeOfferTour, 400);
    }
    scheduleBlink();initTagPills();
    // A refresh must leave you on the tab you were looking at. Browsers keep
    // history.state across a reload for the same entry, so goTab()'s pushState
    // is still there — read it back first. Without this, refreshing on Check In
    // bounced the user to Battery .
    //
    // Only then fall back to a default: new users land on Check In (the HTML
    // default) so they add data immediately instead of scrolling past empty
    // screens; returning users see their Battery.
    //
    // landTab() always replaceState()s the landing tab (never pushState) so
    // the very first Back still leaves the app, regardless of which tab it is.
    // (Also does the renderAll() this block used to do directly.)
    landTab(TABS.includes(BOOT_VIEW) ? BOOT_VIEW : (isNew ? 'checkin' : 'battery'));
  }catch(e){
    if(e.sessionEnded)return;
    console.error(e);
    showLoadBanner(e.network?NET_ERR:"Your battery didn't load. "+e.message);
  }
}

// Tabs
// applyTab() is the shared DOM-render step for both goTab() (real navigation,
// pushes/no-ops through history) and landTab() (one-time boot landing,
// replaceState only). Keeping the DOM work in one place means there is a
// single choke point for what "switching to tab X" actually does.
function applyTab(name){
  // Celebration UI never persists across tab switches
  closeCeleb();
  document.querySelectorAll('.dep-popup').forEach(el=>el.remove());
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));
  renderAll();
}
const TABS=['checkin','battery','log','patterns'];
// Single choke point for main-tab navigation. `fromHistory` is set only by
// the popstate handler below (restoring a prior tab) — it skips the
// pushState call so restoring never re-pushes (loop guard).
// A fast double-tap on the Battery tab's "Log a Check-In" switches tabs on
// tap 1 and lands tap 2 on "Log It". submitCheckin ignores taps that arrive
// right after THAT button only (not every tab switch: a quick real tap on Log It
// after picking the tab must still save).
let goCheckinTappedAt=0;
function goTab(name,fromHistory){
  if(!TABS.includes(name))name='checkin';
  if(!fromHistory&&name===currentTab)return; // no-op: already on this tab, don't push a duplicate entry
  currentTab=name;
  applyTab(name);
  if(!fromHistory)history.pushState({view:name},'',location.pathname+location.search);
}
// Called once per app entry (enterApp) to establish the landing tab.
// Always replaceState()s so the very first Back still leaves the app.
function landTab(name){
  if(!TABS.includes(name))name='checkin';
  currentTab=name;
  applyTab(name);
  history.replaceState({view:name},'',location.pathname+location.search);
}

// Today's data
function getTodayCheckins(){const today=getTodayDate();return checkins.filter(c=>c.checkin_date===today)}
function getTodayAvg(){const tc=getTodayCheckins();if(!tc.length)return 0;return Math.round(tc.reduce((s,c)=>s+c.energy_level,0)/tc.length*10)/10}

// Render All
function renderAll(){
  const avg=getTodayAvg();
  const streak=Number(patterns?.current_streak??stats.current_streak)||0;
  renderBattery(avg);renderLog();renderPatterns();renderRechargeMenu();renderHandMeOne(avg);renderAppTip();renderDailyTip();renderTodaySummary();renderRecap(avg,streak);syncWatt(avg);
  // Streak bar
  const tier=getTier(streak);const nextTier=TIERS.find(t=>t.min>streak);
  const pct=nextTier?((streak-tier.min)/(nextTier.min-tier.min)*100):100;
  document.getElementById('streakFill').style.width=Math.min(pct,100)+'%';
  document.getElementById('streakLabel').textContent=streak+' day'+(streak!==1?'s':'');renderBackupCell();renderFreeInsight();
}

// Battery Visual
function batteryGradient(avg){return avg<=2?'linear-gradient(0deg,#FF5A6E,#FF5A6E)':avg<=4?'linear-gradient(0deg,#E85F45,#FFB09F)':avg<=6?'linear-gradient(0deg,#E85F45,#FFC247)':avg<=8?'linear-gradient(0deg,#6EE7B7,#6EE7B7)':'linear-gradient(0deg,#5CD6F0,#5CD6F0)';}
function renderBattery(avg){
  const fillPct=avg>0?avg*10:0;
  const fill=document.getElementById('battery-fill');
  fill.style.height=fillPct+'%';
  fill.style.background=batteryGradient(avg);
  document.getElementById('battery-pct').textContent=avg>0?avg.toFixed(1)+' / 10':'--';
  document.getElementById('battery-pct').style.color=avg>0?getEnergyColor(avg):'var(--muted)';
  // No emoji icons — the fill height + "X / 10" already show the level (brand is SVG, not emoji).
  document.getElementById('battery-icons').innerHTML='';
  // Fully charged state
  document.getElementById('battery-wrap').classList.toggle('fully-charged',avg>=9.5);
}

// Today Summary
function renderTodaySummary(){
  const tc=getTodayCheckins();
  if(!tc.length){document.getElementById('today-summary').innerHTML='<div class="empty-state" style="padding:1rem">no check-ins yet today</div>';return;}
  const avg=(tc.reduce((s,c)=>s+c.energy_level,0)/tc.length).toFixed(1);
  const times=tc.map(c=>c.time_of_day);
  const badges=tc.map(c=>`<span style="display:inline-block;background:${getEnergyColor(c.energy_level)};color:#fff;font-family:'Fredoka One',cursive;font-size:.7rem;width:26px;height:26px;line-height:26px;text-align:center;border-radius:8px">${c.energy_level}</span>`).join('');
  document.getElementById('today-summary').innerHTML=`<div style="text-align:center;padding:8px 0"><div style="display:flex;justify-content:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">${badges}</div><div style="font-size:.75rem;color:var(--muted)">${tc.length} check-in${tc.length>1?'s':''} today &middot; avg ${avg}</div></div>`;
}

// Log
// Read-only recap for the >=1440 data column. Renders unconditionally — the
// column is display:none below that breakpoint, so there is no width probe to
// keep in sync with the CSS.
function renderRecap(avg,streak){
  const stats=document.getElementById('recap-stats');
  const list=document.getElementById('recap-list');
  if(!stats||!list)return;
  const todayCount=getTodayCheckins().length;
  const week=checkins.slice(0,7);
  const weekAvg=week.length?Math.round(week.reduce((s,c)=>s+c.energy_level,0)/week.length*10)/10:0;
  const rows=[
    ['Today', avg>0?avg.toFixed(1)+' / 10':'--'],
    ['Check-ins today', String(todayCount)],
    ['Last 7 logged', weekAvg?weekAvg.toFixed(1)+' / 10':'--'],
    ['Streak', streak+' day'+(streak===1?'':'s')],
  ];
  stats.innerHTML=rows.map(([k,v])=>`<div class="ledger-stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
  if(!checkins.length){list.innerHTML='<div class="empty-state">nothing logged yet.</div>';return;}
  list.innerHTML=checkins.slice(0,8).map(c=>{
    const when=parseLocalDate(c.checkin_date).toLocaleDateString('en-US',{month:'short',day:'numeric'});
    return `<div class="ledger-row">
      <span class="ledger-dot" style="background:${getEnergyColor(c.energy_level)}">${c.energy_level}</span>
      <span class="ledger-note">${c.note?esc(c.note):'&nbsp;'}</span>
      <span class="ledger-when">${when}</span>
    </div>`;
  }).join('');
}

// Empty Log and Patterns tabs hand you the way out instead of just naming it.
const FIRST_CHECKIN_BTN='<button type="button" class="btn btn-amber empty-cta" data-action="go-first-checkin">Do your first check-in</button>';
function renderLog(){
  const el=document.getElementById('log-list');
  const nudge=proFiltered?'<div class="pro-history-nudge">Showing last 7 days. <a href="#" data-go-pro="unlimited-history">Go Pro</a> for full history.</div>':'';
  if(!checkins.length){el.innerHTML=nudge+'<div class="empty-state">no check-ins yet.<br>log your first one!<br>'+FIRST_CHECKIN_BTN+'</div>';return;}
  el.innerHTML=nudge+checkins.map(c=>{
    const tags=c.tags?JSON.parse(c.tags):[];
    return `<div class="ci-card"><div style="display:flex;align-items:center;gap:8px"><span class="ci-energy" style="background:${getEnergyColor(c.energy_level)}">${c.energy_level}</span><span class="ci-time">${c.time_of_day}</span><span class="ci-date">${parseLocalDate(c.checkin_date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span></div>${tags.length?`<div class="ci-tags">${tags.map(t=>`<span class="ci-tag">${esc(TAG_LABELS[t]||t)}</span>`).join('')}</div>`:''}${c.charged_by?`<div class="ci-notes"><strong>Charged by:</strong> ${esc(c.charged_by)}</div>`:''}${c.drained_by?`<div class="ci-notes"><strong>Drained by:</strong> ${esc(c.drained_by)}</div>`:''}${c.note?`<div class="ci-notes">${esc(c.note)}</div>`:''}<div class="ci-actions"><button class="btn btn-danger btn-sm" data-action="delete-checkin" data-id="${esc(c.id)}">Delete</button></div></div>`;
  }).join('');
}

// Patterns
function renderPatterns(){
  const el=document.getElementById('patterns-content');
  if(!patterns){el.innerHTML='<div class="empty-state">loading patterns...</div>';return;}
  if(patterns.locked){
    const paused=proPaused?'<div style="font-size:.8rem;color:var(--amber-t);margin-bottom:.75rem">Pro paused? Open the app you bought Pro from and relaunch to refresh.</div>':'';
    el.innerHTML=glowNoticedCard(true)+'<div class="card" style="text-align:center;padding:2rem 1rem"><div class="pro-tag" style="margin-bottom:.6rem">&#9733; Pro</div><div style="font-weight:700;font-size:1rem;margin-bottom:.5rem">Pattern Insights is a Pro feature</div><div style="font-size:.85rem;color:var(--muted);line-height:1.6;margin-bottom:.5rem">See what charges and drains your energy across days, times, and activities.</div>'+paused+'<a href="#" data-go-pro="pattern-insights" class="unlock-pro-btn">Go Pro</a></div>';return;
  }
  if(patterns.total_checkins<1){el.innerHTML='<div class="empty-state">log a few check-ins first.<br>patterns need data!<br>'+FIRST_CHECKIN_BTN+'</div>';return;}
  const tier=getTier(patterns.current_streak);
  const allTags=patterns.by_tag.sort((a,b)=>b.avg-a.avg);
  const overall=patterns.avg_overall||5;
  const chargers=allTags.filter(t=>t.avg>=overall);
  const drainers=allTags.filter(t=>t.avg<overall);
  const timeOrder=['morning','afternoon','evening'];
  const byTime=timeOrder.map(t=>{const f=patterns.by_time.find(x=>x.time_of_day===t);return{time:t,avg:f?f.avg:0,count:f?f.count:0}});
  const dowNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Generate insight text
  let insights=[];
  if(chargers.length){const top=chargers[0];insights.push(`<strong>${esc(TAG_LABELS[top.tag]||top.tag)}</strong> boosts your energy to ${top.avg.toFixed(1)} avg (${(top.avg-overall>=0?'+':'') + (top.avg-overall).toFixed(1)} vs your average)`);}
  if(drainers.length){const worst=drainers[drainers.length-1];insights.push(`<strong>${esc(TAG_LABELS[worst.tag]||worst.tag)}</strong> drops your energy to ${worst.avg.toFixed(1)} avg (${(worst.avg-overall).toFixed(1)} vs your average)`);}
  const bestTime=byTime.filter(t=>t.count).sort((a,b)=>b.avg-a.avg)[0];
  if(bestTime&&bestTime.avg)insights.push(`Your <strong>${bestTime.time}s</strong> tend to be your highest energy time (${bestTime.avg.toFixed(1)} avg)`);

  el.innerHTML=`
    <div class="tier-card"><div class="tier-emoji">${boltSVG(tier.color,28)}</div><div><div class="tier-label">${tier.name}</div><div class="tier-sub">${patterns.current_streak} day streak</div></div></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-lbl">Check-ins</div><div class="stat-val amber">${patterns.total_checkins}</div></div>
      <div class="stat-card"><div class="stat-lbl">Avg Energy</div><div class="stat-val amber">${overall.toFixed(1)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Current Streak</div><div class="stat-val">${patterns.current_streak} days</div></div>
      <div class="stat-card"><div class="stat-lbl">Best Streak</div><div class="stat-val">${patterns.longest_streak} days</div></div>
    </div>
    ${insights.length?`<div class="card"><div class="sec-lbl">key insights</div>${insights.map(i=>`<div style="font-size:.8rem;color:var(--muted);line-height:1.6;margin-bottom:8px;padding-left:12px;border-left:3px solid var(--amber)">${i}</div>`).join('')}</div>`:''}
    ${allTags.length?`<div class="card"><div class="sec-lbl">energy by activity</div><div style="font-size:.7rem;color:var(--muted);margin-bottom:10px">Activities above your ${overall.toFixed(1)} average charge you. Below it drain you.</div>${allTags.map(t=>{
      const diff=t.avg-overall;const isCharger=diff>=0;
      return `<div class="bar-chart-item"><div class="bar-chart-label"><span>${esc(TAG_LABELS[t.tag]||t.tag)} <span style="font-size:.65rem;opacity:.6">(${t.count}x)</span></span><span style="color:${isCharger?'var(--green-t)':'var(--red-t)'};font-weight:700">${t.avg.toFixed(1)} <span style="font-size:.65rem">${isCharger?'+':''} ${diff.toFixed(1)}</span></span></div><div class="bar-chart-track"><div class="bar-chart-fill" style="width:${t.avg*10}%;background:${isCharger?'linear-gradient(90deg,var(--green),var(--cyan))':'linear-gradient(90deg,var(--red),var(--orange))'}"></div></div></div>`;
    }).join('')}</div>`:'<div class="card"><div class="sec-lbl">energy by activity</div><div style="font-size:.8rem;color:var(--muted)">Tag your activities in check-ins to see which ones boost or drain your energy.</div></div>'}
    ${byTime.some(t=>t.count)?`<div class="card"><div class="sec-lbl">energy by time of day</div>${byTime.map(t=>`<div class="bar-chart-item"><div class="bar-chart-label"><span>${t.time}</span><span>${t.avg?t.avg.toFixed(1):'--'} avg <span style="font-size:.65rem;opacity:.6">(${t.count} check-ins)</span></span></div><div class="bar-chart-track"><div class="bar-chart-fill" style="width:${(t.avg||0)*10}%;background:linear-gradient(90deg,var(--amber),var(--volt))"></div></div></div>`).join('')}</div>`:''}
    ${patterns.by_dow.length?`<div class="card"><div class="sec-lbl">energy by day of week</div>${patterns.by_dow.sort((a,b)=>a.dow-b.dow).map(d=>`<div class="bar-chart-item"><div class="bar-chart-label"><span>${dowNames[d.dow]}</span><span>${d.avg.toFixed(1)} avg</span></div><div class="bar-chart-track"><div class="bar-chart-fill" style="width:${d.avg*10}%;background:linear-gradient(90deg,var(--amber),var(--volt))"></div></div></div>`).join('')}</div>`:''}
  `;
}

// ── Recharge Menu ───────────────────────────────────────────────────────────
// Their own good days, read back to them. Nothing here is generic advice: every
// line is a tag they picked or a phrase they typed on a day they rated 7+.
// Laid out as a menu because it is one: courses, dish names, a description in
// the person's own words, and the number in the price column. Bars and charts
// live one card down in Pattern Insights; a menu you read is a different object
// from a chart you study.
const COURSE_LABELS = { morning: 'Mornings', afternoon: 'Afternoons', evening: 'Evenings', any: 'Any time of day' };
const COURSE_ORDER = ['morning', 'afternoon', 'evening', 'any'];

function menuDish(i){
  const name=esc(TAG_LABELS[i.tag]||i.tag);
  // One line only. A menu description is a sentence, not a tag cloud.
  const desc=i.examples.length?`<div class="rm-desc">&ldquo;${esc(i.examples[0])}&rdquo;</div>`:'';
  return `<div class="rm-dish">
    <div class="rm-line"><span class="rm-name">${name}</span><span class="rm-dots"></span><span class="rm-price">${i.avg.toFixed(1)}</span></div>
    ${desc}
    <div class="rm-note">${i.count} check-in${i.count===1?'':'s'} &middot; +${i.lift.toFixed(1)} over your average</div>
  </div>`;
}

function renderRechargeMenu(){
  const el=document.getElementById('recharge-content');
  if(!el)return;
  const m=rechargeMenu;
  // Locked is covered by the one unlock card in Pattern Insights. Two unlock
  // cards on one tab is nagging, not signposting.
  if(!m||m.locked||m.error){el.innerHTML='';return;}
  if(!m.ready){
    el.innerHTML=`<div class="rm-card"><div class="rm-head">
        <div class="rm-pro"><span class="pro-star">&#9733;</span> Pro</div>
        <div class="rm-title">Recharge Menu</div>
        <div class="rm-flourish">${boltSVG('#FF7F66',13)}</div>
      </div>
      <div class="rm-empty">Nothing on it yet. An activity earns a spot once it turns up ${m.min_count||3} times on days you rated ${m.high_energy||7} or higher.</div>
      <div class="rm-empty-meta">${m.high_days||0} good day${(m.high_days||0)===1?'':'s'} logged so far. Keep tagging what you were doing.</div>
    </div>`;
    return;
  }
  // Courses come from when each thing actually worked, so the structure is read
  // off the data rather than invented to look like a menu.
  const courses=Object.create(null);
  for(const i of m.items){const k=i.best_time&&COURSE_LABELS[i.best_time]?i.best_time:'any';(courses[k]||(courses[k]=[])).push(i);}
  const body=COURSE_ORDER.filter(k=>courses[k]).map(k=>
    `<div class="rm-course"><div class="rm-course-lbl">${COURSE_LABELS[k]}</div>${courses[k].map(menuDish).join('')}</div>`
  ).join('');
  const offMenu=(m.in_your_words||[]).length
    ? `<div class="rm-course rm-off"><div class="rm-course-lbl">Off menu</div>
       <div class="rm-off-note">Other things you wrote on your good days.</div>
       <div class="rm-off-list">${m.in_your_words.map(w=>`<span class="rm-off-item">&ldquo;${esc(w)}&rdquo;</span>`).join('')}</div></div>`
    : '';
  const thin=m.thin?`<div class="rm-foot-note">Still a short menu. It fills out as you tag more days.</div>`:'';
  el.innerHTML=`<div class="rm-card">
      <div class="rm-head">
        <div class="rm-pro"><span class="pro-star">&#9733;</span> Pro</div>
        <div class="rm-title">Recharge Menu</div>
        <div class="rm-flourish">${boltSVG('#FF7F66',13)}</div>
        <div class="rm-sub">what actually charges you, in your own words</div>
      </div>
      ${body}
      ${offMenu}
      <div class="rm-foot">Numbers are your average energy on days you did each thing. Yours overall is ${(m.avg_overall||0).toFixed(1)}. Courses are the time of day you usually logged each one.</div>
      ${thin}
    </div>`;
}

// Separate surface, separate job. The menu is for reading; this is for the
// moment you are flat and do not want to read anything. It only shows up on the
// Battery tab when today is actually below par.
function renderHandMeOne(avg){
  const el=document.getElementById('hand-me-one');
  if(!el)return;
  const m=rechargeMenu;
  const below=avg>0&&m&&m.avg_overall&&avg<m.avg_overall;
  if(!m||m.locked||m.error||!m.ready||!below){el.innerHTML='';return;}
  el.innerHTML=`<div class="card hmo-card">
    <div class="sec-lbl"><span class="pro-star" title="Pro feature">&#9733;</span>running low?</div>
    <div class="hmo-copy">You are under your ${m.avg_overall.toFixed(1)} average today. Want one thing that has worked before?</div>
    <button class="btn btn-amber hmo-btn" type="button" data-action="serve-one">Hand me one</button>
    <button class="hmo-link" type="button" data-action="go-menu">See your whole menu &rarr;</button>
  </div>`;
}

// The point of the whole feature: it's 3pm, you're flat, you don't want to read
// a menu. Weighted to the top but not always the same answer.
function serveOne(){
  const items=(rechargeMenu&&rechargeMenu.items)||[];
  if(!items.length)return;
  const pool=items.slice(0,5);
  const pick=pool[Math.floor(Math.random()*pool.length)];
  const phrase=pick.examples.length?pick.examples[Math.floor(Math.random()*pick.examples.length)]:null;
  document.querySelectorAll('.dep-popup').forEach(el=>el.remove());
  const popup=document.createElement('div');
  popup.className='dep-popup';
  popup.setAttribute('role','status');
  popup.innerHTML=`<div class="pop-msg" style="font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">off your menu</div>
    <div class="pop-amount">${esc(TAG_LABELS[pick.tag]||pick.tag)}</div>
    ${phrase?`<div class="pop-msg">&ldquo;${esc(phrase)}&rdquo;</div>`:''}
    <div class="pop-msg" style="font-size:.72rem;color:var(--muted)">Your average on these days: ${pick.avg.toFixed(1)}</div>
    <button class="pop-close" data-action="dismiss-popup">Got it</button>`;
  document.body.appendChild(popup);
  reactWatt('pleased');
  setTimeout(()=>{if(popup.parentElement)popup.remove()},9000);
}

// Daily tip
function renderDailyTip(){
  const tip=GENERAL_NUDGES[Math.floor(Date.now()/86400000)%GENERAL_NUDGES.length];
  document.getElementById('daily-tip').innerHTML=`<div class="tip-card"><div class="tip-text">${tip.text}</div><a class="tip-cta" href="${tip.link}" target="_blank" rel="noopener">${tip.cta} &rarr;</a>${isAff(tip.link)?'<div class="tip-disc">affiliate link</div>':''}</div>`;
}

// Tag pills
function initTagPills(){
  document.getElementById('tag-pills').innerHTML=orderedTags().map(t=>`<button type="button" class="tag-pill${selectedTags.includes(t)?' active':''}" data-action="toggle-tag" data-tag="${esc(t)}">${TAG_LABELS[t]}</button>`).join('');
}
function toggleTag(el,tag){
  el.classList.toggle('active');
  if(selectedTags.includes(tag))selectedTags=selectedTags.filter(t=>t!==tag);
  else selectedTags.push(tag);
}
function pickTime(el,time){
  selectedTime=time;
  document.querySelectorAll('.time-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
}
function pickDay(el,day){
  checkinDay=day;
  document.querySelectorAll('.day-btn').forEach(b=>b.classList.toggle('active',b===el));
  const input=document.getElementById('ci-date');
  if(input){
    if(day==='other'){
      const today=getTodayDate();
      input.min=shiftDays(today,-MAX_BACKFILL_DAYS);
      input.max=today;
      if(!customDate)customDate=shiftDays(today,-2);
      input.value=customDate;
      input.hidden=false;
      input.focus();
    }else{
      input.hidden=true;
    }
  }
  // A past day can't inherit the time of day from the current clock — calling it
  // "afternoon" at 9pm would be inventing a detail about a day that's over. Clear
  // it so they have to say, and require it before the entry saves.
  selectedTime=(day==='today')?defaultTimeOfDay():null;
  syncTimeButtons();
  syncCheckinDay();
}
function pickCustomDate(input){
  const today=getTodayDate();
  const min=shiftDays(today,-MAX_BACKFILL_DAYS);
  // Empty or out of range keeps the last good value: <input type=date> reports
  // '' mid-typing, and min/max are advisory on some mobile pickers.
  if(input.value&&input.value>=min&&input.value<=today)customDate=input.value;
  else input.value=customDate;
  syncCheckinDay();
}
// Keeps the button label and hint honest about which day is about to be saved.
function syncCheckinDay(){
  const back=isBackdated();
  const btn=document.getElementById('log-it-btn');
  if(btn)btn.textContent=back?`Log It for ${prettyDate(getCheckinDate())}`:'Log It';
  const hint=document.getElementById('ci-date-hint');
  if(hint){
    hint.textContent=back?'Saving this under a past day. It still counts toward your streak.':'';
    hint.hidden=!back;
  }
  // "Log again later today" is the wrong nudge on a day that's already over.
  const foot=document.getElementById('ci-footer-hint');
  if(foot){
    foot.textContent=back
      ?'You can add more than one check-in to a past day too, one per part of the day.'
      :'Log again later today. Two or three check-ins are what show you a shape, not just a score.';
  }
}
function updateSliderDisplay(){
  const v=document.getElementById('ci-energy').value;
  const el=document.getElementById('ci-energy-val');
  el.textContent=v;el.style.color=getEnergyColor(+v);
}

// Submit check-in
let checkinSaving=false; // in-flight guard: a double-tap must not save twice
async function submitCheckin(){
  if(checkinSaving)return;
  if(Date.now()-goCheckinTappedAt<450)return; // ghost tap from "Log a Check-In"
  if(!selectedTime){toast('Pick a time of day for that entry');return;}
  checkinSaving=true;
  const logBtn=document.getElementById('log-it-btn');
  if(logBtn)logBtn.disabled=true;
  const energy=parseInt(document.getElementById('ci-energy').value);
  const date=getCheckinDate();
  const charged=document.getElementById('ci-charged').value;
  const drained=document.getElementById('ci-drained').value;
  const note=document.getElementById('ci-note').value;
  const ebBefore=checkins.slice(), ebTagsSaved=selectedTags.slice(), ebTime=selectedTime;
  try{
    await api('/api/checkins',{method:'POST',body:JSON.stringify({energy_level:energy,time_of_day:selectedTime,checkin_date:date,tags:selectedTags.length?selectedTags:undefined,charged_by:charged||undefined,drained_by:drained||undefined,note:note||undefined})});
    // Reload from server
    await loadCheckins();
    await loadPatterns();
    await loadRechargeMenu();
    // Reset form
    document.getElementById('ci-charged').value='';document.getElementById('ci-drained').value='';document.getElementById('ci-note').value='';
    document.getElementById('ci-energy').value=5;updateSliderDisplay();
    selectedTags=[];document.querySelectorAll('.tag-pill').forEach(p=>p.classList.remove('active'));
    // Back to today, so the next entry can't silently land on the same past day.
    checkinDay='today';customDate='';
    const dateInput=document.getElementById('ci-date');
    if(dateInput)dateInput.hidden=true;
    document.querySelectorAll('.day-btn').forEach(b=>b.classList.toggle('active',b.dataset.day==='today'));
    selectedTime=defaultTimeOfDay();syncTimeButtons();syncCheckinDay();
    renderAll();
    // Celebrations
    const milestoneHit=checkMilestones();
    if(!milestoneHit)miniCelebrate(energy);
    const ebLines=glowReaction({energy,date,time:ebTime,tags:ebTagsSaved,charged,drained},ebBefore);
    document.getElementById('speechBubble').innerHTML=ebLines.map(esc).join('<br>');
    showCheckinPopup(energy,date,ebLines);
  }catch(e){toast(e.message);}
  finally{checkinSaving=false;if(logBtn)logBtn.disabled=false;}
}

// Delete check-in
async function deleteCheckin(id){
  if(!confirm('Delete this check-in?'))return;
  try{
    await api(`/api/checkins/${id}`,{method:'DELETE'});
    await loadCheckins();
    await loadPatterns();
    await loadRechargeMenu();
    renderAll();toast('Deleted');
  }catch(e){toast(e.message);}
}

// Check-in popup — promo-free. Promos live on milestone celebrations only
// (never the first check-in, never a low-energy log).
function showCheckinPopup(energy,date,lines){
  document.querySelectorAll('.dep-popup').forEach(el=>el.remove());
  const popup=document.createElement('div');
  const boltColor=energy>=8?'#6EE7B7':energy>=5?'#FF7F66':'#FF5A6E';
  let icon=`<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="${boltColor}"/></svg>`;
  let msg=energy>=8?'<div class="pop-msg" style="color:var(--green-t);font-weight:700">HIGH ENERGY!</div>':energy>=5?'<div class="pop-msg">Solid. Keep tracking.</div>':'<div class="pop-msg">Low energy logged. Rest counts too.</div>';
  if(lines){const t=lines.join(' ');msg='<div class="pop-msg">'+esc(t.charAt(0).toUpperCase()+t.slice(1))+'</div>';}
  popup.className='dep-popup';
  popup.setAttribute('role','status');   // announced, and exempt from the axe 'region' landmark rule
  const whenLine=(date&&date!==getTodayDate())?`<div class="pop-msg">Logged for ${esc(prettyDate(date))}</div>`:'';
  popup.innerHTML=`<div style="line-height:0">${icon}</div><div class="pop-amount">${energy} / 10</div>${msg}${whenLine}<button class="pop-close" data-action="dismiss-popup">Got it</button>`;
  document.body.appendChild(popup);
  setTimeout(()=>{if(popup.parentElement)popup.remove()},6000);
}

// Mini celebrate
function miniCelebrate(energy){
  reactWatt('pleased');
  const wrap=document.querySelector('.watt-wrap');
  const rect=wrap.getBoundingClientRect();
  burst(rect.left+rect.width/2,rect.top+rect.height/2,energy>=7?12:6);
  if(energy>=7)flashScreen('rgba(110,231,183,.08)');
  if(energy>=9){flashScreen('rgba(255,194,71,.1)');setTimeout(()=>burst(Math.random()*innerWidth,Math.random()*innerHeight,8),200);}
}

// Milestones
function checkMilestones(){
  if(!patterns)return false;
  const storageKey='eb_milestones';
  const hit=JSON.parse(localStorage.getItem(storageKey)||'[]');
  let best=null;
  for(let i=MILESTONES.length-1;i>=0;i--){
    const m=MILESTONES[i];if(hit.includes(m.key))continue;
    if(m.check(patterns.current_streak,patterns.total_checkins)){if(!best)best=m;hit.push(m.key);}
  }
  if(best){localStorage.setItem(storageKey,JSON.stringify(hit));setTimeout(()=>celebrateFull(best),600);return true;}
  return false;
}

function celebrateFull(milestone){
  reactWatt('celebrating');
  flashScreen('rgba(255,127,102,.15)');
  setTimeout(()=>flashScreen('rgba(255,194,71,.12)'),300);
  setTimeout(()=>flashScreen('rgba(110,231,183,.1)'),600);
  for(let w=0;w<5;w++)setTimeout(()=>burst(Math.random()*innerWidth,Math.random()*innerHeight,14),w*250);
  fireConfetti(80);
  setTimeout(()=>{
    document.getElementById('celeb-icon').innerHTML=boltSVG('#6EE7B7',48);
    document.getElementById('celeb-title').textContent=milestone.title;
    document.getElementById('celeb-msg').innerHTML=milestone.msg;
    const nudge=MILESTONE_NUDGES[milestone.key];
    document.getElementById('celeb-nudge').innerHTML=nudge?`<div class="tip-card" style="margin-top:14px;text-align:left"><div class="tip-text">${nudge.text}</div><a class="tip-cta" href="${nudge.link}" target="_blank" rel="noopener">${nudge.cta} &rarr;</a>${isAff(nudge.link)?'<div class="tip-disc">affiliate link</div>':''}</div>`:'';
    openOverlay('celeb-overlay');
  },900);
  setTimeout(()=>reactWatt('idle'),6000);
}
function closeCeleb(fromHistory){ closeOverlay('celeb-overlay', fromHistory); }

// Confetti
function fireConfetti(count=80){
  const canvas=document.getElementById('confetti-canvas');canvas.width=innerWidth;canvas.height=innerHeight;
  const ctx=canvas.getContext('2d');
  const colors=['#FF7F66','#FFB09F','#FFC247','#6EE7B7','#5CD6F0','#C3A6FF','#FF5A6E'];
  const pieces=[];for(let i=0;i<count;i++)pieces.push({x:Math.random()*canvas.width,y:-20-Math.random()*200,w:6+Math.random()*6,h:4+Math.random()*4,color:colors[Math.floor(Math.random()*colors.length)],rot:Math.random()*360,rotV:(Math.random()-.5)*8,vy:1.5+Math.random()*3,vx:(Math.random()-.5)*2,opacity:1});
  let frame=0;
  function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);let alive=false;pieces.forEach(p=>{if(p.opacity<=0)return;alive=true;p.y+=p.vy;p.x+=p.vx;p.rot+=p.rotV;if(p.y>canvas.height+20){p.opacity=0;return;}if(frame>100)p.opacity-=.015;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);ctx.globalAlpha=Math.max(p.opacity,0);ctx.fillStyle=p.color;ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);ctx.restore();});frame++;if(alive)requestAnimationFrame(draw);else ctx.clearRect(0,0,canvas.width,canvas.height);}
  draw();
}

// Particles
function burst(x,y,count=12){
  const colors=['#FF7F66','#FFB09F','#FFC247','#6EE7B7','#5CD6F0'];
  for(let i=0;i<count;i++){const angle=(i/count)*Math.PI*2+Math.random()*.5;const dist=40+Math.random()*60;const p=document.createElement('div');p.className='particle';const size=4+Math.random()*6;p.style.cssText=`width:${size}px;height:${size}px;left:${x}px;top:${y}px;background:${colors[i%colors.length]};--tx:${Math.cos(angle)*dist}px;--ty:${Math.sin(angle)*dist}px;--dur:${(.5+Math.random()*.5).toFixed(2)}s;--rot:${Math.random()*720}deg`;document.body.appendChild(p);setTimeout(()=>p.remove(),1200);}
}
function flashScreen(color){const f=document.createElement('div');f.style.cssText=`position:fixed;inset:0;background:${color};z-index:997;pointer-events:none;animation:screen-flash .5s forwards`;document.body.appendChild(f);setTimeout(()=>f.remove(),600);}

// Watt interactions
let wattTimeout;
function wattClick(){
  document.getElementById('speechBubble').innerHTML=WATT_LINES[Math.floor(Math.random()*WATT_LINES.length)];
  reactWatt('pleased');
  const wrap=document.querySelector('.watt-wrap');const rect=wrap.getBoundingClientRect();
  burst(rect.left+rect.width/2,rect.top+rect.height/2,8);
  clearTimeout(wattTimeout);wattTimeout=setTimeout(()=>syncWatt(getTodayAvg()),3500);
}
function reactWatt(state){
  const w=document.getElementById('wattWrap');
  w.className='watt-wrap state-'+state;
  if(state==='pleased')setTimeout(()=>{w.className='watt-wrap state-idle';},1200);
}
function syncWatt(avg){
  // Bands are whole numbers but the day's average can be 4.5: match on [min, max+1).
  const line=WATT_PROGRESS.find(l=>avg>=l.min&&avg<l.max+1);
  if(line)document.getElementById('speechBubble').innerHTML=line.line;
  const art=document.getElementById('glowArt');
  if(art)art.innerHTML=glowSvg(avg>0?avg/10:0.05,'live');
}
function scheduleBlink(){
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const blink=()=>{const g=document.querySelector('#glowArt .glow-eyes');if(!g)return;g.classList.add('blink');setTimeout(()=>g.classList.remove('blink'),150);};
  setInterval(()=>{setTimeout(blink,Math.random()*3500);},1800+Math.random()*3500);
}

// Account
// GDPR Right-to-Access: download all of the signed-in user's data as JSON.
async function exportMyData(btn){
  if(btn){btn.disabled=true;btn.textContent='Preparing...';}
  try{
    const data=await api('/api/account/export');
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='energy-battery-data.json';
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
  }catch(e){
    toast(e.message||'Could not export your data.');
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Export my data';}
  }
}

// Delete Account: open modal that requires a fresh proof before proceeding.
// A stolen JWT alone must not be enough to wipe data with two confirm() clicks.
// Password accounts type their password. App Hub accounts that never set one
// switch to "type DELETE" and the hub token on this device is checked instead.
let deleteViaHub=false;
function setDeleteMode(viaHub){
  deleteViaHub=!!viaHub;
  document.getElementById('delete-pw-row').style.display=deleteViaHub?'none':'block';
  document.getElementById('delete-hub-row').style.display=deleteViaHub?'block':'none';
  const err=document.getElementById('delete-account-err');
  if(err){err.textContent='';err.style.display='none';}
  const f=document.getElementById(deleteViaHub?'delete-account-confirm':'delete-account-pw');
  if(f)f.focus();
}
function confirmDeleteAccount(){
  const pw=document.getElementById('delete-account-pw');
  const conf=document.getElementById('delete-account-confirm');
  if(pw)pw.value='';
  if(conf)conf.value='';
  openOverlay('delete-account-modal');
  setTimeout(()=>setDeleteMode(false),0);
}
async function performDeleteAccount(){
  const err=document.getElementById('delete-account-err');
  const btn=document.getElementById('delete-account-confirm-btn');
  err.style.display='none';
  let body;
  if(deleteViaHub){
    const typed=document.getElementById('delete-account-confirm').value.trim();
    if(typed!=='DELETE'){err.textContent='Type DELETE to confirm.';err.style.display='block';return;}
    await ensureFreshHubToken();
    const hubJwt=localStorage.getItem('hub_pro_jwt');
    if(!hubJwt){err.textContent="There's no App Hub sign-in on this device. Open the App Hub, launch Energy Battery from there, then try again. Or use Forgot password on the sign-in screen to set a password.";err.style.display='block';return;}
    body={hub_pro_jwt:hubJwt,confirm:'DELETE'};
  }else{
    const pw=document.getElementById('delete-account-pw').value;
    if(!pw||pw.length<10){err.textContent='Enter your password to confirm.';err.style.display='block';return;}
    body={current_password:pw};
  }
  btn.disabled=true;
  try{
    await api('/api/auth/account',{method:'DELETE',body:JSON.stringify(body)});
    // Flag so the login screen confirms the deletion after the reload.
    try{sessionStorage.setItem('eb_deleted','1');}catch{}
    logout();
  }catch(e){
    err.textContent=e.message||'Could not delete account.';
    err.style.display='block';
    btn.disabled=false;
  }
}
function closeModal(id, fromHistory){ closeOverlay(id, fromHistory); }

// -----------------------------------------------------------------------------
// 3) Feedback widget — login-only, lazy-loaded (mirrors App Hub).
//    No static <script> tag: the logged-out page never shows a feedback button.
//    First call injects the script; later calls just re-show the FAB.
// -----------------------------------------------------------------------------
window.FEEDBACK_APP = 'Energy Battery';
let fbwLoaded = false;
function showFeedbackWidget() {
  feedbackWanted = true;
  if (!feedbackAvailable) return;
  if (!fbwLoaded) {
    fbwLoaded = true;
    const s = document.createElement('script');
    s.src = '/feedback-widget.js?v=20261002a';
    document.body.appendChild(s);
    return;
  }
  const b = document.querySelector('.fbw-btn');
  if (b) b.style.display = '';
}
function hideFeedbackWidget() {
  feedbackWanted = false;
  const b = document.querySelector('.fbw-btn');
  if (b) b.style.display = 'none';
  const o = document.querySelector('.fbw-overlay');
  if (o) o.classList.remove('fbw-open');
}

// -----------------------------------------------------------------------------
// 3.5) BROWSER BACK/FORWARD — main tabs (post-auth) + auth steps (pre-auth).
// A Back press means "leave what I opened" — closes every open modal/overlay,
// then restores whatever the popped history entry points at.
// -----------------------------------------------------------------------------
// Transient UI with no backdrop and no focus trap never earns a history entry,
// but a Back press should still clear it.
function clearTransientOverlays() {
  document.querySelectorAll('.dep-popup').forEach(el => el.remove());
}
// Tears every layer down, gates included — for leaving the authed view
// (logout), not for an ordinary Back, which pops exactly one layer.
function closeAllOverlays() {
  while (overlayStack.length) popOverlayLayer();
  clearTransientOverlays();
}
// Restores a pre-auth history entry (login/signup tab or verify-code step).
// Always resets from a clean baseline (authTab) first, since the popped entry
// can be a step removed from the screen's current DOM state.
function restoreAuthView(state) {
  if (state && (state.guestView === 'try' || state.guestView === 'result')) { showGuest(state.guestView, { fromHistory: true }); return; }
  const view = (state && state.authView) || 'login';
  const mode = state && state.mode === 'signup' ? 'signup' : 'login';
  authTab(mode, true);
  if (view === 'verify') showCodeBox((state && state.email) || pendingVerifyEmail, undefined, true);
}
window.addEventListener('popstate', (ev) => {
  const state = ev.state || {};
  clearTransientOverlays();
  // Pop only as many layers as this entry gives back, so Back steps out of
  // one dialog at a time instead of leaving the origin.
  unwindOverlaysTo(state.ebOverlay || 0);
  if (currentUser) {
    // Authenticated: restore the in-app tab. A stale pre-auth entry (no
    // `view` — e.g. left over from before login) defaults to Check In.
    goTab(state.view || 'checkin', true);
  } else {
    // Not authenticated: restore the auth-screen step. A stale in-app tab
    // entry (no `authView`) defaults to the login landing.
    restoreAuthView(state);
  }
});

// -----------------------------------------------------------------------------
// 4) Event wiring — replaces every onclick/oninput/onsubmit attribute.
//     Uses event delegation off document for items that appear in dynamically
//     generated HTML (delete-checkin buttons, tag pills, popup close, etc.).
// -----------------------------------------------------------------------------
function wireEvents() {
  // ---- Auth screen ----
  document.querySelectorAll('.auth-tab').forEach((tab, i) => {
    tab.addEventListener('click', () => authTab(i === 0 ? 'login' : 'signup'));
  });
  const authForm = document.getElementById('auth-form');
  if (authForm) authForm.addEventListener('submit', authSubmit);
  const forgotBtn = document.getElementById('forgot-btn');
  if (forgotBtn) forgotBtn.addEventListener('click', forgotPw);
  const verifyCodeBtn = document.getElementById('verify-code-btn');
  if (verifyCodeBtn) verifyCodeBtn.addEventListener('click', submitCode);
  const resendCodeBtn = document.getElementById('resend-code-btn');
  if (resendCodeBtn) resendCodeBtn.addEventListener('click', resendCode);
  const codeInput = document.getElementById('auth-code');
  if (codeInput) codeInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitCode(); } });
  const codePwInput = document.getElementById('code-pw');
  if (codePwInput) codePwInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitCode(); } });

  // ---- Guest sample check-in ----
  const guestEnergy = document.getElementById('guest-energy');
  if (guestEnergy) guestEnergy.addEventListener('input', syncGuestSlider);
  const guestFillBtn = document.getElementById('guest-fill-btn');
  if (guestFillBtn) guestFillBtn.addEventListener('click', guestFill);

  // ---- Reset screen ----
  const resetBtn = document.querySelector('#reset-screen .auth-btn');
  if (resetBtn) resetBtn.addEventListener('click', confirmReset);

  // ---- Header actions ----
  const helpBtn = document.getElementById('hdr-help');
  if (helpBtn) helpBtn.addEventListener('click', () => openHelp());
  document.querySelectorAll('[data-logout]').forEach(b => b.addEventListener('click', logout));
  // Retry on the load-failure banner
  const retryBtn = document.getElementById('load-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', () => loadAppData(false));

  // ---- Watt panel ----
  const wattWrap = document.getElementById('wattWrap');
  if (wattWrap) wattWrap.addEventListener('click', wattClick);
  // Watt is a div with role=button: Enter and Space must poke him too.
  if (wattWrap) wattWrap.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); wattClick(); } });
  // Enter in the reset password field submits the reset (there is no form).
  const resetPw = document.getElementById('reset-pw');
  if (resetPw) resetPw.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); confirmReset(); } });

  // ---- Tabs ----
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => goTab(tab.dataset.tab));
  });

  // ---- Battery panel ----
  const goCheckinBtn = document.getElementById('go-checkin-btn');
  if (goCheckinBtn) goCheckinBtn.addEventListener('click', () => { goCheckinTappedAt=Date.now(); goTab('checkin'); });

  // ---- Check-in form ----
  const ciEnergy = document.getElementById('ci-energy');
  if (ciEnergy) ciEnergy.addEventListener('input', updateSliderDisplay);
  document.querySelectorAll('.time-btn[data-time]').forEach(btn => {
    btn.addEventListener('click', () => pickTime(btn, btn.dataset.time));
  });
  syncTimeButtons(); // reflect the clock-based default (HTML hardcodes afternoon)
  document.querySelectorAll('.day-btn[data-day]').forEach(btn => {
    btn.addEventListener('click', () => pickDay(btn, btn.dataset.day));
  });
  const ciDate = document.getElementById('ci-date');
  if (ciDate) ciDate.addEventListener('change', () => pickCustomDate(ciDate));
  syncCheckinDay();
  const logItBtn = document.getElementById('log-it-btn');
  if (logItBtn) logItBtn.addEventListener('click', submitCheckin);

  // ---- Celebration ----
  const celebClose = document.querySelector('.celeb-close');
  if (celebClose) celebClose.addEventListener('click', () => closeCeleb());
  const celebOverlay = document.getElementById('celeb-overlay');
  if (celebOverlay) celebOverlay.addEventListener('click', (e) => { if (e.target === celebOverlay) closeCeleb(); });
  // Esc dismisses celebration UI (and the Pro modal)
  // Escape dismisses the top layer, through the same close path as the
  // on-screen buttons so Escape and browser Back stay in sync. Gates are
  // deliberately un-dismissable — there is no app behind them yet.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.dep-popup').forEach(el => el.remove());
    const top = overlayStack[overlayStack.length - 1];
    if (!top || !top.pushed) return;
    e.preventDefault();
    closeOverlay(top.id);
  });

  // ---- Delete-account modal ----
  const cancelDeleteBtn = document.getElementById('cancel-delete-account-btn');
  if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', () => closeOverlay('delete-account-modal'));
  const confirmDeleteBtn = document.getElementById('delete-account-confirm-btn');
  if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', performDeleteAccount);
  const useHubBtn = document.getElementById('delete-use-hub-btn');
  if (useHubBtn) useHubBtn.addEventListener('click', () => setDeleteMode(true));
  const usePwBtn = document.getElementById('delete-use-pw-btn');
  if (usePwBtn) usePwBtn.addEventListener('click', () => setDeleteMode(false));

  // ---- Onboarding ----
  const onboardBtn = document.getElementById('onboard-go-btn');
  // Swaps one landing-level gate for the next, so the stack is emptied and
  // re-seeded rather than layered — otherwise Back out of the timezone picker
  // would re-open onboarding.
  if (onboardBtn) onboardBtn.addEventListener('click', () => {
    closeOverlay('onboard-overlay', true);
    showTrackModal(false);
  });

  // ---- What do you want to track? ----
  document.querySelectorAll('.track-opt[data-track]').forEach(b => {
    b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
  });
  const trackBtn = document.getElementById('track-confirm-btn');
  if (trackBtn) trackBtn.addEventListener('click', confirmTrack);
  const trackCancel = document.getElementById('track-cancel-btn');
  if (trackCancel) trackCancel.addEventListener('click', () => closeOverlay('track-modal'));

  // ---- Timezone modal ----
  const tzBtn = document.getElementById('tz-confirm-btn');
  if (tzBtn) tzBtn.addEventListener('click', confirmTz);
  const tzCancel = document.getElementById('tz-cancel-btn');
  if (tzCancel) tzCancel.addEventListener('click', () => closeTzModal());

  // ---- Delegated handlers for dynamic content ----
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    if (action === 'delete-checkin') {
      deleteCheckin(t.dataset.id);
    } else if (action === 'confirm-delete-account') {
      confirmDeleteAccount();
    } else if (action === 'toggle-tag') {
      toggleTag(t, t.dataset.tag);
    } else if (action === 'dismiss-popup') {
      if (t.parentElement) t.parentElement.remove();
    } else if (action === 'export-data') {
      exportMyData(t);
    } else if (action === 'close-help') {
      closeHelp();
    } else if (action === 'start-tour') {
      closeHelp();
      setTimeout(startTour, 220);
    } else if (action === 'serve-one') {
      serveOne();
    } else if (action === 'go-menu') {
      goTab('patterns');
    } else if (action === 'change-timezone') {
      openTzSettings();
    } else if (action === 'tip-act') {
      runTipAction(t.dataset.tipAct);
    } else if (action === 'go-first-checkin') {
      goCheckinTappedAt = Date.now();
      goTab('checkin');
      const card = document.getElementById('panel-checkin');
      if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (action === 'change-track') {
      showTrackModal(true);
    } else if (action === 'guest-tag') {
      toggleGuestTag(t, t.dataset.tag);
    } else if (action === 'guest-signup') {
      leaveGuestTo('signup');
    } else if (action === 'guest-login') {
      leaveGuestTo('login');
    } else if (action === 'guest-redo') {
      guestRedo();
    } else if (action === 'guest-try') {
      showGuest(readGuestCheckin() ? 'result' : 'try');
    }
  });
}

// -----------------------------------------------------------------------------
// Help panel + guided tour
// -----------------------------------------------------------------------------
// Both go through the overlay stack, so Back and Escape close them and a modal
// opened over one lands back on the one underneath instead of the bare app.
function openHelp(){
  const m = document.getElementById('help-modal');
  if (!m) return;
  const body = m.querySelector('.help-body');
  if (body) body.scrollTop = 0;
  openOverlay('help-modal');
  const done = m.querySelector('.help-done');
  if (done) done.focus();
}
function closeHelp(fromHistory){ closeOverlay('help-modal', fromHistory); }

// Each stop highlights a real element with a ring and pins an explainer to the
// bottom. Registered as ONE overlay layer for the whole run, so Back ends the
// tour and leaves you on the app; per-stop entries would replay it backwards.
const TOUR_STOPS = [
  { tab: null, sel: null, text: "new here? i'm Glow. let me show you around. five quick stops, or skip any time." },
  { tab: 'checkin', sel: '#wattWrap', text: "that's me. i brighten and dim with your day, and i'll say something if you click me." },
  { tab: 'checkin', sel: '#panel-checkin', text: "this is the only thing you have to do. slide the number, pick the time of day, tap what you were doing. about fifteen seconds." },
  { tab: 'battery', sel: '#panel-battery', text: "the battery is today's average across your check-ins, not just the last one. a rough morning and a good evening land in the middle." },
  { tab: 'log', sel: '#panel-log', text: "the log is every check-in you've made, newest first. free keeps the last 7 days in view." },
  { tab: 'patterns', sel: '#panel-patterns', text: "patterns is where i tell you what charges and drains you, counted rather than guessed. that one's Pro. the ? up top reopens this any time." },
];
function tourSeen(){ try { return localStorage.getItem('eb_tour_done') === '1'; } catch { return false; } }
function tourMarkSeen(){ try { localStorage.setItem('eb_tour_done','1'); } catch {} }
let ebTourStep;
function startTour(){
  endTour();
  ebTourStep = 0;
  openOverlay('tour-layer');
  renderTourStep();
}
function endTour(fromHistory){
  if (ebTourStep === undefined) return;
  if (!fromHistory && closeOverlay('tour-layer', false)) return; // popstate finishes it
  ebTourStep = undefined;
  tourMarkSeen();
  const b = document.getElementById('tourbox'); if (b) b.remove();
  const r = document.getElementById('tourring'); if (r) r.remove();
}
function renderTourStep(){
  const n = ebTourStep, stop = TOUR_STOPS[n];
  if (!stop) return endTour();
  const show = () => {
    const ob = document.getElementById('tourbox'); if (ob) ob.remove();
    const or = document.getElementById('tourring'); if (or) or.remove();
    if (stop.sel) {
      const el = document.querySelector(stop.sel);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const ring = document.createElement('div');
        ring.id = 'tourring';
        ring.style.cssText = `left:${r.left-6}px;top:${r.top-6}px;width:${r.width+12}px;height:${r.height+12}px;`;
        document.body.appendChild(ring);
      }
    }
    const last = n === TOUR_STOPS.length - 1;
    const box = document.createElement('div');
    box.id = 'tourbox';
    box.setAttribute('role','dialog');
    box.setAttribute('aria-label','App tour');
    box.innerHTML = `<p>${esc(stop.text)}</p><div class="tourrow">`+
      `<span class="tourcount">${n===0?'':`${n} of ${TOUR_STOPS.length-1}`}</span>`+
      `<button type="button" class="tourbtn ghost" id="tour-skip">${last?'Done':n===0?'No thanks':'Skip'}</button>`+
      (last?'':`<button type="button" class="tourbtn" id="tour-next">${n===0?'Show me':'Next'}</button>`)+
      `</div>`;
    document.body.appendChild(box);
    document.getElementById('tour-skip').onclick = () => endTour();
    const next = document.getElementById('tour-next');
    if (next) { next.onclick = () => { ebTourStep = n + 1; renderTourStep(); }; next.focus(); }
  };
  // Switch tab first; the highlight target renders with the tab. fromHistory=true
  // so tab moves never stack entries on top of the tour's single overlay entry.
  if (stop.tab && currentTab !== stop.tab) { goTab(stop.tab, true); setTimeout(show, 60); }
  else show();
}
// Offered once, and only to an account that has not logged anything yet.
function maybeOfferTour(){
  if (tourSeen()) return;
  if ((checkins || []).length) { tourMarkSeen(); return; }
  startTour();
}

// -----------------------------------------------------------------------------
// 5) Init — runs after DOM is ready (script is loaded with `defer`)
// -----------------------------------------------------------------------------
(async function init() {
  wireEvents();
  // Let the rest of this file finish loading first. The guest landing below
  // draws Glow, and glowSvg() reads GLOW_P, a const declared further down:
  // touching it before then is a TDZ ReferenceError that kills init().
  await Promise.resolve();

  // Post-deletion confirmation on the login screen
  let landOnLogin = false;
  try {
    if (sessionStorage.getItem('eb_deleted')) {
      landOnLogin = true;
      sessionStorage.removeItem('eb_deleted');
      const s = document.getElementById('auth-suc');
      if (s) { s.textContent = 'Your account was deleted.'; s.style.display = 'block'; }
    }
  } catch {}

  if (getResetToken()) {
    hideBootScreen();
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('reset-screen').style.display = 'flex';
    return;
  }
  // Logged-out landing is the guest sample check-in, not a sign-up wall (UX
  // fixes 2026-11). A refresh on the log-in or sign-up card stays there, and
  // so does the post-deletion message. Always replaceState, so the very first
  // Back leaves the site. If a session logs the user in below, enterApp()'s
  // own landTab() replaceState overwrites this.
  if (landOnLogin) landAuth('login');
  else if (BOOT_ENTRY.authView === 'login' || BOOT_ENTRY.authView === 'signup') landAuth(BOOT_ENTRY.authView);
  else {
    // Read (and so re-validate) any stored sample every time, which also purges one that was tampered with.
    const pendingSample = readGuestCheckin();
    showGuest(BOOT_ENTRY.guestView === 'try' || !pendingSample ? 'try' : 'result', { replace: true });
  }
  try {
  // If the stored hub Pro token is expired (or about to be), trade it for a
  // fresh one BEFORE hub-sso and pro-status ever see it. Renewal fix: Stripe
  // renewals expire the cached token even though the user is still paying.
  await ensureFreshHubToken();
  // Who is signed in? One GET /api/me (the cookie is HttpOnly). A fresh
  // ?hubpro= arrival skips it: hub-sso below decides who this is.
  let bootErr = null;
  if (!HUB_ARRIVAL) {
    // Pre-cookie builds kept the login token in localStorage. It's dead
    // now (the server only reads the cookie), so just wipe any leftover.
    try { localStorage.removeItem('eb_token'); } catch {}
    try { currentUser = await api('/api/me'); }
    catch (err) { if (!err.sessionEnded) bootErr = err.message; }
  }
  // Hub SSO: if hub passed us a Pro JWT and we have no Battery session, exchange it.
  if (!currentUser && !bootErr) {
    const hubPro = localStorage.getItem('hub_pro_jwt');
    if (hubPro) {
      try {
        const r = await fetch(API + '/api/auth/hub-sso', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hub_pro_jwt: hubPro }) });
        if (r.ok) { const d = await r.json(); currentUser = d.user; }
      } catch (err) { console.error('hub-sso:', err.message); }
    }
  }
  if (currentUser) { try { await enterApp(false); } catch { logout(); } }
  else if (bootErr) {
    landAuth('login');
    showAuthScreen();
    const el = document.getElementById('auth-err');
    if (el) { el.textContent = bootErr; el.style.display = 'block'; }
  }
  } finally {
    // Nobody gets stranded on the boot screen. If it is still up by now, no
    // session resolved, which means the auth screen.
    const boot = document.getElementById('boot-screen');
    if (boot && boot.style.display !== 'none') showAuthScreen();
  }
})();

// ── Show/hide password toggle (uniform across the hub + all 5 apps) ─────────
(function initPwEyes(){
  var EYE='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYEOFF='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  ['auth-pw','auth-pw2'].forEach(function(id){
    var input=document.getElementById(id);
    if(!input||input.dataset.eyeInit)return;
    input.dataset.eyeInit='1';
    var wrap=document.createElement('div');
    wrap.style.position='relative';
    input.parentNode.insertBefore(wrap,input);
    wrap.appendChild(input);
    input.style.paddingRight='40px';
    var btn=document.createElement('button');
    btn.type='button';
    btn.setAttribute('aria-label','Show password');
    btn.setAttribute('aria-pressed','false');
    btn.style.cssText='position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:8px;line-height:0;color:inherit;opacity:.55';
    btn.innerHTML=EYE;
    btn.addEventListener('click',function(){
      var show=input.type==='password';
      input.type=show?'text':'password';
      btn.innerHTML=show?EYEOFF:EYE;
      btn.setAttribute('aria-label',show?'Hide password':'Show password');
      btn.setAttribute('aria-pressed',String(show));
      input.focus();
    });
    wrap.appendChild(btn);
  });
})();

// Glow the firefly, Energy Battery's mascot.
// Her tail lantern is the battery: it fills and glows with the day's energy,
// her eyelids droop and she sags when you're drained.
const GLOW_P = { body: '#FF7F66', shade: '#2A3342', ink: '#1A1020', volt: '#FFC247', good: '#6EE7B7', low: '#FF5A6E' };

function glowSvg(e, uid, w, h) {
  e = Math.max(0.05, Math.min(1, e));
  const P = GLOW_P, lift = (1 - e) * 10;
  const tail = e < 0.34 ? P.low : P.good;
  const glowR = 26 + e * 34, glowO = 0.15 + e * 0.55, wingO = 0.35 + e * 0.25;
  const lid = Math.max(0, 0.55 - e * 0.7);
  const eye = x => {
    const cy = 66 + lift, r = 9;
    return `<circle cx="${x}" cy="${cy}" r="${r}" fill="#fff"/><circle cx="${x + 1.5}" cy="${cy + 1.5}" r="5.2" fill="${P.ink}"/><circle cx="${x + 3.5}" cy="${cy - 1.2}" r="1.9" fill="#fff"/>` +
      (lid > 0.02 ? `<path d="M${x - r - 1} ${cy - r - 1} h${2 * r + 2} v${(2 * r + 2) * lid} q-${r + 1} 5 -${2 * r + 2} 0 z" fill="${P.body}"/>` : '');
  };
  const my = 88 + lift;
  const mouth = e < 0.34 ? `<path d="M63 ${my + 3} q7 -5 14 0" stroke="${P.ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`
    : e < 0.67 ? `<path d="M64 ${my + 1} h12" stroke="${P.ink}" stroke-width="2.6" stroke-linecap="round"/>`
    : `<path d="M61 ${my - 1} q9 11 18 0 z" fill="${P.ink}"/><path d="M65 ${my + 3.2} q5 3 10 0" fill="#FF8FA3"/>`;
  const ch = 0.15 + e * 0.35;
  return `<svg viewBox="0 0 140 210" width="${w || 140}" height="${h || 210}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
<defs>
<radialGradient id="gg${uid}"><stop offset="0" stop-color="${tail}" stop-opacity="${glowO}"/><stop offset="1" stop-color="${tail}" stop-opacity="0"/></radialGradient>
<linearGradient id="gt${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.volt}"/><stop offset="1" stop-color="${tail}"/></linearGradient>
<clipPath id="gc${uid}"><ellipse cx="70" cy="${150 + lift}" rx="30" ry="34"/></clipPath>
</defs>
<circle class="glow-halo" cx="70" cy="${150 + lift}" r="${glowR}" fill="url(#gg${uid})"/>
<g class="glow-wings" opacity="${wingO}"><ellipse cx="38" cy="${92 + lift}" rx="26" ry="15" transform="rotate(-28 38 ${92 + lift})" fill="#E8F4FF"/><ellipse cx="102" cy="${92 + lift}" rx="26" ry="15" transform="rotate(28 102 ${92 + lift})" fill="#E8F4FF"/></g>
<path d="M58 ${34 + lift} q-6 -18 -16 -20" stroke="${P.body}" stroke-width="3" fill="none" stroke-linecap="round"/>
<path d="M82 ${34 + lift} q6 -18 16 -20" stroke="${P.body}" stroke-width="3" fill="none" stroke-linecap="round"/>
<circle cx="42" cy="${14 + lift}" r="4.5" fill="${P.volt}"/><circle cx="98" cy="${14 + lift}" r="4.5" fill="${P.volt}"/>
<ellipse cx="70" cy="${150 + lift}" rx="30" ry="34" fill="${P.shade}"/>
<rect x="36" y="${184 + lift - 68 * e}" width="68" height="${68 * e + 4}" fill="url(#gt${uid})" clip-path="url(#gc${uid})"/>
<ellipse cx="60" cy="${136 + lift}" rx="8" ry="12" fill="#fff" opacity=".22"/>
<path d="M44 ${140 + lift} q26 8 52 0 M42 ${156 + lift} q28 8 56 0" stroke="${P.body}" stroke-width="2" opacity=".35" fill="none"/>
<ellipse cx="70" cy="${70 + lift}" rx="42" ry="40" fill="${P.body}"/>
<ellipse cx="56" cy="${52 + lift}" rx="14" ry="9" fill="#fff" opacity=".12"/>
<g class="glow-eyes" style="transform-origin:70px ${66 + lift}px">${eye(55)}${eye(85)}</g>
<ellipse cx="44" cy="${84 + lift}" rx="7" ry="4.5" fill="#FF7A9A" opacity="${ch}"/><ellipse cx="96" cy="${84 + lift}" rx="7" ry="4.5" fill="#FF7A9A" opacity="${ch}"/>
${mouth}
<path d="M40 ${104 + lift} q-10 8 -8 18 M100 ${104 + lift} q10 8 8 18" stroke="${P.body}" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`;
}
if (typeof module !== 'undefined') module.exports = { glowSvg, GLOW_P };

// Energy Battery features:
//  1. Glow reacts to what you actually logged, not just the number.
//  2. One free "Glow noticed" insight once there are 5 check-ins.
//  3. The backup cell: one missed day a week doesn't break the streak (math is in the worker).
// Uses app.js globals:
// checkins, stats, patterns, TAG_LABELS, esc.

function ebShort(s, n) { s = String(s || '').trim().replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; }
function ebAvg(list) { return list.reduce((a, c) => a + c.energy_level, 0) / list.length; }
function ebTags(c) { if (Array.isArray(c.tags)) return c.tags; try { const t = JSON.parse(c.tags || '[]'); return Array.isArray(t) ? t : []; } catch { return []; } }
function ebLabel(tag) { return String(TAG_LABELS[tag] || tag).toLowerCase(); }

// ---------- 1. Glow reacts to the entry ----------
// entry: {energy, date, time, tags, charged, drained}; before: check-ins as they were before this save.
// Returns two short lowercase lines, plain text (callers escape).
function glowReaction(entry, before) {
  const n = entry.energy, tags = entry.tags || [];
  const aNum = (n === 8 ? 'an ' : 'a ') + n; // "an 8", never "a 8"
  if (tags.includes('caffeine') && n <= 4) return ['caffeine and ' + aNum + '?', 'suspicious.'];
  // Compare only with a check-in from earlier in the same day (a backfilled morning is not "down" from the afternoon).
  const order = { morning: 0, afternoon: 1, evening: 2 };
  const earlier = before.filter(c => c.checkin_date === entry.date && order[c.time_of_day] < order[entry.time])
    .sort((x, y) => order[y.time_of_day] - order[x.time_of_day]);
  if (earlier.length) {
    const prev = earlier[0].energy_level;
    if (n - prev >= 3) return ['up from a ' + prev + ' earlier.', 'whatever happened in between, do it again.'];
    if (prev - n >= 3) return ['down from a ' + prev + ' earlier.', 'what happened in between?'];
  }
  let best = null;
  for (const t of tags) {
    const past = before.filter(c => ebTags(c).includes(t));
    if (past.length < 2) continue;
    const a = ebAvg(past), diff = Math.abs(a - n);
    if (!best || diff > best.diff) best = { t, a, diff };
  }
  if (best && best.diff >= 2) return [ebLabel(best.t) + ' usually lands you at ' + best.a.toFixed(1) + '.', "today it's " + aNum + '. noted.'];
  if (entry.drained && n <= 4) return ['"' + ebShort(entry.drained, 28) + '" got you.', "logged it so we can spot it next time."];
  if (entry.charged && n >= 7) return ['"' + ebShort(entry.charged, 28) + '" worked.', "i'll remember that one."];
  if (best) return [ebLabel(best.t) + ' again, and ' + aNum + '.', "right about your usual for it."];
  if (tags.includes('sleep') && n >= 8) return ['sleep strikes again.', aNum + '!'];
  if (n >= 8) return [aNum + '!', "i'm glowing just looking at it."];
  if (n >= 5) return ['solid.', 'keep tracking.'];
  return ['low energy logged.', 'rest counts too.'];
}

// ---------- 2. One free insight ----------
function glowNoticedLine(list) {
  if (list.length < 5) return null;
  const overall = ebAvg(list);
  const times = ['morning', 'afternoon', 'evening'].map(t => {
    const g = list.filter(c => c.time_of_day === t);
    return { t, n: g.length, a: g.length ? ebAvg(g) : 0 };
  }).filter(x => x.n >= 2).sort((x, y) => y.a - x.a);
  if (times.length >= 2) {
    const hi = times[0], lo = times[times.length - 1], d = hi.a - lo.a;
    if (d >= 1) return 'your ' + lo.t + 's run ' + d.toFixed(1) + ' lower than your ' + hi.t + 's.';
  }
  const byTag = {};
  for (const c of list) for (const t of ebTags(c)) (byTag[t] = byTag[t] || []).push(c);
  let pick = null;
  for (const [t, g] of Object.entries(byTag)) {
    if (g.length < 2) continue;
    const d = ebAvg(g) - overall;
    if (!pick || Math.abs(d) > Math.abs(pick.d)) pick = { t, d };
  }
  if (pick && Math.abs(pick.d) >= 1) return 'days you tag ' + ebLabel(pick.t) + ' run ' + Math.abs(pick.d).toFixed(1) + (pick.d > 0 ? ' higher' : ' lower') + ' than your average.';
  return "your energy's been steady, around " + overall.toFixed(1) + '. steady is useful data too.';
}
function glowNoticedCard(forLocked) {
  const n = checkins.length;
  if (!n) return '';
  const line = glowNoticedLine(checkins);
  const body = line
    ? '<div class="gn-line">' + esc(line) + '</div>' + (forLocked ? '<div class="gn-foot">Pro shows every pattern, not just this one.</div>' : '')
    : '<div class="gn-line">log ' + (5 - n) + ' more check-in' + (5 - n === 1 ? '' : 's') + " and i'll tell you something i noticed.</div>";
  return '<div class="card glow-noticed"><div class="gn-lbl">Glow noticed</div>' + body + '</div>';
}
function renderFreeInsight() {
  const el = document.getElementById('free-insight');
  if (el) el.innerHTML = glowNoticedCard(false);
}

// ---------- 3. Backup cell ----------
function ebWeekday(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
}
function ebMonthDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate();
}
function renderBackupCell() {
  const el = document.getElementById('backupCell');
  if (!el) return;
  const b = stats.backup;
  if (!b || !stats.current_streak) { el.hidden = true; return; }
  const icon = '<svg viewBox="0 0 16 24" width="11" height="16" aria-hidden="true"><rect x="5" y="0" width="6" height="3" rx="1" fill="currentColor"/><rect x="1.5" y="3" width="13" height="19.5" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>' +
    (b.ready ? '<rect x="4" y="6" width="8" height="14" rx="1.5" fill="currentColor"/>' : '') + '</svg>';
  el.innerHTML = icon + '<span>' + (b.ready
    ? 'backup cell charged. it covers one missed day a week.'
    : 'backup cell covered ' + esc(ebWeekday(b.used_on)) + '. it recharges ' + esc(ebMonthDay(b.recharges_on)) + '.') + '</span>';
  el.classList.toggle('used', !b.ready);
  el.hidden = false;
}
