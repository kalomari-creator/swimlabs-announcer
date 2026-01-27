CREATE TABLE IF NOT EXISTS announcement_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id TEXT NOT NULL,
  date TEXT,
  time TEXT,
  type TEXT,
  swimmer_name TEXT,
  message TEXT NOT NULL,
  result TEXT NOT NULL,
  source TEXT NOT NULL,
  triggered_at TEXT,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS announcement_last (
  location_id TEXT NOT NULL,
  device_mode TEXT NOT NULL,
  message TEXT NOT NULL,
  spoken_at TEXT NOT NULL,
  PRIMARY KEY (location_id, device_mode)
);

CREATE TABLE IF NOT EXISTS report_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  range_start TEXT,
  range_end TEXT,
  uploaded_at TEXT,
  filename TEXT,
  content_hash TEXT,
  raw_content TEXT,
  parsed_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_uploads_lookup
  ON report_uploads(location_id, report_type, effective_date, uploaded_at);
