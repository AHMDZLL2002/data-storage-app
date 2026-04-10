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

// Trust Render's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Sessions stored in SQLite so they survive server restarts
const SESSION_DB_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : __dirname;

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
const UPLOADS_DIR = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), 'uploads')
  : path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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
      db.run('INSERT INTO login_logs (user_id, action, ip_address) VALUES (?, ?, ?)', [user.id, 'login', ip]);
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
      db.run('INSERT INTO login_logs (user_id, action, ip_address) VALUES (?, ?, ?)', [userId, 'logout', ip]);
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
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'app.db');
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
    warning: !isPersistent ? 'DB_PATH env var not set to /var/data/app.db - disk not mounted!' : null
  });
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
  const { category, tarikh, rujukan, dibayar_kepada, kepala_vot, perkara, liabiliti, bayaran } = req.body;
  const image = req.file ? '/uploads/' + req.file.filename : null;
  const userId = req.session.userId;

  if (!userId) return res.status(401).json({ error: 'User not authenticated' });

  const categoryNormalized = category ? category.toString().toLowerCase() : 'perbekalan';
  const bayaranAmount = parseFloat(bayaran) || 0;

  // Compute running jumlah_bayaran and baki from category budget
  db.get('SELECT COALESCE(SUM(bayaran), 0) as total FROM data WHERE LOWER(category) = ?',
    [categoryNormalized], (err, row) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      const prevTotal = parseFloat(row.total) || 0;
      const jumlah_bayaran = prevTotal + bayaranAmount;

      db.get('SELECT peruntukan FROM category_budgets WHERE category = ?',
        [categoryNormalized], (err2, budget) => {
          const peruntukan = budget ? parseFloat(budget.peruntukan) || 0 : 0;
          const baki = peruntukan - jumlah_bayaran;

          db.run(`INSERT INTO data (user_id, category, tarikh, rujukan, dibayar_kepada, kepala_vot, perkara, liabiliti, bayaran, jumlah_bayaran, baki, image)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, categoryNormalized, tarikh, rujukan, dibayar_kepada, kepala_vot, perkara, liabiliti, bayaranAmount, jumlah_bayaran, baki, image],
            function(insertErr) {
              if (insertErr) {
                console.error('Database error inserting data:', insertErr);
                return res.status(500).json({ error: 'Database error: ' + insertErr.message });
              }
              res.json({ success: true, id: this.lastID, jumlah_bayaran, baki });
            });
        });
    });
});

// Delete data entry
app.delete('/api/data/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM data WHERE id = ? AND user_id = ?', [id, req.session.userId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Data not found' });
    }
    res.json({ success: true });
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
  db.all('SELECT id, username, nama, no_pekerja, jawatan, jabatan, telefon, profile_pic, created_at FROM users ORDER BY id', (err, rows) => {
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

// ── Kepala VOT List API ─────────────────────────────────────────
// Get kepala vot options, optional ?category= filter
app.get('/api/kepala-vot', requireAuth, (req, res) => {
  const { category } = req.query;
  const sql = category
    ? 'SELECT * FROM kepala_vot_list WHERE LOWER(category) = LOWER(?) ORDER BY kod ASC'
    : 'SELECT * FROM kepala_vot_list ORDER BY category ASC, kod ASC';
  const params = category ? [category] : [];
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, data: rows || [] });
  });
});

// Add kepala vot option (admin only)
app.post('/api/kepala-vot', requireAdmin, (req, res) => {
  const { kod, keterangan, category } = req.body;
  if (!kod) return res.status(400).json({ error: 'Kod diperlukan' });
  if (!category) return res.status(400).json({ error: 'Kategori diperlukan' });
  db.run('INSERT INTO kepala_vot_list (kod, keterangan, category) VALUES (?, ?, ?)', [kod.trim(), keterangan || '', category.toLowerCase()], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, id: this.lastID });
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
    doc.fontSize(18).font('Helvetica-Bold').text('LAPORAN DATA TRANSAKSI', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Data Storage System', { align: 'center' });
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
    
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#FFFFFF');
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
    doc.font('Helvetica');
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
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10);
    
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
  const { month, category } = req.query;
  const monthNames = ['Januari','Februari','Mac','April','Mei','Juni','Julai','Ogos','September','Oktober','November','Disember'];

  db.all('SELECT * FROM data ORDER BY category ASC, tarikh ASC, created_at ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    let data = rows || [];
    if (category) data = data.filter(r => (r.category||'').toLowerCase() === category.toLowerCase());
    if (month) data = data.filter(r => {
      if (!r.tarikh) return false;
      return String(new Date(r.tarikh).getMonth() + 1).padStart(2,'0') === month;
    });

    try {
      const PDFDocument = require('pdfkit');
      const fsLib = require('fs');
      const catLabel   = category ? category.charAt(0).toUpperCase()+category.slice(1) : 'Semua Kategori';
      const monthLabel = month ? monthNames[parseInt(month)-1] : 'Semua Bulan';

      const doc = new PDFDocument({ size:'A4', layout:'landscape', margin:0, bufferPages:true });
      const filename = `Penyata_${catLabel}_${monthLabel}.pdf`.replace(/ /g,'_');
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
      doc.pipe(res);

      const PW = doc.page.width;   // ≈ 842
      const PH = doc.page.height;  // ≈ 595
      const MX = 28;
      const CONTENT_W = PW - MX * 2;
      const NAVY = '#1a3a6b';
      const LIGHT = '#eef2ff';

      // columns (total ≈ 784 fits in CONTENT_W 786)
      const cols = [
        { h:'No.',            w:22,  a:'center', k:null              },
        { h:'Tarikh',         w:62,  a:'left',   k:'tarikh'          },
        { h:'Rujukan',        w:60,  a:'left',   k:'rujukan'         },
        { h:'Kepala VOT',     w:68,  a:'left',   k:'kepala_vot'      },
        { h:'Dibayar Kepada', w:100, a:'left',   k:'dibayar_kepada'  },
        { h:'Perkara',        w:168, a:'left',   k:'perkara'         },
        { h:'Kategori',       w:62,  a:'left',   k:'category'        },
        { h:'Bayaran (RM)',   w:66,  a:'right',  k:'bayaran'         },
        { h:'J. Bayaran',     w:70,  a:'right',  k:'jumlah_bayaran'  },
        { h:'Baki (RM)',      w:66,  a:'right',  k:'baki'            },
      ];
      const ROW_H = 17;
      const HDR_H = 22;
      const FOOT_H = 20;

      const HEADER_H = 88;  // taller header for clarity
      const LINE1_Y  = 10;
      const LOGO_SIZE = 65;

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
          doc.fillColor(NAVY).fontSize(16).font('Helvetica-Bold')
             .text('SISTEM PENGURUSAN KEWANGAN VOT', textX, 13, { width:textW });
          // Thin underline
          doc.rect(textX, 32, textW * 0.65, 1).fill('#c8a951');
          // Report subtitle
          doc.fillColor('#2c4a8c').fontSize(11).font('Helvetica-Bold')
             .text('PENYATA TRANSAKSI', textX, 37, { width:textW });
          // Details line
          doc.fillColor('#555').fontSize(8.5).font('Helvetica')
             .text(`Kategori: ${catLabel}`, textX, 54, { width:textW });
          doc.fillColor('#555').fontSize(8.5)
             .text(`Bulan: ${monthLabel}`, textX, 65, { width:textW });
          // Print date — right aligned
          doc.fillColor('#888').fontSize(7.5)
             .text(`Tarikh Cetak: ${new Date().toLocaleDateString('ms-MY')}`, MX, HEADER_H - 18, { width:CONTENT_W, align:'right' });
        } else {
          doc.fillColor(NAVY).fontSize(13).font('Helvetica-Bold')
             .text('PENYATA TRANSAKSI', textX, 18, { width:textW });
          doc.fillColor('#555').fontSize(8.5).font('Helvetica')
             .text(`Kategori: ${catLabel}   ·   Bulan: ${monthLabel}   ·   (sambungan)`, textX, 40, { width:textW });
          doc.fillColor('#888').fontSize(7.5)
             .text(`Tarikh Cetak: ${new Date().toLocaleDateString('ms-MY')}`, MX, HEADER_H - 18, { width:CONTENT_W, align:'right' });
        }
        return HEADER_H;
      }

      function drawTableHeader(y) {
        doc.rect(MX, y, CONTENT_W, HDR_H).fill(NAVY);
        doc.fillColor('#fff').fontSize(7.5).font('Helvetica-Bold');
        let x = MX;
        cols.forEach(c => {
          doc.text(c.h, x+3, y+(HDR_H-7.5)/2+1, { width:c.w-6, align:c.a });
          x += c.w;
        });
        return y + HDR_H;
      }

      function drawRow(row, y, rowNum, even) {
        doc.rect(MX, y, CONTENT_W, ROW_H).fill(even ? LIGHT : '#fff');
        doc.rect(MX, y+ROW_H-0.5, CONTENT_W, 0.5).fill('#dde0f0');
        doc.fillColor('#333').fontSize(7).font('Helvetica');
        let x = MX;
        cols.forEach(c => {
          let val;
          if (!c.k) {
            val = String(rowNum);
          } else if (['bayaran','jumlah_bayaran','baki'].includes(c.k)) {
            const n = parseFloat(row[c.k]||0);
            val = n.toFixed(2);
            doc.fillColor(c.k==='baki' && n<0 ? '#c0392b' : '#333');
          } else {
            const raw = (row[c.k]||'-').toString();
            const limit = c.k==='perkara' ? 48 : c.k==='dibayar_kepada' ? 22 : 20;
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
        doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
        let x = MX;
        cols.forEach((c,ci) => {
          let val = '';
          if (ci===5) val='JUMLAH KESELURUHAN';
          if (ci===7) val=tot.bayaran.toFixed(2);
          if (ci===8) val=tot.jumlah.toFixed(2);
          if (ci===9) val=tot.baki.toFixed(2);
          doc.text(val, x+3, y+(HDR_H-8)/2+1, { width:c.w-6, align:c.a });
          x += c.w;
        });
        return y + HDR_H;
      }

      // ── Render ───────────────────────────────────────────────────
      let yPos = drawHeader(true);
      yPos = drawTableHeader(yPos);
      const tot = { bayaran:0, jumlah:0, baki:0 };

      data.forEach((row, idx) => {
        if (yPos + ROW_H > PH - FOOT_H - HDR_H) {
          doc.addPage({ size:'A4', layout:'landscape', margin:0 });
          yPos = drawHeader(false);
          yPos = drawTableHeader(yPos);
        }
        yPos = drawRow(row, yPos, idx+1, idx%2===0);
        tot.bayaran += parseFloat(row.bayaran)||0;
        tot.jumlah  += parseFloat(row.jumlah_bayaran)||0;
      });
      tot.baki = data.length>0 ? (parseFloat(data[data.length-1].baki)||0) : 0;

      if (yPos + HDR_H > PH - FOOT_H) {
        doc.addPage({ size:'A4', layout:'landscape', margin:0 });
        yPos = 50;
      }
      yPos = drawTotals(yPos, tot);

      // Summary
      if (yPos + 14 < PH - FOOT_H) {
        doc.fillColor('#444').fontSize(8.5).font('Helvetica')
           .text(`Jumlah Rekod: ${data.length}   ·   Jumlah Bayaran: RM ${tot.bayaran.toFixed(2)}   ·   Jumlah Keseluruhan: RM ${tot.jumlah.toFixed(2)}`, MX, yPos+6, { width:CONTENT_W });
      }

      // ── Footer on every page ─────────────────────────────────────
      const pc = doc.bufferedPageRange().count;
      for (let p=0; p<pc; p++) {
        doc.switchToPage(p);
        const fy = PH - 18;
        doc.rect(0, fy-5, PW, 23).fill('#f0f2f8');
        doc.rect(0, fy-6, PW, 1).fill(NAVY);
        doc.fillColor('#666').fontSize(7).font('Helvetica');
        doc.text(`Dijana pada: ${new Date().toLocaleString('ms-MY')}   ·   Sistem Pengurusan Kewangan VOT`, MX, fy, { width:CONTENT_W*0.7 });
        doc.text(`Halaman ${p+1} daripada ${pc}`, MX+CONTENT_W*0.7, fy, { width:CONTENT_W*0.3, align:'right' });
      }

      doc.flushPages();
      doc.end();
    } catch(e) {
      console.error('PDF penyata error:', e);
      if (!res.headersSent) res.status(500).json({ error:'PDF generation failed' });
    }
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
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'app.db');
  const isPersistent = dbPath.startsWith('/var/data');
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database path: ${dbPath}`);
  console.log(`Session store: ${path.join(SESSION_DB_DIR, 'sessions.db')}`);
  console.log(`Persistent storage: ${isPersistent ? 'YES (/var/data disk mounted)' : 'NO (local - data will be lost on restart)'}`);
});