-- Migration number: 0002 	 2026-10-23T17:30:00.000Z
-- The AI stage moved from a Workers AI label to a Jev verdict with
-- probabilities. The old table held almost nothing, so it is dropped and
-- recreated rather than altered (SQLite cannot change a CHECK in place).
DROP INDEX IF EXISTS log_created_at_idx;
DROP INDEX IF EXISTS log_source_idx;
DROP TABLE IF EXISTS log;

CREATE TABLE log (
  id                   TEXT    PRIMARY KEY,
  contact              TEXT    NOT NULL,
  message              TEXT    NOT NULL,
  channel              TEXT    NOT NULL CHECK (channel IN ('red','green')),
  source               TEXT,
  rate_limit_decision  TEXT    CHECK (rate_limit_decision IN ('accept','drop')),
  rate_limit_violation TEXT    CHECK (rate_limit_violation IN ('none','hour','day','lifetime','kv_error')),
  -- 'error' is the fail-open path: Jev could not be asked, the page was delivered.
  ai_decision          TEXT    CHECK (ai_decision IN ('accept','drop','error')),
  -- Jev's Choice answer; on a drop it is the label the drop was charged to.
  ai_kind              TEXT    CHECK (ai_kind IN ('page','joke','gibberish','spam')),
  ai_kind_confidence   REAL    CHECK (ai_kind_confidence BETWEEN 0 AND 1),
  -- P(spam) + P(gibberish), the number the channel threshold is applied to.
  ai_drop_probability  REAL    CHECK (ai_drop_probability BETWEEN 0 AND 1),
  ai_hijack            REAL    CHECK (ai_hijack BETWEEN 0 AND 1),
  -- Position on the three urgency levels, 0 to 2.
  ai_urgency           REAL    CHECK (ai_urgency BETWEEN 0 AND 2),
  ai_model             TEXT,
  -- Why a message was dropped, or the error text on the fail-open path.
  ai_reason            TEXT,
  adapter              TEXT,
  result               TEXT    CHECK (result IN ('dropped','delivered','failed')),
  result_reason        TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX log_created_at_idx ON log(created_at);
CREATE INDEX log_source_idx     ON log(source) WHERE source IS NOT NULL;
