const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create a new database file in the server directory
const dbPath = path.resolve(__dirname, 'clients.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Initialize the database table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      niche TEXT,
      email TEXT,
      location TEXT,
      issue TEXT,
      draft TEXT,
      api_payload TEXT,
      status TEXT DEFAULT 'Identified',
      ceo_name TEXT,
      linkedin_url TEXT,
      is_queued INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Gracefully add new columns to existing database if they don't exist
  ['ceo_name', 'linkedin_url'].forEach(col => {
    db.run(`ALTER TABLE clients ADD COLUMN ${col} TEXT`, (err) => {
      // Ignore errors if column already exists
    });
  });
  db.run(`ALTER TABLE clients ADD COLUMN is_queued INTEGER DEFAULT 0`, (err) => {});
  db.run(`ALTER TABLE clients ADD COLUMN subject TEXT DEFAULT ''`, (err) => {});
});

const Database = {
  addProspect: (prospect, callback) => {
    const { name, niche, email, location, issue, draft, subject, api_payload, ceo_name, linkedin_url, status } = prospect;
    db.run(
      `INSERT INTO clients (name, niche, email, location, issue, draft, subject, api_payload, ceo_name, linkedin_url, status, is_queued) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [name, niche, email, location || '', issue, draft || '', subject || '', JSON.stringify(api_payload || {}), ceo_name || '', linkedin_url || '', status || 'Awaiting Approval'],
      function (err) {
        if (err) return callback(err, null);
        callback(null, this.lastID);
      }
    );
  },

  clearProspects: (callback) => {
    db.run(`DELETE FROM clients`, [], function (err) {
      if (callback) callback(err, this.changes);
    });
  },
  
  getProspects: (callback) => {
    db.all(`SELECT * FROM clients ORDER BY created_at DESC`, [], (err, rows) => {
      callback(err, rows);
    });
  },

  updateStatus: (id, status, callback) => {
    db.run(
      `UPDATE clients SET status = ? WHERE id = ?`,
      [status, id],
      function (err) {
        callback(err, this.changes);
      }
    );
  }
};

module.exports = Database;
