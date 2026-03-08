const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const p1BoardEl = document.getElementById("p1-board");
const p2BoardEl = document.getElementById("p2-board");
const p1ScoreEl = document.getElementById("p1-score");
const p2ScoreEl = document.getElementById("p2-score");
const p1WordsEl = document.getElementById("p1-words");
const p2WordsEl = document.getElementById("p2-words");
const messageEl = document.getElementById("message");
const newMatchButton = document.getElementById("new-match");

let currentMatchId = null;

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
  grid.forEach((row) => {
    row.forEach((token) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.textContent = token;
      container.appendChild(tile);
    });
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

function applyState(state) {
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

  renderWords(p1WordsEl, state.players["1"].words || []);
  renderWords(p2WordsEl, state.players["2"].words || []);

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

pollState();
setInterval(pollState, 800);
