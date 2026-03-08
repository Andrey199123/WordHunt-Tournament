import random
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
WORD_LIST_PATH = DATA_DIR / "words.txt"

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)

# Classic 4x4 Boggle dice.
DICE = [
    "AAEEGN",
    "ABBJOO",
    "ACHOPS",
    "AFFKPS",
    "AOOTTW",
    "CIMOTU",
    "DEILRX",
    "DELRVY",
    "DISTTY",
    "EEGHNW",
    "EEINSU",
    "EHRTVW",
    "EIOSST",
    "ELRTTY",
    "HIMNQU",
    "HLNNRZ",
]

WORD_SET = set()
STATE_LOCK = threading.Lock()


def load_word_set() -> set[str]:
    words: set[str] = set()
    if not WORD_LIST_PATH.exists():
        return words

    with WORD_LIST_PATH.open("r", encoding="utf-8") as handle:
        for line in handle:
            word = line.strip().lower()
            if word:
                words.add(word)
    return words


def generate_board() -> list[list[str]]:
    dice = DICE[:]
    random.shuffle(dice)

    letters: list[str] = []
    for die in dice:
        face = random.choice(die)
        letters.append("Qu" if face == "Q" else face)

    return [letters[i : i + 4] for i in range(0, 16, 4)]


def new_match() -> dict:
    return {
        "id": uuid.uuid4().hex[:8],
        "board": generate_board(),
        "created_at": time.time(),
        "start_time": None,
        "duration": 90,
        "status": "waiting",
        "players": {
            "1": {"joined": False, "score": 0, "words": []},
            "2": {"joined": False, "score": 0, "words": []},
        },
    }


MATCH_STATE = new_match()


def score_word(word_len: int) -> int:
    if word_len <= 2:
        return 0
    if word_len <= 4:
        return 1
    if word_len == 5:
        return 2
    if word_len == 6:
        return 3
    if word_len == 7:
        return 5
    return 11


def time_remaining(match: dict) -> int:
    if match["start_time"] is None:
        return match["duration"]
    elapsed = int(time.time() - match["start_time"])
    return max(0, match["duration"] - elapsed)


def update_match_status(match: dict) -> None:
    if match["start_time"] is None:
        return
    if time_remaining(match) == 0:
        match["status"] = "finished"


def maybe_start_match(match: dict) -> None:
    p1_ready = match["players"]["1"]["joined"]
    p2_ready = match["players"]["2"]["joined"]

    if p1_ready and p2_ready and match["start_time"] is None:
        match["start_time"] = time.time()
        match["status"] = "running"


def normalize_word(raw_word: str) -> str:
    return "".join(ch for ch in raw_word.lower() if ch.isalpha())


def neighbors(r: int, c: int):
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            nr, nc = r + dr, c + dc
            if 0 <= nr < 4 and 0 <= nc < 4:
                yield nr, nc


def word_on_board(word: str, board: list[list[str]]) -> bool:
    target = word.lower()
    tokens = [[cell.lower() for cell in row] for row in board]

    def dfs(r: int, c: int, idx: int, visited: set[tuple[int, int]]) -> bool:
        token = tokens[r][c]
        if not target.startswith(token, idx):
            return False

        next_idx = idx + len(token)
        if next_idx == len(target):
            return True

        visited.add((r, c))
        for nr, nc in neighbors(r, c):
            if (nr, nc) in visited:
                continue
            if dfs(nr, nc, next_idx, visited):
                return True
        visited.remove((r, c))
        return False

    for row in range(4):
        for col in range(4):
            if dfs(row, col, 0, set()):
                return True
    return False


def winner_info(match: dict):
    p1 = match["players"]["1"]["score"]
    p2 = match["players"]["2"]["score"]

    if p1 == p2:
        return {"winner": "tie", "text": "Tie game"}
    if p1 > p2:
        return {"winner": "1", "text": "Player 1 wins"}
    return {"winner": "2", "text": "Player 2 wins"}


def serialize_state(match: dict, view: str, player: str | None) -> dict:
    remaining = time_remaining(match)
    payload = {
        "id": match["id"],
        "board": match["board"],
        "status": match["status"],
        "duration": match["duration"],
        "time_remaining": remaining,
        "players": {
            "1": {
                "joined": match["players"]["1"]["joined"],
                "score": match["players"]["1"]["score"],
                "word_count": len(match["players"]["1"]["words"]),
            },
            "2": {
                "joined": match["players"]["2"]["joined"],
                "score": match["players"]["2"]["score"],
                "word_count": len(match["players"]["2"]["words"]),
            },
        },
    }

    if view == "spectator":
        payload["players"]["1"]["words"] = match["players"]["1"]["words"]
        payload["players"]["2"]["words"] = match["players"]["2"]["words"]
    elif view == "player" and player in {"1", "2"}:
        opponent = "2" if player == "1" else "1"
        payload["my_words"] = match["players"][player]["words"]
        payload["opponent"] = {
            "id": opponent,
            "score": match["players"][opponent]["score"],
            "word_count": len(match["players"][opponent]["words"]),
        }

    if match["status"] == "finished":
        payload["result"] = winner_info(match)

    return payload


def error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


@app.get("/")
def home():
    return render_template("home.html")


@app.get("/play/<player_id>")
def play(player_id: str):
    if player_id not in {"1", "2"}:
        return error("Invalid player", 404)
    return render_template("player.html", player_id=player_id)


@app.get("/spectate")
def spectate():
    return render_template("spectator.html")


@app.post("/api/new-match")
def api_new_match():
    global MATCH_STATE
    with STATE_LOCK:
        MATCH_STATE = new_match()
        return jsonify({"ok": True, "state": serialize_state(MATCH_STATE, "spectator", None)})


@app.post("/api/join")
def api_join():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")

    with STATE_LOCK:
        if MATCH_STATE["status"] == "finished":
            return error("Match finished. Start a new match.")

        MATCH_STATE["players"][player]["joined"] = True
        maybe_start_match(MATCH_STATE)
        return jsonify({"ok": True, "state": serialize_state(MATCH_STATE, "player", player)})


@app.post("/api/submit")
def api_submit():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")

    submitted = normalize_word(str(body.get("word", "")))
    if len(submitted) < 3:
        return error("Word must be at least 3 letters")

    with STATE_LOCK:
        update_match_status(MATCH_STATE)

        if MATCH_STATE["status"] != "running":
            return error("Match is not running")

        if time_remaining(MATCH_STATE) <= 0:
            MATCH_STATE["status"] = "finished"
            return error("Time is up")

        player_state = MATCH_STATE["players"][player]
        if submitted in player_state["words"]:
            return error("Already found")

        if submitted not in WORD_SET:
            return error("Not in dictionary")

        if not word_on_board(submitted, MATCH_STATE["board"]):
            return error("Word not found on board")

        points = score_word(len(submitted))
        player_state["words"].append(submitted)
        player_state["score"] += points

        return jsonify(
            {
                "ok": True,
                "word": submitted,
                "points": points,
                "score": player_state["score"],
                "state": serialize_state(MATCH_STATE, "player", player),
            }
        )


@app.get("/api/state")
def api_state():
    view = request.args.get("view", "spectator")
    player = request.args.get("player")

    with STATE_LOCK:
        update_match_status(MATCH_STATE)
        if view not in {"spectator", "player"}:
            return error("Invalid view")
        if view == "player" and player not in {"1", "2"}:
            return error("Missing player id")

        return jsonify({"ok": True, "state": serialize_state(MATCH_STATE, view, player)})


WORD_SET = load_word_set()

if __name__ == "__main__":
    app.run(debug=True)
