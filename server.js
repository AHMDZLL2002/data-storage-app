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
  const { tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki } = req.body;

  if (!tarikh || !perkara) {
    return res.json({ success: false, message: 'Tarikh dan Perkara diperlukan' });
  }

  db.run(
    `INSERT INTO data (user_id, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran, jumlah_bayaran, baki) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.session.userId, tarikh, rujukan, dibayar_kepada, perkara, liabiliti, bayaran || 0, jumlah_bayaran || 0, baki || 0],
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
  db.all(`SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err || !rows) {
      return res.status(500).json({ success: false, message: 'Error exporting data' });
    }

    const doc = new PDFDocument({ margin: 30, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="data-export.pdf"');

    doc.pipe(res);
    
    // Title
    doc.fontSize(16).font('Helvetica-Bold').text('Data Report', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleString('ms-MY')}`, { align: 'center' });
    doc.moveDown();

    // Table configuration
    const columns = [
      { key: 'tarikh', label: 'Tarikh', width: 50 },
      { key: 'rujukan', label: 'Rujukan', width: 45 },
      { key: 'dibayar_kepada', label: 'Dibayar Kepada', width: 55 },
      { key: 'perkara', label: 'Perkara', width: 50 },
      { key: 'liabiliti', label: 'Liabiliti', width: 45 },
      { key: 'bayaran', label: 'Bayaran', width: 40 },
      { key: 'jumlah_bayaran', label: 'Jumlah', width: 40 },
      { key: 'baki', label: 'Baki', width: 40 }
    ];

    const startX = 30;
    const startY = doc.y;
    const rowHeight = 25;
    const cellPadding = 4;
    let currentY = startY;

    // Calculate total width
    const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);

    // Draw header
    doc.font('Helvetica-Bold').fontSize(8);
    let xPos = startX;

    // Draw header boxes
    columns.forEach((col) => {
      doc.rect(xPos, currentY, col.width, rowHeight).stroke();
      doc.text(col.label, xPos + cellPadding, currentY + cellPadding, {
        width: col.width - cellPadding * 2,
        height: rowHeight - cellPadding * 2,
        align: 'left',
        valign: 'top'
      });
      xPos += col.width;
    });

    currentY += rowHeight;

    // Draw data rows
    doc.font('Helvetica').fontSize(7);
    rows.forEach((row) => {
      // Check if we need a new page
      if (currentY + rowHeight > doc.page.height - 30) {
        doc.addPage();
        currentY = 30;
      }

      xPos = startX;
      columns.forEach((col) => {
        const value = String(row[col.key] || '-').substring(0, 20);
        doc.rect(xPos, currentY, col.width, rowHeight).stroke();
        doc.text(value, xPos + cellPadding, currentY + cellPadding, {
          width: col.width - cellPadding * 2,
          height: rowHeight - cellPadding * 2,
          align: 'left',
          valign: 'top'
        });
        xPos += col.width;
      });
      currentY += rowHeight;
    });

    // Add footer
    doc.fontSize(8).text(`Total Records: ${rows.length}`, startX, doc.page.height - 20);

    doc.end();
  });
});

// Export to Excel
app.get('/api/export/excel', checkAuth, (req, res) => {
  db.all(`SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err || !rows) {
      return res.status(500).json({ success: false, message: 'Error exporting data' });
    }

    // Transform data
    const excelData = rows.map(row => ({
      'Tarikh': row.tarikh || '-',
      'Rujukan': row.rujukan || '-',
      'Dibayar Kepada': row.dibayar_kepada || '-',
      'Perkara': row.perkara || '-',
      'Liabiliti': row.liabiliti || '-',
      'Bayaran': row.bayaran || '-',
      'Jumlah Bayaran': row.jumlah_bayaran || '-',
      'Baki': row.baki || '-'
    }));

    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="data-export.xlsx"');
    XLSX.write(wb, { out: res, type: 'buffer' });
  });
});

// Export to CSV
app.get('/api/export/csv', checkAuth, (req, res) => {
  db.all(`SELECT * FROM data WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
    if (err || !rows) {
      return res.status(500).json({ success: false, message: 'Error exporting data' });
    }

    let csv = 'Tarikh,Rujukan,Dibayar Kepada,Perkara,Liabiliti,Bayaran,Jumlah Bayaran,Baki\n';
    rows.forEach(row => {
      csv += `"${row.tarikh || ''}","${row.rujukan || ''}","${row.dibayar_kepada || ''}","${row.perkara || ''}","${row.liabiliti || ''}","${row.bayaran || ''}","${row.jumlah_bayaran || ''}","${row.baki || ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="data-export.csv"');
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

// Get all users (admin only)
app.get('/api/users', checkAuth, (req, res) => {
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.userId], (err, adminUser) => {
    if (err || !adminUser || adminUser.username !== 'admin') {
      return res.json({ success: false, message: 'Unauthorized - Admin only' });
    }

    db.all(`SELECT id, username, created_at FROM users ORDER BY created_at DESC`, (err, rows) => {
      if (err) {
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
