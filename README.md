# Farcast

A shared tabletop for playing Magic remotely. No OBS, no masking, no camera on the cards.
Each player loads their own decklist, and the server makes sure your hand and library are
never sent to your opponent.

Phase 1: two players, manual tabletop (no rules engine), accounts, saved decks, and
win–loss records per deck.

## Run it locally

```bash
npm install
npm run db:migrate:local     # creates the local D1 tables
npm run dev                  # http://localhost:8787
```

Open two browser windows (one normal, one private), create an account in each, save a
deck in each, and play against yourself.

End-to-end test. It starts its own stand-ins for Scryfall, Google, and Cloudflare Access, so it
runs offline. Start the dev server with the test settings listed at the top of
`test/smoke.mjs`, on a fresh local database, then run `npm test`.

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler d1 create farcast          # copy the database_id it prints
# paste it into wrangler.jsonc → d1_databases[0].database_id
npm run db:migrate                      # creates the tables in the remote D1
npm run deploy
```

Durable Objects with SQLite storage are available on the Workers free plan.

## Fonts

Gloock (display: wordmark, deck names, life totals) and Hanken Grotesk (everything else), both
under the SIL Open Font License. They're bundled in `public/fonts` with their licenses, so players'
browsers never contact Google. To change them, swap the files and the `--display` / `--ui`
variables at the top of `public/styles.css`.

## Sign-in

Three methods, each switched on in `wrangler.jsonc` → `vars`. Any mix works.

**Cloudflare Access (best for a private group).** Only people you list can reach the site at all,
and Access shows them a Google (or email code) login first. Free for up to 50 users.
1. In the Cloudflare dashboard, go to Zero Trust → Access → Applications → Add an application →
   Self-hosted. Use your Worker's hostname. Add Google as a login method if you like
   (Zero Trust → Settings → Authentication).
2. Add a policy: Include → Emails → your friends' addresses.
3. Copy the application's "Application Audience (AUD) Tag" into `ACCESS_AUD`, and your team
   domain (`yourteam.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`.
4. Optional: set `AUTH_PASSWORD` to `"off"`. Everyone is then signed in automatically from their
   Access login, and there are no passwords to reset.

**Google sign-in.** Adds a "Sign in with Google" button.
1. In Google Cloud Console → APIs & Services → Credentials, create an OAuth client ID
   (Web application). Add the authorized redirect URI
   `https://<your-worker-host>/api/auth/google/callback`.
2. Put the client ID in `GOOGLE_CLIENT_ID` and run `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
3. Optional: list allowed emails in `ALLOWED_EMAILS` to keep it to your group.

**Name and password.** On by default. There's no password reset (no email is set up), so once
Access or Google is on, consider turning it off.

**Rate limiting** is not built into the app. Add Cloudflare rate limiting rules (Security → WAF →
Rate limiting rules) for `POST /api/auth/login` and `POST /api/auth/register`, and optionally for
`/api/auth/google/*` and `/api/decks/resolve` (which calls Scryfall).

New Google and Access users choose the name other players see on their first visit. Anyone can
change their name later by clicking it at the top of the page.

## How it works

```
Browser ──HTTP──▶ Worker (src/index.ts)
   │                ├─ POST /api/rooms            create a room code, init its Durable Object
   │                ├─ GET  /api/rooms/:code      does the room exist / is it full
   │                ├─ POST /api/deck/resolve     decklist text or link → Scryfall card data
   │                └─ GET  /api/games?ids=…      finished games from D1
   │
   └──WebSocket──▶ GameRoom Durable Object (src/game-room.ts), one per room
                    ├─ holds the full game state (src/game.ts)
                    ├─ applies each action, then sends every player their own filtered view
                    ├─ hibernates between messages (idle rooms cost ~nothing)
                    ├─ on game end → writes a record to D1
                    └─ alarm: deletes itself after 1h (lobby), 3h idle (playing), 30 min (ended)
```

**Hidden information.** `viewFor()` in `src/game.ts` is the only place state leaves the server.
Opponents get your hand *count*, never its cards. Library contents are never in the shared
view, even for you; searching or peeking returns a private message to you alone. Face-down
cards are sent to opponents with their name and image stripped, and the log never names them.
Library cards get fresh ids on every shuffle so nobody can track a known card.

**Accounts.** See Sign-in above. Google sign-in uses the authorization-code flow with PKCE; the
Worker checks the ID token's issuer, audience, expiry, and verified email. Cloudflare Access
tokens are verified against your team's published signing keys (RS256), plus audience, issuer,
and expiry, on every request. Password accounts are stored in D1. Passwords are hashed with PBKDF2-SHA256
(100,000 iterations, per-user salt). Sessions are random tokens in an HttpOnly cookie; only a
SHA-256 of each token is stored. Requests that change data, and WebSocket connections, must come
from the site's own origin. The Worker checks the session and tells the game room who you are;
the browser can't claim to be someone else.

**Decks.** Saved per account. The editor has two boxes: the commander (one per line, up to two
for partners or a background) and the rest of the deck. There's no fixed deck size; that's left
to the players. If an export lists the commander in the deck box too, it's counted once. A deck is its exact card list: changing cards or the commander
saves a new deck (the old version is retired from your list but keeps its record). Renaming or
changing printings keeps the same deck. In a room you pick one of your saved decks; the room
loads it from D1, so the browser never supplies card lists directly.

**Ending a game.** End game → report the result. Claiming a win, or "No winner," waits for the
other player to confirm; they can confirm or choose "Keep playing," and you can withdraw the claim.
Admitting defeat (reporting that your opponent won, or conceding) ends the game at once. If a room
expires with a claim still unconfirmed, the game is saved as abandoned and doesn't count.

**Unranked games.** Choose Ranked or Unranked when creating a game; either player can switch it in
the lobby before the game starts (which asks both players to ready up again). Unranked games are
kept in your history, marked "Unranked," but never count toward records, and ending one doesn't
need confirmation.

**Records.** Every finished ranked game with an agreed winner counts. Before a game, the lobby's head-to-head
panel shows three records: you against this player with any decks, your chosen deck against this
player, and your deck against their exact deck. Your deck list shows each deck's overall record. Games with no winner and
abandoned games don't count.

**Who controls what.** You change only your own life, poison, commander damage taken, and cards.

**Deck import.** Paste any common export format (Moxfield, Archidekt, MTGO, Arena), including
set codes, collector numbers, foil markers, and Moxfield tags. Public Archidekt links load
directly. Moxfield has no public API and usually blocks server requests, so the app tries the
link and, if blocked, tells the player to paste the export text instead.

**Card images** come from Scryfall. The server only accepts image URLs on `cards.scryfall.io`,
so a player can't push arbitrary images into their opponent's browser.

## Controls

| Action | How |
| --- | --- |
| Play a card | Double-click it in your hand, or drag it onto the battlefield |
| Play face down | Right-click → Play face down, or hold Alt while dropping |
| Tap / untap | Click a card on the battlefield |
| Card menu (counters, copy, transform, move) | Right-click, or long-press on touch |
| Draw | Click your library, or press D |
| Search your library | Sidebar → Library → Search, the ⋯ button on your library, or press F |
| Look at the top cards, mill, shuffle, mulligan | Sidebar → Library, or the ⋯ button on your library |
| Put a card into your library at a position | Card menu → "Put into library at position…" (e.g. 3rd from the top), or Position… in any card viewer |
| Untap all | U |
| Pass turn | N |
| Token, dice, or coin | Right-click empty battlefield, or the sidebar buttons |
| Counter badges | Click to add one, right-click or shift-click to remove one |
| Life | − / + on your own bar, shift-click for 5 |

## Roadmap

See [ROADMAP.md](ROADMAP.md) for milestones: finishing the two-player game, then voice, then video.
