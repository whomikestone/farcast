# Farcast: notes for Claude Code

Farcast is a two-player tabletop for playing Magic: The Gathering remotely with friends, built on
Cloudflare Workers. It replaces the OBS + Moxfield + SpellTable routine: cards are digital, and the
server enforces hidden information (hands, libraries, face-down cards).

- Live: https://farcast.mstone.io (workers.dev address disabled; owner's Cloudflare rate limiting rules apply)
- Repo: github.com/whomikestone/farcast. Every push to `main` deploys automatically (Cloudflare Workers Builds).
- Plans and status: `ROADMAP.md`. Player-facing history: `CHANGELOG.md` (shown in the app at `/changelog`).

## Commands

```bash
npm install
npm run dev:test     # local server on :8787 with test sign-in settings and a FRESH local database
npm test             # end-to-end suite (needs dev:test running; it starts stand-ins for Scryfall/Google/Access on :8899)
npm run typecheck
npm run dev          # plain local server (no test settings)
npm run db:migrate   # apply new migrations to PRODUCTION D1 (needs `npx wrangler login` once)
```

The suite expects a fresh database: restart `npm run dev:test` before each `npm test`. If a port is
busy, an old server or stand-in is still running.

## How it fits together

| Path | What it is |
| --- | --- |
| `src/index.ts` | Worker: API routes, sign-in, decks, records, history; forwards room traffic to the Durable Object |
| `src/game-room.ts` | `GameRoom` Durable Object: one per room, WebSockets (hibernation), expiry alarms, writes results to D1 |
| `src/game.ts` | Pure game logic: state, `applyAction()` for every player action, `viewFor()` (what each player may see) |
| `src/auth.ts` | Sessions, password accounts, Google OIDC (PKCE), Cloudflare Access JWT verification |
| `src/deck.ts` / `src/decks.ts` | Decklist parsing + Scryfall lookup / saved decks and win–loss records |
| `public/app.js`, `public/styles.css` | The whole client: plain JS, no build step |
| `public/fonts/` | Gloock (display) and Hanken Grotesk (UI), bundled, with licenses |
| `migrations/` | D1 schema, numbered; add new files, never edit applied ones |
| `test/smoke.mjs`, `test/mocks.mjs` | End-to-end suite and its offline stand-ins |

## Rules that must hold

- **The server is the source of truth.** The client sends small actions; `applyAction()` validates them.
  Players may only change their own cards, life, poison, commander damage taken, and counters.
- **Hidden information never leaves the server.** Everything a player receives goes through `viewFor()`.
  Never send ids or names of cards in another player's hand or library, or of face-down cards. Shuffles
  re-id library cards. Reveals (`announce`) send card faces only, never ids. Log lines name a card only
  when it is in, or moving to, a public zone.
- **Decks come from D1,** loaded by the room by id after checking ownership; the browser never supplies
  card lists to a game. Card images are only accepted from `cards.scryfall.io`.
- **Records:** only ranked games with an agreed winner count. Claiming a win needs the opponent's
  confirmation; admitting defeat is immediate. Changing a deck's cards makes a new deck version.
- **Names are fixed once chosen.** Only Google/Access users without a chosen name can set one.

## With every change (standing rules)

1. **`CHANGELOG.md`:** add the change to today's line, dated in **Pacific time** (`YYYY.MM.DD — change;
   change`), newest day first, one line per day. The owner edits wording by hand: keep their wording
   for past days; never rewrite their lines.
2. **Controls:** if a control or keyboard shortcut is added or changed, update the README's controls
   table and the in-app controls guide (planned; see ROADMAP).
3. **`ROADMAP.md`:** check off finished items; add new requests where the owner asks.
4. **Tests:** server behavior changes get a check in `test/smoke.mjs`. Verify UI changes in a browser
   at a laptop-sized window (about 1400×800), including the opponent's view where relevant.

## Writing and design conventions

- UI copy: plain words, sentence case, Oxford comma, from the player's point of view.
- Colors: brass `#d4a648` means "you", lilac `#ab9ce8` means "your opponent", on a dark felt green.
- Gloock has no italic and only one weight (declared 100–900 so browsers don't fake bold); its dash is a
  hairline, so record dashes use the UI font (`.rd`).
- Per-browser settings live in `localStorage` under `farcast:` (view sizes, last life choice, etc.).

## Gotchas found the hard way

- Modal state objects use `m.type` for the modal kind: store other values under other names
  (a library filter once overwrote it and closed the window).
- `.side` (game sidebar) grid rows must match its children (preview, controls, log, chat).
- The hand is a short strip: cards show their top 60% and magnify like the Mac Dock (`magnifyHand`);
  drag ghosts must clear the magnified transform.
- Counter badges: click adds one; right-click or shift-click removes one (so right-clicking a badge does
  not open the card menu).
- `CHANGELOG.md` is bundled into the Worker as text (`rules` in `wrangler.jsonc`), so the What's new page
  updates with each deploy.

## Open work (see ROADMAP.md for the full list)

- Next: point at a card (glow on both screens); sketch pad under the library (named counters + note);
  token stacks and a token picker with Scryfall art; in-app controls and shortcuts guide.
- Owner side: set up sign-in restrictions (Cloudflare Access emails and/or Google `ALLOWED_EMAILS`).
- Later milestones: voice, then video (Cloudflare Realtime SFU).
