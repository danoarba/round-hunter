const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'auto_send_state.json');
const DEFAULT_DAILY_LIMIT = 50;
const MIN_DAILY_LIMIT = 1;
const MAX_DAILY_LIMIT = 200;
/** Random delay between auto-approves (ms) — keeps sends natural */
const MIN_DELAY_MS = 90 * 1000;
const MAX_DELAY_MS = 280 * 1000;

const HUNT_LOCATIONS = [
  'New York, USA',
  'Los Angeles, USA',
  'Chicago, USA',
  'Miami, USA',
  'Austin, USA',
  'Toronto, Canada',
  'Vancouver, Canada',
  'London, UK',
  'Manchester, UK',
  'Dubai, UAE',
  'Sydney, Australia',
  'Singapore',
];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function defaultState() {
  return {
    enabled: false,
    dailySent: 0,
    dailyLimit: DEFAULT_DAILY_LIMIT,
    day: todayKey(),
    emptyHuntStreak: 0,
    lastAutoAt: null,
    targetQuery: null,
  };
}

function clampDailyLimit(n) {
  const num = parseInt(n, 10);
  if (!Number.isFinite(num)) return DEFAULT_DAILY_LIMIT;
  return Math.min(MAX_DAILY_LIMIT, Math.max(MIN_DAILY_LIMIT, num));
}

function getDailyLimit(state) {
  return clampDailyLimit(state?.dailyLimit ?? DEFAULT_DAILY_LIMIT);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return defaultState();
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const base = { ...defaultState(), ...raw };
    if (base.dailyLimit == null) base.dailyLimit = DEFAULT_DAILY_LIMIT;
    else base.dailyLimit = clampDailyLimit(base.dailyLimit);
    if (base.day !== todayKey()) {
      base.day = todayKey();
      base.dailySent = 0;
    }
    return base;
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('auto_send_state save failed:', err.message);
  }
}

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function parseIndustryAndLocation(query) {
  const raw = String(query || '').trim();
  const match = raw.match(/^(.+?)\s+in\s+(.+)$/i);
  if (!match) {
    return { industryQuery: 'Dental Clinic', location: 'New York, USA' };
  }
  return { industryQuery: match[1].trim(), location: match[2].trim() };
}

function nextLocation(currentLocation) {
  const idx = HUNT_LOCATIONS.findIndex(
    (l) => l.toLowerCase() === String(currentLocation || '').toLowerCase()
  );
  const nextIdx = idx >= 0 ? (idx + 1) % HUNT_LOCATIONS.length : 0;
  return HUNT_LOCATIONS[nextIdx];
}

function buildQuery(industryQuery, location) {
  return `${industryQuery} in ${location}`;
}

function isValidOutboundEmail(email) {
  const e = String(email || '').trim();
  if (!e.includes('@')) return false;
  if (/not_found|no email/i.test(e)) return false;
  if (['test@fake.com', 'you@email.com'].includes(e.toLowerCase())) return false;
  return true;
}

module.exports = {
  DEFAULT_DAILY_LIMIT,
  MIN_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  HUNT_LOCATIONS,
  loadState,
  saveState,
  todayKey,
  randomDelayMs,
  parseIndustryAndLocation,
  nextLocation,
  buildQuery,
  isValidOutboundEmail,
  clampDailyLimit,
  getDailyLimit,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
};
