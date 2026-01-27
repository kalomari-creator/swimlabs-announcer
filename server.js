const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { spawn } = require("child_process");
const crypto = require("crypto");
const cheerio = require('cheerio');
const multer = require('multer');

// Configure multer for file uploads (store in memory)
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = 5055;
// ---- CORS CONFIG (REQUIRED FOR TAILSCALE + IP ACCESS) ----
const ALLOWED_ORIGINS = new Set([
  "http://100.102.148.122:5055",
  "http://swimlabs-server-ser.tail8048a1.ts.net:5055",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
// ---- END CORS CONFIG ----
// -------------------- CONFIG --------------------
const ADMIN_PIN = process.env.ADMIN_PIN || "1590";
const MANAGER_PIN = process.env.MANAGER_PIN || "8118";
const MANAGER_CODE = process.env.MANAGER_CODE || MANAGER_PIN;
const MAX_FAILS = 3;
const LOCKOUT_MS = 2 * 60 * 1000;

// -------------------- Paths --------------------
const APP_ROOT = (() => {
  if (process.env.APP_ROOT) return path.resolve(process.env.APP_ROOT);
  let current = __dirname;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return __dirname;
    current = parent;
  }
})();

function resolveDir(envValue, candidates, fallback) {
  if (envValue) return path.resolve(envValue);
  for (const candidate of candidates) {
    const resolved = path.resolve(APP_ROOT, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return path.resolve(APP_ROOT, fallback);
}

const DATA_DIR = resolveDir(process.env.DATA_DIR, ["data", "runtime/data", "runtime/db", "db"], "data");
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "app.db");
if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

const SCHEDULE_DIR = resolveDir(process.env.SCHEDULE_DIR, ["runtime/schedules", "schedules"], "schedules");
const EXPORT_DIR = resolveDir(process.env.EXPORT_DIR, ["runtime/exports", "exports"], "exports");
const MANAGER_REPORTS_DIR = resolveDir(
  process.env.MANAGER_REPORTS_DIR,
  ["runtime/manager_reports", "manager_reports"],
  "manager_reports"
);
const PUBLIC_DIR = resolveDir(process.env.PUBLIC_DIR, ["public", "client/public", "app/public"], "public");
const ASSETS_DIR = resolveDir(process.env.ASSETS_DIR, ["assets"], "assets");
const CONFIG_DIR = resolveDir(process.env.CONFIG_DIR, ["config"], "config");
const PIPER_DIR = process.env.PIPER_DIR
  ? path.resolve(process.env.PIPER_DIR)
  : path.join(ASSETS_DIR, "piper", "piper");
const TTS_MODEL_DIR = process.env.TTS_MODEL_DIR
  ? path.resolve(process.env.TTS_MODEL_DIR)
  : path.join(ASSETS_DIR, "tts");

// Piper TTS
let PIPER_BIN = process.env.PIPER_BIN_PATH || path.join(PIPER_DIR, "piper");
// Support layouts where bin/piper/piper is a directory containing the piper binary
try {
  if (fs.existsSync(PIPER_BIN) && fs.statSync(PIPER_BIN).isDirectory()) {
    const candidate = path.join(PIPER_BIN, "piper");
    if (fs.existsSync(candidate)) PIPER_BIN = candidate;
  }
} catch (e) { /* ignore */ }

const VOICE_MODEL =
  process.env.VOICE_MODEL_PATH || path.join(TTS_MODEL_DIR, "en_US-lessac-medium.onnx");

const TTS_OUT_DIR = resolveDir(process.env.TTS_OUT_DIR, ["runtime/tts_out", "tts_out"], "tts_out");
const TTS_OUT_WAV = path.join(TTS_OUT_DIR, "last.wav");
const PING_WAV = path.join(TTS_OUT_DIR, "ping.wav");

// -------------------- Middleware --------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve index.html + any assets in /public
app.use("/public", express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

if (!fs.existsSync(TTS_OUT_DIR)) fs.mkdirSync(TTS_OUT_DIR, { recursive: true });
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
if (!fs.existsSync(SCHEDULE_DIR)) fs.mkdirSync(SCHEDULE_DIR, { recursive: true });
if (!fs.existsSync(MANAGER_REPORTS_DIR)) fs.mkdirSync(MANAGER_REPORTS_DIR, { recursive: true });

function sanitizeDirSegment(value) {
  return String(value || "").trim().replace(/[\\/]/g, "-");
}

function getScheduleDir(location) {
  const name = location?.name || location?.code || "unknown";
  return path.join(SCHEDULE_DIR, sanitizeDirSegment(name));
}

function getManagerReportDir(location) {
  const name = location?.code || location?.name || "unknown";
  return path.join(MANAGER_REPORTS_DIR, sanitizeDirSegment(name));
}

function getLocationFileTag(location) {
  const tag = location?.code || location?.name || "location";
  return sanitizeDirSegment(tag).replace(/\s+/g, "_");
}

// Create location-specific directories
const LOCATION_NAMES = [
  'SwimLabs Westchester',
  'SwimLabs Woodlands',
  'SafeSplash Riverdale',
  'SafeSplash Santa Monica',
  'SafeSplash Torrance',
  'SafeSplash Summerlin'
];
LOCATION_NAMES.forEach(name => {
  const schedDir = path.join(SCHEDULE_DIR, sanitizeDirSegment(name));
  if (!fs.existsSync(schedDir)) fs.mkdirSync(schedDir, { recursive: true });
});

// -------------------- DB schema / migration --------------------
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roster (
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      swimmer_name TEXT NOT NULL,
      instructor_name TEXT,
      zone INTEGER,
      program TEXT,
      age_text TEXT,

      attendance INTEGER DEFAULT NULL,
      attendance_at TEXT,
      attendance_auto_absent INTEGER DEFAULT 0,

      is_addon INTEGER DEFAULT 0,

      flag_new INTEGER DEFAULT 0,
      flag_makeup INTEGER DEFAULT 0,
      flag_policy INTEGER DEFAULT 0,
      flag_owes INTEGER DEFAULT 0,
      flag_trial INTEGER DEFAULT 0,

      created_at TEXT,
      updated_at TEXT,

      zone_overridden INTEGER DEFAULT 0,
      zone_override_at TEXT,
      zone_override_by TEXT,

      PRIMARY KEY(date, start_time, swimmer_name)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      ip TEXT,
      device_mode TEXT,
      action TEXT NOT NULL,
      date TEXT,
      start_time TEXT,
      swimmer_name TEXT,
      details TEXT
    );
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trial_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swimmer_name TEXT NOT NULL,
      location_id INTEGER NOT NULL DEFAULT 1,
      status TEXT DEFAULT 'new',
      last_contact_at TEXT,
      next_follow_up_at TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      report_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      uploaded_at TEXT,
      size_bytes INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_report_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      report_type TEXT NOT NULL,
      report_date TEXT,
      data_json TEXT,
      warnings_json TEXT,
      uploaded_at TEXT,
      archived INTEGER DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS absence_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      swimmer_name TEXT NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT,
      status TEXT DEFAULT 'new',
      notes TEXT,
      contacted_at TEXT,
      rescheduled_at TEXT,
      completed_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(location_id, swimmer_name, date, start_time)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bundle_tracker (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT,
      notes TEXT,
      start_date TEXT,
      duration_weeks INTEGER,
      monthly_price REAL,
      discounted_monthly REAL,
      total_billed REAL,
      house_credit REAL,
      expiration_date TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS guard_tasks (
      location_id INTEGER NOT NULL,
      task_date TEXT NOT NULL,
      data_json TEXT,
      updated_at TEXT,
      PRIMARY KEY(location_id, task_date)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS guard_task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      task_date TEXT NOT NULL,
      data_json TEXT,
      saved_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      location_id INTEGER,
      initials TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      class_key TEXT,
      instructor_name TEXT,
      class_day_time_level TEXT,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Locations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      has_announcements INTEGER DEFAULT 0,
      brand TEXT DEFAULT 'swimlabs',
      active INTEGER DEFAULT 1
    );
  `);

  // Insert default locations if table is empty
  const locCount = db.prepare(`SELECT COUNT(*) as c FROM locations`).get();
  if (locCount.c === 0) {
    const insertLoc = db.prepare(`INSERT INTO locations (code, name, has_announcements, brand) VALUES (?, ?, ?, ?)`);
    insertLoc.run('SLW', 'SwimLabs Westchester', 1, 'swimlabs');
    insertLoc.run('SLX', 'SwimLabs Woodlands', 0, 'swimlabs');
    insertLoc.run('SSR', 'SafeSplash Riverdale', 0, 'safesplash');
    insertLoc.run('SSM', 'SafeSplash Santa Monica', 0, 'safesplash');
    insertLoc.run('SST', 'SafeSplash Torrance', 0, 'safesplash');
    insertLoc.run('SSS', 'SafeSplash Summerlin', 0, 'safesplash');
  }

  const cols = db.prepare(`PRAGMA table_info(roster)`).all().map((r) => r.name);
  const addIfMissing = (name, ddl) => { if (!cols.includes(name)) db.exec(ddl); };

  addIfMissing("program", `ALTER TABLE roster ADD COLUMN program TEXT;`);
  addIfMissing("age_text", `ALTER TABLE roster ADD COLUMN age_text TEXT;`);
  addIfMissing("attendance", `ALTER TABLE roster ADD COLUMN attendance INTEGER DEFAULT NULL;`);
  addIfMissing("attendance_at", `ALTER TABLE roster ADD COLUMN attendance_at TEXT;`);
  addIfMissing("attendance_auto_absent", `ALTER TABLE roster ADD COLUMN attendance_auto_absent INTEGER DEFAULT 0;`);
  addIfMissing("is_addon", `ALTER TABLE roster ADD COLUMN is_addon INTEGER DEFAULT 0;`);

  addIfMissing("flag_new", `ALTER TABLE roster ADD COLUMN flag_new INTEGER DEFAULT 0;`);
  addIfMissing("flag_makeup", `ALTER TABLE roster ADD COLUMN flag_makeup INTEGER DEFAULT 0;`);
  addIfMissing("flag_policy", `ALTER TABLE roster ADD COLUMN flag_policy INTEGER DEFAULT 0;`);
  addIfMissing("flag_owes", `ALTER TABLE roster ADD COLUMN flag_owes INTEGER DEFAULT 0;`);
  addIfMissing("flag_trial", `ALTER TABLE roster ADD COLUMN flag_trial INTEGER DEFAULT 0;`);

  addIfMissing("created_at", `ALTER TABLE roster ADD COLUMN created_at TEXT;`);
  addIfMissing("updated_at", `ALTER TABLE roster ADD COLUMN updated_at TEXT;`);

  addIfMissing("zone_overridden", `ALTER TABLE roster ADD COLUMN zone_overridden INTEGER DEFAULT 0;`);
  addIfMissing("zone_override_at", `ALTER TABLE roster ADD COLUMN zone_override_at TEXT;`);
  addIfMissing("zone_override_by", `ALTER TABLE roster ADD COLUMN zone_override_by TEXT;`);
  addIfMissing("location_id", `ALTER TABLE roster ADD COLUMN location_id INTEGER DEFAULT 1;`);
  addIfMissing("substitute_instructor", `ALTER TABLE roster ADD COLUMN substitute_instructor TEXT;`);
  addIfMissing("is_substitute", `ALTER TABLE roster ADD COLUMN is_substitute INTEGER DEFAULT 0;`);
  addIfMissing("original_instructor", `ALTER TABLE roster ADD COLUMN original_instructor TEXT;`);
  addIfMissing("balance_amount", `ALTER TABLE roster ADD COLUMN balance_amount REAL DEFAULT NULL;`);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_key ON roster(date, start_time, swimmer_name);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_followup ON trial_followups(swimmer_name, location_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_roster_date_time ON roster(date, start_time);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_manager_reports ON manager_reports(location_id, report_type, uploaded_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_manager_report_data ON manager_report_data(location_id, report_type, uploaded_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_guard_tasks ON guard_tasks(location_id, task_date);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_guard_task_history ON guard_task_history(location_id, task_date, saved_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_log ON activity_log(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_location_date ON observations(location_id, date);`);
}
ensureSchema();

// -------------------- Lockout per IP --------------------
const ipAuthState = new Map();

function nowISO() { return new Date().toISOString(); }

const MANAGER_REPORT_TYPES = new Set(["retention", "aged_accounts", "drop_list", "balance_list", "billing"]);

function getLocationById(locId) {
  return db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locId);
}

function safeExportFilename(name) {
  const filename = String(name || "");
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return null;
  }
  return filename;
}

function getIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function sha(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function isLocked(ip) {
  const st = ipAuthState.get(ip);
  if (!st) return false;
  if (!st.lockedUntil) return false;
  return Date.now() < st.lockedUntil;
}

function recordFail(ip) {
  const st = ipAuthState.get(ip) || { fails: 0, lockedUntil: 0 };
  st.fails += 1;
  if (st.fails >= MAX_FAILS) {
    st.lockedUntil = Date.now() + LOCKOUT_MS;
    st.fails = 0;
  }
  ipAuthState.set(ip, st);
  return st;
}

function clearFail(ip) {
  ipAuthState.set(ip, { fails: 0, lockedUntil: 0 });
}

function verifyManagerCode(input) {
  return sha(input || "") === sha(MANAGER_CODE);
}

function audit(req, action, payload = {}) {
  const ip = getIP(req);
  const device_mode = payload.device_mode || null;
  const details = payload.details ? JSON.stringify(payload.details) : null;

  db.prepare(`
    INSERT INTO audit_log(at, ip, device_mode, action, date, start_time, swimmer_name, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowISO(),
    ip,
    device_mode,
    action,
    payload.date || null,
    payload.start_time || null,
    payload.swimmer_name || null,
    details
  );
}

function logActivity(action, { location_id = null, initials = null, details = null } = {}) {
  db.prepare(`
    INSERT INTO activity_log(action, location_id, initials, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    action,
    location_id,
    initials || null,
    details ? JSON.stringify(details) : null,
    nowISO()
  );
}

// -------------------- Helpers --------------------
function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
// ---- Active roster date (persisted) ----
function getActiveDate() {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get("activeDate");
    const v = row?.value ? String(row.value) : null;
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  } catch (_) {}
  return null;
}

function setActiveDate(date) {
  const d = String(date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  db.prepare(`
    INSERT INTO app_state(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run("activeDate", d);
}

function getManagerDateRange() {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get("managerDateRange");
    if (!row?.value) return null;
    const parsed = JSON.parse(String(row.value));
    if (!parsed?.start || !parsed?.end) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.start)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.end)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function setManagerDateRange(start, end) {
  const s = String(start || "").trim();
  const e = String(end || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return null;
  if (s > e) return null;
  const payload = JSON.stringify({ start: s, end: e });
  db.prepare(`
    INSERT INTO app_state(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run("managerDateRange", payload);
  return { start: s, end: e };
}

function getReadOnlyMode() {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get("readOnlyMode");
    return row?.value === "true";
  } catch (_) {
    return false;
  }
}

function setReadOnlyMode(enabled) {
  db.prepare(`
    INSERT INTO app_state(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run("readOnlyMode", enabled ? "true" : "false");
  return enabled ? true : false;
}

function activeOrToday() {
  return getActiveDate() || todayISO();
}

// ---- Date parsing helpers ----
function parseDateFromFilename(filename) {
  const base = path.basename(String(filename || "")).trim();
  if (!base) return null;

  // YYYY-MM-DD
  let m = base.match(/(\d{4})[-_\.](\d{2})[-_\.](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // MM-DD-YYYY
  m = base.match(/(\d{2})[-_\.](\d{2})[-_\.](\d{4})/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;

  return null;
}

function parseDateFromText(text) {
  const t = String(text || "");

  // YYYY-MM-DD
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // MM/DD/YYYY
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }

  return null;
}

function parseDateFromHTML(html) {
  const stripped = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return parseDateFromText(stripped);
}

function parseLocationFromHTML(html) {
  const stripped = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const match = stripped.match(/Location\s*:\s*([A-Za-z0-9\s\-&]+)/i);
  return match && match[1] ? match[1].trim() : null;
}

function parseHTMLTable(html) {
  const $ = cheerio.load(html || "");
  const tables = $("table");
  if (!tables.length) return { headers: [], rows: [] };
  let best = null;
  tables.each((_, table) => {
    const $table = $(table);
    const headers = $table.find("tr").first().find("th,td").map((__, cell) => $(cell).text().trim()).get();
    const rows = [];
    $table.find("tr").slice(1).each((__, row) => {
      const cols = $(row).find("td,th").map((___, cell) => $(cell).text().trim()).get();
      if (cols.length) rows.push(cols);
    });
    if (!best || rows.length > best.rows.length) {
      best = { headers, rows };
    }
  });
  return best || { headers: [], rows: [] };
}

function parseRetentionReport(html) {
  const $ = cheerio.load(html || "");
  const warnings = [];
  const instructors = [];
  const tables = $("table").toArray();
  if (!tables.length) warnings.push("No retention tables detected.");

  const tableSet = new Set(tables);
  const nodes = $("body").find("*").toArray();

  const extractPercent = (table) => {
    const cell = $(table).find("tr").first().find("th,td").eq(1);
    const text = cell.text().trim();
    const match = text.match(/-?\d+(\.\d+)?/);
    return match ? parseFloat(match[0]) : null;
  };

  const extractSwimmerCount = (tableList) => {
    for (const table of tableList) {
      const rows = $(table).find("tr");
      for (let i = 0; i < rows.length; i += 1) {
        const cells = $(rows[i]).find("th,td").toArray();
        for (let j = 0; j < cells.length; j += 1) {
          const text = $(cells[j]).text().trim().toLowerCase();
          if (text.includes("swimmer") || text.includes("student") || text.includes("count")) {
            const nextCell = cells[j + 1];
            if (nextCell) {
              const numMatch = $(nextCell).text().match(/-?\d+(\.\d+)?/);
              if (numMatch) return parseFloat(numMatch[0]);
            }
          }
        }
      }
    }
    return null;
  };

  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (tableSet.has(node)) {
      i += 1;
      continue;
    }
    const text = $(node).text().replace(/\s+/g, " ").trim();
    const isCandidate = text.length > 1 && text.length < 60 && /[a-z]/i.test(text);
    if (!isCandidate) {
      i += 1;
      continue;
    }
    const tableList = [];
    let j = i + 1;
    while (j < nodes.length && tableList.length < 4) {
      if (tableSet.has(nodes[j])) tableList.push(nodes[j]);
      j += 1;
    }
    if (tableList.length === 4) {
      const retentionPercent = extractPercent(tableList[1]);
      const swimmerCount = extractSwimmerCount(tableList);
      instructors.push({
        instructor: text,
        retention_percent: retentionPercent,
        swimmer_count: swimmerCount
      });
      i = j;
      continue;
    }
    i += 1;
  }

  if (!instructors.length) {
    const { headers, rows } = parseHTMLTable(html);
    if (!rows.length) warnings.push("No retention rows detected.");
    const headerMap = headers.map((h) => h.toLowerCase());
    const instructorIdx = headerMap.findIndex((h) => h.includes("instructor") || h.includes("coach"));
    const percentIdx = headerMap.findIndex((h) => h.includes("%") || h.includes("retention"));
    const countIdx = headerMap.findIndex((h) => h.includes("swimmer") || h.includes("count"));
    rows.forEach((cols) => {
      const instructor = cols[instructorIdx >= 0 ? instructorIdx : 0] || "";
      const percentRaw = cols[percentIdx >= 0 ? percentIdx : 1] || "";
      const countRaw = cols[countIdx >= 0 ? countIdx : 2] || "";
      const percentMatch = String(percentRaw).match(/-?\d+(\.\d+)?/);
      const countMatch = String(countRaw).match(/-?\d+(\.\d+)?/);
      if (instructor.trim()) {
        instructors.push({
          instructor: instructor.trim(),
          retention_percent: percentMatch ? parseFloat(percentMatch[0]) : null,
          swimmer_count: countMatch ? parseFloat(countMatch[0]) : null
        });
      }
    });
  }

  if (!instructors.length) warnings.push("No instructors detected in retention report.");
  return { instructors, warnings };
}

function parseAgedAccountsReport(html) {
  const { headers, rows } = parseHTMLTable(html);
  const warnings = [];
  if (!rows.length) warnings.push("No aged accounts rows detected.");
  return { headers, rows, warnings };
}

function parseDropListReport(html) {
  const { headers, rows } = parseHTMLTable(html);
  const warnings = [];
  if (!rows.length) warnings.push("No drop list rows detected.");
  const entries = rows.map((cols) => {
    const raw = cols.join(" ");
    const date = parseDateFromText(raw);
    return { raw: cols, drop_date: date || null };
  });
  if (!entries.some((e) => e.drop_date)) warnings.push("No drop dates detected in drop list.");
  return { headers, entries, warnings };
}

function calculateBundle({ durationWeeks, monthlyPrice, startDate }) {
  const weeks = Number(durationWeeks || 0);
  const monthly = Number(monthlyPrice || 0);
  if (![12, 24, 52].includes(weeks)) {
    return { ok: false, error: "Invalid duration weeks" };
  }
  if (!monthly || Number.isNaN(monthly) || monthly <= 0) {
    return { ok: false, error: "Invalid monthly price" };
  }
  const months = weeks / 4;
  const discountRate = weeks === 12 ? 0.15 : 0.2;
  const discountedMonthly = monthly * (1 - discountRate);
  const totalBilled = discountedMonthly * months;
  const baseTotal = monthly * months;
  const discountAmount = baseTotal - totalBilled;
  const houseCredit = discountAmount + (weeks === 52 ? 50 : 0);
  let expirationDate = null;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    const start = new Date(`${startDate}T00:00:00`);
    start.setDate(start.getDate() + weeks * 7);
    expirationDate = start.toISOString().split("T")[0];
  }
  return {
    ok: true,
    discountedMonthly,
    totalBilled,
    houseCredit,
    expirationDate
  };
}


function todayRollSheetFilename() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `Roll_Sheets_${mm}-${dd}-${yyyy}.pdf`;
}

function normalizeWhitespaceLines(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normalizeTimeTo24h(raw) {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!m) return null;

  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];

  if (ap === "pm" && hh !== 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseDateRangeFromSectionText(text) {
  const t = String(text || "");
  const rangeMatch = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:→|->|–|-)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!rangeMatch) return null;

  const startMonth = String(rangeMatch[1]).padStart(2, "0");
  const startDay = String(rangeMatch[2]).padStart(2, "0");
  const startYear = rangeMatch[3];
  const endMonth = String(rangeMatch[4]).padStart(2, "0");
  const endDay = String(rangeMatch[5]).padStart(2, "0");
  const endYear = rangeMatch[6];

  return {
    start: `${startYear}-${startMonth}-${startDay}`,
    end: `${endYear}-${endMonth}-${endDay}`,
    startYear: Number(startYear),
    endYear: Number(endYear),
    startMonth: Number(startMonth),
    startDay: Number(startDay)
  };
}

function inferYearFromRange(month, day, range) {
  const mm = Number(month);
  const dd = Number(day);
  if (!range || !range.startYear || !range.endYear) return new Date().getFullYear();
  if (range.startYear === range.endYear) return range.startYear;

  if (mm > range.startMonth || (mm === range.startMonth && dd >= range.startDay)) {
    return range.startYear;
  }
  return range.endYear;
}

function extractDateTimeFromHeader(text, range, fallbackTime) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const dateMatch = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (!dateMatch) return null;

  const month = String(dateMatch[1]).padStart(2, "0");
  const day = String(dateMatch[2]).padStart(2, "0");
  const year = dateMatch[3] ? Number(dateMatch[3]) : inferYearFromRange(month, day, range);
  const dateISO = `${year}-${month}-${day}`;

  const timeMatch = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  let startTime = fallbackTime || null;
  if (timeMatch) {
    const timeRaw = `${timeMatch[1]}:${timeMatch[2] || "00"} ${timeMatch[3]}`;
    startTime = normalizeTimeTo24h(timeRaw) || startTime;
  }

  return { dateISO, startTime };
}

function parseRosterDateColumns($, $table, range, fallbackTime) {
  const headerRows = $table.find("thead tr");
  const rowsToScan = headerRows.length ? headerRows.toArray() : $table.find("tr").slice(0, 2).toArray();

  for (const row of rowsToScan) {
    const $row = $(row);
    const columns = [];
    let colIndex = 0;

    $row.find("th, td").each((_, cell) => {
      const $cell = $(cell);
      const colSpan = parseInt($cell.attr("colspan") || "1", 10);
      const info = extractDateTimeFromHeader($cell.text(), range, fallbackTime);

      for (let i = 0; i < colSpan; i += 1) {
        if (info && i === 0) {
          columns.push({
            index: colIndex,
            date: info.dateISO,
            start_time: info.startTime || fallbackTime || null
          });
        }
        colIndex += 1;
      }
    });

    if (columns.length > 0) return columns;
  }

  return [];
}

function hasAutoAbsentIndicator($cell, $) {
  if (!$cell || !$cell.length) return false;
  const text = $cell.text().toLowerCase();
  if (text.includes("ø") || text.includes("⌀") || text.includes("⊘")) return true;

  let hasCancel = false;
  $cell.find("img").each((_, img) => {
    const src = String($(img).attr("src") || "").toLowerCase();
    const alt = String($(img).attr("alt") || "").toLowerCase();
    const title = String($(img).attr("title") || "").toLowerCase();
    const filename = src.split("/").pop() || "";
    const blob = `${src} ${alt} ${title} ${filename}`;
    if (blob.includes("cancel")) {
      hasCancel = true;
    }
  });
  return hasCancel;
}

function isAbsentAttendanceCell($cell, $) {
  if (!$cell || !$cell.length) return false;

  const text = $cell.text().toLowerCase();
  if (text.includes("absent") || text.includes("no show") || text.includes("noshow")) return true;
  if (text.includes("ø") || text.includes("⌀") || text.includes("⊘")) return true;

  const styleStrike = $cell.find('[style*="line-through"], [style*="line-through"]').length > 0;
  if (styleStrike) return true;

  const classStrike = $cell.find('[class*="absent"], [class*="no-show"], [class*="noshow"], [class*="strike"]').length > 0;
  if (classStrike) return true;

  if (hasAutoAbsentIndicator($cell, $)) return true;

  let isAbsent = false;
  $cell.find("img").each((_, img) => {
    const src = String($(img).attr("src") || "").toLowerCase();
    const alt = String($(img).attr("alt") || "").toLowerCase();
    const title = String($(img).attr("title") || "").toLowerCase();
    const blob = `${src} ${alt} ${title}`;
    if (
      blob.includes("x-modifier") ||
      blob.includes("absent") ||
      blob.includes("no-show") ||
      blob.includes("noshow") ||
      (blob.includes("circle") && (blob.includes("slash") || blob.includes("strike")))
    ) {
      isAbsent = true;
    }
  });

  return isAbsent;
}

function formatTime12h(t) {
  const [hh, mm] = t.split(":").map(Number);
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  if (mm === 0) return `${h12} ${ampm}`;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

function formatRosterTimeLabel(t) {
  const raw = String(t || "").trim();
  if (!raw) return "—";
  if (/am|pm/i.test(raw)) return raw;
  if (!raw.includes(":")) return raw;
  return formatTime12h(raw);
}

function lastFirstToFirstLast(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  const parts = t.split(",");
  if (parts.length >= 2) {
    const last = parts[0].trim();
    const first = parts.slice(1).join(",").trim();
    return `${first} ${last}`.replace(/\s+/g, " ").trim();
  }
  return t;
}

function cleanAgeText(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(\d+)\s*y(?:\s*(\d+)\s*m)?/i);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = m[2] ? parseInt(m[2], 10) : 0;
    if (mo === 0) return `${y}y`;
    return `${y}y ${mo}m`;
  }
  return t;
}

function normalizeAgeText(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = t.match(/(\d+)\s*(?:y|yr|yrs|year|years)(?:\s*(\d+)\s*(?:m|mo|mos|month|months))?/i);
  if (m) {
    const normalized = `${m[1]}y${m[2] ? ` ${m[2]}m` : ""}`;
    return cleanAgeText(normalized);
  }
  return null;
}

function normalizeProgramNonGroup(rawProgram) {
  const p = String(rawProgram || "").replace(/\s+/g, " ").trim();
  if (!p) return null;

  const up = p.toUpperCase();
  if (up.startsWith("PRIVATE")) return "Private";
  if (up.startsWith("SEMI-PRIVATE") || up.startsWith("SEMI PRIVATE")) return "Semi-Private";
  if (up.startsWith("PARENTTOT") || up.startsWith("PARENT TOT")) return "ParentTot";
  if (up.startsWith("TODDLER TRANSITION") || up.startsWith("TODDLER")) return "Toddler Transition";
  if (up.startsWith("ADULT")) return "Adult";
  return p;
}

function detectFlags(contextText) {
  const s = String(contextText || "");
  const up = s.toUpperCase();

  const hasToken = (re) => re.test(up);

  const flag_new =
    hasToken(/⭐|★/) ||
    hasToken(/\bFIRST\s*DAY\b/) ||
    hasToken(/\bFIRST\s*TIME\b/) ||
    hasToken(/\bNEW\b/) ||
    hasToken(/\bFD\b/) ||
    hasToken(/\bFIRST\b/);

  const flag_makeup =
    hasToken(/\bMAKE\s*UP\b/) ||
    hasToken(/\bMAKEUP\b/) ||
    hasToken(/\bMKUP\b/) ||
    hasToken(/\bMU\b/) ||
    hasToken(/\bM\/U\b/) ||
    hasToken(/\bMUA\b/);

  const flag_policy =
    hasToken(/\bMISSING\s*WAIVER\b/) ||
    hasToken(/\bMISSING\s*POLICY\b/) ||
    hasToken(/\bWAIVER\b/) ||
    hasToken(/\bPOLICY\b/) ||
    hasToken(/\bMP\b/);

  const flag_owes =
    hasToken(/\bOWES\b/) ||
    hasToken(/\bOWE\b/) ||
    hasToken(/\bUNPAID\b/) ||
    hasToken(/\bPAST\s*DUE\b/) ||
    hasToken(/\bBALANCE\b/) ||
    hasToken(/\bDUE\b/) ||
    hasToken(/\$/);

  const flag_trial =
    hasToken(/\bTRIAL\b/) ||
    hasToken(/\bTR\b/) ||
    hasToken(/\bTR\.\b/) ||
    hasToken(/\bTRIAL\s*CLASS\b/);

  return {
    flag_new: flag_new ? 1 : 0,
    flag_makeup: flag_makeup ? 1 : 0,
    flag_policy: flag_policy ? 1 : 0,
    flag_owes: flag_owes ? 1 : 0,
    flag_trial: flag_trial ? 1 : 0,
  };
}

// -------------------- PDF extraction --------------------
function pdftotextToString(pdfPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("pdftotext", ["-layout", pdfPath, "-"]);
    let out = "";
    let err = "";

    proc.stdout.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d) => (err += d.toString("utf8")));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`pdftotext failed (code ${code}): ${err || "unknown error"}`));
      resolve(out);
    });
  });
}

async function getTodayPdfText() {
  const filename = todayRollSheetFilename();
  const fullPath = path.join(SCHEDULE_DIR, filename);

  if (!fs.existsSync(fullPath)) {
    return { ok: false, error: "PDF not found", filename, fullPath };
  }

  try {
    const text = await pdftotextToString(fullPath);
    return { ok: true, method: "pdftotext", filename, fullPath, text };
  } catch (e) {
    return {
      ok: false,
      error: "Failed to read PDF via pdftotext",
      filename,
      fullPath,
      details: String(e?.stack || e?.message || e),
    };
  }
}

// -------------------- Parse roster lines --------------------
function parseRosterFromLines(lines) {
  const rows = [];

  let currentStartTime = null;
  let currentInstructor = null;
  let currentZone = null;
  let currentProgram = null;

  const isHeaderOrNoise = (s) => {
    if (!s) return true;
    if (s.startsWith("Student Medical")) return true;
    if (s.startsWith("CLA-")) return true;
    if (s.includes("Page ") && s.includes(" of ")) return true;
    return false;
  };

  const isAgeLine = (s) => {
    if (/^\d+\s*(y|m)\b/i.test(s)) return true;
    if (s.includes("•")) return true;
    if (s.toLowerCase().includes("allerg")) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("Schedule:")) {
      const timeMatch = line.match(/Schedule:\s+\w+\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      const instMatch = line.match(/Instructors:\s+(.*?)\s+Program:/i);
      const zoneMatch = line.match(/Zone:\s+Zone\s+([1-4])/i);
      const programMatch = line.match(/Program:\s+(.*?)\s+Zone:/i);

      currentStartTime = timeMatch ? normalizeTimeTo24h(timeMatch[1]) : null;

      const instRaw = instMatch ? instMatch[1] : null;
      currentInstructor = instRaw ? lastFirstToFirstLast(instRaw) : null;

      currentZone = zoneMatch ? parseInt(zoneMatch[1], 10) : null;

      const rawProgram = programMatch ? String(programMatch[1]).trim() : null;
      const upProg = String(rawProgram || "").toUpperCase();

      if (upProg === "GROUP") {
        let found = null;
        for (let back = 1; back <= 16; back++) {
          const prev = String(lines[i - back] || "").trim();
          const m = prev.match(
            /^GROUP:\s*(.+?)\s+on\s+\w{3}\s*:\s*\d{1,2}(?::\d{2})?\s*-\s*\d{1,2}(?::\d{2})?\s+with\s+/i
          );
          if (m) {
            found = `GROUP: ${m[1].trim()}`;
            break;
          }
        }
        currentProgram = found || "GROUP";
      } else {
        currentProgram = normalizeProgramNonGroup(rawProgram);
      }

      continue;
    }

    if (!currentStartTime || !currentInstructor || !currentZone) continue;
    if (isHeaderOrNoise(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (isAgeLine(line)) continue;

    const upper = line.toUpperCase();
    if (
      upper.startsWith("GROUP:") ||
      upper.startsWith("PRIVATE:") ||
      upper.startsWith("SEMI-PRIVATE:") ||
      upper.startsWith("SEMI PRIVATE:") ||
      upper.startsWith("ADULT:") ||
      upper.startsWith("PARENTTOT:") ||
      upper.startsWith("PARENT TOT:") ||
      upper.startsWith("TODDLER") ||
      upper.startsWith("15% OFF:")
    ) {
      continue;
    }

    let swimmerName = null;
    let rawNameLine = line;

    if (line.endsWith(",")) {
      const next = lines[i + 1] || "";
      const m = next.match(/^\d+\s+(.+)$/);
      if (m) {
        swimmerName = `${line} ${m[1]}`.replace(/\s+/g, " ").trim();
        i += 1;
      }
    }

    if (!swimmerName) {
      const next = lines[i + 1] || "";
      if (/^\d+$/.test(next)) {
        swimmerName = line.trim();
        i += 1;
      }
    }

    if (!swimmerName) {
      const m = line.match(/^\d+\s+(.+)$/);
      if (m) swimmerName = m[1].trim();
    }

    if (swimmerName) {
      let ageText = null;
      const nextLine = lines[i + 1] || "";
      if (isAgeLine(nextLine)) ageText = cleanAgeText(nextLine);

      const ctx = [
        rawNameLine,
        lines[i + 1] || "",
        lines[i + 2] || "",
        lines[i - 1] || "",
        lines[i - 2] || "",
      ].join("  ");

      const flags = detectFlags(ctx);

      rows.push({
        start_time: currentStartTime,
        swimmer_name: lastFirstToFirstLast(swimmerName.replace(/[★⭐*]/g, "").trim()),
        instructor_name: currentInstructor,
        zone: currentZone,
        program: currentProgram,
        age_text: ageText,
        ...flags
      });
    }
  }

  return rows;
}

// -------------------- Audio helpers --------------------
function playWav(wavPath) {
  return new Promise((resolve, reject) => {
    const player = spawn("aplay", [wavPath]);
    player.on("error", reject);
    player.on("close", () => resolve());
  });
}

function playPing() {
  return new Promise((resolve) => {
    if (!fs.existsSync(PING_WAV)) return resolve();
    playWav(PING_WAV).then(resolve).catch(() => resolve());
  });
}

let speakQueue = Promise.resolve();
let lastAnnouncement = { text: null, at: null };

function speakWithPiper(text) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PIPER_BIN)) return reject(new Error(`Piper binary not found: ${PIPER_BIN}`));
    if (!fs.existsSync(VOICE_MODEL)) return reject(new Error(`Voice model not found: ${VOICE_MODEL}`));

    // Set LD_LIBRARY_PATH to include the piper directory for shared libraries
    const piperDir = path.dirname(PIPER_BIN);
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: piperDir + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : '')
    };

    const p = spawn(PIPER_BIN, ["--model", VOICE_MODEL, "--output_file", TTS_OUT_WAV], { env });
    let err = "";

    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("error", (e) => reject(e));

    p.stdin.write(text);
    p.stdin.end();

    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`piper failed (${code}): ${err || "unknown error"}`));
      playWav(TTS_OUT_WAV).then(resolve).catch(reject);
    });
  });
}

function speakAnnouncement(text, opts = {}) {
  const { ping = true } = opts;
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return Promise.resolve({ ok: false, error: "empty text" });

  speakQueue = speakQueue.then(async () => {
    lastAnnouncement = { text: cleaned, at: nowISO() };
    if (ping) {
      await playPing();
      await new Promise((r) => setTimeout(r, 350));
    }
    await speakWithPiper(cleaned);
  });

  return speakQueue.then(() => ({ ok: true, text: cleaned, at: lastAnnouncement.at }));
}

// -------------------- API --------------------
app.get("/api/status", (req, res) => {
  const activeDate = activeOrToday();
  const managerDateRange = getManagerDateRange();

  const expectedPdf = `Roll_Sheets_${activeDate.slice(5,7)}-${activeDate.slice(8,10)}-${activeDate.slice(0,4)}.pdf`;
  const pdfPath = path.join(SCHEDULE_DIR, expectedPdf);

  const htmlPath = path.join(SCHEDULE_DIR, "Roll Sheets.html");

  const pdfExists = fs.existsSync(pdfPath);
  const htmlExists = fs.existsSync(htmlPath);

  res.json({
    ok: true,
    todayISO: todayISO(),
    activeDate,
    expectedPdf,
    pdfExists,
    pdfSizeBytes: pdfExists ? fs.statSync(pdfPath).size : 0,
    htmlExists,
    htmlSizeBytes: htmlExists ? fs.statSync(htmlPath).size : 0,
    piperBinExists: fs.existsSync(PIPER_BIN),
    voiceModelExists: fs.existsSync(VOICE_MODEL),
    managerDateRange,
    lastAnnouncement
  });
});

app.post("/api/set-active-date", (req, res) => {
  try {
    const { date } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ ok: false, error: "invalid date" });
    }
    setActiveDate(date);
    audit(req, "set_active_date", { date });
    res.json({ ok: true, activeDate: activeOrToday() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "set-active-date failed", details: String(e?.stack || e?.message || e) });
  }
});

app.post("/api/manager-date-range", (req, res) => {
  try {
    const { start, end } = req.body || {};
    const saved = setManagerDateRange(start, end);
    if (!saved) return res.status(400).json({ ok: false, error: "invalid date range" });
    audit(req, "set_manager_date_range", { start: saved.start, end: saved.end });
    res.json({ ok: true, range: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: "manager-date-range failed", details: String(e?.stack || e?.message || e) });
  }
});

app.get("/api/manager-date-range", (req, res) => {
  try {
    res.json({ ok: true, range: getManagerDateRange() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "manager-date-range failed", details: String(e?.stack || e?.message || e) });
  }
});

app.post("/api/import-today", async (req, res) => {
  try {
    const pdf = await getTodayPdfText();
    if (!pdf.ok) return res.status(400).json({ ok: false, error: pdf.error, details: pdf.details, filename: pdf.filename });

    const lines = normalizeWhitespaceLines(pdf.text);
    const parsed = parseRosterFromLines(lines);

    const date = activeOrToday();
    const now = nowISO();

    const ins = db.prepare(`
      INSERT INTO roster (
        date, start_time, swimmer_name,
        instructor_name, zone, program, age_text,
        attendance, attendance_at, attendance_auto_absent,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        NULL, NULL, 0,
        0,
        ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(date, start_time, swimmer_name) DO UPDATE SET
        instructor_name=excluded.instructor_name,
        zone=excluded.zone,
        program=excluded.program,
        age_text=excluded.age_text,
        attendance_auto_absent=excluded.attendance_auto_absent,
        flag_new=excluded.flag_new,
        flag_makeup=excluded.flag_makeup,
        flag_policy=excluded.flag_policy,
        flag_owes=excluded.flag_owes,
        flag_trial=excluded.flag_trial,
        updated_at=excluded.updated_at
    `);

    const tx = db.transaction((rows) => {
      for (const r of rows) {
        ins.run(
          date, r.start_time, r.swimmer_name,
          r.instructor_name || null, r.zone || null, r.program || null, r.age_text || null,
          r.flag_new || 0, r.flag_makeup || 0, r.flag_policy || 0, r.flag_owes || 0, r.flag_trial || 0,
          now, now
        );
      }
    });

    tx(parsed);

    audit(req, "import_today", {
      device_mode: req.body?.device_mode || null,
      details: { parsed_count: parsed.length }
    });

    res.json({ ok: true, imported: parsed.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Import failed", details: String(e?.stack || e?.message || e) });
  }
});

app.get("/api/blocks", (req, res) => {
  const date = activeOrToday();
  const location_id = req.query.location_id || req.session?.location_id || 1;

  const rows = db.prepare(`
    SELECT DISTINCT start_time
    FROM roster
    WHERE date = ? AND location_id = ?
    ORDER BY start_time ASC
  `).all(date, location_id);

  res.json({ ok: true, blocks: rows.map(r => r.start_time) });
});

app.get("/api/blocks/:start_time", (req, res) => {
  const date = activeOrToday();
  const start_time = req.params.start_time;
  const location_id = req.query.location_id || req.session?.location_id || 1;

  const kids = db.prepare(`
    SELECT
      swimmer_name,
      instructor_name,
      substitute_instructor,
      is_substitute,
      original_instructor,
      zone,
      program,
      age_text,
      attendance,
      attendance_auto_absent,
      is_addon,
      zone_overridden,
      flag_new, flag_makeup, flag_policy, flag_owes, flag_trial
    FROM roster
    WHERE date = ? AND start_time = ? AND location_id = ?
  `).all(date, start_time, location_id);

  res.json({ ok: true, kids });
});
// Safety issues endpoint
app.get("/api/safety-issues", (req, res) => {
  try {
    res.json({ ok: true, issues: [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/update-flags", (req, res) => {
  try {
    const ip = getIP(req);
    const { start_time, swimmer_name, device_mode, flags } = req.body || {};
    if (!start_time || !swimmer_name || !flags) return res.status(400).json({ ok: false, error: "missing fields" });

    const date = activeOrToday();
    const now = nowISO();

    db.prepare(`
      UPDATE roster SET
        flag_new = ?,
        flag_makeup = ?,
        flag_policy = ?,
        flag_owes = ?,
        flag_trial = ?,
        updated_at = ?
      WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).run(
      flags.flag_new ? 1 : 0,
      flags.flag_makeup ? 1 : 0,
      flags.flag_policy ? 1 : 0,
      flags.flag_owes ? 1 : 0,
      flags.flag_trial ? 1 : 0,
      now,
      date,
      start_time,
      swimmer_name
    );

    audit(req, "update_flags", { device_mode, date, start_time, swimmer_name, details: { by: ip, flags } });

    const row = db.prepare(`
      SELECT flag_new, flag_makeup, flag_policy, flag_owes, flag_trial
      FROM roster WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).get(date, start_time, swimmer_name);

    res.json({ ok: true, flags: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: "update flags failed", details: String(e?.stack || e?.message || e) });
  }
});

// -------------------- Missing endpoints (wired by the UI) --------------------

// Attendance: 1 = here, 0 = absent, null = clear
app.post("/api/attendance", (req, res) => {
  try {
    const { start_time, swimmer_name, attendance, device_mode } = req.body || {};
    if (!start_time || !swimmer_name) return res.status(400).json({ ok: false, error: "missing fields" });

    const date = activeOrToday();
    const now = nowISO();

    let att = null;
    if (attendance === 0 || attendance === "0") att = 0;
    if (attendance === 1 || attendance === "1") att = 1;

    db.prepare(`
      UPDATE roster SET
        attendance = ?,
        attendance_at = ?,
        updated_at = ?
      WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).run(att, att === null ? null : now, now, date, start_time, swimmer_name);

    audit(req, "attendance", { device_mode, date, start_time, swimmer_name, details: { attendance: att } });

    res.json({ ok: true, attendance: att, at: now });
  } catch (e) {
    res.status(500).json({ ok: false, error: "attendance update failed", details: String(e?.stack || e?.message || e) });
  }
});

app.post("/api/attendance/bulk", (req, res) => {
  try {
    const { start_time, attendance, location_id, initials } = req.body || {};
    if (!start_time) return res.status(400).json({ ok: false, error: "missing start_time" });
    const locId = Number(location_id || 1);
    const date = activeOrToday();
    const now = nowISO();
    const att = attendance === 1 || attendance === "1" ? 1 : null;
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "initials required" });
    }

    db.prepare(`
      UPDATE roster SET attendance = ?, attendance_at = ?, updated_at = ?
      WHERE date = ? AND start_time = ? AND location_id = ?
    `).run(att, att === null ? null : now, now, date, start_time, locId);

    audit(req, "attendance_bulk", { date, start_time, details: { attendance: att, initials: initialsClean } });
    logActivity("attendance_bulk", { location_id: locId, initials: initialsClean, details: { start_time, attendance: att } });
    res.json({ ok: true, attendance: att });
  } catch (e) {
    res.status(500).json({ ok: false, error: "attendance bulk failed", details: String(e?.stack || e?.message || e) });
  }
});

// Zone update: requires manager_code in deck mode
app.post("/api/update-zone", (req, res) => {
  try {
    const ip = getIP(req);
    const { start_time, swimmer_name, new_zone, device_mode, manager_code } = req.body || {};
    if (!start_time || !swimmer_name || !new_zone) return res.status(400).json({ ok: false, error: "missing fields" });

    const zoneInt = parseInt(new_zone, 10);
    if (![1,2,3,4].includes(zoneInt)) return res.status(400).json({ ok: false, error: "invalid zone", details: { zone } });

    if (String(device_mode || "").toLowerCase() === "deck") {
      if (isLocked(ip)) return res.status(429).json({ ok: false, error: "Manager code locked. Try again in 2 minutes." });

      if (!verifyManagerCode(manager_code)) {
        const st = recordFail(ip);
        const locked = isLocked(ip);
        return res.status(401).json({
          ok: false,
          error: locked ? "Too many failed attempts. Locked for 2 minutes." : "Invalid manager code",
          details: { fails_remaining: locked ? 0 : (MAX_FAILS - (st.fails || 0)) }
        });
      }
      clearFail(ip);
    }

    const date = activeOrToday();
    const now = nowISO();

    db.prepare(`
      UPDATE roster SET
        zone = ?,
        zone_overridden = 1,
        zone_override_at = ?,
        zone_override_by = ?,
        updated_at = ?
      WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).run(zoneInt, now, ip, now, date, start_time, swimmer_name);

    audit(req, "update_zone", { device_mode, date, start_time, swimmer_name, details: { new_zone: zoneInt, by: ip } });

    res.json({ ok: true, zone: zoneInt });
  } catch (e) {
    res.status(500).json({ ok: false, error: "update zone failed", details: String(e?.stack || e?.message || e) });
  }
});

// Add swimmer (add-on)
app.post("/api/add-swimmer", (req, res) => {
  try {
    const { start_time, swimmer_name, instructor_name, zone, program, age_text, device_mode, location_id } = req.body || {};
    if (!start_time || !swimmer_name) return res.status(400).json({ ok: false, error: "missing fields" });

    const date = activeOrToday();
    const now = nowISO();
    const locId = location_id || 1;

    const z = zone === "" || zone === undefined || zone === null ? null : parseInt(zone, 10);
    if (z !== null && ![1,2,3,4].includes(z)) return res.status(400).json({ ok: false, error: "invalid zone", details: { zone } });

    db.prepare(`
      INSERT INTO roster (
        date, start_time, swimmer_name,
        instructor_name, zone, program, age_text,
        attendance, attendance_at, attendance_auto_absent,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        location_id,
        created_at, updated_at,
        zone_overridden, zone_override_at, zone_override_by
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        NULL, NULL, 0,
        1,
        0,0,0,0,0,
        ?,
        ?, ?,
        0, NULL, NULL
      )
      ON CONFLICT(date, start_time, swimmer_name) DO UPDATE SET
        instructor_name=excluded.instructor_name,
        zone=excluded.zone,
        program=excluded.program,
        age_text=excluded.age_text,
        is_addon=1,
        location_id=excluded.location_id,
        updated_at=excluded.updated_at
    `).run(
      date, start_time, swimmer_name,
      instructor_name || null,
      z,
      program || null,
      age_text || null,
      locId,
      now, now
    );

    audit(req, "add_swimmer", { device_mode, date, start_time, swimmer_name, details: { is_addon: true, zone: z } });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "add swimmer failed", details: String(e?.stack || e?.message || e) });
  }
});

// Remove add-on swimmer only
app.post("/api/remove-addon", (req, res) => {
  try {
    const { start_time, swimmer_name, device_mode, initials } = req.body || {};
    if (!start_time || !swimmer_name) return res.status(400).json({ ok: false, error: "missing fields" });
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) return res.status(400).json({ ok: false, error: "initials required" });

    const date = activeOrToday();
    const info = db.prepare(`
      SELECT is_addon FROM roster WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).get(date, start_time, swimmer_name);

    if (!info) return res.status(404).json({ ok: false, error: "not found" });
    if (!info.is_addon) return res.status(400).json({ ok: false, error: "not an add-on" });

    db.prepare(`
      DELETE FROM roster WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).run(date, start_time, swimmer_name);

    audit(req, "remove_addon", { device_mode, date, start_time, swimmer_name, details: { initials: initialsClean } });
    logActivity("remove_addon", { location_id: null, initials: initialsClean, details: { swimmer_name, start_time, date } });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "remove add-on failed", details: String(e?.stack || e?.message || e) });
  }
});

// Speak typed announcement
app.post("/api/speak", async (req, res) => {
  try {
    const { text, device_mode } = req.body || {};
    const out = await speakAnnouncement(text, { ping: true });
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "speech failed" });

    audit(req, "speak", { device_mode, details: { text: out.text } });
    res.json({ ok: true, lastAnnouncement });
  } catch (e) {
    res.status(500).json({ ok: false, error: "speak failed", details: String(e?.stack || e?.message || e) });
  }
});

// Repeat last announcement
app.post("/api/repeat-last", async (req, res) => {
  try {
    const { device_mode } = req.body || {};
    if (!lastAnnouncement?.text) return res.status(400).json({ ok: false, error: "No last announcement yet" });

    const out = await speakAnnouncement(lastAnnouncement.text, { ping: true });
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "speech failed" });

    audit(req, "repeat_last", { device_mode });
    res.json({ ok: true, lastAnnouncement });
  } catch (e) {
    res.status(500).json({ ok: false, error: "repeat failed", details: String(e?.stack || e?.message || e) });
  }
});

// Force time-block announcement
app.post("/api/force-time-announcement", async (req, res) => {
  try {
    const { start_time, device_mode } = req.body || {};
    if (!start_time) return res.status(400).json({ ok: false, error: "missing start_time" });

    const date = activeOrToday();
    const countRow = db.prepare(`
      SELECT COUNT(*) AS c FROM roster WHERE date = ? AND start_time = ?
    `).get(date, start_time);
    const c = countRow?.c || 0;

    const msg = `Attention families. ${formatTime12h(start_time)} classes are starting soon. Please bring your swimmer to the pool deck.`.replace(/\s+/g, " ").trim();

    const out = await speakAnnouncement(msg, { ping: true });
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "speech failed" });

    audit(req, "force_time_announcement", { device_mode, date, start_time, details: { count: c } });
    res.json({ ok: true, lastAnnouncement });
  } catch (e) {
    res.status(500).json({ ok: false, error: "force-time announcement failed", details: String(e?.stack || e?.message || e) });
  }
});

// "Call parent" action: speaks a standard page
app.post("/api/call-parent", async (req, res) => {
  try {
    const { swimmer_name, device_mode } = req.body || {};
    if (!swimmer_name) return res.status(400).json({ ok: false, error: "missing swimmer_name" });

    const msg = `Parent or guardian of ${swimmer_name}. Please come to the front desk.`;
    const out = await speakAnnouncement(msg, { ping: true });
    if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "speech failed" });

    audit(req, "call_parent", { device_mode, swimmer_name, details: { text: msg } });
    res.json({ ok: true, lastAnnouncement });
  } catch (e) {
    res.status(500).json({ ok: false, error: "call-parent failed", details: String(e?.stack || e?.message || e) });
  }
});

// Export CSV of today's roster + attendance
app.get("/api/export-attendance", (req, res) => {
  try {
    const date = activeOrToday();
    const rows = db.prepare(`
      SELECT
        date, start_time, swimmer_name, instructor_name, zone, program, age_text,
        attendance, attendance_at, attendance_auto_absent,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        zone_overridden, zone_override_at, zone_override_by
      FROM roster
      WHERE date = ?
      ORDER BY start_time ASC, instructor_name ASC, swimmer_name ASC
    `).all(date);

    const toAtt = (v) => (v === 1 ? "Here" : v === 0 ? "Absent" : "");

    const header = [
      "date","start_time","start_time_12h","swimmer_name","instructor_name","zone","program","age_text",
      "attendance","attendance_at","attendance_auto_absent",
      "is_addon",
      "flag_new","flag_makeup","flag_policy","flag_owes","flag_trial",
      "zone_overridden","zone_override_at","zone_override_by"
    ];

    const lines = [header.join(",")];
    for (const r of rows) {
      const vals = [
        r.date,
        r.start_time,
        formatTime12h(r.start_time),
        r.swimmer_name,
        r.instructor_name || "",
        r.zone ?? "",
        r.program || "",
        r.age_text || "",
        toAtt(r.attendance),
        r.attendance_at || "",
        r.attendance_auto_absent ? "1" : "0",
        r.is_addon ? "1" : "0",
        r.flag_new ? "1" : "0",
        r.flag_makeup ? "1" : "0",
        r.flag_policy ? "1" : "0",
        r.flag_owes ? "1" : "0",
        r.flag_trial ? "1" : "0",
        r.zone_overridden ? "1" : "0",
        r.zone_override_at || "",
        r.zone_override_by || ""
      ].map((x) => {
        const s = String(x ?? "");
        if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g,'""')}"`;
        return s;
      });
      lines.push(vals.join(","));
    }

    const csv = lines.join("\n");
    const filename = `attendance_${date}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, error: "export failed", details: String(e?.stack || e?.message || e) });
  }
});

function importRosterRows({ date, locationId, rows, source }) {
  if (!rows.length) return { imported: 0 };

  setActiveDate(date);

  db.prepare(`DELETE FROM roster WHERE date = ? AND location_id = ? AND is_addon = 0`).run(date, locationId);

  const now = nowISO();
  const ins = db.prepare(`
    INSERT INTO roster (
      date, start_time, swimmer_name,
      instructor_name, substitute_instructor, is_substitute, original_instructor, zone, program, age_text,
      attendance, attendance_at, attendance_auto_absent,
      is_addon,
      flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
      balance_amount,
      created_at, updated_at,
      zone_overridden, zone_override_at, zone_override_by,
      location_id
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?,
      ?,
      ?, ?,
      ?, ?, ?,
      ?
    )
    ON CONFLICT(date, start_time, swimmer_name) DO UPDATE SET
      instructor_name=excluded.instructor_name,
      substitute_instructor=excluded.substitute_instructor,
      is_substitute=excluded.is_substitute,
      original_instructor=excluded.original_instructor,
      zone=excluded.zone,
      program=excluded.program,
      age_text=excluded.age_text,
      attendance=excluded.attendance,
      attendance_at=excluded.attendance_at,
      attendance_auto_absent=excluded.attendance_auto_absent,
      is_addon=excluded.is_addon,
      flag_new=excluded.flag_new,
      flag_makeup=excluded.flag_makeup,
      flag_policy=excluded.flag_policy,
      flag_owes=excluded.flag_owes,
      flag_trial=excluded.flag_trial,
      balance_amount=excluded.balance_amount,
      zone_overridden=excluded.zone_overridden,
      zone_override_at=excluded.zone_override_at,
      zone_override_by=excluded.zone_override_by,
      updated_at=excluded.updated_at,
      location_id=excluded.location_id
  `);

  const tx = db.transaction((arr) => {
    for (const r of arr) {
      const st = String(r.start_time || "").trim();
      const sn = String(r.swimmer_name || "").trim();
      if (!st || !sn) continue;
      ins.run(
        date,
        st,
        sn,
      r.instructor_name || null,
      r.substitute_instructor || null,
      r.is_substitute ? 1 : 0,
      r.original_instructor || null,
      (r.zone === 0 || r.zone) ? r.zone : null,
        r.program || null,
        r.age_text || null,
        (r.attendance === 0 || r.attendance === 1) ? r.attendance : null,
        r.attendance_at || null,
        r.attendance_auto_absent ? 1 : 0,
        r.is_addon ? 1 : 0,
        r.flag_new ? 1 : 0,
        r.flag_makeup ? 1 : 0,
        r.flag_policy ? 1 : 0,
        r.flag_owes ? 1 : 0,
        r.flag_trial ? 1 : 0,
        r.balance_amount !== undefined ? r.balance_amount : null,
        r.created_at || now,
        now,
        r.zone_overridden ? 1 : 0,
        r.zone_override_at || null,
        r.zone_override_by || null,
        locationId
      );
    }
  });
  tx(rows);

  if (source) {
    audit(source, "import_json", { date, count: rows.length });
  }

  return { imported: rows.length };
}

app.get("/api/server-exports", (req, res) => {
  try {
    const locationId = Number(req.query.location_id || 1);
    const location = getLocationById(locationId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const exportDir = path.join(EXPORT_DIR, location.code);
    if (!fs.existsSync(exportDir)) {
      return res.json({ ok: true, exports: [] });
    }

    const files = fs.readdirSync(exportDir)
      .filter((f) => f.endsWith(".json"))
      .map((filename) => {
        const stat = fs.statSync(path.join(exportDir, filename));
        return {
          filename,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));

    res.json({ ok: true, exports: files });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server-exports failed", details: String(e?.stack || e?.message || e) });
  }
});

app.post("/api/export-server", (req, res) => {
  try {
    const { location_id, date } = req.body || {};
    const locationId = Number(location_id || 1);
    const location = getLocationById(locationId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const exportDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) ? String(date) : activeOrToday();

    const rows = db.prepare(`
      SELECT
        date, start_time, swimmer_name, instructor_name, substitute_instructor, is_substitute, original_instructor, zone, program, age_text,
        attendance, attendance_at, attendance_auto_absent,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        balance_amount,
        zone_overridden, zone_override_at, zone_override_by,
        created_at, updated_at,
        location_id
      FROM roster
      WHERE date = ? AND location_id = ?
      ORDER BY start_time ASC, instructor_name ASC, swimmer_name ASC
    `).all(exportDate, locationId);

    const exportDir = path.join(EXPORT_DIR, location.code);
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const exportFilename = `roster_${location.code}_${exportDate}_${timestamp}.json`;
    const exportPath = path.join(exportDir, exportFilename);

    const payload = {
      ok: true,
      location: location.name,
      location_code: location.code,
      location_id: locationId,
      date: exportDate,
      exported_at: nowISO(),
      count: rows.length,
      rows
    };

    fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2), 'utf-8');

    audit(req, "export_server", {
      location: location.name,
      location_id: locationId,
      date: exportDate,
      count: rows.length,
      filename: exportFilename
    });

    res.json({ ok: true, filename: exportFilename, count: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: "export-server failed", details: String(e?.stack || e?.message || e) });
  }
});

app.post("/api/import-server", (req, res) => {
  try {
    const { location_id, filename, initials } = req.body || {};
    const locationId = Number(location_id || 1);
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const location = getLocationById(locationId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const safeName = safeExportFilename(filename);
    if (!safeName) {
      return res.status(400).json({ ok: false, error: "Invalid filename" });
    }

    const exportPath = path.join(EXPORT_DIR, location.code, safeName);
    if (!fs.existsSync(exportPath)) {
      return res.status(404).json({ ok: false, error: "Export file not found" });
    }

    const payload = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    const rows = Array.isArray(payload.rows) ? payload.rows : (Array.isArray(payload.roster) ? payload.roster : []);
    const importDate = (payload.date && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date)))
      ? String(payload.date)
      : activeOrToday();

    if (!rows.length) {
      return res.status(400).json({ ok: false, error: "No rows in export file" });
    }

    const result = importRosterRows({ date: importDate, locationId, rows });

    audit(req, "import_server", {
      location: location.name,
      location_id: locationId,
      date: importDate,
      count: result.imported,
      filename: safeName,
      initials: initialsClean
    });
    logActivity("import_server", { location_id: locationId, initials: initialsClean, details: { filename: safeName, date: importDate } });

    res.json({ ok: true, date: importDate, count: result.imported, filename: safeName });
  } catch (e) {
    res.status(500).json({ ok: false, error: "import-server failed", details: String(e?.stack || e?.message || e) });
  }
});


// ==================== HTML UPLOAD SUPPORT ====================
function parseHTMLRoster(html) {
  const $ = cheerio.load(html);
  const swimmers = [];
  const datesFound = new Set();
  
  const iconMap = {
    '1st-ever.png': 'flag_new',
    'balance.png': 'flag_owes',
    'birthday.png': 'flag_makeup',  // Birthday icon = Makeup class
    'makeup.png': 'flag_makeup',
    'policy.png': 'flag_policy',
    'trial.png': 'flag_trial'
  };
  
  $('div[style*="page-break-inside"]').each((_, section) => {
    const $section = $(section);
    
    let startTime = null;
    const scheduleText = $section.find('th:contains("Schedule:")').next().text();
    const timeMatch = scheduleText.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
    if (timeMatch) {
      startTime = normalizeTimeTo24h(timeMatch[0].trim());
    }
    
    if (!startTime) return;
    
    let instructorName = null;
    let substituteInstructor = null;

    const headerText = $section.find('.full-width-header').text().replace(/\s+/g, ' ').trim();
    if (headerText) {
      const headerMatch = headerText.match(/with\s+(.+?)(?:\s{2,}|Zone:|Program:|Schedule:|Capacity:|Ages:|$)/i);
      if (headerMatch) {
        const headerInstructor = headerMatch[1].trim();
        const headerIsSub = /\*/.test(headerInstructor) || /\(sub\)/i.test(headerInstructor);
        const cleanedHeader = headerInstructor.replace(/\(sub\)/ig, "").replace(/\*/g, "").trim();
        if (cleanedHeader) {
          if (headerIsSub) {
            substituteInstructor = lastFirstToFirstLast(cleanedHeader);
          } else {
            instructorName = lastFirstToFirstLast(cleanedHeader);
          }
        }
      }
    }

    // Get all instructor list items (Roster reports may use Instructor or Instructors)
    const instructorHeader = $section
      .find('th')
      .filter((_, th) => /Instructors?:/i.test($(th).text().replace(/\s+/g, ' ').trim()))
      .first();
    const instructorCell = instructorHeader.length ? instructorHeader.next() : null;
    const instructorItems = instructorCell ? instructorCell.find('li') : $();

    if (instructorItems.length > 0) {
      instructorItems.each((idx, item) => {
        const text = $(item).text().trim();
        if (!text) return;

        // Check if this instructor has an asterisk (indicates substitute)
        if (text.includes('*')) {
          // This is the substitute - remove asterisk and convert name
          const cleanName = text.replace(/\*/g, '').trim();
          substituteInstructor = lastFirstToFirstLast(cleanName);
        } else if (!instructorName) {
          // First instructor without asterisk is the original/regular instructor
          instructorName = lastFirstToFirstLast(text);
        }
      });

      // If no regular instructor was found but we have a substitute,
      // use the substitute as the main instructor
      if (!instructorName && substituteInstructor) {
        instructorName = substituteInstructor;
        substituteInstructor = null;
      }
    } else if (instructorCell && instructorCell.length) {
      const rawInstructor = instructorCell.text().replace(/\s+/g, ' ').trim();
      if (rawInstructor) {
        const isSub = /\*/.test(rawInstructor) || /\(sub\)/i.test(rawInstructor);
        const cleaned = rawInstructor.replace(/\(sub\)/ig, '').replace(/\*/g, '').trim();
        if (cleaned) {
          if (isSub) {
            substituteInstructor = lastFirstToFirstLast(cleaned);
          } else if (!instructorName) {
            instructorName = lastFirstToFirstLast(cleaned);
          }
        }
      }
    }
    
    let programText = null;
    const programSpan = $section.find('th:contains("Program:")').next().find('span').first().text().trim();
    if (programSpan) {
      const upProg = programSpan.toUpperCase();
      if (upProg === 'GROUP') {
        const fullText = $section.text();
        const levelMatch = fullText.match(/GROUP:\s*(Beginner|Intermediate|Advanced|Swimmer)\s*(\d+)/i);
        if (levelMatch) {
          const levelName = levelMatch[1].charAt(0).toUpperCase() + levelMatch[1].slice(1).toLowerCase();
          programText = `GROUP: ${levelName} ${levelMatch[2]}`;
        } else {
          programText = 'GROUP';
        }
      } else {
        programText = normalizeProgramNonGroup(programSpan);
      }
    }
    
    let zone = 1;
    const zoneText = $section.find('th:contains("Zone:")').next().find('span').text().trim();
    const zoneMatch = zoneText.match(/Zone\s*(\d+)/i);
    if (zoneMatch) {
      zone = parseInt(zoneMatch[1]);
    }

    const $table = $section.find('table.table-roll-sheet').first();
    const sectionText = $section.text();
    const dateRange = parseDateRangeFromSectionText(sectionText);
    const dateColumns = $table.length ? parseRosterDateColumns($, $table, dateRange, startTime) : [];

    $section.find('table.table-roll-sheet tbody tr').each((_, row) => {
      const $row = $(row);
      
      const nameEl = $row.find('.student-name strong');
      if (nameEl.length === 0) return;
      
      const swimmerName = lastFirstToFirstLast(nameEl.text().trim());
      const ageText = normalizeAgeText($row.find('.student-info').text().trim());
      
      const flags = {
        flag_new: 0,
        flag_makeup: 0,
        flag_policy: 0,
        flag_owes: 0,
        flag_trial: 0
      };
      
      $row.find('.icons img').each((_, img) => {
        const src = $(img).attr('src') || '';
        const filename = src.split('/').pop();
        const flagName = iconMap[filename];
        if (flagName && flags.hasOwnProperty(flagName)) {
          flags[flagName] = 1;
        }
      });

      // Extract balance amount from Details column
      let balanceAmount = null;
      const detailsText = $row.find('td').eq(3).text(); // Details is usually the 4th column (index 3)
      const balanceMatch = detailsText.match(/Balance:\s*\$?([-\d,.]+)/i);
      if (balanceMatch) {
        // Clean up balance string and convert to number
        const balanceStr = balanceMatch[1].replace(/,/g, '');
        balanceAmount = parseFloat(balanceStr);
        // If we found a balance, mark flag_owes
        if (!isNaN(balanceAmount) && balanceAmount !== 0) {
          flags.flag_owes = 1;
        }
      }

      // Determine if this is a substitute scenario
      const isSubstitute = substituteInstructor ? 1 : 0;
      const originalInstructor = substituteInstructor ? instructorName : null;
      const actualInstructor = substituteInstructor || instructorName;

      if (dateColumns.length > 0) {
        const rowCells = $row.find('td');
        dateColumns.forEach((col) => {
          const cell = rowCells.eq(col.index);
          const autoAbsent = hasAutoAbsentIndicator(cell, $);
          const attendance = isAbsentAttendanceCell(cell, $) ? 0 : null;
          if (col.date) datesFound.add(col.date);

          swimmers.push({
            date: col.date || null,
            start_time: col.start_time || startTime,
            swimmer_name: swimmerName,
            age_text: ageText,
            instructor_name: actualInstructor,
            substitute_instructor: substituteInstructor,
            is_substitute: isSubstitute,
            original_instructor: originalInstructor,
            program: programText,
            zone: zone,
            attendance: attendance,
            attendance_auto_absent: autoAbsent ? 1 : 0,
            balance_amount: balanceAmount,
            ...flags
          });
        });
      } else {
        // Fallback: single-date upload with absence detection on attendance cells
        let attendance = null;
        const attendanceCell = $row.find('td.date-time, td.cell-bordered');
        const autoAbsent = hasAutoAbsentIndicator(attendanceCell, $);
        if (isAbsentAttendanceCell(attendanceCell, $)) {
          attendance = 0;
        }

        swimmers.push({
          date: null,
          start_time: startTime,
          swimmer_name: swimmerName,
          age_text: ageText,
          instructor_name: actualInstructor,
          substitute_instructor: substituteInstructor,
          is_substitute: isSubstitute,
          original_instructor: originalInstructor,
          program: programText,
          zone: zone,
          attendance: attendance,
          attendance_auto_absent: autoAbsent ? 1 : 0,
          balance_amount: balanceAmount,
          ...flags
        });
      }
    });
  });
  
  console.log(`HTML Parser: Found ${swimmers.length} swimmers`);
  return { swimmers, dates: Array.from(datesFound) };
}

app.post("/api/upload-html/preview", upload.single('html'), (req, res) => {
  try {
    const { location_id } = req.body || {};
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No HTML file uploaded" });
    }
    const html = req.file.buffer.toString("utf8");
    const detectedDate = parseDateFromHTML(html) || todayISO();
    let parsed = null;
    try {
      parsed = parseHTMLRoster(html);
    } catch (parseError) {
      return res.status(400).json({ ok: false, error: `Failed to parse HTML: ${parseError.message}` });
    }
    const swimmers = Array.isArray(parsed) ? parsed : (parsed?.swimmers || []);
    const normalizedRows = swimmers.map((row) => ({ ...row, date: row.date || detectedDate }));
    const dateList = Array.from(new Set(normalizedRows.map((row) => row.date).filter(Boolean))).sort();
    const dateStart = dateList[0] || detectedDate;
    const dateEnd = dateList[dateList.length - 1] || dateStart;
    const location = location_id ? getLocationById(Number(location_id)) : null;
    res.json({
      ok: true,
      summary: {
        location: location?.name || null,
        report_type: "roster_html",
        date_start: dateStart,
        date_end: dateEnd,
        count: swimmers.length
      }
    });
  } catch (error) {
    console.error("HTML preview error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/upload-html", upload.single('html'), async (req, res) => {
  try {
    // Handle FormData file upload (new method)
    let html, filename;

    if (req.file) {
      // FormData upload
      html = req.file.buffer.toString('utf-8');
      filename = req.file.originalname;
    } else if (req.body.html_content) {
      // JSON upload (fallback for compatibility)
      html = req.body.html_content;
      filename = req.body.filename;
    } else if (req.body.html_base64) {
      // Base64 upload (legacy)
      html = Buffer.from(req.body.html_base64, "base64").toString("utf-8");
      filename = req.body.filename;
    } else {
      return res.status(400).json({ ok: false, error: "No file data provided" });
    }

    const locId = Number(req.body.location_id || req.query.location_id || 1);
    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locId);

    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const detectedDate =
      parseDateFromFilename(filename) ||
      parseDateFromHTML(html) ||
      todayISO();

    // Save to location-specific folder with descriptive filename
    // Format: roll_sheet_{LOCATION_NAME}_{DATE}.html
    const locationDir = getScheduleDir(location);
    if (!fs.existsSync(locationDir)) fs.mkdirSync(locationDir, { recursive: true });
    const htmlFilename = `roll_sheet_${getLocationFileTag(location)}_${detectedDate}.html`;
    const htmlPath = path.join(locationDir, htmlFilename);
    try {
      fs.writeFileSync(htmlPath, html, "utf-8");
    } catch (writeError) {
      return res.status(500).json({ ok: false, error: `Failed to save HTML: ${writeError.message}` });
    }

    let parsed = null;
    try {
      parsed = parseHTMLRoster(html);
    } catch (parseError) {
      return res.status(400).json({ ok: false, error: `Failed to parse HTML: ${parseError.message}` });
    }
    const swimmers = Array.isArray(parsed) ? parsed : (parsed?.swimmers || []);
    if (swimmers.length === 0) {
      return res.status(400).json({ ok: false, error: "No swimmers found in HTML file" });
    }

    const today = todayISO();
    const normalizedRows = swimmers.map((row) => ({
      ...row,
      date: row.date || detectedDate
    }));

    const dateList = Array.from(new Set(
      normalizedRows.map((row) => row.date).filter(Boolean)
    )).sort();
    const dateStart = dateList[0] || detectedDate;
    const dateEnd = dateList[dateList.length - 1] || dateStart;

    const rowsToInsert = normalizedRows.filter((row) => row.date >= today);
    if (rowsToInsert.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No roster entries found for today or later.",
        date_start: dateStart,
        date_end: dateEnd
      });
    }
    const activeDate = dateList.includes(today) ? today : dateStart;
    setActiveDate(activeDate);

    // Auto-export existing roster before clearing (if any exists)
    // Exports are stored on SERVER in subdirectories: exports/{LOCATION_CODE}/
    // Example: exports/SLW/ for SwimLabs Westchester
    //          exports/SSM/ for SafeSplash Santa Monica
    const existingRoster = db.prepare(`
      SELECT * FROM roster
      WHERE date >= ? AND location_id = ? AND is_addon = 0
    `).all(today, locId);

    if (existingRoster.length > 0) {
      // Create export directory for this location on server
      const exportDir = path.join(EXPORT_DIR, location.code);
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      // Generate timestamp for filename
      // Format: roster_{LOCATION_CODE}_{DATE}_{TIMESTAMP}.json
      // Example: roster_SLW_2026-01-24_2026-01-24T15-30-45-123Z.json
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFilename = `roster_${location.code}_${today}_${timestamp}.json`;
      const exportPath = path.join(exportDir, exportFilename);

      // Save existing roster to JSON on server
      fs.writeFileSync(exportPath, JSON.stringify({
        location: location.name,
        location_code: location.code,
        date: today,
        date_start: dateStart,
        date_end: dateEnd,
        exported_at: nowISO(),
        count: existingRoster.length,
        roster: existingRoster
      }, null, 2), 'utf-8');

      console.log(`[AUTO-EXPORT] Saved ${existingRoster.length} swimmers to server: ${location.code}/${exportFilename}`);
    }

    // Delete existing roster from today forward for this location
    db.prepare(`DELETE FROM roster WHERE date >= ? AND location_id = ? AND is_addon = 0`).run(today, locId);

    const now = nowISO();
    const ins = db.prepare(`
      INSERT INTO roster (
        date, start_time, swimmer_name,
        instructor_name, substitute_instructor, is_substitute, original_instructor, zone, program, age_text,
        attendance, attendance_at, attendance_auto_absent,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        balance_amount,
        location_id,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(date, start_time, swimmer_name) DO UPDATE SET
        instructor_name=excluded.instructor_name,
        substitute_instructor=excluded.substitute_instructor,
        is_substitute=excluded.is_substitute,
        original_instructor=excluded.original_instructor,
        zone=excluded.zone,
        program=excluded.program,
        age_text=excluded.age_text,
        attendance=excluded.attendance,
        attendance_at=excluded.attendance_at,
        attendance_auto_absent=excluded.attendance_auto_absent,
        is_addon=excluded.is_addon,
        flag_new=excluded.flag_new,
        flag_makeup=excluded.flag_makeup,
        flag_policy=excluded.flag_policy,
        flag_owes=excluded.flag_owes,
        flag_trial=excluded.flag_trial,
        balance_amount=excluded.balance_amount,
        location_id=excluded.location_id,
        updated_at=excluded.updated_at
    `);

    const tx = db.transaction((rows) => {
      for (const r of rows) {
        ins.run(
          r.date, r.start_time, r.swimmer_name,
          r.instructor_name || null,
          r.substitute_instructor || null,
          r.is_substitute || 0,
          r.original_instructor || null,
          r.zone || null,
          r.program || null,
          r.age_text || null,
          r.attendance !== undefined ? r.attendance : null,
          r.attendance_auto_absent ? 1 : 0,
          r.flag_new || 0, r.flag_makeup || 0, r.flag_policy || 0, r.flag_owes || 0, r.flag_trial || 0,
          r.balance_amount !== undefined ? r.balance_amount : null,
          locId,
          now, now
        );
      }
    });

    tx(rowsToInsert);

    audit(req, "html_upload", { 
      location: location.name,
      date_start: dateStart,
      date_end: dateEnd,
      count: rowsToInsert.length
    });

    res.json({ ok: true, count: rowsToInsert.length, date_start: dateStart, date_end: dateEnd, location: location.name });
  } catch (error) {
    console.error("HTML upload error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== MANAGER REPORTS ====================
function resolveLocationByName(name) {
  if (!name) return null;
  const normalized = String(name).trim().toLowerCase();
  return db.prepare(`SELECT * FROM locations WHERE lower(name) = ?`).get(normalized)
    || db.prepare(`SELECT * FROM locations WHERE lower(code) = ?`).get(normalized);
}

function normalizeInitials(value) {
  return String(value || "").trim().toUpperCase().slice(0, 4);
}

function verifyPin(pin, pinType) {
  if (!pin) return { ok: false };
  const incoming = String(pin);
  if (pinType === "manager") {
    if (incoming === MANAGER_PIN) return { ok: true, role: "manager" };
    if (incoming === ADMIN_PIN) return { ok: true, role: "admin" };
    return { ok: false };
  }
  if (incoming === ADMIN_PIN) return { ok: true, role: "admin" };
  return { ok: false };
}

app.post("/api/manager-reports/preview", upload.single("report"), (req, res) => {
  try {
    const reportType = String(req.body?.report_type || "").toLowerCase();
    if (!MANAGER_REPORT_TYPES.has(reportType)) {
      return res.status(400).json({ ok: false, error: "Invalid report type" });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No report file uploaded" });
    }
    const html = req.file.buffer.toString("utf8");
    const locationName = parseLocationFromHTML(html);
    const reportDate = parseDateFromHTML(html);
    let parsed = null;
    if (reportType === "retention") parsed = parseRetentionReport(html);
    if (reportType === "aged_accounts") parsed = parseAgedAccountsReport(html);
    if (reportType === "drop_list") parsed = parseDropListReport(html);
    const summary = {
      location_name: locationName,
      report_type: reportType,
      report_date: reportDate,
      warnings: parsed?.warnings || []
    };
    if (reportType === "retention") summary.row_count = parsed.instructors.length;
    if (reportType === "aged_accounts") summary.row_count = parsed.rows.length;
    if (reportType === "drop_list") summary.row_count = parsed.entries.length;
    res.json({ ok: true, summary });
  } catch (error) {
    console.error("Manager report preview error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/manager-reports/upload", upload.single("report"), (req, res) => {
  try {
    const reportType = String(req.body?.report_type || "").toLowerCase();
    if (!MANAGER_REPORT_TYPES.has(reportType)) {
      return res.status(400).json({ ok: false, error: "Invalid report type" });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No report file uploaded" });
    }
    const initials = normalizeInitials(req.body?.initials || "");
    if (!initials) {
      return res.status(400).json({ ok: false, error: "Initials are required" });
    }
    const pinCheck = verifyPin(req.body?.pin, "manager");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid manager PIN" });
    }

    const html = req.file.buffer.toString("utf8");
    const locationName = parseLocationFromHTML(html);
    let location = null;
    const locId = Number(req.body?.location_id || 0);
    if (reportType !== "drop_list" && locationName) {
      location = resolveLocationByName(locationName);
    }
    if (!location) {
      if (!locId) {
        return res.status(400).json({ ok: false, error: "Location required for this report." });
      }
      location = getLocationById(locId);
    }
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location selection." });
    }
    if (reportType === "drop_list" && !locId) {
      return res.status(400).json({ ok: false, error: "Drop list uploads must include a selected location." });
    }

    const reportDate = parseDateFromHTML(html);
    let parsed = null;
    if (reportType === "retention") parsed = parseRetentionReport(html);
    if (reportType === "aged_accounts") parsed = parseAgedAccountsReport(html);
    if (reportType === "drop_list") parsed = parseDropListReport(html);
    const warnings = parsed?.warnings || [];
    if (locationName && locId && location && resolveLocationByName(locationName)?.id !== location.id) {
      warnings.push(`HTML location "${locationName}" does not match selected location.`);
    }
    const now = nowISO();

    if (reportType === "aged_accounts") {
      db.prepare(`
        UPDATE manager_report_data
        SET archived = 1
        WHERE location_id = ? AND report_type = 'aged_accounts'
      `).run(location.id);
    }

    db.prepare(`
      INSERT INTO manager_report_data (
        location_id, report_type, report_date, data_json, warnings_json, uploaded_at, archived
      ) VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      location.id,
      reportType,
      reportDate,
      JSON.stringify(parsed || {}),
      JSON.stringify(warnings),
      now
    );

    audit(req, "manager_report_upload", {
      location_id: location.id,
      report_type: reportType,
      details: { initials, warnings }
    });
    logActivity("manager_report_upload", {
      location_id: location.id,
      initials,
      details: { report_type: reportType, warnings }
    });

    res.json({
      ok: true,
      report: {
        location_id: location.id,
        report_type: reportType,
        report_date: reportDate,
        uploaded_at: now,
        warnings
      }
    });
  } catch (error) {
    console.error("Manager report upload error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/manager-reports", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    const role = String(req.query?.role || "manager");
    if (!locId) {
      return res.status(400).json({ ok: false, error: "location_id is required" });
    }
    const reports = db.prepare(`
      SELECT * FROM manager_report_data
      WHERE location_id = ?
      AND (? = 'admin' OR archived = 0)
      ORDER BY uploaded_at DESC
    `).all(locId, role);
    const latest = {};
    for (const report of reports) {
      if (!latest[report.report_type]) {
        latest[report.report_type] = report;
      }
    }
    res.json({ ok: true, reports, latest });
  } catch (error) {
    console.error("Manager report list error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/manager-reports/data", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    const reportType = String(req.query?.report_type || "").toLowerCase();
    const includeArchived = String(req.query?.include_archived || "false") === "true";
    if (!locId || !MANAGER_REPORT_TYPES.has(reportType)) {
      return res.status(400).json({ ok: false, error: "location_id and report_type required" });
    }
    const rows = db.prepare(`
      SELECT * FROM manager_report_data
      WHERE location_id = ? AND report_type = ?
      AND (? = 1 OR archived = 0)
      ORDER BY uploaded_at DESC
    `).all(locId, reportType, includeArchived ? 1 : 0);
    res.json({ ok: true, reports: rows });
  } catch (error) {
    console.error("Manager report data error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/manager-reports/delete", (req, res) => {
  try {
    const { report_id, initials, pin } = req.body || {};
    const id = Number(report_id || 0);
    const initialsClean = normalizeInitials(initials);
    if (!id) {
      return res.status(400).json({ ok: false, error: "report_id required" });
    }
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "initials required" });
    }
    const pinCheck = verifyPin(pin, "admin");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid admin PIN" });
    }
    const report = db.prepare(`SELECT * FROM manager_report_data WHERE id = ?`).get(id);
    if (!report) {
      return res.status(404).json({ ok: false, error: "Report not found" });
    }
    db.prepare(`DELETE FROM manager_report_data WHERE id = ?`).run(id);
    audit(req, "manager_report_delete", { details: { report_id: id, initials: initialsClean } });
    logActivity("manager_report_delete", {
      location_id: report.location_id,
      initials: initialsClean,
      details: { report_type: report.report_type, report_date: report.report_date }
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Manager report delete error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ATTENDANCE SUMMARY ====================
app.get("/api/attendance-summary", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    const start = req.query?.start || activeOrToday();
    const end = req.query?.end || activeOrToday();
    if (!locId) return res.status(400).json({ ok: false, error: "location_id required" });

    const rows = db.prepare(`
      SELECT date, instructor_name, attendance
      FROM roster
      WHERE location_id = ? AND date BETWEEN ? AND ?
    `).all(locId, start, end);

    const byDate = new Map();
    const byInstructor = new Map();
    rows.forEach((row) => {
      if (row.attendance !== 0 && row.attendance !== 1) return;
      const dateKey = row.date;
      const instructorKey = row.instructor_name || "Unassigned";

      if (!byDate.has(dateKey)) byDate.set(dateKey, { date: dateKey, total: 0, present: 0, absent: 0 });
      const dateEntry = byDate.get(dateKey);
      dateEntry.total += 1;
      if (row.attendance === 1) dateEntry.present += 1;
      if (row.attendance === 0) dateEntry.absent += 1;

      if (!byInstructor.has(instructorKey)) byInstructor.set(instructorKey, { instructor: instructorKey, total: 0, present: 0, absent: 0 });
      const instEntry = byInstructor.get(instructorKey);
      instEntry.total += 1;
      if (row.attendance === 1) instEntry.present += 1;
      if (row.attendance === 0) instEntry.absent += 1;
    });

    const dateStats = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
      .map((entry) => ({
        ...entry,
        rate: entry.total ? Math.round((entry.present / entry.total) * 1000) / 10 : 0
      }));

    const instructorStats = Array.from(byInstructor.values()).sort((a, b) => a.instructor.localeCompare(b.instructor))
      .map((entry) => ({
        ...entry,
        rate: entry.total ? Math.round((entry.present / entry.total) * 1000) / 10 : 0
      }));

    const totals = dateStats.reduce((acc, entry) => {
      acc.total += entry.total;
      acc.present += entry.present;
      acc.absent += entry.absent;
      return acc;
    }, { total: 0, present: 0, absent: 0 });
    totals.rate = totals.total ? Math.round((totals.present / totals.total) * 1000) / 10 : 0;

    res.json({ ok: true, summary: { totals, dateStats, instructorStats } });
  } catch (error) {
    console.error("Attendance summary error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ATTENDANCE HISTORY ====================
app.get("/api/attendance-history", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    const start = req.query?.start || activeOrToday();
    const end = req.query?.end || activeOrToday();
    const limit = Math.min(Number(req.query?.limit || 500), 2000);
    if (!locId) return res.status(400).json({ ok: false, error: "location_id required" });
    const rows = db.prepare(`
      SELECT date, start_time, swimmer_name, instructor_name, program, attendance, attendance_at, attendance_auto_absent, updated_at
      FROM roster
      WHERE location_id = ? AND date BETWEEN ? AND ?
      ORDER BY date DESC, start_time DESC, swimmer_name ASC
      LIMIT ?
    `).all(locId, start, end, limit);
    res.json({ ok: true, rows });
  } catch (error) {
    console.error("Attendance history error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ABSENCE TRACKER ====================
app.get("/api/absence-tracker", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    const start = req.query?.start || activeOrToday();
    const end = req.query?.end || activeOrToday();
    if (!locId) return res.status(400).json({ ok: false, error: "location_id required" });

    const rows = db.prepare(`
      SELECT
        r.date, r.start_time, r.swimmer_name, r.instructor_name, r.program,
        r.attendance_auto_absent, r.attendance_at,
        f.status, f.notes, f.contacted_at, f.rescheduled_at, f.completed_at
      FROM roster r
      LEFT JOIN absence_followups f
        ON f.location_id = r.location_id
        AND f.swimmer_name = r.swimmer_name
        AND f.date = r.date
        AND (f.start_time IS r.start_time OR (f.start_time IS NULL AND r.start_time IS NULL))
      WHERE r.location_id = ? AND r.date BETWEEN ? AND ? AND r.attendance = 0
      ORDER BY r.date DESC, r.start_time DESC, r.swimmer_name ASC
    `).all(locId, start, end);

    res.json({ ok: true, rows });
  } catch (error) {
    console.error("Absence tracker error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/absence-tracker/update", (req, res) => {
  try {
    const { location_id, swimmer_name, date, start_time, status, notes, pin } = req.body || {};
    const locId = Number(location_id || 0);
    if (!locId || !swimmer_name || !date) {
      return res.status(400).json({ ok: false, error: "location_id, swimmer_name, and date required" });
    }
    const pinCheck = verifyPin(pin, "manager");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid manager PIN" });
    }

    const now = nowISO();
    const existing = db.prepare(`
      SELECT * FROM absence_followups
      WHERE location_id = ? AND swimmer_name = ? AND date = ? AND (start_time IS ? OR start_time = ?)
    `).get(locId, swimmer_name, date, start_time || null, start_time || null);

    const nextStatus = status || existing?.status || "new";
    const contactedAt = nextStatus === "contacted" ? now : existing?.contacted_at || null;
    const rescheduledAt = nextStatus === "rescheduled" ? now : existing?.rescheduled_at || null;
    const completedAt = nextStatus === "complete" ? now : existing?.completed_at || null;

    db.prepare(`
      INSERT INTO absence_followups (
        location_id, swimmer_name, date, start_time,
        status, notes, contacted_at, rescheduled_at, completed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(location_id, swimmer_name, date, start_time) DO UPDATE SET
        status=excluded.status,
        notes=excluded.notes,
        contacted_at=excluded.contacted_at,
        rescheduled_at=excluded.rescheduled_at,
        completed_at=excluded.completed_at,
        updated_at=excluded.updated_at
    `).run(
      locId,
      swimmer_name,
      date,
      start_time || null,
      nextStatus,
      notes || existing?.notes || null,
      contactedAt,
      rescheduledAt,
      completedAt,
      existing?.created_at || now,
      now
    );

    res.json({ ok: true, status: nextStatus });
  } catch (error) {
    console.error("Absence tracker update error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== BUNDLE TRACKER ====================
app.get("/api/bundles", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    if (!locId) return res.status(400).json({ ok: false, error: "location_id required" });
    const rows = db.prepare(`
      SELECT * FROM bundle_tracker
      WHERE location_id = ?
      ORDER BY expiration_date ASC
    `).all(locId);
    res.json({ ok: true, bundles: rows });
  } catch (error) {
    console.error("Bundles list error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/bundles", (req, res) => {
  try {
    const { location_id, customer_name, phone, notes, start_date, duration_weeks, monthly_price, pin } = req.body || {};
    const locId = Number(location_id || 0);
    if (!locId || !customer_name) return res.status(400).json({ ok: false, error: "location_id and customer_name required" });
    const pinCheck = verifyPin(pin, "manager");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid manager PIN" });
    }
    const calc = calculateBundle({ durationWeeks: duration_weeks, monthlyPrice: monthly_price, startDate: start_date });
    if (!calc.ok) return res.status(400).json({ ok: false, error: calc.error });
    const now = nowISO();
    const result = db.prepare(`
      INSERT INTO bundle_tracker (
        location_id, customer_name, phone, notes,
        start_date, duration_weeks, monthly_price,
        discounted_monthly, total_billed, house_credit, expiration_date,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      locId,
      customer_name,
      phone || null,
      notes || null,
      start_date || null,
      Number(duration_weeks),
      Number(monthly_price),
      calc.discountedMonthly,
      calc.totalBilled,
      calc.houseCredit,
      calc.expirationDate,
      now,
      now
    );
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (error) {
    console.error("Bundle create error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put("/api/bundles/:id", (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const { location_id, customer_name, phone, notes, start_date, duration_weeks, monthly_price, pin } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "bundle id required" });
    const pinCheck = verifyPin(pin, "manager");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid manager PIN" });
    }
    const calc = calculateBundle({ durationWeeks: duration_weeks, monthlyPrice: monthly_price, startDate: start_date });
    if (!calc.ok) return res.status(400).json({ ok: false, error: calc.error });
    const now = nowISO();
    db.prepare(`
      UPDATE bundle_tracker
      SET location_id = ?, customer_name = ?, phone = ?, notes = ?,
          start_date = ?, duration_weeks = ?, monthly_price = ?,
          discounted_monthly = ?, total_billed = ?, house_credit = ?, expiration_date = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      Number(location_id),
      customer_name,
      phone || null,
      notes || null,
      start_date || null,
      Number(duration_weeks),
      Number(monthly_price),
      calc.discountedMonthly,
      calc.totalBilled,
      calc.houseCredit,
      calc.expirationDate,
      now,
      id
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Bundle update error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete("/api/bundles/:id", (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const pin = req.body?.pin;
    if (!id) return res.status(400).json({ ok: false, error: "bundle id required" });
    const pinCheck = verifyPin(pin, "manager");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid manager PIN" });
    }
    db.prepare(`DELETE FROM bundle_tracker WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (error) {
    console.error("Bundle delete error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== GUARD TASKS ====================
app.get("/api/guard-tasks", (req, res) => {
  try {
    const locId = Number(req.query?.location_id || 0);
    const taskDate = String(req.query?.date || "").trim();
    if (!locId || !taskDate) {
      return res.status(400).json({ ok: false, error: "location_id and date required" });
    }
    const row = db.prepare(`
      SELECT * FROM guard_tasks WHERE location_id = ? AND task_date = ?
    `).get(locId, taskDate);
    res.json({ ok: true, task: row || null });
  } catch (error) {
    console.error("Guard tasks fetch error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/guard-tasks", (req, res) => {
  try {
    const { location_id, date, data, initials } = req.body || {};
    const locId = Number(location_id || 0);
    const taskDate = String(date || "").trim();
    if (!locId || !taskDate || !data) {
      return res.status(400).json({ ok: false, error: "location_id, date, and data required" });
    }
    const now = nowISO();
    const payload = JSON.stringify(data);
    db.prepare(`
      INSERT INTO guard_tasks(location_id, task_date, data_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(location_id, task_date) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at
    `).run(locId, taskDate, payload, now);
    db.prepare(`
      INSERT INTO guard_task_history(location_id, task_date, data_json, saved_at)
      VALUES (?, ?, ?, ?)
    `).run(locId, taskDate, payload, now);

    audit(req, "guard_tasks_save", { details: { location_id: locId, date: taskDate, initials } });
    if (initials) {
      logActivity("guard_tasks_save", { location_id: locId, initials, details: { date: taskDate } });
    }
    res.json({ ok: true, saved_at: now });
  } catch (error) {
    console.error("Guard tasks save error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/guard-tasks/clear", (req, res) => {
  try {
    const { location_id, date, initials } = req.body || {};
    const locId = Number(location_id || 0);
    const taskDate = String(date || "").trim();
    const initialsClean = normalizeInitials(initials);
    if (!locId || !taskDate) {
      return res.status(400).json({ ok: false, error: "location_id and date required" });
    }
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "initials required" });
    }
    db.prepare(`DELETE FROM guard_tasks WHERE location_id = ? AND task_date = ?`).run(locId, taskDate);
    audit(req, "guard_tasks_clear", { details: { location_id: locId, date: taskDate, initials: initialsClean } });
    logActivity("guard_tasks_clear", { location_id: locId, initials: initialsClean, details: { date: taskDate } });
    res.json({ ok: true });
  } catch (error) {
    console.error("Guard tasks clear error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== LOCATION MANAGEMENT ====================
app.get("/api/locations", (req, res) => {
  try {
    const locations = db.prepare(`SELECT * FROM locations WHERE active = 1 ORDER BY id`).all();
    res.json({ ok: true, locations });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/set-location", (req, res) => {
  try {
    const { location_id } = req.body;
    if (!location_id) {
      return res.status(400).json({ ok: false, error: 'location_id required' });
    }
    
    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(location_id);
    if (!location) {
      return res.status(404).json({ ok: false, error: 'Location not found' });
    }
    
    audit(req, "set_location", { location_id, location_name: location.name });
    res.json({ ok: true, location });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/roster/classes", (req, res) => {
  try {
    const { location_id, date } = req.query;
    if (!date) {
      return res.status(400).json({ ok: false, error: "date required" });
    }
    const locId = Number(location_id || 1);
    const rows = db.prepare(`
      SELECT start_time, instructor_name, program, swimmer_name
      FROM roster
      WHERE date = ? AND location_id = ?
      ORDER BY start_time, instructor_name, swimmer_name
    `).all(date, locId);

    const classMap = new Map();
    rows.forEach((row) => {
      const instructorName = row.instructor_name || "Instructor TBD";
      const program = row.program || "";
      const timeLabel = formatRosterTimeLabel(row.start_time || "");
      const classKey = `${date}|${row.start_time || ""}|${instructorName}|${program}`.toLowerCase();
      if (!classMap.has(classKey)) {
        classMap.set(classKey, {
          classKey,
          label: `${timeLabel}${program ? ` • ${program}` : ""} • ${instructorName}`,
          instructorName,
          timeLabel,
          levelLabel: program || "",
          swimmers: [],
          locationId: locId,
          date
        });
      }
      const entry = classMap.get(classKey);
      if (row.swimmer_name) {
        entry.swimmers.push({ name: row.swimmer_name });
      }
    });

    res.json({ ok: true, classes: Array.from(classMap.values()) });
  } catch (error) {
    console.error("Roster class load error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/observations", (req, res) => {
  try {
    const payload = req.body || {};
    const locationId = Number(payload.location_id || 0);
    const date = String(payload.date || "").trim();
    if (!locationId || !date) {
      return res.status(400).json({ ok: false, error: "location_id and date are required" });
    }
    const createdAt = nowISO();
    const dataJson = JSON.stringify(payload);
    const info = db.prepare(`
      INSERT INTO observations (
        location_id, date, class_key, instructor_name, class_day_time_level, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      locationId,
      date,
      payload.classKey || "",
      payload.instructor_name || "",
      payload.class_day_time_level || "",
      dataJson,
      createdAt
    );
    res.json({ ok: true, id: info.lastInsertRowid, created_at: createdAt });
  } catch (error) {
    console.error("Observation save error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/observations", (req, res) => {
  try {
    const { location_id, instructor, from, to } = req.query;
    if (!location_id) {
      return res.status(400).json({ ok: false, error: "location_id required" });
    }
    const locId = Number(location_id);
    const filters = ["location_id = ?"];
    const params = [locId];
    if (from) {
      filters.push("date >= ?");
      params.push(from);
    }
    if (to) {
      filters.push("date <= ?");
      params.push(to);
    }
    if (instructor) {
      filters.push("lower(instructor_name) = ?");
      params.push(String(instructor).toLowerCase());
    }
    const rows = db.prepare(`
      SELECT id, location_id, date, instructor_name, class_key, class_day_time_level, data_json, created_at
      FROM observations
      WHERE ${filters.join(" AND ")}
      ORDER BY date DESC, created_at DESC
    `).all(...params);
    const observations = rows.map((row) => {
      let parsed = {};
      try {
        parsed = JSON.parse(row.data_json || "{}");
      } catch (err) {
        parsed = {};
      }
      return {
        id: row.id,
        created_at: row.created_at,
        location_id: row.location_id,
        date: row.date,
        instructor_name: row.instructor_name,
        classKey: row.class_key,
        class_day_time_level: row.class_day_time_level,
        ...parsed
      };
    });
    res.json({ ok: true, observations });
  } catch (error) {
    console.error("Observations fetch error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/observations/summary", (req, res) => {
  try {
    const { location_id, from, to } = req.query;
    if (!location_id) {
      return res.status(400).json({ ok: false, error: "location_id required" });
    }
    const locId = Number(location_id);
    const filters = ["location_id = ?"];
    const params = [locId];
    if (from) {
      filters.push("date >= ?");
      params.push(from);
    }
    if (to) {
      filters.push("date <= ?");
      params.push(to);
    }
    const rows = db.prepare(`
      SELECT instructor_name, data_json
      FROM observations
      WHERE ${filters.join(" AND ")}
    `).all(...params);

    const statsMap = new Map();
    const ensureStats = (name) => {
      if (!statsMap.has(name)) {
        statsMap.set(name, {
          instructor: name,
          count: 0,
          safe_start: { yes: 0, total: 0 },
          swimmer_interaction: { yes: 0, total: 0 },
          time_management: { yes: 0, total: 0 },
          skill_tracking: { yes: 0, total: 0 },
          demonstrations: { yes: 0, total: 0 },
          class_safety: { yes: 0, total: 0 }
        });
      }
      return statsMap.get(name);
    };

    const tallyField = (stats, field, value) => {
      if (!value) return;
      const normalized = String(value).toLowerCase();
      if (normalized !== "yes" && normalized !== "no") return;
      stats[field].total += 1;
      if (normalized === "yes") stats[field].yes += 1;
    };

    rows.forEach((row) => {
      let data = {};
      try {
        data = JSON.parse(row.data_json || "{}");
      } catch (err) {
        data = {};
      }
      const name = data.instructor_name || row.instructor_name || "Unknown";
      const stats = ensureStats(name);
      stats.count += 1;
      tallyField(stats, "safe_start", data.safe_start?.value);
      tallyField(stats, "swimmer_interaction", data.swimmer_interaction?.value);
      tallyField(stats, "time_management", data.time_management?.value);
      tallyField(stats, "skill_tracking", data.skill_tracking?.value);
      tallyField(stats, "demonstrations", data.demonstrations?.value);
      tallyField(stats, "class_safety", data.class_safety?.value);
    });

    const formatRate = (stat) => {
      if (!stat.total) return "—";
      return `${Math.round((stat.yes / stat.total) * 100)}%`;
    };

    const instructors = Array.from(statsMap.values()).map((entry) => ({
      instructor: entry.instructor,
      count: entry.count,
      safe_start_rate: formatRate(entry.safe_start),
      swimmer_interaction_rate: formatRate(entry.swimmer_interaction),
      time_management_rate: formatRate(entry.time_management),
      skill_tracking_rate: formatRate(entry.skill_tracking),
      demonstrations_rate: formatRate(entry.demonstrations),
      class_safety_rate: formatRate(entry.class_safety)
    })).sort((a, b) => a.instructor.localeCompare(b.instructor));

    res.json({ ok: true, summary: { instructors, count: rows.length } });
  } catch (error) {
    console.error("Observation summary error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== INSTRUCTOR MANAGEMENT ====================
function loadStaffConfig() {
  const configPath = path.join(CONFIG_DIR, "instructors.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("instructors.json not found");
  }
  const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!configData.states) {
    const states = {};
    (configData.instructors || []).forEach((i) => {
      const state = i.location || "Unknown";
      if (!states[state]) states[state] = [];
      states[state].push({
        firstName: i.firstName,
        lastName: i.lastName,
        phone: i.phone || "",
        birthday: i.birthday || ""
      });
    });
    configData.states = states;
    configData.locationOverrides = configData.locationOverrides || {};
  }
  return configData;
}

function saveStaffConfig(configData) {
  const configPath = path.join(CONFIG_DIR, "instructors.json");
  const next = { ...configData, last_updated: new Date().toISOString() };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
}

function getLocationState(location, mapping) {
  const normalizeKey = (value) => String(value || "").trim().toLowerCase();
  const normalizedMapping = new Map(
    Object.entries(mapping || {}).map(([key, value]) => [normalizeKey(key), value])
  );
  const regionCandidates = [
    location.name,
    location.code,
    location.short_code,
    location.shortCode
  ].map(normalizeKey);
  return regionCandidates.map((key) => normalizedMapping.get(key)).find(Boolean) || location.name;
}

app.get("/api/instructors", (req, res) => {
  try {
    const configData = loadStaffConfig();
    const { states, locationMapping, locationOverrides } = configData;

    // Get current location from session/request (from location_id in query or default)
    const location_id = req.query.location_id || req.session?.location_id || 1;
    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(location_id);

    if (!location) {
      return res.json({ ok: true, instructors: [] });
    }
    const region = getLocationState(location, locationMapping);
    const baseStaff = (states[region] || []).map((i) => ({
      firstName: i.firstName,
      lastName: i.lastName,
      phone: i.phone || "",
      birthday: i.birthday || ""
    }));

    const overrideKey = location.code || location.name;
    const overrides = locationOverrides?.[overrideKey] || { add: [], remove: [] };
    const removeSet = new Set((overrides.remove || []).map((name) => name.toLowerCase()));
    let staffList = baseStaff.filter((i) => !removeSet.has(`${i.firstName} ${i.lastName}`.toLowerCase()));
    staffList = staffList.concat(overrides.add || []);

    const filtered = staffList
      .map((i) => ({
        displayName: `${i.firstName} ${i.lastName.charAt(0)}.`,
        fullName: `${i.firstName} ${i.lastName}`,
        firstName: i.firstName,
        lastName: i.lastName
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.json({ ok: true, instructors: filtered, location: location.name, region, override_key: overrideKey });
  } catch (error) {
    console.error("Instructor fetch error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get all staff for admin panel (includes phone and birthday)
app.get("/api/staff", (req, res) => {
  try {
    const configData = loadStaffConfig();
    const { states, locationOverrides } = configData;

    const staff = Object.entries(states || {}).flatMap(([state, list]) =>
      (list || []).map((i) => ({
        id: `${i.firstName}_${i.lastName}_${state}`,
        firstName: i.firstName,
        lastName: i.lastName,
        state,
        phone: i.phone || "",
        birthday: i.birthday || ""
      }))
    ).sort((a, b) => a.lastName.localeCompare(b.lastName));

    res.json({ ok: true, staff, overrides: locationOverrides || {} });
  } catch (error) {
    console.error("Staff fetch error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== STAFF AND LOCATION MANAGEMENT ====================

// Staff management endpoints
app.post("/api/admin/remove-staff", (req, res) => {
  try {
    const { firstName, lastName, scope, state, location_key, initials } = req.body || {};
    if (!firstName || !lastName) {
      return res.status(400).json({ ok: false, error: "First and last name required" });
    }
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const configData = loadStaffConfig();
    const scopeType = scope || "state";

    if (scopeType === "override") {
      if (!location_key) {
        return res.status(400).json({ ok: false, error: "location_key required for override removal" });
      }
      const overrides = configData.locationOverrides || {};
      const entry = overrides[location_key] || { add: [], remove: [] };
      entry.add = (entry.add || []).filter((i) => !(i.firstName === firstName && i.lastName === lastName));
      overrides[location_key] = entry;
      configData.locationOverrides = overrides;
      saveStaffConfig(configData);
      audit(req, "remove_staff_override", { details: { firstName, lastName, location_key, initials: initialsClean } });
      logActivity("remove_staff_override", { initials: initialsClean, details: { location_key, firstName, lastName } });
      return res.json({ ok: true, message: "Override staff removed successfully" });
    }

    if (!state) {
      return res.status(400).json({ ok: false, error: "state required for state removal" });
    }
    const list = configData.states?.[state] || [];
    const next = list.filter((i) => !(i.firstName === firstName && i.lastName === lastName));
    if (next.length === list.length) {
      return res.status(404).json({ ok: false, error: "Staff member not found" });
    }
    configData.states[state] = next;
    saveStaffConfig(configData);
    audit(req, "remove_staff", { details: { firstName, lastName, state, initials: initialsClean } });
    logActivity("remove_staff", { initials: initialsClean, details: { state, firstName, lastName } });
    res.json({ ok: true, message: "Staff member removed successfully" });
  } catch (error) {
    console.error("Remove staff error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/add-staff", (req, res) => {
  try {
    const { firstName, lastName, state, location_key, scope, phone, birthday } = req.body || {};
    if (!firstName || !lastName) {
      return res.status(400).json({ ok: false, error: "First name and last name are required" });
    }
    const configData = loadStaffConfig();
    const scopeType = scope || "state";

    if (scopeType === "override") {
      if (!location_key) {
        return res.status(400).json({ ok: false, error: "location_key required for override add" });
      }
      const overrides = configData.locationOverrides || {};
      const entry = overrides[location_key] || { add: [], remove: [] };
      const exists = (entry.add || []).some((i) => i.firstName === firstName && i.lastName === lastName);
      if (exists) {
        return res.status(400).json({ ok: false, error: "Override staff member already exists" });
      }
      entry.add = (entry.add || []).concat({
        firstName,
        lastName,
        phone: phone || "",
        birthday: birthday || ""
      });
      overrides[location_key] = entry;
      configData.locationOverrides = overrides;
      saveStaffConfig(configData);
      audit(req, "add_staff_override", { details: { firstName, lastName, location_key } });
      return res.json({ ok: true, message: "Override staff member added successfully" });
    }

    if (!state) {
      return res.status(400).json({ ok: false, error: "State is required" });
    }
    const list = configData.states?.[state] || [];
    const exists = list.some((i) => i.firstName === firstName && i.lastName === lastName);
    if (exists) {
      return res.status(400).json({ ok: false, error: "Staff member already exists" });
    }
    configData.states[state] = list.concat({
      firstName,
      lastName,
      phone: phone || "",
      birthday: birthday || ""
    }).sort((a, b) => a.lastName.localeCompare(b.lastName));
    saveStaffConfig(configData);
    audit(req, "add_staff", { details: { firstName, lastName, state } });
    res.json({ ok: true, message: "Staff member added successfully" });
  } catch (error) {
    console.error("Add staff error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/staff/override-remove", (req, res) => {
  try {
    const { location_key, firstName, lastName, initials } = req.body || {};
    if (!location_key || !firstName || !lastName) {
      return res.status(400).json({ ok: false, error: "location_key, firstName, lastName required" });
    }
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const configData = loadStaffConfig();
    const overrides = configData.locationOverrides || {};
    const entry = overrides[location_key] || { add: [], remove: [] };
    const fullName = `${firstName} ${lastName}`;
    if (!entry.remove.includes(fullName)) {
      entry.remove.push(fullName);
    }
    overrides[location_key] = entry;
    configData.locationOverrides = overrides;
    saveStaffConfig(configData);
    audit(req, "staff_override_remove", { details: { location_key, firstName, lastName, initials: initialsClean } });
    logActivity("staff_override_remove", { initials: initialsClean, details: { location_key, firstName, lastName } });
    res.json({ ok: true });
  } catch (error) {
    console.error("Override remove error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/staff/override-restore", (req, res) => {
  try {
    const { location_key, firstName, lastName } = req.body || {};
    if (!location_key || !firstName || !lastName) {
      return res.status(400).json({ ok: false, error: "location_key, firstName, lastName required" });
    }
    const configData = loadStaffConfig();
    const overrides = configData.locationOverrides || {};
    const entry = overrides[location_key] || { add: [], remove: [] };
    const fullName = `${firstName} ${lastName}`;
    entry.remove = (entry.remove || []).filter((name) => name !== fullName);
    overrides[location_key] = entry;
    configData.locationOverrides = overrides;
    saveStaffConfig(configData);
    audit(req, "staff_override_restore", { details: { location_key, firstName, lastName } });
    res.json({ ok: true });
  } catch (error) {
    console.error("Override restore error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Location management endpoints
app.post("/api/admin/remove-location", (req, res) => {
  try {
    const { id, initials } = req.body;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Location ID required' });
    }
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }

    // Set location as inactive instead of deleting
    const result = db.prepare(`UPDATE locations SET active = 0 WHERE id = ?`).run(id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Location not found' });
    }

    audit(req, "remove_location", { location_id: id, details: { initials: initialsClean } });
    logActivity("remove_location", { location_id: id, initials: initialsClean });
    res.json({ ok: true, message: 'Location removed successfully' });
  } catch (error) {
    console.error("Remove location error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/add-location", (req, res) => {
  try {
    const { name, short_code, brand } = req.body;

    if (!name) {
      return res.status(400).json({ ok: false, error: 'Location name is required' });
    }

    // Check if location already exists
    const existing = db.prepare(`SELECT id FROM locations WHERE name = ?`).get(name);
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Location already exists' });
    }

    const result = db.prepare(`
      INSERT INTO locations (name, short_code, brand, active)
      VALUES (?, ?, ?, 1)
    `).run(name, short_code || '', brand || 'swimlabs');

    audit(req, "add_location", { name, short_code, brand });
    res.json({ ok: true, message: 'Location added successfully', location_id: result.lastInsertRowid });
  } catch (error) {
    console.error("Add location error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ADMIN PIN VERIFICATION ====================
const pinAttempts = new Map(); // Track failed attempts by IP
const pinLockouts = new Map(); // Track lockout expiry by IP

app.post("/api/verify-pin", (req, res) => {
  try {
    const { pin, pin_type } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;

    // Load settings
    const settingsPath = path.join(CONFIG_DIR, "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return res.status(500).json({ ok: false, error: 'settings.json not found' });
    }

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const adminPin = settings.admin_pin || ADMIN_PIN;
    const managerPin = settings.manager_pin || MANAGER_PIN;
    const requestedType = String(pin_type || "admin");
    const allowAdmin = pin === adminPin;
    const allowManager = pin === managerPin;

    // Check if client is locked out
    const lockoutUntil = pinLockouts.get(clientIp);
    if (lockoutUntil && Date.now() < lockoutUntil) {
      const remainingSeconds = Math.ceil((lockoutUntil - Date.now()) / 1000);
      return res.status(429).json({
        ok: false,
        error: 'Too many failed attempts',
        locked_until: lockoutUntil,
        remaining_seconds: remainingSeconds
      });
    }

    // Verify PIN
    if ((requestedType === "manager" && (allowManager || allowAdmin)) || (requestedType === "admin" && allowAdmin)) {
      // Success - clear attempts and lockout
      pinAttempts.delete(clientIp);
      pinLockouts.delete(clientIp);

      audit(req, "pin_success", { ip: clientIp, details: { pin_type: requestedType } });

      return res.json({
        ok: true,
        authenticated: true,
        role: allowAdmin ? "admin" : "manager",
        expires_at: Date.now() + (2 * 60 * 60 * 1000) // 2 hours from now
      });
    }

    // Failed attempt
    const attempts = (pinAttempts.get(clientIp) || 0) + 1;
    pinAttempts.set(clientIp, attempts);

    audit(req, "pin_failed", { ip: clientIp, attempts, details: { pin_type: requestedType } });

    if (attempts >= 3) {
      // Lockout for 2 minutes
      const lockoutUntil = Date.now() + (2 * 60 * 1000);
      pinLockouts.set(clientIp, lockoutUntil);
      pinAttempts.delete(clientIp);

      return res.status(429).json({
        ok: false,
        error: 'Too many failed attempts. Locked for 2 minutes.',
        locked_until: lockoutUntil,
        remaining_seconds: 120
      });
    }

    return res.status(401).json({
      ok: false,
      error: 'Incorrect PIN',
      attempts_remaining: 3 - attempts
    });

  } catch (error) {
    console.error("PIN verification error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== READ-ONLY MODE ====================
app.get("/api/read-only", (req, res) => {
  try {
    res.json({ ok: true, read_only: getReadOnlyMode() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/read-only", (req, res) => {
  try {
    const enabled = !!req.body?.read_only;
    const initials = normalizeInitials(req.body?.initials || "");
    if (!initials) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const value = setReadOnlyMode(enabled);
    audit(req, "read_only_toggle", { details: { enabled: value, initials } });
    logActivity("read_only_toggle", { initials, details: { enabled: value } });
    res.json({ ok: true, read_only: value });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ACTIVITY LOG ====================
app.get("/api/admin/activity-log", (req, res) => {
  try {
    const limit = Math.min(500, Math.max(50, Number(req.query?.limit || 200)));
    const rows = db.prepare(`
      SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    res.json({ ok: true, entries: rows });
  } catch (error) {
    console.error("Activity log error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ADMIN CLEAR ROSTER ====================
app.post("/api/clear-roster", (req, res) => {
  try {
    const { location_id, initials } = req.body || {};
    const locId = location_id || 1;
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const date = activeOrToday();

    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    // Get existing roster to export as backup
    const existingRoster = db.prepare(`
      SELECT * FROM roster
      WHERE date = ? AND location_id = ?
    `).all(date, locId);

    let backupFile = null;

    if (existingRoster.length > 0) {
      // Create export directory for this location on server
      const exportDir = path.join(EXPORT_DIR, location.code);
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      // Generate timestamp for filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFilename = `roster_CLEARED_${location.code}_${date}_${timestamp}.json`;
      const exportPath = path.join(exportDir, exportFilename);

      // Save existing roster to JSON on server
      fs.writeFileSync(exportPath, JSON.stringify({
        location: location.name,
        location_code: location.code,
        date: date,
        cleared_at: nowISO(),
        count: existingRoster.length,
        roster: existingRoster
      }, null, 2), 'utf-8');

      backupFile = `${location.code}/${exportFilename}`;
      console.log(`[ADMIN CLEAR] Backed up ${existingRoster.length} swimmers to: ${backupFile}`);
    }

    // Delete all roster data for this location and date
    const result = db.prepare(`
      DELETE FROM roster WHERE date = ? AND location_id = ?
    `).run(date, locId);

    audit(req, "admin_clear_roster", {
      location: location.name,
      location_id: locId,
      date: date,
      deleted_count: result.changes,
      backup_file: backupFile,
      initials: initialsClean
    });
    logActivity("clear_roster", { location_id: locId, initials: initialsClean, details: { date, backup_file: backupFile } });

    console.log(`[ADMIN CLEAR] Deleted ${result.changes} swimmers for ${location.name} (${date})`);

    res.json({
      ok: true,
      deleted_count: result.changes,
      backup_file: backupFile,
      location: location.name,
      date: date
    });

  } catch (error) {
    console.error("Clear roster error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ADMIN CLEAR FUTURE ROSTER ====================
app.post("/api/clear-roster-future", (req, res) => {
  try {
    const { location_id, initials } = req.body || {};
    const locId = location_id || 1;
    const initialsClean = normalizeInitials(initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const today = todayISO();

    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const existingRoster = db.prepare(`
      SELECT * FROM roster
      WHERE date >= ? AND location_id = ?
    `).all(today, locId);

    let backupFile = null;
    if (existingRoster.length > 0) {
      const exportDir = path.join(EXPORT_DIR, location.code);
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFilename = `roster_CLEARED_FUTURE_${location.code}_${today}_${timestamp}.json`;
      const exportPath = path.join(exportDir, exportFilename);

      fs.writeFileSync(exportPath, JSON.stringify({
        location: location.name,
        location_code: location.code,
        date_start: today,
        cleared_at: nowISO(),
        count: existingRoster.length,
        roster: existingRoster
      }, null, 2), 'utf-8');

      backupFile = `${location.code}/${exportFilename}`;
      console.log(`[ADMIN CLEAR FUTURE] Backed up ${existingRoster.length} swimmers to: ${backupFile}`);
    }

    const result = db.prepare(`
      DELETE FROM roster WHERE date >= ? AND location_id = ?
    `).run(today, locId);

    audit(req, "admin_clear_roster_future", {
      location: location.name,
      location_id: locId,
      date_start: today,
      deleted_count: result.changes,
      backup_file: backupFile,
      initials: initialsClean
    });
    logActivity("clear_roster_future", { location_id: locId, initials: initialsClean, details: { date_start: today, backup_file: backupFile } });

    console.log(`[ADMIN CLEAR FUTURE] Deleted ${result.changes} swimmers for ${location.name} (from ${today})`);

    res.json({
      ok: true,
      deleted_count: result.changes,
      backup_file: backupFile,
      location: location.name,
      date_start: today
    });
  } catch (error) {
    console.error("Clear future roster error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== ADMIN CLEAR ALL ROSTERS ====================
app.post("/api/clear-roster-all", (req, res) => {
  try {
    const initialsClean = normalizeInitials(req.body?.initials);
    if (!initialsClean) {
      return res.status(400).json({ ok: false, error: "Initials required" });
    }
    const pinCheck = verifyPin(req.body?.pin, "admin");
    if (!pinCheck.ok) {
      return res.status(401).json({ ok: false, error: "Invalid admin PIN" });
    }
    const date = activeOrToday();
    const startDate = req.body?.start_date || null;
    const endDate = req.body?.end_date || null;
    if ((startDate && !endDate) || (!startDate && endDate)) {
      return res.status(400).json({ ok: false, error: "Both start_date and end_date are required to clear a window." });
    }
    const hasRange = startDate && endDate;
    const selectSql = hasRange
      ? `SELECT * FROM roster WHERE date BETWEEN ? AND ?`
      : `SELECT * FROM roster`;
    const existingRoster = hasRange
      ? db.prepare(selectSql).all(startDate, endDate)
      : db.prepare(selectSql).all();
    let backupFile = null;

    if (existingRoster.length > 0) {
      const exportDir = path.join(EXPORT_DIR, "ALL");
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFilename = `roster_CLEARED_ALL_${date}_${timestamp}.json`;
      const exportPath = path.join(exportDir, exportFilename);

      fs.writeFileSync(exportPath, JSON.stringify({
        date: date,
        start_date: startDate,
        end_date: endDate,
        cleared_at: nowISO(),
        count: existingRoster.length,
        roster: existingRoster
      }, null, 2), 'utf-8');

      backupFile = `ALL/${exportFilename}`;
      console.log(`[ADMIN CLEAR ALL] Backed up ${existingRoster.length} swimmers to: ${backupFile}`);
    }

    const deleteSql = hasRange
      ? `DELETE FROM roster WHERE date BETWEEN ? AND ?`
      : `DELETE FROM roster`;
    const result = hasRange
      ? db.prepare(deleteSql).run(startDate, endDate)
      : db.prepare(deleteSql).run();

    audit(req, "admin_clear_roster_all", {
      date: date,
      start_date: startDate,
      end_date: endDate,
      deleted_count: result.changes,
      backup_file: backupFile,
      initials: initialsClean
    });
    logActivity("clear_roster_all", { initials: initialsClean, details: { start_date: startDate, end_date: endDate, backup_file: backupFile } });

    console.log(`[ADMIN CLEAR ALL] Deleted ${result.changes} roster rows`);

    res.json({
      ok: true,
      deleted_count: result.changes,
      backup_file: backupFile,
      date: date,
      start_date: startDate,
      end_date: endDate
    });
  } catch (error) {
    console.error("Clear all rosters error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin stats endpoint
app.get("/api/admin/stats", (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get today's swimmer count
    const swimmerCount = db.prepare(`
      SELECT COUNT(DISTINCT swimmer_name) as count
      FROM roster
      WHERE date = ?
    `).get(today);

    // Get attendance rate for today
    const attendanceStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as present
      FROM roster
      WHERE date = ? AND attendance IS NOT NULL
    `).get(today);

    const attendanceRate = attendanceStats.total > 0
      ? Math.round((attendanceStats.present / attendanceStats.total) * 100)
      : 0;

    // Get trial count for this week
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const weekStart = startOfWeek.toISOString().split('T')[0];

    const trialCount = db.prepare(`
      SELECT COUNT(DISTINCT swimmer_name) as count
      FROM roster
      WHERE date >= ? AND flag_trial = 1
    `).get(weekStart);

    res.json({
      ok: true,
      stats: {
        swimmers_today: swimmerCount.count || 0,
        attendance_rate: attendanceRate,
        trials_this_week: trialCount.count || 0
      }
    });

  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Trial follow-up report
app.get("/api/trials", (req, res) => {
  try {
    const locationId = Number(req.query.location_id || 1);
    const location = getLocationById(locationId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const days = Math.max(1, Math.min(120, Number(req.query.days || 30)));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startISO = startDate.toISOString().split('T')[0];

    const trials = db.prepare(`
      SELECT
        swimmer_name,
        MAX(date) as last_date,
        COUNT(*) as trial_visits,
        MAX(program) as program,
        MAX(instructor_name) as instructor_name,
        MAX(balance_amount) as balance_amount
      FROM roster
      WHERE location_id = ? AND flag_trial = 1 AND date >= ?
      GROUP BY swimmer_name
      ORDER BY last_date DESC, swimmer_name ASC
    `).all(locationId, startISO);

    const followups = db.prepare(`
      SELECT swimmer_name, status, last_contact_at, next_follow_up_at, notes, updated_at
      FROM trial_followups
      WHERE location_id = ?
    `).all(locationId);

    const followupMap = new Map(followups.map((f) => [f.swimmer_name, f]));
    const results = trials.map((t) => {
      const follow = followupMap.get(t.swimmer_name);
      return {
        swimmer_name: t.swimmer_name,
        last_date: t.last_date,
        trial_visits: t.trial_visits,
        program: t.program,
        instructor_name: t.instructor_name,
        balance_amount: t.balance_amount,
        follow_up: follow || {
          status: "new",
          last_contact_at: null,
          next_follow_up_at: null,
          notes: "",
          updated_at: null
        }
      };
    });

    res.json({ ok: true, trials: results, days, start_date: startISO });
  } catch (error) {
    console.error("Trial report error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/trials/followup", (req, res) => {
  try {
    const { swimmer_name, location_id, status, last_contact_at, next_follow_up_at, notes } = req.body || {};
    if (!swimmer_name) {
      return res.status(400).json({ ok: false, error: "swimmer_name required" });
    }

    const locationId = Number(location_id || 1);
    const location = getLocationById(locationId);
    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const now = nowISO();
    db.prepare(`
      INSERT INTO trial_followups (
        swimmer_name, location_id, status, last_contact_at, next_follow_up_at, notes, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(swimmer_name, location_id) DO UPDATE SET
        status=excluded.status,
        last_contact_at=excluded.last_contact_at,
        next_follow_up_at=excluded.next_follow_up_at,
        notes=excluded.notes,
        updated_at=excluded.updated_at
    `).run(
      swimmer_name,
      locationId,
      status || "new",
      last_contact_at || null,
      next_follow_up_at || null,
      notes || null,
      now,
      now
    );

    audit(req, "trial_followup_update", {
      location_id: locationId,
      swimmer_name,
      status: status || "new"
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Trial follow-up update error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Virtual Desk: Detailed swimmer data
app.get("/api/virtual-desk/swimmers", (req, res) => {
  try {
    const { date, location_id } = req.query;

    if (!date || !location_id) {
      return res.status(400).json({ ok: false, error: 'date and location_id required' });
    }

    // Get all swimmers for the specified date and location with detailed information
    const swimmers = db.prepare(`
      SELECT
        swimmer_name,
        age_text,
        program,
        instructor_name,
        substitute_instructor,
        zone,
        start_time,
        attendance,
        is_addon,
        flag_new,
        flag_makeup,
        flag_policy,
        flag_owes,
        flag_trial,
        balance_amount
      FROM roster
      WHERE date = ? AND location_id = ?
      ORDER BY start_time, instructor_name, swimmer_name
    `).all(date, location_id);

    // Calculate attendance statistics for each swimmer
    const swimmerDetails = swimmers.map(s => {
      // Get historical attendance for this swimmer
      const attendanceHistory = db.prepare(`
        SELECT
          date,
          start_time,
          attendance,
          program,
          instructor_name
        FROM roster
        WHERE swimmer_name = ? AND location_id = ?
        ORDER BY date DESC, start_time DESC
        LIMIT 30
      `).all(s.swimmer_name, location_id);

      const totalClasses = attendanceHistory.length;
      const attendedCount = attendanceHistory.filter(a => a.attendance === 1).length;
      const missedCount = attendanceHistory.filter(a => a.attendance === 0).length;
      const attendanceRate = totalClasses > 0 ? Math.round((attendedCount / totalClasses) * 100) : 0;

      // Determine balance status
      let balanceStatus = 'current';
      if (s.flag_owes) balanceStatus = 'owes';
      else if (s.flag_policy) balanceStatus = 'policy';

      return {
        swimmer_name: s.swimmer_name,
        age_text: s.age_text,
        program: s.program,
        instructor_name: s.instructor_name,
        substitute_instructor: s.substitute_instructor,
        zone: s.zone,
        start_time: s.start_time,
        attendance: s.attendance,
        is_addon: s.is_addon,
        balance_amount: s.balance_amount,
        flags: {
          new: s.flag_new,
          makeup: s.flag_makeup,
          policy: s.flag_policy,
          owes: s.flag_owes,
          trial: s.flag_trial
        },
        stats: {
          total_classes: totalClasses,
          attended: attendedCount,
          missed: missedCount,
          attendance_rate: attendanceRate
        },
        attendance_history: attendanceHistory,
        balance_status: balanceStatus
      };
    });

    res.json({ ok: true, swimmers: swimmerDetails, date, location_id });

  } catch (error) {
    console.error("Virtual desk swimmers error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/add-location", (req, res) => {
  try {
    const { code, name, has_announcements, brand } = req.body;

    if (!code || !name) {
      return res.status(400).json({ ok: false, error: 'code and name required' });
    }

    // Create directories
    const schedDir = path.join(SCHEDULE_DIR, sanitizeDirSegment(name));
    const expDir = path.join(EXPORT_DIR, code);
    if (!fs.existsSync(schedDir)) fs.mkdirSync(schedDir, { recursive: true });
    if (!fs.existsSync(expDir)) fs.mkdirSync(expDir, { recursive: true });
    
    const insert = db.prepare(`
      INSERT INTO locations (code, name, has_announcements, brand)
      VALUES (?, ?, ?, ?)
    `);
    const result = insert.run(code, name, has_announcements ? 1 : 0, brand || 'swimlabs');
    
    audit(req, "add_location", { code, name });
    res.json({ ok: true, location_id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================
// ENHANCED REPORTING FEATURES (v4.7.x)
// =============================================================

// Virtual Desk Export: Export swimmer details to CSV or JSON
app.get("/api/reports/virtual-desk/export", (req, res) => {
  try {
    const { date, location_id, format } = req.query;

    if (!date || !location_id) {
      return res.status(400).json({ ok: false, error: 'date and location_id required' });
    }

    const location = getLocationById(Number(location_id));
    if (!location) {
      return res.status(400).json({ ok: false, error: 'Invalid location' });
    }

    // Get all swimmers for the specified date and location
    const swimmers = db.prepare(`
      SELECT
        swimmer_name,
        age_text,
        program,
        instructor_name,
        substitute_instructor,
        zone,
        start_time,
        attendance,
        is_addon,
        flag_new,
        flag_makeup,
        flag_policy,
        flag_owes,
        flag_trial,
        balance_amount
      FROM roster
      WHERE date = ? AND location_id = ?
      ORDER BY start_time, instructor_name, swimmer_name
    `).all(date, location_id);

    // Calculate attendance statistics for each swimmer
    const swimmerDetails = swimmers.map(s => {
      const attendanceHistory = db.prepare(`
        SELECT date, attendance
        FROM roster
        WHERE swimmer_name = ? AND location_id = ? AND attendance IS NOT NULL
        ORDER BY date DESC
        LIMIT 30
      `).all(s.swimmer_name, location_id);

      const totalClasses = attendanceHistory.length;
      const attendedCount = attendanceHistory.filter(a => a.attendance === 1).length;
      const missedCount = attendanceHistory.filter(a => a.attendance === 0).length;
      const attendanceRate = totalClasses > 0 ? Math.round((attendedCount / totalClasses) * 100) : 0;

      return {
        swimmer_name: s.swimmer_name,
        age_text: s.age_text || '',
        program: s.program || '',
        instructor_name: s.instructor_name || '',
        substitute_instructor: s.substitute_instructor || '',
        zone: s.zone || '',
        start_time: s.start_time,
        start_time_12h: formatTime12h(s.start_time),
        attendance: s.attendance === 1 ? 'Present' : s.attendance === 0 ? 'Absent' : 'Unmarked',
        is_addon: s.is_addon ? 'Yes' : 'No',
        flag_new: s.flag_new ? 'Yes' : 'No',
        flag_makeup: s.flag_makeup ? 'Yes' : 'No',
        flag_policy: s.flag_policy ? 'Yes' : 'No',
        flag_owes: s.flag_owes ? 'Yes' : 'No',
        flag_trial: s.flag_trial ? 'Yes' : 'No',
        balance_amount: s.balance_amount || 0,
        total_classes_30d: totalClasses,
        attended_30d: attendedCount,
        missed_30d: missedCount,
        attendance_rate: attendanceRate
      };
    });

    // Export as JSON
    if (format === 'json') {
      const filename = `virtual_desk_${location.code}_${date}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.json({
        export_date: nowISO(),
        roster_date: date,
        location: location.name,
        location_code: location.code,
        total_swimmers: swimmerDetails.length,
        swimmers: swimmerDetails
      });
    }

    // Default: Export as CSV
    const header = [
      "swimmer_name", "age", "program", "instructor", "substitute_instructor",
      "zone", "start_time", "start_time_12h", "attendance",
      "is_addon", "new", "makeup", "policy", "owes", "trial",
      "balance_amount", "total_classes_30d", "attended_30d", "missed_30d", "attendance_rate"
    ];

    const lines = [header.join(",")];
    for (const r of swimmerDetails) {
      const vals = [
        r.swimmer_name, r.age_text, r.program, r.instructor_name, r.substitute_instructor,
        r.zone, r.start_time, r.start_time_12h, r.attendance,
        r.is_addon, r.flag_new, r.flag_makeup, r.flag_policy, r.flag_owes, r.flag_trial,
        r.balance_amount, r.total_classes_30d, r.attended_30d, r.missed_30d, r.attendance_rate + '%'
      ].map(x => {
        const s = String(x ?? "");
        if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      lines.push(vals.join(","));
    }

    const csv = lines.join("\n");
    const filename = `virtual_desk_${location.code}_${date}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error("Virtual desk export error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Attendance Reports: Comprehensive attendance analytics with date range
app.get("/api/reports/attendance", (req, res) => {
  try {
    const { location_id, start_date, end_date, group_by } = req.query;

    if (!location_id) {
      return res.status(400).json({ ok: false, error: 'location_id required' });
    }

    const location = getLocationById(Number(location_id));
    if (!location) {
      return res.status(400).json({ ok: false, error: 'Invalid location' });
    }

    // Default to last 30 days if no dates provided
    const endDt = end_date || todayISO();
    const startDt = start_date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().split('T')[0];
    })();

    // Overall stats for the period
    const overallStats = db.prepare(`
      SELECT
        COUNT(*) as total_entries,
        COUNT(DISTINCT swimmer_name) as unique_swimmers,
        COUNT(DISTINCT date) as days_with_classes,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as total_present,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as total_absent,
        SUM(CASE WHEN attendance IS NULL THEN 1 ELSE 0 END) as total_unmarked,
        SUM(CASE WHEN flag_trial = 1 THEN 1 ELSE 0 END) as total_trials,
        SUM(CASE WHEN flag_new = 1 THEN 1 ELSE 0 END) as total_new,
        SUM(CASE WHEN flag_makeup = 1 THEN 1 ELSE 0 END) as total_makeups
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ?
    `).get(location_id, startDt, endDt);

    const markedEntries = (overallStats.total_present || 0) + (overallStats.total_absent || 0);
    const overallRate = markedEntries > 0
      ? Math.round((overallStats.total_present / markedEntries) * 100)
      : 0;

    // Daily breakdown
    const dailyStats = db.prepare(`
      SELECT
        date,
        COUNT(*) as total,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as absent,
        SUM(CASE WHEN attendance IS NULL THEN 1 ELSE 0 END) as unmarked
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date DESC
    `).all(location_id, startDt, endDt);

    const dailyWithRates = dailyStats.map(d => {
      const marked = d.present + d.absent;
      return {
        ...d,
        attendance_rate: marked > 0 ? Math.round((d.present / marked) * 100) : 0
      };
    });

    // Program breakdown
    const programStats = db.prepare(`
      SELECT
        program,
        COUNT(*) as total,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as absent
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ?
      GROUP BY program
      ORDER BY total DESC
    `).all(location_id, startDt, endDt);

    const programWithRates = programStats.map(p => {
      const marked = p.present + p.absent;
      return {
        ...p,
        attendance_rate: marked > 0 ? Math.round((p.present / marked) * 100) : 0
      };
    });

    // Time slot breakdown
    const timeSlotStats = db.prepare(`
      SELECT
        start_time,
        COUNT(*) as total,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as absent
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ?
      GROUP BY start_time
      ORDER BY start_time
    `).all(location_id, startDt, endDt);

    const timeSlotWithRates = timeSlotStats.map(t => {
      const marked = t.present + t.absent;
      return {
        ...t,
        start_time_12h: formatTime12h(t.start_time),
        attendance_rate: marked > 0 ? Math.round((t.present / marked) * 100) : 0
      };
    });

    // Low attendance swimmers (< 70% attendance rate)
    const lowAttendanceSwimmers = db.prepare(`
      SELECT
        swimmer_name,
        COUNT(*) as total_classes,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as attended,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as missed
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ? AND attendance IS NOT NULL
      GROUP BY swimmer_name
      HAVING (SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) < 70
      ORDER BY (SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) ASC
      LIMIT 20
    `).all(location_id, startDt, endDt);

    const lowAttendanceWithRates = lowAttendanceSwimmers.map(s => ({
      ...s,
      attendance_rate: s.total_classes > 0 ? Math.round((s.attended / s.total_classes) * 100) : 0
    }));

    res.json({
      ok: true,
      report: {
        location: location.name,
        location_code: location.code,
        period: { start_date: startDt, end_date: endDt },
        generated_at: nowISO(),
        summary: {
          total_entries: overallStats.total_entries || 0,
          unique_swimmers: overallStats.unique_swimmers || 0,
          days_with_classes: overallStats.days_with_classes || 0,
          total_present: overallStats.total_present || 0,
          total_absent: overallStats.total_absent || 0,
          total_unmarked: overallStats.total_unmarked || 0,
          overall_attendance_rate: overallRate,
          total_trials: overallStats.total_trials || 0,
          total_new_swimmers: overallStats.total_new || 0,
          total_makeups: overallStats.total_makeups || 0
        },
        by_date: dailyWithRates,
        by_program: programWithRates,
        by_time_slot: timeSlotWithRates,
        low_attendance_swimmers: lowAttendanceWithRates
      }
    });

  } catch (error) {
    console.error("Attendance report error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Attendance Report Export
app.get("/api/reports/attendance/export", (req, res) => {
  try {
    const { location_id, start_date, end_date, format } = req.query;

    if (!location_id) {
      return res.status(400).json({ ok: false, error: 'location_id required' });
    }

    const location = getLocationById(Number(location_id));
    if (!location) {
      return res.status(400).json({ ok: false, error: 'Invalid location' });
    }

    const endDt = end_date || todayISO();
    const startDt = start_date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().split('T')[0];
    })();

    const rows = db.prepare(`
      SELECT
        date, start_time, swimmer_name, instructor_name, program, zone,
        attendance, flag_new, flag_makeup, flag_trial, balance_amount
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ?
      ORDER BY date DESC, start_time, swimmer_name
    `).all(location_id, startDt, endDt);

    if (format === 'json') {
      const filename = `attendance_report_${location.code}_${startDt}_to_${endDt}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.json({
        export_date: nowISO(),
        location: location.name,
        period: { start_date: startDt, end_date: endDt },
        total_records: rows.length,
        records: rows.map(r => ({
          ...r,
          start_time_12h: formatTime12h(r.start_time),
          attendance_status: r.attendance === 1 ? 'Present' : r.attendance === 0 ? 'Absent' : 'Unmarked'
        }))
      });
    }

    // CSV export
    const header = ["date", "start_time", "start_time_12h", "swimmer_name", "instructor", "program", "zone", "attendance", "new", "makeup", "trial", "balance"];
    const lines = [header.join(",")];

    for (const r of rows) {
      const vals = [
        r.date,
        r.start_time,
        formatTime12h(r.start_time),
        r.swimmer_name,
        r.instructor_name || '',
        r.program || '',
        r.zone || '',
        r.attendance === 1 ? 'Present' : r.attendance === 0 ? 'Absent' : 'Unmarked',
        r.flag_new ? 'Yes' : 'No',
        r.flag_makeup ? 'Yes' : 'No',
        r.flag_trial ? 'Yes' : 'No',
        r.balance_amount || ''
      ].map(x => {
        const s = String(x ?? "");
        if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      lines.push(vals.join(","));
    }

    const csv = lines.join("\n");
    const filename = `attendance_report_${location.code}_${startDt}_to_${endDt}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error("Attendance report export error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Instructor Performance Analytics
app.get("/api/reports/instructors", (req, res) => {
  try {
    const { location_id, start_date, end_date } = req.query;

    if (!location_id) {
      return res.status(400).json({ ok: false, error: 'location_id required' });
    }

    const location = getLocationById(Number(location_id));
    if (!location) {
      return res.status(400).json({ ok: false, error: 'Invalid location' });
    }

    const endDt = end_date || todayISO();
    const startDt = start_date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().split('T')[0];
    })();

    // Get instructor performance metrics
    const instructorStats = db.prepare(`
      SELECT
        instructor_name,
        COUNT(DISTINCT date) as days_worked,
        COUNT(*) as total_swimmers,
        COUNT(DISTINCT swimmer_name) as unique_swimmers,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as swimmers_present,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as swimmers_absent,
        COUNT(DISTINCT program) as programs_taught,
        GROUP_CONCAT(DISTINCT program) as program_list
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ? AND instructor_name IS NOT NULL AND instructor_name != ''
      GROUP BY instructor_name
      ORDER BY total_swimmers DESC
    `).all(location_id, startDt, endDt);

    const instructorDetails = instructorStats.map(i => {
      const markedTotal = i.swimmers_present + i.swimmers_absent;
      const attendanceRate = markedTotal > 0 ? Math.round((i.swimmers_present / markedTotal) * 100) : 0;

      // Get time slot distribution for this instructor
      const timeSlots = db.prepare(`
        SELECT start_time, COUNT(*) as count
        FROM roster
        WHERE location_id = ? AND date >= ? AND date <= ? AND instructor_name = ?
        GROUP BY start_time
        ORDER BY count DESC
        LIMIT 5
      `).all(location_id, startDt, endDt, i.instructor_name);

      // Get most recent classes
      const recentClasses = db.prepare(`
        SELECT date, start_time, program, COUNT(*) as swimmer_count
        FROM roster
        WHERE location_id = ? AND date >= ? AND date <= ? AND instructor_name = ?
        GROUP BY date, start_time, program
        ORDER BY date DESC, start_time DESC
        LIMIT 10
      `).all(location_id, startDt, endDt, i.instructor_name);

      return {
        instructor_name: i.instructor_name,
        days_worked: i.days_worked,
        total_class_entries: i.total_swimmers,
        unique_swimmers: i.unique_swimmers,
        swimmers_present: i.swimmers_present,
        swimmers_absent: i.swimmers_absent,
        class_attendance_rate: attendanceRate,
        programs_taught: i.programs_taught,
        program_list: i.program_list ? i.program_list.split(',') : [],
        common_time_slots: timeSlots.map(t => ({
          time: t.start_time,
          time_12h: formatTime12h(t.start_time),
          count: t.count
        })),
        recent_classes: recentClasses.map(c => ({
          date: c.date,
          time: c.start_time,
          time_12h: formatTime12h(c.start_time),
          program: c.program,
          swimmer_count: c.swimmer_count
        }))
      };
    });

    // Top performers by attendance rate (min 10 entries)
    const topByAttendance = [...instructorDetails]
      .filter(i => (i.swimmers_present + i.swimmers_absent) >= 10)
      .sort((a, b) => b.class_attendance_rate - a.class_attendance_rate)
      .slice(0, 5);

    // Most active instructors
    const mostActive = [...instructorDetails]
      .sort((a, b) => b.total_class_entries - a.total_class_entries)
      .slice(0, 5);

    res.json({
      ok: true,
      report: {
        location: location.name,
        location_code: location.code,
        period: { start_date: startDt, end_date: endDt },
        generated_at: nowISO(),
        summary: {
          total_instructors: instructorDetails.length,
          total_class_entries: instructorDetails.reduce((sum, i) => sum + i.total_class_entries, 0),
          average_attendance_rate: instructorDetails.length > 0
            ? Math.round(instructorDetails.reduce((sum, i) => sum + i.class_attendance_rate, 0) / instructorDetails.length)
            : 0
        },
        instructors: instructorDetails,
        highlights: {
          top_by_attendance: topByAttendance.map(i => ({
            name: i.instructor_name,
            attendance_rate: i.class_attendance_rate,
            total_entries: i.total_class_entries
          })),
          most_active: mostActive.map(i => ({
            name: i.instructor_name,
            total_entries: i.total_class_entries,
            days_worked: i.days_worked
          }))
        }
      }
    });

  } catch (error) {
    console.error("Instructor report error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Instructor Report Export
app.get("/api/reports/instructors/export", (req, res) => {
  try {
    const { location_id, start_date, end_date, format } = req.query;

    if (!location_id) {
      return res.status(400).json({ ok: false, error: 'location_id required' });
    }

    const location = getLocationById(Number(location_id));
    if (!location) {
      return res.status(400).json({ ok: false, error: 'Invalid location' });
    }

    const endDt = end_date || todayISO();
    const startDt = start_date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().split('T')[0];
    })();

    const instructorStats = db.prepare(`
      SELECT
        instructor_name,
        COUNT(DISTINCT date) as days_worked,
        COUNT(*) as total_swimmers,
        COUNT(DISTINCT swimmer_name) as unique_swimmers,
        SUM(CASE WHEN attendance = 1 THEN 1 ELSE 0 END) as swimmers_present,
        SUM(CASE WHEN attendance = 0 THEN 1 ELSE 0 END) as swimmers_absent,
        COUNT(DISTINCT program) as programs_taught,
        GROUP_CONCAT(DISTINCT program) as program_list
      FROM roster
      WHERE location_id = ? AND date >= ? AND date <= ? AND instructor_name IS NOT NULL AND instructor_name != ''
      GROUP BY instructor_name
      ORDER BY total_swimmers DESC
    `).all(location_id, startDt, endDt);

    const rows = instructorStats.map(i => {
      const marked = i.swimmers_present + i.swimmers_absent;
      return {
        instructor_name: i.instructor_name,
        days_worked: i.days_worked,
        total_class_entries: i.total_swimmers,
        unique_swimmers: i.unique_swimmers,
        swimmers_present: i.swimmers_present,
        swimmers_absent: i.swimmers_absent,
        attendance_rate: marked > 0 ? Math.round((i.swimmers_present / marked) * 100) : 0,
        programs_taught: i.programs_taught,
        program_list: i.program_list || ''
      };
    });

    if (format === 'json') {
      const filename = `instructor_report_${location.code}_${startDt}_to_${endDt}.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.json({
        export_date: nowISO(),
        location: location.name,
        period: { start_date: startDt, end_date: endDt },
        total_instructors: rows.length,
        instructors: rows
      });
    }

    // CSV export
    const header = ["instructor", "days_worked", "total_class_entries", "unique_swimmers", "present", "absent", "attendance_rate", "programs_taught", "program_list"];
    const lines = [header.join(",")];

    for (const r of rows) {
      const vals = [
        r.instructor_name,
        r.days_worked,
        r.total_class_entries,
        r.unique_swimmers,
        r.swimmers_present,
        r.swimmers_absent,
        r.attendance_rate + '%',
        r.programs_taught,
        r.program_list
      ].map(x => {
        const s = String(x ?? "");
        if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      lines.push(vals.join(","));
    }

    const csv = lines.join("\n");
    const filename = `instructor_report_${location.code}_${startDt}_to_${endDt}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    console.error("Instructor report export error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

function scheduleGuardTaskSnapshots() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const delay = nextMidnight.getTime() - now.getTime();
  setTimeout(() => {
    try {
      const today = todayISO();
      const rows = db.prepare(`SELECT * FROM guard_tasks WHERE task_date = ?`).all(today);
      const savedAt = nowISO();
      const insert = db.prepare(`
        INSERT INTO guard_task_history(location_id, task_date, data_json, saved_at)
        VALUES (?, ?, ?, ?)
      `);
      rows.forEach((row) => {
        insert.run(row.location_id, row.task_date, row.data_json, savedAt);
      });
    } catch (error) {
      console.error("Guard task midnight snapshot error:", error);
    }
    scheduleGuardTaskSnapshots();
  }, Math.max(1000, delay));
}

scheduleGuardTaskSnapshots();

app.listen(PORT, () => {
  console.log(`SwimLabs Announcer server running on http://localhost:${PORT}`);
});
