// Local stand-ins for Scryfall, Google's token endpoint, and Cloudflare Access's signing keys.
// Tests only. Start wrangler dev with the vars listed in test/smoke.mjs so the Worker talks to these.
import http from 'node:http';
import crypto from 'node:crypto';

const img = (kind, id) => `https://cards.scryfall.io/${kind}/front/${id[0]}/${id[1]}/${id}.jpg?1562404344`;
function card(name, set = 'tst', cn = '1') {
  const id = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000';
  const land = /^(Forest|Island|Mountain|Plains|Swamp)$/.test(name);
  const commander = /Commander$/.test(name);
  return {
    object: 'card', id, name, set, collector_number: cn,
    type_line: land ? `Basic Land — ${name}` : commander ? 'Legendary Creature — Test' : 'Creature — Test',
    ...(land ? {} : { power: '2', toughness: '2' }),
    color_identity: commander ? ['G', 'U'] : [],
    image_uris: { small: img('small', id), normal: img('normal', id), art_crop: img('art_crop', id) },
  };
}

const b64url = (b) => Buffer.from(b).toString('base64url');
export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const ACCESS = { team: 'test.cloudflareaccess.com', aud: 'test-aud' };
const GOOGLE_USERS = {
  gina: { sub: 'google-sub-gina', email: 'gina@example.com', given_name: 'Gina' },
  stranger: { sub: 'google-sub-stranger', email: 'stranger@example.com', given_name: 'Stranger' },
};

export function startMocks(port = 8899) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `kid-${Date.now()}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  const signAccess = (claims, { key = privateKey } = {}) => {
    const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const p = b64url(JSON.stringify({ iss: `https://${ACCESS.team}`, aud: [ACCESS.aud], exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key);
    return `${h}.${p}.${b64url(sig)}`;
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url.startsWith('/cards/collection')) {
        const { identifiers = [] } = JSON.parse(body || '{}');
        const data = [], not_found = [];
        for (const i of identifiers) {
          if (i.name === 'Not A Real Card') not_found.push(i);
          else data.push(i.name ? card(i.name) : card(`Printed ${i.collector_number}`, i.set, i.collector_number));
        }
        return send(200, { data, not_found });
      }
      if (req.url.startsWith('/google/token')) {
        const f = new URLSearchParams(body);
        const u = GOOGLE_USERS[f.get('code')];
        if (!u || f.get('client_id') !== GOOGLE_CLIENT_ID || !f.get('code_verifier') || f.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant' });
        const claims = { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...u };
        return send(200, { id_token: `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig` });
      }
      if (req.url.startsWith('/access/certs')) return send(200, { keys: [jwk] });
      send(404, {});
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, signAccess })));
}
