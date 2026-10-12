import type { CardDef } from './game';

export interface DeckLine {
  count: number;
  name: string;
  set?: string;
  cn?: string;
  section: 'main' | 'commander' | 'skip';
}

const SCRYFALL_HEADERS = {
  'User-Agent': 'FarcastTabletop/0.1',
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

// ---------- text parsing ----------
// Handles Moxfield/Archidekt/MTGO/Arena exports, e.g.
//   1 Sol Ring
//   1x Sol Ring
//   1 Sol Ring (CMM) 400 *F* #Ramp
//   Commander / Deck / Sideboard section headers

const HEADER = /^(?:\/\/\s*)?(commanders?|deck|main(?:board)?|sideboard|maybeboard|considering|companions?|tokens?|about)\s*:?\s*(?:\(\d+\))?\s*$/i;

export function parseDeckText(text: string): { name?: string; lines: DeckLine[] } {
  let section: DeckLine['section'] = 'main';
  let name: string | undefined;
  const merged = new Map<string, DeckLine>();

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    const header = line.match(HEADER);
    if (header) {
      const h = header[1].toLowerCase();
      section = h.startsWith('commander') ? 'commander' : h === 'deck' || h.startsWith('main') ? 'main' : 'skip';
      continue;
    }
    const nameLine = line.match(/^name\s+(.+)$/i);
    if (nameLine && section === 'skip') {
      name = nameLine[1].trim();
      continue;
    }
    if (line.startsWith('#') || line.startsWith('//')) continue;

    let lineSection = section;
    if (/^SB:\s*/i.test(line)) {
      line = line.replace(/^SB:\s*/i, '');
      lineSection = 'skip';
    }

    let count = 1;
    const countMatch = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (countMatch) {
      count = Math.min(99, parseInt(countMatch[1], 10));
      line = countMatch[2];
    }

    line = line
      .replace(/\s+#.*$/, '') // Moxfield tags
      .replace(/(\s+\*[A-Z]+\*)+\s*$/i, '') // *F* foil / *E* etched markers
      .trim();

    let set: string | undefined;
    let cn: string | undefined;
    const withCn = line.match(/^(.+?)\s+\(([A-Za-z0-9]{2,6})\)\s+(\S+)$/);
    const setOnly = line.match(/^(.+?)\s+\(([A-Za-z0-9]{2,6})\)$/);
    if (withCn) [, line, set, cn] = withCn;
    else if (setOnly) [, line, set] = setOnly;

    const cardName = line.trim();
    if (!cardName || count < 1) continue;

    const key = `${lineSection}|${cardName.toLowerCase()}|${set ?? ''}|${cn ?? ''}`;
    const existing = merged.get(key);
    if (existing) existing.count += count;
    else merged.set(key, { count, name: cardName, set: set?.toLowerCase(), cn, section: lineSection });
  }
  return { name, lines: [...merged.values()] };
}

// Two boxes in the editor: one for the commander(s), one for the rest of the deck.
// Anything under a "Commander" header in the deck box also counts as a commander.
export function parseTwoBoxes(commanderText: string, deckText: string): { name?: string; lines: DeckLine[] } {
  const cmd = parseDeckText(`Commander\n${commanderText}`).lines
    .filter((l) => l.section !== 'skip')
    .map((l) => ({ ...l, section: 'commander' as const, count: 1 }));
  const deck = parseDeckText(`Deck\n${deckText}`);
  return { name: deck.name, lines: [...cmd, ...deck.lines] };
}

// ---------- deck URLs (best effort; neither site offers an official API) ----------

export async function fetchDeckFromUrl(url: string): Promise<{ name?: string; lines: DeckLine[] }> {
  const mox = url.match(/moxfield\.com\/decks\/([\w-]+)/i);
  const arch = url.match(/archidekt\.com\/(?:api\/)?decks\/(\d+)/i);

  if (arch) {
    const res = await fetch(`https://archidekt.com/api/decks/${arch[1]}/`, { headers: { Accept: 'application/json', 'User-Agent': SCRYFALL_HEADERS['User-Agent'] } });
    if (!res.ok) throw new Error(`Archidekt returned ${res.status}. Make sure the deck is public, or paste its text export.`);
    const data: any = await res.json();
    const lines: DeckLine[] = [];
    for (const entry of data.cards ?? []) {
      const cats: string[] = (entry.categories ?? []).map((c: string) => c.toLowerCase());
      const skip = cats.some((c) => c === 'maybeboard' || c === 'sideboard');
      const name = entry.card?.oracleCard?.name;
      if (!name) continue;
      lines.push({
        count: entry.quantity ?? 1,
        name,
        set: entry.card?.edition?.editioncode,
        cn: entry.card?.collectorNumber,
        section: skip ? 'skip' : cats.includes('commander') ? 'commander' : 'main',
      });
    }
    if (!lines.length) throw new Error('That Archidekt deck has no cards we could read.');
    return { name: data.name, lines };
  }

  if (mox) {
    // Moxfield has no public API and often blocks requests from servers.
    // If this fails, the user pastes Moxfield's text export instead.
    let res: Response;
    try {
      res = await fetch(`https://api2.moxfield.com/v3/decks/all/${mox[1]}`, { headers: { Accept: 'application/json', 'User-Agent': SCRYFALL_HEADERS['User-Agent'] } });
    } catch {
      throw new Error(MOXFIELD_FALLBACK);
    }
    if (!res.ok) throw new Error(MOXFIELD_FALLBACK);
    const data: any = await res.json().catch(() => null);
    const boards = data?.boards;
    if (!boards) throw new Error(MOXFIELD_FALLBACK);
    const lines: DeckLine[] = [];
    const take = (board: string, section: DeckLine['section']) => {
      for (const entry of Object.values<any>(boards[board]?.cards ?? {})) {
        if (!entry?.card?.name) continue;
        lines.push({ count: entry.quantity ?? 1, name: entry.card.name, set: entry.card.set, cn: entry.card.cn, section });
      }
    };
    take('commanders', 'commander');
    take('mainboard', 'main');
    if (!lines.length) throw new Error(MOXFIELD_FALLBACK);
    return { name: data.name, lines };
  }

  throw new Error('Use a Moxfield or Archidekt deck link, or paste the decklist text.');
}

const MOXFIELD_FALLBACK =
  "Moxfield didn't let us load that deck directly. In Moxfield, open the deck, choose Export, copy the text, and paste it here.";

// ---------- Scryfall ----------

function toDef(card: any): CardDef {
  const faces: any[] | undefined = card.card_faces;
  const hasBack = !card.image_uris && faces?.[1]?.image_uris;
  const front = card.image_uris ?? faces?.[0]?.image_uris;
  const frontFace = hasBack ? faces![0] : card;
  const def: CardDef = {
    name: hasBack ? faces![0].name : card.name,
    typeLine: frontFace.type_line ?? card.type_line,
    manaCost: frontFace.mana_cost ?? card.mana_cost,
    image: front?.normal,
    imageSmall: front?.small,
    scryfallId: card.id,
    artCrop: front?.art_crop,
    colors: (card.color_identity ?? []).join(''),
    set: card.set,
    cn: card.collector_number,
  };
  const power = frontFace.power ?? card.power;
  const toughness = frontFace.toughness ?? card.toughness;
  if (power != null && toughness != null) def.pt = `${power}/${toughness}`;
  else if (frontFace.loyalty != null) def.pt = `[${frontFace.loyalty}]`;
  if (hasBack) {
    def.backName = faces![1].name;
    def.backImage = faces![1].image_uris.normal;
    def.backImageSmall = faces![1].image_uris.small;
  }
  for (const k of Object.keys(def) as (keyof CardDef)[]) if (def[k] == null || def[k] === '') delete def[k];
  return def;
}

async function collection(identifiers: object[], base: string): Promise<{ data: any[]; notFound: any[] }> {
  const data: any[] = [];
  const notFound: any[] = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    if (i) await new Promise((r) => setTimeout(r, 100)); // Scryfall asks for ~10 req/s max
    const res = await fetch(`${base}/cards/collection`, {
      method: 'POST',
      headers: SCRYFALL_HEADERS,
      body: JSON.stringify({ identifiers: identifiers.slice(i, i + 75) }),
    });
    if (!res.ok) throw new Error(`Card lookup failed (Scryfall returned ${res.status}). Try again in a moment.`);
    const body: any = await res.json();
    data.push(...(body.data ?? []));
    notFound.push(...(body.not_found ?? []));
  }
  return { data, notFound };
}

export interface ResolvedDeck {
  name: string;
  main: { count: number; def: CardDef }[];
  commanders: CardDef[];
  notFound: string[];
  skipped: number;
}

export async function resolveDeck(parsed: { name?: string; lines: DeckLine[] }, base = 'https://api.scryfall.com'): Promise<ResolvedDeck> {
  const wanted = parsed.lines.filter((l) => l.section !== 'skip');
  const skipped = parsed.lines.filter((l) => l.section === 'skip').reduce((n, l) => n + l.count, 0);
  if (!wanted.length) throw new Error('No cards found. Paste one card per line, like "1 Sol Ring".');
  if (wanted.length > 250) throw new Error('That list has more than 250 different cards.');

  const byKey = new Map<string, any>();
  const index = (card: any) => {
    byKey.set(`n:${card.name.toLowerCase()}`, card);
    for (const f of card.card_faces ?? []) if (f.name) byKey.set(`n:${f.name.toLowerCase()}`, card);
    byKey.set(`s:${card.set}:${card.collector_number}`, card);
  };

  // Pass 1: exact printings where we have them, names otherwise.
  const ids = new Map<string, object>();
  for (const l of wanted) {
    if (l.set && l.cn) ids.set(`s:${l.set}:${l.cn}`, { set: l.set, collector_number: l.cn });
    else ids.set(`n:${l.name.toLowerCase()}`, { name: frontName(l.name) });
  }
  const first = await collection([...ids.values()], base);
  first.data.forEach(index);

  // Pass 2: printings Scryfall didn't recognise, retried by name.
  const retry = new Map<string, object>();
  for (const l of wanted) if (!lookup(byKey, l)) retry.set(l.name.toLowerCase(), { name: frontName(l.name) });
  if (retry.size) (await collection([...retry.values()], base)).data.forEach(index);

  const main: ResolvedDeck['main'] = [];
  const commanders: CardDef[] = [];
  const notFound: string[] = [];
  for (const l of wanted) {
    const card = lookup(byKey, l);
    if (!card) {
      notFound.push(l.name);
      continue;
    }
    const def = toDef(card);
    if (l.section === 'commander') for (let i = 0; i < l.count; i++) commanders.push(def);
    else main.push({ count: l.count, def });
  }
  // Exports often list the commander in the main deck too; don't count it twice.
  for (const c of commanders) {
    const entry = main.find((e) => e.def.name === c.name);
    if (entry) entry.count--;
  }
  return {
    name: parsed.name?.slice(0, 80) || 'Untitled deck',
    main: main.filter((e) => e.count > 0),
    commanders,
    notFound,
    skipped,
  };
}

function frontName(name: string) {
  // "Delver of Secrets // Insectile Aberration" -> front face; split cards like "Fire // Ice" also resolve this way.
  return name.split(/\s*\/\/?\s*/)[0].trim();
}

function lookup(byKey: Map<string, any>, l: DeckLine) {
  return (
    (l.set && l.cn ? byKey.get(`s:${l.set}:${l.cn}`) : undefined) ??
    byKey.get(`n:${l.name.toLowerCase()}`) ??
    byKey.get(`n:${frontName(l.name).toLowerCase()}`)
  );
}
