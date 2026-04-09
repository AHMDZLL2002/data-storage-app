const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: 'your-secret-key', // Change this in production
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
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
      res.json({ success: true, user: { id: user.id, username: user.username } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Get current user
app.get('/api/user', requireAuth, (req, res) => {
  console.log('/api/user called - session userId:', req.session.userId);
  res.json({ success: true, user: { id: req.session.userId, username: req.session.username } });
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
  const { category, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki } = req.body;
  const image = req.file ? '/uploads/' + req.file.filename : null;
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  // Normalize category to lowercase for consistent filtering across the app
  const categoryNormalized = category ? category.toString().toLowerCase() : 'perbekalan';

  db.run(`INSERT INTO data (user_id, category, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki, image)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
         [userId, categoryNormalized, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki, image],
         function(err) {
           if (err) {
             console.error('Database error inserting data:', err);
             return res.status(500).json({ error: 'Database error: ' + err.message });
           }
           res.json({ success: true, id: this.lastID });
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
  db.all('SELECT id, username, created_at FROM users ORDER BY id', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ data: rows });
  });
});

// Create new user (admin only)
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true, id: this.lastID });
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

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});