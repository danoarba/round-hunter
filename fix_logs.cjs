const fs = require('fs');

let content = fs.readFileSync('server/index.js', 'utf8');

const helper = `
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
`;

// Insert the helper after `let prospects = [];`
content = content.replace('let prospects = [];', 'let prospects = [];\n' + helper);

// Replace io.emit('log', ... ) and io.emit('agent_log', ... ) with emitLog(...)
content = content.replace(/io\.emit\('agent_log',\s*(\{[\s\S]*?\})\);/g, 'emitLog($1);');
content = content.replace(/io\.emit\('log',\s*(\{[\s\S]*?\})\);/g, 'emitLog($1);');

// Fix the one-liner in process.stdout.on
content = content.replace(/if \(text\) io\.emit\('agent_log',\s*(\{[\s\S]*?\})\);/g, 'if (text) emitLog($1);');
content = content.replace(/if \(line\) io\.emit\('log',\s*(\{[\s\S]*?\})\);/g, 'if (line) emitLog($1);');

// Handle connection
content = content.replace("socket.emit('statusUpdate', { swarmActive, metrics });", "socket.emit('statusUpdate', { swarmActive, metrics });\n  socket.emit('initialLogs', logHistory);");

fs.writeFileSync('server/index.js', content);
console.log('Fixed index.js logs');
