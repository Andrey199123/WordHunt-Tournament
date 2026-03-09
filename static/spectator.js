const matchStorageKey = "wordhunt_spectator_match_id";

const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const p1BoardEl = document.getElementById("p1-board");
const p2BoardEl = document.getElementById("p2-board");
const p1TraceOverlayEl = document.getElementById("p1-trace-overlay");
const p2TraceOverlayEl = document.getElementById("p2-trace-overlay");
const p1TraceWordEl = document.getElementById("p1-trace-word");
const p2TraceWordEl = document.getElementById("p2-trace-word");
const p1ScoreEl = document.getElementById("p1-score");
const p2ScoreEl = document.getElementById("p2-score");
const p1LastEl = document.getElementById("p1-last");
const p2LastEl = document.getElementById("p2-last");
const p1WordsEl = document.getElementById("p1-words");
const p2WordsEl = document.getElementById("p2-words");
const messageEl = document.getElementById("message");
const startMatchButton = document.getElementById("start-match");
const newMatchButton = document.getElementById("new-match");
const openPlayer1Link = document.getElementById("open-player-1");
const openPlayer2Link = document.getElementById("open-player-2");

let pinnedMatchId = localStorage.getItem(matchStorageKey) || null;
let currentMatchId = pinnedMatchId;
let latestState = null;
let p1BoardSignature = "";
let p2BoardSignature = "";
let mismatchCount = 0;
const pollMs = 220;

function blankGrid() {
  return Array.from({ length: 4 }, () => Array(4).fill(""));
}

function isValidBoard(grid) {
  return (
    Array.isArray(grid) &&
    grid.length === 4 &&
    grid.every((row) => Array.isArray(row) && row.length === 4)
  );
}

function gridSignature(grid) {
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
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function pinMatch(matchId) {
  if (!matchId) {
    return;
  }
  pinnedMatchId = matchId;
  localStorage.setItem(matchStorageKey, matchId);
  updatePlayerLinks(matchId);
}

function activeMatchId() {
  return pinnedMatchId || null;
}

function updatePlayerLinks(matchId) {
  if (!matchId) {
    openPlayer1Link.href = "/play/1";
    openPlayer2Link.href = "/play/2";
    return;
  }
  openPlayer1Link.href = `/play/1?match=${encodeURIComponent(matchId)}`;
  openPlayer2Link.href = `/play/2?match=${encodeURIComponent(matchId)}`;
}

function renderBoard(container, grid) {
  container.innerHTML = "";
  grid.forEach((row, r) => {
    row.forEach((token, c) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      if (!token) {
        tile.classList.add("placeholder");
      }
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.textContent = token || "";
      container.appendChild(tile);
    });
  });
}

function tileCenter(boardEl, row, col) {
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

function drawTrace(overlayEl, boardEl, path, color) {
  const boardRect = boardEl.getBoundingClientRect();
  const width = Math.max(1, Math.round(boardRect.width));
  const height = Math.max(1, Math.round(boardRect.height));
  overlayEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  overlayEl.setAttribute("width", String(width));
  overlayEl.setAttribute("height", String(height));
  overlayEl.innerHTML = "";

  if (!Array.isArray(path) || !path.length) {
    return;
  }

  const points = path
    .map((cell) => {
      if (!Array.isArray(cell) || cell.length !== 2) {
        return null;
      }
      return tileCenter(boardEl, Number(cell[0]), Number(cell[1]));
    })
    .filter(Boolean);

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
    polyline.setAttribute("stroke", color);
    polyline.setAttribute("stroke-width", "9");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    polyline.setAttribute("opacity", "0.86");
    overlayEl.appendChild(polyline);
  }

  points.forEach((pt) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(pt.x));
    dot.setAttribute("cy", String(pt.y));
    dot.setAttribute("r", "6");
    dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0.96");
    overlayEl.appendChild(dot);
  });
}

function renderWords(container, words) {
  container.innerHTML = "";
  if (!words.length) {
    container.textContent = "No words yet";
    return;
  }

  words.forEach((word) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = word;
    container.appendChild(chip);
  });
}

function updateStartButton(state) {
  if (state.status === "running") {
    startMatchButton.disabled = true;
    startMatchButton.textContent = "Match Running";
    return;
  }

  if (state.status === "finished") {
    startMatchButton.disabled = true;
    startMatchButton.textContent = "Match Finished";
    return;
  }

  if (state.can_start) {
    startMatchButton.disabled = false;
    startMatchButton.textContent = "Start Match";
    return;
  }

  startMatchButton.disabled = true;
  const p1Joined = state.players["1"].joined;
  const p2Joined = state.players["2"].joined;
  if (!p1Joined && !p2Joined) {
    startMatchButton.textContent = "Waiting For Players";
  } else if (!p1Joined) {
    startMatchButton.textContent = "Waiting For Player 1";
  } else {
    startMatchButton.textContent = "Waiting For Player 2";
  }
}

function renderHiddenBoards() {
  const hidden = blankGrid();
  const hiddenSig = gridSignature(hidden);
  if (p1BoardSignature !== hiddenSig) {
    renderBoard(p1BoardEl, hidden);
    p1BoardSignature = hiddenSig;
  }
  if (p2BoardSignature !== hiddenSig) {
    renderBoard(p2BoardEl, hidden);
    p2BoardSignature = hiddenSig;
  }
  drawTrace(p1TraceOverlayEl, p1BoardEl, [], "#5fd6ff");
  drawTrace(p2TraceOverlayEl, p2BoardEl, [], "#ffc86e");
  p1TraceWordEl.textContent = "Tracing: waiting for start";
  p2TraceWordEl.textContent = "Tracing: waiting for start";
}

function renderLiveBoards(state) {
  if (!isValidBoard(state.board)) {
    return;
  }

  const sig = gridSignature(state.board);
  if (p1BoardSignature !== sig) {
    renderBoard(p1BoardEl, state.board);
    p1BoardSignature = sig;
  }
  if (p2BoardSignature !== sig) {
    renderBoard(p2BoardEl, state.board);
    p2BoardSignature = sig;
  }

  const p1Swipe = state.swipes?.["1"] || { path: [], word: "" };
  const p2Swipe = state.swipes?.["2"] || { path: [], word: "" };

  drawTrace(p1TraceOverlayEl, p1BoardEl, p1Swipe.path, "#5fd6ff");
  drawTrace(p2TraceOverlayEl, p2BoardEl, p2Swipe.path, "#ffc86e");

  p1TraceWordEl.textContent = p1Swipe.word ? `Tracing: ${p1Swipe.word.toUpperCase()}` : "Tracing: -";
  p2TraceWordEl.textContent = p2Swipe.word ? `Tracing: ${p2Swipe.word.toUpperCase()}` : "Tracing: -";
}

function applyState(state) {
  if (!state || !state.id) {
    return;
  }

  if (pinnedMatchId && state.id !== pinnedMatchId) {
    return;
  }

  if (!pinnedMatchId) {
    pinMatch(state.id);
  }

  if (currentMatchId !== state.id) {
    currentMatchId = state.id;
    setMessage("Match synced");
  }

  latestState = state;

  timerEl.textContent = formatTime(state.time_remaining);
  statusEl.textContent = state.status[0].toUpperCase() + state.status.slice(1);

  p1ScoreEl.textContent = String(state.players["1"].score);
  p2ScoreEl.textContent = String(state.players["2"].score);
  p1LastEl.textContent = `+${state.players["1"].last_points || 0}`;
  p2LastEl.textContent = `+${state.players["2"].last_points || 0}`;

  renderWords(p1WordsEl, state.players["1"].words || []);
  renderWords(p2WordsEl, state.players["2"].words || []);

  if (state.status === "waiting") {
    renderHiddenBoards();
  } else {
    renderLiveBoards(state);
  }

  updateStartButton(state);

  if (state.status === "finished" && state.result) {
    setMessage(state.result.summary || state.result.text);
  }
}

async function pollState() {
  const params = new URLSearchParams({ view: "spectator" });
  const matchId = activeMatchId();
  if (matchId) {
    params.set("match_id", matchId);
  }

  const res = await fetch(`/api/state?${params.toString()}`);
  const data = await res.json();

  if (!data.ok) {
    if (data.error === "Match id mismatch") {
      mismatchCount += 1;
      if (mismatchCount > 6) {
        pinnedMatchId = null;
        localStorage.removeItem(matchStorageKey);
        updatePlayerLinks(null);
        mismatchCount = 0;
      }
      return;
    }
    setMessage(data.error || "State error", true);
    return;
  }

  mismatchCount = 0;
  applyState(data.state);
}

newMatchButton.addEventListener("click", async () => {
  const res = await fetch("/api/new-match", { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    setMessage(data.error || "Could not start new match", true);
    return;
  }

  pinMatch(data.state.id);
  currentMatchId = data.state.id;
  applyState(data.state);
  setMessage("New match ready. Have both players join, then click Start Match.");
});

startMatchButton.addEventListener("click", async () => {
  const body = {};
  const matchId = activeMatchId();
  if (matchId) {
    body.match_id = matchId;
  }

  const res = await fetch("/api/start-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    setMessage(data.error || "Could not start match", true);
    await pollState();
    return;
  }
  pinMatch(data.state.id);
  setMessage("Match started");
  applyState(data.state);
});

window.addEventListener("resize", () => {
  if (!latestState) {
    return;
  }
  if (latestState.status === "waiting") {
    renderHiddenBoards();
  } else {
    renderLiveBoards(latestState);
  }
});

updatePlayerLinks(pinnedMatchId);
renderHiddenBoards();
pollState();
setInterval(pollState, pollMs);
