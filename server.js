// =============================================================================
// Shabaknap - Nehiza or Zingur
// Server: WebSocket game server with full state machine
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
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html for SPA-like behavior
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// -----------------------------------------------------------------------------
// WebSocket Server
// -----------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

// -----------------------------------------------------------------------------
// Color palette for players
// -----------------------------------------------------------------------------
const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F1948A', '#82E0AA', '#F8C471', '#AED6F1', '#D7BDE2',
  '#A3E4D7', '#FAD7A0', '#D5F5E3', '#FADBD8', '#D6EAF8',
];

// -----------------------------------------------------------------------------
// Game State
// -----------------------------------------------------------------------------
let game = createFreshGame();

function createFreshGame() {
  return {
    phase: 'LOBBY',
    players: [],
    round: createFreshRound(),
    winners: [],
    eliminatedLog: [],
    roundNumber: 0,
    gameStarted: false,
  };
}

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

// Map from token -> player id
const tokenMap = {};
// Map from player id -> WebSocket
const playerSockets = {};
// Active timer reference
let phaseTimer = null;

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function getAlivePlayers() {
  return game.players.filter(p => p.alive);
}

function getAliveConnectedPlayers() {
  return game.players.filter(p => p.alive && p.connected);
}

function getPlayer(id) {
  return game.players.find(p => p.id === id);
}

// Build the state object to send to clients.
// During VOTING, hide what players voted (but show who has voted).
function sanitizeState(forPlayerId) {
  const state = JSON.parse(JSON.stringify(game));

  // During active voting phases, hide vote values
  if (state.phase === 'VOTING') {
    state.round.votes = {};
    // But indicate who has voted via hasVoted on each player
  }

  // During ELIMINATION or RUNOFF, hide who voted for whom
  if (state.phase === 'ELIMINATION' || state.phase === 'RUNOFF') {
    state.round.eliminationVotes = {};
  }

  // Add the requesting player's own vote back so they can see their selection
  if (forPlayerId && game.phase === 'VOTING' && game.round.votes[forPlayerId]) {
    state.round.myVote = game.round.votes[forPlayerId];
  }

  if (forPlayerId && (game.phase === 'ELIMINATION' || game.phase === 'RUNOFF') && game.round.eliminationVotes[forPlayerId]) {
    state.round.myEliminationVote = game.round.eliminationVotes[forPlayerId];
  }

  return state;
}

function broadcast() {
  game.players.forEach(p => {
    const ws = playerSockets[p.id];
    if (ws && ws.readyState === 1) {
      const state = sanitizeState(p.id);
      ws.send(JSON.stringify({ type: 'state', data: state, yourId: p.id }));
    }
  });
}

function sendError(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'error', message: msg }));
  }
}

function clearPhaseTimer() {
  if (phaseTimer) {
    clearTimeout(phaseTimer);
    phaseTimer = null;
  }
}

function setPhaseTimer(seconds, callback) {
  clearPhaseTimer();
  game.round.timerEnd = Date.now() + seconds * 1000;
  phaseTimer = setTimeout(() => {
    phaseTimer = null;
    callback();
  }, seconds * 1000);
}

// Mark hasVoted on player objects (used for UI indicator)
function updateHasVoted() {
  game.players.forEach(p => {
    if (game.phase === 'VOTING') {
      p.hasVoted = !!game.round.votes[p.id];
    } else if (game.phase === 'ELIMINATION' || game.phase === 'RUNOFF') {
      p.hasVoted = !!game.round.eliminationVotes[p.id];
    } else {
      p.hasVoted = false;
    }
  });
}

// -----------------------------------------------------------------------------
// Phase Transitions
// -----------------------------------------------------------------------------

function transitionToVoting(initiatorId, title, description) {
  game.phase = 'VOTING';
  game.roundNumber++;
  game.round = createFreshRound();
  game.round.initiator = initiatorId;
  game.round.title = title;
  game.round.description = description;

  // Initiator is auto-voted as "attend"
  game.round.votes[initiatorId] = 'attend';
  updateHasVoted();

  setPhaseTimer(60, () => {
    // Non-voters default to zingur
    getAlivePlayers().forEach(p => {
      if (!game.round.votes[p.id]) {
        game.round.votes[p.id] = 'zingur';
      }
    });
    updateHasVoted();
    transitionToVotingResults();
  });

  broadcast();
}

function checkAllVoted() {
  const alive = getAlivePlayers();
  return alive.every(p => game.round.votes[p.id]);
}

function transitionToVotingResults() {
  clearPhaseTimer();
  game.phase = 'VOTING_RESULTS';

  // Build teams
  const alive = getAlivePlayers();
  game.round.attendTeam = [];
  game.round.zingurTeam = [];

  alive.forEach(p => {
    const vote = game.round.votes[p.id] || 'zingur';
    if (vote === 'attend') {
      game.round.attendTeam.push(p.id);
    } else {
      game.round.zingurTeam.push(p.id);
    }
  });

  // Determine losing team: team with FEWER votes loses.
  // If equal, ZINGUR team loses.
  if (game.round.attendTeam.length <= game.round.zingurTeam.length) {
    // Attend team is smaller or equal — but if equal, zingur loses
    if (game.round.attendTeam.length < game.round.zingurTeam.length) {
      game.round.losingTeam = [...game.round.attendTeam];
    } else {
      // Equal — zingur loses
      game.round.losingTeam = [...game.round.zingurTeam];
    }
  } else {
    // Zingur team is smaller
    game.round.losingTeam = [...game.round.zingurTeam];
  }

  // If losing team is empty (everyone voted the same way), no elimination needed
  if (game.round.losingTeam.length === 0) {
    // Back to lobby after brief display
    setPhaseTimer(5, () => {
      game.phase = 'LOBBY';
      game.round.timerEnd = null;
      broadcast();
    });
    broadcast();
    return;
  }

  // If losing team has only 1 member — auto-eliminate, skip excuse phase
  if (game.round.losingTeam.length === 1) {
    setPhaseTimer(5, () => {
      eliminatePlayer(game.round.losingTeam[0], 'Auto-eliminated (solo on losing team)');
      checkGameOver();
    });
    broadcast();
    return;
  }

  // Otherwise, proceed to excuse phase after brief display
  setPhaseTimer(5, () => {
    transitionToExcuse();
  });

  broadcast();
}

function transitionToExcuse() {
  game.phase = 'EXCUSE';
  game.round.excuses = {};
  game.round.candidates = [...game.round.losingTeam];

  setPhaseTimer(60, () => {
    // Players who didn't submit get empty excuse
    game.round.candidates.forEach(id => {
      if (!game.round.excuses[id]) {
        game.round.excuses[id] = '(No excuse submitted)';
      }
    });
    transitionToElimination();
  });

  broadcast();
}

function checkAllExcusesSubmitted() {
  return game.round.candidates.every(id => game.round.excuses[id]);
}

function transitionToElimination() {
  clearPhaseTimer();
  game.phase = 'ELIMINATION';
  game.round.eliminationVotes = {};
  updateHasVoted();

  setPhaseTimer(60, () => {
    resolveElimination();
  });

  broadcast();
}

function checkAllEliminationVoted() {
  const alive = getAlivePlayers();
  return alive.every(p => game.round.eliminationVotes[p.id]);
}

function resolveElimination() {
  clearPhaseTimer();

  const alive = getAlivePlayers();

  // Count votes for each candidate
  const voteCounts = {};
  game.round.candidates.forEach(id => { voteCounts[id] = 0; });

  // Count actual votes
  Object.values(game.round.eliminationVotes).forEach(votedFor => {
    if (voteCounts[votedFor] !== undefined) {
      voteCounts[votedFor]++;
    }
  });

  // Non-voters: don't count them (they simply abstained)

  // Find max votes
  const maxVotes = Math.max(...Object.values(voteCounts));
  const tied = Object.entries(voteCounts)
    .filter(([id, count]) => count === maxVotes)
    .map(([id]) => id);

  if (tied.length === 1) {
    // Clear winner (loser, actually)
    eliminatePlayer(tied[0], 'Voted out');
    checkGameOver();
  } else if (game.phase !== 'RUNOFF' && tied.length > 1) {
    // Need runoff
    transitionToRunoff(tied);
  } else {
    // Already in runoff or still tied — random elimination
    const randomIdx = Math.floor(Math.random() * tied.length);
    eliminatePlayer(tied[randomIdx], 'Randomly eliminated after tie');
    checkGameOver();
  }
}

function transitionToRunoff(tiedPlayerIds) {
  game.phase = 'RUNOFF';
  game.round.candidates = [...tiedPlayerIds];
  game.round.eliminationVotes = {};
  updateHasVoted();

  setPhaseTimer(60, () => {
    resolveRunoff();
  });

  broadcast();
}

function resolveRunoff() {
  clearPhaseTimer();

  const voteCounts = {};
  game.round.candidates.forEach(id => { voteCounts[id] = 0; });

  Object.values(game.round.eliminationVotes).forEach(votedFor => {
    if (voteCounts[votedFor] !== undefined) {
      voteCounts[votedFor]++;
    }
  });

  const maxVotes = Math.max(...Object.values(voteCounts));
  const tied = Object.entries(voteCounts)
    .filter(([id, count]) => count === maxVotes)
    .map(([id]) => id);

  if (tied.length === 1) {
    eliminatePlayer(tied[0], 'Voted out in runoff');
  } else {
    // Still tied — random
    const randomIdx = Math.floor(Math.random() * tied.length);
    eliminatePlayer(tied[randomIdx], 'Randomly eliminated after runoff tie');
  }
  checkGameOver();
}

function eliminatePlayer(playerId, reason) {
  const player = getPlayer(playerId);
  if (player) {
    player.alive = false;
    game.eliminatedLog.push({
      id: playerId,
      nickname: player.nickname,
      reason: reason,
      round: game.roundNumber,
    });
  }
}

function checkGameOver() {
  const alive = getAlivePlayers();
  if (alive.length <= 2) {
    game.phase = 'GAME_OVER';
    game.winners = alive.map(p => p.id);
    game.round.timerEnd = null;
    clearPhaseTimer();
    broadcast();
  } else {
    // Back to lobby
    game.phase = 'LOBBY';
    game.round = createFreshRound();
    game.gameStarted = true;
    broadcast();
  }
}

// -----------------------------------------------------------------------------
// WebSocket Message Handlers
// -----------------------------------------------------------------------------

function handleJoin(ws, data) {
  const nickname = (data.nickname || '').trim().substring(0, 20);
  if (!nickname) {
    return sendError(ws, 'Nickname is required');
  }

  // Check for reconnection via token
  if (data.token && tokenMap[data.token]) {
    const existingId = tokenMap[data.token];
    const existingPlayer = getPlayer(existingId);
    if (existingPlayer) {
      existingPlayer.connected = true;
      playerSockets[existingId] = ws;
      ws._playerId = existingId;
      ws._token = data.token;
      broadcast();
      return;
    }
  }

  // Don't allow joining during active game phases (unless reconnecting)
  if (game.phase !== 'LOBBY' && game.gameStarted) {
    return sendError(ws, 'Game is in progress. Cannot join now.');
  }

  // Check for duplicate nickname
  const existing = game.players.find(p => p.nickname.toLowerCase() === nickname.toLowerCase() && p.connected);
  if (existing) {
    return sendError(ws, 'That nickname is already taken');
  }

  // Create new player
  const id = generateId();
  const token = generateToken();
  const colorIdx = game.players.length % COLORS.length;

  const player = {
    id,
    nickname,
    color: COLORS[colorIdx],
    alive: true,
    connected: true,
    hasVoted: false,
  };

  game.players.push(player);
  tokenMap[token] = id;
  playerSockets[id] = ws;
  ws._playerId = id;
  ws._token = token;

  // Send the token to the client for localStorage
  ws.send(JSON.stringify({ type: 'token', token, playerId: id }));
  broadcast();
}

function handleInitiate(ws, data) {
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  const player = getPlayer(playerId);
  if (!player || !player.alive) return sendError(ws, 'You are not an active player');

  if (game.phase !== 'LOBBY') return sendError(ws, 'Can only initiate during lobby phase');

  const alive = getAlivePlayers();
  if (alive.length < 3) return sendError(ws, 'Need at least 3 alive players to start');

  const title = (data.title || '').trim().substring(0, 100);
  const description = (data.description || '').trim().substring(0, 500);
  if (!title) return sendError(ws, 'Event title is required');

  game.gameStarted = true;
  transitionToVoting(playerId, title, description);
}

function handleVote(ws, data) {
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  const player = getPlayer(playerId);
  if (!player || !player.alive) return sendError(ws, 'You are not an active player');

  if (game.phase !== 'VOTING') return sendError(ws, 'Not in voting phase');

  // Initiator is auto-attend, can't change
  if (playerId === game.round.initiator) return sendError(ws, 'Initiator always attends');

  const vote = data.vote === 'attend' ? 'attend' : 'zingur';
  game.round.votes[playerId] = vote;
  updateHasVoted();
  broadcast();

  // Check if all alive players voted
  if (checkAllVoted()) {
    transitionToVotingResults();
  }
}

function handleExcuse(ws, data) {
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  if (game.phase !== 'EXCUSE') return sendError(ws, 'Not in excuse phase');

  if (!game.round.candidates.includes(playerId)) {
    return sendError(ws, 'You are not on the losing team');
  }

  const excuse = (data.excuse || '').trim().substring(0, 500);
  game.round.excuses[playerId] = excuse || '(No excuse)';
  broadcast();

  if (checkAllExcusesSubmitted()) {
    transitionToElimination();
  }
}

function handleEliminateVote(ws, data) {
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  const player = getPlayer(playerId);
  if (!player || !player.alive) return sendError(ws, 'You are not an active player');

  if (game.phase !== 'ELIMINATION' && game.phase !== 'RUNOFF') {
    return sendError(ws, 'Not in elimination phase');
  }

  const target = data.target;
  if (!game.round.candidates.includes(target)) {
    return sendError(ws, 'Invalid elimination target');
  }

  game.round.eliminationVotes[playerId] = target;
  updateHasVoted();
  broadcast();

  if (checkAllEliminationVoted()) {
    if (game.phase === 'ELIMINATION') {
      resolveElimination();
    } else {
      resolveRunoff();
    }
  }
}

function handleRestart(ws) {
  const playerId = ws._playerId;
  if (!playerId) return sendError(ws, 'Not joined');

  if (game.phase !== 'GAME_OVER' && game.phase !== 'LOBBY') {
    return sendError(ws, 'Can only restart from game over or lobby');
  }

  clearPhaseTimer();

  // Reset all connected players to alive, remove disconnected
  const newPlayers = game.players.filter(p => p.connected).map(p => ({
    ...p,
    alive: true,
    hasVoted: false,
  }));

  game = createFreshGame();
  game.players = newPlayers;

  broadcast();
}

// -----------------------------------------------------------------------------
// WebSocket Connection Handler
// -----------------------------------------------------------------------------

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return sendError(ws, 'Invalid message format');
    }

    switch (msg.type) {
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'initiate':
        handleInitiate(ws, msg);
        break;
      case 'vote':
        handleVote(ws, msg);
        break;
      case 'excuse':
        handleExcuse(ws, msg);
        break;
      case 'eliminate_vote':
        handleEliminateVote(ws, msg);
        break;
      case 'restart':
        handleRestart(ws);
        break;
      default:
        sendError(ws, 'Unknown message type');
    }
  });

  ws.on('close', () => {
    const playerId = ws._playerId;
    if (playerId) {
      const player = getPlayer(playerId);
      if (player) {
        player.connected = false;
      }
      delete playerSockets[playerId];
      broadcast();
    }
  });
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`Shabaknap server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your mobile browser`);
});
