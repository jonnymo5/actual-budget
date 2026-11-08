BEGIN TRANSACTION;

CREATE TABLE rsu_grants
  (id TEXT PRIMARY KEY,
   name TEXT,
   ticker TEXT,
   grant_date INTEGER,
   total_shares REAL,
   account TEXT,
   category TEXT,
   payee TEXT,
   withholding_rate REAL,
   notes TEXT,
   sort_order REAL,
   tombstone INTEGER DEFAULT 0);

CREATE TABLE rsu_vest_events
  (id TEXT PRIMARY KEY,
   grant_id TEXT,
   vest_date INTEGER,
   shares REAL,
   schedule TEXT,
   actual_price INTEGER,
   actual_net INTEGER,
   notes TEXT,
   tombstone INTEGER DEFAULT 0);

CREATE TABLE stock_prices
  (id TEXT PRIMARY KEY,
   price INTEGER,
   currency TEXT,
   as_of TEXT,
   updated_at TEXT,
   source TEXT,
   manual_override INTEGER DEFAULT 0,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX rsu_vest_events_grant_id ON rsu_vest_events(grant_id);
CREATE INDEX rsu_vest_events_schedule ON rsu_vest_events(schedule);

COMMIT;
