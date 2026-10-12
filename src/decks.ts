// Saved decks. A deck is an exact card list: changing cards or commanders creates a new deck
// (and retires the old one, keeping its record). Renaming or changing printings does not.
import { sanitizeDef, type CardDef } from './game';
import type { Env } from './index';

export interface DeckBody {
  name: string;
  main: { count: number; def: CardDef }[];
  commanders: CardDef[];
}

export function normalizeDeck(raw: any): DeckBody | string {
  if (!raw || !Array.isArray(raw.main)) return 'That deck could not be read.';
  const main: DeckBody['main'] = [];
  for (const e of raw.main) {
    const def = sanitizeDef(e?.def);
    const count = Math.trunc(Number(e?.count));
    if (def && count >= 1 && count <= 99) main.push({ count, def });
  }
  const commanders = (Array.isArray(raw.commanders) ? raw.commanders : []).slice(0, 2).map(sanitizeDef).filter(Boolean) as CardDef[];
  const total = main.reduce((n, e) => n + e.count, 0) + commanders.length;
  if (!total) return 'That deck has no cards.';
  if (total > 250) return 'Decks are limited to 250 cards.';
  const name = String(raw.name ?? '').trim().slice(0, 80) || 'Untitled deck';
  return { name, main, commanders };
}

export const cardCount = (d: DeckBody) => d.main.reduce((n, e) => n + e.count, 0) + d.commanders.length;

// Identity of a deck for records: card names and counts plus commanders. Printings and the name don't count.
export async function contentHash(d: DeckBody): Promise<string> {
  const counts = new Map<string, number>();
  for (const e of d.main) counts.set(e.def.name, (counts.get(e.def.name) ?? 0) + e.count);
  const lines = [...counts].map(([n, c]) => `${c} ${n}`).sort();
  const cmd = d.commanders.map((c) => c.name).sort();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ lines, cmd })));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const RECORD_SQL = `
  SUM(CASE WHEN g.winner_user_id = me.user_id THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN g.winner_user_id IS NOT NULL AND g.winner_user_id <> me.user_id THEN 1 ELSE 0 END) AS losses`;

export async function listDecks(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    `SELECT d.id, d.name, d.commanders, d.card_count, d.created_at, d.previous_id,
            (SELECT COUNT(*) FROM game_players me JOIN games g ON g.id = me.game_id
              WHERE me.deck_id = d.id AND g.ranked = 1 AND g.winner_user_id = me.user_id) AS wins,
            (SELECT COUNT(*) FROM game_players me JOIN games g ON g.id = me.game_id
              WHERE me.deck_id = d.id AND g.ranked = 1 AND g.winner_user_id IS NOT NULL AND g.winner_user_id <> me.user_id) AS losses
       FROM decks d
      WHERE d.user_id = ? AND d.retired_at IS NULL
      ORDER BY d.created_at DESC`,
  ).bind(userId).all<any>();
  return rows.results.map((r) => ({ ...r, commanders: JSON.parse(r.commanders) }));
}

export async function getDeck(env: Env, userId: string, id: string, includeRetired = false) {
  const row = await env.DB.prepare(
    `SELECT id, name, list, retired_at FROM decks WHERE id = ? AND user_id = ? ${includeRetired ? '' : 'AND retired_at IS NULL'}`,
  ).bind(id, userId).first<any>();
  if (!row) return null;
  const list = JSON.parse(row.list);
  return { id: row.id as string, name: row.name as string, main: list.main, commanders: list.commanders } as DeckBody & { id: string };
}

export async function createDeck(env: Env, userId: string, body: DeckBody, previousId: string | null = null) {
  const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM decks WHERE user_id = ? AND retired_at IS NULL').bind(userId).first<{ n: number }>();
  if ((active?.n ?? 0) >= 100) return 'You can keep up to 100 decks. Delete one first.';
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO decks (id, user_id, name, commanders, card_count, content_hash, list, created_at, previous_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, body.name, JSON.stringify(body.commanders.map((c) => c.name)), cardCount(body), await contentHash(body),
    JSON.stringify({ main: body.main, commanders: body.commanders }), Date.now(), previousId).run();
  return { id, newVersion: !!previousId };
}

// Save an edit. Same cards → update in place (name/printings). Different cards → new deck, old one retired.
export async function updateDeck(env: Env, userId: string, id: string, body: DeckBody) {
  const old = await env.DB.prepare('SELECT content_hash FROM decks WHERE id = ? AND user_id = ? AND retired_at IS NULL')
    .bind(id, userId).first<{ content_hash: string }>();
  if (!old) return null;
  const hash = await contentHash(body);
  if (hash === old.content_hash) {
    await env.DB.prepare('UPDATE decks SET name = ?, commanders = ?, list = ? WHERE id = ?')
      .bind(body.name, JSON.stringify(body.commanders.map((c) => c.name)), JSON.stringify({ main: body.main, commanders: body.commanders }), id).run();
    return { id, newVersion: false };
  }
  const created = await createDeck(env, userId, body, id);
  if (typeof created === 'string') return created;
  await env.DB.prepare('UPDATE decks SET retired_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return created;
}

export async function retireDeck(env: Env, userId: string, id: string) {
  const r = await env.DB.prepare('UPDATE decks SET retired_at = ? WHERE id = ? AND user_id = ? AND retired_at IS NULL')
    .bind(Date.now(), id, userId).run();
  return r.meta.changes > 0;
}

// Records against one opponent, all from the signed-in player's side:
//   overall  - you vs this player, any decks
//   vsPlayer - your chosen deck vs this player, any of their decks
//   exact    - your chosen deck vs their chosen deck
export async function matchupRecord(env: Env, userId: string, myDeck: string | null, oppUser: string, oppDeck: string | null) {
  if (myDeck) {
    const mine = await env.DB.prepare('SELECT 1 FROM decks WHERE id = ? AND user_id = ?').bind(myDeck, userId).first();
    if (!mine) return null;
  }
  const q = (deck: string | null, theirDeck: string | null) => {
    const args: unknown[] = [userId, oppUser];
    let where = 'me.user_id = ?1 AND g.ranked = 1'; // unranked games never count
    let opp = 'o.user_id = ?2';
    if (deck) { args.push(deck); where += ` AND me.deck_id = ?${args.length}`; }
    if (theirDeck) { args.push(theirDeck); opp += ` AND o.deck_id = ?${args.length}`; }
    return env.DB.prepare(
      `SELECT ${RECORD_SQL}
         FROM game_players me JOIN games g ON g.id = me.game_id
        WHERE ${where}
          AND EXISTS (SELECT 1 FROM game_players o WHERE o.game_id = me.game_id AND o.user_id <> me.user_id AND ${opp})`,
    ).bind(...args);
  };
  const queries = [q(null, null), ...(myDeck ? [q(myDeck, null)] : []), ...(myDeck && oppDeck ? [q(myDeck, oppDeck)] : [])];
  const results = await env.DB.batch(queries);
  const rec = (r: any) => ({ wins: r?.results?.[0]?.wins ?? 0, losses: r?.results?.[0]?.losses ?? 0 });
  return {
    overall: rec(results[0]),
    vsPlayer: myDeck ? rec(results[1]) : null,
    exact: myDeck && oppDeck ? rec(results[2]) : null,
  };
}
