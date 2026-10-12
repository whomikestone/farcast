// Sign-in for Farcast. Three ways in, each switched on by settings in wrangler.jsonc:
//   Cloudflare Access  ACCESS_TEAM_DOMAIN + ACCESS_AUD   (gate the whole site; identity comes from Access)
//   Google             GOOGLE_CLIENT_ID + secret GOOGLE_CLIENT_SECRET (optional ALLOWED_EMAILS)
//   Password           AUTH_PASSWORD = "on" (default) | "off"
import type { Env } from './index';

const ITERATIONS = 100_000; // Workers' PBKDF2 ceiling
const SESSION_DAYS = 30;
const COOKIE = 'farcast_session';
const OAUTH_COOKIE = 'farcast_oauth';
const enc = new TextEncoder();

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (buf: ArrayBuffer | Uint8Array) => toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
const randomB64Url = (n = 32) => toB64Url(crypto.getRandomValues(new Uint8Array(n)));

export interface User {
  id: string;
  username: string;
  needsName?: boolean;
}

export function authConfig(env: Env) {
  return {
    password: env.AUTH_PASSWORD !== 'off',
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    access: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
  };
}

// ---------- passwords ----------

export async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return { hash: toB64(bits), salt: toB64(salt) };
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(s: string) {
  return toB64(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function validUsername(u: unknown): u is string {
  return typeof u === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_ .-]{1,22}[A-Za-z0-9_]$/.test(u);
}
const USERNAME_RULES = 'Names are 3 to 24 characters: letters, numbers, spaces, dots, dashes, or underscores.';

export async function register(env: Env, username: string, password: string): Promise<User | string> {
  if (!validUsername(username)) return USERNAME_RULES;
  if (typeof password !== 'string' || password.length < 8) return 'Passwords need at least 8 characters.';
  if (password.length > 200) return 'That password is too long.';
  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (taken) return 'That name is taken.';
  const { hash, salt } = await hashPassword(password);
  const user = { id: crypto.randomUUID(), username };
  await env.DB.prepare('INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, username, hash, salt, Date.now()).run();
  return user;
}

// Rate limiting is left to Cloudflare rate limiting rules on /api/auth/* (see README).
export async function login(env: Env, username: string, password: string): Promise<User | string> {
  if (typeof username !== 'string' || typeof password !== 'string') return "That name and password don't match.";
  const row = await env.DB.prepare('SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?')
    .bind(username).first<{ id: string; username: string; pass_hash: string; pass_salt: string }>();
  // Hash even when the user doesn't exist so timing doesn't reveal which names are real.
  const { hash } = await hashPassword(password, row?.pass_salt || 'AAAAAAAAAAAAAAAAAAAAAA==');
  if (!row || !row.pass_hash || !sameString(hash, row.pass_hash)) return "That name and password don't match.";
  return { id: row.id, username: row.username };
}

// ---------- sessions ----------

export async function createSession(env: Env, userId: string, secure: boolean): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 86_400_000).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

function cookie(request: Request, name: string): string | null {
  const m = (request.headers.get('Cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

const USER_SQL = 'SELECT u.id, u.username, u.name_chosen FROM users u';
const toUser = (r: any): User | null => (r ? { id: r.id, username: r.username, needsName: r.name_chosen === 0 } : null);

export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const viaAccess = await accessUser(env, request);
  if (viaAccess) return viaAccess;
  const token = cookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return toUser(await env.DB.prepare(`${USER_SQL} JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256(token), Date.now()).first());
}

export async function logout(env: Env, request: Request, secure: boolean): Promise<string> {
  const token = cookie(request, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function rename(env: Env, userId: string, username: unknown): Promise<User | string> {
  if (!validUsername(username)) return USERNAME_RULES;
  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').bind(username, userId).first();
  if (taken) return 'That name is taken.';
  await env.DB.prepare('UPDATE users SET username = ?, name_chosen = 1 WHERE id = ?').bind(username, userId).run();
  return { id: userId, username };
}

// ---------- accounts from Google / Access ----------

async function uniqueUsername(env: Env, suggested: string) {
  let base = suggested.replace(/[^A-Za-z0-9_ .-]/g, '').replace(/^[ .-]+|[ .-]+$/g, '').slice(0, 20) || 'Player';
  if (base.length < 3) base = `${base}___`.slice(0, 3);
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}${Math.floor(Math.random() * 900 + 100)}`;
    if (!(await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first())) return name;
  }
  return `Player${crypto.randomUUID().slice(0, 8)}`;
}

export async function externalUser(env: Env, provider: 'google' | 'access', subject: string, email: string | null, suggested: string): Promise<User> {
  const found = toUser(await env.DB.prepare(`${USER_SQL} JOIN identities i ON i.user_id = u.id WHERE i.provider = ? AND i.subject = ?`)
    .bind(provider, subject).first());
  if (found) return found;
  const user = { id: crypto.randomUUID(), username: await uniqueUsername(env, suggested) };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, username, pass_hash, pass_salt, created_at, name_chosen) VALUES (?, ?, '', '', ?, 0)").bind(user.id, user.username, now),
    env.DB.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(provider, subject, user.id, email, now),
  ]);
  // If two first requests raced, use whichever identity row won.
  return toUser(await env.DB.prepare(`${USER_SQL} JOIN identities i ON i.user_id = u.id WHERE i.provider = ? AND i.subject = ?`)
    .bind(provider, subject).first())!;
}

// ---------- Google (OpenID Connect, authorization code + PKCE) ----------

const googleAuthUrl = (env: Env) => env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const googleTokenUrl = (env: Env) => env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

export async function googleStart(env: Env, url: URL): Promise<Response> {
  const state = randomB64Url(24);
  const verifier = randomB64Url(48);
  const challenge = toB64Url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const target = new URL(googleAuthUrl(env));
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const secure = url.protocol === 'https:';
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Set-Cookie': `${OAUTH_COOKIE}=${state}.${verifier}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    },
  });
}

export async function googleCallback(env: Env, request: Request, url: URL): Promise<Response> {
  const secure = url.protocol === 'https:';
  const fail = (message: string) => {
    const headers = new Headers({ Location: `/signin?auth_error=${encodeURIComponent(message)}` });
    headers.append('Set-Cookie', `${OAUTH_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
    return new Response(null, { status: 302, headers });
  };
  const [state, verifier] = (cookie(request, OAUTH_COOKIE) ?? '').split('.');
  if (url.searchParams.get('error')) return fail('Google sign-in was cancelled.');
  if (!state || !verifier || url.searchParams.get('state') !== state) return fail('That sign-in link expired. Try again.');
  const code = url.searchParams.get('code');
  if (!code) return fail('Google sign-in failed. Try again.');

  // Exchanged directly with Google over TLS, so the ID token can be trusted without checking its signature.
  const res = await fetch(googleTokenUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: verifier,
    }),
  });
  if (!res.ok) return fail('Google sign-in failed. Try again.');
  const { id_token } = await res.json<any>();
  let claims: any;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64Url(String(id_token).split('.')[1])));
  } catch {
    return fail('Google sign-in failed. Try again.');
  }
  const issuerOk = ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss);
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || !claims.sub) return fail('Google sign-in failed. Try again.');
  if (!claims.email || claims.email_verified === false) return fail('Your Google account needs a verified email.');
  const allowed = (env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(claims.email).toLowerCase())) return fail("This Google account isn't on the invite list for this table.");

  const user = await externalUser(env, 'google', claims.sub, claims.email, claims.given_name || claims.name || claims.email.split('@')[0]);
  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', await createSession(env, user.id, secure));
  headers.append('Set-Cookie', `${OAUTH_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  return new Response(null, { status: 302, headers });
}

// ---------- Cloudflare Access ----------

let accessKeys: { at: number; keys: Map<string, CryptoKey> } | null = null;

async function loadAccessKeys(env: Env, force = false) {
  if (!force && accessKeys && Date.now() - accessKeys.at < 3_600_000) return accessKeys.keys;
  const res = await fetch(env.ACCESS_CERTS_URL ?? `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: ${res.status}`);
  const { keys = [] } = await res.json<any>();
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA') continue;
    map.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  accessKeys = { at: Date.now(), keys: map };
  return map;
}

async function accessUser(env: Env, request: Request): Promise<User | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(request, 'CF_Authorization');
  if (!token) return null;
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(fromB64Url(h)));
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(p)));
    if (header.alg !== 'RS256') return null;
    let key = (await loadAccessKeys(env)).get(header.kid);
    if (!key) key = (await loadAccessKeys(env, true)).get(header.kid); // keys rotate
    if (!key) return null;
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64Url(s), enc.encode(`${h}.${p}`));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!valid || !aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || claims.exp * 1000 < Date.now()) return null;
    if (!claims.email) return null; // service tokens can't play
    return externalUser(env, 'access', claims.sub || claims.email, claims.email, claims.email.split('@')[0]);
  } catch (err) {
    console.error('Access token check failed', err);
    return null;
  }
}
