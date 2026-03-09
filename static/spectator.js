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

let currentMatchId = null;
let latestState = null;
const pollMs = 180;

function setMessage(text, isError = false) {
  messageEl.textContent = text || "";
  messageEl.classList.toggle("error", isError);
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function renderBoard(container, grid) {
  container.innerHTML = "";
  grid.forEach((row, r) => {
    row.forEach((token, c) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.textContent = token;
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

function applyState(state) {
  latestState = state;

  if (currentMatchId !== state.id) {
    currentMatchId = state.id;
    renderBoard(p1BoardEl, state.board);
    renderBoard(p2BoardEl, state.board);
    setMessage("New match loaded");
  }

  timerEl.textContent = formatTime(state.time_remaining);
  statusEl.textContent = state.status[0].toUpperCase() + state.status.slice(1);

  p1ScoreEl.textContent = String(state.players["1"].score);
  p2ScoreEl.textContent = String(state.players["2"].score);
  p1LastEl.textContent = `+${state.players["1"].last_points || 0}`;
  p2LastEl.textContent = `+${state.players["2"].last_points || 0}`;

  renderWords(p1WordsEl, state.players["1"].words || []);
  renderWords(p2WordsEl, state.players["2"].words || []);

  const p1Swipe = state.swipes?.["1"] || { path: [], word: "" };
  const p2Swipe = state.swipes?.["2"] || { path: [], word: "" };
  drawTrace(p1TraceOverlayEl, p1BoardEl, p1Swipe.path, "#5fd6ff");
  drawTrace(p2TraceOverlayEl, p2BoardEl, p2Swipe.path, "#ffc86e");
  p1TraceWordEl.textContent = p1Swipe.word ? `Tracing: ${p1Swipe.word.toUpperCase()}` : "Tracing: -";
  p2TraceWordEl.textContent = p2Swipe.word ? `Tracing: ${p2Swipe.word.toUpperCase()}` : "Tracing: -";

  updateStartButton(state);

  if (state.status === "finished" && state.result) {
    setMessage(state.result.text);
  }
}

async function pollState() {
  const res = await fetch("/api/state?view=spectator");
  const data = await res.json();

  if (!data.ok) {
    setMessage(data.error || "State error", true);
    return;
  }

  applyState(data.state);
}

newMatchButton.addEventListener("click", async () => {
  const res = await fetch("/api/new-match", { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    setMessage(data.error || "Could not start new match", true);
    return;
  }
  applyState(data.state);
});

startMatchButton.addEventListener("click", async () => {
  const res = await fetch("/api/start-match", { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    setMessage(data.error || "Could not start match", true);
    await pollState();
    return;
  }
  setMessage("Match started");
  applyState(data.state);
});

window.addEventListener("resize", () => {
  if (!latestState) {
    return;
  }
  const p1Swipe = latestState.swipes?.["1"] || { path: [], word: "" };
  const p2Swipe = latestState.swipes?.["2"] || { path: [], word: "" };
  drawTrace(p1TraceOverlayEl, p1BoardEl, p1Swipe.path, "#5fd6ff");
  drawTrace(p2TraceOverlayEl, p2BoardEl, p2Swipe.path, "#ffc86e");
});

pollState();
setInterval(pollState, pollMs);
