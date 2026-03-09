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
const matchControlButton = document.getElementById("match-control");
const syncLiveButton = document.getElementById("sync-live");
const openPlayer1Link = document.getElementById("open-player-1");
const openPlayer2Link = document.getElementById("open-player-2");

let pinnedMatchId = localStorage.getItem(matchStorageKey) || null;
let currentMatchId = pinnedMatchId;
let latestState = null;
let p1BoardSignature = "";
let p2BoardSignature = "";
let mismatchRecoveryInFlight = false;

const pollMs = 90;

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

function clearPinnedMatch() {
  pinnedMatchId = null;
  currentMatchId = null;
  latestState = null;
  localStorage.removeItem(matchStorageKey);
  updatePlayerLinks(null);
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

async function openPlayerWithFreshMatch(playerId, event) {
  if (event) {
    event.preventDefault();
  }

  try {
    const res = await fetch("/api/state?view=spectator");
    const data = await res.json();
    if (!data.ok) {
      setMessage(data.error || "Could not sync player link", true);
      return;
    }

    pinMatch(data.state.id);
    currentMatchId = data.state.id;
    applyState(data.state);

    const url = `/play/${playerId}?match=${encodeURIComponent(data.state.id)}`;
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      window.open(url, "_blank", "noopener");
      return;
    }
    window.open(url, "_blank", "noopener");
  } catch {
    setMessage("Could not sync player link", true);
  }
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

function updateControlButton(state) {
  if (!state) {
    matchControlButton.disabled = false;
    matchControlButton.textContent = "Create Match";
    return;
  }

  if (state.status === "running") {
    matchControlButton.disabled = true;
    matchControlButton.textContent = "Match Running";
    return;
  }

  if (state.status === "finished") {
    matchControlButton.disabled = false;
    matchControlButton.textContent = "Start Next Match";
    return;
  }

  if (state.can_start) {
    matchControlButton.disabled = false;
    matchControlButton.textContent = "Start Match";
    return;
  }

  if (state.players["1"].joined || state.players["2"].joined) {
    matchControlButton.disabled = false;
    matchControlButton.textContent = "Reset Match";
    return;
  }

  matchControlButton.disabled = false;
  matchControlButton.textContent = "Create Match";
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

  updateControlButton(state);

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

  try {
    const res = await fetch(`/api/state?${params.toString()}`);
    const data = await res.json();

    if (!data.ok) {
      if (data.error === "Match id mismatch") {
        if (!mismatchRecoveryInFlight) {
          mismatchRecoveryInFlight = true;
          setMessage("Live out of sync. Recovering...", true);
          clearPinnedMatch();
          await fetchAndAdoptCurrentMatch();
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

async function fetchAndAdoptCurrentMatch() {
  try {
    const res = await fetch("/api/state?view=spectator");
    const data = await res.json();
    if (!data.ok) {
      setMessage(data.error || "Could not sync live screen", true);
      return;
    }

    pinMatch(data.state.id);
    currentMatchId = data.state.id;
    applyState(data.state);
    setMessage("Live screen synced");
  } catch {
    setMessage("Could not sync live screen", true);
  }
}

matchControlButton.addEventListener("click", async () => {
  const state = latestState;

  if (!state || state.status === "finished" || (state.status === "waiting" && !state.can_start)) {
    const res = await fetch("/api/new-match", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      setMessage(data.error || "Could not create match", true);
      return;
    }

    pinMatch(data.state.id);
    currentMatchId = data.state.id;
    applyState(data.state);
    setMessage("Match created. Open Sync Player 1 and Sync Player 2 links.");
    return;
  }

  if (state.status === "waiting" && state.can_start) {
    const res = await fetch("/api/start-match", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      setMessage(data.error || "Could not start match", true);
      await pollState();
      return;
    }

    pinMatch(data.state.id);
    applyState(data.state);
    setMessage("Match started");
  }
});

syncLiveButton.addEventListener("click", async () => {
  clearPinnedMatch();
  await fetchAndAdoptCurrentMatch();
});

openPlayer1Link.addEventListener("click", (event) => openPlayerWithFreshMatch("1", event));
openPlayer2Link.addEventListener("click", (event) => openPlayerWithFreshMatch("2", event));

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
updateControlButton(null);
pollState();
setInterval(pollState, pollMs);
