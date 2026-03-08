const playerId = document.body.dataset.playerId;

const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const boardEl = document.getElementById("board");
const myScoreEl = document.getElementById("my-score");
const oppScoreEl = document.getElementById("opp-score");
const wordsEl = document.getElementById("words");
const messageEl = document.getElementById("message");
const currentWordEl = document.getElementById("current-word");

let currentMatchId = null;
let board = [];
let isSelecting = false;
let selectedPath = [];
let selectedWord = "";
let activePointerId = null;
let running = false;

const pollMs = 800;

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

function updateSelectionUi() {
  const pathSet = new Set(selectedPath.map((cell) => `${cell.r},${cell.c}`));
  boardEl.querySelectorAll(".tile").forEach((tile) => {
    const key = `${tile.dataset.row},${tile.dataset.col}`;
    tile.classList.toggle("selected", pathSet.has(key));
  });

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

function attachBoardInput() {
  boardEl.addEventListener("pointerdown", (event) => {
    if (!running) {
      return;
    }

    const tile = tileAt(event.clientX, event.clientY);
    if (!tile) {
      return;
    }

    isSelecting = true;
    activePointerId = event.pointerId;
    boardEl.setPointerCapture(event.pointerId);
    clearSelection();
    isSelecting = true;
    addTileToSelection(tile);
    event.preventDefault();
  });

  boardEl.addEventListener("pointermove", (event) => {
    if (!isSelecting || event.pointerId !== activePointerId) {
      return;
    }

    const tile = tileAt(event.clientX, event.clientY);
    addTileToSelection(tile);
  });

  const finishSelection = async (event) => {
    if (!isSelecting || event.pointerId !== activePointerId) {
      return;
    }

    isSelecting = false;
    boardEl.releasePointerCapture(event.pointerId);

    if (selectedWord.length >= 3 && running) {
      await submitWord(selectedWord);
    }

    clearSelection();
  };

  boardEl.addEventListener("pointerup", finishSelection);
  boardEl.addEventListener("pointercancel", finishSelection);
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
  oppScoreEl.textContent = String(state.opponent.score);
  renderWords(state.my_words || []);

  if (state.status === "waiting") {
    statusEl.textContent = "Waiting";
    running = false;
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
  const joined = await joinMatch();
  if (!joined) {
    return;
  }

  await pollState();
  setInterval(pollState, pollMs);
}

init();
