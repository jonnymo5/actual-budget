BEGIN TRANSACTION;

CREATE TABLE card_statements
  (id TEXT PRIMARY KEY,
   account TEXT,
   pay_from TEXT,
   closing_date INTEGER,
   statement_balance INTEGER,
   minimum_due INTEGER,
   due_date INTEGER,
   payment_amount INTEGER,
   schedule TEXT,
   skipped_schedule TEXT,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX card_statements_account ON card_statements(account);
CREATE INDEX card_statements_schedule ON card_statements(schedule);

COMMIT;
