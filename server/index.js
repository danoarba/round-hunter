const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./database');
const { sendCampaign, getPublicUrl } = require('./sendCampaign');
const autoSend = require('./autoSend');

// Use local venv python if it exists, else fall back to system python3
const VENV_PYTHON = path.join(__dirname, 'venv', 'bin', 'python');
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
console.log('Using Python:', PYTHON);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// State
let swarmActive = false;
let swarmProcess = null;
let swarmTimeout = null;
let neededSwarmActive = false;
let neededSwarmProcess = null;
let neededSwarmTimeout = null;
let campaignBusy = false;
let inboxBusy = false;

// Simulated metrics and data
let metrics = {
  activeAgents: 0,
  leadsHunted: 0,
  pitchesDelivered: 0,
  conversionRate: 0.0
};
let prospects = [];

const MAX_LOGS = 50;
let logHistory = [];
function emitLog(logData) {
  if (!logData.timestamp) {
    logData.timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  logHistory.push(logData);
  if (logHistory.length > MAX_LOGS) logHistory.shift();
  io.emit('log', logData);
}


/** rotating = multi-query local hunt | quality = only leads with real email on site */
let huntMode = (process.env.HUNT_MODE || 'rotating').toLowerCase();
/** UK: auto | cylex_api (Apify only) | ddg (free DDG, no Apify) */
let ukHuntSource = (process.env.UK_HUNT_SOURCE || 'auto').toLowerCase();
let autoSendState = autoSend.loadState();
let autoSendTimer = null;

// currentTargetQuery: loaded from DB on boot (survives Railway deploys)
// Priority: env var > DB saved value > hardcoded default
let currentTargetQuery = process.env.DEFAULT_TARGET_QUERY || "Dental Clinic in London, UK";

function getAutoSendPublic() {
  if (autoSendState.day !== autoSend.todayKey()) {
    autoSendState.day = autoSend.todayKey();
    autoSendState.dailySent = 0;
    autoSend.saveState(autoSendState);
  }
  return {
    enabled: !!autoSendState.enabled,
    dailySent: autoSendState.dailySent || 0,
    dailyLimit: autoSend.getDailyLimit(autoSendState),
    day: autoSendState.day,
  };
}

function emitFullStatus(extra = {}) {
  io.emit('statusUpdate', {
    swarmActive,
    neededSwarmActive,
    metrics,
    currentTargetQuery,
    huntMode,
    ukHuntSource,
    cylexApifyConfigured: !!(process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN),
    autoSend: getAutoSendPublic(),
    ...extra,
  });
}

function rotateHuntLocation(reason) {
  const { industryQuery, location } = autoSend.parseIndustryAndLocation(currentTargetQuery);
  const nextLoc = autoSend.nextLocation(location);
  if (nextLoc === location) return;
  currentTargetQuery = autoSend.buildQuery(industryQuery, nextLoc);
  autoSendState.emptyHuntStreak = 0;
  autoSend.saveState(autoSendState);
  emitLog({
    type: 'sys',
    id: 'Scout-Alpha',
    text: `Area exhausted (${reason}). Auto-switched hunt → ${currentTargetQuery}`,
  });
  emitFullStatus();
}

function scheduleAutoSendTick(delayMs) {
  if (autoSendTimer) {
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
  }
  if (!autoSendState.enabled) return;
  const wait = delayMs != null ? delayMs : autoSend.randomDelayMs();
  const limit = autoSend.getDailyLimit(autoSendState);
  autoSendTimer = setTimeout(runAutoSendTick, wait);
  emitLog({
    type: 'sys',
    id: 'Auto-Send',
    text: `Next auto-approve in ~${Math.round(wait / 1000)}s (${getAutoSendPublic().dailySent}/${limit} today)`,
  });
}

function runAutoSendTick() {
  autoSendTimer = null;
  if (!autoSendState.enabled) return;

  if (autoSendState.day !== autoSend.todayKey()) {
    autoSendState.day = autoSend.todayKey();
    autoSendState.dailySent = 0;
    autoSend.saveState(autoSendState);
    emitFullStatus();
  }

  const dailyLimit = autoSend.getDailyLimit(autoSendState);
  if (autoSendState.dailySent >= dailyLimit) {
    emitLog({
      type: 'alert',
      id: 'Auto-Send',
      text: `Daily limit reached (${dailyLimit}). Auto-send paused until tomorrow.`,
    });
    scheduleAutoSendTick(30 * 60 * 1000);
    return;
  }

  db.getProspects((err, rows) => {
    if (err) {
      scheduleAutoSendTick(autoSend.randomDelayMs());
      return;
    }
    const list = rows || [];
    const backlog = list.filter(
      (r) => r.status === 'Queued' || r.status === 'Sending'
    ).length;
    // Don't pile the queue — wait until outbound is clear
    if (backlog > 0 || campaignBusy) {
      scheduleAutoSendTick(45 * 1000);
      return;
    }

    const candidate = list
      .filter((r) => {
        const lane = (r.lane || 'standard').toLowerCase();
        return lane === 'standard'
          && r.status === 'Awaiting Approval'
          && autoSend.isValidOutboundEmail(r.email);
      })
      .sort((a, b) => a.id - b.id)[0];

    if (!candidate) {
      emitLog({
        type: 'sys',
        id: 'Auto-Send',
        text: 'No Awaiting Approval prospects with valid email — waiting for scout.',
      });
      scheduleAutoSendTick(autoSend.randomDelayMs());
      return;
    }

    db.updateStatus(candidate.id, 'Queued', (updErr) => {
      if (updErr) {
        scheduleAutoSendTick(autoSend.randomDelayMs());
        return;
      }
      autoSendState.dailySent += 1;
      autoSendState.lastAutoAt = new Date().toISOString();
      autoSend.saveState(autoSendState);
      io.emit('prospect_updated', { id: candidate.id, status: 'Queued' });
      emitLog({
        type: 'action',
        id: 'Auto-Send',
        text: `Auto-approved → Queued: ${candidate.name} (${candidate.email}) · ${autoSendState.dailySent}/${autoSend.getDailyLimit(autoSendState)} today`,
      });
      emitFullStatus();
      scheduleAutoSendTick(autoSend.randomDelayMs());
    });
  });
}

function setAutoSendConfig({ enabled, dailyLimit } = {}) {
  if (typeof enabled === 'boolean') {
    autoSendState.enabled = enabled;
  }
  if (dailyLimit != null) {
    autoSendState.dailyLimit = autoSend.clampDailyLimit(dailyLimit);
  }
  if (autoSendState.day !== autoSend.todayKey()) {
    autoSendState.day = autoSend.todayKey();
    autoSendState.dailySent = 0;
  }
  autoSend.saveState(autoSendState);
  if (autoSendTimer) {
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
  }
  const limit = autoSend.getDailyLimit(autoSendState);
  if (autoSendState.enabled) {
    emitLog({
      type: 'success',
      id: 'Auto-Send',
      text: `Auto-send ON — random gaps ~${Math.round(autoSend.MIN_DELAY_MS / 60000)}–${Math.round(autoSend.MAX_DELAY_MS / 60000)} min, max ${limit}/day`,
    });
    scheduleAutoSendTick(8 * 1000);
  } else if (typeof enabled === 'boolean') {
    emitLog({ type: 'sys', id: 'Auto-Send', text: 'Auto-send OFF — manual Review & queue only.' });
  } else {
    emitLog({
      type: 'sys',
      id: 'Auto-Send',
      text: `Daily send limit set to ${limit}`,
    });
  }
  emitFullStatus();
}

function setAutoSendEnabled(enabled) {
  setAutoSendConfig({ enabled: !!enabled });
}

// Run a single iteration of the swarm
const attachSwarmHandlers = (proc, { lane, onClose }) => {
  proc.stdout.on('data', (data) => {
    const output = data.toString().trim().split('\n');
    output.forEach(line => {
      try {
        const logData = JSON.parse(line);
        emitLog({ type: logData.type, id: logData.id, text: logData.text });

        if (
          logData.type === 'success'
          && (logData.text.includes('high-intent leads') || logData.text.includes('clinic leads'))
        ) {
          const numMatch = logData.text.match(/\d+/);
          if (numMatch) {
            const n = parseInt(numMatch[0], 10);
            metrics.leadsHunted += n;
            if (lane === 'standard') {
              if (n === 0) {
                autoSendState.emptyHuntStreak = (autoSendState.emptyHuntStreak || 0) + 1;
                autoSend.saveState(autoSendState);
                if (autoSendState.emptyHuntStreak >= 2) {
                  rotateHuntLocation(`${autoSendState.emptyHuntStreak} empty hunts`);
                }
              } else {
                autoSendState.emptyHuntStreak = 0;
                autoSend.saveState(autoSendState);
              }
            }
            emitFullStatus();
          }
        }

        if (logData.type === 'prospect_data') {
          let prospect;
          try {
            prospect = typeof logData.text === 'string' ? JSON.parse(logData.text) : logData.text;
          } catch (err) {
            prospect = logData.text;
          }
          prospect.lane = lane;
          if (lane === 'needed' && !prospect.need_signal) {
            prospect.need_signal = prospect.issue || 'Demand signal';
          }
          db.isDuplicate(prospect, (dupErr, isDup) => {
            if (dupErr) {
              console.error('Duplicate check failed', dupErr);
            }
            if (isDup) {
              emitLog({
                type: 'sys',
                id: 'Scout-Alpha',
                text: `Skipped duplicate: ${prospect.name || prospect.email}`,
              });
              return;
            }
            db.addProspect(prospect, (err, id) => {
              if (err) {
                console.error('Failed to add prospect to db', err);
              } else {
                prospect.id = id;
                prospect.status = prospect.status || 'Awaiting Approval';
                prospect.lane = lane;
                io.emit('prospect_updated', prospect);
                prospects.push(prospect);
              }
            });
          });
        }

        if (logData.type === 'success' && logData.text.includes('Draft saved')) {
          metrics.pitchesDelivered += 1;
          metrics.conversionRate = parseFloat(((metrics.pitchesDelivered / (metrics.leadsHunted || 1)) * 100).toFixed(1));
          emitFullStatus();
        }
      } catch (e) {
        if (line) emitLog({ type: 'sys', id: 'Sys', text: line });
      }
    });
  });

  proc.stderr.on('data', (data) => {
    emitLog({ type: 'alert', id: 'Error', text: data.toString().trim() });
  });

  proc.on('close', (code) => {
    onClose(code);
  });
};

const runSwarmIteration = () => {
  if (!swarmActive) return;

  swarmProcess = spawn(PYTHON, ['agents.py', currentTargetQuery, '--hunt-mode', huntMode], {
    cwd: __dirname,
    env: {
      ...process.env,
      PUBLIC_URL: getPublicUrl(),
      HUNT_MODE: huntMode,
      UK_HUNT_SOURCE: ukHuntSource,
      PYTHONUNBUFFERED: '1'
    }
  });

  attachSwarmHandlers(swarmProcess, {
    lane: 'standard',
    onClose: (code) => {
      swarmProcess = null;
      emitLog({ type: 'sys', id: 'Sys', text: `Agent swarm iteration exited with code ${code}.` });
      if (swarmActive) {
        emitLog({ type: 'sys', id: 'System', text: 'Agents resting for 3 minutes before next autonomous hunt...' });
        swarmTimeout = setTimeout(runSwarmIteration, 3 * 60 * 1000);
      }
    }
  });
};

const runNeededSwarmIteration = () => {
  if (!neededSwarmActive) return;

  neededSwarmProcess = spawn(PYTHON, ['agents.py', '--lane', 'needed'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PUBLIC_URL: getPublicUrl(),
      PYTHONUNBUFFERED: '1'
    }
  });

  attachSwarmHandlers(neededSwarmProcess, {
    lane: 'needed',
    onClose: (code) => {
      neededSwarmProcess = null;
      emitLog({ type: 'sys', id: 'Need-Scout', text: `Needed Clients hunt exited with code ${code}.` });
      if (neededSwarmActive) {
        emitLog({ type: 'sys', id: 'Need-Scout', text: 'Needed hunt resting 4 minutes before next pass...' });
        neededSwarmTimeout = setTimeout(runNeededSwarmIteration, 4 * 60 * 1000);
      }
    }
  });
};

// Start Swarm (24/7 Loop)
const startSwarm = () => {
  if (swarmActive) return;
  swarmActive = true;
  metrics.activeAgents = 3;
  emitFullStatus();
  emitLog({ type: 'sys', id: 'System', text: '24/7 Autonomous Mode Engaged. Swarm will now run continuously.' });
  runSwarmIteration();
};

const startNeededSwarm = () => {
  if (neededSwarmActive) return;
  neededSwarmActive = true;
  emitFullStatus();
  emitLog({ type: 'sys', id: 'Need-Scout', text: 'Needed Clients hunt ON — looking for hiring / AI receptionist demand.' });
  runNeededSwarmIteration();
};

// Halt Swarm
const haltSwarm = () => {
  swarmActive = false;
  metrics.activeAgents = neededSwarmActive ? 1 : 0;
  if (swarmProcess) {
    swarmProcess.kill();
    swarmProcess = null;
  }
  if (swarmTimeout) {
    clearTimeout(swarmTimeout);
    swarmTimeout = null;
  }
  emitFullStatus();
  emitLog({ type: 'alert', id: 'System', text: 'Swarm operations halted manually. 24/7 Mode Disengaged.' });
};

const haltNeededSwarm = () => {
  neededSwarmActive = false;
  metrics.activeAgents = swarmActive ? 3 : 0;
  if (neededSwarmProcess) {
    neededSwarmProcess.kill();
    neededSwarmProcess = null;
  }
  if (neededSwarmTimeout) {
    clearTimeout(neededSwarmTimeout);
    neededSwarmTimeout = null;
  }
  emitFullStatus();
  emitLog({ type: 'alert', id: 'Need-Scout', text: 'Needed Clients hunt halted.' });
};

// Socket Connection
io.on('connection', (socket) => {
  console.log('Dashboard connected:', socket.id);
  
  emitFullStatus();
  socket.emit('initialLogs', logHistory);

  socket.on('setTargetQuery', (query) => {
    if (query && query.trim()) {
      currentTargetQuery = query.trim();
      autoSendState.emptyHuntStreak = 0;
      autoSendState.targetQuery = currentTargetQuery;
      autoSend.saveState(autoSendState);
      // Also persist to SQLite DB (survives Railway deploys)
      db.setSetting('targetQuery', currentTargetQuery);
      emitFullStatus();
      emitLog({ type: 'sys', id: 'Scout-Alpha', text: `Target Search Niche updated to: "${currentTargetQuery}"` });
    }
  });

  socket.on('toggleSwarm', () => {
    if (swarmActive) {
      haltSwarm();
    } else {
      startSwarm();
    }
  });

  socket.on('toggleNeededSwarm', () => {
    if (neededSwarmActive) {
      haltNeededSwarm();
    } else {
      startNeededSwarm();
    }
  });

  socket.on('setAutoSend', (payload) => {
    setAutoSendConfig({
      enabled: payload && typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
      dailyLimit: payload && payload.dailyLimit != null ? payload.dailyLimit : undefined,
    });
  });

  socket.on('setUkHuntSource', (payload) => {
    const src = (payload && payload.source) || 'auto';
    if (src === 'cylex_api' || src === 'apify') ukHuntSource = 'cylex_api';
    else if (src === 'ddg' || src === 'free') ukHuntSource = 'ddg';
    else ukHuntSource = 'auto';
    emitFullStatus();
    emitLog({
      type: 'sys',
      id: 'Cylex-API',
      text: ukHuntSource === 'cylex_api'
        ? 'UK source → Cylex API only (Apify; needs APIFY_API_TOKEN).'
        : ukHuntSource === 'ddg'
          ? 'UK source → Free DDG (no Apify).'
          : 'UK source → Auto (Apify when token set, else DDG).',
    });
  });

  socket.on('setHuntMode', (payload) => {
    const mode = (payload && payload.mode) || 'rotating';
    huntMode = mode === 'quality' ? 'quality' : 'rotating';
    emitFullStatus();
    emitLog({
      type: 'sys',
      id: 'Scout-Alpha',
      text: huntMode === 'quality'
        ? 'Hunt mode → Quality (multi-search, email required before CRM).'
        : 'Hunt mode → Rotating local search (more leads, includes No Email).',
    });
  });

  socket.on('disconnect', () => {
    console.log('Dashboard disconnected:', socket.id);
  });
});

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    swarmActive,
    metrics,
    currentTargetQuery,
    huntMode,
    ukHuntSource,
    cylexApifyConfigured: !!(process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN),
    autoSend: getAutoSendPublic(),
  });
});

app.get('/api/auto-send', (req, res) => {
  res.json(getAutoSendPublic());
});

app.post('/api/auto-send', (req, res) => {
  const body = req.body || {};
  setAutoSendConfig({
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    dailyLimit: body.dailyLimit != null ? body.dailyLimit : undefined,
  });
  res.json(getAutoSendPublic());
});

app.get('/api/prospects', (req, res) => {
  db.getProspects((err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.delete('/api/prospects/reset', (req, res) => {
  db.clearProspects((err, changes) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    metrics.leadsHunted = 0;
    metrics.pitchesDelivered = 0;
    metrics.conversionRate = 0;
    logHistory = [];
    emitFullStatus();
    io.emit('logsCleared');
    io.emit('initialLogs', []);
    emitLog({ type: 'sys', id: 'System', text: 'CRM database and live logs cleared.' });
    res.json({ success: true, changes, logsCleared: true });
  });
});

app.post('/api/prospects/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  db.updateStatus(id, status, (err, changes) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    io.emit('prospect_updated', { id: parseInt(id, 10), status });
    res.json({ success: true, changes });
  });
});

app.post('/api/prospects/:id/resend', (req, res) => {
  const { id } = req.params;
  db.getProspects((err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    const prospect = (rows || []).find(r => String(r.id) === String(id));
    if (!prospect) {
      res.status(404).json({ error: 'Prospect not found' });
      return;
    }
    if (['Queued', 'Sending'].includes(prospect.status)) {
      res.status(400).json({ error: 'Already queued or sending' });
      return;
    }
    const email = String(prospect.email || '');
    if (!email.includes('@') || email.includes('not_found') || email === 'No Email Found') {
      res.status(400).json({ error: 'Prospect has no valid email' });
      return;
    }
    if (['No Website', 'No Email'].includes(prospect.status)) {
      res.status(400).json({ error: 'Cannot resend this prospect status' });
      return;
    }

    db.updateStatus(id, 'Queued', (updErr) => {
      if (updErr) {
        res.status(500).json({ error: updErr.message });
        return;
      }
      io.emit('prospect_updated', { id: parseInt(id, 10), status: 'Queued' });
      emitLog({
        type: 'action',
        id: 'Campaigns',
        text: `Resend queued for ${prospect.name} (${email}) — demo token + cold email will go out again.`,
      });
      res.json({ success: true, status: 'Queued' });
    });
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    publicUrl: getPublicUrl(),
    swarmActive,
    autoSend: getAutoSendPublic(),
    huntMode,
    ukHuntSource,
    cylexApifyConfigured: !!(process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN),
  });
});

app.get('/api/track/open/:id', (req, res) => {
  const { id } = req.params;
  
  db.updateStatus(id, 'Email Opened', (err) => {
    if (!err) {
      io.emit('prospect_updated', { id: parseInt(id), status: 'Email Opened' });
      emitLog({
        type: 'success',
        id: 'System',
        text: `Prospect #${id} just OPENED your cold email!`,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
      });
    }
  });

  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private'
  });
  res.end(pixel);
});

// ---------------------------------------------------------
// ACTIVE CAMPAIGNS (QUEUE PROCESSOR) — Node SMTP (reliable)
// ---------------------------------------------------------
function markProspectStatus(id, status, logText, logType = 'success') {
  db.updateStatus(id, status, (err) => {
    if (err) {
      console.error(`Failed to mark prospect ${id} as ${status}:`, err);
      return;
    }
    io.emit('prospect_updated', { id, status });
    if (logText) {
      emitLog({
        type: logType,
        id: 'Campaigns',
        text: logText,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
      });
    }
  });
}

/** Stuck Sending (crash / hang / deploy) → Failed so UI categories work again */
function recoverStuckSending(reason = 'recovered stuck Sending') {
  db.getProspects((err, rows) => {
    if (err || !rows) return;
    rows.filter((r) => r.status === 'Sending').forEach((r) => {
      markProspectStatus(
        r.id,
        'Failed',
        `${reason}: ${r.name} → Failed (use Resend)`,
        'alert'
      );
    });
  });
}

setInterval(() => {
  if (campaignBusy) return;

  db.getProspects((err, rows) => {
    if (err) return;
    const queuedLead = rows.find(r => r.status === 'Queued');
    if (!queuedLead) return;

    campaignBusy = true;
    console.log('Processing Campaign Queue for:', queuedLead.name);
    emitLog({
      type: 'action',
      id: 'Campaigns',
      text: `Processing Queue: Sending email to ${queuedLead.ceo_name || 'Clinic Owner'} at ${queuedLead.name}...`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
    });

    db.updateStatus(queuedLead.id, 'Sending', () => {
      io.emit('prospect_updated', { id: queuedLead.id, status: 'Sending' });
    });

    let settled = false;
    const overallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      campaignBusy = false;
      console.error('Campaign overall timeout for', queuedLead.name);
      markProspectStatus(
        queuedLead.id,
        'Failed',
        `Send timed out for ${queuedLead.name} → Failed`,
        'alert'
      );
    }, 90000);

    sendCampaign(queuedLead, emitLog)
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        campaignBusy = false;
        markProspectStatus(
          queuedLead.id,
          'Done',
          `Campaign sent to ${queuedLead.name} → Done`
        );
      })
      .catch((sendErr) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        campaignBusy = false;
        console.error('Campaign send error:', sendErr);
        markProspectStatus(
          queuedLead.id,
          'Failed',
          `Send failed for ${queuedLead.name}: ${sendErr.message || sendErr}`,
          'alert'
        );
      });
  });
}, 10 * 1000);

// ---------------------------------------------------------
// AI REPLY PARSER (INBOX MONITOR) — only when IMAP configured
// ---------------------------------------------------------
let imapWarnedOnce = false;
setInterval(() => {
  if (inboxBusy) return;
  const imapUser = process.env.IMAP_USER || '';
  const imapPass = process.env.IMAP_PASS || '';
  if (!imapUser || !imapPass) {
    if (!imapWarnedOnce) {
      imapWarnedOnce = true;
      emitLog({
        type: 'sys',
        id: 'Inbox-Monitor',
        text: 'IMAP not set — reply parser off (cold email still works). Optional: IMAP_USER / IMAP_PASS.',
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
      });
    }
    return;
  }

  inboxBusy = true;
  const child = spawn(PYTHON, ['inbox_monitor.py'], {
    cwd: __dirname,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });

  child.stdout.on('data', (data) => {
    const output = data.toString().trim().split('\n');
    output.forEach(line => {
      try {
        const logData = JSON.parse(line);
        emitLog({ type: logData.type, id: logData.id, text: logData.text, timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }) });

        if (logData.text.includes('Hot Lead') || logData.text.includes('Ignored')) {
          io.emit('statusUpdate', { swarmActive, metrics });
        }
      } catch (e) {}
    });
  });

  child.on('close', () => { inboxBusy = false; });
  child.on('error', () => { inboxBusy = false; });
}, 5 * 60 * 1000);

// SPA fallback for non-API GET routes
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  const indexPath = path.join(__dirname, '../dist/index.html');
  if (!fs.existsSync(indexPath)) return res.status(500).send('Frontend build missing. Run npm run build.');
  res.sendFile(indexPath);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hermes Command Center running on 0.0.0.0:${PORT}`);
  console.log(`Public URL: ${getPublicUrl()}`);

  // Load persisted targetQuery from SQLite (overrides default unless env var set)
  if (!process.env.DEFAULT_TARGET_QUERY) {
    db.getSetting('targetQuery', null, (err, saved) => {
      if (saved) {
        currentTargetQuery = saved;
        console.log(`Restored hunt target from DB: ${currentTargetQuery}`);
      }
      console.log(`Default hunt: ${currentTargetQuery}`);
      _bootSwarm();
    });
  } else {
    console.log(`Default hunt: ${currentTargetQuery}`);
    _bootSwarm();
  }
});

function _bootSwarm() {
  // Clear any Sending left from previous crash / hang so queue + UI can move again
  setTimeout(() => recoverStuckSending('Boot'), 1500);

  // Resume auto-send schedule if it was left ON
  if (autoSendState.enabled) {
    setTimeout(() => {
      emitLog({ type: 'sys', id: 'Auto-Send', text: 'Resuming auto-send (was ON before restart).' });
      scheduleAutoSendTick(12 * 1000);
    }, 5000);
  }

  // 24/7 hunting on Railway / production boots
  const autoStart = String(process.env.AUTO_START_SWARM || 'true').toLowerCase() !== 'false';
  if (autoStart) {
    setTimeout(() => {
      if (!swarmActive) {
        emitLog({ type: 'sys', id: 'System', text: `Auto-starting 24/7 hunt for: ${currentTargetQuery}` });
        startSwarm();
      }
    }, 4000);
  }
}
