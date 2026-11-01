# Word Hunt Tournament

A two-player Word Hunt game built for a Bytes for Better Lives club event. Players swipe words on their own boards while a spectator screen shows the live match.

[Play the live game](https://wordhunt-tournament.vercel.app)

## How a match works

The host creates a match from `/spectate`, then opens `/play/1` and `/play/2` for the players. Once both players join, the host starts a 90-second round. The server owns the board, timer, word validation, scores, and winner so every screen sees the same state.

Each submitted word is checked against the dictionary, the board's adjacency rules, and that player's previous words before points are awarded. Scores increase with word length, from 100 points for three letters to 2,200 points plus 400 for each additional letter at eight letters and above.

## Project structure

- `api/index.py` - game state, validation, scoring, and API routes
- `static/player.js` - touch and mouse input for player boards
- `static/spectator.js` - host controls and live scoreboard
- `templates/` - player and spectator pages
- `data/words.txt` - allowed-word dictionary

The app keeps state in Redis when `REDIS_URL` or `KV_URL` is configured. It falls back to in-process state for a simple local run, but shared Redis state is needed for a multi-instance deployment.

## Local run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python api/index.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). For a deployed match, configure a shared Redis-compatible service before starting the app.

Built for Bytes for Better Lives.
