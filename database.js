const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'app.db'), (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Initialize tables
db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Data table with transaction structure and category
  db.run(`
    CREATE TABLE IF NOT EXISTS data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT DEFAULT 'Perbekalan',
      tarikh TEXT NOT NULL,
      rujukan TEXT,
      dibayar_kepada TEXT,
      perkara TEXT NOT NULL,
      liabiliti TEXT,
      bayaran REAL,
      jumlah_bayaran REAL,
      baki REAL,
      image TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Notices table for admin-to-all-users notifications
  db.run(`
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'Pengumuman',
      image_data TEXT,
      image_name TEXT,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Migration: Add image columns if they don't exist
  db.all("PRAGMA table_info(notices)", (err, columns) => {
    if (columns) {
      const hasImageData = columns.some(col => col.name === 'image_data');
      const hasImageName = columns.some(col => col.name === 'image_name');
      
      if (!hasImageData) {
        db.run(`ALTER TABLE notices ADD COLUMN image_data TEXT`, (err) => {
          if (err) console.error('Error adding image_data column:', err);
          else console.log('Added image_data column to notices table');
        });
      }
      
      if (!hasImageName) {
        db.run(`ALTER TABLE notices ADD COLUMN image_name TEXT`, (err) => {
          if (err) console.error('Error adding image_name column:', err);
          else console.log('Added image_name column to notices table');
        });
      }
    }
  });

  // Create indexes for better performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_notices_created_at ON notices(created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notices_created_by ON notices(created_by)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_data_user_id ON data(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_data_created_at ON data(created_at DESC)`);

  // Insert default user if not exists
  db.get(`SELECT * FROM users WHERE username = ?`, ['admin'], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, ['admin', 'password123']);
      console.log('Default user created: admin / password123');
    }
  });
});

module.exports = db;
