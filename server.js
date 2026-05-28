// =============================================================================
// Shabaknap - Nehiza or Zingur
// Server: WebSocket game server, multi-room
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// HTTP Server — serves static files from public/
// -----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // HTTP state fallback — independent of the WebSocket. Mobile Chrome freezes
  // a backgrounded tab's JS and silently kills its socket; when that socket
  // wedges (stays OPEN but delivers nothing), every WS-based recovery path is
  // dead and only a manual reload helps. This plain GET lets the client pull
  // fresh state over a transport that mobile handles reliably — automating
  // exactly what a refresh does. Keyed by the player's token.
  if (req.url && req.url.startsWith('/api/state')) {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const entry = token && tokenMap[token];
    const room = entry && rooms[entry.pin];
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (!room || !getPlayer(room, entry.playerId)) {
      res.writeHead(404, headers);
      res.end(JSON.stringify({ type: 'error', message: 'Room not found' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      type: 'state',
      data: sanitizeState(room, entry.playerId),
      yourId: entry.playerId,
    }));
    return;
  }

  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // HTML must never be cached — that way every fresh visit picks up the
  // latest deploy. Audio/images can sit in the browser cache (the names
  // are stable; we re-run the generator if we want different sound).
  const cacheHeaders = (ext === '.html' || !ext)
    ? { 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
    : { 'Cache-Control': 'public, max-age=3600' };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html', ...cacheHeaders });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, ...cacheHeaders });
    res.end(data);
  });
});

// -----------------------------------------------------------------------------
// WebSocket Server + Heartbeat
// -----------------------------------------------------------------------------
// Disable permessage-deflate. Compression batches small frames waiting for
// a fuller payload, which on mobile carriers + Cloudflare ends up adding
// seconds of latency to every broadcast. Our state messages are a few KB
// at most — not worth compressing.
const wss = new WebSocketServer({ server, perMessageDeflate: false });
const HEARTBEAT_INTERVAL_MS = 30000;

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => { clearInterval(heartbeatInterval); });

const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F1948A', '#82E0AA', '#F8C471', '#AED6F1', '#D7BDE2',
  '#A3E4D7', '#FAD7A0', '#D5F5E3', '#FADBD8', '#D6EAF8',
];

// -----------------------------------------------------------------------------
// Multi-room state
// -----------------------------------------------------------------------------
const rooms = {};                // pin -> room
const tokenMap = {};             // token -> { pin, playerId }
const playerSockets = {};        // playerId -> ws
const phaseTimers = {};          // pin -> Timeout (kept off the room so JSON.stringify won't choke on the circular Timeout object)
const hostGraceTimers = {};      // pin -> Timeout: wait before transferring host away from a briefly-disconnected host
const HOST_GRACE_MS = 30000;

function createFreshRound() {
  return {
    initiator: null,
    title: '',
    description: '',
    votes: {},
    attendTeam: [],
    zingurTeam: [],
    losingTeam: [],
    excuses: {},
    eliminationVotes: {},
    timerEnd: null,
    candidates: [],
  };
}

function createRoom(pin) {
  return {
    pin,
    phase: 'LOBBY',
    players: [],
    hostId: null,
    round: createFreshRound(),
    winners: [],
    eliminatedLog: [],
    roundNumber: 0,
    gameStarted: false,
  };
}

function generateToken() { return crypto.randomBytes(16).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }

function generatePin() {
  for (let i = 0; i < 200; i++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms[pin]) return pin;
  }
  throw new Error('Could not generate unique PIN');
}

function getRoom(ws) { return ws._pin ? rooms[ws._pin] : null; }
function getPlayer(room, id) { return room.players.find(p => p.id === id); }
function getAlivePlayers(room) { return room.players.filter(p => p.alive); }

function sanitizeState(room, forPlayerId) {
  const state = JSON.parse(JSON.stringify(room));

  if (state.phase === 'VOTING') {
    state.round.votes = {};
  }
  if (state.phase === 'ELIMINATION' || state.phase === 'RUNOFF') {
    state.round.eliminationVotes = {};
  }
  if (forPlayerId && room.phase === 'VOTING' && room.round.votes[forPlayerId]) {
    state.round.myVote = room.round.votes[forPlayerId];
  }
  if (forPlayerId && (room.phase === 'ELIMINATION' || room.phase === 'RUNOFF') && room.round.eliminationVotes[forPlayerId]) {
    state.round.myEliminationVote = room.round.eliminationVotes[forPlayerId];
  }
  return state;
}

function broadcast(room) {
  if (!room) return;
  room.players.forEach(p => {
    const ws = playerSockets[p.id];
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'state', data: sanitizeState(room, p.id), yourId: p.id }));
    }
  });
}

function sendError(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'error', message: msg }));
  }
}

function clearPhaseTimer(room) {
  const t = phaseTimers[room.pin];
  if (t) { clearTimeout(t); delete phaseTimers[room.pin]; }
}

function setPhaseTimer(room, seconds, callback) {
  clearPhaseTimer(room);
  room.round.timerEnd = Date.now() + seconds * 1000;
  phaseTimers[room.pin] = setTimeout(() => {
    delete phaseTimers[room.pin];
    callback();
  }, seconds * 1000);
}

function updateHasVoted(room) {
  room.players.forEach(p => {
    if (room.phase === 'VOTING') {
      p.hasVoted = !!room.round.votes[p.id];
    } else if (room.phase === 'ELIMINATION' || room.phase === 'RUNOFF') {
      p.hasVoted = !!room.round.eliminationVotes[p.id];
    } else {
      p.hasVoted = false;
    }
  });
}

// -----------------------------------------------------------------------------
// Phase Transitions
// -----------------------------------------------------------------------------

function transitionToVoting(room, initiatorId, title, description) {
  room.phase = 'VOTING';
  room.roundNumber++;
  room.round = createFreshRound();
  room.round.initiator = initiatorId;
  room.round.title = title;
  room.round.description = description;

  room.round.votes[initiatorId] = 'attend';
  updateHasVoted(room);

  setPhaseTimer(room, 60, () => {
    getAlivePlayers(room).forEach(p => {
      if (!room.round.votes[p.id]) room.round.votes[p.id] = 'zingur';
    });
    updateHasVoted(room);
    transitionToVotingResults(room);
  });

  broadcast(room);
}

function checkAllVoted(room) {
  return getAlivePlayers(room).every(p => room.round.votes[p.id]);
}

function transitionToVotingResults(room) {
  clearPhaseTimer(room);
  room.phase = 'VOTING_RESULTS';

  const alive = getAlivePlayers(room);
  room.round.attendTeam = [];
  room.round.zingurTeam = [];

  alive.forEach(p => {
    const vote = room.round.votes[p.id] || 'zingur';
    if (vote === 'attend') room.round.attendTeam.push(p.id);
    else room.round.zingurTeam.push(p.id);
  });

  if (room.round.attendTeam.length <= room.round.zingurTeam.length) {
    if (room.round.attendTeam.length < room.round.zingurTeam.length) {
      room.round.losingTeam = [...room.round.attendTeam];
    } else {
      room.round.losingTeam = [...room.round.zingurTeam];
    }
  } else {
    room.round.losingTeam = [...room.round.zingurTeam];
  }

  if (room.round.losingTeam.length === 0) {
    setPhaseTimer(room, 5, () => {
      room.phase = 'LOBBY';
      room.round.timerEnd = null;
      broadcast(room);
    });
    broadcast(room);
    return;
  }

  if (room.round.losingTeam.length === 1) {
    setPhaseTimer(room, 5, () => {
      eliminatePlayer(room, room.round.losingTeam[0], 'Auto-eliminated (solo on losing team)');
      checkGameOver(room);
    });
    broadcast(room);
    return;
  }

  setPhaseTimer(room, 5, () => { transitionToExcuse(room); });
  broadcast(room);
}

function transitionToExcuse(room) {
  room.phase = 'EXCUSE';
  room.round.excuses = {};
  room.round.candidates = [...room.round.losingTeam];

  setPhaseTimer(room, 60, () => {
    room.round.candidates.forEach(id => {
      if (!room.round.excuses[id]) room.round.excuses[id] = '(No excuse submitted)';
    });
    transitionToElimination(room);
  });

  broadcast(room);
}

function checkAllExcusesSubmitted(room) {
  return room.round.candidates.every(id => room.round.excuses[id]);
}

function transitionToElimination(room) {
  clearPhaseTimer(room);
  room.phase = 'ELIMINATION';
  room.round.eliminationVotes = {};
  updateHasVoted(room);

  setPhaseTimer(room, 60, () => { resolveElimination(room); });
  broadcast(room);
}

function checkAllEliminationVoted(room) {
  return getAlivePlayers(room).every(p => room.round.eliminationVotes[p.id]);
}

function resolveElimination(room) {
  clearPhaseTimer(room);

  const voteCounts = {};
  room.round.candidates.forEach(id => { voteCounts[id] = 0; });
  Object.values(room.round.eliminationVotes).forEach(votedFor => {
    if (voteCounts[votedFor] !== undefined) voteCounts[votedFor]++;
  });

  const maxVotes = Math.max(...Object.values(voteCounts));
  const tied = Object.entries(voteCounts)
    .filter(([_, count]) => count === maxVotes)
    .map(([id]) => id);

  if (tied.length === 1) {
    eliminatePlayer(room, tied[0], 'Voted out');
    checkGameOver(room);
  } else if (room.phase !== 'RUNOFF' && tied.length > 1) {
    transitionToRunoff(room, tied);
  } else {
    const randomIdx = Math.floor(Math.random() * tied.length);
    eliminatePlayer(room, tied[randomIdx], 'Randomly eliminated after tie');
    checkGameOver(room);
  }
}

function transitionToRunoff(room, tiedPlayerIds) {
  room.phase = 'RUNOFF';
  room.round.candidates = [...tiedPlayerIds];
  room.round.eliminationVotes = {};
  updateHasVoted(room);

  setPhaseTimer(room, 60, () => { resolveRunoff(room); });
  broadcast(room);
}

function resolveRunoff(room) {
  clearPhaseTimer(room);

  const voteCounts = {};
  room.round.candidates.forEach(id => { voteCounts[id] = 0; });
  Object.values(room.round.eliminationVotes).forEach(votedFor => {
    if (voteCounts[votedFor] !== undefined) voteCounts[votedFor]++;
  });

  const maxVotes = Math.max(...Object.values(voteCounts));
  const tied = Object.entries(voteCounts)
    .filter(([_, count]) => count === maxVotes)
    .map(([id]) => id);

  if (tied.length === 1) {
    eliminatePlayer(room, tied[0], 'Voted out in runoff');
  } else {
    const randomIdx = Math.floor(Math.random() * tied.length);
    eliminatePlayer(room, tied[randomIdx], 'Randomly eliminated after runoff tie');
  }
  checkGameOver(room);
}

function eliminatePlayer(room, playerId, reason) {
  const player = getPlayer(room, playerId);
  if (player) {
    player.alive = false;
    room.eliminatedLog.push({
      id: playerId,
      nickname: player.nickname,
      reason,
      round: room.roundNumber,
    });
  }
}

function checkGameOver(room) {
  const alive = getAlivePlayers(room);
  if (alive.length <= 2) {
    room.phase = 'GAME_OVER';
    room.winners = alive.map(p => p.id);
    room.round.timerEnd = null;
    clearPhaseTimer(room);
    broadcast(room);
  } else {
    room.phase = 'LOBBY';
    room.round = createFreshRound();
    room.gameStarted = true;
    broadcast(room);
  }
}

// -----------------------------------------------------------------------------
// Message Handlers
// -----------------------------------------------------------------------------

function makePlayer(room, id, nickname) {
  return {
    id,
    nickname,
    color: COLORS[room.players.length % COLORS.length],
    alive: true,
    connected: true,
    hasVoted: false,
  };
}

function attachPlayer(ws, room, player, token) {
  tokenMap[token] = { pin: room.pin, playerId: player.id };
  playerSockets[player.id] = ws;
  ws._playerId = player.id;
  ws._token = token;
  ws._pin = room.pin;
  ws.send(JSON.stringify({ type: 'token', token, playerId: player.id, pin: room.pin }));
}

function tryReconnect(ws, data) {
  if (!data.token || !tokenMap[data.token]) return false;
  const { pin, playerId } = tokenMap[data.token];
  const room = rooms[pin];
  if (!room) return false;
  const player = getPlayer(room, playerId);
  if (!player) return false;

  player.connected = true;
  playerSockets[playerId] = ws;
  ws._playerId = playerId;
  ws._token = data.token;
  ws._pin = pin;

  // If the host is returning, cancel any pending host transfer.
  if (room.hostId === playerId && hostGraceTimers[pin]) {
    clearTimeout(hostGraceTimers[pin]);
    delete hostGraceTimers[pin];
  }

  ws.send(JSON.stringify({ type: 'token', token: data.token, playerId, pin }));
  broadcast(room);
  return true;
}

function handleCreateRoom(ws, data) {
  if (tryReconnect(ws, data)) return;

  const nickname = (data.nickname || '').trim().substring(0, 20);
  if (!nickname) return sendError(ws, 'Nickname is required');

  const pin = generatePin();
  const room = createRoom(pin);
  rooms[pin] = room;

  const id = generateId();
  const token = generateToken();
  const player = makePlayer(room, id, nickname);
  room.players.push(player);
  room.hostId = id;

  attachPlayer(ws, room, player, token);
  broadcast(room);
}

function handleJoinRoom(ws, data) {
  if (tryReconnect(ws, data)) return;

  const nickname = (data.nickname || '').trim().substring(0, 20);
  const pin = (data.pin || '').trim();
  if (!nickname) return sendError(ws, 'Nickname is required');
  if (!pin) return sendError(ws, 'PIN is required');

  const room = rooms[pin];
  if (!room) return sendError(ws, 'Room not found. Check the PIN.');

  if (room.phase !== 'LOBBY' && room.gameStarted) {
    return sendError(ws, 'Game is in progress. Cannot join now.');
  }

  if (room.players.find(p => p.nickname.toLowerCase() === nickname.toLowerCase() && p.connected)) {
    return sendError(ws, 'That nickname is already taken in this room');
  }

  const id = generateId();
  const token = generateToken();
  const player = makePlayer(room, id, nickname);
  room.players.push(player);

  attachPlayer(ws, room, player, token);
  broadcast(room);
}

function handleLeaveRoom(ws) {
  const room = getRoom(ws);
  const playerId = ws._playerId;
  if (!room || !playerId) return;

  // Take the player out for good — drop from room, sockets, and token map.
  room.players = room.players.filter(p => p.id !== playerId);
  delete playerSockets[playerId];
  if (ws._token) delete tokenMap[ws._token];
  ws._playerId = null;
  ws._token = null;
  ws._pin = null;

  // If the host just left, transfer immediately (no grace period — this
  // wasn't a network blip, they actively left).
  if (room.hostId === playerId) {
    if (hostGraceTimers[room.pin]) {
      clearTimeout(hostGraceTimers[room.pin]);
      delete hostGraceTimers[room.pin];
    }
    const newHost = room.players.find(p => p.connected);
    room.hostId = newHost ? newHost.id : null;
  }

  // If nobody is left, drop the room entirely.
  if (room.players.length === 0) {
    clearPhaseTimer(room);
    if (hostGraceTimers[room.pin]) {
      clearTimeout(hostGraceTimers[room.pin]);
      delete hostGraceTimers[room.pin];
    }
    delete rooms[room.pin];
    return;
  }

  broadcast(room);
}

function handleStartGame(ws) {
  const room = getRoom(ws);
  if (!room) return sendError(ws, 'Not in a room');
  const playerId = ws._playerId;
  if (playerId !== room.hostId) return sendError(ws, 'Only the host can start the game');
  if (room.phase !== 'LOBBY') return sendError(ws, 'Can only start from lobby');
  if (room.gameStarted) return; // already started — no-op

  const alive = getAlivePlayers(room);
  if (alive.length < 3) return sendError(ws, 'Need at least 3 players to start');

  // Open the floor — anyone alive can now initiate the first event.
  // First to send `initiate` wins (Node processes WS messages serially).
  room.gameStarted = true;
  broadcast(room);
}

function handleInitiate(ws, data) {
  const room = getRoom(ws);
  if (!room) return sendError(ws, 'Not in a room');
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  const player = getPlayer(room, playerId);
  if (!player || !player.alive) return sendError(ws, 'You are not an active player');
  if (room.phase !== 'LOBBY') return sendError(ws, 'Can only initiate during lobby phase');
  if (!room.gameStarted) return sendError(ws, 'Host has not started the game yet');

  const alive = getAlivePlayers(room);
  if (alive.length < 3) return sendError(ws, 'Need at least 3 alive players');

  const title = (data.title || '').trim().substring(0, 100);
  const description = (data.description || '').trim().substring(0, 500);
  if (!title) return sendError(ws, 'Event title is required');

  transitionToVoting(room, playerId, title, description);
}

function handleVote(ws, data) {
  const room = getRoom(ws);
  if (!room) return sendError(ws, 'Not in a room');
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  const player = getPlayer(room, playerId);
  if (!player || !player.alive) return sendError(ws, 'You are not an active player');
  if (room.phase !== 'VOTING') return sendError(ws, 'Not in voting phase');
  if (playerId === room.round.initiator) return sendError(ws, 'Initiator always attends');

  const vote = data.vote === 'attend' ? 'attend' : 'zingur';
  room.round.votes[playerId] = vote;
  updateHasVoted(room);
  broadcast(room);

  if (checkAllVoted(room)) transitionToVotingResults(room);
}

function handleExcuse(ws, data) {
  const room = getRoom(ws);
  if (!room) return sendError(ws, 'Not in a room');
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  if (room.phase !== 'EXCUSE') return sendError(ws, 'Not in excuse phase');
  if (!room.round.candidates.includes(playerId)) return sendError(ws, 'You are not on the losing team');

  const excuse = (data.excuse || '').trim().substring(0, 500);
  room.round.excuses[playerId] = excuse || '(No excuse)';
  broadcast(room);

  if (checkAllExcusesSubmitted(room)) transitionToElimination(room);
}

function handleEliminateVote(ws, data) {
  const room = getRoom(ws);
  if (!room) return sendError(ws, 'Not in a room');
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  const player = getPlayer(room, playerId);
  if (!player || !player.alive) return sendError(ws, 'You are not an active player');
  if (room.phase !== 'ELIMINATION' && room.phase !== 'RUNOFF') return sendError(ws, 'Not in elimination phase');

  const target = data.target;
  if (!room.round.candidates.includes(target)) return sendError(ws, 'Invalid elimination target');

  room.round.eliminationVotes[playerId] = target;
  updateHasVoted(room);
  broadcast(room);

  if (checkAllEliminationVoted(room)) {
    if (room.phase === 'ELIMINATION') resolveElimination(room);
    else resolveRunoff(room);
  }
}

function handleRestart(ws) {
  const room = getRoom(ws);
  if (!room) return sendError(ws, 'Not in a room');
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');
  if (playerId !== room.hostId) return sendError(ws, 'Only the host can start a new game');

  if (room.phase !== 'GAME_OVER' && room.phase !== 'LOBBY') {
    return sendError(ws, 'Can only restart from game over or lobby');
  }

  clearPhaseTimer(room);

  const newPlayers = room.players.filter(p => p.connected).map(p => ({
    ...p, alive: true, hasVoted: false,
  }));

  const fresh = createRoom(room.pin);
  fresh.hostId = room.hostId;
  fresh.players = newPlayers;
  rooms[room.pin] = fresh;

  broadcast(fresh);
}

// -----------------------------------------------------------------------------
// WebSocket Connection
// -----------------------------------------------------------------------------

wss.on('connection', (ws, req) => {
  // Nagle batches small writes for up to 200ms waiting for more data —
  // exactly the wrong behavior for a real-time game with tiny frames.
  if (req && req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (e) { return sendError(ws, 'Invalid message format'); }

    switch (msg.type) {
      case 'create_room': handleCreateRoom(ws, msg); break;
      case 'join_room':   handleJoinRoom(ws, msg);   break;
      case 'reconnect':
        if (!tryReconnect(ws, msg)) sendError(ws, 'Could not reconnect — room may have ended');
        break;
      case 'start_game':  handleStartGame(ws);       break;
      case 'leave_room':  handleLeaveRoom(ws);       break;
      case 'initiate':    handleInitiate(ws, msg);   break;
      case 'vote':        handleVote(ws, msg);       break;
      case 'excuse':      handleExcuse(ws, msg);     break;
      case 'eliminate_vote': handleEliminateVote(ws, msg); break;
      case 'restart':     handleRestart(ws);         break;
      case 'ping':
        ws.isAlive = true;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'request_state': {
        // Safety net: client polls for state in case a broadcast was dropped
        // somewhere between the server and the device (Cloudflare hiccup,
        // mobile radio glitch, etc.). Re-send the current state to *just*
        // this client.
        const r = getRoom(ws);
        if (r && ws._playerId && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'state',
            data: sanitizeState(r, ws._playerId),
            yourId: ws._playerId,
          }));
        }
        break;
      }
      default:
        sendError(ws, 'Unknown message type');
    }
  });

  ws.on('close', () => {
    const playerId = ws._playerId;
    const room = getRoom(ws);
    if (!room || !playerId) return;

    // Race guard: a fresh reconnect from the same player may have already
    // taken over playerSockets[playerId]. If so, the old socket closing is
    // not a real disconnect — ignore it.
    if (playerSockets[playerId] !== ws) return;

    const player = getPlayer(room, playerId);
    if (player) player.connected = false;
    delete playerSockets[playerId];

    // Grace period for host transfer — mobile briefly drops the socket on
    // backgrounding/network flips, and we don't want to demote the host
    // every time their phone sleeps.
    if (room.hostId === playerId) {
      if (hostGraceTimers[room.pin]) clearTimeout(hostGraceTimers[room.pin]);
      hostGraceTimers[room.pin] = setTimeout(() => {
        delete hostGraceTimers[room.pin];
        const r = rooms[room.pin];
        if (!r) return;
        const stillHost = getPlayer(r, r.hostId);
        if (!stillHost || !stillHost.connected) {
          const newHost = r.players.find(p => p.connected);
          if (newHost) {
            r.hostId = newHost.id;
            broadcast(r);
          }
        }
      }, HOST_GRACE_MS);
    }

    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Shabaknap server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your mobile browser`);
});
