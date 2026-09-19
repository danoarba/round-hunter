import React, { useState, useEffect, useRef, useMemo } from 'react';
import { io } from 'socket.io-client';
import {
  Activity, Users, Mail, Settings, Search, Zap, Radar,
  Clock, XCircle, Clock3, Send, LayoutDashboard,
  Terminal, ChevronRight, Copy, ExternalLink,
  Pause, Play, RefreshCw, Inbox, AlertTriangle,
  Building2, MapPin, Phone, FileText, X, Check, RotateCcw, Crosshair
} from 'lucide-react';

const API_BASE_URL = window.location.port === '5173' ? `http://${window.location.hostname}:3001` : '';

/** Default hunt = Dental. Other industries are optional switches. */
const INDUSTRIES = [
  { id: 'dental', label: 'Dental Clinics', query: 'Dental Clinic', default: true },
  { id: 'ortho', label: 'Orthodontists', query: 'Orthodontist' },
  { id: 'derm', label: 'Dermatologists', query: 'Dermatologist' },
  { id: 'medspa', label: 'Medical Spas', query: 'Medical Spa' },
  { id: 'chiro', label: 'Chiropractors', query: 'Chiropractor' },
  { id: 'restaurant', label: 'Restaurants', query: 'Restaurant' },
  { id: 'cafe', label: 'Cafes', query: 'Cafe' },
  { id: 'salon', label: 'Hair Salons', query: 'Hair Salon' },
  { id: 'gym', label: 'Gyms & Fitness', query: 'Gym Fitness Center' },
  { id: 'hotel', label: 'Hotels', query: 'Hotel' },
  { id: 'law', label: 'Law Firms', query: 'Law Firm' },
  { id: 'realestate', label: 'Real Estate Agencies', query: 'Real Estate Agency' },
];

const LOCATIONS = [
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

const DEFAULT_INDUSTRY = INDUSTRIES.find(i => i.default) || INDUSTRIES[0];
const DEFAULT_LOCATION = 'New York, USA';

function buildTargetQuery(industryQuery, location) {
  return `${industryQuery} in ${location}`;
}

function isUkLocation(location) {
  const loc = (location || '').toLowerCase();
  return loc.includes('uk') || loc.includes('united kingdom') || loc.includes('london') || loc.includes('manchester');
}

function parseTargetQuery(q) {
  const raw = (q || '').trim();
  const match = raw.match(/^(.+?)\s+in\s+(.+)$/i);
  if (!match) {
    return { industryId: DEFAULT_INDUSTRY.id, location: DEFAULT_LOCATION, industryQuery: DEFAULT_INDUSTRY.query };
  }
  const industryQuery = match[1].trim();
  const location = match[2].trim();
  const found = INDUSTRIES.find(i => i.query.toLowerCase() === industryQuery.toLowerCase())
    || INDUSTRIES.find(i => industryQuery.toLowerCase().includes(i.query.toLowerCase().split(' ')[0]));
  return {
    industryId: found?.id || DEFAULT_INDUSTRY.id,
    industryQuery: found?.query || industryQuery,
    location: LOCATIONS.includes(location) ? location : location,
  };
}

const RESENDABLE = new Set(['Done', 'Failed', 'Email Opened', 'Hot Lead 🔥']);

const STATUS_FILTERS = [
  'All', 'Awaiting Approval', 'Queued', 'Sending', 'Done',
  'Email Opened', 'Hot Lead 🔥', 'No Email', 'No Website', 'Waiting', 'Ignored', 'Failed'
];

function canResend(p) {
  if (!p || !RESENDABLE.has(p.status)) return false;
  const email = String(p.email || '');
  if (!email || email.includes('not_found') || email === 'No Email Found' || !email.includes('@')) return false;
  if (p.status === 'No Website' || p.status === 'No Email') return false;
  return true;
}

function parsePayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Pull Services / Timings / Doctors even from older coreInfo-only payloads */
function intelligenceFields(prospect) {
  const payload = parsePayload(prospect?.api_payload) || {};
  const dyn = payload.dynamic_fields || {};
  const core = String(dyn.coreInfo || '');
  const fromCore = (label) => {
    const re = new RegExp(`${label}:\\s*([^.]*)\\.`, 'i');
    const m = core.match(re);
    return m ? m[1].trim() : '';
  };
  const dash = (v) => {
    const s = String(v || '').trim();
    return s && s !== '—' ? s : '';
  };
  return {
    services: dash(dyn.services) || fromCore('Services') || '—',
    timings: dash(dyn.clinic_timings) || fromCore('Hours') || '—',
    doctors: dash(dyn.doctors) || fromCore('Team') || '—',
    phone: dash(payload.phone) || fromCore('Phone') || '—',
    website: dash(payload.website_url) || '—',
    payload,
    dyn,
  };
}

function statusTone(status) {
  const map = {
    'Awaiting Approval': 'bg-teal-50 text-teal-800 border-teal-200',
    Queued: 'bg-amber-50 text-amber-800 border-amber-200',
    Sending: 'bg-sky-50 text-sky-800 border-sky-200',
    Done: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    'Email Opened': 'bg-cyan-50 text-cyan-800 border-cyan-200',
    'Hot Lead 🔥': 'bg-rose-50 text-rose-800 border-rose-200',
    'No Email': 'bg-orange-50 text-orange-800 border-orange-200',
    'No Website': 'bg-stone-100 text-stone-600 border-stone-200',
    Waiting: 'bg-yellow-50 text-yellow-800 border-yellow-200',
    Ignored: 'bg-stone-100 text-stone-500 border-stone-200',
    Failed: 'bg-red-50 text-red-700 border-red-200',
  };
  return map[status] || 'bg-stone-50 text-stone-700 border-stone-200';
}

export default function App() {
  const [swarmActive, setSwarmActive] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [prospectFilter, setProspectFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  const [logs, setLogs] = useState([]);
  const [prospects, setProspects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draftModal, setDraftModal] = useState(null);
  const [draftEmail, setDraftEmail] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [targetQuery, setTargetQuery] = useState(buildTargetQuery(DEFAULT_INDUSTRY.query, DEFAULT_LOCATION));
  const [industryId, setIndustryId] = useState(DEFAULT_INDUSTRY.id);
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [metrics, setMetrics] = useState({
    activeAgents: 0, leadsHunted: 0, pitchesDelivered: 0, conversionRate: 0.0
  });
  const [toast, setToast] = useState(null);
  const [health, setHealth] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [autoSend, setAutoSend] = useState({ enabled: false, dailySent: 0, dailyLimit: 50 });
  const [neededSwarmActive, setNeededSwarmActive] = useState(false);
  const [huntMode, setHuntMode] = useState('rotating');
  const [ukHuntSource, setUkHuntSource] = useState('auto');
  const [cylexApifyConfigured, setCylexApifyConfigured] = useState(false);

  const socketRef = useRef(null);
  const logsContainerRef = useRef(null);

  const showToast = (message, tone = 'ok') => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 3200);
  };

  const loadProspects = (opts = {}) => {
    const { toast = false, resetFilter = false } = opts;
    return fetch(`${API_BASE_URL}/api/prospects`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setProspects(list);
        if (resetFilter) setProspectFilter('All');
        if (toast) {
          const done = list.filter(p => p.status === 'Done').length;
          const failed = list.filter(p => p.status === 'Failed').length;
          const sending = list.filter(p => p.status === 'Sending').length;
          showToast(`Refreshed ${list.length} · Done ${done} · Failed ${failed} · Sending ${sending}`);
        }
        return list;
      })
      .catch(() => {
        setProspects([]);
        if (toast) showToast('Refresh failed — check connection', 'err');
        return [];
      });
  };

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    socketRef.current = io(API_BASE_URL);

    socketRef.current.on('statusUpdate', (data) => {
      setSwarmActive(data.swarmActive);
      if (typeof data.neededSwarmActive === 'boolean') setNeededSwarmActive(data.neededSwarmActive);
      if (data.metrics) setMetrics(data.metrics);
      if (data.autoSend) setAutoSend(data.autoSend);
      if (data.huntMode === 'quality' || data.huntMode === 'rotating') setHuntMode(data.huntMode);
      if (data.ukHuntSource) setUkHuntSource(data.ukHuntSource);
      if (typeof data.cylexApifyConfigured === 'boolean') setCylexApifyConfigured(data.cylexApifyConfigured);
      if (data.currentTargetQuery) {
        setTargetQuery(data.currentTargetQuery);
        const parsed = parseTargetQuery(data.currentTargetQuery);
        setIndustryId(parsed.industryId);
        setLocation(parsed.location);
      }
    });
    socketRef.current.on('initialLogs', (history) => setLogs(history || []));
    socketRef.current.on('logsCleared', () => setLogs([]));
    socketRef.current.on('log', (logEntry) => setLogs((prev) => [...prev.slice(-199), logEntry]));
    socketRef.current.on('prospect_updated', (data) => {
      setProspects((prev) => {
        const exists = prev.find(p => p.id === data.id);
        if (exists) return prev.map(p => p.id === data.id ? { ...p, ...data } : p);
        return [data, ...prev];
      });
      setSelected((s) => (s && s.id === data.id ? { ...s, ...data } : s));
    });

    loadProspects();
    fetch(`${API_BASE_URL}/api/health`).then(r => r.json()).then(setHealth).catch(() => {});

    return () => {
      clearInterval(timer);
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (['prospects', 'needed', 'campaigns', 'insights'].includes(activeTab)) loadProspects();
  }, [activeTab]);

  useEffect(() => {
    const el = logsContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, activeTab]);

  const toggleSwarm = () => socketRef.current?.emit('toggleSwarm');
  const toggleNeededSwarm = () => socketRef.current?.emit('toggleNeededSwarm');

  const isNeeded = (p) => (p?.lane || 'standard').toLowerCase() === 'needed';
  const isStandard = (p) => !isNeeded(p);

  const toggleAutoSend = () => {
    const next = !autoSend.enabled;
    socketRef.current?.emit('setAutoSend', { enabled: next, dailyLimit: autoSend.dailyLimit });
    setAutoSend((s) => ({ ...s, enabled: next }));
    showToast(next ? `Auto-send ON — max ${autoSend.dailyLimit || 50}/day` : 'Auto-send OFF — manual only');
  };

  const updateDailyLimit = (raw) => {
    const n = Math.min(200, Math.max(1, parseInt(raw, 10) || 50));
    setAutoSend((s) => ({ ...s, dailyLimit: n }));
    socketRef.current?.emit('setAutoSend', { dailyLimit: n });
  };

  const setUkHuntSourceChoice = (source) => {
    setUkHuntSource(source);
    socketRef.current?.emit('setUkHuntSource', { source });
    const labels = {
      auto: 'UK Auto — Apify Cylex API when token set, else free DDG',
      cylex_api: 'UK Cylex API only (Apify)',
      ddg: 'UK free DDG only',
    };
    showToast(labels[source] || labels.auto);
  };

  const setHuntModeChoice = (mode) => {
    const next = mode === 'quality' ? 'quality' : 'rotating';
    setHuntMode(next);
    socketRef.current?.emit('setHuntMode', { mode: next });
    showToast(
      next === 'quality'
        ? 'Hunt v2: Quality — multi-search, real email required'
        : 'Hunt v2: Rotating — more volume, includes No Email rows'
    );
  };

  const handleQueryChange = (newQuery) => {
    setTargetQuery(newQuery);
    const parsed = parseTargetQuery(newQuery);
    setIndustryId(parsed.industryId);
    setLocation(parsed.location);
    socketRef.current?.emit('setTargetQuery', newQuery);
  };

  const applyHuntTarget = (nextIndustryId, nextLocation) => {
    const industry = INDUSTRIES.find(i => i.id === nextIndustryId) || DEFAULT_INDUSTRY;
    const loc = nextLocation || DEFAULT_LOCATION;
    setIndustryId(industry.id);
    setLocation(loc);
    handleQueryChange(buildTargetQuery(industry.query, loc));
    showToast(`Hunting switched → ${industry.label} in ${loc}`);
  };

  const updateStatus = async (id, status) => {
    try {
      await fetch(`${API_BASE_URL}/api/prospects/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      setProspects(prev => prev.map(p => p.id === id ? { ...p, status } : p));
      if (selected?.id === id) setSelected(s => ({ ...s, status }));
      if (status === 'Queued') showToast('Queued — demo builds then email sends automatically');
      else showToast(`Status → ${status}`);
    } catch {
      showToast('Status update failed', 'err');
    }
  };

  const resendProspect = async (prospect) => {
    if (!canResend(prospect)) {
      showToast('Cannot resend this prospect', 'err');
      return;
    }
    if (!window.confirm(`Resend demo token + cold email to ${prospect.email}?`)) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/prospects/${prospect.id}/resend`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Resend failed', 'err');
        return;
      }
      setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, status: 'Queued' } : p));
      if (selected?.id === prospect.id) setSelected(s => ({ ...s, status: 'Queued' }));
      showToast('Resend queued — demo + email will send shortly');
    } catch {
      showToast('Resend failed', 'err');
    }
  };

  const resetDatabase = async () => {
    if (!window.confirm('Clear the entire CRM database and live logs? This cannot be undone.')) return;
    try {
      await fetch(`${API_BASE_URL}/api/prospects/reset`, { method: 'DELETE' });
      setProspects([]);
      setSelected(null);
      setLogs([]);
      showToast('Database and logs cleared');
    } catch {
      showToast('Reset failed', 'err');
    }
  };

  const openDraft = (prospect) => {
    setDraftModal(prospect);
    setDraftEmail(prospect.email?.includes('not_found') || prospect.email === 'No Email Found' ? '' : (prospect.email || ''));
    setDraftSubject(prospect.subject || `quick question about ${prospect.name}`);
  };

  const approveDraft = async () => {
    if (!draftModal) return;
    if (!draftEmail || !draftEmail.includes('@')) {
      showToast('Enter a valid email before queueing', 'err');
      return;
    }
    await updateStatus(draftModal.id, 'Queued');
    setDraftModal(null);
  };

  const filteredProspects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return prospects.filter(p => {
      if (!p || !isStandard(p)) return false;
      if (prospectFilter !== 'All' && p.status !== prospectFilter) return false;
      if (!q) return true;
      const hay = [p.name, p.email, p.location, p.niche, p.ceo_name, p.issue, p.status]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [prospects, prospectFilter, searchQuery]);

  const neededProspects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return prospects.filter(p => {
      if (!p || !isNeeded(p)) return false;
      if (prospectFilter !== 'All' && p.status !== prospectFilter) return false;
      if (!q) return true;
      const hay = [p.name, p.email, p.location, p.niche, p.issue, p.need_signal, p.status]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [prospects, prospectFilter, searchQuery]);

  const counts = useMemo(() => {
    const standard = prospects.filter(isStandard);
    const needed = prospects.filter(isNeeded);
    const c = {
      total: standard.length,
      await: 0,
      queued: 0,
      done: 0,
      opened: 0,
      hot: 0,
      failed: 0,
      noEmail: 0,
      neededTotal: needed.length,
      neededAwait: needed.filter(p => p.status === 'Awaiting Approval').length,
    };
    standard.forEach(p => {
      if (p.status === 'Awaiting Approval') c.await++;
      else if (p.status === 'Queued' || p.status === 'Sending') c.queued++;
      else if (p.status === 'Done') c.done++;
      else if (p.status === 'Email Opened') c.opened++;
      else if (p.status === 'Hot Lead 🔥') c.hot++;
      else if (p.status === 'Failed') c.failed++;
      else if (p.status === 'No Email') c.noEmail++;
    });
    return c;
  }, [prospects]);

  const nav = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'prospects', label: 'Prospects', icon: Users, badge: counts.await || null },
    { id: 'needed', label: 'Needed Clients', icon: Crosshair, badge: counts.neededAwait || null },
    { id: 'campaigns', label: 'Campaigns', icon: Mail, badge: counts.queued || null },
    { id: 'live', label: 'Live Log', icon: Terminal },
    { id: 'insights', label: 'Insights', icon: Activity },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied');
    } catch {
      showToast('Copy failed', 'err');
    }
  };

  return (
    <div className="h-screen flex overflow-hidden text-[15px]">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-[240px]' : 'w-[72px]'} shrink-0 bg-[#141816] text-[#e8ebe7] flex flex-col transition-[width] duration-200`}>
        <div className="h-16 px-4 flex items-center gap-3 border-b border-white/8">
          <div className="w-9 h-9 rounded-lg bg-teal-700 flex items-center justify-center shrink-0">
            <Radar size={18} className="text-teal-50" />
          </div>
          {sidebarOpen && (
            <div className="min-w-0">
              <div className="font-semibold tracking-tight truncate">Hermes</div>
              <div className="text-[11px] text-teal-300/80 tracking-wide">Dial AI Command</div>
            </div>
          )}
        </div>

        <nav className="flex-1 py-4 px-2 space-y-0.5 overflow-y-auto">
          {nav.map(item => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  active ? 'bg-white/10 text-white' : 'text-white/55 hover:text-white hover:bg-white/5'
                }`}
                title={item.label}
              >
                <Icon size={18} className="shrink-0" />
                {sidebarOpen && (
                  <>
                    <span className="flex-1 text-left text-sm font-medium">{item.label}</span>
                    {item.badge ? (
                      <span className="text-[11px] font-semibold bg-teal-700 text-white min-w-5 h-5 px-1.5 rounded-md flex items-center justify-center">
                        {item.badge}
                      </span>
                    ) : null}
                  </>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/8 space-y-2">
          <div className={`flex items-center gap-2 px-2 py-2 rounded-lg ${swarmActive ? 'bg-teal-900/40' : 'bg-white/5'}`}>
            <span className={`w-2 h-2 rounded-sm ${swarmActive ? 'bg-teal-400' : 'bg-rose-400'}`} />
            {sidebarOpen && (
              <span className="text-xs text-white/70 font-medium">
                {swarmActive ? 'Cold swarm live' : 'Cold swarm off'}
              </span>
            )}
          </div>
          <div className={`flex items-center gap-2 px-2 py-2 rounded-lg ${neededSwarmActive ? 'bg-amber-900/40' : 'bg-white/5'}`}>
            <span className={`w-2 h-2 rounded-sm ${neededSwarmActive ? 'bg-amber-400' : 'bg-white/25'}`} />
            {sidebarOpen && (
              <span className="text-xs text-white/70 font-medium">
                {neededSwarmActive ? 'Needed hunt live' : 'Needed hunt off'}
              </span>
            )}
          </div>
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="w-full text-xs text-white/40 hover:text-white/70 py-1"
          >
            {sidebarOpen ? 'Collapse' : '›'}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 shrink-0 surface border-b flex items-center justify-between px-6 gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
              {activeTab === 'live' ? 'Live Log'
                : activeTab === 'needed' ? 'Needed Clients'
                : activeTab === 'prospects' ? 'Prospects'
                : activeTab === 'campaigns' ? 'Campaigns'
                : activeTab === 'insights' ? 'Insights'
                : activeTab === 'settings' ? 'Settings'
                : 'Overview'}
            </h1>
            <p className="text-xs text-[var(--color-mute)] font-mono">{time}</p>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 surface-inset rounded-lg px-3 py-2 min-w-[280px]">
              <Search size={14} className="text-[var(--color-mute)]" />
              <input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!['prospects', 'needed'].includes(activeTab)) setActiveTab('prospects');
                }}
                placeholder="Search…"
                className="bg-transparent outline-none text-sm w-full placeholder:text-[var(--color-mute)]"
              />
            </div>
            {activeTab === 'needed' ? (
              <button
                onClick={toggleNeededSwarm}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                  neededSwarmActive
                    ? 'bg-rose-600 text-white hover:bg-rose-700'
                    : 'bg-amber-700 text-white hover:bg-amber-800'
                }`}
              >
                {neededSwarmActive ? <Pause size={16} /> : <Crosshair size={16} />}
                {neededSwarmActive ? 'Halt Need Hunt' : 'Start Need Hunt'}
              </button>
            ) : (
              <button
                onClick={toggleSwarm}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                  swarmActive
                    ? 'bg-rose-600 text-white hover:bg-rose-700'
                    : 'bg-teal-700 text-white hover:bg-teal-800'
                }`}
              >
                {swarmActive ? <Pause size={16} /> : <Play size={16} />}
                {swarmActive ? 'Halt Swarm' : 'Start Swarm'}
              </button>
            )}
          </div>
        </header>

        <main className={`flex-1 min-h-0 p-6 ${activeTab === 'live' ? 'overflow-hidden' : 'overflow-auto'}`}>
          <div className="max-w-[1400px] mx-auto">
            {activeTab === 'overview' && (
              <Overview
                metrics={metrics}
                counts={counts}
                targetQuery={targetQuery}
                industryId={industryId}
                location={location}
                huntMode={huntMode}
                onHuntModeChange={setHuntModeChoice}
                ukHuntSource={ukHuntSource}
                cylexApifyConfigured={cylexApifyConfigured}
                onUkHuntSourceChange={setUkHuntSourceChoice}
                onApplyHunt={applyHuntTarget}
                onQueryChange={handleQueryChange}
                swarmActive={swarmActive}
                logs={logs}
                logsContainerRef={logsContainerRef}
                onOpenProspects={() => setActiveTab('prospects')}
                onOpenCampaigns={() => setActiveTab('campaigns')}
              />
            )}

            {activeTab === 'prospects' && (
              <ProspectsView
                prospects={filteredProspects}
                allCount={prospects.filter(isStandard).length}
                filter={prospectFilter}
                setFilter={setProspectFilter}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                onSelect={setSelected}
                selected={selected}
                onDraft={openDraft}
                onStatus={updateStatus}
                onResend={resendProspect}
                onReset={resetDatabase}
                onRefresh={() => loadProspects({ toast: true, resetFilter: true })}
                copyText={copyText}
                autoSend={autoSend}
                onToggleAutoSend={toggleAutoSend}
                onDailyLimitChange={updateDailyLimit}
              />
            )}

            {activeTab === 'needed' && (
              <NeededClientsView
                prospects={neededProspects}
                allCount={counts.neededTotal}
                filter={prospectFilter}
                setFilter={setProspectFilter}
                neededSwarmActive={neededSwarmActive}
                onToggleHunt={toggleNeededSwarm}
                onSelect={setSelected}
                selected={selected}
                onDraft={openDraft}
                onStatus={updateStatus}
                onResend={resendProspect}
                onRefresh={() => loadProspects({ toast: true })}
                copyText={copyText}
              />
            )}

            {activeTab === 'campaigns' && (
              <CampaignsView
                prospects={prospects}
                onStatus={updateStatus}
                onResend={resendProspect}
                onSelect={setSelected}
                onDraft={openDraft}
              />
            )}

            {activeTab === 'live' && (
              <LiveLog logs={logs} swarmActive={swarmActive} logsContainerRef={logsContainerRef} />
            )}

            {activeTab === 'insights' && (
              <InsightsView counts={counts} metrics={metrics} prospects={prospects} />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                health={health}
                targetQuery={targetQuery}
                onRefreshHealth={() =>
                  fetch(`${API_BASE_URL}/api/health`).then(r => r.json()).then(setHealth).catch(() => {})
                }
              />
            )}
          </div>
        </main>
      </div>

      {/* Detail drawer */}
      {selected && (
        <DetailDrawer
          prospect={selected}
          onClose={() => setSelected(null)}
          onDraft={openDraft}
          onStatus={updateStatus}
          onResend={resendProspect}
          copyText={copyText}
        />
      )}

      {/* Draft modal */}
      {draftModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#141816]/45 backdrop-blur-[2px]">
          <div className="surface w-full max-w-2xl rounded-xl overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-[var(--color-line)] flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Review & queue</h3>
                <p className="text-xs text-[var(--color-mute)] mt-0.5">{draftModal.name}</p>
              </div>
              <button onClick={() => setDraftModal(null)} className="p-1.5 hover:bg-stone-100 rounded-md">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4 max-h-[60vh] overflow-auto">
              <label className="block">
                <span className="text-xs font-semibold text-[var(--color-mute)] uppercase tracking-wide">To</span>
                <input
                  type="email"
                  value={draftEmail}
                  onChange={(e) => setDraftEmail(e.target.value)}
                  className="mt-1.5 w-full surface-inset rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-teal-700/30"
                  placeholder="owner@clinic.com"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-[var(--color-mute)] uppercase tracking-wide">Subject</span>
                <input
                  type="text"
                  value={draftSubject}
                  onChange={(e) => setDraftSubject(e.target.value)}
                  className="mt-1.5 w-full surface-inset rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-teal-700/30"
                />
              </label>
              <div>
                <span className="text-xs font-semibold text-[var(--color-mute)] uppercase tracking-wide">Email body</span>
                <pre className="mt-1.5 surface-inset rounded-lg p-4 text-sm whitespace-pre-wrap font-sans leading-relaxed text-[var(--color-ink-soft)]">
                  {draftModal.draft || 'No draft yet'}
                </pre>
              </div>
              <p className="text-xs text-[var(--color-mute)] flex items-start gap-2">
                <Zap size={14} className="mt-0.5 text-teal-700 shrink-0" />
                On approve: dialaiagent.com builds the personalized demo (~10s), then Brevo sends this email.
              </p>
            </div>
            <div className="px-5 py-4 border-t border-[var(--color-line)] flex justify-end gap-2 bg-[#f7f9f6]">
              <button onClick={() => setDraftModal(null)} className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-stone-200/60">
                Keep draft
              </button>
              <button
                onClick={approveDraft}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-teal-700 text-white hover:bg-teal-800 inline-flex items-center gap-2"
              >
                <Send size={14} /> Approve & queue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-[60] px-4 py-3 rounded-lg text-sm font-medium shadow-lg border ${
          toast.tone === 'err'
            ? 'bg-red-50 text-red-800 border-red-200'
            : 'bg-[#141816] text-white border-transparent'
        }`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

/* ---------- Views ---------- */

function Overview({
  metrics, counts, targetQuery, industryId, location, huntMode, onHuntModeChange,
  ukHuntSource, cylexApifyConfigured, onUkHuntSourceChange,
  onApplyHunt, onQueryChange, swarmActive, logs, logsContainerRef, onOpenProspects, onOpenCampaigns,
}) {
  const activeIndustry = INDUSTRIES.find(i => i.id === industryId) || DEFAULT_INDUSTRY;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Active agents" value={metrics.activeAgents} hint={swarmActive ? 'Hunting' : 'Idle'} />
        <Stat label="Leads hunted" value={metrics.leadsHunted} hint="Session" />
        <Stat label="Awaiting you" value={counts.await} hint="Review drafts" action={onOpenProspects} />
        <Stat label="In queue" value={counts.queued} hint="Sending soon" action={onOpenCampaigns} />
      </div>

      <section className="surface rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Hunt target</h2>
            <p className="text-xs text-[var(--color-mute)] mt-0.5">
              Default is <span className="font-semibold text-teal-800">Dental Clinics</span>. Switch industry or country anytime — swarm follows immediately.
              {isUkLocation(location) && (
                <span className="block mt-1 text-teal-800/90">
                  UK data from{' '}
                  <a href="https://www.cylex-uk.co.uk/" target="_blank" rel="noreferrer" className="underline font-medium">Cylex</a>
                  {cylexApifyConfigured
                    ? ' via Apify API (structured fields).'
                    : ' — add APIFY_API_TOKEN on Railway for accurate API pulls (else free DDG).'}
                </span>
              )}
            </p>
          </div>
          <div className="text-xs font-mono surface-inset px-3 py-2 rounded-lg text-[var(--color-ink-soft)] max-w-full truncate">
            {targetQuery}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">Industry</span>
            <select
              value={industryId}
              onChange={(e) => onApplyHunt(e.target.value, location)}
              className="mt-1.5 w-full surface-inset rounded-lg px-3 py-3 text-sm font-medium outline-none focus:ring-2 focus:ring-teal-700/25"
            >
              {INDUSTRIES.map(i => (
                <option key={i.id} value={i.id}>
                  {i.label}{i.default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">Country / city</span>
            <select
              value={LOCATIONS.includes(location) ? location : '__custom'}
              onChange={(e) => {
                if (e.target.value === '__custom') return;
                onApplyHunt(industryId, e.target.value);
              }}
              className="mt-1.5 w-full surface-inset rounded-lg px-3 py-3 text-sm font-medium outline-none focus:ring-2 focus:ring-teal-700/25"
            >
              {LOCATIONS.map(loc => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
              {!LOCATIONS.includes(location) && (
                <option value="__custom">{location}</option>
              )}
            </select>
          </label>
        </div>

        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">Quick locations for {activeIndustry.label}</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {LOCATIONS.slice(0, 8).map(loc => (
              <button
                key={loc}
                onClick={() => onApplyHunt(industryId, loc)}
                className={`text-xs font-medium px-3 py-2 rounded-lg border transition-colors ${
                  location === loc
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'border-[var(--color-line)] hover:border-teal-700/40 text-[var(--color-ink-soft)]'
                }`}
              >
                {loc}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">Custom search (optional)</span>
          <input
            value={targetQuery}
            onChange={(e) => onQueryChange(e.target.value)}
            className="mt-1.5 w-full surface-inset rounded-lg px-3 py-3 text-sm font-medium outline-none focus:ring-2 focus:ring-teal-700/25"
            placeholder="e.g. Restaurant in Dubai, UAE"
          />
        </label>

        {isUkLocation(location) && (
          <div className="pt-2 border-t border-[var(--color-line)]">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">UK data source</span>
            <p className="text-xs text-[var(--color-mute)] mt-1 mb-3">
              Cylex has no public MCP on this app — production uses Apify&apos;s Cylex actor API. MCP in Cursor is optional for manual tests only.
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                ['auto', 'Auto (recommended)'],
                ['cylex_api', 'Cylex API only'],
                ['ddg', 'Free DDG'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  disabled={id === 'cylex_api' && !cylexApifyConfigured}
                  title={id === 'cylex_api' && !cylexApifyConfigured ? 'Set APIFY_API_TOKEN in Railway first' : ''}
                  onClick={() => onUkHuntSourceChange(id)}
                  className={`text-sm font-medium px-4 py-2.5 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    ukHuntSource === id || (id === 'cylex_api' && ukHuntSource === 'apify')
                      ? 'bg-teal-700 text-white border-teal-700'
                      : 'border-[var(--color-line)] hover:border-teal-700/40 text-[var(--color-ink-soft)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-[var(--color-line)]">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">Hunt method (v2)</span>
          <p className="text-xs text-[var(--color-mute)] mt-1 mb-3">
            Rotating runs several local searches per cycle and filters schools/.edu. Quality skips leads without a real email on the website.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onHuntModeChange('rotating')}
              className={`text-sm font-medium px-4 py-2.5 rounded-lg border transition-colors ${
                huntMode === 'rotating'
                  ? 'bg-teal-700 text-white border-teal-700'
                  : 'border-[var(--color-line)] hover:border-teal-700/40 text-[var(--color-ink-soft)]'
              }`}
            >
              Rotating — more leads
            </button>
            <button
              type="button"
              onClick={() => onHuntModeChange('quality')}
              className={`text-sm font-medium px-4 py-2.5 rounded-lg border transition-colors ${
                huntMode === 'quality'
                  ? 'bg-teal-700 text-white border-teal-700'
                  : 'border-[var(--color-line)] hover:border-teal-700/40 text-[var(--color-ink-soft)]'
              }`}
            >
              Quality — email required
            </button>
          </div>
        </div>
      </section>

      <div className="grid lg:grid-cols-5 gap-4 items-stretch">
        <section className="lg:col-span-2 surface rounded-xl p-5 flex flex-col min-h-0">
          <h2 className="font-semibold mb-1">Pipeline</h2>
          <p className="text-xs text-[var(--color-mute)] mb-4">Where every lead sits right now</p>
          <div className="space-y-2 flex-1">
            {[
              ['Awaiting Approval', counts.await],
              ['Queued / Sending', counts.queued],
              ['Done', counts.done],
              ['Opened', counts.opened],
              ['Hot leads', counts.hot],
              ['No email', counts.noEmail],
            ].map(([label, n]) => (
              <div key={label} className="flex items-center gap-3">
                <span className="text-sm text-[var(--color-ink-soft)] w-36 shrink-0">{label}</span>
                <div className="flex-1 h-2 rounded bg-[#e8ece7] overflow-hidden">
                  <div
                    className="h-full bg-teal-700/80 rounded transition-all"
                    style={{ width: `${Math.min(100, counts.total ? (n / counts.total) * 100 : 0)}%` }}
                  />
                </div>
                <span className="font-mono text-sm font-semibold w-8 text-right">{n}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="lg:col-span-3 rounded-xl overflow-hidden border border-[#1f2924] bg-[#0f1412] flex flex-col h-[380px] max-h-[380px]">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 text-sm text-teal-200/90 font-mono">
              <Terminal size={14} /> live swarm
            </div>
            <span className="text-[11px] text-white/40 font-mono">{logs.length} events</span>
          </div>
          <div ref={logsContainerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 font-mono text-[12px] space-y-1">
            {logs.length === 0 ? (
              <p className="text-white/35 py-16 text-center text-sm font-sans">
                Start the swarm to see scout / pitch activity here.
              </p>
            ) : (
              logs.slice(-80).map((log, i) => (
                <LogLine key={i} {...log} />
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function NeededClientsView({
  prospects, allCount, filter, setFilter, neededSwarmActive, onToggleHunt,
  onSelect, selected, onDraft, onStatus, onResend, onRefresh, copyText
}) {
  return (
    <div className="space-y-4">
      <section className="surface rounded-xl p-5 border border-amber-200/80 bg-gradient-to-br from-amber-50/80 to-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 text-amber-900 font-semibold text-sm mb-1">
              <Crosshair size={16} /> Needed Clients
            </div>
            <p className="text-sm text-[var(--color-ink-soft)] leading-relaxed">
              Alag lane: businesses already signaling demand — hiring virtual/remote receptionist,
              looking for AI phone agent, answering-service need. Hunt → personalized demo → cold email
              (same send engine, separate list from cold Prospects).
            </p>
          </div>
          <button
            onClick={onToggleHunt}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold ${
              neededSwarmActive
                ? 'bg-rose-600 text-white hover:bg-rose-700'
                : 'bg-amber-700 text-white hover:bg-amber-800'
            }`}
          >
            {neededSwarmActive ? <Pause size={16} /> : <Play size={16} />}
            {neededSwarmActive ? 'Halt Need Hunt' : 'Start Need Hunt'}
          </button>
        </div>
      </section>

      <div className="flex gap-4 h-[calc(100vh-16rem)] min-h-[420px]">
        <div className="flex-1 surface rounded-xl overflow-hidden flex flex-col min-w-0">
          <div className="p-4 border-b border-[var(--color-line)] space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-semibold">Demand queue</h2>
                <p className="text-xs text-[var(--color-mute)]">
                  Showing {prospects.length} of {allCount} needed leads
                </p>
              </div>
              <button onClick={onRefresh} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-[var(--color-line)] hover:bg-stone-50">
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {STATUS_FILTERS.map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium border ${
                    filter === f
                      ? 'bg-amber-800 text-white border-amber-800'
                      : 'border-[var(--color-line)] text-[var(--color-ink-soft)] hover:bg-stone-50'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {prospects.length === 0 ? (
              <div className="p-12 text-center text-sm text-[var(--color-mute)]">
                <Crosshair className="mx-auto mb-3 text-amber-700/50" size={28} />
                <p className="font-medium text-[var(--color-ink-soft)]">No needed clients yet</p>
                <p className="mt-1">Start Need Hunt to find hiring / AI receptionist demand signals.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--color-panel)] border-b border-[var(--color-line)] text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
                  <tr>
                    <th className="text-left font-semibold px-4 py-3">Business</th>
                    <th className="text-left font-semibold px-4 py-3">Need signal</th>
                    <th className="text-left font-semibold px-4 py-3">Contact</th>
                    <th className="text-left font-semibold px-4 py-3">Status</th>
                    <th className="text-right font-semibold px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => onSelect(p)}
                      className={`border-b border-[var(--color-line)] cursor-pointer hover:bg-amber-50/40 ${
                        selected?.id === p.id ? 'bg-amber-50/70' : ''
                      }`}
                    >
                      <td className="px-4 py-3 font-medium max-w-[200px] truncate">{p.name}</td>
                      <td className="px-4 py-3 text-xs text-[var(--color-ink-soft)] max-w-[240px] truncate">
                        {p.need_signal || p.issue || '—'}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono truncate max-w-[180px]">{p.email}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[11px] font-semibold px-2 py-1 rounded-md border ${statusTone(p.status)}`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex gap-2">
                          {p.status === 'Awaiting Approval' && (
                            <button
                              onClick={() => onDraft(p)}
                              className="text-xs font-semibold text-amber-900 hover:underline"
                            >
                              Review
                            </button>
                          )}
                          {canResend(p) && (
                            <button
                              onClick={() => onResend(p.id)}
                              className="text-xs font-semibold text-teal-800 hover:underline"
                            >
                              Resend
                            </button>
                          )}
                          {p.status === 'Awaiting Approval' && (
                            <button
                              onClick={() => onStatus(p.id, 'Ignored')}
                              className="text-xs font-semibold text-rose-700 hover:underline"
                            >
                              Ignore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProspectsView({
  prospects, allCount, filter, setFilter, searchQuery, setSearchQuery,
  onSelect, selected, onDraft, onStatus, onResend, onReset, onRefresh, copyText,
  autoSend, onToggleAutoSend, onDailyLimitChange
}) {
  return (
    <div className="flex gap-4 h-[calc(100vh-8.5rem)] min-h-[520px]">
      <div className="flex-1 surface rounded-xl overflow-hidden flex flex-col min-w-0">
        <div className="p-4 border-b border-[var(--color-line)] space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold">Prospects</h2>
              <p className="text-xs text-[var(--color-mute)]">
                Showing {prospects.length} of {allCount}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <label className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold border border-[var(--color-line)] bg-white">
                <span className="text-[var(--color-mute)]">Daily</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={autoSend?.dailyLimit ?? 50}
                  onChange={(e) => onDailyLimitChange?.(e.target.value)}
                  className="w-12 bg-transparent outline-none font-mono text-center"
                  title="Max auto-sends per day (1–200)"
                />
              </label>
              <button
                onClick={onToggleAutoSend}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  autoSend?.enabled
                    ? 'bg-teal-700 text-white border-teal-700 hover:bg-teal-800'
                    : 'border-[var(--color-line)] hover:bg-stone-50 text-[var(--color-ink-soft)]'
                }`}
                title="When ON: auto-queue Awaiting Approval with random delays up to your daily limit"
              >
                <Zap size={14} />
                {autoSend?.enabled ? 'Auto-send ON' : 'Auto-send OFF'}
                <span className={`font-mono ${autoSend?.enabled ? 'text-teal-100' : 'text-[var(--color-mute)]'}`}>
                  {autoSend?.dailySent ?? 0}/{autoSend?.dailyLimit ?? 50}
                </span>
              </button>
              <button onClick={onRefresh} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-[var(--color-line)] hover:bg-stone-50">
                <RefreshCw size={14} /> Refresh
              </button>
              <button onClick={onReset} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-rose-700 border border-rose-200 hover:bg-rose-50">
                <XCircle size={14} /> Reset DB + Logs
              </button>
            </div>
          </div>
          {autoSend?.enabled && (
            <p className="text-[11px] text-teal-800 bg-teal-50 border border-teal-100 rounded-lg px-3 py-2">
              Auto-send active: Awaiting Approval → Queued on a random ~1.5–5 min rhythm. Daily cap {autoSend.dailyLimit}. Change the Daily number anytime. Turn OFF for full manual control.
            </p>
          )}
          <div className="flex items-center gap-2 md:hidden surface-inset rounded-lg px-3 py-2">
            <Search size={14} className="text-[var(--color-mute)]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search…"
              className="bg-transparent outline-none text-sm w-full"
            />
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {STATUS_FILTERS.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium border ${
                  filter === f
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'border-[var(--color-line)] text-[var(--color-ink-soft)] hover:bg-stone-50'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {prospects.length === 0 ? (
            <EmptyState
              title="No prospects match"
              body={filter === 'All' ? 'Start the swarm from Overview to hunt leads.' : `Nothing in “${filter}”.`}
            />
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-[#f0f3ef] z-10">
                <tr className="text-[11px] uppercase tracking-wider text-[var(--color-mute)]">
                  <th className="py-3 px-4 font-semibold">Clinic</th>
                  <th className="py-3 px-4 font-semibold hidden lg:table-cell">Contact</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {prospects.map(p => (
                  <tr
                    key={p.id}
                    onClick={() => onSelect(p)}
                    className={`border-t border-[var(--color-line)] cursor-pointer transition-colors ${
                      selected?.id === p.id ? 'bg-teal-50/60' : 'hover:bg-[#f7f9f6]'
                    }`}
                  >
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-[var(--color-ink)]">{p.name}</div>
                      <div className="text-xs text-[var(--color-mute)] mt-0.5 flex items-center gap-1">
                        <MapPin size={11} /> {p.location || '—'} · {p.niche || '—'}
                      </div>
                      {p.ceo_name && (
                        <div className="text-xs text-teal-800 mt-0.5 font-medium">{p.ceo_name}</div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 hidden lg:table-cell text-sm text-[var(--color-ink-soft)]">
                      {p.email && !String(p.email).includes('not_found') ? p.email : (
                        <span className="text-orange-700 text-xs font-medium">No email</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex text-[11px] font-semibold px-2 py-1 rounded-md border ${statusTone(p.status)}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1 flex-wrap">
                        <IconBtn title="Ignore" onClick={() => onStatus(p.id, 'Ignored')}><XCircle size={15} /></IconBtn>
                        <IconBtn title="Waiting" onClick={() => onStatus(p.id, 'Waiting')}><Clock3 size={15} /></IconBtn>
                        {canResend(p) && (
                          <button
                            onClick={() => onResend(p)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-teal-700/30 text-teal-800 hover:bg-teal-50"
                            title="Resend demo token + cold email"
                          >
                            <RotateCcw size={12} /> Resend
                          </button>
                        )}
                        {p.status !== 'No Website' && !['Queued', 'Sending', 'Done', 'Email Opened', 'Hot Lead 🔥'].includes(p.status) && (
                          <button
                            onClick={() => onDraft(p)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold bg-teal-700 text-white hover:bg-teal-800"
                          >
                            <Send size={12} /> Review
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailDrawer({ prospect, onClose, onDraft, onStatus, onResend, copyText }) {
  const intel = intelligenceFields(prospect);
  const payload = intel.payload;
  const dyn = intel.dyn;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button className="absolute inset-0 bg-[#141816]/30" onClick={onClose} aria-label="Close" />
      <aside className="relative w-full max-w-md h-full surface border-l shadow-2xl overflow-y-auto animate-[slideIn_.2s_ease]">
        <div className="sticky top-0 bg-[var(--color-panel)] border-b border-[var(--color-line)] px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <h2 className="font-semibold text-lg leading-tight truncate">{prospect.name}</h2>
            <span className={`inline-flex mt-2 text-[11px] font-semibold px-2 py-1 rounded-md border ${statusTone(prospect.status)}`}>
              {prospect.status}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-stone-100"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          <Section title="Contact">
            <Row icon={Mail} label="Email" value={prospect.email} onCopy={() => copyText(prospect.email)} />
            <Row icon={Users} label="Decision maker" value={prospect.ceo_name || '—'} />
            <Row icon={MapPin} label="Location" value={prospect.location || '—'} />
            <Row icon={Building2} label="Niche" value={prospect.niche || '—'} />
            {prospect.linkedin_url && (
              <a
                href={prospect.linkedin_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm text-teal-800 font-medium hover:underline mt-2"
              >
                <ExternalLink size={14} /> Open LinkedIn profile
              </a>
            )}
          </Section>

          <Section title="Intelligence">
            <Row icon={AlertTriangle} label="Pain / issue" value={prospect.issue || '—'} />
            {prospect.need_signal && (
              <Row icon={Crosshair} label="Need signal" value={prospect.need_signal} />
            )}
            {(prospect.lane || 'standard') === 'needed' && (
              <Row icon={Crosshair} label="Lane" value="Needed Clients" />
            )}
            <Row icon={FileText} label="Services" value={intel.services} />
            <Row icon={Clock} label="Timings" value={intel.timings} />
            <Row icon={Users} label="Doctors" value={intel.doctors} />
            <Row icon={Phone} label="Phone (payload)" value={intel.phone} />
            <Row icon={ExternalLink} label="Website" value={intel.website} onCopy={intel.website !== '—' ? () => copyText(intel.website) : undefined} />
            {(dyn.consultation_fee || dyn.service_fees) && (
              <>
                <Row label="Consult fee" value={dyn.consultation_fee || '—'} />
                <Row label="Service fees" value={dyn.service_fees || '—'} />
              </>
            )}
          </Section>

          <Section title="Email draft">
            <p className="text-xs font-semibold text-[var(--color-mute)] mb-1">Subject</p>
            <p className="text-sm mb-3">{prospect.subject || '—'}</p>
            <pre className="surface-inset rounded-lg p-3 text-xs whitespace-pre-wrap leading-relaxed max-h-48 overflow-auto">
              {prospect.draft || 'No draft'}
            </pre>
          </Section>

          {payload && (
            <Section title="Demo payload (sent on approve)">
              <pre className="surface-inset rounded-lg p-3 text-[11px] font-mono overflow-auto max-h-40">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </Section>
          )}

          <Section title="Meta">
            <Row label="ID" value={String(prospect.id)} />
            <Row label="Created" value={prospect.created_at ? new Date(prospect.created_at).toLocaleString() : '—'} />
          </Section>
        </div>

        <div className="sticky bottom-0 border-t border-[var(--color-line)] bg-[var(--color-panel)] p-4 flex flex-wrap gap-2">
          {canResend(prospect) && (
            <button
              onClick={() => onResend(prospect)}
              className="flex-1 inline-flex justify-center items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border border-teal-700 text-teal-800 hover:bg-teal-50"
            >
              <RotateCcw size={14} /> Resend demo + email
            </button>
          )}
          {prospect.status !== 'No Website' && !['Queued', 'Sending', 'Done', 'Email Opened', 'Hot Lead 🔥'].includes(prospect.status) && (
            <button
              onClick={() => onDraft(prospect)}
              className="flex-1 inline-flex justify-center items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold bg-teal-700 text-white hover:bg-teal-800"
            >
              <Send size={14} /> Review & queue
            </button>
          )}
          <button onClick={() => onStatus(prospect.id, 'Waiting')} className="px-3 py-2.5 rounded-lg text-sm font-medium border border-[var(--color-line)] hover:bg-stone-50">
            Waiting
          </button>
          <button onClick={() => onStatus(prospect.id, 'Ignored')} className="px-3 py-2.5 rounded-lg text-sm font-medium text-rose-700 border border-rose-200 hover:bg-rose-50">
            Ignore
          </button>
        </div>
      </aside>
      <style>{`@keyframes slideIn { from { transform: translateX(12px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>
    </div>
  );
}

function CampaignsView({ prospects, onStatus, onResend, onSelect, onDraft }) {
  const groups = {
    active: prospects.filter(p => ['Queued', 'Sending'].includes(p.status)),
    sent: prospects.filter(p => ['Done', 'Email Opened', 'Hot Lead 🔥'].includes(p.status)),
    failed: prospects.filter(p => p.status === 'Failed'),
  };

  return (
    <div className="space-y-6">
      <div className="grid sm:grid-cols-3 gap-3">
        <Stat label="In queue" value={groups.active.length} hint="Auto-send ~30s" />
        <Stat label="Sent / engaged" value={groups.sent.length} hint="Done + opens" />
        <Stat label="Failed" value={groups.failed.length} hint="Use Resend" />
      </div>

      <CampaignList
        title="Sending queue"
        empty="Queue empty — approve a draft from Prospects."
        items={groups.active}
        onStatus={onStatus}
        onResend={onResend}
        onSelect={onSelect}
        onDraft={onDraft}
        cancelable
      />
      <CampaignList
        title="Sent & engaged"
        empty="No sends yet."
        items={groups.sent}
        onStatus={onStatus}
        onResend={onResend}
        onSelect={onSelect}
        onDraft={onDraft}
        resendable
      />
      <CampaignList
        title="Failed"
        empty="No failures."
        items={groups.failed}
        onStatus={onStatus}
        onResend={onResend}
        onSelect={onSelect}
        onDraft={onDraft}
        resendable
      />
    </div>
  );
}

function CampaignList({ title, empty, items, onStatus, onResend, onSelect, onDraft, cancelable, resendable }) {
  return (
    <section className="surface rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-line)]">
        <h2 className="font-semibold">{title}</h2>
      </div>
      {items.length === 0 ? (
        <p className="p-8 text-sm text-[var(--color-mute)] text-center">{empty}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {items.map((p, idx) => (
            <li key={p.id} className="px-5 py-4 flex items-center gap-4 hover:bg-[#f7f9f6]">
              <div className="w-8 h-8 rounded-lg surface-inset flex items-center justify-center text-xs font-mono font-semibold text-[var(--color-mute)]">
                {idx + 1}
              </div>
              <button onClick={() => onSelect(p)} className="flex-1 text-left min-w-0">
                <div className="font-semibold truncate">{p.name}</div>
                <div className="text-xs text-[var(--color-mute)] truncate">
                  {p.email}{p.ceo_name ? ` · ${p.ceo_name}` : ''}
                </div>
              </button>
              <span className={`text-[11px] font-semibold px-2 py-1 rounded-md border ${statusTone(p.status)}`}>
                {p.status}
              </span>
              {cancelable && (
                <button
                  onClick={() => onStatus(p.id, 'Awaiting Approval')}
                  className="text-xs font-semibold text-rose-700 hover:underline"
                >
                  Cancel
                </button>
              )}
              {resendable && canResend(p) && (
                <button
                  onClick={() => onResend(p)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-teal-800 hover:underline"
                >
                  <RotateCcw size={12} /> Resend
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LiveLog({ logs, swarmActive, logsContainerRef }) {
  return (
    <section className="rounded-xl overflow-hidden border border-[#1f2924] bg-[#0f1412] h-[calc(100vh-8.5rem)] max-h-[calc(100vh-8.5rem)] flex flex-col">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-sm text-teal-200 font-mono">
          <Terminal size={14} /> root@hermes
        </div>
        <span className={`text-[11px] font-semibold px-2 py-1 rounded ${swarmActive ? 'bg-teal-900 text-teal-200' : 'bg-white/10 text-white/50'}`}>
          {swarmActive ? 'RUNNING' : 'IDLE'}
        </span>
      </div>
      <div ref={logsContainerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 font-mono text-[12.5px] space-y-1">
        {logs.length === 0 ? (
          <EmptyState dark title="No log events" body="Deploy the swarm to stream agent output." />
        ) : (
          logs.map((log, i) => <LogLine key={i} {...log} />)
        )}
      </div>
    </section>
  );
}

function InsightsView({ counts, metrics, prospects }) {
  const byNiche = useMemo(() => {
    const m = {};
    prospects.forEach(p => {
      const k = p.niche || 'Unknown';
      m[k] = (m[k] || 0) + 1;
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [prospects]);

  return (
    <div className="space-y-6">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Total CRM" value={counts.total} />
        <Stat label="Pitches session" value={metrics.pitchesDelivered} />
        <Stat label="Conversion %" value={metrics.conversionRate} />
        <Stat label="Hot leads" value={counts.hot} />
      </div>
      <section className="surface rounded-xl p-5">
        <h2 className="font-semibold mb-4">By niche</h2>
        {byNiche.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">No data yet.</p>
        ) : (
          <div className="space-y-2">
            {byNiche.map(([niche, n]) => (
              <div key={niche} className="flex items-center gap-3">
                <span className="text-sm flex-1 truncate">{niche}</span>
                <div className="w-40 h-2 rounded bg-[#e8ece7] overflow-hidden">
                  <div className="h-full bg-teal-700/70" style={{ width: `${(n / counts.total) * 100}%` }} />
                </div>
                <span className="font-mono text-sm w-6 text-right">{n}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="surface rounded-xl p-5">
        <h2 className="font-semibold mb-2">How to use</h2>
        <ol className="text-sm text-[var(--color-ink-soft)] space-y-2 list-decimal list-inside leading-relaxed">
          <li>Set niche on Overview → Start Swarm</li>
          <li>Open Prospects → click a row for full intel</li>
          <li>Review draft → Approve & queue</li>
          <li>Watch Campaigns for send status + opens</li>
        </ol>
      </section>
    </div>
  );
}

function SettingsView({ health, targetQuery, onRefreshHealth }) {
  return (
    <div className="max-w-xl space-y-4">
      <section className="surface rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">System health</h2>
          <button onClick={onRefreshHealth} className="text-xs font-semibold text-teal-800 inline-flex items-center gap-1">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {health ? (
          <dl className="text-sm space-y-2">
            <div className="flex justify-between gap-4"><dt className="text-[var(--color-mute)]">API</dt><dd className="font-medium flex items-center gap-1"><Check size={14} className="text-teal-700" /> OK</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-[var(--color-mute)]">Swarm</dt><dd className="font-medium">{health.swarmActive ? 'Active' : 'Halted'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-[var(--color-mute)]">Public URL</dt><dd className="font-mono text-xs break-all text-right">{health.publicUrl || '—'}</dd></div>
          </dl>
        ) : (
          <p className="text-sm text-[var(--color-mute)]">Could not reach /api/health</p>
        )}
      </section>
      <section className="surface rounded-xl p-5">
        <h2 className="font-semibold mb-2">Active target</h2>
        <p className="text-sm font-medium">{targetQuery}</p>
        <p className="text-xs text-[var(--color-mute)] mt-3">
          Email sending needs BREVO_SMTP_USER / BREVO_SMTP_PASS on the server. Inbox replies need IMAP_* vars.
        </p>
      </section>
    </div>
  );
}

/* ---------- Atoms ---------- */

function Stat({ label, value, hint, action }) {
  const Comp = action ? 'button' : 'div';
  return (
    <Comp
      onClick={action}
      className={`surface rounded-xl p-4 text-left ${action ? 'hover:border-teal-700/40 transition-colors cursor-pointer' : ''}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)]">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-[var(--color-mute)] flex items-center gap-1">{hint}{action && <ChevronRight size={12} />}</div>}
    </Comp>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-mute)] mb-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ icon: Icon, label, value, onCopy }) {
  return (
    <div className="flex gap-2 items-start text-sm">
      {Icon && <Icon size={14} className="mt-0.5 text-[var(--color-mute)] shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-[var(--color-mute)]">{label}</div>
        <div className="font-medium break-words text-[var(--color-ink-soft)]">{value || '—'}</div>
      </div>
      {onCopy && value && value !== '—' && (
        <button onClick={onCopy} className="p-1 rounded hover:bg-stone-100 text-[var(--color-mute)]" title="Copy">
          <Copy size={13} />
        </button>
      )}
    </div>
  );
}

function IconBtn({ children, onClick, title }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-mute)] hover:bg-stone-100 hover:text-[var(--color-ink)]"
    >
      {children}
    </button>
  );
}

function EmptyState({ title, body, dark }) {
  return (
    <div className={`py-20 px-6 text-center ${dark ? 'text-white/40' : 'text-[var(--color-mute)]'}`}>
      <Inbox size={28} className="mx-auto mb-3 opacity-50" />
      <h3 className={`font-semibold ${dark ? 'text-white/70' : 'text-[var(--color-ink)]'}`}>{title}</h3>
      <p className="text-sm mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  );
}

function LogLine({ type, id, text, timestamp }) {
  const colors = {
    sys: 'text-white/45',
    worker: 'text-teal-300/90',
    alert: 'text-amber-300',
    success: 'text-emerald-300',
    action: 'text-sky-300',
  };
  return (
    <div className="flex gap-3 leading-relaxed">
      <span className="text-white/30 shrink-0 w-[62px]">{timestamp || '—'}</span>
      <span className={`shrink-0 w-[72px] font-semibold ${colors[type] || colors.sys}`}>
        {type === 'worker' ? id : (type || 'sys').toUpperCase()}
      </span>
      <span className="text-white/80 break-words">{text}</span>
    </div>
  );
}
