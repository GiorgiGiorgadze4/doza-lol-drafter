# Doza Drafter: LoL captain draft

A browser app for **League of Legends in-house games**. Two captains draft **one by one** from the whole roster on a shared screen, dragging each player straight onto a role slot of their team. Players are rated **1–5 stars on each role**, and both team totals and a win estimate update live as players are placed.

- **100% front end**: plain HTML/CSS/vanilla JS in `public/`, no backend, no build step, no dependencies
- The player roster is a committed file, **`public/data/players.json`**, so every push publishes the latest ratings
- Drafts in progress and finished drafts are saved in `localStorage`, with JSON/CSV import and export

## Quick start

```bash
npm run dev
# open http://localhost:5173
```

There is no `npm install` step. `npm run dev` starts a tiny local helper (`scripts/dev.js`, zero dependencies) that serves `public/`, live-reloads on file changes and, most importantly, **writes your rating edits from the Players page into `public/data/players.json`**.

### Updating ratings

1. `npm run dev` and open the **Players** page
2. Click stars, rename, add or delete players. Every change is saved to `public/data/players.json`
3. `git commit -am "Update ratings" && git push`. Anyone opening the site now gets the new roster

On the published (static) site the Players page still works, but edits are kept in that browser only, as an override on top of the published roster. When a new `players.json` is published, the override is dropped so everyone is back on the shared data. You can also **Download players.json** there and drop it into the repo by hand.

### Hosting

`public/` is the whole site. Deploy that folder as-is to GitHub Pages, Netlify, Cloudflare Pages or any static host. Any static file server also works locally, e.g. `python -m http.server -d public` (edits then stay in the browser, as on the published site).

## How a draft works

1. **Players page**: rate everyone 1–5 on TOP / JNG / MID / ADC / SUP. Import from CSV: `name,top,jng,mid,adc,sup`.
2. **New draft**: the whole roster is shown; choose the two captains and adjust the rules. Anyone not picked sits out.
3. **Start draft**: the draft opens on this screen; share it on Discord or stream if the captains aren't in the same room.
4. **Lobby**: click Start draft when both captains are ready.
5. **Captains**: if they play, they start on their main role (their highest rating in `players.json`), placed automatically.
6. **Draft**: one pick each, alternating (A B A B…). The whole roster stays listed next to the 5v5 board; on your turn drag a player onto an empty role slot of your team (or tap the player, then the slot). Legal slots light up green with the new team total, illegal ones show the reason. Picked players (on the board or in the list) can be dragged to another role of their team at any time (move or swap with a teammate). At any time either team can also drop a roster player on one of its players to swap them in (the other goes back to the roster), or drag a player back to the roster, which gives that pick back at the end of the order. None of this uses a turn; captains can't be benched.
7. **Lock in**: when all picks are made the draft isn't final yet. Each captain can still change their team, then locks in. A lock-in can be cancelled until the other captain locks in too; once both are locked in, the draft is final.
8. **Done**: copy the lineup for Discord. The draft is saved to History.

## Balance rules (the details)

| Rule | Default | Why |
|------|---------|-----|
| A pick is worth the player's rating **on the assigned role** | – | Off-role players add fewer stars, and they really are weaker there. |
| **No star cap** | – | Captains draft freely from the whole roster; the board shows both totals and the balance bar a rough win estimate. (The engine still supports the older capped 10-player mode.) |
| **No dead ends**: a pick is legal only if both teams can still fill every role with the players left | always on | Checked with a small matching search, so the last pick is never impossible. |
| **Alternating picks** | A B A B… | One player per turn; the team that picks second gets blue side to balance the first pick. |
| First pick is a **coin flip**; the other team gets **blue side** | – | Compensates the team that picks second. |
| **Min role rating** | 1★ (off) | Set it to 2★ to stop anyone being put on a role they can't play. |
| **Pick timer** | 45 s | When it runs out, the best legal pick is made automatically. The organizer can pause it. |
| **Lock in** | always, no timer | The draft only counts once both captains lock in; either can cancel until both have. |
| **Controls** | – | Undo, and pause or resume the timer. |

The balance bar shows an Elo-style estimate. Each star of difference is worth about 7 percentage points near 50/50.

## Project layout

```
public/index.html        app shell
public/app.js            UI: router, players, setup, draft HUD, history
public/engine.js         rules engine
public/style.css         HUD styling
public/data/players.json the player roster (edit it from the UI with npm run dev)
scripts/dev.js           local dev helper: static server + saves players.json
test/engine.test.js      fuzz tests: random capped drafts and full-roster no-cap drafts, never a dead end
```

Run the tests with `npm test`.

## License

MIT
