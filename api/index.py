import json
import os
import random
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from flask import Flask, jsonify, render_template, request

try:
    import redis
except ImportError:  # pragma: no cover - fallback for local envs without redis package
    redis = None

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
REDIS_STATE_KEY = "wordhunt:match_state:v1"
REDIS_LOCK_KEY = "wordhunt:match_lock:v1"
REDIS_URL = os.environ.get("REDIS_URL") or os.environ.get("KV_URL")

REDIS_CLIENT = None
if redis is not None and REDIS_URL:
    try:
        REDIS_CLIENT = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        REDIS_CLIENT.ping()
    except Exception:
        REDIS_CLIENT = None


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


def blank_player_state() -> dict:
    return {"joined": False, "score": 0, "words": [], "last_points": 0}


def blank_swipe_state() -> dict:
    return {"path": [], "word": "", "updated_at": None}


def hydrate_match(raw_state) -> dict:
    if not isinstance(raw_state, dict):
        return new_match()

    state = raw_state
    if not isinstance(state.get("id"), str) or not state["id"]:
        state["id"] = uuid.uuid4().hex[:8]

    board = state.get("board")
    if not (
        isinstance(board, list)
        and len(board) == 4
        and all(isinstance(row, list) and len(row) == 4 for row in board)
    ):
        state["board"] = generate_board()

    if state.get("status") not in {"waiting", "running", "finished"}:
        state["status"] = "waiting"

    try:
        state["duration"] = int(state.get("duration", 90))
    except (TypeError, ValueError):
        state["duration"] = 90
    if state["duration"] <= 0:
        state["duration"] = 90

    if "start_time" not in state:
        state["start_time"] = None
    if "created_at" not in state:
        state["created_at"] = time.time()

    players = state.get("players")
    if not isinstance(players, dict):
        players = {}
    for pid in ("1", "2"):
        player = players.get(pid)
        if not isinstance(player, dict):
            player = blank_player_state()
        player["joined"] = bool(player.get("joined", False))
        try:
            player["score"] = int(player.get("score", 0))
        except (TypeError, ValueError):
            player["score"] = 0
        try:
            player["last_points"] = int(player.get("last_points", 0))
        except (TypeError, ValueError):
            player["last_points"] = 0
        words = player.get("words", [])
        if not isinstance(words, list):
            words = []
        player["words"] = [normalize_word(str(word)) for word in words if normalize_word(str(word))]
        players[pid] = player
    state["players"] = players

    swipes = state.get("active_swipes")
    if not isinstance(swipes, dict):
        swipes = {}
    for pid in ("1", "2"):
        swipe = swipes.get(pid)
        if not isinstance(swipe, dict):
            swipe = blank_swipe_state()
        swipe["path"] = sanitize_path(swipe.get("path", []))
        swipe["word"] = normalize_word(str(swipe.get("word", "")))[:16]
        updated_at = swipe.get("updated_at")
        if updated_at is not None:
            try:
                updated_at = float(updated_at)
            except (TypeError, ValueError):
                updated_at = None
        swipe["updated_at"] = updated_at
        swipes[pid] = swipe
    state["active_swipes"] = swipes

    return state


def dump_state(state: dict) -> str:
    return json.dumps(state, separators=(",", ":"))


def load_match_state() -> dict:
    global MATCH_STATE
    if REDIS_CLIENT is None:
        MATCH_STATE = hydrate_match(MATCH_STATE)
        return MATCH_STATE

    raw_state = REDIS_CLIENT.get(REDIS_STATE_KEY)
    if not raw_state:
        state = new_match()
        REDIS_CLIENT.set(REDIS_STATE_KEY, dump_state(state))
        return state

    try:
        parsed = json.loads(raw_state)
    except json.JSONDecodeError:
        parsed = new_match()
    return hydrate_match(parsed)


def save_match_state(state: dict) -> None:
    global MATCH_STATE
    state = hydrate_match(state)
    if REDIS_CLIENT is None:
        MATCH_STATE = state
        return
    REDIS_CLIENT.set(REDIS_STATE_KEY, dump_state(state))


@contextmanager
def state_guard():
    if REDIS_CLIENT is None:
        with STATE_LOCK:
            yield
        return

    lock = REDIS_CLIENT.lock(REDIS_LOCK_KEY, timeout=8, blocking_timeout=4, sleep=0.02, thread_local=False)
    acquired = False
    try:
        acquired = bool(lock.acquire(blocking=True))
        if not acquired:
            raise RuntimeError("Could not acquire state lock")
        yield
    finally:
        if acquired:
            try:
                lock.release()
            except Exception:
                pass


@contextmanager
def locked_match(writeback: bool = True):
    with state_guard():
        match = load_match_state()
        yield match
        if writeback:
            save_match_state(match)


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


def update_match_status(match: dict) -> bool:
    changed = False
    if match["start_time"] is None:
        return changed
    if time_remaining(match) == 0 and match["status"] != "finished":
        match["status"] = "finished"
        match["active_swipes"]["1"] = {"path": [], "word": "", "updated_at": None}
        match["active_swipes"]["2"] = {"path": [], "word": "", "updated_at": None}
        changed = True
    return changed


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


def cleanup_stale_swipes(match: dict, stale_after_seconds: float = 1.2) -> bool:
    changed = False
    now = time.time()
    for player in ("1", "2"):
        swipe = match["active_swipes"][player]
        updated_at = swipe.get("updated_at")
        if not updated_at:
            continue
        if now - float(updated_at) > stale_after_seconds:
            match["active_swipes"][player] = {"path": [], "word": "", "updated_at": None}
            changed = True
    return changed


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


def state_unavailable_error():
    return error("State sync temporarily unavailable. Please retry.", 503)


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
    try:
        with state_guard():
            match = new_match()
            save_match_state(match)
            return jsonify({"ok": True, "state": serialize_state(match, "spectator", None)})
    except RuntimeError:
        return state_unavailable_error()


@app.post("/api/join")
def api_join():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")

    try:
        with locked_match(writeback=True) as match:
            if match["status"] == "finished":
                return error("Match finished. Start a new match.")

            match["players"][player]["joined"] = True
            return jsonify({"ok": True, "state": serialize_state(match, "player", player)})
    except RuntimeError:
        return state_unavailable_error()


@app.post("/api/start-match")
def api_start_match():
    try:
        with locked_match(writeback=True) as match:
            update_match_status(match)

            if match["status"] == "finished":
                return error("Match finished. Start a new match.")

            if match["status"] == "running":
                return error("Match already running")

            if not players_ready_to_start(match):
                return error("Both players must join before starting")

            match["start_time"] = time.time()
            match["status"] = "running"
            return jsonify({"ok": True, "state": serialize_state(match, "spectator", None)})
    except RuntimeError:
        return state_unavailable_error()


@app.post("/api/submit")
def api_submit():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")

    submitted = normalize_word(str(body.get("word", "")))
    if len(submitted) < 3:
        return error("Word must be at least 3 letters")

    try:
        with locked_match(writeback=True) as match:
            update_match_status(match)

            if match["status"] != "running":
                return error("Match is not running")

            if time_remaining(match) <= 0:
                match["status"] = "finished"
                return error("Time is up")

            player_state = match["players"][player]
            if submitted in player_state["words"]:
                return error("Already found")

            if submitted not in WORD_SET:
                return error("Not in dictionary")

            if not word_on_board(submitted, match["board"]):
                return error("Word not found on board")

            points = score_word(len(submitted))
            player_state["words"].append(submitted)
            player_state["score"] += points
            player_state["last_points"] = points
            match["active_swipes"][player] = {"path": [], "word": "", "updated_at": None}

            return jsonify(
                {
                    "ok": True,
                    "word": submitted,
                    "points": points,
                    "score": player_state["score"],
                    "state": serialize_state(match, "player", player),
                }
            )
    except RuntimeError:
        return state_unavailable_error()


@app.post("/api/swipe-update")
def api_swipe_update():
    body = request.get_json(silent=True) or {}
    player = str(body.get("player", ""))
    if player not in {"1", "2"}:
        return error("Player must be '1' or '2'")

    try:
        with locked_match(writeback=True) as match:
            update_match_status(match)

            if match["status"] != "running":
                match["active_swipes"][player] = {"path": [], "word": "", "updated_at": None}
                return jsonify({"ok": True})

            path = sanitize_path(body.get("path", []))
            word = normalize_word(str(body.get("word", "")))[:16]
            match["active_swipes"][player] = {
                "path": path,
                "word": word,
                "updated_at": time.time(),
            }
            return jsonify({"ok": True})
    except RuntimeError:
        return state_unavailable_error()


@app.get("/api/state")
def api_state():
    view = request.args.get("view", "spectator")
    player = request.args.get("player")

    if view not in {"spectator", "player"}:
        return error("Invalid view")
    if view == "player" and player not in {"1", "2"}:
        return error("Missing player id")

    try:
        with locked_match(writeback=False) as match:
            dirty = update_match_status(match)
            dirty = cleanup_stale_swipes(match) or dirty
            if dirty:
                save_match_state(match)
            return jsonify({"ok": True, "state": serialize_state(match, view, player)})
    except RuntimeError:
        return state_unavailable_error()


WORD_SET = load_word_set()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
