// The practice bot: a seat the room plays by itself, so one person can try the table alone.
// It isn't clever. Each turn it untaps and draws, plays a land, casts what its lands can pay for,
// attacks with everything that was already out, and passes. It never changes your life total:
// it says in chat how much damage it's swinging for, and you apply it like you would at a real table.

import { parseTwoBoxes, resolveDeck } from './deck';
import type { Card, CardDef, GameState, Player } from './game';

export const BOT_USER_ID = 'bot';
export const BOT_NAME = 'Practice bot';

const BOT_COMMANDER = '1 Marwyn, the Nurturer';
const BOT_LIST = `36 Forest
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Wayfarer's Bauble
1 Swiftfoot Boots
1 Lightning Greaves
1 Llanowar Elves
1 Elvish Mystic
1 Fyndhorn Elves
1 Arbor Elf
1 Elvish Visionary
1 Sakura-Tribe Elder
1 Wood Elves
1 Yavimaya Elder
1 Eternal Witness
1 Reclamation Sage
1 Acidic Slime
1 Thragtusk
1 Craterhoof Behemoth
1 Avenger of Zendikar
1 Terastodon
1 Krosan Tusker
1 Pelakka Wurm
1 Primeval Titan
1 Hornet Queen
1 Rampaging Baloths
1 Garruk's Packleader
1 Leatherback Baloth
1 Kalonian Tusker
1 Grizzly Bears
1 Centaur Courser
1 Steel Leaf Champion
1 Old-Growth Troll
1 Questing Beast
1 Lovestruck Beast
1 End-Raze Forerunners
1 Ravenous Baloth
1 Craw Wurm
1 Colossal Dreadmaw
1 Ancient Brontodon
1 Gigantosaurus
1 Carnage Tyrant
1 Elvish Archdruid
1 Priest of Titania
1 Somberwald Sage
1 Beast Whisperer
1 Champion of Lambholt
1 Indrik Stomphowler
1 Thrashing Brontodon
1 Vorstclaw
1 Woodland Bellower
1 Garenbrig Paladin
1 Garruk Wildspeaker
1 Cultivate
1 Kodama's Reach
1 Rampant Growth
1 Nature's Lore
1 Three Visits
1 Harmonize
1 Beast Within
1 Overrun
1 Triumph of the Hordes
1 Heroic Intervention`;

// Looked up on Scryfall once per Worker instance, like a player's deck would be.
let cached: Promise<{ name: string; main: { count: number; def: CardDef }[]; commanders: CardDef[] }> | null = null;

export function botDeck(scryfallBase?: string) {
  cached ??= resolveDeck(parseTwoBoxes(BOT_COMMANDER, BOT_LIST), scryfallBase)
    .then((d) => {
      if (d.notFound.length) console.warn('Practice bot deck: cards not found', d.notFound);
      return { name: 'Marwyn stompy (practice bot)', main: d.main, commanders: d.commanders };
    })
    .catch((err) => {
      cached = null; // try again next time
      throw err;
    });
  return cached;
}

// ---------- playing a turn ----------

// Remembered on the bot's seat between steps, so a turn picks up where it left off.
export interface BotMemo {
  turn: number; // the turn number this memo belongs to
  landPlayed: boolean;
  cast: number; // spells cast this turn
  newIds: string[]; // permanents that arrived this turn ("summoning sick")
  attacked: boolean;
  commanderCasts: number; // for commander tax, across the whole game
}

const MAX_CASTS_PER_TURN = 4;
const isLand = (c: Card) => /\bLand\b/.test(c.def.typeLine ?? '');
const isCreature = (c: Card) => /\bCreature\b/.test(c.def.typeLine ?? '');
const isSpell = (c: Card) => /\b(Instant|Sorcery)\b/.test(c.def.typeLine ?? '');

// "{3}{G}{G}" → 5. X costs nothing here; hybrid and Phyrexian symbols count as one.
export function manaValue(cost: string | undefined): number {
  if (!cost) return 0;
  const front = cost.split('//')[0];
  let n = 0;
  for (const [, sym] of front.matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(sym)) n += Number(sym);
    else if (sym !== 'X' && sym !== 'Y' && sym !== 'Z') n += 1;
  }
  return n;
}

const power = (c: Card) => {
  const m = (c.pt ?? c.def.pt ?? '').match(/^(-?\d+)\//);
  return m ? Number(m[1]) : 0;
};

/**
 * The bot's next step on its own turn: a few actions applied together, or null when it has
 * nothing left to do (it will have passed the turn by then). Mutates bot.botMemo.
 */
export function nextBotStep(state: GameState, bot: Player): any[] | null {
  const turn = state.turn;
  if (state.status !== 'playing' || !turn || turn.activeId !== bot.id || bot.conceded) return null;
  const memo: BotMemo = bot.botMemo?.turn === turn.number
    ? bot.botMemo
    : { turn: turn.number, landPlayed: false, cast: 0, newIds: [], attacked: false, commanderCasts: bot.botMemo?.commanderCasts ?? 0 };
  bot.botMemo = memo;
  const z = bot.zones;

  // Untap, upkeep, draw.
  if (!turn.begun) return [{ t: 'beginTurn' }];

  // Instants and sorceries it "cast" last step have resolved.
  const resolved = z.battlefield.find(isSpell);
  if (resolved) return [{ t: 'move', cardId: resolved.id, to: 'graveyard' }];

  // One land a turn.
  if (!memo.landPlayed) {
    memo.landPlayed = true;
    const land = z.hand.find(isLand);
    if (land) {
      memo.newIds.push(land.id);
      return [{ t: 'move', cardId: land.id, to: 'battlefield' }];
    }
  }

  // Cast the cheapest thing its untapped lands can pay for, commander included.
  if (memo.cast < MAX_CASTS_PER_TURN) {
    const lands = z.battlefield.filter((c) => isLand(c) && !c.tapped);
    const options = [
      ...z.hand.filter((c) => !isLand(c)).map((c) => ({ c, cost: manaValue(c.def.manaCost), commander: false })),
      ...z.command.map((c) => ({ c, cost: manaValue(c.def.manaCost) + 2 * memo.commanderCasts, commander: true })),
    ]
      .filter((o) => o.cost <= lands.length)
      .sort((a, b) => b.cost - a.cost || (a.commander ? -1 : 1)); // spend as much mana as it can
    const pick = options[0];
    if (pick) {
      memo.cast++;
      if (pick.commander) memo.commanderCasts++;
      memo.newIds.push(pick.c.id);
      return [
        ...lands.slice(0, pick.cost).map((l) => ({ t: 'tap', cardId: l.id, tapped: true })),
        { t: 'move', cardId: pick.c.id, to: 'battlefield' },
      ];
    }
  }

  // Attack with every untapped creature that started the turn on the battlefield.
  if (!memo.attacked) {
    memo.attacked = true;
    const defender = state.players.find((p) => p.id !== bot.id && !p.conceded);
    const attackers = z.battlefield.filter((c) => isCreature(c) && !c.tapped && !c.faceDown && !memo.newIds.includes(c.id) && power(c) > 0);
    if (defender && attackers.length && turn.number > 1) {
      const total = attackers.reduce((n, c) => n + power(c), 0);
      const names = attackers.map((c) => `${c.def.name} (${power(c)})`).join(', ');
      const commander = attackers.filter((c) => bot.deck?.commanders.some((d) => d.name === c.def.name));
      const note = commander.length ? ` ${commander.map((c) => c.def.name).join(' and ')} ${commander.length === 1 ? 'is' : 'are'} its commander: ${commander.reduce((n, c) => n + power(c), 0)} of that is commander damage.` : '';
      return [
        ...attackers.map((c) => ({ t: 'tap', cardId: c.id, tapped: true })),
        { t: 'chat', text: `Attacking ${defender.name} with ${names}: ${total} damage if you don't block.${note}`.slice(0, 300) },
      ];
    }
  }

  // Discard down to seven, then pass.
  if (z.hand.length > 7) return [{ t: 'move', cardId: z.hand[z.hand.length - 1].id, to: 'graveyard' }];
  return [{ t: 'passTurn' }];
}
