# Doza Drafter: LoL captain draft

A browser app for **League of Legends in-house games**. Two captains connect from their own browsers and draft 10 players **one by one**. Every pick is a **player and a role**. Players are rated **1–5 stars on each role**, and each team has a **star cap** so the teams stay balanced.

- Zero dependencies: plain Node.js server plus a vanilla JS front end
- Real-time over Server-Sent Events; the server holds the authoritative draft state, so captains can't cheat
- Local **hot-seat mode** that works with no server, even from static hosting
- Player pool, setup, room links and finished drafts are saved in `localStorage`, with JSON/CSV import and export

## Quick start

```bash
node server.js          # or: npm start
# open http://localhost:3000
```

Requires Node 18 or newer. There is no `npm install` step.

| Env var    | Default  | Meaning                                  |
|------------|----------|------------------------------------------|
| `PORT`     | `3000`   | HTTP port                                |
| `HOST`     | `0.0.0.0`| Bind address                             |
| `DATA_DIR` | `./data` | Where rooms are saved (`rooms.json`) so they survive restarts |

### Docker

```bash
docker build -t doza-drafter .
docker run -d -p 3000:3000 -v doza-data:/app/data doza-drafter
```

### Behind nginx

SSE needs buffering turned off for `/api/`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

### Static-only hosting

The `public/` folder is a complete static site (GitHub Pages, Netlify and so on). Without the Node server, only **local hot-seat** drafts are available. Online rooms need `server.js`.

## How a draft works

1. **Players page**: rate everyone 1–5 on TOP / JNG / MID / ADC / SUP. Import from CSV: `name,top,jng,mid,adc,sup`.
2. **New draft**: pick tonight's 10 players and the two captains, and adjust the rules.
3. **Create online room**: you get the organizer view plus private links for Captain A, Captain B and spectators.
4. **Lobby**: both captains click Ready, or the organizer force-starts.
5. **Captain roles**: if the captains are among the 10 players, each one locks their own role first.
6. **Draft**: snake order (A B B A A B B A). Each pick is player + role. Illegal options are greyed out, with the reason shown.
7. **Swap phase** (optional): captains can swap roles inside their own team, still under the cap. Both click Ready.
8. **Done**: copy the lineup for Discord. The draft is saved to History.

## Balance rules (the details)

| Rule | Default | Why |
|------|---------|-----|
| A pick is worth the player's rating **on the assigned role** | – | Off-role players cost fewer stars, and they really are weaker there. |
| **Star cap** = ⌈best possible total ÷ 2⌉ + tolerance | tolerance **+1** | Neither team can stack. The best possible total is the highest score the 10 players can reach across the 10 slots. |
| **No dead ends**: a pick is legal only if the rest of the draft can still finish with both teams under the cap | always on | Checked exactly with a small dynamic program, so the last pick is never impossible. |
| **Snake pick order** | snake | Balances out the first-pick advantage. Alternate (ABAB) is also available. |
| First pick is a **coin flip**; the other team gets **blue side** | – | Compensates the team that picks second. |
| **Min role rating** | 1★ (off) | Set it to 2★ to stop anyone being put on a role they can't play. |
| **Pick timer** | 45 s | When it runs out, the best legal pick is made automatically. The organizer can pause it. |
| **Swap phase** | on, 60 s | Room for player freedom: teammates can trade lanes after the draft, as long as the team stays under the cap. |
| **Organizer tools** | – | Undo, pause or resume, force start, and acting on behalf of either captain. |

The balance bar shows an Elo-style estimate. Each star of difference is worth about 7 percentage points near 50/50.

## Project layout

```
server.js            zero-dependency HTTP + SSE server, room storage
public/index.html    app shell
public/app.js        UI: router, players, setup, draft HUD, history
public/engine.js     rules engine (shared by browser and server)
public/style.css     HUD styling
test/engine.test.js  fuzz test: 500 random drafts, never a dead end or cap break
```

Run the tests with `npm test`.

## API (for bots/integrations)

- `POST /api/rooms` `{players[10], captains:{A:{playerId},B:{playerId}}, teamNames, settings}` returns `{roomId, keys:{A,B,admin}}`
- `GET /api/rooms/:id?key=` returns a state snapshot and your seat
- `GET /api/rooms/:id/events?key=` opens an SSE stream (`state` events)
- `POST /api/rooms/:id/action` `{key, action}` where action is `ready`, `forceStart`, `lockCaptain{role}`, `pick{playerId,role}`, `swap{r1,r2}`, `pause`, `resume` or `undo`. The organizer can add `asTeam`.

## License

MIT
