// ============================================================
// BAN MANAGEMENT SYSTEM - SERVER
// Node.js + Express
// ============================================================

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Thai777@';
const DATA_DIR = path.join(__dirname, 'data');
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'ban-system-secret-key-2025-xkq9p';

// ============================================================
// INITIALIZE DATA DIRECTORY & FILE
// ============================================================
function initializeDataStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[INIT] Created data directory');
  }

  if (!fs.existsSync(BANS_FILE)) {
    const defaultData = {
      bans: {},
      history: [],
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(BANS_FILE, JSON.stringify(defaultData, null, 2));
    console.log('[INIT] Created bans.json');
  }
}

// ============================================================
// DATA HELPERS
// ============================================================
function readBans() {
  try {
    const raw = fs.readFileSync(BANS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[ERROR] Reading bans file:', err.message);
    return { bans: {}, history: [], lastUpdated: new Date().toISOString() };
  }
}

function writeBans(data) {
  try {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(BANS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('[ERROR] Writing bans file:', err.message);
    return false;
  }
}

// ============================================================
// AUTO-EXPIRE SYSTEM
// Removes bans that have passed their expiry time
// ============================================================
function removeExpiredBans(data) {
  const now = new Date();
  let removed = 0;
  const expiredList = [];

  for (const userId in data.bans) {
    const ban = data.bans[userId];
    
    // Skip permanent bans
    if (!ban.expiresAt || ban.expiresAt === null || ban.duration === 'Permanent') {
      continue;
    }

    const expiryDate = new Date(ban.expiresAt);
    
    if (expiryDate <= now) {
      // Move to history before removing
      expiredList.push({
        ...ban,
        userId: userId,
        expiredAt: now.toISOString(),
        removalReason: 'auto-expired'
      });
      
      delete data.bans[userId];
      removed++;
      console.log(`[AUTO-EXPIRE] Removed expired ban for UserID: ${userId}`);
    }
  }

  // Add expired bans to history (keep last 500 entries)
  if (expiredList.length > 0) {
    data.history = [...expiredList, ...(data.history || [])].slice(0, 500);
  }

  return { data, removed };
}

function getCleanBans() {
  let data = readBans();
  const { data: cleanData, removed } = removeExpiredBans(data);
  
  if (removed > 0) {
    writeBans(cleanData);
  }
  
  return cleanData;
}

// ============================================================
// BACKGROUND TIMER - Check expiry every 60 seconds
// ============================================================
setInterval(() => {
  const before = readBans();
  const { data: after, removed } = removeExpiredBans(before);
  if (removed > 0) {
    writeBans(after);
    console.log(`[TIMER] Removed ${removed} expired ban(s)`);
  }
}, 60 * 1000);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  // API requests get JSON error
  if (req.path.startsWith('/api/admin')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Please log in first' });
  }
  
  // Web requests redirect to login
  return res.redirect('/');
}

// ============================================================
// ROUTES - PAGES
// ============================================================

// Login page
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============================================================
// ROUTES - AUTH API
// ============================================================

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.loginTime = new Date().toISOString();
    return res.json({ 
      success: true, 
      message: 'Login successful',
      redirect: '/dashboard'
    });
  }

  // Delay wrong password response (anti-brute force)
  setTimeout(() => {
    res.status(401).json({ error: 'Invalid password' });
  }, 1000);
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authenticated: !!(req.session && req.session.authenticated),
    loginTime: req.session?.loginTime || null
  });
});

// ============================================================
// ROUTES - PUBLIC API (No auth required)
// ============================================================

// THE MAIN ENDPOINT FOR ROBLOX SCRIPTS
// Returns active bans only (expired bans auto-filtered)
app.get('/api/banlist', (req, res) => {
  const data = getCleanBans(); // Auto-removes expired
  
  // Build clean ban list for public consumption
  const publicBans = {};
  
  for (const userId in data.bans) {
    const ban = data.bans[userId];
    publicBans[userId] = {
      reason: ban.reason || 'No reason provided',
      bannedBy: ban.bannedBy || 'Admin',
      bannedAt: ban.bannedAt,
      expiresAt: ban.expiresAt || null,
      duration: ban.duration || 'Permanent',
      username: ban.username || 'Unknown'
    };
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  res.json({
    lastUpdated: data.lastUpdated,
    totalBans: Object.keys(publicBans).length,
    bans: publicBans
  });
});

// Alternative URL aliases for the ban list
app.get('/raw', (req, res) => res.redirect('/api/banlist'));
app.get('/banlist.json', (req, res) => res.redirect('/api/banlist'));
app.get('/bans', (req, res) => res.redirect('/api/banlist'));

// ============================================================
// ROUTES - ADMIN API (Auth required)
// ============================================================

// Get all bans (admin view with full data)
app.get('/api/admin/bans', requireAuth, (req, res) => {
  const data = getCleanBans();
  
  // Add computed fields
  const bansWithMeta = {};
  const now = new Date();
  
  for (const userId in data.bans) {
    const ban = data.bans[userId];
    let remainingMs = null;
    let remainingText = 'Permanent';
    let isExpired = false;
    
    if (ban.expiresAt && ban.duration !== 'Permanent') {
      const expiry = new Date(ban.expiresAt);
      remainingMs = expiry - now;
      
      if (remainingMs <= 0) {
        isExpired = true;
        remainingText = 'Expired';
      } else {
        remainingText = formatDuration(remainingMs);
      }
    }
    
    bansWithMeta[userId] = {
      ...ban,
      userId,
      remainingMs,
      remainingText,
      isExpired
    };
  }
  
  res.json({
    success: true,
    totalBans: Object.keys(bansWithMeta).length,
    bans: bansWithMeta,
    lastUpdated: data.lastUpdated
  });
});

// Get ban history
app.get('/api/admin/history', requireAuth, (req, res) => {
  const data = readBans();
  res.json({
    success: true,
    history: data.history || [],
    total: (data.history || []).length
  });
});

// Get stats
app.get('/api/admin/stats', requireAuth, (req, res) => {
  const data = getCleanBans();
  const bans = data.bans;
  const now = new Date();
  
  let permanentCount = 0;
  let temporaryCount = 0;
  let expiringIn24h = 0;
  
  for (const userId in bans) {
    const ban = bans[userId];
    if (!ban.expiresAt || ban.duration === 'Permanent') {
      permanentCount++;
    } else {
      temporaryCount++;
      const expiry = new Date(ban.expiresAt);
      const hoursLeft = (expiry - now) / (1000 * 60 * 60);
      if (hoursLeft <= 24) expiringIn24h++;
    }
  }
  
  res.json({
    success: true,
    stats: {
      totalActive: Object.keys(bans).length,
      permanent: permanentCount,
      temporary: temporaryCount,
      expiringIn24h,
      historyCount: (data.history || []).length,
      lastUpdated: data.lastUpdated
    }
  });
});

// BAN A USER
app.post('/api/admin/ban', requireAuth, (req, res) => {
  const { userId, username, reason, duration } = req.body;
  
  // Validation
  if (!userId) {
    return res.status(400).json({ error: 'UserID is required' });
  }
  
  const userIdStr = String(userId).trim();
  
  if (!/^\d+$/.test(userIdStr)) {
    return res.status(400).json({ error: 'UserID must be a number' });
  }
  
  if (!reason || reason.trim() === '') {
    return res.status(400).json({ error: 'Ban reason is required' });
  }
  
  if (!duration) {
    return res.status(400).json({ error: 'Ban duration is required' });
  }
  
  // Calculate expiry
  const now = new Date();
  let expiresAt = null;
  
  const durationMap = {
    '1 Hour':    1 * 60 * 60 * 1000,
    '6 Hours':   6 * 60 * 60 * 1000,
    '12 Hours':  12 * 60 * 60 * 1000,
    '1 Day':     24 * 60 * 60 * 1000,
    '3 Days':    3 * 24 * 60 * 60 * 1000,
    '7 Days':    7 * 24 * 60 * 60 * 1000,
    '30 Days':   30 * 24 * 60 * 60 * 1000,
    'Permanent': null
  };
  
  if (!durationMap.hasOwnProperty(duration)) {
    return res.status(400).json({ error: 'Invalid duration value' });
  }
  
  const durationMs = durationMap[duration];
  if (durationMs !== null) {
    expiresAt = new Date(now.getTime() + durationMs).toISOString();
  }
  
  // Load and update data
  let data = getCleanBans();
  
  // Check if already banned
  const alreadyBanned = data.bans[userIdStr];
  
  const banRecord = {
    userId: userIdStr,
    username: username ? username.trim() : 'Unknown',
    reason: reason.trim(),
    duration: duration,
    bannedAt: now.toISOString(),
    expiresAt: expiresAt,
    bannedBy: 'Admin',
    banId: uuidv4()
  };
  
  data.bans[userIdStr] = banRecord;
  
  if (writeBans(data)) {
    console.log(`[BAN] UserID ${userIdStr} banned for ${duration}. Reason: ${reason.trim()}`);
    return res.json({
      success: true,
      message: `User ${userIdStr} has been banned`,
      ban: banRecord,
      wasAlreadyBanned: !!alreadyBanned
    });
  }
  
  res.status(500).json({ error: 'Failed to save ban data' });
});

// UNBAN A USER
app.delete('/api/admin/unban/:userId', requireAuth, (req, res) => {
  const userIdStr = String(req.params.userId).trim();
  
  if (!/^\d+$/.test(userIdStr)) {
    return res.status(400).json({ error: 'Invalid UserID format' });
  }
  
  let data = readBans();
  
  if (!data.bans[userIdStr]) {
    return res.status(404).json({ error: `UserID ${userIdStr} is not currently banned` });
  }
  
  const removedBan = { ...data.bans[userIdStr] };
  
  // Move to history
  const historyEntry = {
    ...removedBan,
    userId: userIdStr,
    unbannedAt: new Date().toISOString(),
    removalReason: 'manual-unban'
  };
  
  data.history = [historyEntry, ...(data.history || [])].slice(0, 500);
  delete data.bans[userIdStr];
  
  if (writeBans(data)) {
    console.log(`[UNBAN] UserID ${userIdStr} unbanned manually`);
    return res.json({
      success: true,
      message: `User ${userIdStr} has been unbanned`,
      unbannedUser: removedBan
    });
  }
  
  res.status(500).json({ error: 'Failed to update ban data' });
});

// UNBAN via POST (alternative for form submissions)
app.post('/api/admin/unban', requireAuth, (req, res) => {
  req.params = { userId: req.body.userId };
  // Forward to DELETE handler logic
  const userIdStr = String(req.body.userId || '').trim();
  
  if (!userIdStr || !/^\d+$/.test(userIdStr)) {
    return res.status(400).json({ error: 'Valid UserID is required' });
  }
  
  let data = readBans();
  
  if (!data.bans[userIdStr]) {
    return res.status(404).json({ error: `UserID ${userIdStr} is not currently banned` });
  }
  
  const removedBan = { ...data.bans[userIdStr] };
  const historyEntry = {
    ...removedBan,
    userId: userIdStr,
    unbannedAt: new Date().toISOString(),
    removalReason: 'manual-unban'
  };
  
  data.history = [historyEntry, ...(data.history || [])].slice(0, 500);
  delete data.bans[userIdStr];
  
  if (writeBans(data)) {
    return res.json({
      success: true,
      message: `User ${userIdStr} has been unbanned`
    });
  }
  
  res.status(500).json({ error: 'Failed to update ban data' });
});

// Clear ban history
app.delete('/api/admin/history', requireAuth, (req, res) => {
  let data = readBans();
  data.history = [];
  
  if (writeBans(data)) {
    return res.json({ success: true, message: 'History cleared' });
  }
  
  res.status(500).json({ error: 'Failed to clear history' });
});

// Export ban list as JSON file download
app.get('/api/admin/export', requireAuth, (req, res) => {
  const data = getCleanBans();
  const filename = `banlist-export-${new Date().toISOString().split('T')[0]}.json`;
  
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(data);
});

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function formatDuration(ms) {
  if (ms <= 0) return 'Expired';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    const remainHours = hours % 24;
    return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainMins = minutes % 60;
    return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ============================================================
// 404 HANDLER
// ============================================================
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START SERVER
// ============================================================
initializeDataStorage();

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================================');
  console.log('  🔨 Ban Management System - ONLINE');
  console.log('================================================');
  console.log(`  🌐 Dashboard:  http://localhost:${PORT}`);
  console.log(`  📡 API:        http://localhost:${PORT}/api/banlist`);
  console.log(`  🔑 Password:   ${ADMIN_PASSWORD}`);
  console.log('================================================');
});
