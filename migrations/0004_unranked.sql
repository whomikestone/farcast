-- Unranked games are kept in history but never count toward records.
ALTER TABLE games ADD COLUMN ranked INTEGER NOT NULL DEFAULT 1;
