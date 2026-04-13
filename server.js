const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE_PATH = process.env.DB_PATH || (process.env.NODE_ENV === 'production' ? '/var/data/app.db' : path.join(__dirname, 'app.db'));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE_PATH), 'backups');
const BACKUP_ENABLED = (process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
const BACKUP_INTERVAL_HOURS = Math.max(1, parseInt(process.env.BACKUP_INTERVAL_HOURS || '24', 10));
const BACKUP_RETENTION_COUNT = Math.max(1, parseInt(process.env.BACKUP_RETENTION_COUNT || '14', 10));

let backupInProgress = false;
let lastBackupInfo = {
  status: 'not-run',
  reason: null,
  startedAt: null,
  completedAt: null,
  dbBackupFile: null,
  sessionBackupFile: null,
  error: null
};

function getPublicBaseUrl(req) {
  const fromEnv = (process.env.PUBLIC_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = req.get('host');
  return `${protocol}://${host}`.replace(/\/$/, '');
}

// Trust Render's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Sessions stored in SQLite so they survive server restarts
const SESSION_DB_DIR = path.dirname(DB_FILE_PATH);

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: SESSION_DB_DIR }),
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days — survives browser close
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Persistent uploads directory (uses /var/data/uploads on Render, public/uploads locally)
const UPLOADS_DIR = DB_FILE_PATH.startsWith('/var/data')
  ? path.join(path.dirname(DB_FILE_PATH), 'uploads')
  : path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (BACKUP_ENABLED && !fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function makeBackupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith('.db') || name.endsWith('.json'))
      .map((name) => {
        const fullPath = path.join(BACKUP_DIR, name);
        const stat = fs.statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const uniqueBuckets = [];
    const seenKeys = new Set();
    files.forEach((file) => {
      const key = file.name.replace(/^(app|sessions|meta)-/, '').replace(/\.(db|json)$/, '');
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueBuckets.push(key);
      }
    });

    const keepKeys = new Set(uniqueBuckets.slice(0, BACKUP_RETENTION_COUNT));
    files.forEach((file) => {
      const key = file.name.replace(/^(app|sessions|meta)-/, '').replace(/\.(db|json)$/, '');
      if (!keepKeys.has(key)) {
        try { fs.unlinkSync(file.fullPath); } catch (_) {}
      }
    });
  } catch (err) {
    console.error('Backup prune error:', err.message);
  }
}

function getExistingFontPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function configurePdfFonts(doc) {
  const regularPath = getExistingFontPath([
    process.env.PDF_FONT_REGULAR,
    path.join(__dirname, 'public', 'fonts', 'NotoSans-Regular.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf'
  ]);

  const boldPath = getExistingFontPath([
    process.env.PDF_FONT_BOLD,
    path.join(__dirname, 'public', 'fonts', 'NotoSans-Bold.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\segoeuib.ttf'
  ]);

  if (regularPath) doc.registerFont('AppPdfRegular', regularPath);
  if (boldPath) doc.registerFont('AppPdfBold', boldPath);

  return {
    regular: regularPath ? 'AppPdfRegular' : 'Helvetica',
    bold: boldPath ? 'AppPdfBold' : 'Helvetica-Bold'
  };
}

function runSqliteBackup(reason = 'manual') {
  return new Promise((resolve, reject) => {
    if (!BACKUP_ENABLED) {
      return reject(new Error('Backup disabled by configuration'));
    }
    if (backupInProgress) {
      return reject(new Error('Backup already in progress'));
    }

    backupInProgress = true;
    const startedAt = new Date();
    const stamp = makeBackupTimestamp();
    const dbBackupFile = path.join(BACKUP_DIR, `app-${stamp}.db`);
    const sessionSrc = path.join(SESSION_DB_DIR, 'sessions.db');
    const sessionBackupFile = path.join(BACKUP_DIR, `sessions-${stamp}.db`);
    const metaFile = path.join(BACKUP_DIR, `meta-${stamp}.json`);

    lastBackupInfo = {
      status: 'running',
      reason,
      startedAt: startedAt.toISOString(),
      completedAt: null,
      dbBackupFile,
      sessionBackupFile: fs.existsSync(sessionSrc) ? sessionBackupFile : null,
      error: null
    };


    const escapedBackupPath = dbBackupFile.replace(/'/g, "''");

    db.serialize(() => {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      db.run(`VACUUM INTO '${escapedBackupPath}'`, (vacuumErr) => {
        if (vacuumErr) {
          backupInProgress = false;
          lastBackupInfo.status = 'failed';
          lastBackupInfo.completedAt = new Date().toISOString();
          lastBackupInfo.error = vacuumErr.message;
          return reject(vacuumErr);
        }

        try {
          if (fs.existsSync(sessionSrc)) {
            fs.copyFileSync(sessionSrc, sessionBackupFile);
          }

          const summary = {
            reason,
            createdAt: new Date().toISOString(),
            dbBackupFile,
            dbSizeBytes: fs.existsSync(dbBackupFile) ? fs.statSync(dbBackupFile).size : 0,
            sessionBackupFile: fs.existsSync(sessionBackupFile) ? sessionBackupFile : null,
            sessionSizeBytes: fs.existsSync(sessionBackupFile) ? fs.statSync(sessionBackupFile).size : 0
          };
          fs.writeFileSync(metaFile, JSON.stringify(summary, null, 2), 'utf8');

          pruneOldBackups();

          backupInProgress = false;
          lastBackupInfo.status = 'success';
          lastBackupInfo.completedAt = new Date().toISOString();
          lastBackupInfo.error = null;
          resolve(summary);
        } catch (fileErr) {
          backupInProgress = false;
          lastBackupInfo.status = 'failed';
          lastBackupInfo.completedAt = new Date().toISOString();
          lastBackupInfo.error = fileErr.message;
          reject(fileErr);
        }
      });
    });
  });
}

// Serve uploaded files from persistent path
app.use('/uploads', express.static(UPLOADS_DIR));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Authentication middleware
function requireAuth(req, res, next) {
  console.log('requireAuth check - session:', { userId: req.session && req.session.userId });
  if (req.session && req.session.userId) {
    return next();
  } else {
    console.log('requireAuth failed - no session');
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Admin middleware
function requireAdmin(req, res, next) {
  if (req.session.userId && req.session.username === 'admin') {
    return next();
  } else {
    return res.status(403).json({ error: 'Admin access required' });
  }
}

// Helper: get current Malaysia time as SQLite-compatible string (UTC+8)
function getMalaysiaTime() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' }).replace('T', ' ');
}

function normalizeCategory(value) {
  return String(value || 'perbekalan').toLowerCase().trim();
}

function normalizeAktivitiCode(value) {
  return String(value || '').trim().substring(0, 6);
}

function normalizeKepalaVot(value) {
  return String(value || '').trim();
}

function getScopeKey(aktiviti, kepalaVot) {
  return `${normalizeAktivitiCode(aktiviti)}|${normalizeKepalaVot(kepalaVot)}`;
}

function getVoucherDisplayStatus(row) {
  const type = String(row?.transaction_type || 'bill').trim();
  if (type === 'voucher_cancel') return 'cancel-entry';
  return String(row?.voucher_status || 'active').trim() || 'active';
}

function recalculateScopeRunningTotals(aktiviti, kepalaVot, done) {
  const aktivitiCode = normalizeAktivitiCode(aktiviti);
  const kod = normalizeKepalaVot(kepalaVot);
  if (!aktivitiCode || !kod) return done();

  db.get(
    `SELECT peruntukan
     FROM kepala_vot_list
     WHERE SUBSTR(COALESCE(aktiviti, ''), 1, 6) = ? AND TRIM(COALESCE(kod, '')) = ?
     ORDER BY id DESC
     LIMIT 1`,
    [aktivitiCode, kod],
    (budgetErr, budgetRow) => {
      if (budgetErr) return done(budgetErr);

      const peruntukan = budgetRow ? (parseFloat(budgetRow.peruntukan) || 0) : 0;
      db.all(
        `SELECT id, bayaran
         FROM data
         WHERE SUBSTR(COALESCE(aktiviti, ''), 1, 6) = ? AND TRIM(COALESCE(kepala_vot, '')) = ?
         ORDER BY date(COALESCE(tarikh, created_at)) ASC, datetime(created_at) ASC, id ASC`,
        [aktivitiCode, kod],
        (rowsErr, rows) => {
          if (rowsErr) return done(rowsErr);

          let runningTotal = 0;
          let index = 0;

          const updateNext = () => {
            if (index >= rows.length) return done();

            const row = rows[index++];
            runningTotal += parseFloat(row.bayaran) || 0;
            const baki = peruntukan - runningTotal;

            db.run(
              'UPDATE data SET jumlah_bayaran = ?, baki = ? WHERE id = ?',
              [runningTotal, baki, row.id],
              (updateErr) => {
                if (updateErr) return done(updateErr);
                updateNext();
              }
            );
          };

          updateNext();
        }
      );
    }
  );
}

function recalculateMultipleScopes(scopeList, done) {
  const uniqueScopes = Array.from(new Set(
    (scopeList || [])
      .map((scope) => getScopeKey(scope?.aktiviti, scope?.kepala_vot))
      .filter((key) => key !== '|')
  )).map((key) => {
    const [aktiviti, kepala_vot] = key.split('|');
    return { aktiviti, kepala_vot };
  });

  let index = 0;
  const next = () => {
    if (index >= uniqueScopes.length) return done();
    const scope = uniqueScopes[index++];
    recalculateScopeRunningTotals(scope.aktiviti, scope.kepala_vot, (err) => {
      if (err) return done(err);
      next();
    });
  };

  next();
}

// Routes

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (user) {
      req.session.userId = user.id;
      req.session.username = user.username;
      // Log login event
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      db.run('INSERT INTO login_logs (user_id, action, ip_address, logged_at) VALUES (?, ?, ?, ?)', [user.id, 'login', ip, getMalaysiaTime()]);
      res.json({ success: true, user: { id: user.id, username: user.username } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  const userId = req.session.userId;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    // Log logout event
    if (userId) {
      db.run('INSERT INTO login_logs (user_id, action, ip_address, logged_at) VALUES (?, ?, ?, ?)', [userId, 'logout', ip, getMalaysiaTime()]);
    }
    res.json({ success: true });
  });
});

// Get current user
app.get('/api/user', requireAuth, (req, res) => {
  console.log('/api/user called - session userId:', req.session.userId);
  db.get('SELECT id, username, nama, no_pekerja, jawatan, jabatan, telefon, profile_pic FROM users WHERE id = ?',
    [req.session.userId], (err, row) => {
      if (err || !row) return res.json({ success: true, user: { id: req.session.userId, username: req.session.username } });
      res.json({ success: true, user: row });
    });
});

// Diagnostic endpoint - check persistent storage status
app.get('/api/status', (req, res) => {
  const dbPath = DB_FILE_PATH;
  const sessionDbPath = path.join(SESSION_DB_DIR, 'sessions.db');
  const isPersistent = dbPath.startsWith('/var/data');
  let dbSize = null;
  let dbExists = false;
  try {
    const stat = fs.statSync(dbPath);
    dbExists = true;
    dbSize = (stat.size / 1024).toFixed(2) + ' KB';
  } catch (e) { /* file not found */ }

  res.json({
    status: isPersistent ? 'PERSISTENT' : 'EPHEMERAL - DATA WILL BE LOST ON RESTART',
    persistent: isPersistent,
    db_path: dbPath,
    db_exists: dbExists,
    db_size: dbSize,
    session_db: sessionDbPath,
    node_env: process.env.NODE_ENV || 'development',
    warning: !isPersistent ? 'DB_PATH env var not set to /var/data/app.db - disk not mounted!' : null,
    backup: {
      enabled: BACKUP_ENABLED,
      directory: BACKUP_DIR,
      intervalHours: BACKUP_INTERVAL_HOURS,
      retentionCount: BACKUP_RETENTION_COUNT,
      inProgress: backupInProgress,
      last: lastBackupInfo
    }
  });
});

// Admin backup endpoints
app.get('/api/backup/status', requireAdmin, (req, res) => {
  let files = [];
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      files = fs.readdirSync(BACKUP_DIR)
        .filter((name) => name.endsWith('.db') || name.endsWith('.json'))
        .map((name) => {
          const fullPath = path.join(BACKUP_DIR, name);
          const stat = fs.statSync(fullPath);
          return { name, sizeBytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() };
        })
        .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read backup directory', details: err.message });
  }

  res.json({
    success: true,
    config: {
      enabled: BACKUP_ENABLED,
      directory: BACKUP_DIR,
      intervalHours: BACKUP_INTERVAL_HOURS,
      retentionCount: BACKUP_RETENTION_COUNT
    },
    inProgress: backupInProgress,
    lastBackup: lastBackupInfo,
    files
  });
});

app.post('/api/backup/run', requireAdmin, async (req, res) => {
  try {
    const summary = await runSqliteBackup('manual-api');
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: 'Backup failed', details: err.message, lastBackup: lastBackupInfo });
  }
});

// Get user data or all data for dashboard views
app.get('/api/data', requireAuth, (req, res) => {
  console.log('/api/data called - session userId:', req.session.userId, 'all=', req.query.all);
  const returnAll = req.query.all === 'true';
  const sql = returnAll ? 'SELECT * FROM data ORDER BY created_at DESC' : 'SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC';
  const params = returnAll ? [] : [req.session.userId];

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, data: rows });
  });
});

// Debug endpoint (no auth) - returns all data entries for debugging only
app.get('/api/data/debug', (req, res) => {
  console.log('/api/data/debug called (unauthenticated debug)');
  db.all('SELECT * FROM data ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error', details: err.message });
    res.json({ success: true, count: rows.length, data: rows });
  });
});

// Create data entry
app.post('/api/data', requireAuth, upload.single('image'), (req, res) => {
  const { category, tarikh, rujukan, dibayar_kepada, kepala_vot, aktiviti, perkara, liabiliti, bayaran } = req.body;
  const image = req.file ? '/uploads/' + req.file.filename : null;
  const userId = req.session.userId;

  if (!userId) return res.status(401).json({ error: 'User not authenticated' });

  const categoryNormalized = normalizeCategory(category);
  const bayaranAmount = parseFloat(bayaran) || 0;

  db.run(`INSERT INTO data (user_id, category, tarikh, rujukan, dibayar_kepada, kepala_vot, aktiviti, perkara, liabiliti, bayaran, jumlah_bayaran, baki, transaction_type, voucher_status, image)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'bill', 'active', ?)`,
    [userId, categoryNormalized, tarikh, rujukan, dibayar_kepada, kepala_vot, aktiviti || '', perkara, liabiliti, bayaranAmount, image],
    function(insertErr) {
      if (insertErr) {
        console.error('Database error inserting data:', insertErr);
        return res.status(500).json({ error: 'Database error: ' + insertErr.message });
      }

      const insertedId = this.lastID;
      recalculateScopeRunningTotals(aktiviti, kepala_vot, (recalcErr) => {
        if (recalcErr) return res.status(500).json({ error: 'Recalculate error: ' + recalcErr.message });
        db.get('SELECT jumlah_bayaran, baki FROM data WHERE id = ?', [insertedId], (readErr, insertedRow) => {
          if (readErr) return res.status(500).json({ error: 'Database error' });
          res.json({
            success: true,
            id: insertedId,
            jumlah_bayaran: parseFloat(insertedRow?.jumlah_bayaran) || 0,
            baki: parseFloat(insertedRow?.baki) || 0
          });
        });
      });
    });
});

// Update data entry
app.put('/api/data/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid data ID' });

  const isAdmin = req.session && req.session.username === 'admin';

  db.get('SELECT * FROM data WHERE id = ?', [id], (findErr, existing) => {
    if (findErr) return res.status(500).json({ error: 'Database error' });
    if (!existing) return res.status(404).json({ error: 'Data not found' });
    if (!isAdmin && existing.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Unauthorized to edit this entry' });
    }
    if (String(existing.transaction_type || 'bill') !== 'bill') {
      return res.status(400).json({ error: 'Hanya baucar asal boleh dikemaskini.' });
    }
    if (String(existing.voucher_status || 'active') === 'cancelled') {
      return res.status(400).json({ error: 'Baucar yang telah dibatalkan tidak boleh dikemaskini.' });
    }

    const nextCategory = normalizeCategory(req.body.category ?? existing.category ?? 'perbekalan');
    const nextTarikh = req.body.tarikh ?? existing.tarikh;
    const nextRujukan = req.body.rujukan ?? existing.rujukan;
    const nextDibayar = req.body.dibayar_kepada ?? existing.dibayar_kepada;
    const nextKepalaVot = req.body.kepala_vot ?? existing.kepala_vot;
    const nextAktiviti = req.body.aktiviti ?? existing.aktiviti;
    const nextPerkara = req.body.perkara ?? existing.perkara;
    const nextLiabiliti = req.body.liabiliti ?? existing.liabiliti;
    const nextBayaran = parseFloat(req.body.bayaran);
    const bayaranValue = Number.isFinite(nextBayaran) ? nextBayaran : (parseFloat(existing.bayaran) || 0);

    db.run(
      `UPDATE data
       SET category = ?, tarikh = ?, rujukan = ?, dibayar_kepada = ?, kepala_vot = ?, aktiviti = ?, perkara = ?, liabiliti = ?, bayaran = ?
       WHERE id = ?`,
      [nextCategory, nextTarikh, nextRujukan, nextDibayar, nextKepalaVot, nextAktiviti, nextPerkara, nextLiabiliti, bayaranValue, id],
      (updateErr) => {
        if (updateErr) return res.status(500).json({ error: 'Database error: ' + updateErr.message });

        recalculateMultipleScopes([
          { aktiviti: existing.aktiviti, kepala_vot: existing.kepala_vot },
          { aktiviti: nextAktiviti, kepala_vot: nextKepalaVot }
        ], (recalcErr) => {
          if (recalcErr) return res.status(500).json({ error: 'Recalculate error: ' + recalcErr.message });
          res.json({ success: true });
        });
      }
    );
  });
});

app.get('/api/cancelled-vouchers', requireAuth, (req, res) => {
  db.all(
    `SELECT original.*, cancel.id AS cancellation_entry_id, cancel.tarikh AS cancellation_tarikh,
            cancel.created_at AS cancellation_created_at, cancel.bayaran AS cancellation_amount,
            cancel.perkara AS cancellation_perkara, cancel.cancellation_reason AS cancellation_reason,
            u.username AS cancelled_by_username
     FROM data original
     LEFT JOIN data cancel ON cancel.parent_data_id = original.id AND cancel.transaction_type = 'voucher_cancel'
     LEFT JOIN users u ON u.id = cancel.cancelled_by
     WHERE original.transaction_type = 'bill' AND original.voucher_status = 'cancelled'
     ORDER BY datetime(cancel.created_at) DESC, cancel.id DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true, data: rows || [] });
    }
  );
});

app.post('/api/data/:id/cancel-voucher', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid voucher ID' });

  const reasonText = String(req.body?.reason || '').trim();
  const cancelTarikh = String(req.body?.tarikh || '').trim() || new Date().toISOString().split('T')[0];
  const cancelledAt = getMalaysiaTime();

  db.get('SELECT * FROM data WHERE id = ?', [id], (findErr, existing) => {
    if (findErr) return res.status(500).json({ error: 'Database error' });
    if (!existing) return res.status(404).json({ error: 'Baucar tidak dijumpai' });
    if (String(existing.transaction_type || 'bill') !== 'bill') {
      return res.status(400).json({ error: 'Hanya baucar asal boleh dibatalkan' });
    }
    if (String(existing.voucher_status || 'active') === 'cancelled') {
      return res.status(400).json({ error: 'Baucar ini telah dibatalkan sebelum ini' });
    }

    const categoryNormalized = normalizeCategory(existing.category);
    const amount = parseFloat(existing.bayaran) || 0;
    const reasonSuffix = reasonText ? ` Sebab: ${reasonText}` : '';
    const cancelPerkara = `PEMBATALAN BAUCAR: ${existing.perkara || '-'}${reasonSuffix}`;
    const cancelRujukan = existing.rujukan ? `${existing.rujukan} (BATAL)` : 'BATAL BAUCAR';

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.run(
        `UPDATE data
         SET voucher_status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancellation_reason = ?
         WHERE id = ?`,
        [cancelledAt, req.session.userId, reasonText || null, id],
        function(updateErr) {
          if (updateErr) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: 'Database error: ' + updateErr.message });
          }

          db.run(
            `INSERT INTO data (
               user_id, category, tarikh, rujukan, dibayar_kepada, kepala_vot, aktiviti, perkara,
               liabiliti, bayaran, jumlah_bayaran, baki, transaction_type, voucher_status,
               parent_data_id, cancelled_at, cancelled_by, cancellation_reason, image
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'voucher_cancel', 'cancel-entry', ?, ?, ?, ?, ?)`,
            [
              existing.user_id,
              categoryNormalized,
              cancelTarikh,
              cancelRujukan,
              existing.dibayar_kepada,
              existing.kepala_vot,
              existing.aktiviti || '',
              cancelPerkara,
              existing.liabiliti,
              -amount,
              existing.id,
              cancelledAt,
              req.session.userId,
              reasonText || null,
              existing.image || null
            ],
            function(insertErr) {
              if (insertErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Database error: ' + insertErr.message });
              }

              const cancellationId = this.lastID;

              recalculateScopeRunningTotals(existing.aktiviti, existing.kepala_vot, (recalcErr) => {
                if (recalcErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'Recalculate error: ' + recalcErr.message });
                }

                db.run('COMMIT', (commitErr) => {
                  if (commitErr) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error: ' + commitErr.message });
                  }

                  res.json({ success: true, cancellationId });
                });
              });
            }
          );
        }
      );
    });
  });
});

// Delete data entry
app.delete('/api/data/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid data ID' });

  const isAdmin = req.session && req.session.username === 'admin';
  db.get('SELECT * FROM data WHERE id = ?', [id], (findErr, existing) => {
    if (findErr) return res.status(500).json({ error: 'Database error' });
    if (!existing) return res.status(404).json({ error: 'Data not found' });
    if (!isAdmin && existing.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this entry' });
    }
    if (String(existing.transaction_type || 'bill') !== 'bill') {
      return res.status(400).json({ error: 'Rekod pembatalan tidak boleh dipadam secara terus.' });
    }
    if (String(existing.voucher_status || 'active') === 'cancelled') {
      return res.status(400).json({ error: 'Baucar yang telah dibatalkan tidak boleh dipadam.' });
    }

    db.run('DELETE FROM data WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      recalculateScopeRunningTotals(existing.aktiviti, existing.kepala_vot, (recalcErr) => {
        if (recalcErr) return res.status(500).json({ error: 'Recalculate error: ' + recalcErr.message });
        res.json({ success: true });
      });
    });
  });
});

// Batch delete selected data entries
app.delete('/api/data', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No IDs provided' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const params = [...ids, req.session.userId];
  db.run(`DELETE FROM data WHERE id IN (${placeholders}) AND user_id = ?`, params, function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, deleted: this.changes });
  });
});

// Delete ALL data entries for current user
app.delete('/api/data-all', requireAdmin, (req, res) => {
  db.run('DELETE FROM data', [], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, deleted: this.changes });
  });
});

// Get statistics
app.get('/api/stats', requireAuth, (req, res) => {
  const returnAll = req.query.all === 'true';
  const sql = returnAll
    ? 'SELECT COUNT(*) as total_entries, SUM(jumlah_bayaran) as total_amount FROM data'
    : 'SELECT COUNT(*) as total_entries, SUM(jumlah_bayaran) as total_amount FROM data WHERE user_id = ?';
  const params = returnAll ? [] : [req.session.userId];

  db.get(sql, params, (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ stats: row });
  });
});

// Get all users (admin only)
app.get('/api/users', requireAdmin, (req, res) => {
  db.all(`
    SELECT
      id,
      username,
      nama,
      no_pekerja,
      jawatan,
      jabatan,
      telefon,
      profile_pic,
      created_at,
      CASE WHEN LOWER(username) = 'admin' THEN 'Admin' ELSE 'Pengguna' END AS role
    FROM users
    ORDER BY id
  `, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ data: rows });
  });
});

// Create new user (admin only)
app.post('/api/users', requireAdmin, upload.single('profile_pic'), (req, res) => {
  const { username, password, nama, no_pekerja, jawatan, jabatan, telefon } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const profile_pic = req.file ? '/uploads/' + req.file.filename : null;

  db.run(
    'INSERT INTO users (username, password, nama, no_pekerja, jawatan, jabatan, telefon, profile_pic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [username, password, nama || null, no_pekerja || null, jawatan || null, jabatan || null, telefon || null, profile_pic],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Username already exists' });
        }
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// Update own profile picture
app.post('/api/user/profile-pic', requireAuth, upload.single('profile_pic'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const profile_pic = '/uploads/' + req.file.filename;
  db.run('UPDATE users SET profile_pic = ? WHERE id = ?', [profile_pic, req.session.userId], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, profile_pic });
  });
});

// Delete user (admin only)
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  
  // Prevent deleting admin account
  if (id == req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true });
  });
});

// Get login history for all users (admin only) - last login & logout per user
app.get('/api/users/login-history', requireAdmin, (req, res) => {
  const sql = `
    SELECT
      u.id,
      MAX(CASE WHEN l.action = 'login'  THEN l.logged_at END) AS last_login,
      MAX(CASE WHEN l.action = 'logout' THEN l.logged_at END) AS last_logout
    FROM users u
    LEFT JOIN login_logs l ON l.user_id = u.id
    GROUP BY u.id
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, data: rows });
  });
});

// Get full login history for a specific user (admin only)
app.get('/api/users/:id/login-history', requireAdmin, (req, res) => {
  db.all(
    'SELECT action, ip_address, logged_at FROM login_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 50',
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true, data: rows });
    }
  );
});

// Get all notices (admin only) - for admin management
app.get('/api/notices', requireAdmin, (req, res) => {
  db.all('SELECT * FROM notices ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ data: rows });
  });
});

// Get all notices for users (public inbox view)
app.get('/api/notices/inbox', requireAuth, (req, res) => {
  db.all(`
    SELECT 
      notices.id, 
      notices.title, 
      notices.content, 
      notices.category, 
      notices.image_data,
      notices.image_name,
      notices.created_at,
      users.username
    FROM notices
    LEFT JOIN users ON notices.created_by = users.id
    ORDER BY notices.created_at DESC
  `, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, notices: rows || [] });
  });
});

// Create notice (admin only)
app.post('/api/notices', requireAdmin, upload.single('noticeImage'), (req, res) => {
  const { title, content, category } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  const imagePath = req.file ? '/uploads/' + req.file.filename : null;
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  db.run('INSERT INTO notices (title, content, category, image_data, image_name, created_by) VALUES (?, ?, ?, ?, ?, ?)', 
         [title, content, category || 'Pengumuman', imagePath, req.file ? req.file.filename : null, userId], 
         function(err) {
    if (err) {
      console.error('Database error inserting notice:', err);
      return res.status(500).json({ error: 'Database error: ' + err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// Delete notice (admin only)
app.delete('/api/notices/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  
  db.run('DELETE FROM notices WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Notice not found' });
    }
    res.json({ success: true });
  });
});

// Get all category budgets
app.get('/api/budgets', requireAuth, (req, res) => {
  db.all('SELECT category, peruntukan, updated_at FROM category_budgets ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, budgets: rows || [] });
  });
});

// Set/update budget for a category
app.post('/api/budgets', requireAuth, (req, res) => {
  const { category, peruntukan } = req.body;
  if (!category) return res.status(400).json({ error: 'Category required' });
  const catNorm = category.toString().toLowerCase();
  const amount = parseFloat(peruntukan) || 0;
  db.run(`INSERT INTO category_budgets (category, peruntukan, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(category) DO UPDATE SET peruntukan = excluded.peruntukan, updated_at = CURRENT_TIMESTAMP`,
    [catNorm, amount], function(err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    });
});

// Get balance info for a category
app.get('/api/balance/:category', requireAuth, (req, res) => {
  const cat = req.params.category.toLowerCase();
  db.get('SELECT peruntukan FROM category_budgets WHERE category = ?', [cat], (err, budget) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const peruntukan = budget ? parseFloat(budget.peruntukan) || 0 : 0;
    db.get('SELECT COALESCE(SUM(bayaran), 0) as total FROM data WHERE LOWER(category) = ?', [cat], (err2, row) => {
      if (err2) return res.status(500).json({ error: 'Database error' });
      const jumlah_bayaran = parseFloat(row.total) || 0;
      res.json({ success: true, peruntukan, jumlah_bayaran, baki: peruntukan - jumlah_bayaran });
    });
  });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SEO: robots file for search engine crawlers
app.get('/robots.txt', (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const content = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /dashboard',
    'Disallow: /data-entry',
    'Disallow: /admin-management',
    `Sitemap: ${baseUrl}/sitemap.xml`
  ].join('\n');

  res.type('text/plain').send(content);
});

// SEO: sitemap for Google indexing
app.get('/sitemap.xml', (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const nowIso = new Date().toISOString();
  const urls = [
    { loc: `${baseUrl}/`, changefreq: 'weekly', priority: '1.0' }
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((url) => (
      `  <url>\n` +
      `    <loc>${url.loc}</loc>\n` +
      `    <lastmod>${nowIso}</lastmod>\n` +
      `    <changefreq>${url.changefreq}</changefreq>\n` +
      `    <priority>${url.priority}</priority>\n` +
      `  </url>`
    )).join('\n') +
    `\n</urlset>`;

  res.type('application/xml').send(xml);
});

// ── Kepala VOT List API ─────────────────────────────────────────
// Get kepala vot options, optional ?category= or ?aktiviti= filter
app.get('/api/kepala-vot', requireAuth, (req, res) => {
  const { category, aktiviti } = req.query;
  let sql, params;
  
  if (aktiviti) {
    // aktiviti como "210100" or "210200" - must match start of stored aktiviti field
    sql = 'SELECT * FROM kepala_vot_list WHERE SUBSTR(aktiviti, 1, LENGTH(?)) = ? ORDER BY kod ASC';
    params = [aktiviti, aktiviti];
    console.log('[API kepala-vot] Filter by aktiviti:', aktiviti);
  } else if (category) {
    sql = 'SELECT * FROM kepala_vot_list WHERE LOWER(category) = LOWER(?) ORDER BY kod ASC';
    params = [category];
    console.log('[API kepala-vot] Filter by category:', category);
  } else {
    sql = 'SELECT * FROM kepala_vot_list ORDER BY category ASC, kod ASC';
    params = [];
    console.log('[API kepala-vot] Return all KVs');
  }
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('[API kepala-vot] DB error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    console.log('[API kepala-vot] Returned:', rows ? rows.length : 0, 'records');
    res.json({ success: true, data: rows || [] });
  });
});

// Add kepala vot option (admin only)
app.post('/api/kepala-vot', requireAdmin, (req, res) => {
  const { aktiviti, kod, keterangan, peruntukan, category } = req.body;
  if (!kod) return res.status(400).json({ error: 'Kod diperlukan' });
  if (!category) return res.status(400).json({ error: 'Kategori diperlukan' });
  db.run('INSERT INTO kepala_vot_list (aktiviti, kod, keterangan, peruntukan, category) VALUES (?, ?, ?, ?, ?)', [aktiviti || '', kod.trim(), keterangan || '', parseFloat(peruntukan) || 0, category.toLowerCase()], function(err) {
    if (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Kod yang sama sudah wujud untuk aktiviti ini.' });
      }
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// Update kepala vot allocation (admin only)
app.put('/api/kepala-vot/:id', requireAdmin, (req, res) => {
  const amount = parseFloat(req.body.peruntukan) || 0;
  db.run('UPDATE kepala_vot_list SET peruntukan = ? WHERE id = ?', [amount, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Tidak dijumpai' });
    res.json({ success: true });
  });
});

// Delete kepala vot option (admin only)
app.delete('/api/kepala-vot/:id', requireAdmin, (req, res) => {
  db.run('DELETE FROM kepala_vot_list WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Tidak dijumpai' });
    res.json({ success: true });
  });
});
// ───────────────────────────────────────────────────────────────

// Serve dashboard - check if user is authenticated
app.get('/dashboard', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve data-entry page - check if user is authenticated
app.get('/data-entry', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'data-entry.html'));
});

// Serve admin-management page - check if user is authenticated
app.get('/admin-management', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin-management.html'));
});

// Export data to PDF
app.get('/api/export/pdf', requireAuth, (req, res) => {
  const month = req.query.month;
  
  db.all('SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC', [req.session.userId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    let filteredData = rows || [];
    if (month) {
      filteredData = filteredData.filter(item => {
        const date = new Date(item.tarikh);
        const itemMonth = String(date.getMonth() + 1).padStart(2, '0');
        return itemMonth === month;
      });
    }

    const PDFDocument = require('pdfkit');
    const fs = require('fs');
    const doc = new PDFDocument({ margin: 40 });
    const pdfFonts = configurePdfFonts(doc);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="data_export.pdf"');
    
    doc.pipe(res);
    
    // Add logo
    const logoPath = path.join(__dirname, 'public', 'images', 'LOGO SMJ.jpg');
    
    try {
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 40, 20, { width: 80 });
      }
    } catch (imgErr) {
      console.error('Error adding logo:', imgErr.message);
    }
    
    // Header
    doc.fontSize(18).font(pdfFonts.bold).text('LAPORAN DATA TRANSAKSI', { align: 'center' });
    doc.fontSize(11).font(pdfFonts.regular).text('Data Storage System', { align: 'center' });
    doc.moveDown(0.5);
    
    // Date info
    const monthNames = ['Januari', 'Februari', 'Mac', 'April', 'Mei', 'Juni', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'];
    let dateInfo = `Tarikh Laporan: ${new Date().toLocaleDateString('ms-MY')}`;
    if (month) {
      const monthIndex = parseInt(month) - 1;
      dateInfo += ` | Bulan: ${monthNames[monthIndex]}`;
    }
    doc.fontSize(10).text(dateInfo, { align: 'center' });
    
    // Separator line
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.5);
    
    // Table headers
    const pageWidth = doc.page.width;
    const margins = 40;
    const contentWidth = pageWidth - 2 * margins;
    const colWidths = [60, 70, 100, 70, 80, 80];
    
    let yPos = doc.y;
    const rowHeight = 25;
    
    doc.fontSize(10).font(pdfFonts.bold).fillColor('#FFFFFF');
    doc.rect(margins, yPos - 5, contentWidth, 20).fill('#2C3E50');
    
    let xPos = margins + 5;
    const headers = ['Tarikh', 'Rujukan', 'Perkara', 'Bayaran', 'Jumlah', 'Baki'];
    headers.forEach((header, i) => {
      doc.text(header, xPos, yPos - 2, { 
        width: colWidths[i] - 5, 
        align: i > 2 ? 'right' : 'left' 
      });
      xPos += colWidths[i];
    });
    
    yPos += 22;
    doc.fillColor('#000000');
    
    // Data rows
    doc.font(pdfFonts.regular);
    doc.fontSize(9);
    let totalBayaran = 0;
    let totalJumlahBayaran = 0;
    let totalBaki = 0;
    
    filteredData.forEach((row, index) => {
      if (yPos > doc.page.height - 60) {
        doc.addPage();
        yPos = 50;
      }
      
      // Alternating row color
      if (index % 2 === 0) {
        doc.rect(margins, yPos - 5, contentWidth, rowHeight - 5).fill('#F8F9FA');
        doc.fillColor('#000000');
      }
      
      xPos = margins + 5;
      doc.text(row.tarikh || '-', xPos, yPos, { width: colWidths[0] - 5, align: 'left' });
      doc.text(row.rujukan || '-', xPos + colWidths[0], yPos, { width: colWidths[1] - 5, align: 'left' });
      doc.text((row.perkara || '-').substring(0, 20), xPos + colWidths[0] + colWidths[1], yPos, { width: colWidths[2] - 5, align: 'left' });
      doc.text('RM ' + (parseFloat(row.bayaran) || 0).toFixed(2), xPos + colWidths[0] + colWidths[1] + colWidths[2], yPos, { width: colWidths[3] - 5, align: 'right' });
      doc.text('RM ' + (parseFloat(row.jumlah_bayaran) || 0).toFixed(2), xPos + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], yPos, { width: colWidths[4] - 5, align: 'right' });
      doc.text('RM ' + (parseFloat(row.baki) || 0).toFixed(2), xPos + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4], yPos, { width: colWidths[5] - 5, align: 'right' });
      
      totalBayaran += parseFloat(row.bayaran) || 0;
      totalJumlahBayaran += parseFloat(row.jumlah_bayaran) || 0;
      totalBaki += parseFloat(row.baki) || 0;
      
      yPos += rowHeight;
    });
    
    // Total row
    yPos += 5;
    doc.rect(margins, yPos - 5, contentWidth, 20).fill('#2C3E50');
    doc.fillColor('#FFFFFF').font(pdfFonts.bold).fontSize(10);
    
    xPos = margins + 5;
    doc.text('JUMLAH', xPos + colWidths[0] + colWidths[1] + colWidths[2], yPos - 2, { width: colWidths[3] - 5, align: 'right' });
    doc.text('RM ' + totalBayaran.toFixed(2), xPos + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3], yPos - 2, { width: colWidths[4] - 5, align: 'right' });
    doc.text('RM ' + totalJumlahBayaran.toFixed(2), xPos + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4], yPos - 2, { width: colWidths[5] - 5, align: 'right' });
    
    yPos += 25;
    doc.fillColor('#000000');
    
    // Summary stats
    doc.moveDown(0.5);
    doc.fontSize(9).text(`Jumlah Rekod: ${filteredData.length}`, margins);
    doc.text(`Total Bayaran: RM ${totalBayaran.toFixed(2)}`);
    doc.text(`Total Jumlah Bayaran: RM ${totalJumlahBayaran.toFixed(2)}`);
    doc.text(`Total Baki: RM ${totalBaki.toFixed(2)}`);
    
    // Footer
    doc.moveDown(1);
    doc.fontSize(8).fillColor('#666666');
    doc.moveTo(margins, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.3);
    doc.text(`Laporan ini dijana secara automatik pada ${new Date().toLocaleString('ms-MY')}`, { align: 'center' });
    doc.text('© Data Storage System - Pihak Berkuasa', { align: 'center' });
    
    doc.end();
  });
});

// Export data to Excel
app.get('/api/export/excel', requireAuth, (req, res) => {
  const month = req.query.month;
  
  db.all('SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC', [req.session.userId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    let filteredData = rows || [];
    if (month) {
      filteredData = filteredData.filter(item => {
        const date = new Date(item.tarikh);
        const itemMonth = String(date.getMonth() + 1).padStart(2, '0');
        return itemMonth === month;
      });
    }

    const XLSX = require('xlsx');
    
    // Prepare data with headers
    const headers = ['Tarikh', 'Rujukan', 'Dibayar Kepada', 'Perkara', 'Kategori', 'Liabiliti', 'Bayaran', 'Jumlah Bayaran', 'Baki'];
    const data = filteredData.map(row => [
      row.tarikh || '-',
      row.rujukan || '-',
      row.dibayar_kepada || '-',
      row.perkara || '-',
      row.category || '-',
      row.liabiliti || '-',
      parseFloat(row.bayaran) || 0,
      parseFloat(row.jumlah_bayaran) || 0,
      parseFloat(row.baki) || 0
    ]);
    
    // Calculate totals
    const totals = [
      'JUMLAH',
      '',
      '',
      '',
      '',
      '',
      filteredData.reduce((sum, row) => sum + (parseFloat(row.bayaran) || 0), 0),
      filteredData.reduce((sum, row) => sum + (parseFloat(row.jumlah_bayaran) || 0), 0),
      filteredData.reduce((sum, row) => sum + (parseFloat(row.baki) || 0), 0)
    ];
    
    // Create worksheet with title and headers
    const wsData = [
      ['LAPORAN DATA TRANSAKSI'],
      ['Data Storage System'],
      [`Tarikh Laporan: ${new Date().toLocaleDateString('ms-MY')}`],
      [],
      headers,
      ...data,
      totals
    ];
    
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 12 }, // Tarikh
      { wch: 12 }, // Rujukan
      { wch: 15 }, // Dibayar Kepada
      { wch: 20 }, // Perkara
      { wch: 12 }, // Kategori
      { wch: 15 }, // Liabiliti
      { wch: 12 }, // Bayaran
      { wch: 15 }, // Jumlah Bayaran
      { wch: 12 }  // Baki
    ];
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data Export');
    
    // Write to response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="data_export.xlsx"');
    
    XLSX.write(wb, { type: 'stream', stream: res });
  });
});

// Export data to CSV
app.get('/api/export/csv', requireAuth, (req, res) => {
  const month = req.query.month;
  
  db.all('SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC', [req.session.userId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    let filteredData = rows || [];
    if (month) {
      filteredData = filteredData.filter(item => {
        const date = new Date(item.tarikh);
        const itemMonth = String(date.getMonth() + 1).padStart(2, '0');
        return itemMonth === month;
      });
    }

    const XLSX = require('xlsx');
    
    // Prepare headers
    const headers = ['Tarikh', 'Rujukan', 'Dibayar Kepada', 'Perkara', 'Kategori', 'Liabiliti', 'Bayaran', 'Jumlah Bayaran', 'Baki'];
    
    // Prepare data
    const data = filteredData.map(row => [
      row.tarikh || '-',
      row.rujukan || '-',
      row.dibayar_kepada || '-',
      row.perkara || '-',
      row.category || '-',
      row.liabiliti || '-',
      parseFloat(row.bayaran) || 0,
      parseFloat(row.jumlah_bayaran) || 0,
      parseFloat(row.baki) || 0
    ]);
    
    // Calculate totals
    const totals = [
      'JUMLAH',
      '',
      '',
      '',
      '',
      '',
      filteredData.reduce((sum, row) => sum + (parseFloat(row.bayaran) || 0), 0),
      filteredData.reduce((sum, row) => sum + (parseFloat(row.jumlah_bayaran) || 0), 0),
      filteredData.reduce((sum, row) => sum + (parseFloat(row.baki) || 0), 0)
    ];
    
    // Build CSV content
    let csv = 'LAPORAN DATA TRANSAKSI\n';
    csv += 'Data Storage System\n';
    csv += `Tarikh Laporan: ${new Date().toLocaleDateString('ms-MY')}\n`;
    csv += '\n';
    csv += headers.map(h => `"${h}"`).join(',') + '\n';
    
    data.forEach(row => {
      csv += row.map(cell => {
        // Escape quotes in cells
        const cellStr = String(cell).replace(/"/g, '""');
        return `"${cellStr}"`;
      }).join(',') + '\n';
    });
    
    csv += totals.map(cell => {
      const cellStr = String(cell).replace(/"/g, '""');
      return `"${cellStr}"`;
    }).join(',') + '\n';
    
    csv += '\n';
    csv += `Jumlah Rekod: ${filteredData.length}\n`;
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8;');
    res.setHeader('Content-Disposition', 'attachment; filename="data_export.csv"');
    
    res.end(`\ufeff${csv}`); // Add BOM for UTF-8 Excel compatibility
  });
});

// ══════════════════════════════════════════════════════════════════
// PROFESSIONAL PENYATA PDF EXPORT
// GET /api/penyata/pdf?category=perbekalan&month=01
// ══════════════════════════════════════════════════════════════════
app.get('/api/penyata/pdf', requireAuth, (req, res) => {
  const { month, category, buku_vot, kepala_vot, kepala_vot_desc } = req.query;
  const monthNames = ['Januari','Februari','Mac','April','Mei','Juni','Julai','Ogos','September','Oktober','November','Disember'];

  db.all('SELECT * FROM data ORDER BY category ASC, tarikh ASC, created_at ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    let data = rows || [];
    if (buku_vot) {
      data = data.filter(r => String(r.aktiviti || '').startsWith(String(buku_vot)));
    } else if (category) {
      data = data.filter(r => (r.category||'').toLowerCase() === category.toLowerCase());
    }
    if (kepala_vot) data = data.filter(r => String(r.kepala_vot || '').trim() === String(kepala_vot).trim());
    const allDataBeforeMonthFilter = data.slice(); // save before month filter for correct opening balance
    if (month) data = data.filter(r => {
      if (!r.tarikh) return false;
      return String(new Date(r.tarikh).getMonth() + 1).padStart(2,'0') === month;
    });

    const selectedKod = kepala_vot ? String(kepala_vot).trim() : '';
    const descFromQuery = kepala_vot_desc ? String(kepala_vot_desc).trim() : '';
    const runPdf = (resolvedKodDesc = '', resolvedPeruntukan = 0, kvMetaByKod = {}) => {
    try {
      const PDFDocument = require('pdfkit');
      const fsLib = require('fs');
      const bukuVotMap = {
        perbekalan: '210100 - PERBELANJAAN SEKRETARIAT SABAH MAJU JAYA',
        pembangunan: '210200 - PROGRAM MENOKTAHKAN MISKIN TEGAR',
        gaji: 'GAJI',
        operasi: 'OPERASI',
        penyelenggaraan: 'PENYELENGGARAAN',
        utiliti: 'UTILITI'
      };
      const bukuVotCode = String(buku_vot || '').trim();
      const catNorm = (category || '').toLowerCase();
      const bukuVotLabel = bukuVotCode === '210100'
        ? '210100 - PERBELANJAAN SEKRETARIAT SABAH MAJU JAYA'
        : bukuVotCode === '210200'
          ? '210200 - PROGRAM MENOKTAHKAN MISKIN TEGAR'
          : (bukuVotMap[catNorm] || 'SEMUA BUKU VOT');
      const monthLabel = month ? monthNames[parseInt(month)-1] : 'Semua Bulan';
      const selectedKodDesc = resolvedKodDesc;
      const selectedKodLabel = selectedKod ? (selectedKodDesc ? `${selectedKod} - ${selectedKodDesc}` : selectedKod) : 'Semua Kod Kepala VOT';

      const doc = new PDFDocument({ size:'A4', layout:'landscape', margin:0, bufferPages:true });
      const pdfFonts = configurePdfFonts(doc);
      const filename = `Penyata_${bukuVotLabel}_${monthLabel}_${selectedKod || 'SemuaKod'}.pdf`.replace(/ /g,'_');
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
      doc.pipe(res);

      const PW = doc.page.width;   // ≈ 842
      const PH = doc.page.height;  // ≈ 595
      const MX = 28;
      const CONTENT_W = PW - MX * 2;
      const NAVY = '#1a3a6b';
      const LIGHT = '#eef2ff';

      // Accountant-style columns
      const cols = [
        { h:'Tarikh',               w:72,  a:'left',   k:'tarikh'         },
        { h:'Rujukan Transaksi',    w:96,  a:'left',   k:'rujukan'        },
        { h:'Dibayar Kepada',       w:132, a:'left',   k:'dibayar_kepada' },
        { h:'Butiran Transaksi',    w:230, a:'left',   k:'butiran_penyata' },
        { h:'Amaun (RM)',           w:82,  a:'right',  k:'bayaran'        },
        { h:'Jumlah Bayaran (RM)',  w:87,  a:'right',  k:'jumlah_bayaran' },
        { h:'Baki Semasa (RM)',     w:87,  a:'right',  k:'baki'           },
      ];
      const ROW_H = 18;
      const HDR_H = 22;
      const FOOT_H = 20;

      const HEADER_H = 102;
      const LINE1_Y  = 10;
      const LOGO_SIZE = 65;

      function fmtAmount(n) {
        const num = parseFloat(n || 0) || 0;
        return num.toLocaleString('ms-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      function drawHeader(isFirst) {
        // Background gradient-like: light top band
        doc.rect(0, 0, PW, HEADER_H).fill('#f4f6fb');
        // Navy accent left stripe
        doc.rect(0, 0, 6, HEADER_H).fill(NAVY);
        // Navy bottom border
        doc.rect(0, HEADER_H - 2, PW, 2).fill(NAVY);
        // Thin gold accent line above navy bottom
        doc.rect(0, HEADER_H - 4, PW, 2).fill('#c8a951');

        // Logo — left side, vertically centred
        const logoPath = path.join(__dirname,'public','images','logo-footer.png');
        const logoX = 18;
        const logoY = (HEADER_H - LOGO_SIZE) / 2;
        if (fsLib.existsSync(logoPath)) {
          try { doc.image(logoPath, logoX, logoY, { width:LOGO_SIZE, height:LOGO_SIZE }); } catch(e){}
        }

        // Vertical divider between logo and text
        const divX = logoX + LOGO_SIZE + 14;
        doc.rect(divX, 12, 1.5, HEADER_H - 24).fill('#c8d0e8');

        const textX = divX + 12;
        const textW = PW - textX - MX;

        if (isFirst) {
          // Organisation name
          doc.fillColor(NAVY).fontSize(16).font(pdfFonts.bold)
             .text('SISTEM PENGURUSAN KEWANGAN', textX, 11, { width:textW });
           doc.fillColor('#4b5f93').fontSize(9.5).font(pdfFonts.regular)
             .text('Sekretariat Sabah Maju Jaya, Jabatan Ketua Menteri', textX, 28, { width:textW });
          // Thin underline
           doc.rect(textX, 42, textW * 0.65, 1).fill('#c8a951');
          // Report subtitle
          doc.fillColor('#2c4a8c').fontSize(11).font(pdfFonts.bold)
             .text('PENYATA TRANSAKSI', textX, 47, { width:textW });
          // Details line
           doc.fillColor('#555').fontSize(8.5).font(pdfFonts.regular)
             .text(`Maklumat Buku VOT: ${bukuVotLabel}`, textX, 62, { width:textW });
           doc.fillColor('#555').fontSize(8.5)
             .text(`Kod Kepala VOT: ${selectedKodLabel}`, textX, 74, { width:textW });
           doc.fillColor('#555').fontSize(8.5)
             .text(`Bulan: ${monthLabel}`, textX, 86, { width:textW });
          // Print date — right aligned
          doc.fillColor('#888').fontSize(7.5)
             .text(`Tarikh Cetak: ${new Date().toLocaleDateString('ms-MY')}`, MX, HEADER_H - 19, { width:CONTENT_W, align:'right' });
        } else {
           doc.fillColor(NAVY).fontSize(13).font(pdfFonts.bold)
             .text('PENYATA TRANSAKSI', textX, 18, { width:textW });
           doc.fillColor('#555').fontSize(8.5).font(pdfFonts.regular)
             .text(`Buku VOT: ${bukuVotLabel}   ·   Kod: ${selectedKod || 'Semua'}   ·   Bulan: ${monthLabel}   ·   (sambungan)`, textX, 40, { width:textW });
          doc.fillColor('#888').fontSize(7.5)
             .text(`Tarikh Cetak: ${new Date().toLocaleDateString('ms-MY')}`, MX, HEADER_H - 18, { width:CONTENT_W, align:'right' });
        }
        return HEADER_H;
      }

      function drawTableHeader(y) {
        doc.rect(MX, y, CONTENT_W, HDR_H).fill(NAVY);
        doc.fillColor('#fff').fontSize(7.5).font(pdfFonts.bold);
        let x = MX;
        cols.forEach(c => {
          doc.text(c.h, x+3, y+(HDR_H-7.5)/2+1, { width:c.w-6, align:c.a });
          x += c.w;
        });
        return y + HDR_H;
      }

      function drawRow(row, y, even) {
        doc.rect(MX, y, CONTENT_W, ROW_H).fill(even ? LIGHT : '#fff');
        doc.rect(MX, y+ROW_H-0.5, CONTENT_W, 0.5).fill('#dde0f0');
        doc.fillColor('#333').fontSize(6.5).font(pdfFonts.regular);
        let x = MX;
        cols.forEach(c => {
          let val;
          if (['bayaran','jumlah_bayaran','baki'].includes(c.k)) {
            const n = parseFloat(row[c.k]||0);
            val = fmtAmount(n);
            doc.fillColor(c.k==='baki' && n<0 ? '#c0392b' : '#333');
          } else {
            const raw = (row[c.k]||'-').toString();
            const limit = c.k==='butiran_penyata' ? 68 : c.k==='dibayar_kepada' ? 24 : 20;
            val = raw.length > limit ? raw.substring(0,limit)+'…' : raw;
          }
          doc.text(val, x+3, y+5, { width:c.w-6, align:c.a });
          doc.fillColor('#333');
          x += c.w;
        });
        return y + ROW_H;
      }

      function drawTotals(y, tot) {
        doc.rect(MX, y, CONTENT_W, HDR_H).fill(NAVY);
        doc.fillColor('#fff').fontSize(7).font(pdfFonts.bold);
        let x = MX;
        cols.forEach((c,ci) => {
          let val = '';
          if (ci===3) val='JUMLAH KESELURUHAN (RM)';
          if (ci===4) val='RM ' + fmtAmount(tot.bayaran);
          if (ci===5) val='RM ' + fmtAmount(tot.jumlah_bayaran);
          if (ci===6) val='RM ' + fmtAmount(tot.baki);
          doc.text(val, x+3, y+(HDR_H-8)/2+1, { width:c.w-6, align:c.a });
          x += c.w;
        });
        return y + HDR_H;
      }

      // ── Render ───────────────────────────────────────────────────
      const TABLE_TOP_GAP = 8;
      const TABLE_BOTTOM_GAP = 8;
      const TOTALS_GAP = 10;
      const BOTTOM_RESERVE = FOOT_H + HDR_H + 26 + TABLE_BOTTOM_GAP;

      const peruntukanForSelectedKod = parseFloat(resolvedPeruntukan) || 0;
      const totalPeruntukanGlobal = selectedKod
        ? 0
        : Object.values(kvMetaByKod).reduce((sum, kv) => sum + (parseFloat(kv.peruntukan) || 0), 0);

      // allSourceData: all data for this buku_vot/kepala_vot (NOT month-filtered) — for correct balance calc
      const allSourceData = (allDataBeforeMonthFilter || []).slice().sort((a, b) => new Date(a.tarikh || a.created_at) - new Date(b.tarikh || b.created_at));
      // sourceData: month-filtered for display rows only
      const sourceData = (data || []).slice().sort((a, b) => new Date(a.tarikh || a.created_at) - new Date(b.tarikh || b.created_at));

      const openingByMonth = {};
      const rowsByMonth = {};
      const monthOrder = [];
      const runningTotalsById = {}; // pre-computed jumlah_bayaran & baki per row id

      // Pass 1: Compute running totals from ALL data (not month-filtered) for correct opening balances
      let tempGlobalBayaran = 0;
      const tempRunningByKod = {};
      allSourceData.forEach((row) => {
        const kod = String(row.kepala_vot || '').trim();
        const aktCode = String(row.aktiviti || '').trim().substring(0, 6);
        const kodKey = `${aktCode}|${kod}`;
        const kodPeruntukan = selectedKod
          ? peruntukanForSelectedKod
          : ((kvMetaByKod[kodKey]?.peruntukan) || (kvMetaByKod[kod]?.peruntukan) || 0);

        if (!tempRunningByKod[kodKey]) {
          tempRunningByKod[kodKey] = { jumlah: 0, peruntukan: kodPeruntukan };
        }

        const itemMonth = String(new Date(row.tarikh || row.created_at).getMonth() + 1).padStart(2, '0');
        if (!Object.prototype.hasOwnProperty.call(openingByMonth, itemMonth)) {
          if (!selectedKod) {
            openingByMonth[itemMonth] = totalPeruntukanGlobal - tempGlobalBayaran;
          } else {
            const selKey = Object.keys(tempRunningByKod).find(k => k.endsWith('|' + selectedKod));
            const info = selKey ? tempRunningByKod[selKey] : { jumlah: 0, peruntukan: peruntukanForSelectedKod };
            openingByMonth[itemMonth] = (parseFloat(info.peruntukan) || 0) - (parseFloat(info.jumlah) || 0);
          }
        }

        const n = parseFloat(row.bayaran) || 0;
        tempRunningByKod[kodKey].jumlah += n;
        if (!selectedKod) {
          tempGlobalBayaran += n;
          runningTotalsById[row.id] = { jumlah_bayaran: tempGlobalBayaran, baki: totalPeruntukanGlobal - tempGlobalBayaran };
        } else {
          runningTotalsById[row.id] = {
            jumlah_bayaran: tempRunningByKod[kodKey].jumlah,
            baki: tempRunningByKod[kodKey].peruntukan - tempRunningByKod[kodKey].jumlah
          };
        }
      });

      // Pass 2: Build display rows from month-filtered data using pre-computed running totals
      sourceData.forEach((row) => {
        const itemMonth = String(new Date(row.tarikh || row.created_at).getMonth() + 1).padStart(2, '0');
        if (!rowsByMonth[itemMonth]) {
          rowsByMonth[itemMonth] = [];
          monthOrder.push(itemMonth);
        }
        const totals = runningTotalsById[row.id] || { jumlah_bayaran: 0, baki: 0 };
        row.jumlah_bayaran = totals.jumlah_bayaran;
        row.baki = totals.baki;
        row.butiran_penyata = String(row.perkara || '-').trim();
        rowsByMonth[itemMonth].push(row);
      });

      const deriveOpeningForMonth = (targetMonth) => {
        const target = parseInt(targetMonth, 10);

        if (!selectedKod) {
          // Aggregate mode: use allSourceData so previous months' bayaran are included
          const totalBefore = allSourceData.reduce((sum, row) => {
            const itemMonth = parseInt(String(new Date(row.tarikh || row.created_at).getMonth() + 1), 10);
            if (itemMonth < target) sum += parseFloat(row.bayaran) || 0;
            return sum;
          }, 0);
          return totalPeruntukanGlobal - totalBefore;
        }

        const tempRunning = {};
        allSourceData.forEach((row) => {
          const itemMonth = parseInt(String(new Date(row.tarikh || row.created_at).getMonth() + 1), 10);
          const kod = String(row.kepala_vot || '').trim();
          const aktCode = String(row.aktiviti || '').trim().substring(0, 6);
          const kodKey = `${aktCode}|${kod}`;

          if (!tempRunning[kodKey]) {
            tempRunning[kodKey] = { jumlah: 0, peruntukan: peruntukanForSelectedKod };
          }

          if (itemMonth < target) {
            tempRunning[kodKey].jumlah += parseFloat(row.bayaran) || 0;
          }
        });

        const selectedKey = Object.keys(tempRunning).find(k => k.endsWith('|' + selectedKod));
        const info = (selectedKey ? tempRunning[selectedKey] : null) || { jumlah: 0, peruntukan: peruntukanForSelectedKod };
        return (parseFloat(info.peruntukan) || 0) - (parseFloat(info.jumlah) || 0);
      };

      const renderMonths = month
        ? [month]
        : monthOrder.slice().sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

      if (renderMonths.length === 0) {
        renderMonths.push(month || String(new Date().getMonth() + 1).padStart(2, '0'));
      }

      let pageFirst = true;
      let overallRecords = 0;
      let overallBayaran = 0;
      let overallJumlahAkhir = 0;
      let overallBakiAkhir = 0;

      renderMonths.forEach((mm, sectionIdx) => {
        const monthData = rowsByMonth[mm] || [];
        const opening = Object.prototype.hasOwnProperty.call(openingByMonth, mm)
          ? (openingByMonth[mm] || 0)
          : deriveOpeningForMonth(mm);
        const monthLabelText = monthNames[parseInt(mm, 10) - 1] || `Bulan ${mm}`;

        if (!pageFirst) {
          doc.addPage({ size:'A4', layout:'landscape', margin:0 });
        }

        let yPos = drawHeader(pageFirst) + TABLE_TOP_GAP;
        pageFirst = false;

        doc.fillColor('#2c4a8c').fontSize(9).font(pdfFonts.bold)
          .text(`BULAN: ${monthLabelText}`, MX, yPos, { width: CONTENT_W });
        yPos += 14;

        yPos = drawTableHeader(yPos);

        const openingRow = {
          tarikh: '-',
          rujukan: '-',
          dibayar_kepada: '-',
          butiran_penyata: 'BAKI DIBAWA KE HADAPAN',
          bayaran: 0,
          jumlah_bayaran: 0,
          baki: opening
        };
        yPos = drawRow(openingRow, yPos, true);

        const monthTot = { bayaran: 0, jumlah_bayaran: 0, baki: opening };
        monthData.forEach((row, idx) => {
          if (yPos + ROW_H > PH - BOTTOM_RESERVE) {
            doc.addPage({ size:'A4', layout:'landscape', margin:0 });
            yPos = drawHeader(false) + TABLE_TOP_GAP;
            doc.fillColor('#2c4a8c').fontSize(9).font(pdfFonts.bold)
              .text(`BULAN: ${monthLabelText} (sambungan)`, MX, yPos, { width: CONTENT_W });
            yPos += 14;
            yPos = drawTableHeader(yPos);
          }

          yPos = drawRow(row, yPos, idx % 2 === 0);
          monthTot.bayaran += parseFloat(row.bayaran) || 0;
          monthTot.jumlah_bayaran = parseFloat(row.jumlah_bayaran) || monthTot.jumlah_bayaran;
          monthTot.baki = parseFloat(row.baki) || monthTot.baki;
        });

        let totalsY = yPos + TOTALS_GAP;
        if (totalsY + HDR_H + 16 > PH - FOOT_H - 6) {
          doc.addPage({ size:'A4', layout:'landscape', margin:0 });
          yPos = drawHeader(false) + TABLE_TOP_GAP;
          doc.fillColor('#2c4a8c').fontSize(9).font(pdfFonts.bold)
            .text(`BULAN: ${monthLabelText} (ringkasan)`, MX, yPos, { width: CONTENT_W });
          yPos += 14;
          yPos = drawTableHeader(yPos);
          totalsY = yPos + TOTALS_GAP;
        }

        drawTotals(totalsY, monthTot);
        doc.fillColor('#444').fontSize(8.5).font(pdfFonts.regular)
          .text(
            `Jumlah Rekod Bulan ${mm}: ${monthData.length}   ·   Amaun (RM): ${fmtAmount(monthTot.bayaran)}   ·   Jumlah Bayaran (RM): ${fmtAmount(monthTot.jumlah_bayaran)}   ·   Baki Semasa (RM): ${fmtAmount(monthTot.baki)}`,
            MX,
            totalsY + HDR_H + 4,
            { width: CONTENT_W }
          );

        overallRecords += monthData.length;
        overallBayaran += monthTot.bayaran;
        overallJumlahAkhir = monthTot.jumlah_bayaran;
        overallBakiAkhir = monthTot.baki;
      });

      // ── Footer on every page ─────────────────────────────────────
      const pc = doc.bufferedPageRange().count;
      for (let p=0; p<pc; p++) {
        doc.switchToPage(p);
        const fy = PH - 18;
        doc.rect(0, fy-5, PW, 23).fill('#f0f2f8');
        doc.rect(0, fy-6, PW, 1).fill(NAVY);
        doc.fillColor('#666').fontSize(7).font(pdfFonts.regular);
        doc.text(`Dijana pada: ${new Date().toLocaleString('ms-MY')}   ·   Sistem Pengurusan Kewangan`, MX, fy, { width:CONTENT_W*0.7 });
        doc.text(`Halaman ${p+1} daripada ${pc}`, MX+CONTENT_W*0.7, fy, { width:CONTENT_W*0.3, align:'right' });
      }

      doc.flushPages();
      doc.end();
    } catch(e) {
      console.error('PDF penyata error:', e);
      if (!res.headersSent) res.status(500).json({ error:'PDF generation failed' });
    }
    };

    let kvSql = 'SELECT kod, keterangan, peruntukan, aktiviti, category FROM kepala_vot_list';
    let kvParams = [];
    if (buku_vot) {
      kvSql += ' WHERE SUBSTR(aktiviti, 1, LENGTH(?)) = ?';
      kvParams = [String(buku_vot), String(buku_vot)];
    } else if (category) {
      kvSql += ' WHERE LOWER(category) = LOWER(?)';
      kvParams = [category || ''];
    }
    kvSql += ' ORDER BY id DESC';

    db.all(
      kvSql,
      kvParams,
      (kvErr, kvRows) => {
        const kvMetaByKod = {};
        if (!kvErr && Array.isArray(kvRows)) {
          kvRows.forEach((kv) => {
            const kod = String(kv.kod || '').trim();
            if (!kod || kvMetaByKod[kod]) return;
            kvMetaByKod[kod] = {
              keterangan: String(kv.keterangan || '').trim(),
              peruntukan: parseFloat(kv.peruntukan) || 0
            };
          });
        }

        if (selectedKod) {
          const selectedMeta = kvMetaByKod[selectedKod] || { keterangan: '', peruntukan: 0 };
          const resolvedDesc = selectedMeta.keterangan || descFromQuery;
          const resolvedPeruntukan = selectedMeta.peruntukan || 0;
          runPdf(resolvedDesc, resolvedPeruntukan, kvMetaByKod);
          return;
        }

        runPdf(descFromQuery, 0, kvMetaByKod);
      }
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// PROFESSIONAL PENYATA EXCEL EXPORT
// GET /api/penyata/excel?category=perbekalan&month=01
// ══════════════════════════════════════════════════════════════════
app.get('/api/penyata/excel', requireAuth, async (req, res) => {
  const { month, category } = req.query;
  const monthNames = ['Januari','Februari','Mac','April','Mei','Juni','Julai','Ogos','September','Oktober','November','Disember'];

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM data ORDER BY category ASC, tarikh ASC, created_at ASC', [], (err, r) => {
        if (err) reject(err); else resolve(r||[]);
      });
    });

    let data = rows;
    if (category) data = data.filter(r => (r.category||'').toLowerCase() === category.toLowerCase());
    if (month) data = data.filter(r => {
      if (!r.tarikh) return false;
      return String(new Date(r.tarikh).getMonth()+1).padStart(2,'0') === month;
    });

    const ExcelJS  = require('exceljs');
    const fsLib    = require('fs');
    const catLabel   = category ? category.charAt(0).toUpperCase()+category.slice(1) : 'Semua Kategori';
    const monthLabel = month ? monthNames[parseInt(month)-1] : 'Semua Bulan';

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistem Pengurusan Kewangan VOT';
    wb.created = new Date();

    const ws = wb.addWorksheet(`Penyata ${catLabel}`, {
      pageSetup:{ paperSize:9, orientation:'landscape', fitToPage:true, fitToWidth:1,
                  margins:{ left:0.5, right:0.5, top:0.75, bottom:0.75, header:0.3, footer:0.3 } },
      properties:{ defaultRowHeight:16 }
    });

    // Column widths [A..J]
    ws.columns = [
      { key:'no',         width:6  },
      { key:'tarikh',     width:13 },
      { key:'rujukan',    width:14 },
      { key:'kepala',     width:15 },
      { key:'dibayar',    width:22 },
      { key:'perkara',    width:42 },
      { key:'kategori',   width:14 },
      { key:'bayaran',    width:16 },
      { key:'jumlah',     width:18 },
      { key:'baki',       width:15 },
    ];

    const NAVY  = 'FF1A3A6B';
    const WHITE = 'FFFFFFFF';
    const LBLUE = 'FFEEF2FF';
    const REP   = 'FFCC0000';

    const navyFill  = () => ({ type:'pattern', pattern:'solid', fgColor:{ argb:NAVY  } });
    const whiteFill = () => ({ type:'pattern', pattern:'solid', fgColor:{ argb:WHITE } });
    const lblueFill = () => ({ type:'pattern', pattern:'solid', fgColor:{ argb:LBLUE } });
    const hairLine  = () => ({ bottom:{ style:'hair', color:{ argb:'FFDDDDDD' } } });

    // ── Logo ─────────────────────────────────────────────────────
    const logoPath = path.join(__dirname,'public','images','logo-footer.png');
    if (fsLib.existsSync(logoPath)) {
      try {
        const imgId = wb.addImage({ filename:logoPath, extension:'png' });
        // Place logo in rows 1-6, columns A-B — larger and clear
        ws.addImage(imgId, { tl:{ col:0.08, row:0.08 }, ext:{ width:110, height:92 } });
      } catch(e) { console.error('Excel logo error:', e.message); }
    }

    // Row heights for header area — more breathing room
    ws.getRow(1).height = 10;  // top padding
    ws.getRow(2).height = 28;  // org name row
    ws.getRow(3).height = 8;   // gold accent spacer
    ws.getRow(4).height = 22;  // report title
    ws.getRow(5).height = 16;  // filter info
    ws.getRow(6).height = 16;  // print date
    ws.getRow(7).height = 10;  // bottom padding before headers

    // Org name — row 2, cols C-J
    ws.mergeCells('C2:J2');
    Object.assign(ws.getCell('C2'), {
      value:'SISTEM PENGURUSAN KEWANGAN VOT',
      font:{ name:'Calibri', bold:true, size:18, color:{ argb:NAVY } },
      alignment:{ horizontal:'left', vertical:'middle' }
    });

    // Gold accent row 3
    ws.mergeCells('C3:J3');
    ws.getCell('C3').fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFC8A951' } };

    // Report title — row 4
    ws.mergeCells('C4:J4');
    Object.assign(ws.getCell('C4'), {
      value:'PENYATA TRANSAKSI',
      font:{ name:'Calibri', bold:true, size:13, color:{ argb:'FF2C4A8C' } },
      alignment:{ horizontal:'left', vertical:'middle' }
    });

    // Filter info — row 5
    ws.mergeCells('C5:J5');
    Object.assign(ws.getCell('C5'), {
      value:`Kategori: ${catLabel}   |   Bulan: ${monthLabel}`,
      font:{ name:'Calibri', size:10, color:{ argb:'FF444444' } },
      alignment:{ horizontal:'left', vertical:'middle' }
    });

    // Print date — row 6
    ws.mergeCells('C6:J6');
    Object.assign(ws.getCell('C6'), {
      value:`Tarikh Cetak: ${new Date().toLocaleDateString('ms-MY')}`,
      font:{ name:'Calibri', size:9, italic:true, color:{ argb:'FF777777' } },
      alignment:{ horizontal:'left', vertical:'middle' }
    });

    // Navy separator before table header — row 7 cells
    for (let c = 1; c <= 10; c++) {
      ws.getCell(7, c).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:NAVY } };
    }

    // Column headers — row 8
    const headers = ['No.','Tarikh','Rujukan','Kepala VOT','Dibayar Kepada','Perkara','Kategori','Bayaran (RM)','J. Bayaran (RM)','Baki (RM)'];
    const hRow = ws.getRow(8);
    hRow.height = 24;
    headers.forEach((h, ci) => {
      const cell = hRow.getCell(ci+1);
      cell.value = h;
      cell.font = { name:'Calibri', bold:true, size:10, color:{ argb:WHITE } };
      cell.fill = navyFill();
      cell.alignment = { horizontal: ci>=7?'right':'center', vertical:'middle', wrapText:true };
    });

    // Data rows (start at row 9)
    let totalBayaran=0, totalJumlah=0;
    data.forEach((row, idx) => {
      const rn = 9 + idx;
      const dgRow = ws.getRow(rn);
      dgRow.height = 15;
      const isEven = idx%2===0;
      const vals = [
        idx+1, row.tarikh||'-', row.rujukan||'-', row.kepala_vot||'-',
        row.dibayar_kepada||'-', row.perkara||'-', row.category||'-',
        parseFloat(row.bayaran)||0, parseFloat(row.jumlah_bayaran)||0, parseFloat(row.baki)||0
      ];
      vals.forEach((val, ci) => {
        const cell = dgRow.getCell(ci+1);
        cell.value = val;
        cell.fill  = isEven ? lblueFill() : whiteFill();
        cell.alignment = { vertical:'middle', horizontal: ci>=7?'right': ci===0?'center':'left' };
        cell.border = hairLine();
        const isNum = ci>=7;
        const isNeg = ci===9 && typeof val==='number' && val<0;
        cell.font = { name:'Calibri', size:9, color:{ argb: isNeg?REP:'FF333333' } };
        if (isNum) cell.numFmt = '#,##0.00';
      });
      totalBayaran += parseFloat(row.bayaran)||0;
      totalJumlah  += parseFloat(row.jumlah_bayaran)||0;
    });

    const lastBaki = data.length>0 ? (parseFloat(data[data.length-1].baki)||0) : 0;

    // Totals row
    const totRn = 9 + data.length;
    const totRow = ws.getRow(totRn);
    totRow.height = 22;
    ['','','','','','JUMLAH KESELURUHAN','',totalBayaran,totalJumlah,lastBaki].forEach((val,ci)=>{
      const cell = totRow.getCell(ci+1);
      cell.value = val;
      cell.font  = { name:'Calibri', bold:true, size:10, color:{ argb:WHITE } };
      cell.fill  = navyFill();
      cell.alignment = { vertical:'middle', horizontal: ci>=7?'right': ci===5?'center':'left' };
      if (ci>=7) cell.numFmt = '#,##0.00';
    });

    // Summary
    const sumRn = totRn + 2;
    ws.mergeCells(`A${sumRn}:J${sumRn}`);
    ws.getRow(sumRn).height = 15;
    Object.assign(ws.getCell(`A${sumRn}`), {
      value:`Jumlah Rekod: ${data.length}   ·   Jumlah Bayaran: RM ${totalBayaran.toFixed(2)}   ·   Jumlah Keseluruhan: RM ${totalJumlah.toFixed(2)}`,
      font:{ name:'Calibri', size:9, italic:true, color:{ argb:'FF555555' } }
    });

    // Footer
    const footRn = sumRn + 2;
    ws.mergeCells(`A${footRn}:J${footRn}`);
    ws.getRow(footRn).height = 13;
    Object.assign(ws.getCell(`A${footRn}`), {
      value:`Dijana pada: ${new Date().toLocaleString('ms-MY')}   ·   Sistem Pengurusan Kewangan VOT`,
      font:{ name:'Calibri', size:8, italic:true, color:{ argb:'FF888888' } }
    });

    const filename = `Penyata_${catLabel}_${monthLabel}.xlsx`.replace(/ /g,'_');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();

  } catch(e) {
    console.error('Excel penyata error:', e);
    if (!res.headersSent) res.status(500).json({ error:'Excel generation failed' });
  }
});

// Start server
app.listen(PORT, () => {
  const dbPath = DB_FILE_PATH;
  const isPersistent = dbPath.startsWith('/var/data');
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database path: ${dbPath}`);
  console.log(`Session store: ${path.join(SESSION_DB_DIR, 'sessions.db')}`);
  console.log(`Persistent storage: ${isPersistent ? 'YES (/var/data disk mounted)' : 'NO (local - data will be lost on restart)'}`);

  if (BACKUP_ENABLED) {
    console.log(`Backup protection: ON (every ${BACKUP_INTERVAL_HOURS}h, keep ${BACKUP_RETENTION_COUNT}, dir ${BACKUP_DIR})`);

    setTimeout(() => {
      runSqliteBackup('startup').then((summary) => {
        console.log('Startup backup created:', summary.dbBackupFile);
      }).catch((err) => {
        console.error('Startup backup failed:', err.message);
      });
    }, 30000);

    setInterval(() => {
      runSqliteBackup('scheduled').then((summary) => {
        console.log('Scheduled backup created:', summary.dbBackupFile);
      }).catch((err) => {
        console.error('Scheduled backup failed:', err.message);
      });
    }, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
  } else {
    console.log('Backup protection: OFF');
  }
});