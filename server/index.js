const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();
const { spawn } = require('child_process');
const db = require('./database');
const path = require('path');
const fs = require('fs');

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


let currentTargetQuery = "Dental Clinic in New York, USA";

// Run a single iteration of the swarm
const runSwarmIteration = () => {
  if (!swarmActive) return;

  // Spawn Python Agent Orchestrator with targeted query
  swarmProcess = spawn(PYTHON, ['agents.py', currentTargetQuery], { cwd: './server' });
  
  swarmProcess.stdout.on('data', (data) => {
    const output = data.toString().trim().split('\n');
    output.forEach(line => {
      try {
        const logData = JSON.parse(line);
        emitLog({ type: logData.type, id: logData.id, text: logData.text });
        
        // Update metrics based on logs
        if (logData.type === 'success' && logData.text.includes('high-intent leads')) {
          const numMatch = logData.text.match(/\d+/);
          if (numMatch) {
            metrics.leadsHunted += parseInt(numMatch[0], 10);
            io.emit('statusUpdate', { swarmActive, metrics });
          }
        }
        
        // Listen for raw prospect data to populate the CRM Table
        if (logData.type === 'prospect_data') {
          let prospect;
          try {
            prospect = typeof logData.text === 'string' ? JSON.parse(logData.text) : logData.text;
          } catch(err) {
            prospect = logData.text;
          }
          db.addProspect(prospect, (err, id) => {
            if (err) {
              console.error('Failed to add prospect to db', err);
            } else {
              prospect.id = id;
              prospect.status = prospect.status || 'Awaiting Approval';
              io.emit('prospect_updated', prospect);
              
              // Also add to global prospects array if we want it in memory (optional)
              prospects.push(prospect);
            }
          });
        }
        
        if (logData.type === 'success' && logData.text.includes('Draft saved')) {
          metrics.pitchesDelivered += 1;
          metrics.conversionRate = parseFloat(((metrics.pitchesDelivered / (metrics.leadsHunted || 1)) * 100).toFixed(1));
          io.emit('statusUpdate', { swarmActive, metrics });
        }
      } catch (e) {
        // If not JSON, send as system log
        if (line) emitLog({ type: 'sys', id: 'Sys', text: line });
      }
    });
  });

  swarmProcess.stderr.on('data', (data) => {
    emitLog({ type: 'alert', id: 'Error', text: data.toString().trim() });
  });

  swarmProcess.on('close', (code) => {
    swarmProcess = null;
    emitLog({ type: 'sys', id: 'Sys', text: `Agent swarm iteration exited with code ${code}.` });
    
    // If still active, schedule the next run after 3 minutes to avoid spamming the scraper
    if (swarmActive) {
      emitLog({ type: 'sys', id: 'System', text: 'Agents resting for 3 minutes before next autonomous hunt...' });
      swarmTimeout = setTimeout(runSwarmIteration, 3 * 60 * 1000);
    }
  });
};

// Start Swarm (24/7 Loop)
const startSwarm = () => {
  if (swarmActive) return;
  swarmActive = true;
  metrics.activeAgents = 3; // Scout, Pitch, Delivery
  io.emit('statusUpdate', { swarmActive, metrics });
  
  emitLog({ type: 'sys', id: 'System', text: '24/7 Autonomous Mode Engaged. Swarm will now run continuously.' });
  runSwarmIteration();
};

// Halt Swarm
const haltSwarm = () => {
  swarmActive = false;
  metrics.activeAgents = 0;
  if (swarmProcess) {
    swarmProcess.kill();
    swarmProcess = null;
  }
  if (swarmTimeout) {
    clearTimeout(swarmTimeout);
    swarmTimeout = null;
  }
  io.emit('statusUpdate', { swarmActive, metrics });
  emitLog({ type: 'alert', id: 'System', text: 'Swarm operations halted manually. 24/7 Mode Disengaged.' });
};

// Socket Connection
io.on('connection', (socket) => {
  console.log('Dashboard connected:', socket.id);
  
  // Send initial state
  socket.emit('statusUpdate', { swarmActive, metrics, currentTargetQuery });
  socket.emit('initialLogs', logHistory);

  socket.on('setTargetQuery', (query) => {
    if (query && query.trim()) {
      currentTargetQuery = query.trim();
      io.emit('statusUpdate', { swarmActive, metrics, currentTargetQuery });
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
  socket.on('disconnect', () => {
    console.log('Dashboard disconnected:', socket.id);
  });
});

// API Routes
app.get('/api/status', (req, res) => {
  res.json({ swarmActive, metrics });
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
    io.emit('statusUpdate', { swarmActive, metrics, currentTargetQuery });
    res.json({ success: true, changes });
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
    res.json({ success: true, changes });
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
// ACTIVE CAMPAIGNS (QUEUE PROCESSOR)
// ---------------------------------------------------------
setInterval(() => {
  // Find one lead in the queue
  db.getProspects((err, rows) => {
    if (err) return;
    const queuedLead = rows.find(r => r.status === 'Queued');
    if (!queuedLead) return; // Queue empty

    console.log('Processing Campaign Queue for:', queuedLead.name);
    emitLog({
      type: 'action',
      id: 'Campaigns',
      text: `Processing Queue: Sending email to ${queuedLead.ceo_name || 'Clinic Owner'} at ${queuedLead.name}...`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
    });
    
    // Update status to 'Sending' temporarily
    db.updateStatus(queuedLead.id, 'Sending', () => {
      io.emit('prospect_updated', { id: queuedLead.id, status: 'Sending' });
    });

    const process = spawn(PYTHON, ['execute_lead.py', JSON.stringify(queuedLead)], {
      cwd: __dirname
    });
    
    process.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) emitLog({ type: 'sys', id: 'Execution-Bot', text: text, timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }) });
    });
    
    process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) emitLog({ type: 'alert', id: 'Execution-Bot', text: text, timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }) });
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        db.updateStatus(queuedLead.id, 'Done', (err) => {
          if (!err) {
            io.emit('prospect_updated', { id: queuedLead.id, status: 'Done' });
            emitLog({
              type: 'success',
              id: 'Campaigns',
              text: `Campaign Sent successfully to ${queuedLead.name}. Marked as Done.`,
              timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
            });
          }
        });
      } else {
        db.updateStatus(queuedLead.id, 'Failed', (err) => {
          if (!err) io.emit('prospect_updated', { id: queuedLead.id, status: 'Failed' });
        });
      }
    });
  });
}, 30 * 1000); // Check every 30 seconds for fast campaign processing

// ---------------------------------------------------------
// AI REPLY PARSER (INBOX MONITOR)
// ---------------------------------------------------------
setInterval(() => {
  if (!swarmActive) return; // Only run when swarm is active, or we could run it 24/7 anyway. Let's run it 24/7.
  
  const process = spawn(PYTHON, ['inbox_monitor.py'], {
    cwd: __dirname
  });
  
  process.stdout.on('data', (data) => {
    const output = data.toString().trim().split('\n');
    output.forEach(line => {
      try {
        const logData = JSON.parse(line);
        emitLog({ type: logData.type, id: logData.id, text: logData.text, timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }) });
        
        if (logData.text.includes('Hot Lead') || logData.text.includes('Ignored')) {
          // Trigger a re-fetch of prospects in UI by emitting a generic update
          io.emit('statusUpdate', { swarmActive, metrics });
        }
      } catch (e) {}
    });
  });
}, 5 * 60 * 1000); // Check inbox every 5 minutes

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Hermes Command Center running on port ${PORT}`);
});
