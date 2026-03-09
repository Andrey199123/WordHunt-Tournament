# Word Hunt Tournament
### Bytes For Better Lives - Beginner Lesson README

This project is a 2-player Word Hunt game for your club event.
It is written to be easy to explain to middle school students.

Players use these pages:

- `/play/1` = Player 1 screen
- `/play/2` = Player 2 screen
- `/spectate` = host/live screen

---

## What Kids Should Understand First

You can explain the game using this idea:

- The **server** is the referee.
- The **players** are just controllers.
- The **spectator screen** is the scoreboard and live view.

The referee (server) is in charge of:

- the letters
- the timer
- checking if words are real
- giving points
- deciding the winner

---

## Super Quick How To Run A Match

1. Open `/spectate`.
2. Click `Create Match`.
3. Open `/play/1` and `/play/2` on player devices.
4. Wait for both players to join.
5. Click `Start Match`.
6. Players swipe words for 90 seconds.
7. End screen shows winner (or tie).

---

## Where The Important Code Lives

- `api/index.py`
  The main game brain (rules, score, timer, match state)

- `static/player.js`
  Reads finger/mouse swipes, draws swipe lines, sends words to server

- `static/spectator.js`
  Host controls, live side-by-side player boards, start/reset buttons

- `data/words.txt`
  Dictionary list of allowed words

---

## How One Word Is Processed

When a player swipes a word:

1. `player.js` sends that word to `POST /api/submit`.
2. `api/index.py` checks:
   - Is match running?
   - Is word in dictionary?
   - Can this word be made from adjacent tiles?
   - Did this player already use this word?
3. If valid, server adds points.
4. All screens read new score from `GET /api/state`.

This is a good lesson:  
"UI asks, server decides."

---

## Scoring Rules Used

The backend function `score_word()` gives points:

- 3 letters = 100
- 4 letters = 400
- 5 letters = 800
- 6 letters = 1400
- 7 letters = 1800
- 8+ letters = 2200 + 400 for each extra letter

---

## How The Timer Works

`start-match` saves a start time.

Then every state update calculates:

- how many seconds passed
- how many seconds are left

When time reaches 0:

- match status becomes `finished`
- winner (or tie) is calculated
- final scores and word counts are shown

---

## Why Redis Is Used (Simple Version)

Vercel runs many small server copies.
If we only saved game data in normal Python memory, one screen might see old data.

Redis is shared storage, so all screens see the same match.

---

## 8-Minute Teaching Script (Middle School Friendly)

You can read this almost word-for-word:

1. "This file `api/index.py` is our game referee."
2. "This object stores everything about one match."
3. "Players swipe letters in `player.js`."
4. "Words get sent to the referee using `/api/submit`."
5. "The referee checks if the word is legal."
6. "If legal, points are added."
7. "Every screen asks for updates using `/api/state`."
8. "When timer ends, winner or tie is shown."

---

## Local Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python api/index.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000)

---

## Deploy

1. Push to GitHub.
2. Import repo to Vercel.
3. Connect Upstash Redis.
4. Deploy.

Project link: [https://github.com/Andrey199123/WordHunt-Tournament](https://github.com/Andrey199123/WordHunt-Tournament)

Made by Andrey Vasilyev
