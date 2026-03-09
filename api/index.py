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
        letters.append(face)

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
            "1": {"joined": False, "score": 0, "words": [], "last_points": 0},
            "2": {"joined": False, "score": 0, "words": [], "last_points": 0},
        },
        "active_swipes": {
            "1": {"path": [], "word": "", "updated_at": None},
            "2": {"path": [], "word": "", "updated_at": None},
        },
    }


MATCH_STATE = new_match()


def score_word(word_len: int) -> int:
    # GamePigeon Word Hunt style scoring by word length.
    if word_len < 3:
        return 0
    if word_len == 3:
        return 100
    if word_len == 4:
        return 400
    if word_len == 5:
        return 800
    if word_len == 6:
        return 1400
    if word_len == 7:
        return 1800
    # 8+ continues scaling by 400.
    return 2200 + (word_len - 8) * 400


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
        match["active_swipes"]["1"] = {"path": [], "word": "", "updated_at": None}
        match["active_swipes"]["2"] = {"path": [], "word": "", "updated_at": None}


def players_ready_to_start(match: dict) -> bool:
    p1_ready = match["players"]["1"]["joined"]
    p2_ready = match["players"]["2"]["joined"]
    return p1_ready and p2_ready


def sanitize_path(raw_path) -> list[list[int]]:
    if not isinstance(raw_path, list):
        return []

    seen: set[tuple[int, int]] = set()
    sanitized: list[list[int]] = []
    for point in raw_path:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            continue
        try:
            row = int(point[0])
            col = int(point[1])
        except (TypeError, ValueError):
            continue

        if not (0 <= row < 4 and 0 <= col < 4):
            continue
        if (row, col) in seen:
            continue

        seen.add((row, col))
        sanitized.append([row, col])
        if len(sanitized) >= 16:
            break

    return sanitized


def cleanup_stale_swipes(match: dict, stale_after_seconds: float = 1.2) -> None:
    now = time.time()
    for player in ("1", "2"):
        swipe = match["active_swipes"][player]
        updated_at = swipe.get("updated_at")
        if not updated_at:
            continue
        if now - float(updated_at) > stale_after_seconds:
            match["active_swipes"][player] = {"path": [], "word": "", "updated_at": None}


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
    p1_words = len(match["players"]["1"]["words"])
    p2_words = len(match["players"]["2"]["words"])

    if p1 == p2:
        return {
            "winner": "tie",
            "text": "Tie game",
            "p1_words": p1_words,
            "p2_words": p2_words,
            "p1_score": p1,
            "p2_score": p2,
            "summary": f"Tie game. P1: {p1} pts, {p1_words} words. P2: {p2} pts, {p2_words} words.",
        }
    if p1 > p2:
        return {
            "winner": "1",
            "text": "Player 1 wins",
            "p1_words": p1_words,
            "p2_words": p2_words,
            "p1_score": p1,
            "p2_score": p2,
            "summary": f"Player 1 wins. P1: {p1} pts, {p1_words} words. P2: {p2} pts, {p2_words} words.",
        }
    return {
        "winner": "2",
        "text": "Player 2 wins",
        "p1_words": p1_words,
        "p2_words": p2_words,
        "p1_score": p1,
        "p2_score": p2,
        "summary": f"Player 2 wins. P1: {p1} pts, {p1_words} words. P2: {p2} pts, {p2_words} words.",
    }


def serialize_state(match: dict, view: str, player: str | None) -> dict:
    cleanup_stale_swipes(match)
    remaining = time_remaining(match)
    payload = {
        "id": match["id"],
        "board": match["board"],
        "status": match["status"],
        "duration": match["duration"],
        "time_remaining": remaining,
        "can_start": match["status"] == "waiting" and players_ready_to_start(match),
        "players": {
            "1": {
                "joined": match["players"]["1"]["joined"],
                "score": match["players"]["1"]["score"],
                "word_count": len(match["players"]["1"]["words"]),
                "last_points": match["players"]["1"]["last_points"],
            },
            "2": {
                "joined": match["players"]["2"]["joined"],
                "score": match["players"]["2"]["score"],
                "word_count": len(match["players"]["2"]["words"]),
                "last_points": match["players"]["2"]["last_points"],
            },
        },
    }

    if view == "spectator":
        payload["players"]["1"]["words"] = match["players"]["1"]["words"]
        payload["players"]["2"]["words"] = match["players"]["2"]["words"]
        payload["swipes"] = {
            "1": {
                "path": match["active_swipes"]["1"]["path"],
                "word": match["active_swipes"]["1"]["word"],
            },
            "2": {
                "path": match["active_swipes"]["2"]["path"],
                "word": match["active_swipes"]["2"]["word"],
            },
        }
    elif view == "player" and player in {"1", "2"}:
        opponent = "2" if player == "1" else "1"
        payload["my_words"] = match["players"][player]["words"]
        payload["opponent"] = {
            "id": opponent,
            "score": match["players"][opponent]["score"],
            "word_count": len(match["players"][opponent]["words"]),
            "last_points": match["players"][opponent]["last_points"],
        }

    if match["status"] == "finished":
        payload["result"] = winner_info(match)

    return payload


def error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def requested_match_id_from_json(body: dict) -> str | None:
    raw = body.get("match_id")
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def requested_match_id_from_query() -> str | None:
    raw = request.args.get("match_id")
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def match_id_mismatch(requested_id: str | None, match: dict) -> bool:
    return requested_id is not None and requested_id != match["id"]


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
    requested_match_id = requested_match_id_from_json(body)

    with STATE_LOCK:
        if match_id_mismatch(requested_match_id, MATCH_STATE):
            return error("Match id mismatch", 409)
        if MATCH_STATE["status"] == "finished":
            return error("Match finished. Start a new match.")

        MATCH_STATE["players"][player]["joined"] = True
        return jsonify({"ok": True, "state": serialize_state(MATCH_STATE, "player", player)})


@app.post("/api/start-match")
def api_start_match():
    with STATE_LOCK:
        update_match_status(MATCH_STATE)

        if MATCH_STATE["status"] == "finished":
            return error("Match finished. Start a new match.")

        if MATCH_STATE["status"] == "running":
            return error("Match already running")

        if not players_ready_to_start(MATCH_STATE):
            return error("Both players must join before starting")

        MATCH_STATE["start_time"] = time.time()
        MATCH_STATE["status"] = "running"
        return jsonify({"ok": True, "state": serialize_state(MATCH_STATE, "spectator", None)})


@app.post("/api/submit")
def api_submit():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")
    requested_match_id = requested_match_id_from_json(body)

    submitted = normalize_word(str(body.get("word", "")))
    if len(submitted) < 3:
        return error("Word must be at least 3 letters")

    with STATE_LOCK:
        if match_id_mismatch(requested_match_id, MATCH_STATE):
            return error("Match id mismatch", 409)
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
        player_state["last_points"] = points
        MATCH_STATE["active_swipes"][player] = {"path": [], "word": "", "updated_at": None}

        return jsonify(
            {
                "ok": True,
                "word": submitted,
                "points": points,
                "score": player_state["score"],
                "state": serialize_state(MATCH_STATE, "player", player),
            }
        )


@app.post("/api/swipe-update")
def api_swipe_update():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")
    requested_match_id = requested_match_id_from_json(body)

    with STATE_LOCK:
        if match_id_mismatch(requested_match_id, MATCH_STATE):
            return error("Match id mismatch", 409)
        update_match_status(MATCH_STATE)

        if MATCH_STATE["status"] != "running":
            MATCH_STATE["active_swipes"][player] = {"path": [], "word": "", "updated_at": None}
            return jsonify({"ok": True})

        path = sanitize_path(body.get("path", []))
        word = normalize_word(str(body.get("word", "")))[:16]
        MATCH_STATE["active_swipes"][player] = {
            "path": path,
            "word": word,
            "updated_at": time.time(),
        }
        return jsonify({"ok": True})


@app.get("/api/state")
def api_state():
    view = request.args.get("view", "spectator")
    player = request.args.get("player")
    requested_match_id = requested_match_id_from_query()

    with STATE_LOCK:
        if match_id_mismatch(requested_match_id, MATCH_STATE):
            return error("Match id mismatch", 409)
        update_match_status(MATCH_STATE)
        if view not in {"spectator", "player"}:
            return error("Invalid view")
        if view == "player" and player not in {"1", "2"}:
            return error("Missing player id")

        return jsonify({"ok": True, "state": serialize_state(MATCH_STATE, view, player)})


WORD_SET = load_word_set()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
