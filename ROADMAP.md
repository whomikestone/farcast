# Roadmap

Milestones in order. Each one should be usable on its own before the next starts.
Status: ✅ done · 🟡 in progress · ⬜ not started

---

## Milestone 1: Play a two-player game end to end 🟡

The tabletop replaces OBS + Moxfield + SpellTable for card play.

**Built**
- ✅ Game rooms as Durable Objects: created on demand, expire when idle, results saved to D1
- ✅ Hidden information enforced by the server (hands, libraries, face-down cards)
- ✅ Board: drag and drop, tap, counters, tokens, copies, face down, transform, zones
- ✅ Life, poison, and commander damage, each changed only by its owner
- ✅ Library tools: search, look at top cards, mill, shuffle (optionally with graveyard), mulligan
- ✅ Put a card into the library at any position (Nth from the top or bottom), including reordering
- ✅ Turn helper: untap, upkeep, and draw, optionally automatic
- ✅ Commander art as the playmat; exact printings from set code + collector number
- ✅ Card preview in the sidebar (local to each player)
- ✅ Accounts: Cloudflare Access, Google, or name + password
- ✅ Saved decks: Commander box + Deck box, checked automatically; card changes make a new version
- ✅ Records in the lobby: you vs player (all decks), this deck vs player, deck vs deck
- ✅ Results need agreement: claiming a win waits for the opponent to confirm; admitting defeat is immediate
- ✅ Unranked games: kept in history, never counted toward records
- ✅ What's new page (change log), names fixed once chosen, type filters in library search,
  close without shuffling, "doesn't untap," one-click top card
- ✅ More playmat room: both halves equal height (about 3 cards tall on a laptop), hand in its own
  strip, slimmer player bars

**To finish**
- ✅ Production D1 database created and migrated
- ✅ Git repository with a typecheck workflow; deploys configured for Cloudflare Workers Builds
- ⬜ Push to GitHub and connect the repo in Workers & Pages (first deploy)
- ⬜ Add the custom domain
- ⬜ Confirm real Scryfall card images and commander playmats on the deployed site
- ⬜ Set up sign-in: Access policy with your group's emails, and/or Google OAuth client
- ⬜ Add Cloudflare rate limiting rules for `/api/auth/*` and `/api/decks/resolve`
- ⬜ Play a full real game with a friend and collect what felt clunky
- ✅ Choose the app's name: Farcast (check trademarks before any public launch; it's close to "Farcaster," an unrelated social network)

---

## Milestone 2: Voice ⬜

Talk at the table without a separate Discord call.

**Approach: Cloudflare Realtime SFU** (not RealtimeKit, which bills per minute with no free tier).
- Each player publishes one microphone track to the SFU and subscribes to the others'.
- The Worker holds the Realtime app secret and creates sessions for signed-in players only.
  Browsers never see the secret.
- The game room Durable Object already knows who is seated, so it shares track names between
  players. No new signaling server is needed.
- Cloudflare's TURN service is included, so it works behind strict home and office networks.

**Scope**
- Join voice on entering a room (with a clear prompt for microphone permission)
- Mute/unmute (with a keyboard shortcut), push-to-talk option
- Speaking indicator on each player's seat bar
- Per-player volume
- Reconnects automatically along with the game connection

**Cost (rough estimate).** Billed only on data Cloudflare sends to players, at $0.05/GB after
1,000 GB free each month (shared with video). Voice at ~40 kbps per stream:
- 2 players: ~36 MB per game-hour → about 27,000 game-hours a month free
- 4 players: ~220 MB per game-hour → about 4,500 game-hours a month free

Effectively free for a friends group.

---

## Milestone 3: Video ⬜

See each other while playing, the social part of SpellTable, without needing a camera on the cards.

**Approach.** Same Cloudflare Realtime session as voice; each player adds a camera track.

**Scope**
- Camera on/off, and choosing which camera to use
- Video tiles that don't cover the board (e.g. beside each player's seat bar, or collapsible)
- Lower resolution automatically when the connection is weak
- Optional later: a second camera on physical cards, for players who want SpellTable-style play

**Cost (rough estimate).** Webcam video at ~1 Mbps per stream:
- 2 players: ~0.9 GB per game-hour → about 1,100 game-hours a month free
- 4 players: ~5.4 GB per game-hour → about 185 game-hours a month free, then roughly $0.27 per
  4-player game-hour

Still free for typical use. Four-player video is where costs could start to appear.

---

## Later (unscheduled)

- Up to 4 players (seat layout, per-opponent commander damage)
- Gain control of a permanent; reveal cards or a hand to a player
- Mobile layout
- Official token art from Scryfall
- Discord sign-in
- Deck history: see earlier versions of a deck and their records
