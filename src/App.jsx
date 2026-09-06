import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { 
  Bot, Terminal, Activity, Users, Mail, Settings, 
  Search, Shield, Zap, Globe, Radar, Command,
  ArrowUpRight, Cpu, Clock, XCircle, Clock3, Send, CheckCircle
} from 'lucide-react';

const API_BASE_URL = window.location.port === '5173' ? `http://${window.location.hostname}:3001` : '';

export default function App() {
  const [swarmActive, setSwarmActive] = useState(false);
  const [activeTab, setActiveTab] = useState('global');
  const [prospectFilter, setProspectFilter] = useState('All');
  const [time, setTime] = useState(new Date().toLocaleTimeString());
  const [logs, setLogs] = useState([]);
  const [prospects, setProspects] = useState([]);
  const [selectedDraft, setSelectedDraft] = useState(null);
  const [targetQuery, setTargetQuery] = useState('Dental Clinic in New York, USA');
  const [metrics, setMetrics] = useState({
    activeAgents: 0,
    leadsHunted: 0,
    pitchesDelivered: 0,
    conversionRate: 0.0
  });
  
  const socketRef = useRef(null);
  const logsEndRef = useRef(null);

  useEffect(() => {
    // Time interval
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    
    // Setup Socket connection to Backend
    socketRef.current = io(API_BASE_URL);
    
    socketRef.current.on('statusUpdate', (data) => {
      setSwarmActive(data.swarmActive);
      if (data.metrics) {
        setMetrics(data.metrics);
      }
      if (data.currentTargetQuery) {
        setTargetQuery(data.currentTargetQuery);
      }
    });

    socketRef.current.on('initialLogs', (history) => {
      setLogs(history);
    });

    socketRef.current.on('log', (logEntry) => {
      setLogs((prev) => [...prev, logEntry]);
    });
    
    socketRef.current.on('prospect_updated', (data) => {
      setProspects((prev) => {
        const exists = prev.find(p => p.id === data.id);
        if (exists) {
          return prev.map(p => p.id === data.id ? { ...p, ...data } : p);
        } else {
          return [data, ...prev];
        }
      });
    });

    return () => {
      clearInterval(timer);
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'prospects' || activeTab === 'campaigns') {
      fetch(`${API_BASE_URL}/api/prospects`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            setProspects(data);
          } else {
            setProspects([]);
          }
        })
        .catch(err => {
          console.error(err);
          setProspects([]);
        });
    }
  }, [activeTab]);

  const toggleSwarm = () => {
    if (socketRef.current) {
      socketRef.current.emit('toggleSwarm');
    }
  };

  const handleQueryChange = (newQuery) => {
    setTargetQuery(newQuery);
    if (socketRef.current) {
      socketRef.current.emit('setTargetQuery', newQuery);
    }
  };

  const updateStatus = async (id, status, prospect) => {
    try {
      await fetch(`${API_BASE_URL}/api/prospects/${id}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
      });
      // Optimistically update the UI
      setProspects(prev => prev.map(p => p.id === id ? { ...p, status } : p));
      
      // If status is "Queued", the backend loop will pick it up
      if (status === 'Queued') {
        alert(`Email added to Campaign Queue! It will be sent automatically.`);
      }
    } catch (error) {
      console.error('Error updating status', error);
    }
  };

  const resetDatabase = async () => {
    if (window.confirm("Are you sure you want to clear the entire CRM database? This cannot be undone.")) {
      try {
        await fetch(`${API_BASE_URL}/api/prospects/reset`, { method: 'DELETE' });
        setProspects([]);
      } catch (error) {
        console.error("Error resetting database:", error);
      }
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800 overflow-hidden font-sans selection:bg-indigo-500/20">
      
      {/* Sidebar Navigation */}
      <aside className="w-[280px] border-r border-slate-200 bg-white/60 backdrop-blur-3xl flex flex-col relative z-20 shadow-xl">
        <div className="h-20 flex items-center px-8 border-b border-slate-200 relative overflow-hidden">
          {/* Logo Glow */}
          <div className="absolute top-1/2 left-8 -translate-y-1/2 w-10 h-10 bg-indigo-500/20 blur-xl rounded-full"></div>
          
          <div className="flex items-center gap-3 relative z-10">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 p-[2px] shadow-[0_0_15px_rgba(99,102,241,0.3)]">
              <div className="w-full h-full bg-white rounded-[10px] flex items-center justify-center backdrop-blur-md">
                <Radar size={22} className="text-indigo-600 animate-spin-slow" style={{ animationDuration: '4s' }} />
              </div>
            </div>
            <div>
              <span className="block font-bold text-lg tracking-tight text-slate-900 leading-tight">Hermes OS</span>
              <span className="block text-[11px] uppercase tracking-widest text-indigo-600 font-bold">Dial AI Core</span>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-8 px-4 space-y-2 overflow-y-auto">
          <div className="px-4 text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Command Center</div>
          <NavItem icon={<Globe size={18} />} label="Global Swarm" active={activeTab === 'global'} onClick={() => setActiveTab('global')} />
          <NavItem icon={<Terminal size={18} />} label="Live Trajectories" badge="12" active={activeTab === 'trajectories'} onClick={() => setActiveTab('trajectories')} />
          <NavItem icon={<Users size={18} />} label="Hunted Prospects" active={activeTab === 'prospects'} onClick={() => setActiveTab('prospects')} />
          <NavItem icon={<Mail size={18} />} label="Active Campaigns" active={activeTab === 'campaigns'} onClick={() => setActiveTab('campaigns')} />
          
          <div className="px-4 text-xs font-bold text-slate-400 uppercase tracking-widest mt-8 mb-4">Intelligence</div>
          <NavItem icon={<Activity size={18} />} label="Performance Analytics" active={activeTab === 'analytics'} onClick={() => setActiveTab('analytics')} />
          <NavItem icon={<Shield size={18} />} label="Security & Guardrails" active={activeTab === 'security'} onClick={() => setActiveTab('security')} />
          <NavItem icon={<Cpu size={18} />} label="Compute Allocation" active={activeTab === 'compute'} onClick={() => setActiveTab('compute')} />
        </nav>
        
        <div className="p-6 border-t border-slate-200 bg-gradient-to-b from-transparent to-slate-100/50">
          <button className="w-full glass-button flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-slate-700 group hover:text-indigo-600">
            <Settings size={18} className="group-hover:rotate-90 transition-transform duration-500" />
            System Preferences
          </button>
        </div>
      </aside>

      {/* Main Workspace */}
      <main className="flex-1 flex flex-col min-w-0 relative z-10 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-100/40 via-slate-50 to-slate-50">
        
        {/* Top Header */}
        <header className="h-20 border-b border-slate-200 flex items-center justify-between px-8 bg-white/70 backdrop-blur-xl sticky top-0 z-30 shadow-sm">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight capitalize">
              {activeTab.replace('-', ' ')} Overview
            </h1>
            <div className="h-6 w-px bg-slate-300"></div>
            <div className="flex items-center gap-2 text-sm font-mono text-slate-600 bg-slate-100 px-4 py-2 rounded-full border border-slate-200 shadow-inner">
              <div className={`w-2.5 h-2.5 rounded-full ${swarmActive ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]'}`}></div>
              {swarmActive ? 'System Online' : 'System Halted'} • {time}
            </div>
          </div>
          
          <div className="flex items-center gap-5">
            <button className="w-11 h-11 rounded-full border border-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-all bg-white shadow-sm">
              <Command size={18} />
            </button>
            <div className="flex items-center gap-3 pl-5 border-l border-slate-200">
              <div className="text-right hidden md:block">
                <div className="text-sm font-bold text-slate-900">Admin Access</div>
                <div className="text-xs text-slate-500 font-medium">Workspace Owner</div>
              </div>
              <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-indigo-500 to-emerald-500 p-[2px] shadow-lg shadow-indigo-500/10">
                <div className="w-full h-full bg-white rounded-full border-2 border-white overflow-hidden">
                  <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Felix&backgroundColor=transparent" alt="User" className="w-full h-full object-cover opacity-90" />
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Dashboard Grid */}
        <div className="flex-1 overflow-auto p-8 relative">
          
          <div className="max-w-[1600px] mx-auto space-y-8">
            
            {activeTab === 'global' ? (
              <>
                {/* Top Metrics Row */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <AdvancedMetric title="Active Agents" value={metrics.activeAgents.toString()} suffix="/ 50" trend={metrics.activeAgents > 0 ? "+4" : "0"} status={metrics.activeAgents > 0 ? "optimal" : "low"} icon={<Bot size={24}/>} />
                  <AdvancedMetric title="Leads Hunted" value={metrics.leadsHunted.toLocaleString()} suffix="today" trend="+142" status="high" icon={<Search size={24}/>} />
                  <AdvancedMetric title="Pitches Delivered" value={metrics.pitchesDelivered.toLocaleString()} trend="+86" status="optimal" icon={<Mail size={24}/>} />
                  <AdvancedMetric title="Conversion Rate" value={metrics.conversionRate.toString()} suffix="%" trend="+1.2%" status="optimal" icon={<Zap size={24}/>} />
                </div>

                {/* Target Niche & Location Selector */}
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                      <Search size={20} />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1">
                        Active Target Niche & Location (Google Maps Search)
                      </label>
                      <input 
                        type="text" 
                        value={targetQuery}
                        onChange={(e) => handleQueryChange(e.target.value)}
                        placeholder="e.g. Dental Clinic in New York, USA"
                        className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-slate-400">Presets:</span>
                    {[
                      'Dental Clinic in New York, USA',
                      'Dermatologist in London, UK',
                      'Medical Spa in Miami, USA',
                      'Orthodontist in Toronto, Canada'
                    ].map((preset) => (
                      <button
                        key={preset}
                        onClick={() => handleQueryChange(preset)}
                        className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all ${
                          targetQuery === preset 
                            ? 'bg-indigo-600 text-white border-indigo-600' 
                            : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {preset.split(' in ')[0]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Main Visualizer and Terminal */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]">
                  
                  {/* Agent Swarm Visualizer (Map/Grid) */}
                  <div className="lg:col-span-1 glass-panel rounded-2xl flex flex-col overflow-hidden relative shadow-lg">
                    <div className="p-6 border-b border-slate-100 flex justify-between items-center z-10 relative bg-white">
                      <div>
                        <h2 className="text-lg font-bold text-slate-900">Swarm Activity</h2>
                        <p className="text-sm text-slate-500 mt-1">Live agent distribution</p>
                      </div>
                      <button onClick={toggleSwarm} className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all border shadow-sm ${swarmActive ? 'bg-rose-50 text-rose-600 border-rose-200 hover:bg-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100'}`}>
                        {swarmActive ? 'Halt Swarm' : 'Deploy Swarm'}
                      </button>
                    </div>
                    
                    {/* Visualizer Grid */}
                    <div className="flex-1 p-6 relative flex items-center justify-center bg-slate-50">
                      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+CjxjaXJjbGUgY3g9IjEiIGN5PSIxIiByPSIxIiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9IjAuMDQiLz4KPC9zdmc+')] opacity-100"></div>
                      
                      <div className="relative w-full aspect-square max-w-[320px] border-2 border-slate-200 rounded-full flex items-center justify-center shadow-[inset_0_0_40px_rgba(0,0,0,0.02)]">
                        <div className="absolute inset-0 rounded-full border-2 border-indigo-400/20 animate-ping" style={{ animationDuration: '3s' }}></div>
                        <div className="w-3/4 h-3/4 rounded-full border-2 border-slate-200 flex items-center justify-center relative bg-white/50 backdrop-blur-sm">
                          {/* Central Core */}
                          <div className="w-20 h-20 rounded-full bg-indigo-50 border-2 border-indigo-200 flex items-center justify-center shadow-[0_0_30px_rgba(99,102,241,0.2)] z-20 backdrop-blur-md">
                            <Cpu size={32} className="text-indigo-600" />
                          </div>
                          
                          {/* Orbiting Agents */}
                          {swarmActive && (
                            <>
                              <OrbitingAgent delay="0s" duration="8s" color="bg-emerald-500" />
                              <OrbitingAgent delay="-2s" duration="12s" color="bg-blue-500" />
                              <OrbitingAgent delay="-5s" duration="10s" color="bg-purple-500" />
                              <OrbitingAgent delay="-8s" duration="15s" color="bg-amber-500" />
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Hyper-Realistic Terminal (Even in Light mode, terminals often look best with a dark or slightly off-white theme. Let's make it an elegant slate terminal) */}
                  <div className="lg:col-span-2 rounded-2xl flex flex-col overflow-hidden relative group shadow-xl border border-slate-800 bg-[#0f172a]">
                    <div className="h-16 border-b border-white/10 bg-slate-900 flex items-center px-6 justify-between z-10 relative">
                      <div className="flex items-center gap-4">
                        <div className="flex gap-2.5">
                          <div className="w-3.5 h-3.5 rounded-full bg-rose-500"></div>
                          <div className="w-3.5 h-3.5 rounded-full bg-amber-400"></div>
                          <div className="w-3.5 h-3.5 rounded-full bg-emerald-500"></div>
                        </div>
                        <div className="text-sm font-mono text-slate-300 flex items-center gap-2 font-bold">
                          <Terminal size={16} className="text-indigo-400" /> root@hermes-swarm:~
                        </div>
                      </div>
                      <div className="text-xs font-mono text-indigo-300 bg-indigo-500/20 px-3 py-1.5 rounded-md border border-indigo-400/30 font-bold">
                        Auto-scroll: ON
                      </div>
                    </div>
                    
                    <div className="flex-1 p-6 font-mono text-[14px] overflow-y-auto relative">
                      {/* Scanline effect */}
                      <div className="absolute inset-0 h-full w-full pointer-events-none opacity-[0.1] bg-[linear-gradient(transparent_50%,rgba(0,0,0,1)_50%)] bg-[length:100%_4px] z-10"></div>
                      
                      <div className="space-y-1.5 relative z-20">
                        {logs.length > 0 ? (
                          <>
                            {logs.map((log, index) => (
                              <LogLine key={index} type={log.type} id={log.id} text={log.text} timestamp={log.timestamp} />
                            ))}
                            {swarmActive && (
                              <div className="flex items-center gap-2 text-slate-400 animate-pulse mt-4 font-bold">
                                <span className="text-emerald-400 text-lg">➜</span>
                                <span className="typing-effect text-slate-300">Awaiting next signal</span>
                                <span className="inline-block w-2.5 h-5 bg-slate-400"></span>
                              </div>
                            )}
                            <div ref={logsEndRef} />
                          </>
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full text-slate-500 mt-24">
                            <Terminal size={48} className="mb-6 opacity-40" />
                            <p className="text-lg font-bold">Swarm operations halted.</p>
                            <p className="text-sm mt-3 opacity-80">Click 'Deploy Swarm' to resume hunting.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                </div>
              </>
            ) : activeTab === 'prospects' ? (
              <div className="glass-panel rounded-2xl shadow-xl overflow-hidden flex flex-col h-[750px]">
                <div className="p-6 border-b border-slate-200 bg-white flex flex-col z-10 gap-4">
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-xl font-bold text-slate-900">Hunted Prospects (CRM)</h2>
                      <p className="text-sm text-slate-500 mt-1">Targeted leads automatically found by Scout Agent.</p>
                    </div>
                    <div className="flex gap-3">
                      <button onClick={resetDatabase} className="px-4 py-2 bg-rose-50 border border-rose-200 text-rose-600 font-bold text-sm rounded-lg hover:bg-rose-100 shadow-sm flex items-center gap-2" title="Clear all prospects to start fresh">
                        <XCircle size={16} /> Reset Database
                      </button>
                      <button className="px-4 py-2 bg-indigo-600 text-white font-bold text-sm rounded-lg hover:bg-indigo-500 shadow-sm shadow-indigo-500/30 flex items-center gap-2">
                        <Mail size={16} /> Mass Pitch Selected
                      </button>
                    </div>
                  </div>
                  {/* Prospect Filters */}
                  <div className="flex gap-2 border-b border-slate-100 pb-2">
                    {['All', 'Awaiting Approval', 'Queued', 'No Email', 'No Website', 'Waiting', 'Ignored'].map(filter => (
                      <button 
                        key={filter}
                        onClick={() => setProspectFilter(filter)}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${
                          prospectFilter === filter 
                            ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' 
                            : 'text-slate-500 hover:bg-slate-50 border border-transparent hover:border-slate-200'
                        }`}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                </div>
                
                <div className="flex-1 overflow-auto bg-slate-50">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-100/80 sticky top-0 z-20 backdrop-blur-md">
                      <tr>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200 w-12"><input type="checkbox" className="rounded border-slate-300" /></th>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200">Clinic Name</th>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200">Contact</th>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200">Date & Time</th>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200">Identified Pain Point</th>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200">Status</th>
                        <th className="py-4 px-6 font-bold text-xs text-slate-500 uppercase tracking-widest border-b border-slate-200 text-right w-[250px]">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(Array.isArray(prospects) ? prospects : []).filter(p => p && (prospectFilter === 'All' ? true : p?.status === prospectFilter)).length > 0 ? (Array.isArray(prospects) ? prospects : []).filter(p => p && (prospectFilter === 'All' ? true : p?.status === prospectFilter)).map((prospect) => {
                        const locText = ((prospect.location || '') + ' ' + (prospect.niche || '')).toLowerCase();
                        return (
                        <tr key={prospect.id || prospect.name || Math.random()} className="hover:bg-white transition-colors group">
                          <td className="py-4 px-6"><input type="checkbox" className="rounded border-slate-300" /></td>
                          <td className="py-4 px-6">
                            <div className="font-bold text-slate-900">{prospect.name}</div>
                            {prospect.ceo_name && (
                              <div className="text-xs font-bold text-indigo-600 mt-0.5">👤 {prospect.ceo_name}</div>
                            )}
                            <div className="text-xs text-slate-400 font-medium flex items-center gap-2 mt-1">
                              <span className="text-sm">
                                {locText.includes('uk') ? '🇬🇧' : 
                                 locText.includes('canada') || locText.includes('toronto') ? '🇨🇦' : 
                                 locText.includes('usa') || locText.includes('united states') ? '🇺🇸' : 
                                 '🌍'}
                              </span>
                              <div className="flex flex-col">
                                <span className="truncate max-w-[200px]" title={prospect.location}>
                                  {prospect.location && prospect.location !== "Unknown Location" ? prospect.location : "Location not found"}
                                </span>
                                <span className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">{prospect.niche}</span>
                              </div>
                            </div>
                          </td>
                          <td className="py-4 px-6 text-sm font-medium">
                            {(!prospect.email || prospect.email.includes('not_found@example.com')) ? (
                              <span className="text-xs text-rose-500 font-semibold bg-rose-50 border border-rose-100 px-2 py-0.5 rounded">No Email Found</span>
                            ) : (
                              <span className="text-slate-600">{prospect.email}</span>
                            )}
                          </td>
                          <td className="py-4 px-6 text-sm text-slate-500">
                            <div className="flex items-center gap-1.5 font-mono text-[11px]">
                              <Clock size={12} className="text-slate-400" />
                              {prospect.created_at ? new Date(prospect.created_at).toLocaleString() : 'Just now'}
                            </div>
                          </td>
                          <td className="py-4 px-6 text-sm">
                            <span className={`px-3 py-1 rounded-md text-xs font-bold border line-clamp-1 max-w-[200px] ${
                              prospect.status === 'No Website' ? 'bg-slate-100 text-slate-500 border-slate-200' : 'bg-rose-50 text-rose-600 border-rose-100'
                            }`} title={prospect.issue}>
                              {prospect.issue}
                            </span>
                          </td>
                          <td className="py-4 px-6">
                            <span className={`px-3 py-1 rounded-full text-[11px] font-bold border flex w-max items-center gap-1.5 ${
                              prospect.status === 'Identified' ? 'bg-indigo-50 text-indigo-600 border-indigo-200' :
                              prospect.status === 'Ignored' ? 'bg-slate-100 text-slate-600 border-slate-200' :
                              prospect.status === 'Waiting' ? 'bg-amber-50 text-amber-600 border-amber-200' :
                              prospect.status === 'Queued' ? 'bg-purple-50 text-purple-600 border-purple-200 animate-pulse' :
                              prospect.status === 'No Website' ? 'bg-slate-100 text-slate-500 border-slate-300' :
                              prospect.status === 'No Email' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                              prospect.status === 'Done' ? 'bg-teal-50 text-teal-600 border-teal-200' :
                              prospect.status === 'Email Opened' ? 'bg-blue-50 text-blue-600 border-blue-200 shadow-[0_0_10px_rgba(59,130,246,0.3)]' :
                              prospect.status === 'Hot Lead 🔥' ? 'bg-rose-500 text-white border-rose-600 shadow-[0_0_15px_rgba(244,63,94,0.5)]' :
                              prospect.status === 'Failed' ? 'bg-red-50 text-red-600 border-red-200' :
                              'bg-emerald-50 text-emerald-600 border-emerald-200'
                            }`}>
                              <div className="w-1.5 h-1.5 rounded-full bg-current"></div>
                              {prospect.status}
                            </span>
                          </td>
                          <td className="py-4 px-6 text-right">
                            <div className="flex items-center justify-end gap-2 transition-opacity">
                              {prospect.linkedin_url && (
                                <a 
                                  href={prospect.linkedin_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="w-8 h-8 flex items-center justify-center rounded-lg text-blue-600 bg-blue-50 hover:bg-blue-600 hover:text-white border border-blue-100 transition-all"
                                  title="Open CEO LinkedIn"
                                >
                                  In
                                </a>
                              )}
                              <button 
                                onClick={() => updateStatus(prospect.id, 'Ignored', prospect)}
                                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100 transition-all"
                                title="Ignore"
                              >
                                <XCircle size={16} />
                              </button>
                              <button 
                                onClick={() => updateStatus(prospect.id, 'Waiting', prospect)}
                                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 border border-transparent hover:border-amber-100 transition-all"
                                title="Waiting"
                              >
                                <Clock3 size={16} />
                              </button>
                              {prospect.status !== 'No Website' && (
                                <button 
                                  onClick={() => setSelectedDraft(prospect)}
                                  className="px-3 py-1.5 flex items-center gap-1.5 rounded-lg text-indigo-600 bg-indigo-50 font-bold text-xs border border-indigo-100 hover:bg-indigo-600 hover:text-white transition-all"
                                  title="Review & Send"
                                >
                                  <Send size={14} /> Preview Email
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    }) : (
                        <tr>
                          <td colSpan="6" className="py-24 text-center">
                            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                              <Search size={24} />
                            </div>
                            <h3 className="text-lg font-bold text-slate-700">No Prospects Found</h3>
                            <p className="text-slate-500 mt-1 max-w-sm mx-auto">
                              {prospectFilter === 'All' 
                                ? "Deploy the swarm from the Global dashboard to instruct the Scout Agent to start hunting leads."
                                : `No prospects match the filter "${prospectFilter}".`
                              }
                            </p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : activeTab === 'campaigns' ? (
              <div className="glass-panel rounded-2xl shadow-xl overflow-hidden flex flex-col h-[750px]">
                <div className="p-6 border-b border-slate-200 bg-white z-10">
                  <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                    <Mail size={24} className="text-indigo-600" /> Active Campaigns (Queue)
                  </h2>
                  <p className="text-sm text-slate-500 mt-1">Emails are sent automatically every 3-5 minutes to prevent spam filtering.</p>
                </div>
                <div className="p-8 flex-1 bg-slate-50 overflow-auto">
                  <div className="max-w-3xl mx-auto space-y-4">
                    {(Array.isArray(prospects) ? prospects : []).filter(p => p && p.status === 'Queued').length === 0 ? (
                      <div className="text-center py-20">
                        <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300 shadow-sm border border-slate-100">
                          <CheckCircle size={32} />
                        </div>
                        <h3 className="text-lg font-bold text-slate-700">Queue is Empty</h3>
                        <p className="text-slate-500 mt-1">All campaigns have been sent successfully. Go to Prospects to queue more.</p>
                      </div>
                    ) : (
                      (Array.isArray(prospects) ? prospects : []).filter(p => p && p.status === 'Queued').map((prospect, idx) => (
                        <div key={prospect.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-sm">
                              #{idx + 1}
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-900">{prospect.name}</h4>
                              <p className="text-sm text-slate-500">{prospect.email} • {prospect.ceo_name ? `To: ${prospect.ceo_name}` : 'Generic Email'}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-bold text-amber-600 bg-amber-50 px-3 py-1 rounded-full animate-pulse border border-amber-200">
                              Waiting in Queue...
                            </span>
                            <button onClick={() => updateStatus(prospect.id, 'Awaiting Approval', prospect)} className="text-sm text-slate-400 hover:text-rose-600 font-bold underline">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-[600px] glass-panel rounded-2xl border-dashed border-2 border-indigo-200">
                <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6 border border-indigo-100 shadow-[0_0_20px_rgba(99,102,241,0.1)]">
                  <Bot size={40} className="text-indigo-500" />
                </div>
                <h2 className="text-2xl font-bold text-slate-800 mb-2">Module Loaded: {activeTab.replace('-', ' ').toUpperCase()}</h2>
                <p className="text-slate-500 max-w-md text-center text-lg">
                  Backend logic is currently disconnected. UI design phase is active. 
                  Connect this module to Hermes Agent core to see live data.
                </p>
                <button onClick={() => setActiveTab('global')} className="mt-8 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow-[0_8px_20px_rgba(99,102,241,0.3)] transition-all transform hover:-translate-y-1">
                  Return to Dashboard
                </button>
              </div>
            )}
            
          </div>
        </div>

        {/* Draft View Modal */}
        {selectedDraft && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-200">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  <Mail size={18} className="text-indigo-500" />
                  Review Pitch: {selectedDraft.name}
                </h3>
                <button onClick={() => setSelectedDraft(null)} className="text-slate-400 hover:text-slate-600">
                  &times;
                </button>
              </div>
              <div className="p-6 space-y-4 text-sm text-slate-700">
                <div className="flex gap-2 items-center">
                  <span className="font-bold text-slate-900 w-16">To:</span> 
                  <input 
                    type="email"
                    defaultValue={selectedDraft.email?.includes('not_found@example.com') ? '' : selectedDraft.email}
                    placeholder="Enter target email (e.g. owner@clinic.com)"
                    onChange={(e) => {
                      selectedDraft.email = e.target.value;
                    }}
                    className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  <span className="font-bold text-slate-900 w-16">Subject:</span> 
                  Quick fix for {selectedDraft.name}'s missed calls
                </div>
                <div className="h-px bg-slate-100 my-4"></div>
                <div className="whitespace-pre-wrap font-medium">
                  {selectedDraft.draft || "Draft content is being generated..."}
                </div>
              </div>
              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
                <button onClick={() => setSelectedDraft(null)} className="px-5 py-2 rounded-lg font-bold text-slate-600 hover:bg-slate-200 transition-colors">
                  Keep in Drafts
                </button>
                <button onClick={() => {
                  updateStatus(selectedDraft.id, 'Queued', selectedDraft);
                  setSelectedDraft(null);
                }} className="px-5 py-2 rounded-lg font-bold text-white bg-indigo-600 hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-500/30 flex items-center gap-2">
                  <Zap size={16} /> Approve & Queue Campaign
                </button>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

// Subcomponents
function NavItem({ icon, label, badge, active = false, onClick }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center justify-between px-5 py-3.5 rounded-xl transition-all duration-300 group ${
      active 
        ? 'bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm' 
        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-transparent'
    }`}>
      <div className="flex items-center gap-3.5">
        <div className={`${active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-indigo-500'} transition-colors`}>
          {icon}
        </div>
        <span className={`text-[15px] ${active ? 'font-bold' : 'font-medium'}`}>{label}</span>
      </div>
      {badge && (
        <span className="text-[11px] font-bold bg-indigo-600 text-white px-2.5 py-0.5 rounded-full shadow-sm">
          {badge}
        </span>
      )}
    </button>
  );
}

function AdvancedMetric({ title, value, suffix, trend, status, icon }) {
  return (
    <div className="glass-panel rounded-2xl p-7 relative overflow-hidden group">
      {/* Hover Gradient Background */}
      <div className="absolute -inset-px bg-gradient-to-br from-indigo-500/5 via-purple-500/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl pointer-events-none"></div>
      
      <div className="flex justify-between items-start relative z-10 mb-6">
        <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 text-slate-500 group-hover:text-indigo-600 group-hover:border-indigo-200 group-hover:bg-indigo-50 transition-all duration-500 shadow-sm">
          {icon}
        </div>
        <div className={`px-3 py-1.5 rounded-full text-[13px] font-bold flex items-center gap-1.5 border shadow-sm ${
          status === 'optimal' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 
          'bg-indigo-50 text-indigo-600 border-indigo-200'
        }`}>
          <ArrowUpRight size={14} strokeWidth={3} />
          {trend}
        </div>
      </div>
      
      <div className="relative z-10">
        <h3 className="text-[15px] font-bold text-slate-500 mb-2">{title}</h3>
        <div className="flex items-baseline gap-2">
          <div className="text-[40px] leading-none font-black text-slate-900 tracking-tight">{value}</div>
          {suffix && <div className="text-[15px] font-bold text-slate-400">{suffix}</div>}
        </div>
      </div>
    </div>
  );
}

function LogLine({ type, id, text, timestamp }) {
  const styles = {
    sys: { color: 'text-slate-400', prefix: '[SYSTEM]' },
    worker: { color: 'text-indigo-300', prefix: `[${id}]` },
    alert: { color: 'text-amber-400', prefix: '[ALERT] ' },
    success: { color: 'text-emerald-400', prefix: '[SUCCESS]' },
    action: { color: 'text-blue-400', prefix: '[ACTION]' }
  };

  const style = styles[type] || styles.sys;

  return (
    <div className="flex items-start gap-3 py-1 group hover:bg-white/[0.05] -mx-3 px-3 rounded transition-colors">
      <span className="text-slate-500 shrink-0 w-[70px] text-[13px] mt-0.5 font-bold">{timestamp}</span>
      <span className={`${style.color} shrink-0 w-[85px] font-bold text-[13px] mt-0.5`}>{style.prefix}</span>
      <span className="text-slate-200 leading-relaxed font-medium">{text}</span>
    </div>
  );
}

function OrbitingAgent({ delay, duration, color }) {
  return (
    <div className="absolute top-1/2 left-1/2 w-full h-full -mt-[50%] -ml-[50%] animate-spin-slow pointer-events-none" style={{ animationDuration: duration, animationDelay: delay }}>
      <div className={`absolute top-0 left-1/2 -ml-2 w-4 h-4 rounded-full ${color} shadow-[0_0_15px_currentColor] border-2 border-white/50`}></div>
    </div>
  );
}
