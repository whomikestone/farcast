-- Accounts, saved decks, and links from game results to users and decks.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT NOT NULL,           -- PBKDF2-SHA256, base64
  pass_salt  TEXT NOT NULL,           -- base64
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,        -- SHA-256 of the cookie token; the token itself is never stored
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- A deck is an exact card list. Changing the cards creates a new row (previous_id points back)
-- and retires the old one, so every version keeps its own record.
CREATE TABLE IF NOT EXISTS decks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  commanders   TEXT NOT NULL DEFAULT '[]', -- JSON array of names, for listing
  card_count   INTEGER NOT NULL,
  content_hash TEXT NOT NULL,              -- card names + counts + commanders; printings don't count
  list         TEXT NOT NULL,              -- JSON { main: [{count, def}], commanders: [def] }
  created_at   INTEGER NOT NULL,
  retired_at   INTEGER,
  previous_id  TEXT REFERENCES decks(id)
);
CREATE INDEX IF NOT EXISTS idx_decks_user ON decks(user_id, retired_at);

ALTER TABLE games ADD COLUMN winner_user_id TEXT;
ALTER TABLE game_players ADD COLUMN user_id TEXT;
ALTER TABLE game_players ADD COLUMN deck_id TEXT;
CREATE INDEX IF NOT EXISTS idx_gp_deck ON game_players(deck_id);
CREATE INDEX IF NOT EXISTS idx_gp_user ON game_players(user_id);
