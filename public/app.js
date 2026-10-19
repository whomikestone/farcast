// Farcast: client. Plain JS, no build step.
// The server is the source of truth; this file renders whatever view the server sends
// and turns clicks/drags into small action messages.

// ---------------------------------------------------------------- utilities

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const cls = (...names) => names.filter(Boolean).join(' ');
const clamp01 = (n) => Math.min(1, Math.max(0, n));

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('farcast:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('farcast:' + key, JSON.stringify(value));
    } catch {
      /* storage full or blocked */
    }
  },
};

function toast(message, kind = 'info') {
  const el = h('div', { class: cls('toast', kind) }, message);
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), 4200);
}

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cardSize() {
  const probe = $('.card-probe');
  return { w: probe.offsetWidth || 80, h: probe.offsetHeight || 112 };
}

// ---------------------------------------------------------------- app state

const S = {
  user: null, // signed-in account { id, username, needsName }
  auth: null, // which sign-in methods are on: { password, google, access }
  code: null,
  ws: null,
  retry: 0,
  connected: false,
  state: null, // server view
  you: null, // my public player id
  closedReason: null,
  decks: null, // my saved decks (for the lobby picker)
  records: null, // { key, vsPlayer, exact }
  modal: null,
  library: null, // private library view from server
  pendingLife: {},
  inflightLife: {},
  lifeTimers: {},
  dismissedEnd: null,
};

const me = () => S.state?.players.find((p) => p.id === S.you);
const opponents = () => S.state?.players.filter((p) => p.id !== S.you) ?? [];
const playerById = (id) => S.state?.players.find((p) => p.id === id);
const isMine = (pid) => pid === S.you;

function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
  else toast('Not connected. Reconnecting…', 'warn');
}

class SignedOut extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    S.user = null;
    showSignIn();
    throw new SignedOut();
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// "3–1", with the dash in the UI font (the display font's dash is a hairline).
const recordText = (r) => h('span', { class: 'rec' }, String(r?.wins ?? 0), h('span', { class: 'rd' }, '–'), String(r?.losses ?? 0));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- routing

// All reads and changes of the address go through these three helpers.
function currentPath() { return location.pathname; }
function currentSearch() { return location.search; }
function setPath(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
}

function navigate(path) {
  setPath(path);
  boot();
}
window.addEventListener('popstate', boot);

// Screens before you're signed in have their own addresses: /signin, /signup, /welcome.
// ?next= remembers where you were going (an invite link, say) so you land there afterwards.
const AUTH_PATHS = ['/signin', '/signup', '/welcome'];
const isAuthPath = (p) => AUTH_PATHS.includes(p.replace(/\/$/, ''));

function nextTarget() {
  const next = new URLSearchParams(currentSearch()).get('next') ?? '';
  // Only same-site paths, never "//elsewhere.com" or "https://…".
  const ok = /^\/(?!\/)/.test(next) && !isAuthPath(next.split('?')[0]) && !/^\/(cdn-cgi|api)\//.test(next);
  return ok ? next : '/';
}

function withNext(authPath) {
  const here = currentPath();
  const internal = here.startsWith('/cdn-cgi/') || here.startsWith('/api/');
  const next = isAuthPath(here) || internal ? nextTarget() : here + currentSearch();
  return next && next !== '/' ? `${authPath}?next=${encodeURIComponent(next)}` : authPath;
}

function showSignIn() {
  const here = currentPath();
  if (here === '/signup') return renderAuth('register');
  if (here !== '/signin') setPath(withNext('/signin'), true);
  renderAuth('signin');
}

async function boot() {
  closeMenu();
  // What's new is public: shown whether or not you're signed in.
  if (currentPath().replace(/\/$/, '') === '/changelog') {
    if (!S.user) {
      try {
        const r = await fetch('/api/me');
        if (r.ok) ({ user: S.user, auth: S.auth } = await r.json());
      } catch { /* show it signed out */ }
    }
    return renderChangelog();
  }
  if (!S.user) {
    try {
      const me = await api('/api/me');
      S.user = me.user;
      S.auth = me.auth;
    } catch {
      return; // api() already showed the sign-in screen
    }
  }
  // Coming back from Google: go where you were headed before you left.
  let afterGoogle = null;
  try { afterGoogle = sessionStorage.getItem('farcast:next'); sessionStorage.removeItem('farcast:next'); } catch { /* storage blocked */ }
  if (afterGoogle) {
    if (/^\/(?!\/)/.test(afterGoogle)) setPath(afterGoogle, true);
  }
  if (S.user.needsName) {
    if (currentPath() !== '/welcome') setPath(withNext('/welcome'), true);
    return renderWelcome();
  }
  if (isAuthPath(currentPath())) setPath(nextTarget(), true);
  const path = currentPath();
  const room = path.match(/^\/r\/([A-Za-z0-9]{6})\/?$/);
  const deck = path.match(/^\/decks\/([0-9a-f-]{36}|new)\/?$/);
  if (room) openRoom(room[1].toUpperCase());
  else if (deck) renderDeckEditor(deck[1] === 'new' ? null : deck[1]);
  else if (path.startsWith('/decks')) renderDecks();
  else renderHome();
}

function link(href, label, attrs = {}) {
  return h('a', { href, onclick: (e) => { e.preventDefault(); navigate(href); }, ...attrs }, label);
}

// FAR in bone, CAST in brass. Uppercase comes from CSS, so it still reads as "Farcast".
function wordmark() {
  return [h('span', { class: 'wm-far', 'aria-hidden': 'true' }, 'Far'), h('span', { class: 'wm-cast', 'aria-hidden': 'true' }, 'cast')];
}

function topBar() {
  return h('header', { class: 'top-bar' },
    link('/', wordmark(), { class: 'wordmark small', 'aria-label': 'Farcast home' }),
    h('nav', { class: 'top-nav' },
      link('/', 'Play'),
      link('/decks', 'Your decks'),
      changelogLink(),
      h('span', { class: 'who-am-i', title: 'Your name at the table' }, S.user.username),
      h('button', { class: 'btn small ghost', type: 'button', onclick: signOut }, 'Sign out')));
}

// ---------------------------------------------------------------- what's new

let changelogCache = null;
async function loadChangelog() {
  if (!changelogCache) {
    changelogCache = fetch('/api/changelog').then((r) => r.json()).then((d) => d.entries ?? []).catch(() => {
      changelogCache = null;
      return [];
    });
  }
  return changelogCache;
}

// "What's new" with a dot when there's an entry newer than the last one you looked at.
// A pill beside the wordmark: "What's new · 10.12", glowing when there's something you haven't seen.
function changelogLink() {
  const date = h('span', { class: 'wn-date' });
  const a = link('/changelog', [h('span', { class: 'wn-label' }, "What's new"), date], { class: 'whats-new' });
  loadChangelog().then((entries) => {
    const latest = entries[0]?.date;
    if (!latest) return;
    date.textContent = latest.slice(5); // "10.12"
    if (latest > store.get('changelogSeen', '')) {
      a.classList.add('has-new');
      a.append(h('span', { class: 'new-dot', 'aria-hidden': 'true' }));
      a.setAttribute('aria-label', `What's new: updated ${latest}, not yet seen`);
    } else {
      a.setAttribute('aria-label', `What's new: updated ${latest}`);
    }
  });
  return a;
}

function formatChangelogDate(d) {
  const [y, m, day] = d.split('.').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

async function renderChangelog() {
  leaveSocket();
  const app = $('#app');
  app.className = 'home';
  const list = h('ol', { class: 'changelog' }, h('li', { class: 'hint' }, 'Loading…'));
  app.replaceChildren(
    h('div', { class: 'home-inner' },
      S.user
        ? topBar()
        : h('header', { class: 'top-bar' },
          link('/', wordmark(), { class: 'wordmark small', 'aria-label': 'Farcast' }),
          h('nav', { class: 'top-nav' }, link('/signin', 'Sign in'))),
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, "What's new")),
      h('p', { class: 'hint changelog-intro' }, 'Every change to Farcast, newest first, so everyone at the table knows what changed and when.'),
      list));
  const entries = await loadChangelog();
  if (!entries.length) return list.replaceChildren(h('li', { class: 'hint' }, "Couldn't load the change log. Try again in a moment."));
  const lastSeen = store.get('changelogSeen', '');
  list.replaceChildren(...entries.map((e, i) => {
    const unseen = !lastSeen || e.date > lastSeen;
    return h('li', { class: cls('changelog-entry', i === 0 && 'latest', unseen && 'is-new') },
      h('span', { class: 'tl-node', 'aria-hidden': 'true' }),
      h('div', { class: 'changelog-date' },
        h('time', { datetime: e.date.replaceAll('.', '-') }, e.date),
        h('span', { class: 'changelog-day' }, formatChangelogDate(e.date)),
        i === 0 ? h('span', { class: 'pill latest-pill' }, 'Latest') : '',
        unseen && lastSeen ? h('span', { class: 'pill new' }, 'New for you') : ''),
      h('div', { class: 'changelog-card' },
        h('p', { class: 'changelog-count' }, plural(e.changes.length, 'change')),
        h('ul', { class: 'changelog-changes' }, e.changes.map((c) => h('li', null, c[0].toUpperCase() + c.slice(1))))));
  }));
  store.set('changelogSeen', entries[0].date);
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' });
  leaveSocket();
  // With Cloudflare Access, also end the Access session or it signs you straight back in.
  if (S.auth?.access) return location.assign('/cdn-cgi/access/logout');
  S.user = null;
  setPath('/signin');
  renderAuth('signin');
}


function renderWelcome() {
  const app = $('#app');
  app.className = 'home';
  const status = h('p', { class: 'hint error', role: 'alert' });
  app.replaceChildren(
    h('div', { class: 'home-inner narrow' },
      h('h1', { class: 'wordmark', 'aria-label': 'Farcast' }, wordmark()),
      h('form', {
        class: 'panel',
        onsubmit: async (e) => {
          e.preventDefault();
          status.textContent = '';
          try {
            S.user = { ...(await api('/api/me', { method: 'PATCH', body: { username: e.currentTarget.elements.username.value.trim() } })).user, needsName: false };
            setPath(nextTarget(), true);
            boot();
          } catch (err) {
            if (!(err instanceof SignedOut)) status.textContent = err.message;
          }
        },
      },
      h('h2', null, 'Welcome. What should other players call you?'),
      h('label', { class: 'field-label' }, 'Your name',
        h('input', { name: 'username', value: S.user.username, required: true, minlength: 3, maxlength: 24, autofocus: true, autocomplete: 'nickname' })),
      h('p', { class: 'hint' }, "This shows at the table and in game history. Choose carefully: names can't be changed later."),
      status,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Continue')))));
  app.querySelector('input')?.select();
}

// ---------------------------------------------------------------- sign in

async function renderAuth(mode = 'signin') {
  leaveSocket();
  const app = $('#app');
  app.className = 'home';
  if (!S.auth) S.auth = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({ password: true }));
  const cfg = S.auth;
  const creating = mode === 'register';
  const authError = new URLSearchParams(currentSearch()).get('auth_error');
  const status = h('p', { class: 'hint error', role: 'alert' }, authError ?? '');
  const wanted = creating ? '/signup' : '/signin';
  if (currentPath() !== wanted || authError) setPath(withNext(wanted), true);
  const submit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget.elements;
    status.textContent = '';
    if (creating && f.password.value !== f.confirm.value) return (status.textContent = "Those passwords don't match.");
    const btn = e.currentTarget.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api(creating ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST', body: { username: f.username.value.trim(), password: f.password.value },
      });
      S.user = user;
      boot();
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
    }
  };
  app.replaceChildren(
    h('div', { class: 'home-inner narrow' },
      h('h1', { class: 'wordmark', 'aria-label': 'Farcast' }, wordmark()),
      h('p', { class: 'lede' }, 'Play Magic with friends from your own decklists. Your hand and library stay private.'),
      cfg.access && !cfg.password && !cfg.google
        ? h('div', { class: 'panel' },
          h('h2', null, 'Sign in through Cloudflare Access'),
          h('p', { class: 'hint' }, "This table is private. Reload the page to sign in, or ask the host to add your email to the invite list."),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Sign in')))
        : '',
      cfg.google
        ? h('div', { class: 'panel google-panel' },
          h('button', { class: 'btn google', type: 'button', onclick: startGoogle },
            h('span', { class: 'g-mark', 'aria-hidden': 'true' }, 'G'), 'Sign in with Google'),
          cfg.password ? '' : status)
        : '',
      !cfg.password ? '' : h('form', { class: 'panel', onsubmit: submit },
        h('h2', null, creating ? 'Create an account' : cfg.google ? 'Or use a name and password' : 'Sign in'),
        h('label', { class: 'field-label' }, 'Username',
          h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 3, maxlength: 24, autofocus: true })),
        h('label', { class: 'field-label' }, 'Password',
          h('input', { name: 'password', type: 'password', autocomplete: creating ? 'new-password' : 'current-password', required: true, minlength: creating ? 8 : null })),
        creating
          ? h('label', { class: 'field-label' }, 'Confirm password',
            h('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }))
          : '',
        creating ? h('p', { class: 'hint' }, "Your name is what other players see, and it can't be changed later. Passwords need at least 8 characters.") : '',
        status,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, creating ? 'Create account' : 'Sign in')),
        h('p', { class: 'hint' },
          creating ? 'Already have an account? ' : 'New here? ',
          h('a', {
            href: withNext(creating ? '/signin' : '/signup'),
            onclick: (e) => { e.preventDefault(); setPath(withNext(creating ? '/signin' : '/signup')); renderAuth(creating ? 'signin' : 'register'); },
          }, creating ? 'Sign in' : 'Create an account'))),
      h('p', { class: 'hint auth-footer' }, link('/changelog', "What's new in Farcast"))));
  app.querySelector('[autofocus]')?.focus();
}

// ---------------------------------------------------------------- home

function startGoogle() {
  // Google sends you back to "/", so remember where you were headed (an invite link, say).
  const next = nextTarget();
  try { if (next !== '/') sessionStorage.setItem('farcast:next', next); } catch { /* storage blocked */ }
  location.assign('/api/auth/google/start');
}

// A row of options where exactly one is chosen.
function segmented(label, options, value, onChange) {
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : null,
      onclick: (e) => {
        for (const b of e.currentTarget.parentElement.children) {
          const on = b === e.currentTarget;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        }
        onChange(v);
      },
    }, text)));
}

function renderHome(error) {
  leaveSocket();
  S.state = null;
  S.code = null;
  const app = $('#app');
  app.className = 'home';

  let life = store.get('life', 40);
  const lifeChoice = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Starting life' },
    [40, 30, 20].map((v) =>
      h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(v === life), class: v === life ? 'on' : null,
        onclick: (e) => {
          life = v;
          store.set('life', v);
          for (const b of e.currentTarget.parentElement.children) {
            const on = b === e.currentTarget;
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', String(on));
          }
        },
      }, `${v} life`)));

  let ranked = store.get('ranked', true);
  const rankedHint = h('p', { class: 'hint' });
  const setRankedHint = () => (rankedHint.textContent = ranked ? 'Counts toward your records.' : "Just for fun: won't count toward anyone's records.");
  setRankedHint();
  const rankedChoice = segmented('Ranked or unranked', [[true, 'Ranked'], [false, 'Unranked']], ranked, (v) => {
    ranked = v;
    store.set('ranked', v);
    setRankedHint();
  });

  const code = h('input', {
    class: 'code-input', maxlength: 6, placeholder: 'ABC123', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Room code',
    oninput: (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')),
  });

  const create = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { code: c } = await api('/api/rooms', { method: 'POST', body: { startingLife: life, ranked } });
      navigate(`/r/${c}`);
    } catch (err) {
      if (err instanceof SignedOut) return;
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create game';
    }
  };

  // An unranked room with the practice bot already seated, for trying things alone.
  const practice = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { code: c } = await api('/api/rooms', { method: 'POST', body: { startingLife: life, ranked: false } });
      S.addBotTo = c;
      navigate(`/r/${c}`);
    } catch (err) {
      if (err instanceof SignedOut) return;
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };

  const join = (e) => {
    e.preventDefault();
    const c = code.value.trim();
    if (c.length !== 6) return toast('Room codes are 6 characters.', 'warn');
    navigate(`/r/${c}`);
  };

  const history = h('section', { class: 'history', 'aria-label': 'Your recent games' });

  app.replaceChildren(
    h('div', { class: 'home-inner' },
      topBar(),
      error ? h('p', { class: 'notice error', role: 'alert' }, error) : null,
      h('div', { class: 'home-grid' },
        h('section', { class: 'panel' },
          h('h2', null, 'Start a game'),
          h('div', { class: 'field-label' }, 'Starting life', lifeChoice),
          h('div', { class: 'field-label' }, 'Game type', rankedChoice, rankedHint),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', onclick: create }, 'Create game'),
            h('button', { class: 'btn', type: 'button', onclick: practice, title: 'An unranked game against a simple bot playing a Commander deck' }, 'Practice against a bot'))),
        h('form', { class: 'panel', onsubmit: join },
          h('h2', null, 'Join a game'),
          h('label', { class: 'field-label' }, 'Room code', code),
          h('p', { class: 'hint' }, 'Or open the invite link your friend sent you.'),
          h('button', { class: 'btn', type: 'submit' }, 'Join game'))),
      history));

  loadHistory(history);
}

async function loadHistory(el) {
  try {
    const { games } = await api('/api/games');
    if (!games?.length) return;
    el.append(
      h('h2', null, 'Recent games'),
      h('ol', { class: 'history-list' },
        games.map((g) => {
          const winner = g.players.find((p) => p.winner);
          return h('li', null,
            h('span', { class: 'h-when' }, timeAgo(g.ended_at)),
            h('span', { class: 'h-who' }, g.players.map((p) =>
              h('span', { class: cls('h-player', p.winner && 'won') }, p.name,
                p.deck ? h('small', null, p.deck) : ''))),
            h('span', { class: 'h-result' },
              g.ranked === 0 ? h('span', { class: 'pill' }, 'Unranked') : '',
              g.end_reason === 'abandoned' ? 'Abandoned' : winner ? (winner.you ? 'You won' : `${winner.name} won`) : 'No winner',
              g.turns ? `, turn ${g.turns}` : ''));
        })));
  } catch {
    /* history is optional */
  }
}

// ---------------------------------------------------------------- your decks

async function renderDecks() {
  leaveSocket();
  const app = $('#app');
  app.className = 'home';
  const list = h('div', { class: 'deck-cards' }, h('p', { class: 'hint' }, 'Loading your decks…'));
  app.replaceChildren(
    h('div', { class: 'home-inner' },
      topBar(),
      h('div', { class: 'page-head' },
        h('h1', { class: 'page-title' }, 'Your decks'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('/decks/new') }, 'Create a deck')),
      h('p', { class: 'hint' }, 'Each deck keeps its own win–loss record. Changing the cards in a deck saves it as a new deck with a fresh record; renaming it or switching printings keeps the record.'),
      list));
  try {
    const { decks } = await api('/api/decks');
    S.decks = decks;
    if (!decks.length) {
      return list.replaceChildren(h('div', { class: 'panel empty-decks' },
        h('h2', null, 'No decks yet'),
        h('p', { class: 'hint' }, 'Paste a decklist exported from Moxfield or Archidekt to create your first deck.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('/decks/new') }, 'Create a deck'))));
    }
    list.replaceChildren(...decks.map((d) =>
      h('article', { class: 'panel deck-card' },
        h('div', { class: 'deck-card-main' },
          h('h2', null, d.name),
          h('p', { class: 'hint' }, [d.commanders.join(' & ') || 'No commander', plural(d.card_count, 'card')].join(' · ')),
          d.previous_id ? h('p', { class: 'hint' }, 'Updated version. Earlier versions keep their own records.') : ''),
        h('div', { class: 'deck-record', 'aria-label': `Record ${d.wins} wins, ${d.losses} losses` },
          h('span', { class: 'rec-num' }, recordText(d)), h('span', { class: 'rec-label' }, 'W–L')),
        h('div', { class: 'deck-card-actions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => navigate(`/decks/${d.id}`) }, 'Edit'),
          h('button', {
            class: 'btn small ghost', type: 'button',
            onclick: () => openModal({
              type: 'confirm', title: `Delete ${d.name}?`,
              text: 'It disappears from your deck list. Games already played with it keep their records.',
              confirm: 'Delete deck', danger: true,
              run: async () => {
                try {
                  await api(`/api/decks/${d.id}`, { method: 'DELETE' });
                  renderDecks();
                } catch (err) { if (!(err instanceof SignedOut)) toast(err.message, 'error'); }
              },
            }),
          }, 'Delete')))));
  } catch (err) {
    if (!(err instanceof SignedOut)) list.replaceChildren(h('p', { class: 'notice error' }, err.message));
  }
}

function deckToText(d) {
  const line = (count, def) => `${count} ${def.name}${def.set ? ` (${def.set.toUpperCase()}) ${def.cn ?? ''}`.trimEnd() : ''}`;
  return {
    commander: d.commanders.map((c) => line(1, c)).join('\n'),
    deck: d.main.map((e) => line(e.count, e.def)).join('\n'),
  };
}

async function renderDeckEditor(deckId) {
  leaveSocket();
  const app = $('#app');
  app.className = 'home';
  const returnTo = new URLSearchParams(currentSearch()).get('return');
  const backTo = returnTo && /^[A-Z0-9]{6}$/.test(returnTo) ? `/r/${returnTo}` : '/decks';

  // The text boxes are the source of truth. Cards are checked automatically whenever they change,
  // and the preview on the right shows what will be saved.
  let draft = null; // last checked deck
  let checkedKey = null; // which box contents `draft` belongs to
  let pending = null; // in-flight check
  let seq = 0;
  let timer = null;

  const nameInput = h('input', { class: 'deck-name-input', maxlength: 80, placeholder: 'Deck name', 'aria-label': 'Deck name' });
  const commanderText = h('textarea', {
    class: 'commander-box', rows: 2, spellcheck: 'false',
    placeholder: "1 Atraxa, Praetors' Voice (2X2) 190",
  });
  const text = h('textarea', {
    rows: 14, spellcheck: 'false',
    placeholder: '1 Sol Ring (CMM) 400\n1 Command Tower (CMM) 1031\n1 Arcane Signet\n…',
  });
  const url = h('input', { type: 'url', placeholder: 'https://archidekt.com/decks/…', autocomplete: 'off' });
  const preview = h('div', { class: 'deck-summary', 'aria-live': 'polite' });
  const saveStatus = h('p', { class: 'hint', role: 'status' });
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, deckId ? 'Save changes' : 'Save deck');

  const boxesKey = () => JSON.stringify([url.value.trim(), commanderText.value, text.value]);
  const isEmpty = () => !url.value.trim() && !commanderText.value.trim() && !text.value.trim();

  function check() {
    clearTimeout(timer);
    const key = boxesKey();
    if (isEmpty()) {
      draft = null;
      checkedKey = key;
      pending = null;
      renderPreview();
      return Promise.resolve(null);
    }
    if (key === checkedKey && !pending) return Promise.resolve(draft);
    const mine = ++seq;
    renderPreview('checking');
    const body = url.value.trim() ? { url: url.value.trim() } : { commander: commanderText.value, text: text.value };
    pending = api('/api/decks/resolve', { method: 'POST', body })
      .then((d) => {
        if (mine !== seq) return pending;
        draft = d;
        checkedKey = key;
        if (!nameInput.value.trim()) nameInput.value = d.name !== 'Untitled deck' ? d.name : (d.commanders[0]?.name.split(',')[0] ?? '');
        if (url.value.trim()) {
          // Fill the boxes from the link so they can be edited like a paste.
          const t = deckToText(d);
          commanderText.value = t.commander;
          text.value = t.deck;
          url.value = '';
          checkedKey = boxesKey();
        }
        return d;
      })
      .catch((err) => {
        if (err instanceof SignedOut) throw err;
        if (mine !== seq) return pending;
        draft = { error: err.message };
        checkedKey = key;
        return draft;
      })
      .finally(() => {
        if (mine === seq) {
          pending = null;
          renderPreview();
        }
      });
    return pending;
  }

  const scheduleCheck = () => {
    clearTimeout(timer);
    saveStatus.textContent = '';
    if (boxesKey() !== checkedKey) renderPreview('typing');
    timer = setTimeout(check, 700);
  };
  for (const el of [commanderText, text]) el.addEventListener('input', scheduleCheck);
  url.addEventListener('change', check);
  url.addEventListener('paste', () => setTimeout(check, 0));

  // Starring a card moves it to the Commander box (and back), so the boxes always match the deck.
  const lineName = (line) => line.replace(/^\s*\d+\s*x?\s+/i, '').replace(/\s+#.*$/, '').replace(/(\s+\*[A-Z]+\*)+\s*$/i, '').replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?$/, '').trim().toLowerCase();
  function makeCommander(def) {
    const cmdLines = commanderText.value.split('\n').filter((l) => l.trim());
    if (cmdLines.length >= 2) return toast('A deck can have at most two commanders. Remove one from the Commander box first.', 'warn');
    const deckLines = text.value.split('\n');
    const i = deckLines.findIndex((l) => lineName(l) === def.name.toLowerCase());
    let moved = `1 ${def.name}`;
    if (i >= 0) {
      const count = parseInt(deckLines[i], 10) || 1;
      moved = deckLines[i].replace(/^\s*\d+\s*x?\s+/i, '1 ');
      if (count > 1) deckLines[i] = deckLines[i].replace(/^\s*\d+/, String(count - 1));
      else deckLines.splice(i, 1);
      text.value = deckLines.join('\n');
    }
    commanderText.value = [...cmdLines, moved.trim()].join('\n');
    check();
  }
  function removeCommander(def) {
    const cmdLines = commanderText.value.split('\n');
    const i = cmdLines.findIndex((l) => lineName(l) === def.name.toLowerCase());
    const line = i >= 0 ? cmdLines.splice(i, 1)[0] : `1 ${def.name}`;
    commanderText.value = cmdLines.filter((l) => l.trim()).join('\n');
    text.value = `${line.trim().replace(/^(?!\d)/, '1 ')}\n${text.value}`.trim();
    check();
  }

  function renderPreview(phase) {
    const d = draft;
    if (phase === 'checking' || phase === 'typing' || pending) {
      return preview.replaceChildren(
        h('h2', null, 'Your deck'),
        h('p', { class: 'checking' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking cards…'),
        d && !d.error ? deckBody(d, true) : '');
    }
    if (!d) {
      return preview.replaceChildren(
        h('h2', null, 'Your deck'),
        h('ol', { class: 'steps' },
          h('li', null, 'Paste your commander and the rest of your deck on the left.'),
          h('li', null, 'Your cards appear here to check.'),
          h('li', null, 'Choose ', h('b', null, deckId ? 'Save changes' : 'Save deck'), '.')));
    }
    if (d.error) return preview.replaceChildren(h('h2', null, 'Your deck'), h('p', { class: 'notice error' }, d.error));
    preview.replaceChildren(h('h2', null, 'Your deck'), deckBody(d, false));
  }

  function deckBody(d, dim) {
    const total = d.main.reduce((n, e) => n + e.count, 0) + d.commanders.length;
    const sorted = [...d.main].sort((a, b) => typeRank(a.def) - typeRank(b.def) || a.def.name.localeCompare(b.def.name));
    return h('div', { class: cls('deck-body', dim && 'dim') },
      h('p', { class: 'deck-total' }, plural(total, 'card'), d.commanders.length ? ` including ${d.commanders.length === 1 ? 'your commander' : 'your commanders'}` : ''),
      d.notFound?.length
        ? h('p', { class: 'notice warn' }, `Couldn't find ${plural(d.notFound.length, 'card')}: ${d.notFound.join(', ')}. Check the spelling in the box on the left.`)
        : '',
      d.skipped ? h('p', { class: 'hint' }, `${plural(d.skipped, 'sideboard or maybeboard card')} left out.`) : '',
      h('h3', null, 'Commander'),
      d.commanders.length
        ? h('ul', { class: 'deck-list cmd' }, d.commanders.map((c) =>
          h('li', null, h('button', { class: 'star on', type: 'button', title: 'Move back to the deck', 'aria-label': `Move ${c.name} back to the deck`, onclick: () => removeCommander(c) }, '★'), c.name)))
        : h('p', { class: 'hint' }, 'None yet. Add one in the Commander box, or click ☆ next to a legendary creature below.'),
      h('details', { open: true },
        h('summary', null, `Deck (${plural(total - d.commanders.length, 'card')})`),
        h('ul', { class: 'deck-list' }, sorted.map((e) =>
          h('li', null,
            /Legendary/.test(e.def.typeLine ?? '') && /Creature|Planeswalker/.test(e.def.typeLine ?? '')
              ? h('button', { class: 'star', type: 'button', title: 'Make this your commander', 'aria-label': `Make ${e.def.name} your commander`, onclick: () => makeCommander(e.def) }, '☆')
              : h('span', { class: 'star-spacer' }),
            h('span', { class: 'qty' }, e.count), e.def.name,
            e.def.set ? h('span', { class: 'printing', title: 'Printing used for this card' }, `${e.def.set.toUpperCase()} ${e.def.cn ?? ''}`) : '')))));
  }

  async function save() {
    saveStatus.className = 'hint';
    if (isEmpty()) {
      saveStatus.className = 'hint error';
      saveStatus.textContent = 'Paste your cards first.';
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Checking cards…';
    try {
      const d = await check();
      if (!d || d.error) {
        saveStatus.className = 'hint error';
        saveStatus.textContent = d?.error ?? 'Paste your cards first.';
        return;
      }
      if (d.notFound?.length && !saveBtn.dataset.confirmMissing) {
        saveBtn.dataset.confirmMissing = '1';
        saveStatus.className = 'hint error';
        saveStatus.textContent = `${plural(d.notFound.length, 'card')} couldn't be found. Fix the spelling on the left, or save without ${d.notFound.length === 1 ? 'it' : 'them'}.`;
        saveBtn.dataset.label = `Save without ${d.notFound.length === 1 ? 'it' : 'them'}`;
        return;
      }
      saveBtn.textContent = 'Saving…';
      const body = { name: nameInput.value.trim() || 'Untitled deck', main: d.main, commanders: d.commanders };
      const res = deckId ? await api(`/api/decks/${deckId}`, { method: 'PUT', body }) : await api('/api/decks', { method: 'POST', body });
      toast(res.newVersion ? 'Saved as a new version. It starts with a fresh record.' : 'Deck saved.');
      navigate(backTo);
    } catch (err) {
      if (err instanceof SignedOut) return;
      saveStatus.className = 'hint error';
      saveStatus.textContent = err.message;
    } finally {
      if (saveBtn.isConnected) {
        saveBtn.disabled = false;
        saveBtn.textContent = saveBtn.dataset.label ?? (deckId ? 'Save changes' : 'Save deck');
      }
    }
  }
  saveBtn.addEventListener('click', save);
  // Changing the boxes after a "can't find" warning asks again.
  for (const el of [commanderText, text]) {
    el.addEventListener('input', () => {
      delete saveBtn.dataset.confirmMissing;
      delete saveBtn.dataset.label;
      saveBtn.textContent = deckId ? 'Save changes' : 'Save deck';
    });
  }

  app.replaceChildren(
    h('div', { class: 'home-inner' },
      topBar(),
      h('div', { class: 'page-head' },
        h('h1', { class: 'page-title' }, deckId ? 'Edit deck' : 'Create a deck'),
        link(backTo, returnTo ? 'Back to the game' : 'Back to your decks')),
      deckId ? h('p', { class: 'notice' }, 'Changing the cards or commander saves this as a new deck with a fresh win–loss record. The current version keeps its record. Renaming or changing printings keeps the record.') : '',
      h('div', { class: 'editor-grid' },
        h('form', { class: 'panel', onsubmit: (e) => { e.preventDefault(); save(); } },
          h('label', { class: 'field-label' }, 'Deck name', nameInput),
          h('label', { class: 'field-label' }, 'Commander', commanderText,
            h('span', { class: 'hint' }, 'One per line. Two for partners or a background. Leave empty for decks without a commander.')),
          h('label', { class: 'field-label' }, 'Deck', text,
            h('span', { class: 'hint' }, 'Everything else, one card per line. Paste straight from a Moxfield or Archidekt export; set codes and collector numbers keep your exact printings. If the export also lists your commander, it\'s only counted once.')),
          h('label', { class: 'field-label' }, 'Or paste a deck link', url,
            h('span', { class: 'hint' }, 'Public Archidekt decks fill in the boxes above. Moxfield usually blocks this, so paste its export instead.'))),
        h('section', { class: 'panel editor-side' },
          preview,
          h('div', { class: 'save-bar' }, saveStatus, saveBtn)))));

  renderPreview();
  if (deckId) {
    try {
      const { deck } = await api(`/api/decks/${deckId}`);
      nameInput.value = deck.name;
      const texts = deckToText(deck);
      commanderText.value = texts.commander;
      text.value = texts.deck;
      draft = { name: deck.name, main: deck.main, commanders: deck.commanders, notFound: [], skipped: 0 };
      checkedKey = boxesKey();
      renderPreview();
    } catch (err) {
      if (!(err instanceof SignedOut)) saveStatus.textContent = err.message;
    }
  } else {
    commanderText.focus();
  }
}

// ---------------------------------------------------------------- room connection

async function openRoom(code) {
  if (S.code === code && S.ws) return;
  leaveSocket();
  S.code = code;
  S.state = null;
  S.closedReason = null;
  S.records = null;
  $('#app').className = 'loading';
  $('#app').replaceChildren(h('p', { class: 'center-note' }, `Opening room ${code}…`));
  try {
    const info = await api(`/api/rooms/${code}`).catch((err) => {
      if (err instanceof SignedOut) throw err;
      return { exists: false };
    });
    if (!info.exists) return renderHome(`There's no game with the code ${code}. Check the code, or start a new game.`);
    S.decks = (await api('/api/decks')).decks;
  } catch (err) {
    if (err instanceof SignedOut) return;
    return renderHome('Could not reach the server. Check your connection and try again.');
  }
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${S.code}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    S.connected = true;
    ws.send(JSON.stringify({ t: 'hello' }));
    updateConnectionBanner();
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return; // we replaced it on purpose
    S.connected = false;
    updateConnectionBanner();
    if (e.code === 4000 || e.code === 4001) return; // room closed or refused
    const delay = Math.min(10000, 400 * 2 ** S.retry++);
    setTimeout(() => S.ws === ws && connect(), delay);
  };
}

function leaveSocket() {
  const ws = S.ws;
  S.ws = null;
  S.connected = false;
  if (ws) try { ws.close(1000); } catch { /* ignore */ }
  updateConnectionBanner();
}

setInterval(() => {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send('{"t":"ping"}');
}, 25000);

function onMessage(msg) {
  switch (msg.t) {
    case 'state': {
      const prevStatus = S.state?.status;
      S.state = msg.state;
      S.you = msg.you;
      S.inflightLife = {};
      if (prevStatus && prevStatus !== S.state.status) {
        // A game just ended or restarted: records and deck totals changed.
        S.records = null;
        api('/api/decks').then(({ decks }) => { S.decks = decks; render(); }).catch(() => {});
      }
      if (S.addBotTo === S.code && S.state.status === 'lobby') {
        S.addBotTo = null;
        if (S.state.players.length < S.state.maxPlayers && !S.state.players.some((p) => p.bot)) send({ t: 'addBot' });
      }
      render();
      maybeAutoBegin();
      loadRecords();
      break;
    }
    case 'library':
      S.library = msg;
      if (!S.modal || S.modal.type !== 'library') S.modal = { type: 'library', filter: '' };
      renderModal();
      break;
    case 'revealed':
      if (msg.by !== S.you) showReveal(msg);
      break;
    case 'error':
      toast(msg.message, 'error');
      break;
    case 'rejected':
    case 'closed':
      S.closedReason = msg.message;
      leaveSocket();
      renderHome(S.closedReason);
      break;
  }
}

function updateConnectionBanner() {
  const el = $('#conn');
  if (S.connected || !S.ws) return el?.remove();
  if (!el) document.body.append(h('div', { id: 'conn', class: 'conn', role: 'status' }, 'Connection lost. Reconnecting…'));
}

// Records for the current pairing: my deck vs this opponent, and my deck vs their exact deck.
async function loadRecords() {
  const mine = me();
  const opp = opponents()[0];
  const myDeck = mine?.deck?.id ?? '';
  if (!mine || !opp || opp.bot) return;
  const key = `${myDeck}|${opp.userId}|${opp.deck?.id ?? ''}`;
  if (S.records?.key === key) return;
  S.records = { key, loading: true };
  try {
    const q = new URLSearchParams({ deck: myDeck, opponent: opp.userId, opponentDeck: opp.deck?.id ?? '' });
    const rec = await api(`/api/records?${q}`);
    if (S.records?.key !== key) return;
    S.records = { key, ...rec };
    render();
  } catch {
    if (S.records?.key === key) S.records = null;
  }
}

const pct = (r) => (r.wins + r.losses ? `${Math.round((r.wins / (r.wins + r.losses)) * 100)}%` : '');

// The pre-game matchup panel in the lobby.
function headToHead() {
  const mine = me();
  const opp = opponents()[0];
  if (!opp || opp.bot) return '';
  const r = S.records && !S.records.loading ? S.records : null;
  const side = (p, cls_) => h('div', { class: cls('h2h-side', cls_) },
    h('span', { class: 'h2h-player' }, p.name),
    h('span', { class: 'h2h-deck' }, p.deck ? p.deck.name : 'Choosing a deck…'),
    p.deck?.commanders.length ? h('span', { class: 'h2h-cmd' }, p.deck.commanders.join(' & ')) : '');
  const stat = (label, rec, note, scope) => h('div', { class: 'h2h-stat' },
    h('span', { class: 'h2h-scope' }, scope),
    h('span', { class: 'h2h-label' }, label),
    rec
      ? h('span', { class: 'h2h-score' },
        h('b', { class: 'w' }, rec.wins), h('span', { class: 'dash' }, '–'), h('b', { class: 'l' }, rec.losses),
        h('small', null, rec.wins + rec.losses ? `${pct(rec)} wins` : 'No games yet'))
      : h('span', { class: 'h2h-wait' }, note));
  const deckName = mine.deck?.name;
  return h('section', { class: 'panel h2h', 'aria-label': 'Head to head' },
    h('div', { class: 'h2h-top' }, side(mine, 'mine'), h('span', { class: 'h2h-vs' }, 'vs'), side(opp, 'theirs')),
    h('div', { class: 'h2h-stats' },
      stat(`You against ${opp.name}`, r?.overall, 'Loading…', 'All your decks'),
      stat(deckName ? `${deckName} against ${opp.name}` : `Your deck against ${opp.name}`, mine.deck ? r?.vsPlayer : null,
        mine.deck ? 'Loading…' : 'Choose a deck to see this', 'Any of their decks'),
      stat(deckName && opp.deck ? `${deckName} against ${opp.deck.name}` : 'This exact matchup', mine.deck && opp.deck ? r?.exact : null,
        !mine.deck ? 'Choose a deck to see this' : !opp.deck ? `Waiting for ${opp.name} to choose a deck` : 'Loading…', 'These two decks')),
    S.state.ranked === false
      ? h('p', { class: 'notice unranked-note' }, h('span', { class: 'pill' }, 'Unranked'), ' This game won\'t change these records.')
      : h('p', { class: 'hint' }, 'Records count ranked games with a winner. Editing a deck\'s cards starts a fresh record for that deck.'));
}

function recordsBlock() {
  const r = S.records;
  const mine = me();
  const opp = opponents()[0];
  if (!r || r.loading || !mine || !opp || opp.bot) return '';
  return h('div', { class: 'records', 'aria-label': 'Your records' },
    h('div', { class: 'rec-row' },
      h('span', { class: 'rec-label' }, `You vs ${opp.name}`),
      h('span', { class: 'rec-num' }, recordText(r.overall))),
    !mine.deck || !r.vsPlayer ? '' : h('div', { class: 'rec-row' },
      h('span', { class: 'rec-label' }, `${mine.deck.name} vs ${opp.name}`),
      h('span', { class: 'rec-num' }, recordText(r.vsPlayer))),
    opp.deck && r.exact
      ? h('div', { class: 'rec-row' },
        h('span', { class: 'rec-label' }, `${mine.deck.name} vs ${opp.deck.name}`),
        h('span', { class: 'rec-num' }, recordText(r.exact)))
      : '');
}

// ---------------------------------------------------------------- top-level render

function render() {
  if (!S.state) return;
  if (S.state.status === 'lobby') renderLobby();
  else renderGame();
  renderModal();
}

// ---------------------------------------------------------------- lobby

function renderLobby() {
  const app = $('#app');
  if (!$('#lobby')) {
    app.className = 'lobby-page';
    S.modal = null;
    const inviteLink = `${location.origin}/r/${S.code}`;
    app.replaceChildren(
      h('div', { id: 'lobby', class: 'lobby' },
        h('header', { class: 'lobby-head' },
          link('/', wordmark(), { class: 'wordmark small', 'aria-label': 'Farcast home' }),
          h('div', { class: 'room-code' },
            changelogLink(),
            h('span', { class: 'code-label' }, 'Room'),
            h('span', { class: 'code' }, S.code),
            h('button', {
              class: 'btn small', type: 'button',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(inviteLink);
                  toast('Invite link copied.');
                } catch {
                  toast(inviteLink);
                }
              },
            }, 'Copy invite link'))),
        h('div', { id: 'lobby-h2h' }),
        h('div', { class: 'lobby-grid' },
          h('section', { class: 'panel', 'aria-label': 'Players' }, h('h2', null, 'Players'), h('div', { id: 'seats' }), h('div', { id: 'lobby-actions' })),
          h('section', { class: 'panel deck-panel', 'aria-label': 'Your deck' }, h('div', { id: 'deck-picker' })))));
  }
  renderSeats();
  renderDeckPicker();
  $('#lobby-h2h').replaceChildren(headToHead());
}

function renderSeats() {
  const s = S.state;
  const seats = [];
  for (let i = 0; i < s.maxPlayers; i++) {
    const p = s.players.find((x) => x.seat === i);
    if (!p) {
      seats.push(h('li', { class: 'seat-row empty' }, h('span', { class: 'dot' }), h('span', null, 'Waiting for an opponent. Send them the invite link.'),
        h('button', { class: 'btn small', type: 'button', title: 'An unranked game against a simple bot playing a Commander deck', onclick: () => send({ t: 'addBot' }) }, 'Play the practice bot')));
      continue;
    }
    seats.push(
      h('li', { class: cls('seat-row', isMine(p.id) ? 'mine' : 'theirs', p.bot && 'bot') },
        h('span', { class: cls('dot', p.online && 'online'), title: p.online ? 'Connected' : 'Disconnected' }),
        h('span', { class: 'seat-name' }, p.name, isMine(p.id) ? h('small', null, ' (you)') : ''),
        h('span', { class: 'seat-deck' }, p.deck ? `${p.deck.name}${p.deck.commanders.length ? ` (${p.deck.commanders.join(' & ')})` : ''}` : 'Choosing a deck'),
        h('span', { class: cls('seat-ready', p.ready && 'yes') }, p.ready ? 'Ready' : 'Not ready'),
        p.bot ? h('button', { class: 'btn small', type: 'button', onclick: () => send({ t: 'removeBot' }) }, 'Remove') : ''));
  }
  const bot = s.players.find((p) => p.bot);
  const isRanked = s.ranked !== false;
  $('#seats').replaceChildren(
    h('ul', { class: 'seat-list' }, seats),
    bot ? h('p', { class: 'hint' }, `${bot.name} plays its turns by itself: it plays a land, casts what its lands can pay for, attacks with everything, and passes. It says in chat how much damage it attacks for; change your life to match. Games against it are unranked.`) : '',
    h('div', { class: 'field-label' }, 'Starting life',
      segmented('Starting life', [[40, '40'], [30, '30'], [20, '20']], s.startingLife, (v) => send({ t: 'setStartingLife', life: v }))),
    h('div', { class: 'field-label' }, 'Game type',
      segmented('Ranked or unranked', [[true, 'Ranked'], [false, 'Unranked']], isRanked, (v) => send({ t: 'setRanked', ranked: v })),
      h('span', { class: 'hint' }, isRanked
        ? 'Counts toward records.'
        : "Won't count toward anyone's records."),
      h('span', { class: 'hint' }, 'Either player can change these before the game starts; changing one asks both of you to ready up again.')));

  const mine = me();
  const allReady = s.players.length >= 2 && s.players.every((p) => p.ready && p.deck);
  $('#lobby-actions').replaceChildren(
    h('div', { class: 'row' },
      h('button', {
        class: cls('btn', mine?.ready ? '' : 'primary'), type: 'button', disabled: !mine?.deck,
        onclick: () => send({ t: 'ready', ready: !mine.ready }),
      }, mine?.ready ? 'Not ready' : "I'm ready"),
      h('button', { class: 'btn primary', type: 'button', disabled: !allReady, onclick: () => send({ t: 'start' }) }, 'Start game')),
    !mine?.deck ? h('p', { class: 'hint' }, 'Choose a deck to get ready.') : !allReady ? h('p', { class: 'hint' }, 'The game can start once both players are ready.') : '');
}

function renderDeckPicker() {
  const el = $('#deck-picker');
  const decks = S.decks ?? [];
  const chosen = me()?.deck?.id;
  const newDeck = () => navigate(`/decks/new?return=${S.code}`);
  if (!decks.length) {
    return el.replaceChildren(
      h('h2', null, 'Your deck'),
      h('p', { class: 'hint' }, "You don't have any saved decks yet. Create one from a Moxfield or Archidekt export, then come back to this room."),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: newDeck }, 'Create a deck')));
  }
  el.replaceChildren(
    h('div', { class: 'deck-title-row' }, h('h2', null, 'Choose your deck'), h('button', { class: 'btn small', type: 'button', onclick: newDeck }, 'Create a deck')),
    h('ul', { class: 'deck-choices', role: 'radiogroup', 'aria-label': 'Your decks' },
      decks.map((d) => h('li', null,
        h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(d.id === chosen), class: cls('deck-choice', d.id === chosen && 'on'),
          onclick: () => send({ t: 'selectDeck', deckId: d.id }),
        },
        h('span', { class: 'dc-name' }, d.name),
        h('span', { class: 'dc-meta' }, [d.commanders.join(' & ') || 'No commander', plural(d.card_count, 'card')].join(' · ')),
        h('span', { class: 'dc-rec' }, recordText(d), h('small', null, ' overall')))))));
}

function typeRank(def) {
  const t = def.typeLine ?? '';
  if (/Creature/.test(t)) return 0;
  if (/Planeswalker/.test(t)) return 1;
  if (/Instant|Sorcery/.test(t)) return 2;
  if (/Artifact|Enchantment|Battle/.test(t)) return 3;
  if (/Land/.test(t)) return 5;
  return 4;
}

// ---------------------------------------------------------------- game board

function renderGame() {
  const app = $('#app');
  if (!$('#board')) {
    app.className = 'game-page';
    S.modal = null;
    app.replaceChildren(
      h('div', { id: 'board', class: 'board' },
        h('main', { class: 'table' },
          h('section', { class: 'seat opp', id: 'opp' },
            h('header', { class: 'seat-bar', id: 'opp-bar' }),
            h('div', { class: 'seat-body' },
              h('div', { class: 'piles', id: 'opp-piles' }),
              h('div', { class: 'field', id: 'opp-field' }))),
          h('div', { class: 'midline', id: 'midline' }),
          h('section', { class: 'seat mine', id: 'mine' },
            h('div', { class: 'seat-body' },
              h('div', { class: 'piles', id: 'my-piles' }),
              h('div', {
                class: 'field', id: 'my-field', dataset: { drop: 'battlefield' },
                oncontextmenu: (e) => {
                  if (e.target !== e.currentTarget) return;
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, fieldMenu());
                },
              })),
            h('div', { class: 'hand', id: 'my-hand', dataset: { drop: 'hand' }, 'aria-label': 'Your hand' }),
            h('footer', { class: 'seat-bar', id: 'my-bar' }))),
        h('aside', { class: 'side' },
          h('div', { class: 'preview', id: 'preview' }, h('p', { class: 'hint' }, 'Hover a card to see it up close. Only you see this.')),
          h('div', { class: 'controls', id: 'controls' }),
          h('ol', { class: 'log', id: 'log', 'aria-label': 'Game log' }),
          h('form', {
            class: 'chat',
            onsubmit: (e) => {
              e.preventDefault();
              const input = $('#chat');
              if (input.value.trim()) send({ t: 'chat', text: input.value });
              input.value = '';
            },
          }, h('input', { id: 'chat', placeholder: 'Message', maxlength: 300, autocomplete: 'off', 'aria-label': 'Chat message' })))));
  }

  const mine = me();
  const opp = opponents()[0];
  $('#opp-bar').replaceChildren(...(opp ? seatBar(opp) : []));
  $('#my-bar').replaceChildren(...seatBar(mine));
  $('#opp-piles').replaceChildren(...(opp ? piles(opp) : []));
  $('#my-piles').replaceChildren(...piles(mine));
  renderField($('#opp-field'), opp, false);
  renderField($('#my-field'), mine, true);
  renderHand(mine);
  renderMidline();
  renderControls();
  renderLog();

  const s = S.state;
  if (s.status === 'ended' && S.dismissedEnd !== s.gameId && (!S.modal || S.modal.type !== 'ended')) S.modal = { type: 'ended' };
  const pr = s.status === 'playing' ? s.pendingResult : null;
  if (pr && !isMine(pr.by) && !pr.confirmedBy.includes(S.you) && S.promptedResult !== pr.at && (!S.modal || S.modal.type !== 'confirmResult')) {
    S.promptedResult = pr.at;
    S.modal = { type: 'confirmResult' };
  }
  if (!pr && S.modal?.type === 'confirmResult') S.modal = null;
}

function seatBar(p) {
  const mine = isMine(p.id);
  const s = S.state;
  const active = s.turn?.activeId === p.id;
  const shown = p.life + (S.pendingLife[p.id] ?? 0) + (S.inflightLife[p.id] ?? 0);
  const pending = S.pendingLife[p.id] ?? 0;
  const anyCommanders = s.players.some((x) => x.deck?.commanders.length);
  const others = s.players.filter((x) => x.id !== p.id);

  return [
    h('div', { class: 'who' },
      h('span', { class: cls('dot', p.online && 'online'), title: p.online ? 'Connected' : 'Disconnected' }),
      h('span', { class: 'who-name' }, p.name),
      active ? h('span', { class: 'turn-tag' }, mine ? 'Your turn' : 'Their turn') : null,
      p.conceded ? h('span', { class: 'turn-tag muted' }, 'Conceded') : null),
    // Each player controls only their own life, poison, and commander damage.
    h('div', { class: cls('life', !mine && 'readonly'), 'aria-label': `${p.name}'s life` },
      mine ? h('button', { class: 'life-btn', type: 'button', 'aria-label': 'Lose 1 life (shift: 5)', onclick: (e) => bumpLife(p.id, e.shiftKey ? -5 : -1) }, '−') : '',
      h('output', { class: 'life-total' }, shown,
        pending ? h('span', { class: cls('life-delta', pending > 0 ? 'up' : 'down') }, pending > 0 ? `+${pending}` : `−${-pending}`) : ''),
      mine ? h('button', { class: 'life-btn', type: 'button', 'aria-label': 'Gain 1 life (shift: 5)', onclick: (e) => bumpLife(p.id, e.shiftKey ? 5 : 1) }, '+') : ''),
    h('div', { class: 'trackers' },
      tracker('Poison', p.counters.poison ?? 0, mine ? (d) => send({ t: 'playerCounter', kind: 'poison', delta: d }) : null, (p.counters.poison ?? 0) >= 10),
      anyCommanders
        ? others.map((src) => {
          const dmg = p.commanderDamage[src.id] ?? 0;
          // Only the player taking commander damage tracks it.
          return tracker(`Cmdr dmg from ${src.name}`, dmg, mine ? (d) => send({ t: 'cmdDamage', playerId: p.id, sourceId: src.id, delta: d }) : null, dmg >= 21);
        })
        : null,
      Object.entries(p.counters).filter(([k, v]) => k !== 'poison' && v > 0).map(([k, v]) =>
        tracker(k[0].toUpperCase() + k.slice(1), v, mine ? (d) => send({ t: 'playerCounter', kind: k, delta: d }) : null))),
    h('div', { class: 'counts' },
      mine ? null : h('span', { class: 'hand-count', title: 'Cards in hand' }, h('span', { class: 'mini-back', 'aria-hidden': 'true' }), `${p.handCount} in hand`),
      h('span', null, `${p.libraryCount} in library`)),
  ];
}

function tracker(label, value, change, lethal = false) {
  return h('span', { class: cls('tracker', lethal && 'lethal', value > 0 && 'has', !change && 'readonly') },
    h('span', { class: 'tracker-label' }, label),
    change ? h('button', { type: 'button', 'aria-label': `${label} minus one`, onclick: () => change(-1) }, '−') : '',
    h('span', { class: 'tracker-value' }, value),
    change ? h('button', { type: 'button', 'aria-label': `${label} plus one`, onclick: () => change(1) }, '+') : '');
}

function bumpLife(pid, d) {
  S.pendingLife[pid] = (S.pendingLife[pid] ?? 0) + d;
  clearTimeout(S.lifeTimers[pid]);
  S.lifeTimers[pid] = setTimeout(() => {
    const v = S.pendingLife[pid];
    delete S.pendingLife[pid];
    if (v) {
      S.inflightLife[pid] = (S.inflightLife[pid] ?? 0) + v;
      send({ t: 'life', delta: v });
    }
    renderGame();
  }, 800);
  renderGame();
}

function piles(p) {
  const mine = isMine(p.id);
  const pile = (zone, label, cards, opts = {}) => {
    const top = cards[cards.length - 1];
    const el = h('button', {
      type: 'button',
      class: cls('pile', `pile-${zone}`, !cards.length && 'empty'),
      dataset: mine ? { drop: zone } : {},
      'aria-label': `${label}, ${opts.count ?? cards.length} cards`,
      onclick: opts.onclick ?? (() => cards.length && openModal({ type: 'zone', playerId: p.id, zone })),
      oncontextmenu: opts.menu ? (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, opts.menu()); } : null,
      onmouseenter: top && !opts.back ? () => showPreview(top, mine) : null,
    },
    opts.back
      ? (opts.count ? h('span', { class: 'card-back' }) : null)
      : top ? cardFace(top) : null,
    h('span', { class: 'pile-label' }, label, h('b', null, opts.count ?? cards.length)));
    return el;
  };
  const libPile = pile('library', 'Library', [], {
    back: true, count: p.libraryCount,
    onclick: mine ? () => send({ t: 'draw', n: 1 }) : () => {},
    menu: mine ? libraryMenu : null,
  });
  if (mine) libPile.title = 'Click to draw. Use ⋯ to search, look at the top, or shuffle.';
  return [
    mine
      ? h('div', { class: 'pile-wrap' }, libPile,
        h('button', {
          class: 'pile-more', type: 'button', 'aria-label': 'Library options: search, look at the top, shuffle',
          onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.right + 4, r.top, libraryMenu()); },
        }, '⋯'))
      : libPile,
    pile('graveyard', 'Graveyard', p.graveyard),
    pile('exile', 'Exile', p.exile),
    pile('command', 'Command', p.command),
  ];
}

const COLOR_RGB = { W: '232,224,196', U: '63,111,176', B: '96,78,118', R: '181,82,59', G: '63,138,79', C: '150,150,150' };

function matTint(colors = '') {
  const cs = [...new Set(colors.split('').filter((c) => COLOR_RGB[c]))];
  if (!cs.length) return 'none';
  if (cs.length === 1) cs.push(cs[0]);
  const stops = cs.map((c, i) => `rgba(${COLOR_RGB[c]}, 0.42) ${Math.round((i / (cs.length - 1)) * 100)}%`);
  return `linear-gradient(115deg, ${stops.join(', ')})`;
}

function applyMat(el, p) {
  const mat = p?.deck?.mat;
  el.style.setProperty('--mat-art', mat?.art ? `url("${mat.art}")` : 'none');
  el.style.setProperty('--mat-tint', matTint(mat?.colors));
  el.classList.toggle('has-mat', !!mat);
}

function renderField(el, p, mine) {
  applyMat(el, p);
  if (!p) return el.replaceChildren(h('p', { class: 'center-note' }, 'Waiting for opponent'));
  el.replaceChildren(...p.battlefield.map((c) => {
    const card = cardEl(c, { mine, zone: 'battlefield', owner: p.id });
    const top = mine ? c.y : 1 - c.y;
    card.style.left = `calc((100% - var(--cw)) * ${c.x})`;
    card.style.top = `calc((100% - var(--ch)) * ${top})`;
    return card;
  }));
  el.classList.toggle('empty-field', !p.battlefield.length);
}

function renderHand(p) {
  const el = $('#my-hand');
  const cards = p.hand ?? [];
  el.style.setProperty('--n', cards.length);
  el.replaceChildren(...(cards.length ? cards.map((c) => cardEl(c, { mine: true, zone: 'hand', owner: p.id })) : [h('p', { class: 'hand-empty' }, 'Your hand is empty')]));
  el.classList.toggle('magnify', canMagnify());
  if (handPointer.active) magnifyHand(handPointer.x); // keep the effect through re-renders
}

// ---------------------------------------------------------------- hand magnification (like the Mac Dock)
// The card nearest the pointer grows and rises fully into view; its neighbours grow a little less,
// in a smooth wave. Off for touch screens and when the system asks for reduced motion.

const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches; // a mouse or trackpad
const handPointer = { active: false, x: 0 };
const MAGNIFY = { scale: 1.75, spread: 1.15 }; // biggest scale; how many card-widths the wave reaches
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const canMagnify = () => canHover && !reduceMotion.matches;

function magnifyHand(x) {
  const hand = $('#my-hand');
  if (!hand || !canMagnify() || document.querySelector('.drag-ghost')) return;
  const box = hand.getBoundingClientRect();
  for (const card of hand.querySelectorAll('.card')) {
    // offsetLeft ignores transforms, so the wave is measured from each card's resting place.
    const centre = box.left + card.offsetLeft + card.offsetWidth / 2;
    const d = (x - centre) / card.offsetWidth;
    const pull = Math.exp(-(d * d) / (2 * MAGNIFY.spread * MAGNIFY.spread)); // 1 at the pointer, fading out
    const scale = 1 + (MAGNIFY.scale - 1) * pull;
    const lift = (card.offsetHeight * 0.42 + 6) * pull; // enough to clear the bar below the hand
    card.style.transform = pull < 0.02 ? '' : `translateY(${-lift}px) scale(${scale})`;
    card.style.zIndex = pull < 0.02 ? '' : String(10 + Math.round(pull * 100));
  }
}

function resetHand() {
  for (const card of document.querySelectorAll('#my-hand .card')) {
    card.style.transform = '';
    card.style.zIndex = '';
  }
}

// Track the pointer over the hand strip and a little above it, where the magnified cards reach.
window.addEventListener('pointermove', (e) => {
  const hand = $('#my-hand');
  if (!hand || !canMagnify() || e.pointerType === 'touch') return;
  const box = hand.getBoundingClientRect();
  const reach = box.height * 1.6;
  const inside = e.clientY >= box.top - reach && e.clientY <= box.bottom + 4 && e.clientX >= box.left && e.clientX <= box.right;
  if (inside) {
    handPointer.active = true;
    handPointer.x = e.clientX;
    magnifyHand(e.clientX);
  } else if (handPointer.active) {
    handPointer.active = false;
    resetHand();
  }
}, { passive: true });

// "that you won", "that they won", "that Sam won", "no winner"
function resultPhrase(pr) {
  const w = playerById(pr.winnerId);
  if (!w) return 'no winner';
  if (isMine(w.id)) return 'that you won';
  return w.id === pr.by ? 'that they won' : `that ${w.name} won`;
}

function renderMidline() {
  const s = S.state;
  const pr = s.status === 'playing' ? s.pendingResult : null;
  if (pr) {
    const mineClaim = isMine(pr.by);
    const by = playerById(pr.by);
    const waitingOn = s.players.filter((p) => p.id !== pr.by && !p.conceded && !pr.confirmedBy.includes(p.id)).map((p) => p.name).join(' and ');
    return $('#midline').replaceChildren(
      h('div', { class: 'midline-result', role: 'status' },
        mineClaim
          ? [h('span', null, `You reported ${resultPhrase(pr)}. Waiting for ${waitingOn} to confirm.`),
            h('button', { class: 'btn tiny', type: 'button', onclick: () => send({ t: 'rejectResult' }) }, 'Withdraw')]
          : [h('span', null, `${by?.name} reported ${resultPhrase(pr)}.`),
            h('button', { class: 'btn tiny primary', type: 'button', onclick: () => send({ t: 'confirmResult' }) }, 'Confirm'),
            h('button', { class: 'btn tiny', type: 'button', onclick: () => send({ t: 'rejectResult' }) }, 'Keep playing')]));
  }
  renderTurnLine();
}

function renderTurnLine() {
  const s = S.state;
  const active = playerById(s.turn?.activeId);
  const needsBegin = s.status === 'playing' && isMine(active?.id) && !s.turn.begun;
  $('#midline').replaceChildren(
    needsBegin
      ? h('button', { class: 'midline-cta', type: 'button', onclick: () => send({ t: 'beginTurn' }) },
        `Turn ${s.turn.number}: your turn. Untap, upkeep, draw`, h('kbd', null, 'N'))
      : h('span', { class: 'midline-text' }, s.status === 'ended' ? 'Game over' : active ? `Turn ${s.turn.number}, ${isMine(active.id) ? 'you' : active.name}` : '',
        s.ranked === false ? h('span', { class: 'pill' }, 'Unranked') : ''));
}

function renderControls() {
  const s = S.state;
  const myTurn = s.turn?.activeId === S.you;
  const playing = s.status === 'playing';
  const needsBegin = playing && myTurn && !s.turn.begun;
  $('#controls').replaceChildren(
    h('div', { class: 'row wrap' },
      needsBegin
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => send({ t: 'beginTurn' }), title: 'Shortcut: N' }, 'Untap, upkeep, draw')
        : h('button', { class: cls('btn', myTurn && playing && 'primary'), type: 'button', disabled: !playing || !myTurn, onclick: () => send({ t: 'passTurn' }), title: 'Shortcut: N' }, 'Pass turn'),
      h('button', { class: 'btn', type: 'button', disabled: !playing, onclick: () => send({ t: 'draw', n: 1 }), title: 'Shortcut: D' }, 'Draw'),
      h('button', { class: 'btn', type: 'button', disabled: !playing, onclick: () => send({ t: 'untapAll' }), title: 'Shortcut: U' }, 'Untap all')),
    h('div', { class: 'control-group' },
      h('span', { class: 'control-label' }, 'Library'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: () => send({ t: 'viewLibrary' }), title: 'Shortcut: F' }, 'Search'),
        h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: lookAtTopCard, title: 'Shortcut: T' }, 'Top card'),
        h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: lookAtTop }, 'Look at top…'),
        h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: () => openModal({ type: 'shuffle' }), title: 'Shortcut: S' }, 'Shuffle'),
        h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, libraryMenu()); } }, 'More…'))),
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: store.get('autoBegin', false) || null,
        onchange: (e) => { store.set('autoBegin', e.target.checked); if (e.target.checked) maybeAutoBegin(); },
      }),
      'Untap, upkeep, and draw automatically when my turn starts'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: tokenPrompt }, 'Create token'),
      h('button', { class: 'btn small', type: 'button', disabled: !playing, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, diceMenu()); } }, 'Roll'),
      h('button', { class: 'btn small ghost', type: 'button', disabled: !playing, onclick: () => openModal({ type: 'end' }) }, 'End game'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openModal({ type: 'view' }), title: 'Card and preview sizes' }, 'View…'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => navigate('/') }, 'Leave')));
}

// Cards an opponent revealed: shown in a panel over the table that doesn't block play.
function showReveal(msg) {
  let root = $('#reveal-root');
  if (!root) document.body.append((root = h('div', { id: 'reveal-root', 'aria-live': 'polite' })));
  const what = msg.whole ? 'revealed their hand' : `revealed ${plural(msg.cards.length, 'card')}${msg.from === 'library' ? ' from their library' : msg.from === 'hand' ? ' from their hand' : ''}`;
  const panel = h('section', { class: 'reveal-panel', role: 'dialog', 'aria-label': `${msg.name} ${what}` },
    h('header', { class: 'reveal-head' },
      h('span', null, h('b', null, msg.name), ` ${what}`),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => panel.remove() }, '×')),
    h('div', { class: 'reveal-cards' }, msg.cards.map((c) =>
      h('div', { class: 'reveal-card', onmouseenter: () => showPreview({ ...c, faceDown: false, counters: {} }, true) }, cardFace({ ...c, faceDown: false }, 'normal')))));
  root.replaceChildren(panel);
}

// ---------------------------------------------------------------- view settings (this browser only)

const VIEW_SCALES = {
  table: { S: 0.85, M: 1, L: 1.2 },
  hand: { S: 1, M: 1.2, L: 1.45 },
};

function applyView() {
  const v = { table: 'M', hand: 'M', preview: 'M', ...store.get('view', {}) };
  const root = document.documentElement;
  root.style.setProperty('--table-scale', VIEW_SCALES.table[v.table] ?? 1);
  root.style.setProperty('--hand-scale', VIEW_SCALES.hand[v.hand] ?? 1.2);
  document.body.classList.remove('preview-S', 'preview-M', 'preview-L');
  document.body.classList.add(`preview-${v.preview}`);
  return v;
}

function viewSettings() {
  const v = applyView();
  const set = (key) => (val) => {
    store.set('view', { ...store.get('view', {}), [key]: val });
    applyView();
    if (S.state?.status && S.state.status !== 'lobby') renderGame(); // re-measure the table
  };
  const row = (label, key) => h('div', { class: 'view-row' },
    h('span', null, label),
    segmented(`${label} size`, [['S', 'S'], ['M', 'M'], ['L', 'L']], v[key], set(key)));
  return h('div', { class: 'view-settings' },
    row('Table cards', 'table'),
    row('Hand cards', 'hand'),
    row('Card preview', 'preview'),
    h('p', { class: 'hint' }, 'These only change your screen, and are remembered in this browser. Larger table cards fit fewer rows on the playmat; a larger preview leaves less room for the game log.'));
}

function maybeAutoBegin() {
  const s = S.state;
  if (!store.get('autoBegin', false) || s?.status !== 'playing') return;
  if (s.turn?.activeId === S.you && !s.turn.begun && S.autoBegunTurn !== `${s.gameId}:${s.turn.number}`) {
    S.autoBegunTurn = `${s.gameId}:${s.turn.number}`;
    send({ t: 'beginTurn' });
  }
}

function nextStep() {
  const s = S.state;
  if (s?.status !== 'playing' || s.turn?.activeId !== S.you) return;
  send({ t: s.turn.begun ? 'passTurn' : 'beginTurn' });
}

function renderLog() {
  const el = $('#log');
  if (!el.dataset.watch) {
    el.dataset.watch = '1';
    el.addEventListener('scroll', () => {
      el.dataset.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40 ? '1' : '';
    });
  }
  const nearBottom = el.dataset.pinned !== '';
  el.replaceChildren(...S.state.log.map((entry) => {
    const who = playerById(entry.by);
    const tone = who ? (isMine(who.id) ? 'me' : 'them') : null;
    if (entry.kind === 'chat') {
      return h('li', { class: 'log-chat' }, h('b', { class: tone }, who?.name ?? 'Someone'), ' ', entry.text);
    }
    return h('li', { class: cls(entry.kind === 'system' && 'log-system') }, who ? h('b', { class: tone }, who.name, ' ') : null, entry.text);
  }));
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- cards

function displayName(c) {
  return c.transformed && c.def.backName ? c.def.backName : c.def.name;
}

function cardFace(c, size = 'small') {
  if (c.faceDown) return h('span', { class: 'card-back' });
  const src = c.transformed
    ? (size === 'small' ? c.def.backImageSmall : c.def.backImage) ?? c.def.backImage
    : (size === 'small' ? c.def.imageSmall : c.def.image) ?? c.def.image;
  if (src) return h('img', { src, alt: displayName(c), draggable: 'false', loading: 'lazy' });
  return h('span', { class: 'text-face' },
    h('span', { class: 'tf-name' }, displayName(c)),
    c.def.typeLine ? h('span', { class: 'tf-type' }, c.def.typeLine) : null,
    (c.pt ?? c.def.pt) ? h('span', { class: cls('tf-pt', c.pt && 'changed') }, c.pt ?? c.def.pt) : null);
}

function counterLabel(kind, n) {
  if (kind === '+1/+1') return `+${n}/+${n}`;
  if (kind === '-1/-1') return `−${n}/−${n}`;
  return `${kind} ${n}`;
}

function cardEl(c, ctx) {
  const el = h('div', {
    class: cls('card', c.tapped && 'tapped', c.token && 'is-token', c.faceDown && 'face-down', ctx.mine && 'own'),
    dataset: { id: c.id },
    tabindex: ctx.mine ? 0 : null,
    role: ctx.mine ? 'button' : null,
    'aria-label': c.faceDown && !ctx.mine ? 'Face-down card' : `${displayName(c)}${c.tapped ? ', tapped' : ''}`,
  },
  cardFace(c),
  c.faceDown && ctx.mine ? h('span', { class: 'peek-tag' }, 'Face down') : null,
  c.token ? h('span', { class: 'token-tag' }, 'Token') : null,
  c.noUntap ? h('span', { class: 'nountap-tag', title: "Doesn't untap during untap" }, 'No untap') : null,
  c.pt && !c.faceDown && (c.transformed ? c.def.backImageSmall ?? c.def.backImage : c.def.imageSmall ?? c.def.image)
    ? h('span', { class: 'pt-badge', title: c.def.pt ? `Printed ${c.def.pt}` : 'Power/toughness' }, c.pt)
    : null,
  Object.keys(c.counters).length
    ? h('span', { class: 'counters' }, Object.entries(c.counters).map(([kind, n]) =>
      h('button', {
        type: 'button',
        class: cls('counter', kind === '+1/+1' && 'plus', kind === '-1/-1' && 'minus', n >= 100 && 'big'),
        disabled: !ctx.mine,
        title: ctx.mine ? 'Click to add one, right-click or shift-click to remove one' : null,
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); send({ t: 'counter', cardId: c.id, kind, delta: e.shiftKey ? -1 : 1 }); },
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); send({ t: 'counter', cardId: c.id, kind, delta: -1 }); },
      }, counterLabel(kind, n))))
    : null);

  // Purely local: nothing about what you hover is sent to the server.
  el.addEventListener('mouseenter', () => showPreview(c, ctx.mine));
  el.addEventListener('focus', () => showPreview(c, ctx.mine));

  if (ctx.mine) {
    makeDraggable(el, c, ctx.zone);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, cardMenu(c, ctx.zone));
    });
    el.addEventListener('dblclick', () => {
      if (ctx.zone === 'hand') send({ t: 'move', cardId: c.id, to: 'battlefield' });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (ctx.zone === 'battlefield') tap(c);
        else if (ctx.zone === 'hand') send({ t: 'move', cardId: c.id, to: 'battlefield' });
      }
    });
  }
  return el;
}

function tap(c) {
  c.tapped = !c.tapped; // optimistic
  renderField($('#my-field'), me(), true);
  send({ t: 'tap', cardId: c.id, tapped: c.tapped });
}

// ---------------------------------------------------------------- card preview (sidebar, local only)

function showPreview(c, mine) {
  const el = $('#preview');
  if (!el) return;
  const hidden = c.faceDown && !mine;
  const face = hidden ? h('span', { class: 'card-back big' }) : cardFace({ ...c, faceDown: false }, 'normal');
  el.replaceChildren(
    h('div', { class: 'preview-card' }, face),
    hidden ? h('p', { class: 'hint' }, 'Face-down card') : h('p', { class: 'preview-meta' },
      h('b', null, displayName(c)),
      c.def.backName ? h('span', { class: 'hint' }, c.transformed ? ` Front: ${c.def.name}` : ` Back: ${c.def.backName}`) : '',
      c.pt ? h('span', { class: 'preview-pt' }, ` Now ${c.pt}${c.def.pt && c.def.pt !== c.pt ? ` (printed ${c.def.pt})` : ''}`) : ''));
}


// ---------------------------------------------------------------- drag and drop

function makeDraggable(el, card, zone) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.counter')) return;
    const start = { x: e.clientX, y: e.clientY };
    const rect = el.getBoundingClientRect();
    const off = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let ghost = null;
    let target = null;
    let menuOpened = false;
    const longPress = e.pointerType === 'mouse' ? null : setTimeout(() => {
      menuOpened = true;
      cleanup();
      openMenu(start.x, start.y, cardMenu(card, zone));
    }, 500);

    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
        clearTimeout(longPress);
        ghost = el.cloneNode(true);
        ghost.style.transform = '';
        ghost.style.zIndex = '';
        resetHand();
        ghost.classList.add('drag-ghost');
        ghost.style.width = `${el.offsetWidth}px`;
        ghost.style.height = `${el.offsetHeight}px`;
        document.body.append(ghost);
        el.classList.add('drag-source');
        closeMenu();
      }
      if (!ghost) return;
      ghost.style.left = `${ev.clientX - off.x}px`;
      ghost.style.top = `${ev.clientY - off.y}px`;
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]') ?? null;
      if (t !== target) {
        target?.classList.remove('drop-hover');
        target = t;
        target?.classList.add('drop-hover');
      }
    };
    const up = (ev) => {
      cleanup();
      if (menuOpened) return;
      if (!ghost) {
        if (ev.type === 'pointerup' && zone === 'battlefield') tap(card);
        return;
      }
      ghost.remove();
      el.classList.remove('drag-source');
      target?.classList.remove('drop-hover');
      if (target) drop(card, zone, target, ev, off);
    };
    const cleanup = () => {
      clearTimeout(longPress);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function drop(card, fromZone, target, ev, off) {
  const to = target.dataset.drop;
  if (to === 'battlefield') {
    const r = target.getBoundingClientRect();
    const { w, h: ch } = cardSize();
    const x = clamp01((ev.clientX - off.x - r.left) / Math.max(1, r.width - w));
    const y = clamp01((ev.clientY - off.y - r.top) / Math.max(1, r.height - ch));
    if (fromZone === 'battlefield') {
      card.x = x; // optimistic
      card.y = y;
      const mine = me();
      mine.battlefield = [...mine.battlefield.filter((c) => c.id !== card.id), card];
      renderField($('#my-field'), mine, true);
      send({ t: 'position', cardId: card.id, x, y });
    } else {
      send({ t: 'move', cardId: card.id, to: 'battlefield', x, y, faceDown: ev.altKey || undefined });
    }
    return;
  }
  if (to === fromZone && to !== 'library') return;
  send({ t: 'move', cardId: card.id, to, pos: 'top' });
}

// ---------------------------------------------------------------- menus

function openMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((it) =>
      it === '-'
        ? h('hr')
        : h('button', {
          type: 'button', role: 'menuitem', class: cls(it.danger && 'danger'),
          onclick: () => { closeMenu(); it.run(); },
        }, it.label, it.hint ? h('kbd', null, it.hint) : null)));
  $('#menu-root').append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector('button')?.focus();
  setTimeout(() => {
    window.addEventListener('pointerdown', outside, true);
  });
  function outside(e) {
    if (!menu.contains(e.target)) closeMenu();
  }
  menu._cleanup = () => window.removeEventListener('pointerdown', outside, true);
}

function closeMenu() {
  const m = $('#menu-root .menu');
  if (m) {
    m._cleanup?.();
    m.remove();
  }
}

const mv = (c, to, extra = {}) => () => send({ t: 'move', cardId: c.id, to, ...extra });

// "Put it into your library third from the top", etc.
function libraryPositionPrompt(c, after) {
  const size = me()?.libraryCount ?? 0;
  prompt(`Put ${c.faceDown ? 'this card' : displayName(c)} into your library`, [
    { name: 'depth', label: 'Position', type: 'number', value: 2, min: 1, max: Math.max(1, size + 1) },
    { name: 'pos', label: 'Counting from', value: 'top', options: [['top', 'the top'], ['bottom', 'the bottom']] },
  ], 'Put it there', (v) => {
    const depth = Math.max(1, parseInt(v.depth, 10) || 1);
    send({ t: 'move', cardId: c.id, to: 'library', pos: v.pos === 'bottom' ? 'bottom' : 'top', depth });
    after?.(v.pos, depth);
  });
}

function cardMenu(c, zone) {
  if (zone === 'hand') {
    return [
      { label: 'Reveal to opponent', run: () => { send({ t: 'reveal', cardIds: [c.id] }); toast(`Revealed ${c.def.name} to your opponent.`); } },
      { label: 'Play', hint: 'Double-click', run: mv(c, 'battlefield') },
      { label: 'Play face down', run: mv(c, 'battlefield', { faceDown: true }) },
      '-',
      { label: 'Discard', run: mv(c, 'graveyard') },
      { label: 'Exile', run: mv(c, 'exile') },
      { label: 'Put on top of library', run: mv(c, 'library', { pos: 'top' }) },
      { label: 'Put on bottom of library', run: mv(c, 'library', { pos: 'bottom' }) },
      { label: 'Put into library at position…', run: () => libraryPositionPrompt(c) },
      { label: 'Move to command zone', run: mv(c, 'command') },
    ];
  }
  const hasCounters = Object.keys(c.counters).length > 0;
  return [
    { label: c.tapped ? 'Untap' : 'Tap', hint: 'Click', run: () => tap(c) },
    c.def.backName ? { label: 'Transform', run: () => send({ t: 'transform', cardId: c.id }) } : null,
    { label: c.faceDown ? 'Turn face up' : 'Turn face down', run: () => send({ t: 'flip', cardId: c.id }) },
    { label: c.noUntap ? 'Untaps normally again' : "Doesn't untap during untap", run: () => send({ t: 'noUntap', cardId: c.id }) },
    '-',
    { label: 'Add +1/+1 counter', run: () => send({ t: 'counter', cardId: c.id, kind: '+1/+1', delta: 1 }) },
    { label: 'Add −1/−1 counter', run: () => send({ t: 'counter', cardId: c.id, kind: '-1/-1', delta: 1 }) },
    { label: 'Add other counter…', run: () => counterPrompt(c) },
    hasCounters ? { label: 'Remove all counters', run: () => send({ t: 'clearCounters', cardId: c.id }) } : null,
    '-',
    c.token ? { label: 'Edit token…', run: () => editTokenPrompt(c) } : null,
    { label: 'Set power/toughness…', run: () => setPtPrompt(c) },
    { label: 'Create token copy', run: () => send({ t: 'copy', cardId: c.id }) },
    '-',
    ...(c.token
      ? [{ label: 'Remove token', danger: true, run: mv(c, 'graveyard') }]
      : [
        { label: 'Return to hand', run: mv(c, 'hand') },
        { label: 'Put into graveyard', run: mv(c, 'graveyard') },
        { label: 'Exile', run: mv(c, 'exile') },
        { label: 'Put on top of library', run: mv(c, 'library', { pos: 'top' }) },
        { label: 'Put on bottom of library', run: mv(c, 'library', { pos: 'bottom' }) },
        { label: 'Put into library at position…', run: () => libraryPositionPrompt(c) },
        { label: 'Move to command zone', run: mv(c, 'command') },
      ]),
  ];
}

function libraryMenu() {
  return [
    { label: 'Draw a card', hint: 'D', run: () => send({ t: 'draw', n: 1 }) },
    { label: 'Draw several…', run: () => numberPrompt('Draw cards', 'How many?', 2, (n) => send({ t: 'draw', n })) },
    '-',
    { label: 'Search library', hint: 'F', run: () => send({ t: 'viewLibrary' }) },
    { label: 'Look at the top card', hint: 'T', run: lookAtTopCard },
    { label: 'Look at the top cards…', run: lookAtTop },
    { label: 'Mill…', run: () => numberPrompt('Mill cards', 'How many?', 1, (n) => send({ t: 'mill', n })) },
    '-',
    { label: 'Shuffle…', hint: 'S', run: () => openModal({ type: 'shuffle' }) },
    { label: 'Mulligan (shuffle hand in, draw 7)', run: () => send({ t: 'mulligan' }) },
    '-',
    {
      label: 'Reveal your hand…',
      run: () => openModal({
        type: 'confirm', title: 'Reveal your whole hand?', text: 'Your opponent will see every card in your hand, and the log will list them.',
        confirm: 'Reveal hand',
        run: () => {
          const hand = me()?.hand ?? [];
          if (!hand.length) return toast('Your hand is empty.', 'warn');
          send({ t: 'reveal', cardIds: hand.map((c) => c.id), whole: 'hand' });
          toast('Revealed your hand to your opponent.');
        },
      }),
    },
  ];
}

function lookAtTopCard() {
  S.modal = null;
  send({ t: 'viewLibrary', n: 1 });
}

function lookAtTop() {
  numberPrompt('Look at the top of your library', 'How many cards?', 3, (n) => { S.modal = null; send({ t: 'viewLibrary', n }); });
}

function fieldMenu() {
  return [
    { label: 'Create token…', run: tokenPrompt },
    { label: 'Untap all', hint: 'U', run: () => send({ t: 'untapAll' }) },
    '-',
    ...diceMenu(),
  ];
}

function diceMenu() {
  return [
    { label: 'Roll a d20', run: () => send({ t: 'roll', sides: 20 }) },
    { label: 'Roll a d6', run: () => send({ t: 'roll', sides: 6 }) },
    { label: 'Flip a coin', run: () => send({ t: 'roll', sides: 2 }) },
  ];
}

// ---------------------------------------------------------------- modals

function openModal(m) {
  S.modal = m;
  renderModal();
}

function closeModal() {
  if (S.modal?.type === 'ended') S.dismissedEnd = S.state?.gameId;
  S.modal = null;
  S.library = null;
  renderModal();
}

function prompt(title, fields, submitLabel, onSubmit) {
  openModal({ type: 'prompt', title, fields, submitLabel, onSubmit });
}

function numberPrompt(title, label, value, run) {
  prompt(title, [{ name: 'n', label, type: 'number', value, min: 1, max: 50 }], 'OK', (v) => run(Math.max(1, parseInt(v.n, 10) || 1)));
}

function counterPrompt(c) {
  prompt(`Add a counter to ${displayName(c)}`, [
    { name: 'kind', label: 'Counter', value: 'charge', list: ['charge', 'loyalty', 'lore', 'shield', 'stun', 'time', 'oil', 'quest'] },
    { name: 'n', label: 'How many', type: 'number', value: 1, min: 1, max: 999 },
  ], 'Add counters', (v) => send({ t: 'counter', cardId: c.id, kind: v.kind.trim(), delta: parseInt(v.n, 10) || 1 }));
}

function editTokenPrompt(c) {
  const type = (c.def.typeLine ?? '').replace(/^Token\s*/, '') || 'Creature';
  const current = c.counters ?? {};
  const kinds = ['+1/+1', '-1/-1', ...Object.keys(current).filter((k) => k !== '+1/+1' && k !== '-1/-1')];
  const label = (k) => (k === '+1/+1' ? '+1/+1 counters' : k === '-1/-1' ? '−1/−1 counters' : `${k[0].toUpperCase()}${k.slice(1)} counters`);
  prompt(`Edit ${c.def.name}`, [
    { name: 'name', label: 'Name', value: c.def.name },
    { name: 'pt', label: 'Power/toughness', value: c.pt ?? c.def.pt ?? '', placeholder: 'Leave empty for non-creatures' },
    { name: 'typeLine', label: 'Type', value: type, list: ['Creature', 'Artifact', 'Artifact Creature', 'Enchantment', 'Enchantment Creature', 'Treasure', 'Food', 'Clue'] },
    ...kinds.map((k) => ({ name: `ctr:${k}`, label: label(k), type: 'number', value: current[k] ?? 0, min: 0, max: 999, group: 'counters' })),
    { name: 'newKind', label: 'Add another counter', value: '', placeholder: 'e.g. charge, shield, oil', list: ['charge', 'loyalty', 'lore', 'shield', 'stun', 'time', 'oil', 'quest', 'flying', 'deathtouch'], group: 'counters' },
    { name: 'newCount', label: 'How many', type: 'number', value: 1, min: 1, max: 999, group: 'counters' },
  ], 'Save token', (v) => {
    const counters = {};
    for (const [key, val] of Object.entries(v)) if (key.startsWith('ctr:')) counters[key.slice(4)] = parseInt(val, 10) || 0;
    const extra = String(v.newKind ?? '').trim();
    if (extra) counters[extra] = (counters[extra] ?? 0) + (parseInt(v.newCount, 10) || 1);
    send({ t: 'editToken', cardId: c.id, name: v.name, pt: v.pt, typeLine: v.typeLine, counters });
  });
}

function setPtPrompt(c) {
  const printed = c.def.pt ? ` Printed: ${c.def.pt}.` : '';
  prompt(`Power/toughness of ${c.faceDown ? 'this face-down card' : displayName(c)}`, [
    { name: 'pt', label: `Power/toughness${printed}`, value: c.pt ?? c.def.pt ?? '', placeholder: 'e.g. 5/5. Leave empty to go back to the printed value' },
  ], 'Set', (v) => send({ t: 'setPT', cardId: c.id, pt: v.pt }));
}

function tokenPrompt() {
  prompt('Create a token', [
    { name: 'name', label: 'Name', value: '', placeholder: 'Soldier' },
    { name: 'pt', label: 'Power/toughness', value: '1/1', placeholder: 'Leave empty for non-creatures' },
    { name: 'typeLine', label: 'Type', value: 'Creature', list: ['Creature', 'Artifact', 'Artifact Creature', 'Enchantment', 'Treasure', 'Food', 'Clue'] },
    { name: 'count', label: 'How many', type: 'number', value: 1, min: 1, max: 20 },
  ], 'Create', (v) => send({ t: 'token', name: v.name, pt: v.pt, typeLine: v.typeLine, count: parseInt(v.count, 10) || 1 }));
}

function renderModal() {
  const root = $('#modal-root');
  const m = S.modal;
  if (!m) return root.replaceChildren();
  let body;
  try {
    body = modalBody(m);
  } catch (err) {
    console.error(err);
    body = null;
  }
  if (!body) {
    S.modal = null;
    return root.replaceChildren();
  }
  const keepFilter = root.querySelector('.filter-input');
  const hadFocus = keepFilter && document.activeElement === keepFilter;
  root.replaceChildren(
    h('div', { class: 'scrim', onclick: (e) => e.target === e.currentTarget && m.type !== 'prompt' && closeModal() },
      h('div', { class: cls('dialog', m.wide && 'wide'), role: 'dialog', 'aria-modal': 'true', 'aria-label': body.title },
        h('header', { class: 'dialog-head' },
          h('h2', null, body.title),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '×')),
        body.content)));
  if (hadFocus) {
    const f = root.querySelector('.filter-input');
    f?.focus();
    f?.setSelectionRange(f.value.length, f.value.length);
  } else {
    (root.querySelector('[autofocus]') ?? root.querySelector('input, button:not(.icon-btn)'))?.focus();
  }
}

function modalBody(m) {
  const s = S.state;
  switch (m.type) {
    case 'prompt': {
      const form = h('form', {
        class: 'prompt-form',
        onsubmit: (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          S.modal = null;
          renderModal();
          m.onSubmit(values);
        },
      },
      m.fields.filter((f) => f.group !== 'counters').map((f, i) => promptField(f, i)),
      m.fields.some((f) => f.group === 'counters')
        ? h('fieldset', { class: 'prompt-group' }, h('legend', null, 'Counters'), m.fields.filter((f) => f.group === 'counters').map((f) => promptField(f, 1)))
        : '',
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, m.submitLabel)));
      return { title: m.title, content: form };
      function promptField(f, i) { return h('label', { class: 'field-label' }, f.label,
        f.options
          ? h('select', { name: f.name }, f.options.map(([value, label]) => h('option', { value, selected: value === f.value || null }, label)))
          : h('input', {
            name: f.name, type: f.type ?? 'text', value: f.value ?? '', min: f.min, max: f.max, placeholder: f.placeholder,
            list: f.list ? `dl-${f.name}` : null, autofocus: i === 0, autocomplete: 'off', required: f.name === 'name' || f.name === 'kind' || null,
          }),
        f.list ? h('datalist', { id: `dl-${f.name}` }, f.list.map((o) => h('option', { value: o }))) : null); }
    }

    case 'zone': {
      const p = playerById(m.playerId);
      if (!p) return null;
      const cards = [...p[m.zone]].reverse(); // newest first
      const mine = isMine(p.id);
      const names = { graveyard: 'Graveyard', exile: 'Exile', command: 'Command zone' };
      if (!cards.length) return { title: `${mine ? 'Your' : `${p.name}'s`} ${names[m.zone].toLowerCase()}`, content: h('p', { class: 'hint' }, 'Empty.') };
      const dests = ['hand', 'battlefield', 'graveyard', 'exile', 'library', 'command'].filter((z) => z !== m.zone);
      return {
        title: `${mine ? 'Your' : `${p.name}'s`} ${names[m.zone].toLowerCase()} (${cards.length})`,
        content: cardGrid(cards, mine ? (c) => [
          ...dests.map((z) => moveButton(c, z, z === 'library' ? 'top' : undefined)),
          h('button', { class: 'btn tiny', type: 'button', onclick: () => send({ t: 'move', cardId: c.id, to: 'library', pos: 'bottom' }) }, 'Library bottom'),
          h('button', { class: 'btn tiny', type: 'button', onclick: () => libraryPositionPrompt(c, () => openModal({ type: 'zone', playerId: p.id, zone: m.zone })) }, 'Library position…'),
        ] : null),
      };
    }

    case 'library': {
      const lib = S.library;
      if (!lib) return { title: 'Library', content: h('p', { class: 'hint' }, 'Loading…') };
      const q = (m.filter ?? '').toLowerCase();
      const typeOf = (c) => c.def.typeLine ?? '';
      const ofType = (c, t) => new RegExp(`\\b${t}\\b`).test(typeOf(c));
      // "Look at the top" mode: you can arrange the shown cards before putting them on the bottom.
      if (lib.mode === 'top') {
        const ids = lib.cards.map((c) => c.id);
        m.order = [...(m.order ?? []).filter((id) => ids.includes(id)), ...ids.filter((id) => !(m.order ?? []).includes(id))];
      }
      const shown = lib.mode === 'top' ? m.order.map((id) => lib.cards.find((c) => c.id === id)) : lib.cards;
      const cards = shown.filter((c) =>
        (!m.typeFilter || ofType(c, m.typeFilter)) &&
        (!q || c.def.name.toLowerCase().includes(q) || typeOf(c).toLowerCase().includes(q)));
      // One-tap type filters, showing only types that are actually in the library.
      const TYPES = ['Land', 'Creature', 'Artifact', 'Enchantment', 'Instant', 'Sorcery', 'Planeswalker', 'Battle'];
      const present = TYPES.map((t) => [t, lib.cards.filter((c) => ofType(c, t)).length]).filter(([, n]) => n > 0);
      const chips = lib.mode === 'search' && present.length
        ? h('div', { class: 'type-chips', role: 'group', 'aria-label': 'Filter by card type' },
          h('button', { type: 'button', class: cls('chip', !m.typeFilter && 'on'), 'aria-pressed': String(!m.typeFilter), onclick: () => { m.typeFilter = null; renderModal(); } }, 'All', h('small', null, lib.cards.length)),
          present.map(([t, n]) => h('button', {
            type: 'button', class: cls('chip', m.typeFilter === t && 'on'), 'aria-pressed': String(m.typeFilter === t),
            onclick: () => { m.typeFilter = m.typeFilter === t ? null : t; renderModal(); },
          }, t, h('small', null, n))))
        : '';
      const refresh = (keepTop) => {
        if (lib.mode === 'search') send({ t: 'viewLibrary', quiet: true });
        else {
          const n = keepTop ? lib.n : lib.n - 1;
          if (n <= 0) return closeModal();
          send({ t: 'viewLibrary', n, quiet: true });
        }
      };
      // In "look at the top" mode, a card that stays within the cards you're looking at keeps the view the same size.
      const staysInView = (pos, depth) => pos === 'top' && depth <= lib.n;
      const act = (c, to, pos, depth = 1) => () => {
        send({ t: 'move', cardId: c.id, to, pos, depth });
        refresh(to === 'library' && staysInView(pos, depth));
      };
      const moveInOrder = (c, step) => () => {
        const i = m.order.indexOf(c.id);
        const j = i + step;
        if (j < 0 || j >= m.order.length) return;
        [m.order[i], m.order[j]] = [m.order[j], m.order[i]];
        renderModal();
      };
      const reveal = (list, label) => {
        send({ t: 'reveal', cardIds: list.map((c) => c.id) });
        toast(`Revealed ${label} to your opponent.`);
      };
      const buttons = (c) => [
        lib.mode === 'top' && m.order.length > 1
          ? h('span', { class: 'order-arrows' },
            h('button', { class: 'btn tiny', type: 'button', 'aria-label': `Move ${c.def.name} left`, disabled: m.order[0] === c.id || null, onclick: moveInOrder(c, -1) }, '←'),
            h('button', { class: 'btn tiny', type: 'button', 'aria-label': `Move ${c.def.name} right`, disabled: m.order.at(-1) === c.id || null, onclick: moveInOrder(c, 1) }, '→'))
          : '',
        h('button', { class: 'btn tiny reveal-btn', type: 'button', onclick: () => reveal([c], c.def.name) }, 'Reveal'),
        h('button', { class: 'btn tiny', type: 'button', onclick: act(c, 'hand') }, 'Hand'),
        h('button', { class: 'btn tiny', type: 'button', onclick: act(c, 'battlefield') }, 'Battlefield'),
        h('button', { class: 'btn tiny', type: 'button', onclick: act(c, 'graveyard') }, 'Graveyard'),
        h('button', { class: 'btn tiny', type: 'button', onclick: act(c, 'exile') }, 'Exile'),
        h('button', { class: 'btn tiny', type: 'button', onclick: act(c, 'library', 'top') }, 'Top'),
        h('button', { class: 'btn tiny', type: 'button', onclick: act(c, 'library', 'bottom') }, 'Bottom'),
        h('button', {
          class: 'btn tiny', type: 'button',
          onclick: () => libraryPositionPrompt(c, (pos, depth) => refresh(staysInView(pos, depth))),
        }, 'Position…'),
      ];
      return {
        title: lib.mode === 'search' ? `Your library (${lib.total})` : lib.n === 1 ? 'The top card of your library' : `Top ${lib.n} of your library`,
        content: h('div', null,
          lib.mode === 'search'
            ? h('input', {
              class: 'filter-input', placeholder: 'Search by name', value: m.filter ?? '', 'aria-label': 'Search by name',
              oninput: (e) => { m.filter = e.target.value; renderModal(); },
            })
            : h('p', { class: 'hint' }, lib.n === 1
              ? 'Your opponent only sees that you looked.'
              : m.order.join() !== lib.cards.map((c) => c.id).join()
                ? 'Rearranged for putting on the bottom. Your library itself hasn\'t changed yet. Your opponent only sees that you looked.'
                : 'Leftmost is the top card. Your opponent only sees that you looked.'),
          chips,
          cards.length ? cardGrid(cards, buttons) : h('p', { class: 'hint empty-filter' }, 'No cards match.'),
          lib.mode === 'top' && shown.length
            ? h('div', { class: 'top-actions' },
              h('div', { class: 'top-action-group' },
                h('span', { class: 'control-label' }, 'Show your opponent'),
                h('button', { class: 'btn small', type: 'button', onclick: () => reveal(shown, shown.length === 1 ? 'the card' : `all ${shown.length} cards`) },
                  shown.length === 1 ? 'Reveal this card' : `Reveal all ${shown.length}`)),
              h('div', { class: 'top-action-group' },
                h('span', { class: 'control-label' }, shown.length === 1 ? 'Put it on the bottom' : `Put the ${shown.length === lib.n ? '' : 'remaining '}${shown.length} on the bottom`),
                h('div', { class: 'row wrap' },
                  h('button', { class: 'btn small', type: 'button', onclick: () => { send({ t: 'bottomMany', cardIds: shown.map((c) => c.id), random: true }); closeModal(); } }, shown.length > 1 ? 'In a random order' : 'Put on bottom'),
                  shown.length > 1
                    ? h('button', { class: 'btn small', type: 'button', onclick: () => { send({ t: 'bottomMany', cardIds: shown.map((c) => c.id), random: false }); closeModal(); } }, 'In this order')
                    : ''),
                shown.length > 1 ? h('span', { class: 'hint' }, 'Arrange with ← →. In this order, the rightmost card ends up at the very bottom.') : ''))
            : '',
          // Closing never shuffles unless you choose to.
          h('div', { class: 'row end close-choices' },
            h('button', { class: 'btn', type: 'button', onclick: () => { send({ t: 'shuffle' }); closeModal(); } }, 'Shuffle and close'),
            h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Close without shuffling'))),
      };
    }

    case 'view':
      return { title: 'View', content: h('div', null, viewSettings(), h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done'))) };

    case 'confirm': {
      return {
        title: m.title,
        content: h('div', null,
          h('p', null, m.text),
          h('div', { class: 'row end' },
            h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
            h('button', { class: cls('btn', m.danger ? 'danger' : 'primary'), type: 'button', autofocus: true, onclick: () => { closeModal(); m.run(); } }, m.confirm))),
      };
    }

    case 'shuffle': {
      const gy = me()?.graveyard.length ?? 0;
      const form = h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          const withGraveyard = e.currentTarget.elements.gy.checked;
          closeModal();
          send({ t: 'shuffle', withGraveyard });
        },
      },
      h('p', null, `Your library has ${me()?.libraryCount ?? 0} cards. Your opponent will see that you shuffled.`),
      h('label', { class: cls('check', !gy && 'disabled') },
        h('input', { type: 'checkbox', name: 'gy', disabled: !gy || null }),
        gy ? `Also shuffle my graveyard into my library (${gy} card${gy === 1 ? '' : 's'})` : 'Also shuffle my graveyard into my library (it is empty)'),
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit', autofocus: true }, 'Shuffle')));
      return { title: 'Shuffle your library?', content: form };
    }

    case 'end': {
      const opps = opponents().filter((p) => !p.conceded);
      if (s.ranked === false) {
        const end = (winnerId) => () => { closeModal(); send({ t: 'endGame', winnerId }); };
        return {
          title: 'End the game',
          content: h('div', { class: 'report' },
            h('p', null, "This game is unranked, so it ends right away and won't count toward anyone's records."),
            h('div', { class: 'report-options' },
              h('button', { class: 'report-option', type: 'button', onclick: end(S.you) }, h('b', null, 'I won')),
              opps.map((p) => h('button', { class: 'report-option', type: 'button', onclick: end(p.id) }, h('b', null, `${p.name} won`))),
              h('button', { class: 'report-option', type: 'button', onclick: end(null) }, h('b', null, 'No winner')))),
        };
      }
      const report = (winnerId) => () => { closeModal(); send({ t: 'endGame', winnerId }); };
      const names = opps.map((p) => p.name).join(' and ');
      return {
        title: 'Report the result',
        content: h('div', { class: 'report' },
          h('p', null, 'Results count toward everyone\'s records, so both of you need to agree.'),
          h('div', { class: 'report-options' },
            h('button', { class: 'report-option', type: 'button', onclick: report(S.you) },
              h('b', null, 'I won'), h('span', null, `${names} will be asked to confirm.`)),
            opps.map((p) => h('button', { class: 'report-option', type: 'button', onclick: report(p.id) },
              h('b', null, `${p.name} won`), h('span', null, 'Ends the game now. No confirmation needed when you\'re the one who lost.'))),
            h('button', { class: 'report-option', type: 'button', onclick: report(null) },
              h('b', null, 'No winner'), h('span', null, `For a draw or a game you're stopping. ${names} will be asked to confirm. Doesn't count toward records.`))),
          h('hr'),
          h('div', { class: 'row' },
            h('button', { class: 'btn danger', type: 'button', onclick: () => { closeModal(); send({ t: 'concede' }); } }, 'Concede'),
            h('span', { class: 'hint' }, 'Ends the game now with your opponent as the winner.'))),
      };
    }

    case 'confirmResult': {
      const pr = s.status === 'playing' ? s.pendingResult : null;
      if (!pr) return null;
      const by = playerById(pr.by);
      const w = playerById(pr.winnerId);
      const iLose = w && !isMine(w.id);
      return {
        title: 'Confirm the result?',
        content: h('div', null,
          h('p', { class: 'confirm-claim' }, `${by?.name} reports `,
            h('b', { class: w ? (isMine(w.id) ? 'me' : 'them') : null }, w ? (isMine(w.id) ? 'you won' : w.id === pr.by ? 'they won' : `${w.name} won`) : 'no winner'), '.'),
          h('p', { class: 'hint' }, iLose
            ? 'Confirming records a loss for you and a win for them.'
            : w ? 'Confirming records a win for you.' : "Confirming ends the game without a winner. It won't count toward records."),
          h('div', { class: 'row end' },
            h('button', { class: 'btn', type: 'button', onclick: () => { S.modal = null; send({ t: 'rejectResult' }); renderModal(); } }, 'No, keep playing'),
            h('button', { class: 'btn primary', type: 'button', autofocus: true, onclick: () => { S.modal = null; send({ t: 'confirmResult' }); renderModal(); } }, 'Confirm'))),
      };
    }

    case 'ended': {
      if (s.status !== 'ended') return null;
      const w = playerById(s.winnerId);
      return {
        title: w ? (isMine(w.id) ? 'You won' : `${w.name} won`) : 'Game over',
        content: h('div', null,
          h('p', null, s.endReason === 'concede' ? 'Won by concession.' : `Ended on turn ${s.turn?.number ?? 1}.`,
            s.ranked === false ? ' Unranked: saved to your game history, not to records.'
              : w ? ' Both players agreed. The result is saved to your game history and deck records.' : ' Saved to your game history. Games without a winner don\'t count toward records.'),
          recordsBlock(),
          h('div', { class: 'row end' },
            h('button', { class: 'btn ghost', type: 'button', onclick: () => navigate('/') }, 'Leave'),
            h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'View the board'),
            h('button', { class: 'btn primary', type: 'button', onclick: () => { S.modal = null; send({ t: 'rematch' }); } }, 'Rematch'))),
      };
    }
  }
  return null;
}

function moveButton(c, zone, pos) {
  const labels = { hand: 'Hand', battlefield: 'Battlefield', graveyard: 'Graveyard', exile: 'Exile', library: 'Library top', command: 'Command' };
  return h('button', { class: 'btn tiny', type: 'button', onclick: () => send({ t: 'move', cardId: c.id, to: zone, pos }) }, labels[zone]);
}

function cardGrid(cards, actions) {
  return h('ul', { class: 'card-grid' },
    cards.map((c) => h('li', { class: 'grid-card' },
      h('div', { class: 'grid-face', onmouseenter: () => showPreview(c, true) }, cardFace({ ...c, faceDown: false }, 'normal')),
      actions ? h('div', { class: 'grid-actions' }, actions(c)) : null)));
}

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#menu-root .menu')) return closeMenu();
    if (S.modal) return closeModal();
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (typing || e.metaKey || e.ctrlKey || e.altKey || S.modal) return;
  if (S.state?.status !== 'playing') return;
  const k = e.key.toLowerCase();
  if (k === 'd') send({ t: 'draw', n: 1 });
  else if (k === 'u') send({ t: 'untapAll' });
  else if (k === 'n') nextStep();
  else if (k === 's') openModal({ type: 'shuffle' });
  else if (k === 'f') send({ t: 'viewLibrary' });
  else if (k === 't') lookAtTopCard();
});

window.addEventListener('resize', closeMenu);

applyView();
boot();
