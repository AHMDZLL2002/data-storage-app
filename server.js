const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const db = require('./database');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Middleware to check authentication
const checkAuth = (req, res, next) => {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/');
  }
};

// Routes
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Login API
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
    if (err) {
      return res.json({ success: false, message: 'Database error' });
    }

    if (row) {
      req.session.userId = row.id;
      req.session.username = row.username;
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.json({ success: false, message: 'Invalid credentials' });
    }
  });
});

// Dashboard
app.get('/dashboard', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Data entry page
app.get('/data-entry', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'data-entry.html'));
});

// Admin management page (only for admin user)
app.get('/admin', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-management.html'));
});

// API: Get all data for user
app.get('/api/data', checkAuth, (req, res) => {
  db.all(`SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err) {
      return res.json({ success: false, message: 'Error fetching data' });
    }
    res.json({ success: true, data: rows });
  });
});

// API: Save data
app.post('/api/data', checkAuth, (req, res) => {
  const { category, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki } = req.body;

  if (!tarikh || !perkara) {
    return res.json({ success: false, message: 'Tarikh dan Perkara diperlukan' });
  }

  db.run(
    `INSERT INTO data (user_id, category, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.session.userId, category || 'Perbekalan', tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran || 0, jumlah_bayaran || 0, baki || 0],
    function(err) {
      if (err) {
        console.error(err);
        return res.json({ success: false, message: 'Error saving data' });
      }
      res.json({ success: true, message: 'Data saved successfully', id: this.lastID });
    }
  );
});

// API: Delete data
app.delete('/api/data/:id', checkAuth, (req, res) => {
  const { id } = req.params;

  db.run(
    `DELETE FROM data WHERE id = ? AND user_id = ?`,
    [id, req.session.userId],
    function(err) {
      if (err) {
        return res.json({ success: false, message: 'Error deleting data' });
      }
      if (this.changes === 0) {
        return res.json({ success: false, message: 'Data not found' });
      }
      res.json({ success: true, message: 'Data deleted successfully' });
    }
  );
});

// API: Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Server is running', timestamp: new Date().toISOString() });
});

// API: Get all notices (for all users including INBOX display) - Optimized
app.get('/api/notices', checkAuth, (req, res) => {
  // Add cache control headers
  res.set('Cache-Control', 'private, max-age=30'); // Cache for 30 seconds

  // First check if notices table exists
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='notices'`, [], (err, row) => {
    if (err || !row) {
      console.error('Notices table does not exist:', err);
      return res.json({ success: false, message: 'Database not initialized' });
    }

    // Try a simpler query first
    db.all(`SELECT * FROM notices ORDER BY created_at DESC LIMIT 100`, [], (err, rows) => {
      if (err) {
        console.error('Database error fetching notices:', err);
        return res.json({ success: false, message: 'Error fetching notices' });
      }

      // Add username to each notice
      const noticesWithUsernames = rows.map(notice => {
        return new Promise((resolve) => {
          db.get(`SELECT username FROM users WHERE id = ?`, [notice.created_by], (err, user) => {
            if (err || !user) {
              notice.username = 'Unknown';
            } else {
              notice.username = user.username;
            }
            resolve(notice);
          });
        });
      });

      Promise.all(noticesWithUsernames).then(notices => {
        res.json({ success: true, notices: notices });
      }).catch(err => {
        console.error('Error processing notices:', err);
        res.json({ success: false, message: 'Error processing notices' });
      });
    });
  });
});

// API: Create new notice (admin only)
app.post('/api/notices', checkAuth, (req, res) => {
  const { title, content, category } = req.body;

  console.log('Creating notice:', { title, content, category, userId: req.session.userId });

  if (!title || !content) {
    return res.json({ success: false, message: 'Title and content are required' });
  }

  // Check if user is admin (can be enhanced with role-based access)
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
    if (err || !user) {
      console.error('User not found:', err);
      return res.json({ success: false, message: 'User not found' });
    }

    console.log('User found:', user.username);

    db.run(
      `INSERT INTO notices (title, content, category, created_by) VALUES (?, ?, ?, ?)`,
      [title, content, category || 'Pengumuman', req.session.userId],
      function(err) {
        if (err) {
          console.error('Error creating notice:', err);
          return res.json({ success: false, message: 'Error creating notice' });
        }
        console.log('Notice created successfully, ID:', this.lastID);
        res.json({ success: true, message: 'Notice sent to all users', id: this.lastID });
      }
    );
  });
});

// API: Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.json({ success: false, message: 'Logout error' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Get current user info
app.get('/api/user', checkAuth, (req, res) => {
  res.json({ username: req.session.username });
});

// Export to PDF
app.get('/api/export/pdf', checkAuth, (req, res) => {
  const monthFilter = req.query.month;
  const categoryFilter = req.query.category;
  let query = `SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`;
  
  db.all(query, [req.session.userId], (err, rows) => {
    if (err || !rows) {
      return res.status(500).json({ success: false, message: 'Error exporting data' });
    }

    // Filter by month if provided
    if (monthFilter) {
      rows = rows.filter(row => {
        const date = new Date(row.tarikh);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return month === monthFilter;
      });
    }

    // Filter by category if provided
    if (categoryFilter && categoryFilter !== 'all') {
      rows = rows.filter(row => row.category === categoryFilter);
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="data-report.pdf"');

    doc.pipe(res);
    
    // Professional Header
    doc.rect(0, 0, doc.page.width, 100).fill('#667eea');
    
    // Logo/Title Area
    doc.fillColor('white').fontSize(24).font('Helvetica-Bold')
       .text('LOGO', 50, 30, { align: 'left' });
    
    doc.fillColor('white').fontSize(16).font('Helvetica')
       .text('Government Data Management System', 50, 60);
    
    // Report Title
    doc.fillColor('#333').fontSize(18).font('Helvetica-Bold')
       .text('Financial Data Report', 0, 120, { align: 'center' });
    
    // Report Info
    const currentDate = new Date().toLocaleDateString('ms-MY');
    const totalRecords = rows.length;
    doc.fillColor('#666').fontSize(10).font('Helvetica')
       .text(`Generated: ${currentDate} | Total Records: ${totalRecords}`, 0, 145, { align: 'center' });
    
    if (monthFilter) {
      const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 
                         'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Disember'];
      const monthIndex = parseInt(monthFilter) - 1;
      doc.text(`Month Filter: ${monthNames[monthIndex]}`, 0, 160, { align: 'center' });
    }
    
    doc.moveDown(2);

    // Table configuration with better spacing
    const columns = [
      { key: 'tarikh', label: 'Tarikh', width: 60 },
      { key: 'rujukan', label: 'Rujukan', width: 50 },
      { key: 'dibayar_kepada', label: 'Dibayar Kepada', width: 70 },
      { key: 'perkara', label: 'Perkara', width: 60 },
      { key: 'category', label: 'Kategori', width: 50 },
      { key: 'liabiliti', label: 'Liabiliti', width: 50 },
      { key: 'bayaran', label: 'Bayaran (RM)', width: 50 },
      { key: 'jumlah_bayaran', label: 'Jumlah (RM)', width: 50 },
      { key: 'baki', label: 'Baki (RM)', width: 45 }
    ];

    const startX = 50;
    let startY = doc.y;
    const rowHeight = 20;
    const cellPadding = 5;
    let currentY = startY;

    // Calculate total width
    const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);

    // Draw header with professional styling
    doc.fillColor('#667eea').rect(startX, currentY, totalWidth, rowHeight).fill();
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
    let xPos = startX;

    columns.forEach((col) => {
      doc.text(col.label, xPos + cellPadding, currentY + cellPadding, {
        width: col.width - cellPadding * 2,
        height: rowHeight - cellPadding * 2,
        align: 'center',
        valign: 'center'
      });
      xPos += col.width;
    });

    currentY += rowHeight;

    // Draw data rows with alternating colors
    doc.font('Helvetica').fontSize(7);
    let rowCount = 0;
    
    rows.forEach((row) => {
      // Check if we need a new page
      if (currentY + rowHeight > doc.page.height - 80) {
        // Add footer to current page
        addPageFooter(doc);
        doc.addPage();
        currentY = 50;
        
        // Redraw header on new page
        doc.fillColor('#667eea').rect(startX, currentY, totalWidth, rowHeight).fill();
        doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
        xPos = startX;
        columns.forEach((col) => {
          doc.text(col.label, xPos + cellPadding, currentY + cellPadding, {
            width: col.width - cellPadding * 2,
            height: rowHeight - cellPadding * 2,
            align: 'center',
            valign: 'center'
          });
          xPos += col.width;
        });
        currentY += rowHeight;
      }

      // Alternate row colors
      const fillColor = rowCount % 2 === 0 ? '#f9f9f9' : 'white';
      doc.fillColor(fillColor).rect(startX, currentY, totalWidth, rowHeight).fill();
      
      // Draw cell borders
      doc.strokeColor('#ddd').lineWidth(0.5);
      xPos = startX;
      columns.forEach((col) => {
        doc.rect(xPos, currentY, col.width, rowHeight).stroke();
        xPos += col.width;
      });

      // Fill data
      doc.fillColor('#333');
      xPos = startX;
      columns.forEach((col) => {
        let cellValue = row[col.key] || '-';
        if (col.key.includes('bayaran') || col.key === 'baki') {
          cellValue = cellValue !== '-' ? `RM ${parseFloat(cellValue).toFixed(2)}` : '-';
        }
        doc.text(cellValue, xPos + cellPadding, currentY + cellPadding, {
          width: col.width - cellPadding * 2,
          height: rowHeight - cellPadding * 2,
          align: col.key.includes('bayaran') || col.key === 'baki' ? 'right' : 'left',
          valign: 'center'
        });
        xPos += col.width;
      });

      currentY += rowHeight;
      rowCount++;
    });

    // Add summary section
    if (rows.length > 0) {
      currentY += 20;
      
      // Summary box
      doc.strokeColor('#667eea').lineWidth(1)
         .rect(startX, currentY, totalWidth, 60).stroke();
      
      doc.fillColor('#667eea').font('Helvetica-Bold').fontSize(10)
         .text('SUMMARY', startX + 10, currentY + 10);
      
      let totalBayaran = 0;
      let totalJumlahBayaran = 0;
      let totalBaki = 0;
      
      rows.forEach(row => {
        totalBayaran += parseFloat(row.bayaran) || 0;
        totalJumlahBayaran += parseFloat(row.jumlah_bayaran) || 0;
        totalBaki += parseFloat(row.baki) || 0;
      });
      
      doc.fillColor('#333').font('Helvetica').fontSize(8);
      doc.text(`Total Bayaran: RM ${totalBayaran.toFixed(2)}`, startX + 10, currentY + 25);
      doc.text(`Total Jumlah Bayaran: RM ${totalJumlahBayaran.toFixed(2)}`, startX + 200, currentY + 25);
      doc.text(`Total Baki: RM ${totalBaki.toFixed(2)}`, startX + 10, currentY + 40);
      doc.text(`Record Count: ${rows.length}`, startX + 200, currentY + 40);
    }

    // Add footer to last page
    addPageFooter(doc);
    
    doc.end();
  });
});

// Helper function to add page footer
function addPageFooter(doc) {
  const pageNumber = doc.pageNumber || 1;
  const totalPages = doc.bufferedPageRange().count || 1;
  
  doc.fillColor('#999').fontSize(8).font('Helvetica')
     .text(`Page ${pageNumber} of ${totalPages}`, 50, doc.page.height - 30, { align: 'center' });
  
  doc.text('Generated by Government Data Management System', 50, doc.page.height - 20, { align: 'center' });
}

// Export to Excel
app.get('/api/export/excel', checkAuth, (req, res) => {
  const monthFilter = req.query.month;
  const categoryFilter = req.query.category;
  
  db.all(`SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err || !rows) {
      return res.status(500).json({ success: false, message: 'Error exporting data' });
    }

    // Filter by month if provided
    if (monthFilter) {
      rows = rows.filter(row => {
        const date = new Date(row.tarikh);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return month === monthFilter;
      });
    }

    // Filter by category if provided
    if (categoryFilter && categoryFilter !== 'all') {
      rows = rows.filter(row => row.category === categoryFilter);
    }

    // Transform data with professional formatting
    const excelData = rows.map(row => ({
      'Tarikh': row.tarikh || '-',
      'Rujukan': row.rujukan || '-',
      'Dibayar Kepada': row.dibayar_kepada || '-',
      'Perkara': row.perkara || '-',
      'Kategori': row.category || '-',
      'Liabiliti': row.liabiliti || '-',
      'Bayaran (RM)': row.bayaran ? parseFloat(row.bayaran).toFixed(2) : '-',
      'Jumlah Bayaran (RM)': row.jumlah_bayaran ? parseFloat(row.jumlah_bayaran).toFixed(2) : '-',
      'Baki (RM)': row.baki ? parseFloat(row.baki).toFixed(2) : '-'
    }));

    const ws = XLSX.utils.json_to_sheet(excelData);
    
    // Set column widths for better readability
    const colWidths = [
      { wch: 12 }, // Tarikh
      { wch: 15 }, // Rujukan
      { wch: 20 }, // Dibayar Kepada
      { wch: 25 }, // Perkara
      { wch: 15 }, // Kategori
      { wch: 15 }, // Liabiliti
      { wch: 15 }, // Bayaran
      { wch: 18 }, // Jumlah Bayaran
      { wch: 12 }  // Baki
    ];
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    
    // Add a title sheet
    const titleData = [
      { 'A': 'LOGO - Government Data Management System' },
      { 'A': 'Financial Data Export Report' },
      { 'A': `Generated: ${new Date().toLocaleDateString('ms-MY')} ${new Date().toLocaleTimeString('ms-MY')}` },
      { 'A': `Total Records: ${rows.length}` },
      { 'A': monthFilter ? `Month Filter: ${new Date(2024, parseInt(monthFilter) - 1).toLocaleDateString('ms-MY', { month: 'long' })}` : 'All Months' },
      { 'A': '' },
      { 'A': 'Data Sheet: Click on "Data" tab below' }
    ];
    
    const titleWs = XLSX.utils.json_to_sheet(titleData, { header: ['A'], skipHeader: true });
    XLSX.utils.book_append_sheet(wb, titleWs, 'Report Info');
    
    XLSX.utils.book_append_sheet(wb, ws, 'Data');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="financial-report.xlsx"');
    XLSX.write(wb, { out: res, type: 'buffer' });
  });
});

// Export to CSV
app.get('/api/export/csv', checkAuth, (req, res) => {
  const monthFilter = req.query.month;
  const categoryFilter = req.query.category;
  
  db.all(`SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err || !rows) {
      return res.status(500).json({ success: false, message: 'Error exporting data' });
    }

    // Filter by month if provided
    if (monthFilter) {
      rows = rows.filter(row => {
        const date = new Date(row.tarikh);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return month === monthFilter;
      });
    }

    // Filter by category if provided
    if (categoryFilter && categoryFilter !== 'all') {
      rows = rows.filter(row => row.category === categoryFilter);
    }

    // Professional CSV header with category
    let csv = '# LOGO - Government Data Management System\n';
    csv += `# Financial Data Export Report\n`;
    csv += `# Generated: ${new Date().toLocaleDateString('ms-MY')} ${new Date().toLocaleTimeString('ms-MY')}\n`;
    csv += `# Total Records: ${rows.length}\n`;
    if (monthFilter) {
      csv += `# Month Filter: ${new Date(2024, parseInt(monthFilter) - 1).toLocaleDateString('ms-MY', { month: 'long' })}\n`;
    }
    csv += '\n';
    csv += 'Tarikh,Rujukan,Dibayar Kepada,Perkara,Kategori,Liabiliti,Bayaran (RM),Jumlah Bayaran (RM),Baki (RM)\n';
    
    rows.forEach(row => {
      csv += `"${row.tarikh || ''}","${row.rujukan || ''}","${row.dibayar_kepada || ''}","${row.perkara || ''}","${row.category || ''}","${row.liabiliti || ''}","${row.bayaran ? parseFloat(row.bayaran).toFixed(2) : ''}","${row.jumlah_bayaran ? parseFloat(row.jumlah_bayaran).toFixed(2) : ''}","${row.baki ? parseFloat(row.baki).toFixed(2) : ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="financial-report.csv"');
    res.send(csv);
  });
});

// Change password
app.post('/api/change-password', checkAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.json({ success: false, message: 'Password lama dan baru diperlukan' });
  }

  // Verify old password
  db.get(`SELECT * FROM users WHERE id = ? AND password = ?`, [req.session.userId, oldPassword], (err, row) => {
    if (err) {
      return res.json({ success: false, message: 'Database error' });
    }

    if (!row) {
      return res.json({ success: false, message: 'Password lama tidak tepat' });
    }

    // Update password
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [newPassword, req.session.userId], function(err) {
      if (err) {
        return res.json({ success: false, message: 'Error updating password' });
      }
      res.json({ success: true, message: 'Password berhasil diubah' });
    });
  });
});

// Register new user (admin only)
app.post('/api/register', checkAuth, (req, res) => {
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.userId], (err, adminUser) => {
    if (err || !adminUser || adminUser.username !== 'admin') {
      return res.json({ success: false, message: 'Unauthorized - Admin only' });
    }

    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({ success: false, message: 'Username dan password diperlukan' });
    }

    if (username.length < 3) {
      return res.json({ success: false, message: 'Username harus minimal 3 karakter' });
    }

    if (password.length < 5) {
      return res.json({ success: false, message: 'Password harus minimal 5 karakter' });
    }

    // Check if username exists
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, existingUser) => {
      if (err) {
        return res.json({ success: false, message: 'Database error' });
      }

      if (existingUser) {
        return res.json({ success: false, message: 'Username sudah ada' });
      }

      // Register new user
      db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) {
          return res.json({ success: false, message: 'Error registering user' });
        }
        res.json({ success: true, message: 'User baru berhasil didaftar', userId: this.lastID });
      });
    });
  });
});

// Get all users (admin only) - Optimized
app.get('/api/users', checkAuth, (req, res) => {
  // Add cache control headers
  res.set('Cache-Control', 'private, max-age=60'); // Cache for 1 minute

  db.get(`SELECT username FROM users WHERE id = ?`, [req.session.userId], (err, adminUser) => {
    if (err || !adminUser || adminUser.username !== 'admin') {
      return res.json({ success: false, message: 'Unauthorized - Admin only' });
    }

    db.all(`SELECT id, username, created_at FROM users ORDER BY created_at DESC LIMIT 100`, (err, rows) => {
      if (err) {
        console.error('Database error fetching users:', err);
        return res.json({ success: false, message: 'Error fetching users' });
      }
      res.json({ success: true, users: rows || [] });
    });
  });
});

// Delete user (admin only)
app.delete('/api/users/:id', checkAuth, (req, res) => {
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.userId], (err, adminUser) => {
    if (err || !adminUser || adminUser.username !== 'admin') {
      return res.json({ success: false, message: 'Unauthorized - Admin only' });
    }

    const userId = req.params.id;

    // Prevent deleting default admin
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, userToDelete) => {
      if (err || !userToDelete) {
        return res.json({ success: false, message: 'User not found' });
      }

      if (userToDelete.username === 'admin') {
        return res.json({ success: false, message: 'Cannot delete default admin user' });
      }

      // Delete user and their data
      db.run(`DELETE FROM data WHERE user_id = ?`, [userId], function(err) {
        if (err) {
          return res.json({ success: false, message: 'Error deleting user data' });
        }

        db.run(`DELETE FROM users WHERE id = ?`, [userId], function(err) {
          if (err) {
            return res.json({ success: false, message: 'Error deleting user' });
          }
          res.json({ success: true, message: 'User deleted successfully' });
        });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
