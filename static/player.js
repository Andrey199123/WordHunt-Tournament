const playerId = document.body.dataset.playerId;

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

let currentMatchId = null;
let board = [];
let isSelecting = false;
let selectedPath = [];
let selectedWord = "";
let activePointerId = null;
let activeTouchId = null;
let activeMouseDown = false;
let running = false;
let swipePublishTimer = null;
let pendingSwipePayload = null;

const pollMs = 350;

function setMessage(text, isError = false) {
  messageEl.textContent = text || "";
  messageEl.classList.toggle("error", isError);
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function parsePos(tile) {
  return {
    r: Number(tile.dataset.row),
    c: Number(tile.dataset.col),
    token: tile.dataset.token,
  };
}

function isAdjacent(a, b) {
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return dr <= 1 && dc <= 1 && (dr + dc > 0);
}

function renderBoard(grid) {
  boardEl.innerHTML = "";
  grid.forEach((row, r) => {
    row.forEach((token, c) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.dataset.token = token;
      tile.textContent = token;
      boardEl.appendChild(tile);
    });
  });
}

function tileCenter(row, col) {
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

function selectionPathPayload() {
  return selectedPath.map((cell) => [cell.r, cell.c]);
}

function scheduleSwipePublish(pathPayload, word) {
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
  }, 65);
}

async function publishSwipe(pathPayload, word) {
  try {
    await fetch("/api/swipe-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player: playerId, path: pathPayload, word }),
    });
  } catch {
    // Ignore transient network misses while tracing.
  }
}

function updateSelectionUi() {
  const pathSet = new Set(selectedPath.map((cell) => `${cell.r},${cell.c}`));
  boardEl.querySelectorAll(".tile").forEach((tile) => {
    const key = `${tile.dataset.row},${tile.dataset.col}`;
    tile.classList.toggle("selected", pathSet.has(key));
  });
  drawTrace(selectedPath);

  if (!selectedWord) {
    currentWordEl.textContent = "Swipe tiles to form words";
    return;
  }
  currentWordEl.textContent = selectedWord.toUpperCase();
}

function clearSelection() {
  isSelecting = false;
  selectedPath = [];
  selectedWord = "";
  updateSelectionUi();
  scheduleSwipePublish([], "");
}

function addTileToSelection(tile) {
  if (!tile || !tile.classList.contains("tile")) {
    return;
  }

  const pos = parsePos(tile);
  if (selectedPath.some((cell) => cell.r === pos.r && cell.c === pos.c)) {
    return;
  }

  const last = selectedPath[selectedPath.length - 1];
  if (last && !isAdjacent(last, pos)) {
    return;
  }

  selectedPath.push(pos);
  selectedWord += pos.token.toLowerCase();
  updateSelectionUi();
  scheduleSwipePublish(selectionPathPayload(), selectedWord);
}

async function submitWord(word) {
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player: playerId, word }),
  });
  const data = await res.json();

  if (!data.ok) {
    setMessage(data.error || "Word rejected", true);
    return;
  }

  const points = data.points;
  setMessage(`+${points} for ${data.word.toUpperCase()}`);
  applyState(data.state);
}

function tileAt(clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  return element ? element.closest(".tile") : null;
}

function startSelectionAtPoint(clientX, clientY) {
  if (!running) {
    return false;
  }

  const tile = tileAt(clientX, clientY);
  if (!tile) {
    return false;
  }

  clearSelection();
  isSelecting = true;
  addTileToSelection(tile);
  return true;
}

function continueSelectionAtPoint(clientX, clientY) {
  if (!isSelecting) {
    return;
  }
  addTileToSelection(tileAt(clientX, clientY));
}

async function finishSelection() {
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
  if (window.PointerEvent) {
    boardEl.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") {
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

function applyState(state) {
  if (currentMatchId !== state.id) {
    currentMatchId = state.id;
    board = state.board;
    renderBoard(board);
    clearSelection();
    setMessage("New match loaded");
  }

  timerEl.textContent = formatTime(state.time_remaining);
  myScoreEl.textContent = String(state.players[playerId].score);
  myLastEl.textContent = `+${state.players[playerId].last_points || 0} last`;
  oppScoreEl.textContent = String(state.opponent.score);
  oppLastEl.textContent = `+${state.opponent.last_points || 0} last`;
  renderWords(state.my_words || []);

  if (state.status === "waiting") {
    statusEl.textContent = "Waiting";
    running = false;
    if (!isSelecting) {
      currentWordEl.textContent = "Waiting for live screen to start";
    }
  } else if (state.status === "running") {
    statusEl.textContent = "Running";
    running = true;
  } else {
    statusEl.textContent = "Finished";
    running = false;
    if (state.result) {
      if (state.result.winner === "tie") {
        setMessage("Tie game");
      } else if (state.result.winner === playerId) {
        setMessage("You win");
      } else {
        setMessage("You lose");
      }
    }
  }
}

async function joinMatch() {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player: playerId }),
  });
  const data = await res.json();

  if (!data.ok) {
    setMessage(data.error || "Could not join", true);
    return false;
  }

  applyState(data.state);
  return true;
}

async function pollState() {
  const res = await fetch(`/api/state?view=player&player=${playerId}`);
  const data = await res.json();

  if (!data.ok) {
    setMessage(data.error || "State error", true);
    return;
  }

  applyState(data.state);
}

async function init() {
  attachBoardInput();
  window.addEventListener("resize", () => drawTrace(selectedPath));
  const joined = await joinMatch();
  if (!joined) {
    return;
  }

  await pollState();
  setInterval(pollState, pollMs);
}

init();
