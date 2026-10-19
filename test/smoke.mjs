// End-to-end test against a local server. It starts its own stand-ins for Scryfall, Google, and
// Cloudflare Access on :8899. In one terminal: npm run dev:test   (fresh local database each time)
// In another:                                       npm test
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMocks, GOOGLE_CLIENT_ID } from './mocks.mjs';

const mocks = await startMocks();
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const step = (s) => console.log('  ✓', s);
const run = Date.now().toString(36);

// ---------- HTTP as a signed-in user ----------
class Account {
  constructor(username) { this.username = username; this.cookie = ''; }
  async call(path, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  async register(password = 'correct horse battery') {
    const r = await this.call('/api/auth/register', { method: 'POST', body: { username: this.username, password } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    this.id = r.data.user.id;
  }
  async saveDeck(name, text) {
    const r = await this.call('/api/decks/resolve', { method: 'POST', body: { text } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d = r.data;
    const s = await this.call('/api/decks', { method: 'POST', body: { name, main: d.main, commanders: d.commanders } });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    return { id: s.data.id, ...d, name };
  }
}

// ---------- WebSocket player ----------
class Client {
  constructor(account) { this.account = account; this.name = account.username; this.messages = []; this.waiters = []; }
  async connect(code) {
    this.ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`, { headers: { Cookie: this.account.cookie } });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'state') { this.state = m.state; this.you = m.you; }
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.send({ t: 'hello' });
    await this.next('state');
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  next(type, pred = () => true, ms = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${type}`)), ms);
      this.waiters.push((m) => {
        if (m.t === type && pred(m)) { clearTimeout(timer); resolve(m); return true; }
        return false;
      });
    });
  }
  act(m, pred) { const p = this.next('state', pred); this.send(m); return p; }
  get mine() { return this.state.players.find((p) => p.id === this.you); }
  get opp() { return this.state.players.find((p) => p.id !== this.you); }
}
const P = (c, m) => m.state.players.find((p) => p.id === c.you);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= accounts =================
const cl = await fetch(`${BASE}/api/changelog`);
assert.equal(cl.status, 200, 'the change log is public');
const { entries } = await cl.json();
assert.ok(entries.length >= 3);
assert.match(entries[0].date, /^\d{4}\.\d{2}\.\d{2}$/);
assert.ok(entries.every((e, i) => i === 0 || e.date < entries[i - 1].date), 'newest first');
assert.ok(entries.every((e) => e.changes.length >= 1), 'each day lists its changes');
assert.ok(entries.at(-1).changes[0].startsWith('First playable version'));
step(`change log: public, ${entries.length} days, newest first, split into individual changes`);

assert.equal((await fetch(`${BASE}/api/decks`)).status, 401);
assert.equal((await fetch(`${BASE}/api/rooms`, { method: 'POST' })).status, 401);
const alice = new Account(`alice_${run}`);
const bob = new Account(`bob_${run}`);
await alice.register();
await bob.register();
const dupe = await new Account('x').call('/api/auth/register', { method: 'POST', body: { username: alice.username.toUpperCase(), password: 'whatever123' } });
assert.equal(dupe.status, 400);
const badLogin = await new Account('x').call('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'wrong password' } });
assert.equal(badLogin.status, 401);
const relog = new Account(alice.username);
assert.equal((await relog.call('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'correct horse battery' } })).status, 200);
const evil = await fetch(`${BASE}/api/decks`, { method: 'POST', headers: { Cookie: alice.cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(evil.status, 403);
step('accounts: sign-up, unique names (any case), wrong password refused, cross-site requests refused');

// ================= Google sign-in =================
const cfg = (await (await fetch(`${BASE}/api/auth/config`)).json());
assert.deepEqual(cfg, { password: true, google: true, access: true });
async function google(code, { badState = false } = {}) {
  const start = await fetch(`${BASE}/api/auth/google/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('client_id'), GOOGLE_CLIENT_ID);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  const oauthCookie = start.headers.get('set-cookie').split(';')[0];
  const state = badState ? 'forged' : to.searchParams.get('state');
  const back = await fetch(`${BASE}/api/auth/google/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { Cookie: oauthCookie } });
  assert.equal(back.status, 302);
  const session = back.headers.getSetCookie().find((c) => c.startsWith('farcast_session=') && !c.startsWith('farcast_session=;'));
  return { location: back.headers.get('location'), session: session?.split(';')[0] };
}
const g1 = await google('gina');
assert.equal(g1.location, '/');
const gina = new Account('Gina');
gina.cookie = g1.session;
let meG = (await gina.call('/api/me')).data.user;
assert.equal(meG.username, 'Gina');
assert.equal(meG.needsName, true, 'new Google users choose their name');
assert.equal((await gina.call('/api/me', { method: 'PATCH', body: { username: alice.username } })).status, 400, 'names stay unique');
const renamedG = (await gina.call('/api/me', { method: 'PATCH', body: { username: `Gina ${run}` } })).data.user;
assert.equal(renamedG.username, `Gina ${run}`);
const again = await gina.call('/api/me', { method: 'PATCH', body: { username: `Gina Again ${run}` } });
assert.equal(again.status, 403, 'a name can only be chosen once');
assert.equal((await alice.call('/api/me', { method: 'PATCH', body: { username: `Alice2 ${run}` } })).status, 403, 'password accounts keep their sign-up name');
const g2 = await google('gina');
const gina2 = new Account('Gina'); gina2.cookie = g2.session;
meG = (await gina2.call('/api/me')).data.user;
assert.equal(meG.id, renamedG.id, 'signing in again finds the same account');
assert.equal(meG.needsName, false);
assert.match(decodeURIComponent((await google('gina', { badState: true })).location), /expired/);
const strangerTry = await google('stranger');
assert.match(decodeURIComponent(strangerTry.location), /invite list/);
assert.equal(strangerTry.session, undefined);
step('Google: PKCE redirect, account created on first sign-in, name chosen once then locked, forged state and uninvited emails refused');

// ================= Cloudflare Access =================
const viaAccess = (token) => fetch(`${BASE}/api/me`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
const goodToken = mocks.signAccess({ sub: 'access-sub-hal', email: 'hal@example.com' });
const halRes = await viaAccess(goodToken);
assert.equal(halRes.status, 200);
const hal = (await halRes.json()).user;
assert.equal(hal.username, 'hal');
assert.equal(hal.needsName, true);
assert.equal((await (await viaAccess(goodToken)).json()).user.id, hal.id, 'same Access user, same account');
assert.equal((await viaAccess(mocks.signAccess({ sub: 'x', email: 'x@example.com', aud: ['other-app'] }))).status, 401, 'wrong audience');
assert.equal((await viaAccess(mocks.signAccess({ sub: 'x', email: 'x@example.com', exp: 1 }))).status, 401, 'expired');
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
assert.equal((await viaAccess(mocks.signAccess({ sub: 'x', email: 'x@example.com' }, { key: otherKey }))).status, 401, 'forged signature');
const tampered = goodToken.split('.'); tampered[1] = Buffer.from(JSON.stringify({ sub: 'access-sub-hal', email: 'evil@example.com', aud: ['test-aud'], iss: 'https://test.cloudflareaccess.com', exp: 9e9 })).toString('base64url');
assert.equal((await viaAccess(tampered.join('.'))).status, 401, 'tampered claims');
step('Cloudflare Access: signed tokens sign you in; wrong audience, expired, forged, and tampered tokens refused');

// ================= decks =================
const list = (cmd, extra) => `Commander\n1 ${cmd}\n\nDeck\n20 Forest\n${Array.from({ length: 20 }, (_, i) => `1 ${extra} ${i}`).join('\n')}\n1 Sol Ring (CMM) 400`;
const aDeck = await alice.saveDeck('Tatyova Value', list('Alice Commander', 'Elf'));
const bDeck1 = await bob.saveDeck('Krenko Goblins', list('Bob Commander', 'Goblin'));
assert.equal(aDeck.commanders[0].name, 'Alice Commander');
assert.ok(aDeck.commanders[0].artCrop.includes('/art_crop/'));
assert.ok(aDeck.main.find((e) => e.def.set === 'cmm' && e.def.cn === '400'), 'exact printing kept');
const notFound = await alice.call('/api/decks/resolve', { method: 'POST', body: { text: '1 Not A Real Card\n1 Forest' } });
assert.deepEqual(notFound.data.notFound, ['Not A Real Card']);
assert.equal((await bob.call(`/api/decks/${aDeck.id}`)).status, 404, "Bob can't read Alice's deck");
const aList = (await alice.call('/api/decks')).data.decks;
assert.equal(aList.length, 1);
assert.equal(aList[0].card_count, 42);
step('decks: look up cards, save, exact printings kept, unknown cards reported, decks are private');

const twoBox = (commander, text) => alice.call('/api/decks/resolve', { method: 'POST', body: { commander, text } });
let tb = (await twoBox('1 Alice Commander', '1 Alice Commander\n1 Sol Ring\n30 Forest')).data;
assert.deepEqual(tb.commanders.map((c) => c.name), ['Alice Commander']);
assert.equal(tb.main.reduce((n, e) => n + e.count, 0), 31, 'commander listed in the deck box too is counted once');
assert.ok(!tb.main.some((e) => e.def.name === 'Alice Commander'));
tb = (await twoBox('Partner One Commander\nPartner Two Commander', '1 Sol Ring')).data;
assert.equal(tb.commanders.length, 2, 'partners: two commanders, counts optional');
const three = await twoBox('1 A Commander\n1 B Commander\n1 C Commander', '1 Sol Ring');
assert.equal(three.status, 400);
assert.match(three.data.error, /at most two commanders/);
tb = (await twoBox('', '60 Forest\n4 Sol Ring')).data;
assert.equal(tb.commanders.length, 0);
assert.equal(tb.main.reduce((n, e) => n + e.count, 0), 64, 'no 99-card rule');
step('two boxes: commander counted once if repeated, partners allowed, a third commander explained, any deck size');

// ================= lobby =================
const { data: { code } } = await alice.call('/api/rooms', { method: 'POST', body: { startingLife: 40 } });
const a = new Client(alice);
const b = new Client(bob);
await a.connect(code);
await b.connect(code);
assert.equal(a.state.players.length, 2);
assert.equal(a.mine.name, alice.username, 'seat uses the account name');

const carol = new Account(`carol_${run}`);
await carol.register();
const c = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`, { headers: { Cookie: carol.cookie } });
await new Promise((r) => c.on('open', r));
const rejected = new Promise((r) => c.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'rejected') r(m); }));
c.send(JSON.stringify({ t: 'hello' }));
assert.match((await rejected).message, /full/);

const anon = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`);
anon.on('error', () => {});
const anonStatus = await new Promise((r) => anon.on('unexpected-response', (_, res) => r(res.statusCode)));
assert.equal(anonStatus, 401);
step('rooms need an account; third player refused; seats use usernames');

b.send({ t: 'selectDeck', deckId: aDeck.id });
assert.match((await b.next('error')).message, /wasn't found/);
b.send({ t: 'setDeck', deck: { name: 'Hacked', main: [{ count: 60, def: { name: 'Black Lotus' } }] } });
await wait(300);
assert.equal(b.mine.deck, null, 'raw card data from the browser is ignored');
await a.act({ t: 'selectDeck', deckId: aDeck.id }, (m) => P(a, m).deck?.id === aDeck.id);
await b.act({ t: 'selectDeck', deckId: bDeck1.id }, (m) => P(b, m).deck?.id === bDeck1.id);
step('players can only pick their own saved decks; browser-sent card lists are ignored');

a.send({ t: 'ready', ready: true });
b.send({ t: 'ready', ready: true });
await a.next('state', (m) => m.state.players.every((p) => p.ready));
await a.act({ t: 'start' }, (m) => m.state.status === 'playing');
await wait(200);
assert.equal(b.state.status, 'playing');
assert.equal(a.opp.deck.mat.colors, 'GU');
assert.ok(a.opp.deck.mat.art.includes('/art_crop/'));
step("game starts; each side sees the other's playmat art");

// ================= hidden information =================
assert.equal(a.mine.hand.length, 7);
assert.equal(a.opp.hand, null);
assert.equal(a.mine.libraryCount, 34); // 41 main-deck cards minus 7 drawn
const raw = JSON.stringify(a.messages.at(-1));
for (const card of b.mine.hand) assert.ok(!raw.includes(card.id), "Alice never sees ids of Bob's hand");
assert.ok(!raw.includes(alice.cookie.split('=')[1]) && !raw.includes(bob.cookie.split('=')[1]), 'session tokens never broadcast');
step('opponent hand, libraries, and session tokens stay hidden');

// ================= ownership rules =================
b.send({ t: 'life', playerId: a.you, delta: -5 });
assert.match((await b.next('error')).message, /Only that player/);
b.send({ t: 'playerCounter', playerId: a.you, kind: 'poison', delta: 1 });
assert.match((await b.next('error')).message, /Only that player/);
b.send({ t: 'cmdDamage', playerId: a.you, sourceId: b.you, delta: 4 });
assert.match((await b.next('error')).message, /Only the player taking/);
await a.act({ t: 'life', delta: -5 }, (m) => P(a, m).life === 35);
await a.act({ t: 'cmdDamage', playerId: a.you, sourceId: b.you, delta: 4 }, (m) => P(a, m).life === 31);
await a.act({ t: 'playerCounter', kind: 'poison', delta: 2 }, (m) => P(a, m).counters.poison === 2);
b.send({ t: 'move', cardId: a.mine.hand[0].id, to: 'graveyard' });
assert.match((await b.next('error')).message, /not yours/);
step('only you change your life, poison, and commander damage; nobody moves your cards');

// ================= core play =================
const land = a.mine.hand.find((x) => /Land/.test(x.def.typeLine)) ?? a.mine.hand[0];
await a.act({ t: 'move', cardId: land.id, to: 'battlefield' }, (m) => P(a, m).battlefield.length === 1);
const onField = a.mine.battlefield[0];
await a.act({ t: 'counter', cardId: onField.id, kind: '+1/+1', delta: 2 }, (m) => P(a, m).battlefield[0].counters['+1/+1'] === 2);
await a.act({ t: 'copy', cardId: onField.id }, (m) => P(a, m).battlefield.length === 2);
await a.act({ t: 'token', name: 'Soldier', pt: '1/1', count: 2 }, (m) => P(a, m).battlefield.length === 4);
await a.act({ t: 'mill', n: 2 }, (m) => P(a, m).graveyard.length === 2);
const libBefore = a.mine.libraryCount;
await a.act({ t: 'shuffle', withGraveyard: true }, (m) => P(a, m).graveyard.length === 0);
assert.equal(a.mine.libraryCount, libBefore + 2);
// put cards into the library at a position
const peek = async (n) => { const pr = a.next('library'); a.send({ t: 'viewLibrary', quiet: true, ...(n ? { n } : {}) }); return (await pr).cards.map((x) => x.id); };
const third = a.mine.hand[0];
await a.act({ t: 'move', cardId: third.id, to: 'library', pos: 'top', depth: 3 }, (m) => !P(a, m).hand.some((x) => x.id === third.id));
assert.equal((await peek(5))[2], third.id, '3rd from the top');
const logLine = a.state.log.at(-1).text;
assert.match(logLine, /put a card 3rd from the top of their library/);
assert.ok(!logLine.includes(third.def.name), 'a card from your hand stays unnamed');
const second = a.mine.hand[0];
await a.act({ t: 'move', cardId: second.id, to: 'library', pos: 'bottom', depth: 2 }, (m) => !P(a, m).hand.some((x) => x.id === second.id));
let all = await peek();
assert.equal(all[all.length - 2], second.id, '2nd from the bottom');
const topCard = all[0];
await a.act({ t: 'move', cardId: topCard, to: 'library', pos: 'top', depth: 4 }, () => true);
assert.equal((await peek(6))[3], topCard, 'reorder within the library');
const deep = a.mine.hand[0];
await a.act({ t: 'move', cardId: deep.id, to: 'library', pos: 'top', depth: 999 }, (m) => !P(a, m).hand.some((x) => x.id === deep.id));
all = await peek();
assert.equal(all.at(-1), deep.id, 'a position past the end goes to the bottom');
const bView = JSON.stringify(b.messages.slice(-6));
assert.ok(!bView.includes(third.id), 'opponent never sees the card');
step('library positions: 3rd from top, 2nd from bottom, reorder within, past the end; card stays hidden');

// "doesn't untap": stays tapped through Untap all and the untap step
const held = a.mine.battlefield[0];
await a.act({ t: 'tap', cardId: held.id, tapped: true }, (m) => P(a, m).battlefield.find((c) => c.id === held.id)?.tapped);
await a.act({ t: 'noUntap', cardId: held.id }, (m) => P(a, m).battlefield.find((c) => c.id === held.id)?.noUntap === true);
const other = a.mine.battlefield.find((c) => c.id !== held.id);
await a.act({ t: 'tap', cardId: other.id, tapped: true }, (m) => P(a, m).battlefield.find((c) => c.id === other.id)?.tapped);
await a.act({ t: 'untapAll' }, (m) => !P(a, m).battlefield.find((c) => c.id === other.id)?.tapped);
assert.equal(a.mine.battlefield.find((c) => c.id === held.id).tapped, true, 'untap all skips it');
assert.match(a.state.log.at(-1).text, /1 stayed tapped/);
await a.act({ t: 'tap', cardId: held.id, tapped: false }, (m) => !P(a, m).battlefield.find((c) => c.id === held.id)?.tapped);
step('"doesn\'t untap": skipped by untap all, still untappable by hand');

// reveal: opponent gets the card faces (no ids); only hand or library cards can be revealed
const toReveal = a.mine.hand[0];
const seen = b.next('revealed');
a.send({ t: 'reveal', cardIds: [toReveal.id] });
const rv = await seen;
assert.equal(rv.cards[0].def.name, toReveal.def.name);
assert.ok(!JSON.stringify(rv).includes(toReveal.id), 'revealed cards carry no ids');
await wait(150);
assert.match(a.state.log.at(-1).text, new RegExp(`revealed ${toReveal.def.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} from their hand`));
a.send({ t: 'reveal', cardIds: [a.mine.battlefield[0].id] });
assert.match((await a.next('error')).message, /hand or library/);
b.send({ t: 'reveal', cardIds: [toReveal.id] });
assert.match((await b.next('error')).message, /hand or library/);
step('reveal: opponent sees the card face only; battlefield and other players\' cards refused');

// put the rest on the bottom, in a chosen and then a random order
const top3 = (await peek(3));
await a.act({ t: 'bottomMany', cardIds: top3, random: false }, () => true);
let lib3 = await peek();
assert.deepEqual(lib3.slice(-3), top3, 'chosen order: last one ends up at the very bottom');
const next3 = lib3.slice(0, 3);
await a.act({ t: 'bottomMany', cardIds: next3, random: true }, () => true);
lib3 = await peek();
assert.deepEqual([...lib3.slice(-3)].sort(), [...next3].sort(), 'random order: same cards, on the bottom');
assert.match(a.state.log.at(-1).text, /3 cards on the bottom of their library in a random order/);
step('put the rest on the bottom: chosen order kept, random order shuffled');

// counters up to 999
const ctr = a.mine.battlefield[0];
await a.act({ t: 'counter', cardId: ctr.id, kind: 'charge', delta: 999 }, (m) => P(a, m).battlefield.find((c) => c.id === ctr.id)?.counters.charge === 999);
await a.act({ t: 'counter', cardId: ctr.id, kind: 'charge', delta: 5 }, () => true);
assert.equal(a.mine.battlefield.find((c) => c.id === ctr.id).counters.charge, 999, 'capped at 999');
step('counters go up to 999');

// edit tokens; set power/toughness
const findA = (id) => a.mine.battlefield.find((c) => c.id === id);
const soldier = a.mine.battlefield.find((c) => c.token && c.def.name === 'Soldier');
await a.act({ t: 'editToken', cardId: soldier.id, name: 'Knight', pt: '2/2', typeLine: 'Creature — Knight' }, (m) => P(a, m).battlefield.find((c) => c.id === soldier.id)?.def.name === 'Knight');
assert.equal(findA(soldier.id).def.pt, '2/2');
assert.equal(findA(soldier.id).def.typeLine, 'Token Creature — Knight');
assert.ok(a.mine.battlefield.some((c) => c.token && c.def.name === 'Soldier'), 'the other Soldier is unchanged');
assert.match(a.state.log.at(-1).text, /changed token Soldier 1\/1 to Knight 2\/2/);
await a.act({ t: 'editToken', cardId: soldier.id, name: 'Knight', pt: '2/2', counters: { '+1/+1': 3, shield: 1 } }, (m) => P(a, m).battlefield.find((c) => c.id === soldier.id)?.counters['+1/+1'] === 3);
assert.deepEqual(findA(soldier.id).counters, { '+1/+1': 3, shield: 1 });
assert.match(a.state.log.at(-1).text, /counters: \+1\/\+1 ×3, shield ×1/);
await a.act({ t: 'editToken', cardId: soldier.id, name: 'Knight', pt: '2/2', counters: { '+1/+1': 0, shield: 1, charge: 1500 } }, (m) => P(a, m).battlefield.find((c) => c.id === soldier.id)?.counters.charge === 999);
assert.deepEqual(findA(soldier.id).counters, { shield: 1, charge: 999 }, '0 removes a counter; counts cap at 999');
// Use a card of its own, so the "doesn't untap" card from earlier isn't disturbed.
const fresh = a.mine.hand[0];
await a.act({ t: 'move', cardId: fresh.id, to: 'battlefield' }, (m) => P(a, m).battlefield.some((c) => c.id === fresh.id));
const original = findA(fresh.id);
await a.act({ t: 'copy', cardId: original.id }, () => true);
const copyCard = a.mine.battlefield.at(-1);
await a.act({ t: 'editToken', cardId: copyCard.id, name: copyCard.def.name, pt: '7/7' }, (m) => P(a, m).battlefield.find((c) => c.id === copyCard.id)?.pt === '7/7');
assert.equal(findA(original.id).pt, null, "editing a copy doesn't touch the original");
a.send({ t: 'editToken', cardId: original.id, name: 'Nope' });
assert.match((await a.next('error')).message, /Only tokens/);
await a.act({ t: 'setPT', cardId: original.id, pt: '5/5' }, (m) => P(a, m).battlefield.find((c) => c.id === original.id)?.pt === '5/5');
await wait(150);
assert.equal(b.opp.battlefield.find((c) => c.id === original.id).pt, '5/5', 'opponent sees the new power/toughness');
b.send({ t: 'setPT', cardId: original.id, pt: '1/1' });
assert.match((await b.next('error')).message, /Only cards on the battlefield/);
await a.act({ t: 'setPT', cardId: original.id, pt: '' }, (m) => P(a, m).battlefield.find((c) => c.id === original.id)?.pt === null);
await a.act({ t: 'setPT', cardId: original.id, pt: '9/9' }, () => true);
await a.act({ t: 'move', cardId: original.id, to: 'hand' }, (m) => P(a, m).hand.some((c) => c.id === original.id));
await a.act({ t: 'move', cardId: original.id, to: 'battlefield' }, (m) => P(a, m).battlefield.some((c) => c.id === original.id));
assert.equal(findA(original.id).pt, null, 'leaving the battlefield resets it');
step("edit tokens (copies stay independent); set and reset power/toughness; it resets when the card leaves; opponents can't change it");

const first = a.state.turn.activeId === a.you ? a : b;
if (first === a) {
  await a.act({ t: 'tap', cardId: held.id, tapped: true }, (m) => P(a, m).battlefield.find((c) => c.id === held.id)?.tapped);
}
await first.act({ t: 'beginTurn' }, (m) => m.state.turn.begun);
if (first === a) assert.equal(a.mine.battlefield.find((c) => c.id === held.id).tapped, true, 'the untap step skips it too');
await first.act({ t: 'passTurn' }, (m) => m.state.turn.number === 2);
step('counters, copies, tokens, mill, graveyard shuffle, begin turn, pass turn');

// ================= results and records =================
await b.act({ t: 'concede' }, (m) => m.state.status === 'ended');
await wait(300);
let rec = (await alice.call(`/api/records?deck=${aDeck.id}&opponent=${bob.id}&opponentDeck=${bDeck1.id}`)).data;
assert.deepEqual(rec, { overall: { wins: 1, losses: 0 }, vsPlayer: { wins: 1, losses: 0 }, exact: { wins: 1, losses: 0 } });
assert.deepEqual((await bob.call(`/api/records?opponent=${alice.id}`)).data, { overall: { wins: 0, losses: 1 }, vsPlayer: null, exact: null }, 'overall record works before choosing a deck');
assert.equal((await bob.call(`/api/records?deck=${aDeck.id}&opponent=${alice.id}`)).status, 404, "can't query records for someone else's deck");
step('game 1: Alice wins; 1–0 overall vs Bob, 1–0 with this deck, 1–0 vs Krenko Goblins; Bob sees 0–1 before picking a deck');

// Bob renames (same cards) → same deck. Then changes a card → new deck with a fresh record.
const renamed = await bob.call(`/api/decks/${bDeck1.id}`, { method: 'PUT', body: { name: 'Krenko Swarm', main: bDeck1.main, commanders: bDeck1.commanders } });
assert.deepEqual(renamed.data, { id: bDeck1.id, newVersion: false });
const changedMain = bDeck1.main.map((e) => (e.def.name === 'Forest' ? { ...e, count: e.count - 1 } : e));
const extra = (await bob.call('/api/decks/resolve', { method: 'POST', body: { text: '1 Goblin Extra' } })).data.main[0];
const v2 = await bob.call(`/api/decks/${bDeck1.id}`, { method: 'PUT', body: { name: 'Krenko Swarm', main: [...changedMain, extra], commanders: bDeck1.commanders } });
assert.equal(v2.data.newVersion, true);
assert.notEqual(v2.data.id, bDeck1.id);
const bobDecks = (await bob.call('/api/decks')).data.decks;
assert.deepEqual(bobDecks.map((d) => d.id), [v2.data.id], 'old version leaves the deck list');
assert.equal(bobDecks[0].wins + bobDecks[0].losses, 0, 'new version starts with a fresh record');
step('renaming keeps the deck; changing a card makes a new deck with a fresh record');

await b.act({ t: 'rematch' }, (m) => m.state.status === 'lobby');
await b.act({ t: 'selectDeck', deckId: v2.data.id }, (m) => P(b, m).deck?.id === v2.data.id);
a.send({ t: 'ready', ready: true });
b.send({ t: 'ready', ready: true });
await a.next('state', (m) => m.state.players.every((p) => p.ready));
await a.act({ t: 'start' }, (m) => m.state.status === 'playing');

// Claiming a win needs the other player to agree.
await b.act({ t: 'endGame', winnerId: b.you }, (m) => m.state.pendingResult?.winnerId === b.you);
await wait(150);
assert.equal(a.state.status, 'playing', 'a claim alone does not end the game');
assert.equal(a.state.pendingResult.by, b.you, 'Alice sees the claim');
await a.act({ t: 'rejectResult' }, (m) => m.state.pendingResult === null);
assert.match(a.state.log.at(-1).text, /didn't agree/);
await b.act({ t: 'endGame', winnerId: b.you }, (m) => !!m.state.pendingResult);
b.send({ t: 'confirmResult' });
assert.match((await b.next('error')).message, /other player needs to confirm/);
assert.equal(b.state.status, 'playing');
await a.act({ t: 'confirmResult' }, (m) => m.state.status === 'ended');
assert.equal(a.state.winnerId, b.you);
assert.equal(a.state.endReason, 'agreed');
await wait(300);
step('claiming a win waits for the other player; "keep playing" cancels it; you can\'t confirm your own claim; confirming ends it');

rec = (await alice.call(`/api/records?deck=${aDeck.id}&opponent=${bob.id}&opponentDeck=${v2.data.id}`)).data;
assert.deepEqual(rec, { overall: { wins: 1, losses: 1 }, vsPlayer: { wins: 1, losses: 1 }, exact: { wins: 0, losses: 1 } });
const oldMatch = (await alice.call(`/api/records?deck=${aDeck.id}&opponent=${bob.id}&opponentDeck=${bDeck1.id}`)).data;
assert.deepEqual(oldMatch.exact, { wins: 1, losses: 0 }, 'old version keeps its record');
const aDecks = (await alice.call('/api/decks')).data.decks;
assert.equal(`${aDecks[0].wins}-${aDecks[0].losses}`, '1-1');
const games = (await alice.call('/api/games')).data.games;
assert.equal(games.length, 2);
assert.equal((await carol.call('/api/games')).data.games.length, 0, 'history is per account');
step('game 2: Bob wins with the new version; Alice is 1–1 vs Bob, 0–1 vs the new deck, old matchup still 1–0');

// Admitting defeat ends the game at once; "no winner" needs agreement and doesn't count.
await a.act({ t: 'rematch' }, (m) => m.state.status === 'lobby');
a.send({ t: 'ready', ready: true }); b.send({ t: 'ready', ready: true });
await a.next('state', (m) => m.state.players.every((p) => p.ready));
await a.act({ t: 'start' }, (m) => m.state.status === 'playing');
await a.act({ t: 'endGame', winnerId: null }, (m) => !!m.state.pendingResult);
await a.act({ t: 'rejectResult' }, (m) => m.state.pendingResult === null); // withdraw own claim
await a.act({ t: 'endGame', winnerId: b.you }, (m) => m.state.status === 'ended');
assert.equal(a.state.winnerId, b.you, '"opponent won" ends immediately');
await wait(300);
rec = (await alice.call(`/api/records?opponent=${bob.id}`)).data;
assert.deepEqual(rec.overall, { wins: 1, losses: 2 });
step('reporting that your opponent won ends the game at once; claims can be withdrawn; Alice now 1–2 vs Bob');

// ================= unranked games =================
const { data: { code: code2 } } = await alice.call('/api/rooms', { method: 'POST', body: { startingLife: 20, ranked: false } });
const a2 = new Client(alice), b2 = new Client(bob);
await a2.connect(code2); await b2.connect(code2);
assert.equal(a2.state.ranked, false, 'room created unranked');
await b2.act({ t: 'setStartingLife', life: 30 }, (m) => m.state.startingLife === 30);
b2.send({ t: 'setStartingLife', life: 25 });
assert.match((await b2.next('error')).message, /20, 30, or 40/);
await a2.act({ t: 'selectDeck', deckId: aDeck.id }, (m) => P(a2, m).deck?.id === aDeck.id);
await b2.act({ t: 'selectDeck', deckId: v2.data.id }, (m) => P(b2, m).deck?.id === v2.data.id);
a2.send({ t: 'ready', ready: true }); b2.send({ t: 'ready', ready: true });
await a2.next('state', (m) => m.state.players.every((p) => p.ready));
await b2.act({ t: 'setRanked', ranked: true }, (m) => m.state.ranked === true);
assert.ok(b2.state.players.every((p) => !p.ready), 'switching the game type asks everyone to ready up again');
await a2.act({ t: 'setRanked', ranked: false }, (m) => m.state.ranked === false);
a2.send({ t: 'ready', ready: true }); b2.send({ t: 'ready', ready: true });
await a2.next('state', (m) => m.state.players.every((p) => p.ready));
await a2.act({ t: 'start' }, (m) => m.state.status === 'playing');
await a2.act({ t: 'endGame', winnerId: a2.you }, (m) => m.state.status === 'ended');
assert.equal(a2.state.winnerId, a2.you, 'unranked: claiming a win ends the game without confirmation');
await wait(300);
assert.deepEqual((await alice.call(`/api/records?opponent=${bob.id}`)).data.overall, { wins: 1, losses: 2 }, 'unranked win not counted');
assert.equal((await alice.call('/api/decks')).data.decks.find((d) => d.id === aDeck.id).wins, 1, 'deck record unchanged');
const hist = (await alice.call('/api/games')).data.games;
assert.equal(hist[0].ranked, 0, 'history marks it unranked');
assert.equal(hist.filter((g) => g.ranked === 1).length, 3);
step('lobby: starting life and ranked/unranked can be changed (both reset ready); unranked ends without confirmation, kept in history, never counted');
a2.ws.close(); b2.ws.close();

// ================= practice bot =================
const { data: { code: code3 } } = await alice.call('/api/rooms', { method: 'POST', body: { startingLife: 40 } });
const a3 = new Client(alice);
await a3.connect(code3);
await a3.act({ t: 'addBot' }, (m) => m.state.players.length === 2 && m.state.players.some((p) => p.bot && p.ready));
assert.equal(a3.opp.bot, true);
assert.equal(a3.opp.online, true, 'the bot always shows as connected');
assert.equal(a3.opp.deck.commanders.length, 1, 'the bot plays a commander deck');
assert.equal(a3.opp.deck.count, 100);
assert.equal(a3.state.ranked, false, 'adding the bot makes the game unranked');
a3.send({ t: 'setRanked', ranked: true });
assert.match((await a3.next('error')).message, /always unranked/);
await a3.act({ t: 'removeBot' }, (m) => m.state.players.length === 1);
await a3.act({ t: 'addBot' }, (m) => m.state.players.some((p) => p.bot && p.ready));
await a3.act({ t: 'selectDeck', deckId: aDeck.id }, (m) => P(a3, m).deck?.id === aDeck.id);
await a3.act({ t: 'ready', ready: true }, (m) => P(a3, m).ready);
await a3.act({ t: 'start' }, (m) => m.state.status === 'playing');
const botTurn = async () => {
  if (a3.state.turn.activeId === a3.you) await a3.act({ t: 'passTurn' }, (m) => m.state.turn.activeId !== a3.you);
  await a3.next('state', (m) => m.state.turn.activeId === a3.you, 30000);
};
await botTurn();
const botName = a3.opp.name;
assert.ok(a3.state.log.some((l) => l.by === a3.opp.id && /^began their turn/.test(l.text)), 'the bot began its turn');
assert.ok(a3.opp.battlefield.some((c) => /Land/.test(c.def.typeLine)), 'the bot played a land');
assert.equal(a3.opp.hand, null, "the bot's hand stays hidden");
await botTurn();
assert.ok(a3.state.log.some((l) => l.by === a3.opp.id && l.kind === 'chat' && /^Attacking .+ damage/.test(l.text)), 'the bot attacks and says how much damage');
assert.equal(P(a3, { state: a3.state }).life, 40, "the bot never changes your life total");
await a3.act({ t: 'endGame', winnerId: a3.you }, (m) => m.state.status === 'ended');
await a3.act({ t: 'rematch' }, (m) => m.state.status === 'lobby');
await a3.next('state', (m) => m.state.players.some((p) => p.bot && p.ready));
await wait(300);
assert.equal((await alice.call('/api/games')).data.games[0].players.find((p) => !p.you).name, botName, 'bot games are kept in history');
assert.deepEqual((await alice.call(`/api/records?opponent=${bob.id}`)).data.overall, { wins: 1, losses: 2 }, 'bot games never count');
step('practice bot: joins with a 100-card commander deck, always unranked, plays its turns (land, spells, attacks in chat) and passes back, readies for a rematch');
a3.ws.close();

a.ws.close();
b.ws.close();
c.close();
mocks.server.close();
console.log('\nAll checks passed.');
