# Deployment Guide - Data Storage Application

Aplikasi ini sudah siap untuk di-deploy ke berbagai platform hosting free.

## Opsi Deployment Terbaik

### 1. **Render.com** (Rekomendasi - Mudah & Gratis)

**Keuntungan:**
- Free tier tersedia
- Custom subdomain gratis
- Auto-deploy dari GitHub
- Support Node.js dengan SQLite

**Langkah-langkah:**

1. **Push ke GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/USERNAME/REPONAME.git
   git branch -M main
   git push -u origin main
   ```

2. **Deploy di Render**
   - Kunjungi: https://render.com
   - Click "New +" → "Web Service"
   - Pilih "Connect to GitHub"
   - Pilih repository `data-storage-app`
   - Fill the form:
     - **Name**: data-storage-app
     - **Branch**: main
     - **Build Command**: npm install
     - **Start Command**: npm start
     - **Plan**: Free
   - Click "Deploy"

3. **Database Setup**
   - Database akan otomatis dibuat saat aplikasi pertama kali start
   - Default admin sudah setup: `admin / password123`

**URL akan didapat dari Render (e.g., `https://data-storage-app.onrender.com`)**

---

### 2. **Railway.app** (Alternatif)

**Keuntungan:**
- Free tier dengan $5/month credit
- Sangat mudah setup
- Support Node.js & SQLite

**Langkah-langkah:**

1. Push ke GitHub (sama seperti di atas)

2. **Deploy di Railway**
   - Kunjungi: https://railway.app
   - Click "New Project"
   - Pilih "Deploy from GitHub"
   - Connect GitHub account
   - Pilih repository ini
   - Railway akan otomatis detect Node.js
   - Project akan auto-deploy

3. Dapatkan domain dari Railway Project Settings

---

### 3. **Replit.com** (Gratis, Simple)

**Langkah-langkah:**

1. Kunjungi: https://replit.com
2. Click "Create Repl" → "Import from GitHub"
3. Paste URL repository ini
4. Click "Import"
5. Replit akan detect dan setup otomatis
6. Click "Run" untuk start aplikasi

---

## Setup Lokal untuk Development

```bash
# Install dependencies
npm install

# Start development server
npm start

# Server akan berjalan di http://localhost:3000
```

## Default Credentials

```
Username: admin
Password: password123
```

## Features

✅ User Authentication (Login System)
✅ Dashboard dengan Multiple Options
✅ Data Entry & Management
✅ Export to PDF, Excel, CSV
✅ Admin Panel - Register Pentadbir Baru
✅ Change Password Feature
✅ Professional UI dengan Header & Footer

## Important Notes

### Untuk Production:

1. **Change Default Password**
   - Login dengan admin / password123
   - Klik "Change Password" di dashboard

2. **Environment Variables** (Optional)
   - Create `.env` file jika perlu custom config
   - Contoh:
     ```
     NODE_ENV=production
     PORT=3000
     ```

3. **Database**
   - SQLite database (`app.db`) akan dibuat otomatis
   - Disimpan di root folder aplikasi
   - Jika menggunakan hosting, database akan persistent di cloud storage

## Troubleshooting

**Error: Database locked**
- Restart aplikasi. Ini normal pada free tier hosting.

**Error: npm install fails**
- Pastikan Node.js version kompatibel (v14+)
- Clear npm cache: `npm cache clean --force`

**Application not starting**
- Check logs di hosting platform
- Pastikan port 3000 available
- Verify semua dependencies di package.json sudah install

## Support

Untuk informasi lebih lanjut:
- Check [README.md](README.md) untuk dokumentasi aplikasi
- Lihat `.github/copilot-instructions.md` untuk project setup details

---

**Happy Deploying! 🚀**
