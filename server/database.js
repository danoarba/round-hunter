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
  db.run(`ALTER TABLE clients ADD COLUMN lane TEXT DEFAULT 'standard'`, (err) => {});
  db.run(`ALTER TABLE clients ADD COLUMN need_signal TEXT DEFAULT ''`, (err) => {});
});

const Database = {
  addProspect: (prospect, callback) => {
    const {
      name, niche, email, location, issue, draft, subject, api_payload,
      ceo_name, linkedin_url, status, lane, need_signal
    } = prospect;
    db.run(
      `INSERT INTO clients (name, niche, email, location, issue, draft, subject, api_payload, ceo_name, linkedin_url, status, is_queued, lane, need_signal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        name,
        niche,
        email,
        location || '',
        issue,
        draft || '',
        subject || '',
        JSON.stringify(api_payload || {}),
        ceo_name || '',
        linkedin_url || '',
        status || 'Awaiting Approval',
        lane || 'standard',
        need_signal || '',
      ],
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

  /** Skip re-adding same clinic (email or website host). */
  isDuplicate: (prospect, callback) => {
    const email = String(prospect.email || '').trim().toLowerCase();
    const badEmail = !email || email.includes('not_found') || email === 'no email found' || email === 'no website';
    let host = '';
    try {
      let url = prospect.url || '';
      if (!url && prospect.api_payload) {
        const raw = typeof prospect.api_payload === 'string'
          ? JSON.parse(prospect.api_payload)
          : prospect.api_payload;
        url = (raw && raw.website_url) || '';
      }
      if (url) {
        host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      }
    } catch (_) {}

    db.all(`SELECT id, email, api_payload FROM clients`, [], (err, rows) => {
      if (err) return callback(err, false);
      const dup = (rows || []).some((r) => {
        const em = String(r.email || '').trim().toLowerCase();
        if (!badEmail && em && em === email) return true;
        if (host) {
          try {
            const raw = r.api_payload ? JSON.parse(r.api_payload) : {};
            const u = raw.website_url || '';
            if (u) {
              const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
              if (h === host) return true;
            }
          } catch (_) {}
        }
        return false;
      });
      callback(null, dup);
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
