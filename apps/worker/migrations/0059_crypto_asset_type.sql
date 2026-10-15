-- 投資持倉與交易新增 crypto 資產類型。SQLite 無法直接修改 CHECK，
-- 因此以新表複製全部既有資料後替換；欄位、唯一鍵與索引維持不變。
CREATE TABLE investment_positions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'fund', 'crypto')),
  symbol TEXT,
  name TEXT NOT NULL,
  quantity REAL,
  market_value INTEGER,
  cash_balance INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  as_of_date TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, source_id, as_of_date)
);

CREATE TABLE investment_transactions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  broker_no TEXT,
  broker_account TEXT,
  broker_name TEXT,
  symbol TEXT,
  name TEXT,
  asset_type TEXT CHECK (asset_type IN ('stock', 'etf', 'fund', 'bond', 'crypto', 'unknown')),
  trade_date TEXT,
  posted_date TEXT,
  transaction_code TEXT,
  transaction_name TEXT,
  quantity REAL,
  price REAL,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, effective_date TEXT AS (COALESCE(trade_date, posted_date, '')),
  UNIQUE (connector_id, account_id, source_id)
);

INSERT INTO investment_positions_new (id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at)
SELECT id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at FROM investment_positions;

INSERT INTO investment_transactions_new (id, connector_id, account_id, source_id, broker_no, broker_account, broker_name, symbol, name, asset_type, trade_date, posted_date, transaction_code, transaction_name, quantity, price, amount, currency, raw_payload, created_at, updated_at)
SELECT id, connector_id, account_id, source_id, broker_no, broker_account, broker_name, symbol, name, asset_type, trade_date, posted_date, transaction_code, transaction_name, quantity, price, amount, currency, raw_payload, created_at, updated_at FROM investment_transactions;

DROP TABLE investment_positions;
DROP TABLE investment_transactions;

ALTER TABLE investment_positions_new RENAME TO investment_positions;
ALTER TABLE investment_transactions_new RENAME TO investment_transactions;

CREATE INDEX idx_investment_positions_page
  ON investment_positions (as_of_date DESC, asset_type ASC, name ASC, id ASC);
CREATE INDEX idx_investment_positions_latest_scope
  ON investment_positions (connector_id, asset_type, as_of_date DESC);
CREATE INDEX idx_investment_positions_asset_type
  ON investment_positions (asset_type);
CREATE INDEX idx_investment_positions_as_of_date
  ON investment_positions (as_of_date);
CREATE INDEX idx_investment_transactions_effective_updated
  ON investment_transactions (effective_date DESC, updated_at DESC, id DESC);
CREATE INDEX idx_investment_transactions_symbol
  ON investment_transactions (symbol);
CREATE INDEX idx_investment_transactions_trade_date
  ON investment_transactions (trade_date);
