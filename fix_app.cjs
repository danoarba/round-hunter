const fs = require('fs');
let content = fs.readFileSync('src/App.jsx', 'utf8');

// Replace the log appending logic
const oldLog = `
    socketRef.current.on('log', (logEntry) => {
      setLogs((prev) => [...prev, { ...logEntry, timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }]);
    });
`;

const newLog = `
    socketRef.current.on('initialLogs', (history) => {
      setLogs(history);
    });

    socketRef.current.on('log', (logEntry) => {
      setLogs((prev) => [...prev, logEntry]);
    });
`;

content = content.replace(oldLog.trim(), newLog.trim());

// Also remove any agent_log if there was any (there wasn't, but just in case)
fs.writeFileSync('src/App.jsx', content);
console.log('Fixed App.jsx');
