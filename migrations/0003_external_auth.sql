-- Google and Cloudflare Access sign-in, and chosen display names.

CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,            -- 'google' | 'access'
  subject    TEXT NOT NULL,            -- the provider's stable user id
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- 0 until a Google/Access user confirms the name other players see.
ALTER TABLE users ADD COLUMN name_chosen INTEGER NOT NULL DEFAULT 1;
