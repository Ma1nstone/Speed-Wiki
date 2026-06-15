const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let roomCode = null;
let isHost = false;
let playerName = "";
let clickCount = 0;
let myPath = [];
let gameTarget = null;
let gameTargetUrl = null;
let punished = false;
let punishTimer = null;
let pageLoading = false;
let elapsedMs = 0;
let timerInterval = null;
let lastTickTime = null;
let inGame = false;
let currentUser = null; // { username, userId } or null if guest
let activeChatId = null; // userId of open conversation

const BLOCKED_PREFIXES = ["Wikipedia:", "Help:", "Template:", "Category:", "File:", "Special:", "Talk:", "User:", "Portal:", "Draft:", "Module:", "MediaWiki:"];
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_API_ZH = "https://zh.wikipedia.org/w/api.php";

// ─── Online count ─────────────────────────────────────────────────────────────
socket.on("server:online", ({ count }) => {
  const homeEl = document.getElementById("home-online-count");
  if (homeEl) homeEl.textContent = count;
  const lobbyEl = document.getElementById("lobby-online-count");
  if (lobbyEl) lobbyEl.textContent = count;
});

function loadSession() {
  try {
    const data = JSON.parse(localStorage.getItem("wikiSession"));
    if (!data) return null;
    return data;
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem("wikiSession");
}

// ─── Screen switching ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => { s.classList.add("hidden"); s.classList.remove("active"); });
  const screen = document.getElementById(`screen-${name}`);
  if (!screen) return;
  screen.classList.remove("hidden");
  screen.classList.add("active");
  const badge = document.getElementById("commit-badge");
  if (badge) { if (name === "home") badge.classList.remove("hidden"); else badge.classList.add("hidden"); }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.animation = "toastOut .25s forwards"; setTimeout(() => toast.remove(), 260); }, 3500);
}
socket.on("toast", ({ msg, type }) => showToast(msg, type));

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = { username: data.username, userId: data.userId };
      playerName = data.username;
      showLoggedIn();
      pollUnread();
      loadFriendRequestCount();
    } else {
      showLoggedOut();
    }
  } catch (e) { showLoggedOut(); }
}

function showLoggedIn() {
  document.getElementById("home-logged-out").classList.add("hidden");
  document.getElementById("home-logged-in").classList.remove("hidden");
  document.getElementById("user-bar-name").textContent = currentUser.username;
}

function showLoggedOut() {
  document.getElementById("home-logged-out").classList.remove("hidden");
  document.getElementById("home-logged-in").classList.add("hidden");
  currentUser = null;
}

async function submitAuth(isRegister) {
  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value;
  const password2 = document.getElementById("auth-password2").value;
  const errorEl = document.getElementById("auth-error");
  errorEl.classList.add("hidden");

  if (!username || !password) { errorEl.textContent = "Fill in all fields"; errorEl.classList.remove("hidden"); return; }
  if (isRegister && password !== password2) { errorEl.textContent = "Passwords don't match"; errorEl.classList.remove("hidden"); return; }

  const endpoint = isRegister ? '/api/register' : '/api/login';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.error) { errorEl.textContent = data.error; errorEl.classList.remove("hidden"); return; }
    currentUser = { username: data.username, userId: data.userId };
    playerName = data.username;
    document.getElementById("modal-auth").classList.add("hidden");
    showLoggedIn();
    pollUnread();
    loadFriendRequestCount();
    showToast(`Welcome, ${data.username}!`, "success");
  } catch (e) { errorEl.textContent = "Server error"; errorEl.classList.remove("hidden"); }
}

// ─── Friends modal auto-refresh ───────────────────────────────────────────────
let friendsRefreshInterval = null;

function startFriendsRefresh() {
  stopFriendsRefresh();
  friendsRefreshInterval = setInterval(() => {
    const modal = document.getElementById("modal-friends");
    if (modal && !modal.classList.contains("hidden")) {
      loadFriends();
    }
  }, 5000);
}

function stopFriendsRefresh() {
  if (friendsRefreshInterval) { clearInterval(friendsRefreshInterval); friendsRefreshInterval = null; }
}

// ─── Friends ──────────────────────────────────────────────────────────────────
async function loadFriends() {
  try {
    const res = await fetch('/api/friends');
    const data = await res.json();
    if (data.error) return;

    // Gather friend IDs and check online status via socket
    const friendIds = data.friends.map(f => f._id.toString());
    let onlineIds = new Set();
    if (friendIds.length > 0) {
      await new Promise(resolve => {
        socket.emit('users:online-check', { userIds: friendIds }, ({ online }) => {
          online.forEach(id => onlineIds.add(id.toString()));
          resolve();
        });
      });
    }

    const reqSection = document.getElementById("friends-requests-section");
    const reqList = document.getElementById("friends-requests-list");
    const list = document.getElementById("friends-list");
    document.getElementById("friends-count").textContent = data.friends.length;

    if (data.requests.length > 0) {
      reqSection.classList.remove("hidden");
      reqList.innerHTML = "";
      data.requests.forEach(r => {
        const li = document.createElement("li");
        li.className = "player-list-item";
        li.innerHTML = `<span class="player-name">${r.from.username}</span>
          <button class="btn btn-primary" style="padding:4px 10px;font-size:.8rem" onclick="acceptFriend('${r.from._id}')">Accept</button>
          <button class="btn btn-ghost" style="padding:4px 10px;font-size:.8rem" onclick="declineFriend('${r.from._id}')">Decline</button>`;
        reqList.appendChild(li);
      });
    } else { reqSection.classList.add("hidden"); }

    list.innerHTML = "";
    if (data.friends.length === 0) {
      list.innerHTML = '<li style="font-size:.85rem;color:var(--ink-muted);padding:8px 0">No friends yet — add someone above!</li>';
    } else {
      data.friends.forEach(f => {
        const fId = f._id.toString();
        const isOnline = onlineIds.has(fId);
        const li = document.createElement("li");
        li.className = "player-list-item";

        const dot = document.createElement("span");
        dot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
        dot.title = isOnline ? 'Online' : 'Offline';

        const name = document.createElement("span");
        name.className = "player-name";
        name.style.flex = "1";
        name.textContent = f.username;

        const msgBtn = document.createElement("button");
        msgBtn.className = "btn btn-ghost";
        msgBtn.style.cssText = "padding:4px 10px;font-size:.8rem";
        msgBtn.textContent = "Message";
        msgBtn.onclick = () => openMessagesAndChat(fId, f.username);

        const invBtn = document.createElement("button");
        invBtn.className = "btn btn-primary";
        invBtn.style.cssText = "padding:4px 10px;font-size:.8rem";
        invBtn.textContent = "Invite";
        invBtn.onclick = () => inviteFriend(fId, f.username);

        li.appendChild(dot);
        li.appendChild(name);
        li.appendChild(msgBtn);
        li.appendChild(invBtn);
        list.appendChild(li);
      });
    }
  } catch (e) { }
}

// Opens the messages modal directly to a chat with the given user
async function openMessagesAndChat(userId, username) {
  // Close friends modal first
  document.getElementById("modal-friends").classList.add("hidden");
  // Open messages modal and go straight to chat
  document.getElementById("modal-messages").classList.remove("hidden");
  document.getElementById("btn-messages-back").classList.remove("hidden");
  document.getElementById("messages-list-view").classList.add("hidden");
  document.getElementById("messages-chat-view").classList.remove("hidden");
  document.getElementById("messages-title").textContent = username;
  activeChatId = userId;
  try {
    const res = await fetch(`/api/messages/${userId}`);
    const data = await res.json();
    const chat = document.getElementById("chat-messages");
    chat.innerHTML = "";
    data.messages.forEach(m => appendChatMessage(m));
    chat.scrollTop = chat.scrollHeight;
    pollUnread();
  } catch (e) { }
}

async function loadFriendRequestCount() {
  try {
    const res = await fetch('/api/friends');
    const data = await res.json();
    if (data.error) return;
    const badge = document.getElementById("friend-requests-badge");
    if (data.requests.length > 0) { badge.textContent = data.requests.length; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
  } catch (e) { }
}

async function acceptFriend(fromId) {
  await fetch('/api/friends/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromId }) });
  loadFriends(); loadFriendRequestCount();
}

async function declineFriend(fromId) {
  await fetch('/api/friends/decline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromId }) });
  loadFriends(); loadFriendRequestCount();
}

function inviteFriend(friendId, friendUsername) {
  const ensureLobbyThenInvite = () => {
    socket.emit(
      "invite:send",
      { toId: friendId, toUsername: friendUsername, roomCode },
      (res) => {
        if (res?.success) {
          showToast(`Invite sent to ${friendUsername}!`, "success");
        } else {
          // They're offline — show specific message AFTER the "sent" toast
          setTimeout(() => showToast(`${friendUsername} is offline`, "warning"), 400);
        }
      }
    );
  };

  if (roomCode) {
    ensureLobbyThenInvite();
    return;
  }

  showToast("Creating lobby...", "info");

  socket.once("lobby:created", ({ code }) => {
    roomCode = code;
    isHost = true;
    document.getElementById("lobby-code-value").textContent = roomCode;
    showScreen("lobby");
    ensureLobbyThenInvite();
  });

  createLobby();
}

// ─── Messaging ────────────────────────────────────────────────────────────────
async function openMessages() {
  document.getElementById("modal-messages").classList.remove("hidden");
  document.getElementById("messages-title").textContent = "Messages";
  document.getElementById("messages-list-view").classList.remove("hidden");
  document.getElementById("messages-chat-view").classList.add("hidden");
  document.getElementById("btn-messages-back").classList.add("hidden");
  activeChatId = null;

  try {
    const res = await fetch('/api/friends');
    const data = await res.json();
    const list = document.getElementById("conversations-list");
    list.innerHTML = "";
    if (!data.friends || data.friends.length === 0) {
      list.innerHTML = '<li style="font-size:.85rem;color:var(--ink-muted);padding:8px 0">No friends to message yet.</li>';
      return;
    }
    data.friends.forEach(f => {
      const li = document.createElement("li");
      li.className = "player-list-item";
      li.style.cursor = "pointer";
      li.innerHTML = `<span class="player-name">${f.username}</span><span style="font-size:.75rem;color:var(--ink-muted)">→</span>`;
      li.onclick = () => openChatWith(f._id, f.username);
      list.appendChild(li);
    });
  } catch (e) { }
}

async function openChatWith(userId, username) {
  activeChatId = userId;
  document.getElementById("messages-title").textContent = username;
  document.getElementById("messages-list-view").classList.add("hidden");
  document.getElementById("messages-chat-view").classList.remove("hidden");
  document.getElementById("btn-messages-back").classList.remove("hidden");

  try {
    const res = await fetch(`/api/messages/${userId}`);
    const data = await res.json();
    const chat = document.getElementById("chat-messages");
    chat.innerHTML = "";
    data.messages.forEach(m => appendChatMessage(m));
    chat.scrollTop = chat.scrollHeight;
    pollUnread();
  } catch (e) { }
}

function appendChatMessage(m) {
  const chat = document.getElementById("chat-messages");
  if (!chat) return;
  const div = document.createElement("div");
  const mine = currentUser && (m.from === currentUser.userId || m.from?._id === currentUser.userId || m.from?.toString() === currentUser.userId?.toString());
  div.className = `chat-msg ${mine ? "mine" : "theirs"}`;
  div.textContent = m.content;
  chat.appendChild(div);
}

async function sendMessage() {
  if (!activeChatId) return;
  const input = document.getElementById("chat-input");
  const content = input.value.trim();
  if (!content) return;
  input.value = "";
  try {
    const res = await fetch('/api/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toId: activeChatId, content }) });
    const data = await res.json();
    if (data.message) {
      appendChatMessage(data.message);
      document.getElementById("chat-messages").scrollTop = 9999;
    }
  } catch (e) { }
}

async function pollUnread() {
  try {
    const res = await fetch('/api/messages/unread/count');
    const data = await res.json();
    const badge = document.getElementById("unread-badge");
    if (badge) { if (data.count > 0) { badge.textContent = data.count; badge.classList.remove("hidden"); } else badge.classList.add("hidden"); }
  } catch (e) { }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function openStats() {
  if (!currentUser) return;
  document.getElementById("modal-stats").classList.remove("hidden");
  try {
    const res = await fetch(`/api/stats/${currentUser.username}`);
    const data = await res.json();
    const s = data.stats;
    const winRate = s.gamesPlayed > 0 ? Math.round((s.gamesWon / s.gamesPlayed) * 100) : 0;
    document.getElementById("stats-content").innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-val">${s.gamesPlayed}</div>
          <div class="stat-label">Games Played</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${s.gamesWon}</div>
          <div class="stat-label">Wins</div>
        </div>
        <div class="stat-card stat-card-wide">
          <div class="stat-val stat-val-rate">${winRate}%</div>
          <div class="stat-label">Win Rate</div>
          <div class="stat-bar-wrap">
            <div class="stat-bar-fill" style="width:${winRate}%"></div>
          </div>
        </div>
      </div>`;
  } catch (e) { }
}

// ─── Challenge preview ────────────────────────────────────────────────────────
async function loadChallengePreview() {
  try {
    const res = await fetch('/api/challenges');
    const challenges = await res.json();
    const c = challenges[Math.floor(Math.random() * challenges.length)];
    if (document.getElementById("preview-start")) document.getElementById("preview-start").textContent = c.start;
    if (document.getElementById("preview-target-name")) document.getElementById("preview-target-name").textContent = c.target;
  } catch (e) { }
}

// ─── Latest commit badge ──────────────────────────────────────────────────────
async function fetchLatestCommit() {
  const badge = document.getElementById("commit-badge");
  if (!badge) return;
  try {
    const res = await fetch("https://api.github.com/repos/Ma1nstone/Speed-Wiki/commits?per_page=1", { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!res.ok) return;
    const [commit] = await res.json();
    if (!commit) return;
    const sha = commit.sha.slice(0, 7);
    const message = commit.commit.message.split("\n")[0];
    const date = new Date(commit.commit.author.date);
    document.getElementById("commit-hash").textContent = sha;
    document.getElementById("commit-msg").textContent = `${message} · ${timeAgo(date)}`;
    badge.classList.remove("hidden");
  } catch (e) { }
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Wikipedia API ────────────────────────────────────────────────────────────
async function fetchWikiPage(title, lang = "en") {
  const api = lang === "zh" ? WIKI_API_ZH : WIKI_API;
  const params = new URLSearchParams({ action: "parse", page: title, format: "json", prop: "text|displaytitle|sections", disableeditsection: "true", redirects: "true", origin: "*" });
  const res = await fetch(`${api}?${params}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || "Wikipedia API error");
  return { title: data.parse.title, html: data.parse.text["*"], sections: data.parse.sections || [] };
}

// ─── DOM Ready ────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  checkAuth();
  loadChallengePreview();
  fetchLatestCommit();

  // Auth modal
  document.getElementById("btn-open-auth").onclick = () => {
    document.getElementById("modal-auth").classList.remove("hidden");
    document.getElementById("auth-error").classList.add("hidden");
    document.getElementById("auth-username").value = "";
    document.getElementById("auth-password").value = "";
    document.getElementById("auth-password2").value = "";
  };
  document.getElementById("btn-auth-cancel").onclick = () => document.getElementById("modal-auth").classList.add("hidden");

  let isRegisterMode = false;
  document.getElementById("tab-login").onclick = () => {
    isRegisterMode = false;
    document.getElementById("tab-login").classList.add("active");
    document.getElementById("tab-register").classList.remove("active");
    document.getElementById("register-extra").classList.add("hidden");
    document.getElementById("btn-auth-submit").textContent = "Login";
  };
  document.getElementById("tab-register").onclick = () => {
    isRegisterMode = true;
    document.getElementById("tab-register").classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("register-extra").classList.remove("hidden");
    document.getElementById("btn-auth-submit").textContent = "Register";
  };
  document.getElementById("btn-auth-submit").onclick = () => submitAuth(isRegisterMode);

  // Logout
  document.getElementById("btn-logout").onclick = async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    currentUser = null; playerName = "";
    showLoggedOut();
    showToast("Logged out", "info");
  };

  // Guest play
  document.getElementById("btn-play-guest").onclick = () => {
    document.getElementById("modal-guest").classList.remove("hidden");
    document.getElementById("input-guest-name").value = "";
  };

  document.getElementById("btn-create-lobby").onclick = () => { createLobby(); };

  document.getElementById("btn-guest-cancel").onclick = () => document.getElementById("modal-guest").classList.add("hidden");
  document.getElementById("btn-guest-confirm").onclick = () => {
    const name = document.getElementById("input-guest-name").value.trim();
    if (!name) { showToast("Enter a name", "error"); return; }
    playerName = name;
    document.getElementById("modal-guest").classList.add("hidden");
    createLobby();
  };

  // Join lobby
  document.getElementById("btn-join-open").onclick = () => {
    if (!currentUser && !playerName) { document.getElementById("modal-guest").classList.remove("hidden"); return; }
    document.getElementById("modal-join").classList.remove("hidden");
    document.getElementById("input-room-code").value = "";
  };
  document.getElementById("btn-join-cancel").onclick = () => document.getElementById("modal-join").classList.add("hidden");
  document.getElementById("btn-join-confirm").onclick = () => {
    const code = document.getElementById("input-room-code").value.trim().toUpperCase();
    if (!code) { showToast("Enter a room code", "error"); return; }
    document.getElementById("modal-join").classList.add("hidden");
    joinLobby(code);
  };
  document.getElementById("input-room-code").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase(); });
  document.getElementById("input-room-code").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("btn-join-confirm").click(); });

  // How to play
  document.getElementById("btn-how-to-play").onclick = () => document.getElementById("modal-how").classList.remove("hidden");
  document.getElementById("btn-how-close").onclick = () => document.getElementById("modal-how").classList.add("hidden");

  // Friends
  document.getElementById("btn-open-friends").onclick = () => { document.getElementById("modal-friends").classList.remove("hidden"); loadFriends(); };
  document.getElementById("btn-open-friends-lobby").onclick = () => { document.getElementById("modal-friends").classList.remove("hidden"); loadFriends(); };
  document.getElementById("btn-friends-close").onclick = () => document.getElementById("modal-friends").classList.add("hidden");
  document.getElementById("btn-friends-add").onclick = async () => {
    const username = document.getElementById("friends-add-input").value.trim();
    if (!username) return;
    const res = await fetch('/api/friends/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
    const data = await res.json();
    if (data.error) showToast(data.error, "error");
    else { showToast(`Friend request sent to ${username}!`, "success"); document.getElementById("friends-add-input").value = ""; }
  };

  // Messages
  document.getElementById("btn-open-messages").onclick = () => openMessages();
  document.getElementById("btn-messages-close").onclick = () => { document.getElementById("modal-messages").classList.add("hidden"); activeChatId = null; };
  document.getElementById("btn-messages-back").onclick = () => { activeChatId = null; openMessages(); };
  document.getElementById("btn-chat-send").onclick = () => sendMessage();
  document.getElementById("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });

  // Stats
  document.getElementById("btn-open-stats").onclick = () => openStats();
  document.getElementById("btn-stats-close").onclick = () => document.getElementById("modal-stats").classList.add("hidden");

  // Lobby buttons
  document.getElementById("btn-copy-code").onclick = () => {
    const code = document.getElementById("lobby-code-value").textContent;
    navigator.clipboard.writeText(code).then(() => showToast("Room code copied!", "success"));
  };
  document.getElementById("btn-start-game").onclick = () => socket.emit("game:start");
  document.getElementById("btn-leave-lobby").onclick = () => { socket.emit("lobby:leave"); showScreen("home"); roomCode = null; isHost = false; };

  // Back button
  document.getElementById("btn-back")?.addEventListener("click", goBack);

  // Play again / leave gameover
  document.getElementById("btn-play-again").onclick = () => socket.emit("game:playAgain");
  document.getElementById("btn-gameover-leave").onclick = () => { disableGameGuard(); socket.emit("lobby:leave"); document.getElementById("overlay-gameover").classList.add("hidden"); showScreen("home"); roomCode = null; isHost = false; };
  document.getElementById("btn-leave-game").onclick = () => { disableGameGuard(); socket.emit("lobby:leave"); roomCode = null; isHost = false; showScreen("home"); };

  // Wiki content click
  document.getElementById("wiki-content")?.addEventListener("click", handleWikiClick);

  // Poll unread every 30s
  setInterval(() => { if (currentUser) pollUnread(); }, 30000);
});

// ─── Lobby ────────────────────────────────────────────────────────────────────
function createLobby() { socket.emit("lobby:create", { playerName: playerName || "Guest" }); }
function joinLobby(code) { socket.emit("lobby:join", { roomCode: code, playerName: playerName || "Guest" }); }

socket.on("lobby:created", ({ code }) => { roomCode = code; isHost = true; document.getElementById("lobby-code-value").textContent = roomCode; showScreen("lobby"); });
socket.on("lobby:joined", ({ code }) => { roomCode = code; isHost = false; document.getElementById("lobby-code-value").textContent = roomCode; showScreen("lobby"); });
socket.on("error", ({ msg }) => showToast(msg, "error"));

// ─── Invites ──────────────────────────────────────────────────────────────────
socket.on("invite:receive", ({ fromUsername, roomCode: inviteCode }) => {
  showToast(`${fromUsername} invited you to a game!`, "info");
  const container = document.getElementById("toast-container");
  const btn = document.createElement("button");
  btn.className = "btn btn-primary";
  btn.style.cssText = "margin-top:4px;width:100%;font-size:.8rem";
  btn.textContent = `Join ${fromUsername}'s lobby`;
  btn.onclick = () => { playerName = currentUser?.username || playerName || "Guest"; joinLobby(inviteCode); btn.closest(".toast")?.remove(); };
  const toasts = container.querySelectorAll(".toast");
  if (toasts.length > 0) toasts[toasts.length - 1].appendChild(btn);
});

// ─── Room state ───────────────────────────────────────────────────────────────
socket.on("room:state", (room) => {
  const lobbyScreen = document.getElementById("screen-lobby");
  if (lobbyScreen && !lobbyScreen.classList.contains("hidden")) {
    const list = document.getElementById("lobby-player-list");
    list.innerHTML = "";
    document.getElementById("lobby-player-count").textContent = `${room.players.length}/8`;
    room.players.forEach(p => {
      const li = document.createElement("li");
      li.className = "player-list-item";
      const avatar = document.createElement("div");
      avatar.className = "player-avatar";
      avatar.style.background = avatarColor(p.name);
      avatar.textContent = p.name.charAt(0).toUpperCase();
      const nameEl = document.createElement("span");
      nameEl.className = "player-name";
      nameEl.textContent = p.name;
      li.appendChild(avatar); li.appendChild(nameEl);
      if (p.id === room.host) { const b = document.createElement("span"); b.className = "badge-host"; b.textContent = "Host"; li.appendChild(b); }
      if (p.id === socket.id) { const y = document.createElement("span"); y.className = "badge-you"; y.textContent = "You"; li.appendChild(y); }
      list.appendChild(li);
    });
    const startBtn = document.getElementById("btn-start-game");
    const waitingMsg = document.getElementById("lobby-waiting-msg");
    if (socket.id === room.host) { startBtn.classList.remove("hidden"); waitingMsg.classList.add("hidden"); isHost = true; }
    else { startBtn.classList.add("hidden"); waitingMsg.classList.remove("hidden"); isHost = false; }
  }
  const gameScreen = document.getElementById("screen-game");
  if (gameScreen && !gameScreen.classList.contains("hidden")) updateScoreboard(room.players);
});

// ─── Scoreboard ───────────────────────────────────────────────────────────────
function updateScoreboard(players) {
  const list = document.getElementById("game-scoreboard");
  if (!list) return;
  list.innerHTML = "";
  const sorted = [...players].sort((a, b) => { if (a.finished && !b.finished) return -1; if (!a.finished && b.finished) return 1; return b.clicks - a.clicks; });
  sorted.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "score-item" + (p.finished ? " score-finished" : "") + (p.id === socket.id ? " score-you" : "");
    const rank = document.createElement("span"); rank.className = "score-rank"; rank.textContent = i + 1;
    const av = document.createElement("div"); av.className = "score-avatar"; av.style.background = avatarColor(p.name); av.textContent = p.name.charAt(0).toUpperCase();
    const info = document.createElement("div"); info.className = "score-info";
    const nameEl = document.createElement("div"); nameEl.className = "score-name"; nameEl.textContent = p.name + (p.id === socket.id ? " (you)" : "");
    const artEl = document.createElement("div"); artEl.className = "score-article"; artEl.textContent = p.finished ? "✓ Finished!" : (p.currentArticle || "—");
    info.appendChild(nameEl); info.appendChild(artEl);
    const clicks = document.createElement("span"); clicks.className = p.finished ? "score-done-badge" : "score-clicks"; clicks.textContent = p.finished ? "🏆" : `${p.clicks}`;
    li.appendChild(rank); li.appendChild(av); li.appendChild(info); li.appendChild(clicks);
    list.appendChild(li);
  });
}

// ─── Fair timer ───────────────────────────────────────────────────────────────
function startFairTimer() {
  elapsedMs = 0; lastTickTime = Date.now(); pageLoading = false;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => { if (!pageLoading) { elapsedMs += Date.now() - lastTickTime; updateTimerDisplay(); } lastTickTime = Date.now(); }, 100);
}
function pauseTimer() { pageLoading = true; document.getElementById("game-timer")?.classList.add("loading"); }
function resumeTimer() { pageLoading = false; document.getElementById("game-timer")?.classList.remove("loading"); lastTickTime = Date.now(); }
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
function updateTimerDisplay() { const s = Math.floor(elapsedMs / 1000); const el = document.getElementById("timer-value"); if (el) el.textContent = `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`; }
socket.on("game:tick", () => { });

// ─── Game starting ────────────────────────────────────────────────────────────
socket.on("game:starting", (data) => {
  clickCount = 0; myPath = []; gameTarget = data.target; gameTargetUrl = data.targetUrl; punished = false;
  document.getElementById("game-target-name").textContent = data.target;
  document.getElementById("sidebar-target-name").textContent = data.target;
  document.getElementById("game-click-count").textContent = "0";
  document.getElementById("path-trail").innerHTML = "";
  document.getElementById("punishment-banner").classList.add("hidden");
  const timerEl = document.getElementById("timer-value"); if (timerEl) timerEl.textContent = "0:00";
  const tocCol = document.getElementById("wiki-toc-col");
  if (tocCol) { tocCol.innerHTML = ""; tocCol.classList.remove("has-toc"); }
  const sb = document.getElementById("game-scoreboard"); if (sb) sb.innerHTML = "";
  updateBackButton();

  const overlay = document.getElementById("overlay-countdown");
  document.getElementById("countdown-start").textContent = data.startArticle;
  document.getElementById("countdown-target").textContent = data.target;
  overlay.classList.remove("hidden");
  showScreen("game");

  const numEl = document.getElementById("countdown-number");
  let count = 3; numEl.textContent = count;
  const tick = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(tick); overlay.classList.add("hidden");
      const startTitle = data.startUrl.split("/wiki/")[1];
      myPath = [{ title: data.startArticle, url: data.startUrl, scrollY: 0 }];
      updatePathTrail(); updateBackButton(); startFairTimer(); enableGameGuard();
      loadWikiPage(startTitle, data.startArticle);
    } else {
      numEl.textContent = count; numEl.style.animation = "none"; void numEl.offsetWidth; numEl.style.animation = "";
    }
  }, 1000);
});

// ─── Load Wikipedia ───────────────────────────────────────────────────────────
async function loadWikiPage(title, displayTitle) {
  pauseTimer();
  const wikiArea = document.getElementById("wiki-content");
  const titleEl = document.getElementById("wiki-page-title");
  const loadingEl = document.getElementById("wiki-loading");
  const scrollArea = document.getElementById("wiki-scroll-area");
  if (loadingEl) loadingEl.classList.remove("hidden");
  if (wikiArea) wikiArea.innerHTML = "";
  if (scrollArea) scrollArea.scrollTop = 0;
  const lang = punished ? "zh" : "en";
  try {
    const { title: resolvedTitle, html, sections } = await fetchWikiPage(title, lang);
    if (titleEl) titleEl.textContent = displayTitle || resolvedTitle;
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll("[title]").forEach(el => el.removeAttribute("title"));
    const existingTOC = tempDiv.querySelector("#toc,.toc,.mw-table-of-contents");
    if (existingTOC) existingTOC.remove();
    if (wikiArea) wikiArea.innerHTML = tempDiv.innerHTML;
    const tocCol = document.getElementById("wiki-toc-col");
    if (tocCol) {
      tocCol.innerHTML = "";
      if (sections && sections.length >= 3) { const toc = buildTOC(sections, wikiArea); if (toc) { tocCol.appendChild(toc); tocCol.classList.add("has-toc"); } else tocCol.classList.remove("has-toc"); }
      else tocCol.classList.remove("has-toc");
    }
    document.getElementById("game-current-article").textContent = displayTitle || resolvedTitle;
  } catch (err) { if (wikiArea) wikiArea.innerHTML = `<p style="color:#d33;padding:20px">Failed to load article. Try another link.</p>`; console.error(err); }
  finally { if (loadingEl) loadingEl.classList.add("hidden"); resumeTimer(); }
}

async function loadWikiPageNoHistory(title, displayTitle, restoreScrollY = 0) {
  pauseTimer();
  const wikiArea = document.getElementById("wiki-content"), titleEl = document.getElementById("wiki-page-title"), loadingEl = document.getElementById("wiki-loading"), scrollArea = document.getElementById("wiki-scroll-area");
  if (loadingEl) loadingEl.classList.remove("hidden");
  if (wikiArea) wikiArea.innerHTML = "";
  if (scrollArea) scrollArea.scrollTop = 0;
  const lang = punished ? "zh" : "en";
  try {
    const { title: resolvedTitle, html, sections } = await fetchWikiPage(title, lang);
    if (titleEl) titleEl.textContent = displayTitle || resolvedTitle;
    const tempDiv = document.createElement("div"); tempDiv.innerHTML = html;
    tempDiv.querySelectorAll("[title]").forEach(el => el.removeAttribute("title"));
    const existingTOC = tempDiv.querySelector("#toc,.toc,.mw-table-of-contents"); if (existingTOC) existingTOC.remove();
    if (wikiArea) wikiArea.innerHTML = tempDiv.innerHTML;
    const tocCol = document.getElementById("wiki-toc-col");
    if (tocCol) { tocCol.innerHTML = ""; if (sections && sections.length >= 3) { const toc = buildTOC(sections, wikiArea); if (toc) { tocCol.appendChild(toc); tocCol.classList.add("has-toc"); } else tocCol.classList.remove("has-toc"); } else tocCol.classList.remove("has-toc"); }
    document.getElementById("game-current-article").textContent = displayTitle || resolvedTitle;
    if (scrollArea && restoreScrollY > 0) requestAnimationFrame(() => { scrollArea.scrollTop = restoreScrollY; });
  } catch (err) { if (wikiArea) wikiArea.innerHTML = `<p style="color:#d33;padding:20px">Failed to load article.</p>`; }
  finally { if (loadingEl) loadingEl.classList.add("hidden"); resumeTimer(); }
}

// ─── Link tracking ────────────────────────────────────────────────────────────
function handleWikiClick(e) {
  const a = e.target.closest("a"); if (!a) return;
  e.preventDefault(); e.stopPropagation();
  const href = a.getAttribute("href"); if (!href) return;
  if (href.startsWith("#")) {
    const sectionId = href.slice(1), wikiArea = document.getElementById("wiki-content"), scrollArea = document.getElementById("wiki-scroll-area");
    if (!wikiArea || !scrollArea) return;
    const target = wikiArea.querySelector(`#${CSS.escape(sectionId)}`) || wikiArea.querySelector(`[id="${sectionId}"]`) || wikiArea.querySelector(`span[id="${sectionId}"]`);
    if (target) { const containerTop = scrollArea.getBoundingClientRect().top, targetTop = target.getBoundingClientRect().top; scrollArea.scrollTo({ top: targetTop - containerTop + scrollArea.scrollTop - 8, behavior: "smooth" }); }
    return;
  }
  const match = href.match(/\/wiki\/([^#?]+)/); if (!match) return;
  const rawTitle = decodeURIComponent(match[1]);
  if (BLOCKED_PREFIXES.some(p => rawTitle.startsWith(p))) return;
  if (a.classList.contains("new") || href.includes("redlink=1") || href.includes("action=edit")) return;
  if (a.classList.contains("external") || href.startsWith("http") || href.startsWith("//")) return;

  clickCount++;
  document.getElementById("game-click-count").textContent = clickCount;
  const displayName = rawTitle.replace(/_/g, " "), cleanUrl = "/wiki/" + match[1];
  document.getElementById("game-current-article").textContent = displayName;
  const scrollArea = document.getElementById("wiki-scroll-area");
  if (scrollArea && myPath.length > 0) myPath[myPath.length - 1].scrollY = scrollArea.scrollTop;
  myPath.push({ title: displayName, url: cleanUrl, scrollY: 0 });
  updatePathTrail(); updateBackButton();
  socket.emit("game:navigate", { article: displayName, url: cleanUrl });
  loadWikiPage(match[1], displayName);
}

// ─── Back button ─────────────────────────────────────────────────────────────
function goBack() {
  if (myPath.length <= 1) return;
  myPath.pop();
  const prev = myPath[myPath.length - 1];
  document.getElementById("game-current-article").textContent = prev.title;
  updatePathTrail(); updateBackButton();
  socket.emit("game:navigate", { article: prev.title, url: prev.url });
  loadWikiPageNoHistory(prev.url.split("/wiki/")[1], prev.title, prev.scrollY || 0);
}
function updateBackButton() { const btn = document.getElementById("btn-back"); if (!btn) return; btn.disabled = myPath.length <= 1; }

// ─── Path trail ───────────────────────────────────────────────────────────────
function updatePathTrail() {
  const trail = document.getElementById("path-trail"); if (!trail) return;
  trail.innerHTML = "";
  myPath.forEach((entry, i) => {
    if (i > 0) { const arrow = document.createElement("span"); arrow.className = "trail-arrow"; arrow.textContent = "›"; trail.appendChild(arrow); }
    const pill = document.createElement("span");
    pill.className = "trail-pill" + (i === myPath.length - 1 ? " trail-current" : "");
    pill.textContent = entry.title; trail.appendChild(pill);
  });
  trail.scrollLeft = trail.scrollWidth;
}

// ─── Search punishment ────────────────────────────────────────────────────────
function triggerPunishment() {
  if (punished) return; punished = true;
  showToast("⚠️ No searching! 30 seconds of Chinese Wikipedia!", "error");
  const banner = document.getElementById("punishment-banner"), timerEl = document.getElementById("punishment-timer");
  banner.classList.remove("hidden"); let remaining = 30; timerEl.textContent = remaining;
  const cur = myPath.length ? myPath[myPath.length - 1] : null;
  if (cur) loadWikiPage(cur.url.split("/wiki/")[1], cur.title);
  punishTimer = setInterval(() => { remaining--; timerEl.textContent = remaining; if (remaining <= 0) { clearInterval(punishTimer); punished = false; banner.classList.add("hidden"); showToast("Punishment over! Back to English.", "success"); const c = myPath.length ? myPath[myPath.length - 1] : null; if (c) loadWikiPage(c.url.split("/wiki/")[1], c.title); } }, 1000);
}

// ─── TOC builder ─────────────────────────────────────────────────────────────
function buildTOC(sections, wikiArea) {
  if (!sections || sections.length < 3) return null;
  const relevant = sections.filter(s => s.toclevel <= 2); if (relevant.length < 3) return null;
  const nav = document.createElement("nav"); nav.className = "custom-toc";
  const header = document.createElement("div"); header.className = "custom-toc-title"; header.textContent = "Contents";
  const toggle = document.createElement("button"); toggle.className = "custom-toc-toggle"; toggle.textContent = "hide";
  toggle.onclick = () => { const list = nav.querySelector(".custom-toc-list"); if (list) { const hidden = list.style.display === "none"; list.style.display = hidden ? "" : "none"; toggle.textContent = hidden ? "hide" : "show"; } };
  header.appendChild(toggle); nav.appendChild(header);
  const ul = document.createElement("ul"); ul.className = "custom-toc-list";
  relevant.forEach(section => {
    const li = document.createElement("li"); li.className = `custom-toc-item toc-level-${section.toclevel}`;
    const a = document.createElement("a"); a.href = `#${section.anchor}`; a.className = "custom-toc-link";
    const numSpan = document.createElement("span"); numSpan.className = "custom-toc-num"; numSpan.textContent = section.number + " ";
    const tmp = document.createElement("span"); tmp.innerHTML = section.line;
    const textSpan = document.createElement("span"); textSpan.textContent = tmp.textContent;
    a.appendChild(numSpan); a.appendChild(textSpan);
    a.addEventListener("click", e => { e.preventDefault(); const scrollArea = document.getElementById("wiki-scroll-area"); if (!scrollArea || !wikiArea) return; const target = wikiArea.querySelector(`#${CSS.escape(section.anchor)}`) || wikiArea.querySelector(`[id="${section.anchor}"]`) || wikiArea.querySelector(`span[id="${section.anchor}"]`); if (target) { const containerTop = scrollArea.getBoundingClientRect().top, targetTop = target.getBoundingClientRect().top; scrollArea.scrollTo({ top: targetTop - containerTop + scrollArea.scrollTop - 8, behavior: "smooth" }); } });
    li.appendChild(a); ul.appendChild(li);
  });
  nav.appendChild(ul); return nav;
}

// ─── Game guard ───────────────────────────────────────────────────────────────
function enableGameGuard() {
  inGame = true; history.pushState({ gameActive: true }, "");
  window.addEventListener("popstate", handlePopstate);
  window.addEventListener("beforeunload", handleBeforeUnload);
}
function disableGameGuard() {
  inGame = false;
  window.removeEventListener("popstate", handlePopstate);
  window.removeEventListener("beforeunload", handleBeforeUnload);
}
function handlePopstate(e) { if (!inGame) return; history.pushState({ gameActive: true }, ""); showToast("Can't go back — you're in a race!", "warning"); }
function handleBeforeUnload(e) { if (!inGame) return; e.preventDefault(); e.returnValue = "You're in a race!"; return e.returnValue; }

// ─── Win / Game over ─────────────────────────────────────────────────────────
socket.on("game:won", ({ clicks, time }) => { stopTimer(); disableGameGuard(); const s = Math.floor(time / 1000); showToast(`🏆 You won in ${clicks} clicks (${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")})!`, "success"); });

socket.on("game:over", ({ leaderboard, winner }) => {
  stopTimer(); disableGameGuard();
  const overlay = document.getElementById("overlay-gameover"), list = document.getElementById("gameover-leaderboard"), title = document.getElementById("gameover-title"), result = document.getElementById("gameover-your-result"), playBtn = document.getElementById("btn-play-again"), pathDiv = document.getElementById("gameover-winner-path");
  list.innerHTML = ""; overlay.classList.remove("hidden");
  const me = leaderboard.find(p => p.id === socket.id), iWon = me && me.finished && me.rank === 1;
  result.textContent = iWon ? "🏆" : "😔"; title.textContent = iWon ? "You Won!" : `${winner?.name || "Someone"} Won!`;
  if (winner?.articlePath?.length > 0) { pathDiv.classList.remove("hidden"); pathDiv.innerHTML = `<div class="winner-path-label">🏆 ${winner.name}'s winning path (${winner.clicks} clicks):</div><div class="winner-path-pills">${winner.articlePath.map((a, i) => `<span class="winner-pill${i === winner.articlePath.length - 1 ? " winner-pill-last" : ""}">${a}</span>` + (i < winner.articlePath.length - 1 ? '<span class="winner-arrow">›</span>' : '')).join('')}</div>`; }
  else pathDiv.classList.add("hidden");
  const rankEmojis = ["🥇", "🥈", "🥉"];
  leaderboard.forEach((p, i) => { const li = document.createElement("li"); li.className = "gameover-item" + (i < 3 ? ` podium-${i + 1}` : ""); const rankEl = document.createElement("span"); rankEl.className = "gameover-rank-emoji"; rankEl.textContent = rankEmojis[i] || `#${i + 1}`; const nameEl = document.createElement("span"); nameEl.className = "gameover-player-name"; nameEl.textContent = p.name + (p.id === socket.id ? " (you)" : ""); const statsEl = document.createElement("span"); statsEl.className = p.finished ? "gameover-player-stats" : "gameover-dnf"; if (p.finished) { const s = Math.floor(p.finishTime / 1000); statsEl.textContent = `${p.clicks} clicks · ${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`; } else statsEl.textContent = `${p.clicks} clicks — Did not finish`; li.appendChild(rankEl); li.appendChild(nameEl); li.appendChild(statsEl); list.appendChild(li); });
  if (isHost) playBtn.classList.remove("hidden"); else playBtn.classList.add("hidden");
});

socket.on("game:reset", () => { stopTimer(); disableGameGuard(); document.getElementById("overlay-gameover").classList.add("hidden"); if (punishTimer) clearInterval(punishTimer); punished = false; document.getElementById("punishment-banner").classList.add("hidden"); const sb = document.getElementById("game-scoreboard"); if (sb) sb.innerHTML = ""; showScreen("lobby"); });

// ─── Avatar colors ────────────────────────────────────────────────────────────
const AVATAR_COLORS = ["#3366CC", "#2E7D32", "#6A1B9A", "#C62828", "#AD6800", "#00695C", "#1565C0", "#4527A0", "#558B2F", "#BF360C"];
function avatarColor(name) { let hash = 0; for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash); return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]; }