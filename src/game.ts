// Pure game logic: no Cloudflare APIs in here, so it's easy to test.
// The Durable Object owns one GameState and calls applyAction() for every message.

export type ZoneName = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command';
export const ZONES: ZoneName[] = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const PUBLIC_ZONES: ReadonlySet<ZoneName> = new Set(['battlefield', 'graveyard', 'exile', 'command']);

export interface CardDef {
  name: string;
  typeLine?: string;
  manaCost?: string;
  pt?: string;
  image?: string;
  imageSmall?: string;
  backName?: string;
  backImage?: string;
  backImageSmall?: string;
  scryfallId?: string;
  artCrop?: string; // used for the playmat
  colors?: string; // color identity, e.g. "GU"
  set?: string;
  cn?: string;
}

export interface Card {
  id: string;
  def: CardDef;
  tapped: boolean;
  faceDown: boolean;
  transformed: boolean;
  counters: Record<string, number>;
  x: number; // 0..1 across the owner's battlefield
  y: number; // 0..1, 0 = edge nearest the centre line
  token: boolean;
}

export interface DeckList {
  id?: string; // saved deck id, used for records
  name: string;
  main: CardDef[]; // expanded, one entry per physical card
  commanders: CardDef[];
}

export interface Player {
  id: string; // public id, safe to show everyone
  userId: string; // account that holds this seat
  name: string;
  seat: number;
  ready: boolean;
  deck: DeckList | null;
  life: number;
  counters: Record<string, number>; // poison, energy, ...
  commanderDamage: Record<string, number>; // keyed by the source player's id
  zones: Record<ZoneName, Card[]>;
  conceded: boolean;
}

export interface LogEntry {
  ts: number;
  text: string;
  by?: string;
  kind: 'action' | 'chat' | 'system';
}

export interface GameState {
  code: string;
  gameId: string;
  status: 'lobby' | 'playing' | 'ended';
  maxPlayers: number;
  startingLife: number;
  ranked: boolean; // unranked games don't count toward records
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastActivity: number;
  players: Player[];
  turn: { activeId: string; number: number; begun: boolean } | null;
  winnerId?: string | null;
  // A reported result waiting for the other players to agree.
  pendingResult?: { by: string; winnerId: string | null; confirmedBy: string[]; at: number } | null;
  endReason?: string;
  archived: boolean;
  log: LogEntry[];
}

export interface ActionResult {
  changed: boolean;
  error?: string;
  private?: unknown; // reply sent only to the acting player
  ended?: boolean;
}

// ---------- randomness ----------

export function randInt(n: number): number {
  // Unbiased integer in [0, n)
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function newId(len = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randInt(alphabet.length)];
  return s;
}

// ---------- construction ----------

export const MAX_PLAYERS = 2; // Phase 1. Raise to 4 in Phase 2.

function emptyZones(): Record<ZoneName, Card[]> {
  return { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] };
}

export function createGame(code: string, opts: { startingLife?: number; ranked?: boolean } = {}): GameState {
  const now = Date.now();
  const life = opts.startingLife === 20 ? 20 : opts.startingLife === 30 ? 30 : 40;
  return {
    code,
    gameId: crypto.randomUUID(),
    status: 'lobby',
    maxPlayers: MAX_PLAYERS,
    startingLife: life,
    ranked: opts.ranked !== false,
    createdAt: now,
    lastActivity: now,
    players: [],
    turn: null,
    archived: false,
    log: [{ ts: now, text: 'Room created', kind: 'system' }],
  };
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return name || 'Player';
}

export function addPlayer(state: GameState, userId: string, name: string): Player {
  const taken = new Set(state.players.map((p) => p.seat));
  let seat = 0;
  while (taken.has(seat)) seat++;
  const p: Player = {
    id: newId(8),
    userId,
    name: cleanName(name),
    seat,
    ready: false,
    deck: null,
    life: state.startingLife,
    counters: { poison: 0 },
    commanderDamage: {},
    zones: emptyZones(),
    conceded: false,
  };
  state.players.push(p);
  state.players.sort((a, b) => a.seat - b.seat);
  return p;
}

function newCard(def: CardDef, token = false): Card {
  return { id: newId(), def, tapped: false, faceDown: false, transformed: false, counters: {}, x: 0, y: 0, token };
}

// ---------- validation of client-supplied card data ----------

const IMG = /^https:\/\/cards\.scryfall\.io\/[\w\-./]+(\?\d+)?$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const img = (v: unknown) => (typeof v === 'string' && v.length < 300 && IMG.test(v) ? v : undefined);

export function sanitizeDef(raw: any): CardDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name, 150)?.trim();
  if (!name) return null;
  const def: CardDef = { name };
  const opt: Array<[keyof CardDef, string | undefined]> = [
    ['typeLine', str(raw.typeLine, 120)],
    ['manaCost', str(raw.manaCost, 60)],
    ['pt', str(raw.pt, 12)],
    ['backName', str(raw.backName, 150)],
    ['scryfallId', str(raw.scryfallId, 40)],
    ['artCrop', img(raw.artCrop)],
    ['colors', typeof raw.colors === 'string' && /^[WUBRGC]{0,5}$/.test(raw.colors) ? raw.colors : undefined],
    ['set', str(raw.set, 8)],
    ['cn', str(raw.cn, 10)],
    ['image', img(raw.image)],
    ['imageSmall', img(raw.imageSmall)],
    ['backImage', img(raw.backImage)],
    ['backImageSmall', img(raw.backImageSmall)],
  ];
  for (const [k, v] of opt) if (v) (def as any)[k] = v;
  return def;
}

// ---------- helpers ----------

const MAX_LOG = 300;

function log(state: GameState, text: string, by?: Player, kind: LogEntry['kind'] = 'action') {
  state.log.push({ ts: Date.now(), text, by: by?.id, kind });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function cardName(c: Card): string {
  return c.transformed && c.def.backName ? c.def.backName : c.def.name;
}

function findCard(p: Player, cardId: unknown): { zone: ZoneName; index: number; card: Card } | null {
  if (typeof cardId !== 'string') return null;
  for (const zone of ZONES) {
    const index = p.zones[zone].findIndex((c) => c.id === cardId);
    if (index >= 0) return { zone, index, card: p.zones[zone][index] };
  }
  return null;
}

const clamp01 = (n: unknown, fallback: number) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, v));
};
const int = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.min(max, Math.max(min, v));
};

function autoPlace(p: Player, def: CardDef): { x: number; y: number } {
  const isLand = /\bLand\b/.test(def.typeLine ?? '');
  const baseY = isLand ? 0.95 : 0.06;
  const rowCards = p.zones.battlefield.filter((c) => Math.abs(c.y - baseY) < 0.12).length;
  const col = rowCards % 11;
  const row = Math.floor(rowCards / 11);
  return { x: 0.01 + col * 0.093, y: Math.min(1, Math.max(0, baseY + (isLand ? -0.25 : 0.25) * row)) };
}

function draw(state: GameState, p: Player, n: number): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const c = p.zones.library.shift();
    if (!c) break;
    p.zones.hand.push(c);
    drawn++;
  }
  return drawn;
}

function shuffleLibrary(p: Player) {
  shuffle(p.zones.library);
  // Fresh ids so nobody can track a known card through a shuffle.
  for (const c of p.zones.library) c.id = newId();
}

function moveVerb(from: ZoneName, to: ZoneName, name: string, pos: 'top' | 'bottom'): string {
  if (to === 'battlefield') {
    if (from === 'hand') return `played ${name}`;
    if (from === 'command') return `cast ${name} from the command zone`;
    return `put ${name} onto the battlefield from their ${zoneLabel(from)}`;
  }
  if (to === 'graveyard') return from === 'hand' ? `discarded ${name}` : `put ${name} into their graveyard`;
  if (to === 'exile') return `exiled ${name}`;
  if (to === 'hand') return from === 'library' ? `put ${name} from their library into their hand` : `returned ${name} to their hand`;
  if (to === 'library') return `put ${name} on the ${pos} of their library`;
  return `moved ${name} to the command zone`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  const suffix = rem100 >= 11 && rem100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function zoneLabel(z: ZoneName): string {
  return z === 'command' ? 'command zone' : z;
}

function endGame(state: GameState, winnerId: string | null, reason: string) {
  state.status = 'ended';
  state.endedAt = Date.now();
  state.winnerId = winnerId;
  state.endReason = reason;
  const w = state.players.find((p) => p.id === winnerId);
  log(state, w ? `${w.name} won the game` : 'The game ended with no winner recorded', undefined, 'system');
}

// ---------- the action handler ----------

export function applyAction(state: GameState, playerId: string, a: any): ActionResult {
  const me = state.players.find((p) => p.id === playerId);
  if (!me) return { changed: false, error: 'You are not seated in this game.' };
  if (!a || typeof a.t !== 'string') return { changed: false, error: 'Unknown action.' };

  // ----- lobby -----
  if (state.status === 'lobby') {
    switch (a.t) {
      case 'setDeck': {
        const d = a.deck;
        if (!d || !Array.isArray(d.main)) return { changed: false, error: 'That deck could not be read.' };
        const main: CardDef[] = [];
        for (const entry of d.main) {
          const def = sanitizeDef(entry?.def);
          const count = int(entry?.count, 1, 99, 1);
          if (!def) continue;
          for (let i = 0; i < count; i++) main.push(def);
        }
        const commanders = (Array.isArray(d.commanders) ? d.commanders : [])
          .slice(0, 2)
          .map(sanitizeDef)
          .filter(Boolean) as CardDef[];
        if (main.length + commanders.length === 0) return { changed: false, error: 'That deck has no cards.' };
        if (main.length + commanders.length > 250) return { changed: false, error: 'Decks are limited to 250 cards.' };
        me.deck = { id: str(d.id, 40), name: str(d.name, 80)?.trim() || 'Untitled deck', main, commanders };
        me.ready = false;
        log(state, `chose ${me.deck.name} (${main.length + commanders.length} cards)`, me);
        return { changed: true };
      }
      case 'setRanked': {
        const ranked = !!a.ranked;
        if (ranked === (state.ranked !== false)) return { changed: false };
        state.ranked = ranked;
        for (const p of state.players) p.ready = false; // everyone re-confirms after a change
        log(state, ranked ? 'made this a ranked game. It will count toward records.' : "made this an unranked game. It won't count toward records.", me);
        return { changed: true };
      }
      case 'ready': {
        if (!me.deck) return { changed: false, error: 'Load a deck before marking yourself ready.' };
        me.ready = !!a.ready;
        return { changed: true };
      }
      case 'start': {
        if (state.players.length < 2) return { changed: false, error: 'Waiting for an opponent to join.' };
        if (state.players.some((p) => !p.ready || !p.deck)) return { changed: false, error: 'Everyone needs a deck and to be ready.' };
        for (const p of state.players) {
          p.zones = emptyZones();
          p.zones.library = p.deck!.main.map((def) => newCard(def));
          p.zones.command = p.deck!.commanders.map((def) => newCard(def));
          shuffleLibrary(p);
          draw(state, p, 7);
          p.life = state.startingLife;
          p.counters = { poison: 0 };
          p.commanderDamage = {};
          p.conceded = false;
        }
        const first = state.players[randInt(state.players.length)];
        state.status = 'playing';
        state.startedAt = Date.now();
        state.turn = { activeId: first.id, number: 1, begun: false };
        log(state, `Game started. ${first.name} goes first.`, undefined, 'system');
        return { changed: true };
      }
      case 'chat':
        return chat(state, me, a);
      default:
        return { changed: false, error: 'The game has not started yet.' };
    }
  }

  if (state.status === 'ended') {
    if (a.t === 'rematch') {
      state.status = 'lobby';
      state.gameId = crypto.randomUUID();
      state.archived = false;
      state.turn = null;
      state.winnerId = undefined;
      state.endReason = undefined;
      state.pendingResult = null;
      state.startedAt = undefined;
      state.endedAt = undefined;
      for (const p of state.players) {
        p.ready = false;
        p.conceded = false;
        p.zones = emptyZones();
        p.life = state.startingLife;
        p.counters = { poison: 0 };
        p.commanderDamage = {};
      }
      log(state, `${me.name} set up a rematch`, undefined, 'system');
      return { changed: true };
    }
    if (a.t === 'chat') return chat(state, me, a);
    return { changed: false, error: 'This game is over.' };
  }

  // ----- playing -----
  switch (a.t) {
    case 'draw': {
      const n = int(a.n, 1, 20, 1);
      if (!me.zones.library.length) return { changed: false, error: 'Your library is empty.' };
      const got = draw(state, me, n);
      log(state, `drew ${got === 1 ? 'a card' : `${got} cards`}`, me);
      return { changed: true };
    }
    case 'mill': {
      const n = int(a.n, 1, 50, 1);
      const milled = me.zones.library.splice(0, n);
      if (!milled.length) return { changed: false, error: 'Your library is empty.' };
      me.zones.graveyard.push(...milled);
      log(state, `milled ${milled.map(cardName).join(', ')}`, me);
      return { changed: true };
    }
    case 'shuffle': {
      const fromGraveyard = a.withGraveyard ? me.zones.graveyard.splice(0) : [];
      me.zones.library.push(...fromGraveyard);
      shuffleLibrary(me);
      log(state, fromGraveyard.length
        ? `shuffled their graveyard (${fromGraveyard.length} card${fromGraveyard.length === 1 ? '' : 's'}) into their library`
        : 'shuffled their library', me);
      return { changed: true };
    }
    case 'beginTurn': {
      // "Next turn" helper: untap step, upkeep, draw step.
      if (!state.turn || state.turn.activeId !== me.id) return { changed: false, error: "It isn't your turn." };
      if (state.turn.begun) return { changed: false, error: 'You already started this turn.' };
      let untapped = 0;
      for (const c of me.zones.battlefield) if (c.tapped) { c.tapped = false; untapped++; }
      // The player who goes first skips their first draw.
      const skipDraw = state.turn.number === 1;
      const drew = skipDraw ? 0 : draw(state, me, 1);
      state.turn.begun = true;
      const parts = [`untapped ${untapped}`, 'upkeep', skipDraw ? 'no draw on the first turn' : drew ? 'drew a card' : 'could not draw (library empty)'];
      log(state, `began their turn: ${parts.join(', ')}`, me);
      return { changed: true };
    }
    case 'mulligan': {
      me.zones.library.push(...me.zones.hand.splice(0));
      shuffleLibrary(me);
      const got = draw(state, me, int(a.n, 0, 7, 7));
      log(state, `mulliganed and drew ${got}`, me);
      return { changed: true };
    }
    case 'move': {
      const loc = findCard(me, a.cardId);
      if (!loc) return { changed: false, error: 'That card is not yours to move.' };
      const to = a.to as ZoneName;
      if (!ZONES.includes(to)) return { changed: false, error: 'Unknown zone.' };
      const pos: 'top' | 'bottom' = a.pos === 'bottom' ? 'bottom' : 'top';
      // depth 1 = the very top (or bottom), 2 = second from the top (or bottom), and so on.
      const depth = int(a.depth, 1, 999, 1);
      const { card, zone: from, index } = loc;
      const faceDownAfter = to === 'battlefield' ? !!a.faceDown : false;

      const visibleFrom = PUBLIC_ZONES.has(from) && !(from === 'battlefield' && card.faceDown);
      const visibleTo = PUBLIC_ZONES.has(to) && !faceDownAfter;
      const name = visibleFrom || visibleTo ? cardName(card) : faceDownAfter ? 'a card face down' : 'a card';

      me.zones[from].splice(index, 1);

      if (card.token && to !== 'battlefield') {
        log(state, `removed token ${cardName(card)}`, me);
        return { changed: true };
      }

      if (from === 'battlefield' && to !== 'battlefield') {
        card.tapped = false;
        card.counters = {};
        card.transformed = false;
      }
      card.faceDown = faceDownAfter;

      if (to === 'battlefield') {
        const spot = typeof a.x === 'number' && typeof a.y === 'number' ? { x: a.x, y: a.y } : autoPlace(me, card.def);
        card.x = clamp01(spot.x, 0.1);
        card.y = clamp01(spot.y, 0.1);
        me.zones.battlefield.push(card);
      } else if (to === 'library') {
        const lib = me.zones.library;
        const at = pos === 'top' ? Math.min(depth - 1, lib.length) : Math.max(0, lib.length - (depth - 1));
        lib.splice(at, 0, card);
      } else {
        me.zones[to].push(card);
      }
      if (to === 'library' && depth > 1) log(state, `put ${name} ${ordinal(depth)} from the ${pos} of their library`, me);
      else if (from !== to || to === 'library') log(state, moveVerb(from, to, name, pos), me);
      return { changed: true };
    }
    case 'position': {
      const loc = findCard(me, a.cardId);
      if (!loc || loc.zone !== 'battlefield') return { changed: false };
      loc.card.x = clamp01(a.x, loc.card.x);
      loc.card.y = clamp01(a.y, loc.card.y);
      // bring to front
      me.zones.battlefield.splice(loc.index, 1);
      me.zones.battlefield.push(loc.card);
      return { changed: true };
    }
    case 'tap': {
      const loc = findCard(me, a.cardId);
      if (!loc || loc.zone !== 'battlefield') return { changed: false };
      loc.card.tapped = typeof a.tapped === 'boolean' ? a.tapped : !loc.card.tapped;
      const n = loc.card.faceDown ? 'a face-down card' : cardName(loc.card);
      log(state, `${loc.card.tapped ? 'tapped' : 'untapped'} ${n}`, me);
      return { changed: true };
    }
    case 'untapAll': {
      let n = 0;
      for (const c of me.zones.battlefield) if (c.tapped) { c.tapped = false; n++; }
      if (!n) return { changed: false };
      log(state, `untapped ${n} permanent${n === 1 ? '' : 's'}`, me);
      return { changed: true };
    }
    case 'flip': {
      const loc = findCard(me, a.cardId);
      if (!loc || loc.zone !== 'battlefield') return { changed: false };
      loc.card.faceDown = !loc.card.faceDown;
      log(state, loc.card.faceDown ? `turned ${cardName(loc.card)} face down` : `turned ${cardName(loc.card)} face up`, me);
      return { changed: true };
    }
    case 'transform': {
      const loc = findCard(me, a.cardId);
      if (!loc || !loc.card.def.backName) return { changed: false, error: 'That card has no back face.' };
      const before = cardName(loc.card);
      loc.card.transformed = !loc.card.transformed;
      log(state, `transformed ${before} into ${cardName(loc.card)}`, me);
      return { changed: true };
    }
    case 'counter': {
      const loc = findCard(me, a.cardId);
      if (!loc || loc.zone !== 'battlefield') return { changed: false };
      const kind = String(a.kind ?? '').trim().slice(0, 20);
      if (!kind) return { changed: false, error: 'Name the counter.' };
      const delta = int(a.delta, -99, 99, 1);
      if (!(kind in loc.card.counters) && Object.keys(loc.card.counters).length >= 8) {
        return { changed: false, error: 'Too many counter types on one card.' };
      }
      const next = Math.max(0, (loc.card.counters[kind] ?? 0) + delta);
      if (next === 0) delete loc.card.counters[kind];
      else loc.card.counters[kind] = next;
      log(state, `${delta > 0 ? 'added' : 'removed'} ${Math.abs(delta)} ${kind} counter${Math.abs(delta) === 1 ? '' : 's'} ${delta > 0 ? 'to' : 'from'} ${loc.card.faceDown ? 'a face-down card' : cardName(loc.card)}`, me);
      return { changed: true };
    }
    case 'clearCounters': {
      const loc = findCard(me, a.cardId);
      if (!loc) return { changed: false };
      loc.card.counters = {};
      return { changed: true };
    }
    case 'copy': {
      const loc = findCard(me, a.cardId);
      if (!loc) return { changed: false };
      if (me.zones.battlefield.length >= 300) return { changed: false, error: 'The battlefield is full.' };
      const c = newCard(loc.card.def, true);
      c.transformed = loc.card.transformed;
      c.x = clamp01(loc.card.x + 0.04, 0.5);
      c.y = clamp01(loc.card.y + 0.06, 0.5);
      me.zones.battlefield.push(c);
      log(state, `created a token copy of ${cardName(loc.card)}`, me);
      return { changed: true };
    }
    case 'token': {
      const name = String(a.name ?? '').trim().slice(0, 60);
      if (!name) return { changed: false, error: 'Give the token a name.' };
      const count = int(a.count, 1, 20, 1);
      if (me.zones.battlefield.length + count > 300) return { changed: false, error: 'The battlefield is full.' };
      const def: CardDef = { name, typeLine: `Token ${String(a.typeLine ?? 'Creature').trim().slice(0, 40) || 'Creature'}` };
      const pt = String(a.pt ?? '').trim().slice(0, 12);
      if (pt) def.pt = pt;
      for (let i = 0; i < count; i++) {
        const c = newCard(def, true);
        const spot = autoPlace(me, def);
        c.x = spot.x;
        c.y = spot.y;
        me.zones.battlefield.push(c);
      }
      log(state, `created ${count} ${name}${pt ? ` ${pt}` : ''} token${count === 1 ? '' : 's'}`, me);
      return { changed: true };
    }
    case 'life': {
      // Each player controls only their own life total.
      if (a.playerId && a.playerId !== me.id) return { changed: false, error: 'Only that player can change their life total.' };
      const target = me;
      const delta = int(a.delta, -1000, 1000, 0);
      if (!delta) return { changed: false };
      const before = target.life;
      target.life += delta;
      log(state, `life: ${before} → ${target.life}`, me);
      return { changed: true };
    }
    case 'playerCounter': {
      if (a.playerId && a.playerId !== me.id) return { changed: false, error: 'Only that player can change their counters.' };
      const target = me;
      const kind = String(a.kind ?? '').trim().toLowerCase().slice(0, 20);
      if (!kind) return { changed: false };
      const delta = int(a.delta, -99, 99, 0);
      target.counters[kind] = Math.max(0, (target.counters[kind] ?? 0) + delta);
      log(state, `${kind}: ${target.counters[kind]}`, me);
      return { changed: true };
    }
    case 'cmdDamage': {
      const victim = state.players.find((p) => p.id === a.playerId);
      const source = state.players.find((p) => p.id === a.sourceId);
      if (!victim || !source) return { changed: false };
      if (victim.id !== me.id) return { changed: false, error: 'Only the player taking commander damage can change it.' };
      const delta = int(a.delta, -99, 99, 0);
      const before = victim.commanderDamage[source.id] ?? 0;
      const next = Math.max(0, before + delta);
      if (next === before) return { changed: false };
      victim.commanderDamage[source.id] = next;
      victim.life -= next - before; // commander damage is also life loss
      log(state, `${victim.name} has taken ${next} commander damage from ${source.name} (life ${victim.life})`, me);
      return { changed: true };
    }
    case 'viewLibrary': {
      const n = a.n == null ? me.zones.library.length : int(a.n, 1, me.zones.library.length || 1, 1);
      const cards = me.zones.library.slice(0, n).map((c) => ({ id: c.id, def: c.def }));
      if (!a.quiet) log(state, a.n == null ? 'is searching their library' : `looked at the top ${n} card${n === 1 ? '' : 's'} of their library`, me);
      return { changed: !a.quiet, private: { t: 'library', mode: a.n == null ? 'search' : 'top', n, total: me.zones.library.length, cards } };
    }
    case 'passTurn': {
      const order = state.players.filter((p) => !p.conceded);
      if (!state.turn || !order.length) return { changed: false };
      const i = order.findIndex((p) => p.id === state.turn!.activeId);
      const next = order[(i + 1) % order.length];
      state.turn = { activeId: next.id, number: state.turn.number + 1, begun: false };
      log(state, `Turn ${state.turn.number}: ${next.name}`, undefined, 'system');
      return { changed: true };
    }
    case 'roll': {
      const sides = [2, 4, 6, 8, 10, 12, 20, 100].includes(a.sides) ? a.sides : 20;
      const r = randInt(sides) + 1;
      log(state, sides === 2 ? `flipped a coin: ${r === 1 ? 'heads' : 'tails'}` : `rolled a d${sides}: ${r}`, me);
      return { changed: true };
    }
    case 'chat':
      return chat(state, me, a);
    case 'concede': {
      if (me.conceded) return { changed: false };
      me.conceded = true;
      state.pendingResult = null;
      log(state, 'conceded', me);
      const left = state.players.filter((p) => !p.conceded);
      const over = left.length <= 1;
      if (over) endGame(state, left[0]?.id ?? null, 'concede');
      return { changed: true, ended: over };
    }
    // Reporting a result. Admitting defeat ends the game at once; anything else
    // (claiming a win, or no winner) waits until every other player still in the game agrees.
    case 'endGame': {
      const winner = a.winnerId == null ? null : state.players.find((p) => p.id === a.winnerId);
      if (a.winnerId != null && !winner) return { changed: false, error: 'Unknown player.' };
      const others = state.players.filter((p) => p.id !== me.id && !p.conceded);
      if (state.ranked === false) {
        // Nothing is at stake in an unranked game, so no confirmation is needed.
        state.pendingResult = null;
        endGame(state, winner?.id ?? null, 'reported');
        return { changed: true, ended: true };
      }
      if (winner && winner.id !== me.id && others.every((p) => p.id === winner.id)) {
        state.pendingResult = null;
        endGame(state, winner.id, 'agreed');
        return { changed: true, ended: true };
      }
      state.pendingResult = { by: me.id, winnerId: winner?.id ?? null, confirmedBy: [], at: Date.now() };
      const waiting = others.map((p) => p.name).join(' and ');
      log(state, `reported ${winner ? `that ${winner.id === me.id ? 'they' : winner.name} won` : 'no winner'}. Waiting for ${waiting} to confirm.`, me);
      return { changed: true };
    }
    case 'confirmResult': {
      const pr = state.pendingResult;
      if (!pr) return { changed: false, error: 'There is no result to confirm.' };
      if (pr.by === me.id) return { changed: false, error: 'The other player needs to confirm your result.' };
      if (!pr.confirmedBy.includes(me.id)) pr.confirmedBy.push(me.id);
      log(state, 'confirmed the result', me);
      const needed = state.players.filter((p) => p.id !== pr.by && !p.conceded);
      if (needed.every((p) => pr.confirmedBy.includes(p.id))) {
        state.pendingResult = null;
        endGame(state, pr.winnerId, 'agreed');
        return { changed: true, ended: true };
      }
      return { changed: true };
    }
    case 'rejectResult': {
      const pr = state.pendingResult;
      if (!pr) return { changed: false };
      state.pendingResult = null;
      log(state, pr.by === me.id ? 'withdrew their reported result' : "didn't agree with the reported result. The game continues.", me);
      return { changed: true };
    }
    default:
      return { changed: false, error: `Unknown action: ${a.t}` };
  }
}

function chat(state: GameState, me: Player, a: any): ActionResult {
  const text = String(a.text ?? '').trim().slice(0, 300);
  if (!text) return { changed: false };
  log(state, text, me, 'chat');
  return { changed: true };
}

// ---------- what each player is allowed to see ----------

function publicCard(c: Card) {
  return { id: c.id, def: c.def, tapped: c.tapped, faceDown: c.faceDown, transformed: c.transformed, counters: c.counters, x: c.x, y: c.y, token: c.token };
}

function hiddenCard(c: Card) {
  return { ...publicCard(c), def: { name: 'Face-down card' }, transformed: false };
}

export function viewFor(state: GameState, viewerId: string, online: Set<string>) {
  return {
    code: state.code,
    gameId: state.gameId,
    status: state.status,
    maxPlayers: state.maxPlayers,
    startingLife: state.startingLife,
    ranked: state.ranked !== false,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    turn: state.turn,
    winnerId: state.winnerId ?? null,
    endReason: state.endReason,
    pendingResult: state.pendingResult ?? null,
    log: state.log.slice(-150),
    players: state.players.map((p) => {
      const mine = p.id === viewerId;
      return {
        id: p.id,
        name: p.name,
        userId: p.userId,
        seat: p.seat,
        online: online.has(p.id),
        ready: p.ready,
        conceded: p.conceded,
        deck: p.deck
          ? {
            id: p.deck.id ?? null,
            name: p.deck.name,
            count: p.deck.main.length + p.deck.commanders.length,
            commanders: p.deck.commanders.map((c) => c.name),
            mat: p.deck.commanders[0] ? { art: p.deck.commanders[0].artCrop ?? null, colors: p.deck.commanders.map((c) => c.colors ?? '').join('') } : null,
          }
          : null,
        life: p.life,
        counters: p.counters,
        commanderDamage: p.commanderDamage,
        libraryCount: p.zones.library.length,
        handCount: p.zones.hand.length,
        hand: mine ? p.zones.hand.map(publicCard) : null,
        battlefield: p.zones.battlefield.map((c) => (c.faceDown && !mine ? hiddenCard(c) : publicCard(c))),
        graveyard: p.zones.graveyard.map(publicCard),
        exile: p.zones.exile.map(publicCard),
        command: p.zones.command.map(publicCard),
      };
    }),
  };
}
