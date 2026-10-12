-- Permanent game records. Live rooms live in Durable Objects and are deleted when they expire.
CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  room_code     TEXT NOT NULL,
  starting_life INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL,
  end_reason    TEXT NOT NULL,          -- reported | concede | abandoned
  winner_name   TEXT,
  turns         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  deck_name   TEXT,
  commanders  TEXT NOT NULL DEFAULT '[]', -- JSON array of card names
  card_count  INTEGER NOT NULL DEFAULT 0,
  final_life  INTEGER NOT NULL,
  poison      INTEGER NOT NULL DEFAULT 0,
  conceded    INTEGER NOT NULL DEFAULT 0,
  is_winner   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, seat)
);

CREATE INDEX IF NOT EXISTS idx_games_ended_at ON games(ended_at DESC);
