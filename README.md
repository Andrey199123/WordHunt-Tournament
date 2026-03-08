# Word Hunt Tournament (Flask + Vercel)

Simple two-player Word Hunt game for live club tournaments with three views:

- `/play/1` for Player 1
- `/play/2` for Player 2
- `/spectate` for live scoreboard and both word lists

## Features

- Shared 4x4 board generated from classic Boggle dice
- 90-second head-to-head timer
- Swipe/touch tile selection (adjacent cells only)
- Dictionary validation from bundled word list (`data/words.txt`)
- Real-time updates via polling (~0.8s)
- Simple reset flow (`Start New Match`)

## Local Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python api/index.py
```

Then open [http://127.0.0.1:5000](http://127.0.0.1:5000)

## Deploy to Vercel

1. Push this project to GitHub.
2. In Vercel, click **Add New Project** and import the repo.
3. No build command needed; Vercel reads `vercel.json`.
4. Deploy.

## Notes

- This implementation keeps match state in server memory for simplicity.
- For a single live classroom match, this is usually fine.
- For production-grade consistency across many concurrent serverless instances, add a shared state store (e.g., Vercel KV/Redis).

## Rules Implemented

- Words must be at least 3 letters.
- Letters must be formed by adjacent tiles; no tile reused in the same word.
- Scoring: 3-4 letters = 1, 5 = 2, 6 = 3, 7 = 5, 8+ = 11.
