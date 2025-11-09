const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const cron = require('node-cron');
const app = express();

const PORT = process.env.PORT || 3002;
const DATA_FILE = path.join(__dirname, 'pelanggan.json');
const USER_FILE = path.join(__dirname, 'user.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware
app.use(session({
  secret: 'rtrwnet-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

// Hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Function untuk hitung jatuh tempo (bulan depan)
function hitungJatuhTempo() {
  const now = new Date();
  const jatuhTempo = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return jatuhTempo.toISOString();
}

// Fungsi untuk menambah 1 bulan ke tanggal jatuh tempo (ROBUST VERSION)
function tambah1BulanJatuhTempo(jatuhTempoLama) {
  if (!jatuhTempoLama) {
    // Jika tidak ada jatuh tempo lama, gunakan default
    return hitungJatuhTempo();
  }
  
  try {
    let year, month, day;
    
    // Handle format YYYY-MM-DD
    if (typeof jatuhTempoLama === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(jatuhTempoLama)) {
      const parts = jatuhTempoLama.split('-');
      year = parseInt(parts[0]);
      month = parseInt(parts[1]) - 1; // Month is 0-indexed
      day = parseInt(parts[2]);
    } 
    // Handle ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)
    else if (typeof jatuhTempoLama === 'string' && jatuhTempoLama.includes('T')) {
      const date = new Date(jatuhTempoLama);
      if (isNaN(date.getTime())) {
        console.warn('Invalid ISO date format:', jatuhTempoLama);
        return hitungJatuhTempo();
      }
      year = date.getUTCFullYear();
      month = date.getUTCMonth();
      day = date.getUTCDate();
    }
    // Fallback: try to parse as Date
    else {
      const date = new Date(jatuhTempoLama);
      if (isNaN(date.getTime())) {
        console.warn('Invalid date format:', jatuhTempoLama);
        return hitungJatuhTempo();
      }
      year = date.getFullYear();
      month = date.getMonth();
      day = date.getDate();
    }
    
    // Create date object and add 1 month
    const newDate = new Date(year, month + 1, day);
    
    // CRITICAL FIX: Handle edge case for dates 29-31
    // If day overflows (e.g., Jan 31 → Feb 31 becomes Mar 3), use last day of target month
    if (newDate.getDate() !== day) {
      // Overflow detected! Use last day of target month instead
      // Set to day 0 of NEXT month = last day of current month
      newDate.setDate(0);
      console.log(`📅 Date overflow fixed: ${year}-${month+1}-${day} → ${newDate.getFullYear()}-${newDate.getMonth()+1}-${newDate.getDate()} (last day of month)`);
    }
    
    // Validate result
    if (isNaN(newDate.getTime())) {
      console.warn('Invalid date calculation for:', jatuhTempoLama);
      return hitungJatuhTempo();
    }
    
    // Return in YYYY-MM-DD format (same as manual input)
    const resultYear = newDate.getFullYear();
    const resultMonth = String(newDate.getMonth() + 1).padStart(2, '0');
    const resultDay = String(newDate.getDate()).padStart(2, '0');
    
    return `${resultYear}-${resultMonth}-${resultDay}`;
  } catch (error) {
    console.error('Error in tambah1BulanJatuhTempo:', error, 'for date:', jatuhTempoLama);
    return hitungJatuhTempo();
  }
}

// ===== FITUR BARU: MULTI-MONTH DATA STORAGE =====

// Fungsi untuk mendapatkan bulan saat ini dalam format YYYY-MM
function getBulanSekarang() {
  const now = new Date();
  return now.toISOString().slice(0, 7); // YYYY-MM
}

// Fungsi untuk mendapatkan bulan sebelumnya dari bulan target
function getBulanSebelumnya(bulanTarget) {
  // Parse YYYY-MM
  const [year, month] = bulanTarget.split('-').map(Number);
  
  // Calculate previous month
  let prevMonth = month - 1;
  let prevYear = year;
  
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear = year - 1;
  }
  
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

// Fungsi untuk read settings
async function readSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    // Jika file tidak ada, buat default
    const defaultSettings = {
      lastResetMonth: getBulanSekarang(),
      lastResetDate: new Date().toISOString()
    };
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
    return defaultSettings;
  }
}

// Fungsi untuk update settings
async function updateSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Fungsi untuk reset bulanan - HANYA untuk auto-reset tanggal 1
async function resetBulanan(bulanBaru) {
  try {
    console.log('🔄 Memulai reset bulanan...');
    
    const data = await readData();
    const targetBulan = bulanBaru || getBulanSekarang();
    
    // Pastikan struktur data per bulan ada
    if (!data.dataPerBulan) {
      data.dataPerBulan = {};
    }
    
    // CRITICAL FIX: Calculate bulan sebelumnya from targetBulan
    const bulanSebelumnya = getBulanSebelumnya(targetBulan);
    
    console.log(`📅 Target bulan: ${targetBulan}`);
    console.log(`📅 Source bulan: ${bulanSebelumnya}`);
    
    // Check if source month data exists
    if (!data.dataPerBulan[bulanSebelumnya]) {
      console.error(`❌ Data bulan ${bulanSebelumnya} tidak ditemukan!`);
      return { success: false, error: `Data bulan ${bulanSebelumnya} tidak ditemukan` };
    }
    
    const pelangganBulanLalu = data.dataPerBulan[bulanSebelumnya];
    console.log(`🔍 Found source from previous month: ${bulanSebelumnya} (${pelangganBulanLalu.length} clients)`);
    
    // Copy dan reset untuk bulan baru
    const pelangganBulanBaru = pelangganBulanLalu.map(pelanggan => ({
      ...pelanggan,
      status: 'Belum Lunas',
      bulan: targetBulan,
      // CRITICAL FIX: Copy jatuh tempo dari bulan lalu + 1 bulan (bukan default!)
      jatuhTempo: tambah1BulanJatuhTempo(pelanggan.jatuhTempo),
      tanggalBayar: null,
      lastResetDate: new Date().toISOString()
    }));
    
    console.log(`✅ Copied ${pelangganBulanBaru.length} clients from ${bulanSebelumnya} to ${targetBulan} (excluded 0 auto-created entries)`);
    
    // Simpan data bulan baru
    data.dataPerBulan[targetBulan] = pelangganBulanBaru;
    data.currentBulan = targetBulan;
    data.pelanggan = pelangganBulanBaru; // Backward compatibility
    
    // Simpan data
    await writeData(data);
    
    // Update settings
    const settings = await readSettings();
    settings.lastResetMonth = targetBulan;
    settings.lastResetDate = new Date().toISOString();
    await updateSettings(settings);
    
    console.log(`✅ Reset bulanan selesai! ${pelangganBulanBaru.length} pelanggan direset ke Belum Lunas`);
    console.log(`📅 Bulan baru: ${targetBulan}`);
    
    return { success: true, countReset: pelangganBulanBaru.length, bulanBaru: targetBulan };
  } catch (error) {
    console.error('❌ Error saat reset bulanan:', error);
    return { success: false, error: error.message };
  }
}

// Fungsi untuk check apakah perlu reset (hanya untuk auto-reset tanggal 1)
async function checkDanResetJikaPerlu() {
  try {
    const settings = await readSettings();
    const bulanSekarang = getBulanSekarang();
    
    // Jika bulan sekarang berbeda dengan bulan terakhir reset
    if (settings.lastResetMonth !== bulanSekarang) {
      console.log('⚠️ Terdeteksi pergantian bulan! Melakukan reset otomatis...');
      await resetBulanan();
    }
  } catch (error) {
    console.error('Error saat check reset:', error);
  }
}

// CRON JOB: Jalankan setiap hari jam 00:01
cron.schedule('1 0 * * *', async () => {
  console.log('⏰ Cron job berjalan - Check reset bulanan...');
  await checkDanResetJikaPerlu();
});

// Cron job tambahan: setiap tanggal 1 jam 00:01 (backup)
cron.schedule('1 0 1 * *', async () => {
  console.log('⏰ Cron job tanggal 1 - Force reset bulanan...');
  await resetBulanan();
});

// ===== END FITUR BARU =====

// Check if user exists
async function userExists() {
  try {
    await fs.access(USER_FILE);
    const data = await fs.readFile(USER_FILE, 'utf-8');
    const user = JSON.parse(data);
    return user.username && user.password;
  } catch {
    return false;
  }
}

// Get user
async function getUser() {
  try {
    const data = await fs.readFile(USER_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Save user
async function saveUser(username, password) {
  const hashedPassword = hashPassword(password);
  const userData = {
    username,
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(USER_FILE, JSON.stringify(userData, null, 2));
}

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.isLoggedIn) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Routes
app.get('/', async (req, res) => {
  const exists = await userExists();
  if (!exists) {
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  } else if (req.session && req.session.isLoggedIn) {
    res.redirect('/dashboard.html');
  } else {
    res.redirect('/login.html');
  }
});

app.get('/setup.html', async (req, res) => {
  const exists = await userExists();
  if (exists) {
    res.redirect('/login.html');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  }
});

app.get('/login.html', async (req, res) => {
  const exists = await userExists();
  if (!exists) {
    res.redirect('/setup.html');
  } else if (req.session && req.session.isLoggedIn) {
    res.redirect('/dashboard.html');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.get('/dashboard.html', async (req, res) => {
  const exists = await userExists();
  if (!exists) {
    res.redirect('/setup.html');
  } else if (req.session && req.session.isLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  } else {
    res.redirect('/login.html');
  }
});

app.use(express.static('public'));

// Initialize data file
async function initDataFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    const initialData = {
      currentBulan: getBulanSekarang(),
      pelanggan: [],
      dataPerBulan: {}
    };
    initialData.dataPerBulan[initialData.currentBulan] = [];
    await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
  }
}

// Read data
async function readData() {
  const data = await fs.readFile(DATA_FILE, 'utf-8');
  const parsed = JSON.parse(data);
  
  // Ensure dataPerBulan structure exists
  if (!parsed.dataPerBulan) {
    parsed.dataPerBulan = {};
    const currentBulan = parsed.currentBulan || getBulanSekarang();
    parsed.dataPerBulan[currentBulan] = parsed.pelanggan || [];
  }
  
  return parsed;
}

// Write data
async function writeData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// Get data for specific month
function getDataForBulan(data, bulan) {
  if (data.dataPerBulan && data.dataPerBulan[bulan]) {
    return data.dataPerBulan[bulan];
  }
  
  // If no data for this month, create empty array or copy from current
  return [];
}

// API: Setup user
app.post('/api/setup', async (req, res) => {
  try {
    const exists = await userExists();
    if (exists) {
      return res.status(400).json({ error: 'User sudah ada' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password harus diisi' });
    }

    await saveUser(username, password);
    req.session.isLoggedIn = true;
    req.session.username = username;
    
    res.json({ success: true, message: 'Setup berhasil!' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal setup' });
  }
});

// API: Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await getUser();
    
    if (user && user.username === username && user.password === hashPassword(password)) {
      req.session.isLoggedIn = true;
      req.session.username = username;
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Gagal login' });
  }
});

// API: Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// API: Get all data - Load data for specific month from session or default to current month
app.get('/api/pelanggan', requireAuth, async (req, res) => {
  try {
    // Check apakah perlu reset sebelum return data (hanya untuk bulan system)
    await checkDanResetJikaPerlu();
    
    const data = await readData();
    
    // Get bulan from session or use current system month
    const bulan = req.session.currentViewBulan || data.currentBulan || getBulanSekarang();
    const pelangganForBulan = getDataForBulan(data, bulan);
    
    res.json({
      pelanggan: pelangganForBulan,
      bulan: bulan,
      dataPerBulan: data.dataPerBulan || {}  // Include all months data for chart & history
    });
  } catch (error) {
    res.status(500).json({ error: 'Gagal membaca data' });
  }
});

// API: Add pelanggan
app.post('/api/pelanggan', requireAuth, async (req, res) => {
  try {
    const { nama, paket, harga, jenisBayar, status, bulan, periode, tanggalBayar, jatuhTempo, statusLangganan,
            biayaInstalasi, sewaPerangkat, diskon, ppn, feeReseller, ipAddress, macAddress } = req.body;
    
    const data = await readData();
    
    // Use bulan from request, session, or current bulan
    const targetBulan = bulan || req.session.currentViewBulan || data.currentBulan || getBulanSekarang();
    
    const now = new Date();
    const pelanggan = {
      id: Date.now().toString(),
      nama,
      paket,
      harga: parseFloat(harga),
      jenisBayar: jenisBayar || 'Cash',
      status: status || 'Belum Lunas',
      bulan: targetBulan,
      periode: periode ? parseInt(periode) : 1,
      statusLangganan: statusLangganan || 'Aktif',
      jatuhTempo: jatuhTempo || hitungJatuhTempo(),
      tanggalBayar: tanggalBayar || (status === 'Lunas' ? now.toISOString() : null),
      createdAt: now.toISOString(),
      // Optional charges
      biayaInstalasi: biayaInstalasi ? parseInt(biayaInstalasi) : 0,
      sewaPerangkat: sewaPerangkat ? parseInt(sewaPerangkat) : 0,
      diskon: diskon ? parseInt(diskon) : 0,
      ppn: ppn ? parseInt(ppn) : 0,
      feeReseller: feeReseller ? parseInt(feeReseller) : 0,
      // Connection info
      ipAddress: ipAddress || '',
      macAddress: macAddress || ''
    };
    
    // Ensure dataPerBulan exists for target month
    if (!data.dataPerBulan[targetBulan]) {
      data.dataPerBulan[targetBulan] = [];
    }
    
    data.dataPerBulan[targetBulan].push(pelanggan);
    
    // AUTO-CREATE for multi-month periode (e.g., 6 bulan, 1 tahun)
    const periodeInt = parseInt(periode) || 1;
    if (periodeInt > 1 && status === 'Lunas') {
      console.log(`🔄 Auto-creating ${periodeInt - 1} additional months for ${nama}`);
      console.log(`📅 Base month (targetBulan): ${targetBulan}`);
      
      // Create entries for subsequent months
      for (let i = 1; i < periodeInt; i++) {
        // Calculate next month using UTC to avoid timezone issues
        const [year, month] = targetBulan.split('-').map(Number);
        
        // Create date in UTC
        const nextMonth = month + i;
        const nextYear = year + Math.floor((nextMonth - 1) / 12);
        const nextMonthAdj = ((nextMonth - 1) % 12) + 1;
        
        const nextBulan = `${nextYear}-${String(nextMonthAdj).padStart(2, '0')}`;
        
        console.log(`📅 Base month: ${targetBulan}, Adding ${i} months → Result: ${nextBulan}`);
        
        // Ensure dataPerBulan exists for next month
        if (!data.dataPerBulan[nextBulan]) {
          data.dataPerBulan[nextBulan] = [];
        }
        
        // Create entry with ZERO harga (already paid in first month)
        const nextMonthEntry = {
          id: Date.now().toString() + '-' + i + '-' + Math.random().toString(36).substr(2, 9),
          nama,
          paket,
          harga: 0, // CRITICAL: No revenue for subsequent months
          jenisBayar: jenisBayar || 'Cash',
          status: 'Lunas', // Auto Lunas (already paid)
          bulan: nextBulan,
          periode: periodeInt,
          statusLangganan: statusLangganan || 'Aktif',
          jatuhTempo: jatuhTempo || hitungJatuhTempo(),
          tanggalBayar: null, // No payment date (paid in first month)
          createdAt: now.toISOString(),
          autoCreated: true, // Flag to identify auto-created entries
          originalPaymentMonth: targetBulan // Reference to original payment month
        };
        
        data.dataPerBulan[nextBulan].push(nextMonthEntry);
        console.log(`  ✅ Created entry for ${nextBulan} with harga: 0`);
      }
    }
    
    // Update backward compatibility array if viewing current month
    if (targetBulan === data.currentBulan) {
      data.pelanggan = data.dataPerBulan[targetBulan];
    }
    
    await writeData(data);
    
    res.json({ success: true, data: { pelanggan: data.dataPerBulan[targetBulan], bulan: targetBulan } });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menambah pelanggan' });
  }
});

// API: Update pelanggan
app.put('/api/pelanggan/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nama, paket, harga, jenisBayar, status, bulan, periode, tanggalBayar, jatuhTempo, statusLangganan,
            biayaInstalasi, sewaPerangkat, diskon, ppn, feeReseller, ipAddress, macAddress } = req.body;
    
    const data = await readData();
    
    // Use bulan from request, session, or current bulan
    const targetBulan = bulan || req.session.currentViewBulan || data.currentBulan || getBulanSekarang();
    
    // Ensure data exists for this month
    if (!data.dataPerBulan[targetBulan]) {
      return res.status(404).json({ error: 'Data bulan tidak ditemukan' });
    }
    
    const index = data.dataPerBulan[targetBulan].findIndex(p => p.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
    }
    
    const existingPelanggan = data.dataPerBulan[targetBulan][index];
    
    data.dataPerBulan[targetBulan][index] = {
      ...existingPelanggan,
      nama: nama || existingPelanggan.nama,
      paket: paket || existingPelanggan.paket,
      harga: harga ? parseFloat(harga) : existingPelanggan.harga,
      jenisBayar: jenisBayar || existingPelanggan.jenisBayar,
      status: status || existingPelanggan.status,
      periode: periode ? parseInt(periode) : existingPelanggan.periode || 1,
      statusLangganan: statusLangganan !== undefined ? statusLangganan : existingPelanggan.statusLangganan || 'Aktif',
      tanggalBayar: tanggalBayar !== undefined ? tanggalBayar : (status === 'Lunas' ? new Date().toISOString() : existingPelanggan.tanggalBayar),
      jatuhTempo: jatuhTempo !== undefined ? jatuhTempo : existingPelanggan.jatuhTempo,
      // Optional charges (preserve existing if not provided)
      biayaInstalasi: biayaInstalasi !== undefined ? parseInt(biayaInstalasi) : (existingPelanggan.biayaInstalasi || 0),
      sewaPerangkat: sewaPerangkat !== undefined ? parseInt(sewaPerangkat) : (existingPelanggan.sewaPerangkat || 0),
      diskon: diskon !== undefined ? parseInt(diskon) : (existingPelanggan.diskon || 0),
      ppn: ppn !== undefined ? parseInt(ppn) : (existingPelanggan.ppn || 0),
      feeReseller: feeReseller !== undefined ? parseInt(feeReseller) : (existingPelanggan.feeReseller || 0),
      // Connection info (preserve existing if not provided)
      ipAddress: ipAddress !== undefined ? ipAddress : (existingPelanggan.ipAddress || ''),
      macAddress: macAddress !== undefined ? macAddress : (existingPelanggan.macAddress || '')
    };
    
    // Update backward compatibility array if viewing current month
    if (targetBulan === data.currentBulan) {
      data.pelanggan = data.dataPerBulan[targetBulan];
    }
    
    await writeData(data);
    res.json({ success: true, data: { pelanggan: data.dataPerBulan[targetBulan], bulan: targetBulan } });
  } catch (error) {
    res.status(500).json({ error: 'Gagal update pelanggan' });
  }
});

// API: Delete pelanggan
app.delete('/api/pelanggan/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readData();
    
    const targetBulan = req.session.currentViewBulan || data.currentBulan || getBulanSekarang();
    
    if (!data.dataPerBulan[targetBulan]) {
      return res.status(404).json({ error: 'Data bulan tidak ditemukan' });
    }
    
    data.dataPerBulan[targetBulan] = data.dataPerBulan[targetBulan].filter(p => p.id !== id);
    
    // Update backward compatibility array if viewing current month
    if (targetBulan === data.currentBulan) {
      data.pelanggan = data.dataPerBulan[targetBulan];
    }
    
    await writeData(data);
    
    res.json({ success: true, data: { pelanggan: data.dataPerBulan[targetBulan], bulan: targetBulan } });
  } catch (error) {
    res.status(500).json({ error: 'Gagal hapus pelanggan' });
  }
});

// API: Bulk delete pelanggan by name (delete from ALL months)
app.delete('/api/pelanggan/bulk/:nama', requireAuth, async (req, res) => {
  try {
    const { nama } = req.params;
    const data = await readData();
    
    let totalDeleted = 0;
    const bulanList = [];
    
    console.log(`🗑️ Bulk delete: ${nama} from all months`);
    
    // Loop through ALL months and delete matching client
    Object.keys(data.dataPerBulan).forEach(bulan => {
      const beforeCount = data.dataPerBulan[bulan].length;
      
      // Delete all entries with matching name (case insensitive)
      data.dataPerBulan[bulan] = data.dataPerBulan[bulan].filter(p => 
        p.nama.toLowerCase() !== nama.toLowerCase()
      );
      
      const afterCount = data.dataPerBulan[bulan].length;
      const deleted = beforeCount - afterCount;
      
      if (deleted > 0) {
        totalDeleted += deleted;
        bulanList.push(bulan);
        console.log(`  ✅ Deleted ${deleted} entries from ${bulan}`);
      }
    });
    
    // Update backward compatibility array
    const currentBulan = data.currentBulan || getBulanSekarang();
    if (data.dataPerBulan[currentBulan]) {
      data.pelanggan = data.dataPerBulan[currentBulan];
    }
    
    await writeData(data);
    
    console.log(`✅ Total deleted: ${totalDeleted} entries from ${bulanList.length} months`);
    
    res.json({ 
      success: true, 
      totalDeleted,
      bulanList,
      message: `Berhasil menghapus ${nama} dari ${bulanList.length} bulan` 
    });
  } catch (error) {
    console.error('Error bulk delete:', error);
    res.status(500).json({ error: 'Gagal hapus pelanggan dari semua bulan' });
  }
});

// ===== FIXED: API CHANGE MONTH - AUTO COPY CLIENTS FROM PREVIOUS MONTH =====
app.post('/api/bulan', requireAuth, async (req, res) => {
  try {
    const { bulan } = req.body;
    
    console.log(`📅 User ganti view bulan ke: ${bulan}`);
    
    // Simpan bulan yang sedang dilihat ke session
    req.session.currentViewBulan = bulan;
    
    const data = await readData();
    
    // Ensure dataPerBulan exists
    if (!data.dataPerBulan) {
      data.dataPerBulan = {};
    }
    
    // Ensure dataPerBulan exists for requested month
    if (!data.dataPerBulan[bulan]) {
      console.log(`🔄 Bulan ${bulan} belum ada data, mencari sumber data...`);
      
      // Try multiple sources in order of priority:
      // 1. Previous month data (dataPerBulan)
      // 2. Current month data (backward compatibility)
      // 3. Legacy pelanggan array
      
      let sourceData = null;
      let sourceName = '';
      
      // Option 1: Find the most recent previous month with data
      const availableBulan = Object.keys(data.dataPerBulan).filter(b => data.dataPerBulan[b].length > 0).sort();
      if (availableBulan.length > 0) {
        const previousBulan = availableBulan[availableBulan.length - 1];
        sourceData = data.dataPerBulan[previousBulan];
        sourceName = previousBulan;
        console.log(`📦 Found source from previous month: ${sourceName} (${sourceData.length} clients)`);
      }
      
      // Option 2: Use current month data if exists
      if (!sourceData && data.currentBulan && data.dataPerBulan[data.currentBulan]) {
        sourceData = data.dataPerBulan[data.currentBulan];
        sourceName = data.currentBulan;
        console.log(`📦 Found source from current month: ${sourceName} (${sourceData.length} clients)`);
      }
      
      // Option 3: Use legacy pelanggan array
      if (!sourceData && data.pelanggan && data.pelanggan.length > 0) {
        sourceData = data.pelanggan;
        sourceName = 'legacy pelanggan array';
        console.log(`📦 Found source from legacy array: ${sourceData.length} clients`);
      }
      
      if (sourceData && sourceData.length > 0) {
        // CRITICAL FIX: DO NOT filter auto-created entries - copy ALL clients!
        // Multi-period clients (e.g., 2-month subscriptions) need to be copied
        
        // Calculate previous month to get correct jatuh tempo
        const previousBulan = getBulanSebelumnya(bulan);
        
        // Copy all clients and reset their payment status
        data.dataPerBulan[bulan] = sourceData.map(p => ({
          ...p,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9), // New unique ID
          status: 'Belum Lunas', // Reset status
          bulan: bulan,
          tanggalBayar: null, // Clear payment date
          // CRITICAL FIX: Use tambah1BulanJatuhTempo instead of hitungJatuhTempo
          jatuhTempo: tambah1BulanJatuhTempo(p.jatuhTempo),
          lastResetDate: new Date().toISOString()
        }));
        
        console.log(`✅ Copied ${data.dataPerBulan[bulan].length} clients from ${sourceName} to ${bulan} (excluded 0 auto-created entries)`);
      } else {
        // No source data found anywhere, start fresh
        data.dataPerBulan[bulan] = [];
        console.log(`ℹ️ No source data found anywhere, starting fresh for ${bulan}`);
      }
      
      await writeData(data);
    } else {
      console.log(`✅ Data for ${bulan} already exists: ${data.dataPerBulan[bulan].length} clients`);
    }
    
    const pelangganForBulan = data.dataPerBulan[bulan];
    
    res.json({ 
      success: true, 
      pelanggan: pelangganForBulan,
      bulan: bulan
    });
  } catch (error) {
    console.error('❌ Error changing month view:', error);
    res.status(500).json({ error: 'Gagal ganti bulan' });
  }
});

// API: Manual Reset - untuk reset manual saja
app.post('/api/reset-bulanan', requireAuth, async (req, res) => {
  try {
    const result = await resetBulanan();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Gagal reset bulanan' });
  }
});

// API: Get settings info
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const settings = await readSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Gagal membaca settings' });
  }
});

// ===== NEW FEATURES APIs =====

// API: Get payment history for a specific client
app.get('/api/pelanggan/:id/history', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readData();
    
    const history = [];
    
    // Search through all months for this client's payment history
    // Match by nama (name) since ID changes per month
    let clientName = null;
    
    // First, find the client's name
    for (const bulan in data.dataPerBulan) {
      const client = data.dataPerBulan[bulan].find(p => p.id === id);
      if (client) {
        clientName = client.nama;
        break;
      }
    }
    
    if (!clientName) {
      return res.json({ success: true, history: [] });
    }
    
    // Now search all months for this client name
    for (const bulan in data.dataPerBulan) {
      const clients = data.dataPerBulan[bulan].filter(p => p.nama === clientName);
      
      clients.forEach(client => {
        history.push({
          bulan: bulan,
          nama: client.nama,
          paket: client.paket,
          harga: client.harga,
          status: client.status,
          jenisBayar: client.jenisBayar,
          tanggalBayar: client.tanggalBayar,
          statusLangganan: client.statusLangganan || 'Aktif'
        });
      });
    }
    
    // Sort by bulan (newest first)
    history.sort((a, b) => b.bulan.localeCompare(a.bulan));
    
    res.json({ success: true, history });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: 'Gagal mengambil history' });
  }
});

// API: Get revenue chart data (6 months)
app.get('/api/revenue-chart', requireAuth, async (req, res) => {
  try {
    const data = await readData();
    
    // Get last 6 months
    const months = [];
    const today = new Date();
    
    for (let i = 5; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthStr = date.toISOString().slice(0, 7); // YYYY-MM
      months.push(monthStr);
    }
    
    // Calculate revenue for each month
    const revenues = months.map(month => {
      const monthData = data.dataPerBulan[month] || [];
      const revenue = monthData
        .filter(p => p.status === 'Lunas')
        .reduce((sum, p) => sum + p.harga, 0);
      return revenue;
    });
    
    // Format labels (e.g., "Jan 2025")
    const labels = months.map(m => {
      const date = new Date(m + '-01');
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 
                          'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      return `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
    });
    
    res.json({
      success: true,
      chartData: {
        labels,
        data: revenues
      }
    });
  } catch (error) {
    console.error('Error generating chart:', error);
    res.status(500).json({ error: 'Gagal membuat grafik' });
  }
});

// Start server
async function startServer() {
  await initDataFile();
  
  // Check reset saat startup
  console.log('🚀 Checking reset status saat startup...');
  await checkDanResetJikaPerlu();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ RT-RW Net Management running on http://0.0.0.0:${PORT}`);
    console.log(`📅 Bulan aktif: ${getBulanSekarang()}`);
    console.log(`⏰ Cron job aktif - Reset otomatis setiap hari jam 00:01`);
    console.log(`🔧 FIXED: Ganti bulan TIDAK auto-reset, data tersimpan per bulan`);
  });
}

startServer();
