const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Use DB_PATH env var, else default to Render disk in production, local file in development
const DB_PATH = process.env.DB_PATH || (process.env.NODE_ENV === 'production' ? '/var/data/app.db' : path.join(__dirname, 'app.db'));

// Ensure parent directory exists (important for persistent disk on Render)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log('Created database directory:', dbDir);
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database at:', DB_PATH);
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

  // Kepala VOT list table - stores available Kepala VOT options managed by admin
  db.run(`
    CREATE TABLE IF NOT EXISTS kepala_vot_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aktiviti TEXT,
      kod TEXT NOT NULL,
      keterangan TEXT,
      peruntukan REAL DEFAULT 0,
      category TEXT DEFAULT 'umum',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (aktiviti, kod)
    )
  `);

  // Category budgets table - stores peruntukan (allocation) per Buku Vot category
  db.run(`
    CREATE TABLE IF NOT EXISTS category_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT UNIQUE NOT NULL,
      peruntukan REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    // Insert default rows for all 6 categories
    const cats = ['perbekalan', 'pembangunan', 'gaji', 'operasi', 'penyelenggaraan', 'utiliti'];
    cats.forEach(cat => {
      db.run(`INSERT OR IGNORE INTO category_budgets (category, peruntukan) VALUES (?, 0)`, [cat]);
    });
  });

  // Migration: Add kepala_vot column to data table if it doesn't exist
  db.all("PRAGMA table_info(data)", (err, columns) => {
    if (columns) {
      const hasKepalaVot = columns.some(col => col.name === 'kepala_vot');
      if (!hasKepalaVot) {
        db.run(`ALTER TABLE data ADD COLUMN kepala_vot TEXT`, (err) => {
          if (err) console.error('Error adding kepala_vot column:', err);
          else console.log('Added kepala_vot column to data table');
        });
      }

      const hasAktiviti = columns.some(col => col.name === 'aktiviti');
      if (!hasAktiviti) {
        db.run(`ALTER TABLE data ADD COLUMN aktiviti TEXT`, (err) => {
          if (err) console.error('Error adding aktiviti column:', err);
          else console.log('Added aktiviti column to data table');
        });
      }
    }
  });

  // Migration: Add category column to kepala_vot_list if not exists
  db.all("PRAGMA table_info(kepala_vot_list)", (err, columns) => {
    if (columns) {
      const hasCat = columns.some(col => col.name === 'category');
      if (!hasCat) {
        db.run(`ALTER TABLE kepala_vot_list ADD COLUMN category TEXT DEFAULT 'umum'`, (err) => {
          if (err) console.error('Error adding category to kepala_vot_list:', err);
          else console.log('Added category column to kepala_vot_list');
        });
      }

      const hasAktiviti = columns.some(col => col.name === 'aktiviti');
      if (!hasAktiviti) {
        db.run(`ALTER TABLE kepala_vot_list ADD COLUMN aktiviti TEXT`, (err) => {
          if (err) console.error('Error adding aktiviti to kepala_vot_list:', err);
          else console.log('Added aktiviti column to kepala_vot_list');
        });
      }

      const hasPeruntukan = columns.some(col => col.name === 'peruntukan');
      if (!hasPeruntukan) {
        db.run(`ALTER TABLE kepala_vot_list ADD COLUMN peruntukan REAL DEFAULT 0`, (err) => {
          if (err) console.error('Error adding peruntukan to kepala_vot_list:', err);
          else console.log('Added peruntukan column to kepala_vot_list');
        });
      }

      db.all("PRAGMA index_list(kepala_vot_list)", (indexErr, indexes) => {
        if (indexErr || !indexes) return;

        const uniqueKodOnlyIndex = indexes.find((index) => index.unique);
        if (!uniqueKodOnlyIndex) return;

        db.all(`PRAGMA index_info(${JSON.stringify(uniqueKodOnlyIndex.name)})`, (infoErr, infoRows) => {
          if (infoErr || !infoRows || infoRows.length !== 1 || infoRows[0].name !== 'kod') return;

          db.serialize(() => {
            db.run(`
              CREATE TABLE IF NOT EXISTS kepala_vot_list_migrated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                aktiviti TEXT,
                kod TEXT NOT NULL,
                keterangan TEXT,
                peruntukan REAL DEFAULT 0,
                category TEXT DEFAULT 'umum',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (aktiviti, kod)
              )
            `, (createErr) => {
              if (createErr) {
                console.error('Error creating migrated kepala_vot_list table:', createErr);
                return;
              }

              db.run(`
                INSERT INTO kepala_vot_list_migrated (id, aktiviti, kod, keterangan, peruntukan, category, created_at)
                SELECT id, COALESCE(aktiviti, ''), kod, keterangan, COALESCE(peruntukan, 0), COALESCE(category, 'umum'), created_at
                FROM kepala_vot_list
              `, (copyErr) => {
                if (copyErr) {
                  console.error('Error copying kepala_vot_list data for migration:', copyErr);
                  return;
                }

                db.run(`DROP TABLE kepala_vot_list`, (dropErr) => {
                  if (dropErr) {
                    console.error('Error dropping old kepala_vot_list table:', dropErr);
                    return;
                  }

                  db.run(`ALTER TABLE kepala_vot_list_migrated RENAME TO kepala_vot_list`, (renameErr) => {
                    if (renameErr) console.error('Error renaming migrated kepala_vot_list table:', renameErr);
                    else console.log('Migrated kepala_vot_list uniqueness to aktiviti + kod');
                  });
                });
              });
            });
          });
        });
      });
    }
  });

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

  // Migration: Add personal info columns to users table if not exist
  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (columns) {
      const personalCols = {
        nama: 'TEXT',
        no_pekerja: 'TEXT',
        jawatan: 'TEXT',
        jabatan: 'TEXT',
        telefon: 'TEXT',
        profile_pic: 'TEXT'
      };
      Object.entries(personalCols).forEach(([col, type]) => {
        if (!columns.some(c => c.name === col)) {
          db.run(`ALTER TABLE users ADD COLUMN ${col} ${type}`, (err) => {
            if (err) console.error(`Error adding ${col} column to users:`, err);
            else console.log(`Added ${col} column to users table`);
          });
        }
      });
    }
  });

  // Login logs table
  db.run(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      ip_address TEXT,
      logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_login_logs_user_id ON login_logs(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_login_logs_logged_at ON login_logs(logged_at DESC)`);

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
