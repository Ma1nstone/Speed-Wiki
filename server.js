const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const userSockets = new Map();

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
const io = new Server(server, { cors: { origin: '*' } });

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

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash });

    req.session.userId = user._id;
    req.session.username = user.username;

    res.json({
      success: true,
      username: user.username,
      userId: user._id
    });
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

    req.session.userId = user._id;
    req.session.username = user.username;

    res.json({
      success: true,
      username: user.username,
      userId: user._id
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    username: req.session.username,
    userId: req.session.userId
  });
});

// ─── Friends routes ───────────────────────────────────────────────────────────
app.post('/api/friends/request', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    const target = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });

    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target._id.toString() === req.session.userId.toString()) {
      return res.status(400).json({ error: 'Cannot add yourself' });
    }

    const alreadyFriends = target.friends.includes(req.session.userId);
    if (alreadyFriends) return res.status(400).json({ error: 'Already friends' });

    const alreadyRequested = target.friendRequests.some(
      r => r.from.toString() === req.session.userId.toString()
    );
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
    if (!me.friends.includes(fromId)) me.friends.push(fromId);
    if (!them.friends.includes(me._id)) them.friends.push(me._id);

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

    const msg = await Message.create({
      from: req.session.userId,
      to: toId,
      content: content.trim()
    });

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
    const count = await Message.countDocuments({
      to: req.session.userId,
      read: false
    });
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

    const records = await GameRecord.find({ userId: user._id })
      .sort({ playedAt: -1 })
      .limit(20);

    res.json({ stats: user.stats, history: records });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Suppress CSS/JS sourcemap 404s ──────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.endsWith('.css.map') || req.path.endsWith('.js.map')) {
    return res.status(204).end();
  }
  next();
});

// ─── Portal route ─────────────────────────────────────────────────────────────
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

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
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoomPublicState(room) {
  return {
    code: room.code,
    host: room.host,
    status: room.status,
    target: room.target,
    targetUrl: room.targetUrl,
    startArticle: room.startArticle,
    startUrl: room.startUrl,
    startTime: room.startTime,
    timeLimit: room.timeLimit,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      currentArticle: p.currentArticle,
      articlePath: p.articlePath,
      clicks: p.clicks,
      finished: p.finished,
      finishTime: p.finishTime,
      rank: p.rank,
    })),
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room:state', getRoomPublicState(room));
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) {
    if (room.gameTimer) clearInterval(room.gameTimer);
    rooms.delete(roomCode);
  }
}

function broadcastOnlineCount() {
  io.emit('server:online', { count: onlineCount });
}

function endGame(room) {
  if (room.status !== 'playing') return;
  if (room.gameTimer) clearInterval(room.gameTimer);
  room.status = 'finished';

  const leaderboard = Array.from(room.players.values())
    .map(p => ({
      id: p.id,
      name: p.name,
      clicks: p.clicks,
      finished: p.finished,
      finishTime: p.finishTime,
      rank: p.rank,
      articlePath: p.articlePath
    }))
    .sort((a, b) => {
      if (a.finished && !b.finished) return -1;
      if (!a.finished && b.finished) return 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.clicks - a.clicks;
    });

  const winner = leaderboard.find(p => p.finished) || null;
  io.to(room.code).emit('game:over', { leaderboard, winner });
  broadcastRoomState(room);
  console.log(`[GAME] ${room.code}: game over`);
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

  if (room.players.size === 0) {
    cleanupRoom(code);
    return;
  }

  if (room.host === socket.id) {
    room.host = room.players.keys().next().value;
    io.to(code).emit('toast', {
      msg: `${room.players.get(room.host).name} is now the host`,
      type: 'info'
    });
  }

  io.to(code).emit('toast', {
    msg: `${playerName} left the lobby`,
    type: 'warning'
  });

  broadcastRoomState(room);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  const username = socket.request.session?.username;

  if (userId) {
    userSockets.set(userId.toString(), socket.id);
  }

  socket.on('invite:send', ({ toId, roomCode }, callback) => {
    const targetSocketId = userSockets.get(toId?.toString());

    // NOT ONLINE
    if (!targetSocketId) {
      if (typeof callback === "function") {
        return callback({ success: false, reason: "offline" });
      }
      return socket.emit('error', { msg: 'User is offline' });
    }

    // SEND INVITE
    io.to(targetSocketId).emit('invite:receive', {
      fromUsername: username,
      roomCode
    });

    // CONFIRM BACK TO SENDER
    if (typeof callback === "function") {
      callback({ success: true });
    }
  });

  socket.on('lobby:create', ({ playerName }) => {
    if (!playerName?.trim()) return socket.emit('error', { msg: 'Name required' });

    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      players: new Map(),
      status: 'waiting',
      target: null,
      targetUrl: null,
      startArticle: null,
      startUrl: null,
      startTime: null,
      gameTimer: null,
      timeLimit: 999999,
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName.trim().slice(0, 20),
      currentArticle: '',
      articlePath: [],
      clicks: 0,
      finished: false,
      finishTime: null,
      rank: null,
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('lobby:created', { code });
    broadcastRoomState(room);
    console.log(`[ROOM] ${code} created by ${playerName}`);
  });

  socket.on('lobby:join', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    if (!playerName?.trim()) return socket.emit('error', { msg: 'Name required' });
    if (!code) return socket.emit('error', { msg: 'Room code required' });

    const room = rooms.get(code);
    if (!room) return socket.emit('error', { msg: 'Room not found. Check the code and try again.' });
    if (room.status !== 'waiting') return socket.emit('error', { msg: 'Game already in progress.' });
    if (room.players.size >= 8) return socket.emit('error', { msg: 'Room is full (max 8 players).' });

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName.trim().slice(0, 20),
      currentArticle: '',
      articlePath: [],
      clicks: 0,
      finished: false,
      finishTime: null,
      rank: null,
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('lobby:joined', { code });
    io.to(code).emit('toast', { msg: `${playerName} joined the lobby`, type: 'info' });
    broadcastRoomState(room);
    console.log(`[ROOM] ${code}: ${playerName} joined`);
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
      p.clicks = 0;
      p.finished = false;
      p.finishTime = null;
      p.rank = null;
    });

    broadcastRoomState(room);
    io.to(code).emit('game:starting', {
      startArticle: room.startArticle,
      startUrl: room.startUrl,
      target: room.target,
      targetUrl: room.targetUrl,
      timeLimit: room.timeLimit,
    });

    room.gameTimer = setInterval(() => {
      const remaining = room.timeLimit - Math.floor((Date.now() - room.startTime) / 1000);
      io.to(code).emit('game:tick', { remaining });
    }, 1000);

    console.log(`[GAME] ${code}: started — ${challenge.start} → ${challenge.target}`);
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

      if (userId) {
        GameRecord.create({
          userId: userId,
          username: player.name,
          startArticle: room.startArticle,
          targetArticle: room.target,
          clicks: player.clicks,
          timeTaken: player.finishTime,
          won: true,
          path: player.articlePath
        }).catch(console.error);

        User.findByIdAndUpdate(userId, {
          $inc: {
            'stats.gamesPlayed': 1,
            'stats.gamesWon': 1,
            'stats.totalClicks': player.clicks
          }
        }).catch(console.error);
      }

      socket.emit('game:won', {
        rank: 1,
        clicks: player.clicks,
        time: player.finishTime,
        path: player.articlePath,
      });

      io.to(code).emit('toast', {
        msg: `🏆 ${player.name} won in ${player.clicks} clicks!`,
        type: 'success',
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
      p.currentArticle = '';
      p.articlePath = [];
      p.clicks = 0;
      p.finished = false;
      p.finishTime = null;
      p.rank = null;
    });

    io.to(code).emit('game:reset');
    broadcastRoomState(room);
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();
    handleLeave(socket);

    if (userId) {
      userSockets.delete(userId.toString());
    }

    console.log(`[-] ${socket.id} disconnected | total: ${onlineCount}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});