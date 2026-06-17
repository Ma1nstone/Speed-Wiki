const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const userSockets = new Map(); // userId -> Set of socketIds

const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt');
const User = require('./models/User');
const Message = require('./models/Message');
const GameRecord = require('./models/GameRecord');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 5000
});

// ─── Profile picture upload setup ────────────────────────────────────────────
const avatarDir = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${req.session.userId}${ext}`);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});

// Serve public folder AND root (for favicon)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

app.use(express.json());

// ─── Session middleware ───────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'devSecret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ─── Auth middleware ──────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
};

const DEV_USERNAME = 'Ma1nstone';

// ─── Helper: get avatar URL for a userId ─────────────────────────────────────
function getAvatarUrl(userId) {
  if (!userId) return null;
  for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
    const p = path.join(avatarDir, `${userId}${ext}`);
    if (fs.existsSync(p)) return `/avatars/${userId}${ext}`;
  }
  return null;
}

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });

    req.session.userId = user._id;
    req.session.username = user.username;

    res.json({ success: true, username: user.username, userId: user._id, avatarUrl: null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (!user) return res.status(400).json({ error: 'Invalid username or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid username or password' });

    if (user.banned) {
      return res.json({ success: true, username: user.username, userId: user._id, banned: true });
    }

    req.session.userId = user._id;
    req.session.username = user.username;

    const avatarUrl = getAvatarUrl(user._id.toString());
    res.json({ success: true, username: user.username, userId: user._id, avatarUrl });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.json({ loggedIn: false });
    if (user.banned) {
      req.session.destroy(() => {});
      return res.json({ loggedIn: true, banned: true, username: user.username, userId: user._id });
    }
    const isDev = user.username.toLowerCase() === DEV_USERNAME.toLowerCase();
    const avatarUrl = getAvatarUrl(user._id.toString());
    res.json({ loggedIn: true, username: user.username, userId: user._id, isDev, avatarUrl });
  } catch (e) {
    res.json({ loggedIn: false });
  }
});

// ─── Profile picture routes ───────────────────────────────────────────────────
app.post('/api/profile/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/avatars/${req.file.filename}`;

    // Update avatar in any active game rooms this user is in
    const userId = req.session.userId.toString();
    const socketSet = userSockets.get(userId);
    if (socketSet) {
      for (const sid of socketSet) {
        const sock = io.sockets.sockets.get(sid);
        if (sock?.data?.roomCode) {
          const room = rooms.get(sock.data.roomCode);
          if (room) {
            const player = room.players.get(sid);
            if (player) {
              player.avatarUrl = avatarUrl;
              broadcastRoomState(room);
            }
          }
        }
      }
    }

    res.json({ success: true, avatarUrl });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.delete('/api/profile/avatar', requireAuth, async (req, res) => {
  try {
    for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
      const p = path.join(avatarDir, `${req.session.userId}${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// ─── Online status route ──────────────────────────────────────────────────────
app.post('/api/online-status', requireAuth, async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.json({ online: [] });
    const online = userIds.filter(id => {
      const s = userSockets.get(id.toString());
      return s && s.size > 0;
    });
    res.json({ online });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Friends routes ───────────────────────────────────────────────────────────
app.post('/api/friends/request', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    const target = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target._id.toString() === req.session.userId.toString()) return res.status(400).json({ error: 'Cannot add yourself' });
    const alreadyFriends = target.friends.some(f => f.toString() === req.session.userId.toString());
    if (alreadyFriends) return res.status(400).json({ error: 'Already friends' });
    const alreadyRequested = target.friendRequests.some(r => r.from.toString() === req.session.userId.toString());
    if (alreadyRequested) return res.status(400).json({ error: 'Request already sent' });
    target.friendRequests.push({ from: req.session.userId });
    await target.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  try {
    const { fromId } = req.body;
    const me = await User.findById(req.session.userId);
    const them = await User.findById(fromId);
    if (!me || !them) return res.status(404).json({ error: 'User not found' });
    me.friendRequests = me.friendRequests.filter(r => r.from.toString() !== fromId);
    if (!me.friends.some(f => f.toString() === fromId)) me.friends.push(fromId);
    if (!them.friends.some(f => f.toString() === me._id.toString())) them.friends.push(me._id);
    await me.save();
    await them.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/decline', requireAuth, async (req, res) => {
  try {
    const { fromId } = req.body;
    const me = await User.findById(req.session.userId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    me.friendRequests = me.friendRequests.filter(r => r.from.toString() !== fromId);
    await me.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/friends/remove', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    const me = await User.findById(req.session.userId);
    const them = await User.findById(friendId);
    if (!me) return res.status(404).json({ error: 'User not found' });

    me.friends = me.friends.filter(f => f.toString() !== friendId);
    await me.save();

    if (them) {
      them.friends = them.friends.filter(f => f.toString() !== req.session.userId.toString());
      await them.save();
    }

    await Message.deleteMany({
      $or: [
        { from: req.session.userId, to: friendId },
        { from: friendId, to: req.session.userId }
      ]
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId)
      .populate('friends', 'username')
      .populate('friendRequests.from', 'username');
    res.json({ friends: me.friends, requests: me.friendRequests });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Messaging routes ─────────────────────────────────────────────────────────
app.post('/api/messages/send', requireAuth, async (req, res) => {
  try {
    const { toId, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Empty message' });
    const msg = await Message.create({ from: req.session.userId, to: toId, content: content.trim() });
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages/:withId', requireAuth, async (req, res) => {
  try {
    const msgs = await Message.find({
      $or: [
        { from: req.session.userId, to: req.params.withId },
        { from: req.params.withId, to: req.session.userId }
      ]
    }).sort({ createdAt: 1 }).limit(100);

    await Message.updateMany(
      { from: req.params.withId, to: req.session.userId, read: false },
      { read: true }
    );

    res.json({ messages: msgs });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages/unread/count', requireAuth, async (req, res) => {
  try {
    const count = await Message.countDocuments({ to: req.session.userId, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Stats routes ─────────────────────────────────────────────────────────────
app.get('/api/stats/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const records = await GameRecord.find({ userId: user._id }).sort({ playedAt: -1 }).limit(20);
    res.json({ stats: user.stats, history: records });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Dev routes (Ma1nstone only) ─────────────────────────────────────────────
app.post('/api/dev/ban', requireAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId);
    if (!me || me.username.toLowerCase() !== DEV_USERNAME.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { username } = req.body;
    const target = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.username.toLowerCase() === DEV_USERNAME.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot ban dev account' });
    }
    target.banned = true;
    await target.save();

    const targetSocketId = userSockets.get(target._id.toString());
    if (targetSocketId) {
      for (const sid of targetSocketId) io.to(sid).emit('account:banned');
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/dev/unban', requireAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId);
    if (!me || me.username.toLowerCase() !== DEV_USERNAME.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { username } = req.body;
    const target = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (!target) return res.status(404).json({ error: 'User not found' });
    target.banned = false;
    await target.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Suppress CSS/JS sourcemap 404s ──────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.endsWith('.css.map') || req.path.endsWith('.js.map')) return res.status(204).end();
  next();
});

// ─── Portal route ─────────────────────────────────────────────────────────────
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

// ─── Race Challenges ──────────────────────────────────────────────────────────
const { RACE_CHALLENGES } = require('./RaceChallenges.js');
app.get('/api/challenges', (req, res) => {
  res.json(RACE_CHALLENGES.map(c => ({ start: c.start, target: c.target })));
});

// ─── Room State ───────────────────────────────────────────────────────────────
const rooms = new Map();
let onlineCount = 0;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}

function getRoomPublicState(room) {
  return {
    code: room.code, host: room.host, status: room.status,
    target: room.target, targetUrl: room.targetUrl,
    startArticle: room.startArticle, startUrl: room.startUrl,
    startTime: room.startTime, timeLimit: room.timeLimit,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, currentArticle: p.currentArticle,
      articlePath: p.articlePath, clicks: p.clicks,
      finished: p.finished, finishTime: p.finishTime, rank: p.rank,
      avatarUrl: p.avatarUrl || null,
    })),
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room:state', getRoomPublicState(room));
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) { if (room.gameTimer) clearInterval(room.gameTimer); rooms.delete(roomCode); }
}

function broadcastOnlineCount() {
  io.emit('server:online', { count: onlineCount });
}

function endGame(room) {
  if (room.status !== 'playing') return;
  if (room.gameTimer) clearInterval(room.gameTimer);
  room.status = 'finished';

  const leaderboard = Array.from(room.players.values())
    .map(p => ({ id: p.id, name: p.name, clicks: p.clicks, finished: p.finished, finishTime: p.finishTime, rank: p.rank, articlePath: p.articlePath }))
    .sort((a, b) => {
      if (a.finished && !b.finished) return -1;
      if (!a.finished && b.finished) return 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.clicks - a.clicks;
    });

  const winner = leaderboard.find(p => p.finished) || null;
  io.to(room.code).emit('game:over', { leaderboard, winner });
  broadcastRoomState(room);
}

function handleLeave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const playerName = room.players.get(socket.id)?.name || 'A player';
  room.players.delete(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;
  if (room.players.size === 0) { cleanupRoom(code); return; }
  if (room.host === socket.id) {
    room.host = room.players.keys().next().value;
    io.to(code).emit('toast', { msg: `${room.players.get(room.host).name} is now the host`, type: 'info' });
  }
  io.to(code).emit('toast', { msg: `${playerName} left the lobby`, type: 'warning' });
  broadcastRoomState(room);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount++;
  broadcastOnlineCount();

  // Resolve userId/username from session at connection time
  const userId = socket.request.session?.userId?.toString();
  const username = socket.request.session?.username;

  // Track socket → user mapping
  if (userId) {
    const wasOffline = !userSockets.has(userId) || userSockets.get(userId).size === 0;
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    if (wasOffline) {
      io.emit('friend:status', { userId, online: true });
    }
  }

  // ── Single disconnect handler ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();

    if (userId) {
      const socketSet = userSockets.get(userId);
      if (socketSet) {
        socketSet.delete(socket.id);
        if (socketSet.size === 0) {
          userSockets.delete(userId);
          io.emit('friend:status', { userId, online: false });
        }
      }
    }

    handleLeave(socket);
  });

  socket.on('users:online-check', ({ userIds }, callback) => {
    if (!Array.isArray(userIds)) return callback && callback({ online: [] });
    const online = userIds.filter(id => {
      const s = userSockets.get(id.toString());
      return s && s.size > 0;
    });
    if (typeof callback === 'function') callback({ online });
  });

  socket.on('invite:send', ({ toId, roomCode }, callback) => {
    const toIdStr = toId?.toString();
    const socketSet = userSockets.get(toIdStr);

    if (!socketSet || socketSet.size === 0) {
      if (typeof callback === 'function') return callback({ success: false, reason: 'offline' });
      return socket.emit('error', { msg: 'User is offline' });
    }

    for (const sid of socketSet) {
      io.to(sid).emit('invite:receive', { fromUsername: username, roomCode });
    }

    if (typeof callback === 'function') callback({ success: true });
  });

  socket.on('lobby:create', ({ playerName }) => {
    if (!playerName?.trim()) return socket.emit('error', { msg: 'Name required' });
    const code = generateRoomCode();
    const room = {
      code, host: socket.id,
      players: new Map(), status: 'waiting',
      target: null, targetUrl: null, startArticle: null, startUrl: null,
      startTime: null, gameTimer: null, timeLimit: 999999,
    };
    const creatorAvatarUrl = userId ? getAvatarUrl(userId) : null;
    room.players.set(socket.id, {
      id: socket.id, name: playerName.trim().slice(0, 20),
      currentArticle: '', articlePath: [], clicks: 0,
      finished: false, finishTime: null, rank: null,
      userId: userId || null,
      avatarUrl: creatorAvatarUrl,
    });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('lobby:created', { code });
    broadcastRoomState(room);
  });

  socket.on('lobby:join', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    if (!playerName?.trim()) return socket.emit('error', { msg: 'Name required' });
    if (!code) return socket.emit('error', { msg: 'Room code required' });
    const room = rooms.get(code);
    if (!room) return socket.emit('error', { msg: 'Room not found. Check the code and try again.' });
    if (room.status !== 'waiting') return socket.emit('error', { msg: 'Game already in progress.' });
    if (room.players.size >= 8) return socket.emit('error', { msg: 'Room is full (max 8 players).' });
    const joinerAvatarUrl = userId ? getAvatarUrl(userId) : null;
    room.players.set(socket.id, {
      id: socket.id, name: playerName.trim().slice(0, 20),
      currentArticle: '', articlePath: [], clicks: 0,
      finished: false, finishTime: null, rank: null,
      userId: userId || null,
      avatarUrl: joinerAvatarUrl,
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('lobby:joined', { code });
    io.to(code).emit('toast', { msg: `${playerName} joined the lobby`, type: 'info' });
    broadcastRoomState(room);
  });

  socket.on('lobby:leave', () => handleLeave(socket));

  socket.on('game:start', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (room.host !== socket.id) return socket.emit('error', { msg: 'Only the host can start.' });
    if (room.status !== 'waiting') return;

    const challenge = RACE_CHALLENGES[Math.floor(Math.random() * RACE_CHALLENGES.length)];
    room.target = challenge.target;
    room.targetUrl = challenge.targetUrl;
    room.startArticle = challenge.start;
    room.startUrl = challenge.startUrl;
    room.status = 'playing';
    room.startTime = Date.now();

    room.players.forEach(p => {
      p.currentArticle = challenge.start;
      p.articlePath = [challenge.start];
      p.clicks = 0; p.finished = false; p.finishTime = null; p.rank = null;
    });

    broadcastRoomState(room);
    io.to(code).emit('game:starting', {
      startArticle: room.startArticle, startUrl: room.startUrl,
      target: room.target, targetUrl: room.targetUrl, timeLimit: room.timeLimit,
    });

    room.gameTimer = setInterval(() => {
      const remaining = room.timeLimit - Math.floor((Date.now() - room.startTime) / 1000);
      io.to(code).emit('game:tick', { remaining });
    }, 1000);
  });

  socket.on('game:navigate', ({ article, url }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;

    const player = room.players.get(socket.id);
    if (!player || player.finished) return;

    player.currentArticle = article;
    player.articlePath.push(article);
    player.clicks++;

    const norm = s => decodeURIComponent(s).toLowerCase().replace(/_/g, ' ').trim();
    const targetSlug = norm(room.targetUrl.replace('/wiki/', ''));
    const incomingSlug = norm((url.split('/wiki/')[1] || article));
    const targetName = norm(room.target);

    if (incomingSlug === targetSlug || incomingSlug === targetName) {
      player.finished = true;
      player.finishTime = Date.now() - room.startTime;
      player.rank = 1;

      const playerUserId = player.userId;
      if (playerUserId) {
        GameRecord.create({
          userId: playerUserId,
          username: player.name,
          startArticle: room.startArticle,
          targetArticle: room.target,
          clicks: player.clicks,
          timeTaken: player.finishTime,
          won: true,
          path: player.articlePath
        }).catch(console.error);

        User.findByIdAndUpdate(playerUserId, {
          $inc: { 'stats.gamesPlayed': 1, 'stats.gamesWon': 1, 'stats.totalClicks': player.clicks }
        }).catch(console.error);
      }

      socket.emit('game:won', { rank: 1, clicks: player.clicks, time: player.finishTime, path: player.articlePath });
      io.to(code).emit('toast', { msg: `🏆 ${player.name} won in ${player.clicks} clicks!`, type: 'success' });

      room.players.forEach((p, sid) => {
        if (sid === socket.id || !p.userId || p.finished) return;
        GameRecord.create({
          userId: p.userId,
          username: p.name,
          startArticle: room.startArticle,
          targetArticle: room.target,
          clicks: p.clicks,
          timeTaken: null,
          won: false,
          path: p.articlePath
        }).catch(console.error);

        User.findByIdAndUpdate(p.userId, {
          $inc: { 'stats.gamesPlayed': 1, 'stats.totalClicks': p.clicks }
        }).catch(console.error);
      });

      endGame(room);
      return;
    }

    broadcastRoomState(room);
  });

  socket.on('game:playAgain', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    if (room.gameTimer) clearInterval(room.gameTimer);
    room.status = 'waiting';
    room.target = room.targetUrl = room.startArticle = room.startUrl = null;
    room.startTime = room.gameTimer = null;
    room.players.forEach(p => {
      p.currentArticle = ''; p.articlePath = []; p.clicks = 0;
      p.finished = false; p.finishTime = null; p.rank = null;
    });
    io.to(code).emit('game:reset');
    broadcastRoomState(room);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});