import { DurableObject } from 'cloudflare:workers';
import { addPlayer, applyAction, cleanName, createGame, viewFor, type GameState } from './game';
import type { Env } from './index';
import { getDeck } from './decks';
import { BOT_NAME, BOT_USER_ID, botDeck, nextBotStep } from './bot';

const MAX_MESSAGE_BYTES = 512 * 1024;
const IDLE_LOBBY_MS = 60 * 60 * 1000; // empty/unstarted rooms: 1 hour
const IDLE_PLAYING_MS = 3 * 60 * 60 * 1000; // games with no activity: 3 hours
const ENDED_LINGER_MS = 30 * 60 * 1000; // finished games stay open for a rematch: 30 min
const BOT_STEP_MS = 700; // pause between the practice bot's moves, so you can follow along
const BOT_MAX_STEPS = 60; // per turn; it passes if it somehow gets stuck

interface Attachment {
  userId?: string; // set by the Worker after checking the session cookie
  username?: string;
  playerId?: string;
}

export class GameRoom extends DurableObject<Env> {
  private state: GameState | null = null;
  private botBusy = false; // the practice bot is playing its turn

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<GameState>('state')) ?? null;
    });
  }

  // ----- RPC from the Worker -----

  async init(code: string, opts: { startingLife?: number; ranked?: boolean }): Promise<boolean> {
    if (this.state) return false; // code already in use
    this.state = createGame(code, opts);
    await this.persist();
    return true;
  }

  async info() {
    const s = this.state;
    if (!s) return { exists: false as const };
    return {
      exists: true as const,
      status: s.status,
      players: s.players.length,
      maxPlayers: s.maxPlayers,
      startingLife: s.startingLife,
      ranked: s.ranked !== false,
    };
  }

  // ----- WebSocket entry point -----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!this.state) return new Response('No such room', { status: 404 });
    // Only the Worker can reach this object, and it sets these after verifying the session.
    const userId = request.headers.get('X-User-Id');
    const username = request.headers.get('X-User-Name');
    if (!userId || !username) return new Response('Sign in first', { status: 401 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, username } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const s = this.state;
    if (!s) {
      ws.close(4000, 'Room closed');
      return;
    }
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) {
      this.send(ws, { t: 'error', message: 'That message was too large.' });
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.t === 'ping') {
      this.send(ws, { t: 'pong' });
      return;
    }
    if (msg?.t === 'hello') {
      await this.hello(ws, msg);
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.playerId) {
      this.send(ws, { t: 'error', message: 'Join the room first.' });
      return;
    }

    // Decks come from the player's saved decks in D1, never from card data sent by the browser.
    if (msg?.t === 'setDeck') return;
    if (msg?.t === 'selectDeck') {
      if (s.status !== 'lobby') return this.send(ws, { t: 'error', message: 'Choose your deck before the game starts.' });
      const deck = typeof msg.deckId === 'string' ? await getDeck(this.env, att.userId!, msg.deckId) : null;
      if (!deck) return this.send(ws, { t: 'error', message: "That deck wasn't found in your decks." });
      msg = { t: 'setDeck', deck: { id: deck.id, name: deck.name, main: deck.main, commanders: deck.commanders } };
    }

    if (msg?.t === 'addBot') return this.addBot(ws);
    if (msg?.t === 'removeBot') {
      const bot = s.players.find((p) => p.bot);
      if (s.status !== 'lobby' || !bot) return;
      s.players = s.players.filter((p) => p !== bot);
      s.log.push({ ts: Date.now(), text: `${bot.name} left`, kind: 'system' });
      await this.persist();
      this.broadcast();
      return;
    }

    const res = applyAction(s, att.playerId, msg);
    if (res.error) this.send(ws, { t: 'error', message: res.error });
    if (res.private) this.send(ws, res.private);
    if (res.announce) {
      for (const w of this.ctx.getWebSockets()) {
        if ((w.deserializeAttachment() as Attachment | null)?.playerId) this.send(w, res.announce);
      }
    }
    if (res.changed) {
      s.lastActivity = Date.now();
      if (res.ended) await this.archive();
      await this.persist();
      this.broadcast();
      await this.botFollowUp();
    }
  }

  // ----- the practice bot -----

  private async addBot(ws: WebSocket) {
    const s = this.state!;
    if (s.status !== 'lobby') return this.send(ws, { t: 'error', message: 'Add the practice bot before the game starts.' });
    if (s.players.some((p) => p.bot)) return;
    if (s.players.length >= s.maxPlayers) return this.send(ws, { t: 'error', message: 'This game is full.' });
    let deck;
    try {
      deck = await botDeck(this.env.SCRYFALL_API);
    } catch {
      return this.send(ws, { t: 'error', message: "The practice bot's deck couldn't be loaded. Try again in a moment." });
    }
    // Someone may have joined while the deck loaded.
    if (s.status !== 'lobby' || s.players.length >= s.maxPlayers || s.players.some((p) => p.bot)) return;
    const bot = addPlayer(s, BOT_USER_ID, BOT_NAME);
    bot.bot = true;
    s.log.push({ ts: Date.now(), text: `${bot.name} joined. Games against it are unranked.`, kind: 'system' });
    s.ranked = false; // never counts toward records
    applyAction(s, bot.id, { t: 'setDeck', deck });
    applyAction(s, bot.id, { t: 'ready', ready: true });
    s.lastActivity = Date.now();
    await this.persist();
    this.broadcast();
  }

  // After anything changes: the bot readies up again in the lobby, and plays its turn.
  private async botFollowUp() {
    const s = this.state;
    const bot = s?.players.find((p) => p.bot);
    if (!s || !bot) return;
    if (s.status === 'lobby' && bot.deck && !bot.ready) {
      applyAction(s, bot.id, { t: 'ready', ready: true });
      await this.persist();
      this.broadcast();
      return;
    }
    if (s.status !== 'playing' || s.turn?.activeId !== bot.id || this.botBusy) return;
    this.botBusy = true;
    try {
      for (let i = 0; ; i++) {
        await new Promise((r) => setTimeout(r, BOT_STEP_MS));
        // The game may have ended, or the room closed, while it waited.
        if (this.state !== s) return;
        const steps = i < BOT_MAX_STEPS ? nextBotStep(s, bot) : s.turn?.activeId === bot.id ? [{ t: 'passTurn' }] : null;
        if (!steps) return;
        let changed = false;
        for (const step of steps) changed = applyAction(s, bot.id, step).changed || changed;
        if (changed) {
          s.lastActivity = Date.now();
          await this.persist();
          this.broadcast();
        }
      }
    } finally {
      this.botBusy = false;
    }
  }

  private async hello(ws: WebSocket, _msg: any) {
    const s = this.state!;
    const att = ws.deserializeAttachment() as Attachment;
    if (!att?.userId) return;
    let player = s.players.find((p) => p.userId === att.userId);
    if (!player) {
      if (s.status !== 'lobby') {
        this.send(ws, { t: 'rejected', message: 'This game has already started.' });
        ws.close(4001, 'Game in progress');
        return;
      }
      if (s.players.length >= s.maxPlayers) {
        this.send(ws, { t: 'rejected', message: 'This game is full.' });
        ws.close(4001, 'Room full');
        return;
      }
      player = addPlayer(s, att.userId, att.username!);
      s.log.push({ ts: Date.now(), text: `${player.name} joined`, kind: 'system' });
    } else {
      player.name = cleanName(att.username);
    }
    ws.serializeAttachment({ ...att, playerId: player.id } satisfies Attachment);
    s.lastActivity = Date.now();
    await this.persist();
    this.broadcast();
    await this.botFollowUp(); // e.g. the room was restarted partway through the bot's turn
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Closing');
    } catch {
      /* already closed */
    }
    this.broadcast(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.broadcast(ws);
  }

  // ----- fan-out -----

  private broadcast(exclude?: WebSocket) {
    const s = this.state;
    if (!s) return;
    const sockets = this.ctx.getWebSockets().filter((w) => w !== exclude);
    const online = new Set<string>();
    for (const w of sockets) {
      const id = (w.deserializeAttachment() as Attachment | null)?.playerId;
      if (id) online.add(id);
    }
    for (const w of sockets) {
      const id = (w.deserializeAttachment() as Attachment | null)?.playerId;
      if (id) this.send(w, { t: 'state', you: id, state: viewFor(s, id, online) });
    }
  }

  private send(ws: WebSocket, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket went away */
    }
  }

  // ----- lifetime -----

  private async persist() {
    const s = this.state;
    if (!s) return;
    await this.ctx.storage.put('state', s);
    const wait = s.status === 'lobby' ? IDLE_LOBBY_MS : s.status === 'playing' ? IDLE_PLAYING_MS : ENDED_LINGER_MS;
    await this.ctx.storage.setAlarm(s.lastActivity + wait);
  }

  async alarm() {
    const s = this.state;
    if (!s) return;
    const wait = s.status === 'lobby' ? IDLE_LOBBY_MS : s.status === 'playing' ? IDLE_PLAYING_MS : ENDED_LINGER_MS;
    if (Date.now() < s.lastActivity + wait) {
      await this.ctx.storage.setAlarm(s.lastActivity + wait);
      return;
    }
    if (s.status === 'playing') {
      s.status = 'ended';
      s.endedAt = Date.now();
      s.endReason = 'abandoned';
      s.winnerId = null;
      await this.archive();
    }
    for (const w of this.ctx.getWebSockets()) {
      this.send(w, { t: 'closed', message: 'This room closed after a period of inactivity.' });
      try {
        w.close(4000, 'Room closed');
      } catch {
        /* ignore */
      }
    }
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  // Write the permanent record to D1. The room itself is temporary.
  private async archive() {
    const s = this.state;
    if (!s || !s.startedAt || s.archived || !this.env.DB) return;
    try {
      const winner = s.players.find((p) => p.id === s.winnerId);
      const stmts = [
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO games (id, room_code, starting_life, started_at, ended_at, end_reason, winner_name, winner_user_id, turns, ranked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(s.gameId, s.code, s.startingLife, s.startedAt, s.endedAt ?? Date.now(), s.endReason ?? 'reported', winner?.name ?? null, winner?.userId ?? null, s.turn?.number ?? 0, s.ranked === false ? 0 : 1),
        ...s.players.map((p) =>
          this.env.DB.prepare(
            `INSERT OR REPLACE INTO game_players (game_id, seat, name, user_id, deck_id, deck_name, commanders, card_count, final_life, poison, conceded, is_winner)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            s.gameId,
            p.seat,
            p.name,
            p.userId,
            p.deck?.id ?? null,
            p.deck?.name ?? null,
            JSON.stringify(p.deck?.commanders.map((c) => c.name) ?? []),
            p.deck ? p.deck.main.length + p.deck.commanders.length : 0,
            p.life,
            p.counters.poison ?? 0,
            p.conceded ? 1 : 0,
            p.id === s.winnerId ? 1 : 0,
          ),
        ),
      ];
      await this.env.DB.batch(stmts);
      s.archived = true;
    } catch (err) {
      console.error('Failed to archive game', s.gameId, err);
    }
  }
}
