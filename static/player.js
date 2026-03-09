const playerId = document.body.dataset.playerId;
const queryMatchId = new URLSearchParams(window.location.search).get("match");
const matchStorageKey = `wordhunt_player_${playerId}_match_id`;

// Cache important DOM nodes once so render/update code stays fast.
const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const boardEl = document.getElementById("board");
const traceOverlayEl = document.getElementById("trace-overlay");
const myScoreEl = document.getElementById("my-score");
const oppScoreEl = document.getElementById("opp-score");
const myLastEl = document.getElementById("my-last");
const oppLastEl = document.getElementById("opp-last");
const wordsEl = document.getElementById("words");
const messageEl = document.getElementById("message");
const currentWordEl = document.getElementById("current-word");
const syncButton = document.getElementById("sync-player");

// A player can open from a spectator-provided URL (?match=...), then keep that
// match id pinned in localStorage so refreshes stay on the same live match.
let pinnedMatchId = queryMatchId || localStorage.getItem(matchStorageKey) || null;
if (queryMatchId) {
  localStorage.setItem(matchStorageKey, queryMatchId);
}

let currentMatchId = pinnedMatchId;
let boardSignature = "";
let latestState = null;

let isSelecting = false;
let selectedPath = [];
let selectedWord = "";
let activePointerId = null;
let activeTouchId = null;
let activeMouseDown = false;
let running = false;
let joinInFlight = false;
let mismatchRecoveryInFlight = false;

let swipePublishTimer = null;
let pendingSwipePayload = null;
let lastPublishedSwipeKey = "";

// Fast polling keeps timer/scores/traces feeling real-time.
const pollMs = 100;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function blankGrid() {
  // Hidden board = same shape as real board, but no letters.
  return Array.from({ length: 4 }, () => Array(4).fill(""));
}

function isValidBoard(grid) {
  // Defensive checks prevent render errors when responses are incomplete.
  return (
    Array.isArray(grid) &&
    grid.length === 4 &&
    grid.every((row) => Array.isArray(row) && row.length === 4)
  );
}

function gridSignature(grid) {
  // Signature lets us skip expensive re-renders when board content is unchanged.
  if (!isValidBoard(grid)) {
    return "";
  }
  return grid.map((row) => row.join("")).join("|");
}

function setMessage(text, isError = false) {
  messageEl.textContent = text || "";
  messageEl.classList.toggle("error", isError);
}

function formatTime(totalSeconds) {
  // Convert raw seconds to game-style M:SS display.
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function pinMatch(matchId) {
  // "Pinning" means this tab is locked to one match id.
  if (!matchId) {
    return;
  }
  pinnedMatchId = matchId;
  localStorage.setItem(matchStorageKey, matchId);
}

function clearPinnedMatch() {
  // Reset local sync state so player can re-attach to the current live match.
  pinnedMatchId = null;
  currentMatchId = null;
  lastPublishedSwipeKey = "";
  localStorage.removeItem(matchStorageKey);
}

function activeMatchId() {
  return pinnedMatchId || null;
}

function renderBoard(grid) {
  // Board is re-created from state so UI cannot drift from server truth.
  boardEl.innerHTML = "";
  grid.forEach((row, r) => {
    row.forEach((token, c) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      if (!token) {
        tile.classList.add("placeholder");
      }
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.dataset.token = token || "";
      tile.textContent = token || "";
      boardEl.appendChild(tile);
    });
  });
}

function renderHiddenBoard() {
  // While waiting, hide letters to prevent pre-round memorization/cheating.
  const hidden = blankGrid();
  const hiddenSignature = gridSignature(hidden);
  if (boardSignature !== hiddenSignature) {
    renderBoard(hidden);
    boardSignature = hiddenSignature;
  }
  drawTrace([]);
}

function renderLiveBoard(grid) {
  // During running/finished, show the actual board letters.
  if (!isValidBoard(grid)) {
    return;
  }

  const signature = gridSignature(grid);
  if (boardSignature !== signature) {
    renderBoard(grid);
    boardSignature = signature;
  }
  drawTrace(selectedPath);
}

function tileCenter(row, col) {
  // SVG trace uses tile center coordinates in board-local space.
  const tile = boardEl.querySelector(`.tile[data-row="${row}"][data-col="${col}"]`);
  if (!tile) {
    return null;
  }

  const tileRect = tile.getBoundingClientRect();
  const boardRect = boardEl.getBoundingClientRect();
  return {
    x: tileRect.left - boardRect.left + tileRect.width / 2,
    y: tileRect.top - boardRect.top + tileRect.height / 2,
  };
}

function drawTrace(path) {
  // This draws the "line connecting tiles" while swiping.
  const boardRect = boardEl.getBoundingClientRect();
  const width = Math.max(1, Math.round(boardRect.width));
  const height = Math.max(1, Math.round(boardRect.height));
  traceOverlayEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  traceOverlayEl.setAttribute("width", String(width));
  traceOverlayEl.setAttribute("height", String(height));
  traceOverlayEl.innerHTML = "";

  if (!path.length) {
    return;
  }

  const points = path.map((cell) => tileCenter(cell.r, cell.c)).filter(Boolean);
  if (!points.length) {
    return;
  }

  if (points.length >= 2) {
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute(
      "points",
      points.map((pt) => `${pt.x},${pt.y}`).join(" "),
    );
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "#7fd7ff");
    polyline.setAttribute("stroke-width", "10");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    polyline.setAttribute("opacity", "0.88");
    traceOverlayEl.appendChild(polyline);
  }

  points.forEach((pt) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(pt.x));
    dot.setAttribute("cy", String(pt.y));
    dot.setAttribute("r", "7");
    dot.setAttribute("fill", "#b8ecff");
    dot.setAttribute("opacity", "0.96");
    traceOverlayEl.appendChild(dot);
  });
}

function parsePos(tile) {
  return {
    r: Number(tile.dataset.row),
    c: Number(tile.dataset.col),
    token: tile.dataset.token,
  };
}

function isAdjacent(a, b) {
  // Word Hunt rule: next tile must touch previous tile (including diagonals).
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return dr <= 1 && dc <= 1 && dr + dc > 0;
}

function selectionPathPayload() {
  // Backend stores path as [row, col] pairs.
  return selectedPath.map((cell) => [cell.r, cell.c]);
}

function scheduleSwipePublish(pathPayload, word) {
  // Coalesce rapid pointer events into one network update every ~40ms.
  // This keeps spectator feed smooth without spamming requests.
  pendingSwipePayload = { path: pathPayload, word };
  if (swipePublishTimer !== null) {
    return;
  }

  swipePublishTimer = window.setTimeout(async () => {
    swipePublishTimer = null;
    const payload = pendingSwipePayload;
    pendingSwipePayload = null;
    if (!payload) {
      return;
    }
    await publishSwipe(payload.path, payload.word);
  }, 40);
}

async function publishSwipe(pathPayload, word) {
  // Skip duplicate payloads to reduce noise/latency.
  const publishKey = `${word}|${JSON.stringify(pathPayload)}`;
  if (publishKey === lastPublishedSwipeKey) {
    return;
  }
  lastPublishedSwipeKey = publishKey;

  const body = { player: playerId, path: pathPayload, word };
  const matchId = activeMatchId();
  if (matchId) {
    body.match_id = matchId;
  }

  try {
    await fetch("/api/swipe-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Ignore transient misses while tracing; poll loop will keep UI in sync.
  }
}

function updateSelectionUi() {
  // Highlight selected tiles + update live word preview text.
  const pathSet = new Set(selectedPath.map((cell) => `${cell.r},${cell.c}`));
  boardEl.querySelectorAll(".tile").forEach((tile) => {
    const key = `${tile.dataset.row},${tile.dataset.col}`;
    tile.classList.toggle("selected", pathSet.has(key));
  });

  drawTrace(selectedPath);

  if (!selectedWord) {
    currentWordEl.textContent = running ? "Swipe tiles to form words" : "Waiting for live screen to start";
    return;
  }
  currentWordEl.textContent = selectedWord.toUpperCase();
}

function clearSelection() {
  // Called when swipe ends or when state changes (waiting/finished/etc.).
  isSelecting = false;
  selectedPath = [];
  selectedWord = "";
  updateSelectionUi();
  scheduleSwipePublish([], "");
}

function addTileToSelection(tile) {
  // Reject invalid tile interactions early.
  if (!tile || !tile.classList.contains("tile") || !tile.dataset.token) {
    return;
  }

  const pos = parsePos(tile);
  if (!pos.token) {
    return;
  }

  if (selectedPath.some((cell) => cell.r === pos.r && cell.c === pos.c)) {
    // Cannot reuse the same tile in one word path.
    return;
  }

  const last = selectedPath[selectedPath.length - 1];
  if (last && !isAdjacent(last, pos)) {
    // Enforce adjacency.
    return;
  }

  selectedPath.push(pos);
  selectedWord += pos.token.toLowerCase();
  updateSelectionUi();
  scheduleSwipePublish(selectionPathPayload(), selectedWord);
}

async function submitWord(word) {
  // Final word validation/scoring always happens on the backend.
  const body = { player: playerId, word };
  const matchId = activeMatchId();
  if (matchId) {
    body.match_id = matchId;
  }

  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!data.ok) {
    if (data.error === "Match id mismatch") {
      // Player is attached to old match id, so ask for manual resync.
      setMessage("Out of sync. Tap Sync Player.", true);
      return;
    }
    setMessage(data.error || "Word rejected", true);
    return;
  }

  setMessage(`+${data.points} for ${data.word.toUpperCase()}`);
  applyState(data.state);
}

function tileAt(clientX, clientY) {
  // Hit-test pointer position to nearest tile.
  const element = document.elementFromPoint(clientX, clientY);
  return element ? element.closest(".tile") : null;
}

function startSelectionAtPoint(clientX, clientY) {
  // Ignore touches before match starts.
  if (!running) {
    return false;
  }

  const tile = tileAt(clientX, clientY);
  if (!tile || !tile.dataset.token) {
    return false;
  }

  clearSelection();
  isSelecting = true;
  addTileToSelection(tile);
  return true;
}

function continueSelectionAtPoint(clientX, clientY) {
  // Add newly entered tiles as finger/mouse moves.
  if (!isSelecting) {
    return;
  }
  addTileToSelection(tileAt(clientX, clientY));
}

async function finishSelection() {
  // Complete swipe, then submit if it formed a legal-length word.
  if (!isSelecting) {
    return;
  }

  const word = selectedWord;
  clearSelection();

  if (word.length >= 3 && running) {
    await submitWord(word);
  }
}

function attachBoardInput() {
  // Pointer Events path (desktop + most modern browsers).
  if (window.PointerEvent) {
    boardEl.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") {
        // Touch is handled by dedicated touch listeners below.
        return;
      }
      if (event.button !== undefined && event.button !== 0) {
        return;
      }

      if (!startSelectionAtPoint(event.clientX, event.clientY)) {
        return;
      }

      activePointerId = event.pointerId;
      if (event.cancelable) {
        event.preventDefault();
      }
    });

    document.addEventListener("pointermove", (event) => {
      if (!isSelecting || activePointerId === null || event.pointerId !== activePointerId) {
        return;
      }
      continueSelectionAtPoint(event.clientX, event.clientY);
      if (event.cancelable) {
        event.preventDefault();
      }
    });

    const onPointerEnd = async (event) => {
      if (activePointerId === null || event.pointerId !== activePointerId) {
        return;
      }

      activePointerId = null;
      await finishSelection();
    };

    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
  }

  // Dedicated touch listeners improve compatibility on iPad/mobile browsers.
  boardEl.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.changedTouches[0];
      if (!touch) {
        return;
      }
      if (!startSelectionAtPoint(touch.clientX, touch.clientY)) {
        return;
      }

      activeTouchId = touch.identifier;
      if (event.cancelable) {
        event.preventDefault();
      }
    },
    { passive: false },
  );

  boardEl.addEventListener(
    "touchmove",
    (event) => {
      if (!isSelecting || activeTouchId === null) {
        return;
      }

      const touch = Array.from(event.touches).find((item) => item.identifier === activeTouchId);
      if (!touch) {
        return;
      }

      continueSelectionAtPoint(touch.clientX, touch.clientY);
      if (event.cancelable) {
        event.preventDefault();
      }
    },
    { passive: false },
  );

  const onTouchEnd = async (event) => {
    if (activeTouchId === null) {
      return;
    }

    const isMyTouch = Array.from(event.changedTouches).some(
      (item) => item.identifier === activeTouchId,
    );
    if (!isMyTouch) {
      return;
    }

    activeTouchId = null;
    await finishSelection();
    if (event.cancelable) {
      event.preventDefault();
    }
  };

  document.addEventListener("touchend", onTouchEnd, { passive: false });
  document.addEventListener("touchcancel", onTouchEnd, { passive: false });

  if (!window.PointerEvent) {
    // Legacy mouse fallback for very old browsers without Pointer Events.
    boardEl.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      if (!startSelectionAtPoint(event.clientX, event.clientY)) {
        return;
      }
      activeMouseDown = true;
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!activeMouseDown || !isSelecting) {
        return;
      }
      continueSelectionAtPoint(event.clientX, event.clientY);
      event.preventDefault();
    });

    document.addEventListener("mouseup", async () => {
      if (!activeMouseDown) {
        return;
      }
      activeMouseDown = false;
      await finishSelection();
    });
  }
}

function renderWords(words) {
  // Player-only list of their accepted words.
  wordsEl.innerHTML = "";
  if (!words.length) {
    wordsEl.textContent = "No words yet";
    return;
  }

  words.forEach((word) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = word;
    wordsEl.appendChild(chip);
  });
}

async function ensureJoined() {
  // Re-assert join in case player tab loaded before spectator created match.
  if (joinInFlight) {
    return;
  }

  joinInFlight = true;
  try {
    const body = { player: playerId };
    const matchId = activeMatchId();
    if (matchId) {
      body.match_id = matchId;
    }

    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.ok) {
      pinMatch(data.state.id);
      applyState(data.state);
      return;
    }

    if (data.error === "Match id mismatch") {
      setMessage("Out of sync. Tap Sync Player.", true);
      return;
    }

    setMessage(data.error || "Could not join", true);
  } finally {
    joinInFlight = false;
  }
}

async function adoptCurrentMatch() {
  // Force this player tab to follow whichever match the server marks as current.
  try {
    const res = await fetch(`/api/state?view=player&player=${playerId}`);
    const data = await res.json();
    if (!data.ok) {
      return false;
    }

    pinMatch(data.state.id);
    applyState(data.state);
    await ensureJoined();
    setMessage(`Player ${playerId} synced`);
    return true;
  } catch {
    return false;
  }
}

function applyState(state) {
  // Central state machine: waiting -> running -> finished.
  if (!state || !state.id) {
    return;
  }

  if (pinnedMatchId && state.id !== pinnedMatchId) {
    pinMatch(state.id);
    setMessage("Player re-synced to current match");
  }

  if (!pinnedMatchId) {
    pinMatch(state.id);
  }

  if (currentMatchId !== state.id) {
    currentMatchId = state.id;
    lastPublishedSwipeKey = "";
    setMessage("Match synced");
  }

  latestState = state;

  // HUD values are always driven by server state.
  timerEl.textContent = formatTime(state.time_remaining);
  myScoreEl.textContent = String(state.players[playerId].score);
  myLastEl.textContent = `+${state.players[playerId].last_points || 0} pts`;
  oppScoreEl.textContent = String(state.opponent.score);
  oppLastEl.textContent = `+${state.opponent.last_points || 0} pts`;
  renderWords(state.my_words || []);

  if (state.status === "waiting") {
    statusEl.textContent = "Waiting";
    running = false;
    renderHiddenBoard();
    currentWordEl.textContent = "Waiting for live screen to start";
    scheduleSwipePublish([], "");

    if (!state.players[playerId].joined) {
      void ensureJoined();
    }
    return;
  }

  if (state.status === "running") {
    statusEl.textContent = "Running";
    running = true;
    renderLiveBoard(state.board);
    if (!isSelecting) {
      currentWordEl.textContent = "Swipe tiles to form words";
    }
    return;
  }

  // Finished state keeps board visible and announces winner summary.
  statusEl.textContent = "Finished";
  running = false;
  renderLiveBoard(state.board);
  drawTrace([]);
  scheduleSwipePublish([], "");

  if (state.result?.summary) {
    setMessage(state.result.summary);
  } else if (state.result?.text) {
    setMessage(state.result.text);
  }

  currentWordEl.textContent = `Words: You ${state.players[playerId].word_count}, Opponent ${
    state.opponent.word_count
  }`;
}

async function initialJoin() {
  // Retry loop helps during brief network race conditions at match startup.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const body = { player: playerId };
    const matchId = activeMatchId();
    if (matchId) {
      body.match_id = matchId;
    }

    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.ok) {
      pinMatch(data.state.id);
      applyState(data.state);
      return true;
    }

    if (data.error === "Match id mismatch") {
      // Try to auto-adopt latest live match before giving up.
      clearPinnedMatch();
      const adopted = await adoptCurrentMatch();
      if (adopted) {
        setMessage(`Player ${playerId} synced`);
        return true;
      }
      await sleep(120);
      continue;
    }

    setMessage(data.error || "Could not join", true);
    return false;
  }

  setMessage("Could not sync to live match. Tap Sync Player.", true);
  return false;
}

async function pollState() {
  // Polling keeps this tab synced with timer, scores, and match transitions.
  const params = new URLSearchParams({ view: "player", player: playerId });
  const matchId = activeMatchId();
  if (matchId) {
    params.set("match_id", matchId);
  }

  try {
    const res = await fetch(`/api/state?${params.toString()}`);
    const data = await res.json();

    if (!data.ok) {
      if (data.error === "Match id mismatch") {
        // Avoid parallel recoveries that can fight each other.
        if (!mismatchRecoveryInFlight) {
          mismatchRecoveryInFlight = true;
          setMessage("Out of sync. Recovering...", true);
          clearPinnedMatch();
          const adopted = await adoptCurrentMatch();
          if (!adopted) {
            setMessage("Out of sync. Tap Sync Player.", true);
          }
          mismatchRecoveryInFlight = false;
        }
        return;
      }
      setMessage(data.error || "State error", true);
      return;
    }

    applyState(data.state);
  } catch {
    setMessage("Connection lost. Retrying...", true);
  }
}

async function syncPlayer() {
  // Manual sync button for classrooms/demo setups with tab swaps/reconnects.
  clearPinnedMatch();
  renderHiddenBoard();

  try {
    const adopted = await adoptCurrentMatch();
    if (!adopted) {
      setMessage("Could not sync player", true);
      return;
    }
    setMessage(`Player ${playerId} synced`);
  } catch {
    setMessage("Could not sync player", true);
  }
}

async function init() {
  // App bootstrap order:
  // 1) input listeners
  // 2) hidden board placeholder
  // 3) initial join
  // 4) polling loop
  attachBoardInput();
  renderHiddenBoard();
  window.addEventListener("resize", () => drawTrace(selectedPath));
  syncButton.addEventListener("click", syncPlayer);

  const joined = await initialJoin();
  if (!joined) {
    return;
  }

  await pollState();
  setInterval(pollState, pollMs);
}

init();
