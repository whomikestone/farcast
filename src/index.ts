import { GameRoom } from './game-room';
import { fetchDeckFromUrl, parseDeckText, parseTwoBoxes, resolveDeck } from './deck';
import { authConfig, createSession, currentUser, googleCallback, googleStart, login, logout, register, rename, type User } from './auth';
import { createDeck, getDeck, listDecks, matchupRecord, normalizeDeck, retireDeck, updateDeck } from './decks';

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  DB: D1Database;
  ASSETS: Fetcher;
  // Sign-in settings (see README). Secrets: GOOGLE_CLIENT_SECRET.
  AUTH_PASSWORD?: string; // "off" disables username + password accounts
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_EMAILS?: string; // optional comma-separated invite list for Google sign-in
  ACCESS_TEAM_DOMAIN?: string; // e.g. yourteam.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's audience tag
  // Overrides for local testing only.
  SCRYFALL_API?: string;
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  ACCESS_CERTS_URL?: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_RE = /^[A-Z0-9]{6}$/;

function roomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const room = (env: Env, code: string) => env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    // Requests that change things (and WebSockets) must come from this site.
    const origin = request.headers.get('Origin');
    if ((method !== 'GET' || request.headers.get('Upgrade') === 'websocket') && origin && origin !== url.origin) {
      return json({ error: 'Cross-site request refused' }, 403);
    }
    const secure = url.protocol === 'https:';
    const body = async () => (method === 'GET' ? {} : await request.json<any>().catch(() => ({})));

    // ---------- accounts ----------
    const cfg = authConfig(env);
    if (path === '/api/auth/config') return json(cfg);
    if (path === '/api/auth/register' && method === 'POST') {
      if (!cfg.password) return json({ error: 'Password accounts are turned off here.' }, 403);
      const { username, password } = await body();
      const user = await register(env, String(username ?? '').trim(), password);
      if (typeof user === 'string') return json({ error: user }, 400);
      return json({ user }, 200, { 'Set-Cookie': await createSession(env, user.id, secure) });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      if (!cfg.password) return json({ error: 'Password sign-in is turned off here.' }, 403);
      const { username, password } = await body();
      const user = await login(env, String(username ?? '').trim(), password);
      if (typeof user === 'string') return json({ error: user }, 401);
      return json({ user }, 200, { 'Set-Cookie': await createSession(env, user.id, secure) });
    }
    if (path === '/api/auth/google/start' && method === 'GET') {
      if (!cfg.google) return json({ error: 'Google sign-in is not set up here.' }, 404);
      return googleStart(env, url);
    }
    if (path === '/api/auth/google/callback' && method === 'GET') {
      if (!cfg.google) return json({ error: 'Google sign-in is not set up here.' }, 404);
      return googleCallback(env, request, url);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': await logout(env, request, secure) });
    }

    // Everything below needs a signed-in user.
    const user = await currentUser(env, request);
    if (!user) return json({ error: 'Sign in first.' }, 401);

    if (path === '/api/me' && method === 'GET') return json({ user, auth: cfg });
    if (path === '/api/me' && method === 'PATCH') {
      const b = await body();
      const updated = await rename(env, user.id, typeof b.username === 'string' ? b.username.trim() : b.username);
      return typeof updated === 'string' ? json({ error: updated }, 400) : json({ user: updated });
    }

    // ---------- decks ----------
    if (path === '/api/decks/resolve' && method === 'POST') {
      const b = await body();
      try {
        const source = typeof b.url === 'string' && b.url.trim()
          ? await fetchDeckFromUrl(b.url.trim())
          : typeof b.commander === 'string'
            ? parseTwoBoxes(b.commander.slice(0, 2_000), String(b.text ?? '').slice(0, 50_000))
            : parseDeckText(String(b.text ?? '').slice(0, 50_000));
        const commanderCount = source.lines.filter((l) => l.section === 'commander').length;
        if (commanderCount > 2) return json({ error: `The commander box lists ${commanderCount} cards. A deck can have at most two commanders (for partners or a background).` }, 400);
        return json(await resolveDeck(source, env.SCRYFALL_API));
      } catch (err: any) {
        return json({ error: err?.message ?? 'Could not load that deck.' }, 400);
      }
    }
    if (path === '/api/decks' && method === 'GET') return json({ decks: await listDecks(env, user.id) });
    if (path === '/api/decks' && method === 'POST') {
      const deck = normalizeDeck(await body());
      if (typeof deck === 'string') return json({ error: deck }, 400);
      const created = await createDeck(env, user.id, deck);
      return typeof created === 'string' ? json({ error: created }, 400) : json(created);
    }
    const deckMatch = path.match(/^\/api\/decks\/([0-9a-f-]{36})$/);
    if (deckMatch) {
      const id = deckMatch[1];
      if (method === 'GET') {
        const deck = await getDeck(env, user.id, id);
        return deck ? json({ deck }) : json({ error: 'Deck not found.' }, 404);
      }
      if (method === 'PUT') {
        const deck = normalizeDeck(await body());
        if (typeof deck === 'string') return json({ error: deck }, 400);
        const saved = await updateDeck(env, user.id, id, deck);
        if (!saved) return json({ error: 'Deck not found.' }, 404);
        return typeof saved === 'string' ? json({ error: saved }, 400) : json(saved);
      }
      if (method === 'DELETE') return (await retireDeck(env, user.id, id)) ? json({ ok: true }) : json({ error: 'Deck not found.' }, 404);
    }

    // ---------- records ----------
    if (path === '/api/records' && method === 'GET') {
      const myDeck = url.searchParams.get('deck') || null;
      const oppUser = url.searchParams.get('opponent') ?? '';
      const oppDeck = url.searchParams.get('opponentDeck') || null;
      const rec = await matchupRecord(env, user.id, myDeck, oppUser, oppDeck);
      return rec ? json(rec) : json({ error: 'Deck not found.' }, 404);
    }

    // ---------- rooms ----------
    if (path === '/api/rooms' && method === 'POST') {
      const b = await body();
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = roomCode();
        if (await room(env, code).init(code, { startingLife: Number(b.startingLife), ranked: b.ranked !== false })) return json({ code });
      }
      return json({ error: 'Could not create a room. Try again.' }, 503);
    }
    const roomMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)(\/ws)?$/);
    if (roomMatch) {
      const code = roomMatch[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ exists: false }, 404);
      if (roomMatch[2]) {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
        return room(env, code).fetch(withUser(request, user));
      }
      const info = await room(env, code).info();
      return json(info, info.exists ? 200 : 404);
    }

    // ---------- your finished games ----------
    if (path === '/api/games' && method === 'GET') {
      const games = await env.DB.prepare(
        `SELECT g.id, g.room_code, g.starting_life, g.started_at, g.ended_at, g.end_reason, g.winner_name, g.turns, g.ranked,
                json_group_array(json_object(
                  'seat', p.seat, 'name', p.name, 'deck', p.deck_name, 'commanders', json(p.commanders),
                  'life', p.final_life, 'winner', p.is_winner, 'conceded', p.conceded, 'you', p.user_id = ?1)) AS players
           FROM games g JOIN game_players p ON p.game_id = g.id
          WHERE g.id IN (SELECT game_id FROM game_players WHERE user_id = ?1)
          GROUP BY g.id
          ORDER BY g.ended_at DESC
          LIMIT 30`,
      ).bind(user.id).all<any>();
      return json({ games: games.results.map((g) => ({ ...g, players: JSON.parse(g.players) })) });
    }

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

// Pass the verified user to the Durable Object. Incoming copies of these headers are overwritten.
function withUser(request: Request, user: User): Request {
  const headers = new Headers(request.headers);
  headers.set('X-User-Id', user.id);
  headers.set('X-User-Name', user.username);
  return new Request(request, { headers });
}
