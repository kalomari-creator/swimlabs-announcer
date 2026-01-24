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

// -------------------- CONFIG --------------------
const MANAGER_CODE = process.env.MANAGER_CODE || "4729";
const MAX_FAILS = 3;
const LOCKOUT_MS = 2 * 60 * 1000;

// -------------------- Paths --------------------
const dbPath = path.join(__dirname, "data", "app.db");
if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

const SCHEDULE_DIR = path.join(__dirname, "schedules");
const EXPORT_DIR = path.join(__dirname, "exports");

// Piper TTS
let PIPER_BIN = process.env.PIPER_BIN_PATH || path.join(__dirname, "bin", "piper", "piper");
// Support layouts where bin/piper/piper is a directory containing the piper binary
try {
  if (fs.existsSync(PIPER_BIN) && fs.statSync(PIPER_BIN).isDirectory()) {
    const candidate = path.join(PIPER_BIN, "piper");
    if (fs.existsSync(candidate)) PIPER_BIN = candidate;
  }
} catch (e) { /* ignore */ }

const VOICE_MODEL =
  process.env.VOICE_MODEL_PATH || path.join(__dirname, "tts", "en_US-lessac-medium.onnx");

const TTS_OUT_DIR = path.join(__dirname, "tts_out");
const TTS_OUT_WAV = path.join(TTS_OUT_DIR, "last.wav");
const PING_WAV = path.join(TTS_OUT_DIR, "ping.wav");

// -------------------- Middleware --------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve index.html from project root + any assets in /public
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

if (!fs.existsSync(TTS_OUT_DIR)) fs.mkdirSync(TTS_OUT_DIR, { recursive: true });
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
if (!fs.existsSync(SCHEDULE_DIR)) fs.mkdirSync(SCHEDULE_DIR, { recursive: true });

// Create location-specific directories
const LOCATION_CODES = ['SLW', 'SLX', 'SSR', 'SSM', 'SST', 'SSS'];
LOCATION_CODES.forEach(code => {
  const schedDir = path.join(SCHEDULE_DIR, code);
  const expDir = path.join(EXPORT_DIR, code);
  if (!fs.existsSync(schedDir)) fs.mkdirSync(schedDir, { recursive: true });
  if (!fs.existsSync(expDir)) fs.mkdirSync(expDir, { recursive: true });
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
  addIfMissing("balance_amount", `ALTER TABLE roster ADD COLUMN balance_amount REAL DEFAULT NULL;`);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_key ON roster(date, start_time, swimmer_name);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_roster_date_time ON roster(date, start_time);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);`);
}
ensureSchema();

// -------------------- Lockout per IP --------------------
const ipAuthState = new Map();

function nowISO() { return new Date().toISOString(); }

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

function formatTime12h(t) {
  const [hh, mm] = t.split(":").map(Number);
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  if (mm === 0) return `${h12} ${ampm}`;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
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
        attendance, attendance_at,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        NULL, NULL,
        0,
        ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT(date, start_time, swimmer_name) DO UPDATE SET
        instructor_name=excluded.instructor_name,
        zone=excluded.zone,
        program=excluded.program,
        age_text=excluded.age_text,
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
      zone,
      program,
      age_text,
      attendance,
      is_addon,
      zone_overridden,
      flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
      balance_amount
    FROM roster
    WHERE date = ? AND start_time = ? AND location_id = ?
  `).all(date, start_time, location_id);

  res.json({ ok: true, kids });
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

app.post("/api/attendance/remove-history", (req, res) => {
  try {
    const { date, start_time, swimmer_name, location_id } = req.body || {};
    if (!date || !start_time || !swimmer_name || !location_id) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    const result = db.prepare(`
      DELETE FROM roster
      WHERE date = ? AND start_time = ? AND swimmer_name = ? AND location_id = ?
    `).run(date, start_time, swimmer_name, location_id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: "record not found" });
    }

    audit(req, "remove_attendance_history", { date, start_time, swimmer_name, location_id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "remove attendance history failed", details: String(e?.stack || e?.message || e) });
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
        attendance, attendance_at,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        location_id,
        created_at, updated_at,
        zone_overridden, zone_override_at, zone_override_by
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        NULL, NULL,
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
    const { start_time, swimmer_name, device_mode } = req.body || {};
    if (!start_time || !swimmer_name) return res.status(400).json({ ok: false, error: "missing fields" });

    const date = activeOrToday();
    const info = db.prepare(`
      SELECT is_addon FROM roster WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).get(date, start_time, swimmer_name);

    if (!info) return res.status(404).json({ ok: false, error: "not found" });
    if (!info.is_addon) return res.status(400).json({ ok: false, error: "not an add-on" });

    db.prepare(`
      DELETE FROM roster WHERE date = ? AND start_time = ? AND swimmer_name = ?
    `).run(date, start_time, swimmer_name);

    audit(req, "remove_addon", { device_mode, date, start_time, swimmer_name });

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
        attendance, attendance_at,
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
      "attendance","attendance_at",
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

// Export JSON of active roster (backup/restore)
app.get("/api/export-json", (req, res) => {
  try {
    const date = activeOrToday();
    const rows = db.prepare(`
      SELECT
        date, start_time, swimmer_name, instructor_name, zone, program, age_text,
        attendance, attendance_at,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        zone_overridden, zone_override_at, zone_override_by,
        created_at, updated_at
      FROM roster
      WHERE date = ?
      ORDER BY start_time ASC, instructor_name ASC, swimmer_name ASC
    `).all(date);

    const payload = { ok: true, date, rows };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="roster_${date}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: "export-json failed", details: String(e?.stack || e?.message || e) });
  }
});

app.post("/api/import-json", (req, res) => {
  try {
    const payload = req.body || {};
    const date = (payload.date && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) ? String(payload.date) : activeOrToday();
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) return res.status(400).json({ ok: false, error: "No rows provided" });

    setActiveDate(date);

    db.prepare(`DELETE FROM roster WHERE date = ? AND is_addon = 0`).run(date);

    const now = nowISO();
    const ins = db.prepare(`
      INSERT INTO roster (
        date, start_time, swimmer_name,
        instructor_name, zone, program, age_text,
        attendance, attendance_at,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        created_at, updated_at,
        zone_overridden, zone_override_at, zone_override_by
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(date, start_time, swimmer_name) DO UPDATE SET
        instructor_name=excluded.instructor_name,
        zone=excluded.zone,
        program=excluded.program,
        age_text=excluded.age_text,
        attendance=excluded.attendance,
        attendance_at=excluded.attendance_at,
        is_addon=excluded.is_addon,
        flag_new=excluded.flag_new,
        flag_makeup=excluded.flag_makeup,
        flag_policy=excluded.flag_policy,
        flag_owes=excluded.flag_owes,
        flag_trial=excluded.flag_trial,
        zone_overridden=excluded.zone_overridden,
        zone_override_at=excluded.zone_override_at,
        zone_override_by=excluded.zone_override_by,
        updated_at=excluded.updated_at
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
          (r.zone === 0 || r.zone) ? r.zone : null,
          r.program || null,
          r.age_text || null,
          (r.attendance === 0 || r.attendance === 1) ? r.attendance : null,
          r.attendance_at || null,
          r.is_addon ? 1 : 0,
          r.flag_new ? 1 : 0,
          r.flag_makeup ? 1 : 0,
          r.flag_policy ? 1 : 0,
          r.flag_owes ? 1 : 0,
          r.flag_trial ? 1 : 0,
          r.created_at || now,
          now,
          r.zone_overridden ? 1 : 0,
          r.zone_override_at || null,
          r.zone_override_by || null
        );
      }
    });
    tx(rows);

    audit(req, "import_json", { date, count: rows.length });
    res.json({ ok: true, date, count: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: "import-json failed", details: String(e?.stack || e?.message || e) });
  }
});


// ==================== HTML UPLOAD SUPPORT ====================
function parseHTMLRoster(html) {
  const $ = cheerio.load(html);
  const swimmers = [];
  
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

    // Get all instructor list items
    const instructorItems = $section.find('th:contains("Instructors:")').next().find('li');

    if (instructorItems.length > 0) {
      instructorItems.each((idx, item) => {
        const text = $(item).text().trim();
        if (!text) return;

        // Check if this instructor has an asterisk (indicates substitute)
        if (text.includes('*')) {
          // This is the substitute - remove asterisk and convert name
          const cleanName = text.replace(/\*/g, '').trim();
          substituteInstructor = lastFirstToFirstLast(cleanName);
        } else if (idx === 0) {
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
    
    $section.find('table.table-roll-sheet tbody tr').each((_, row) => {
      const $row = $(row);
      
      const nameEl = $row.find('.student-name strong');
      if (nameEl.length === 0) return;
      
      const swimmerName = lastFirstToFirstLast(nameEl.text().trim());
      const ageText = $row.find('.student-info').text().trim();
      
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

      // Check for pre-marked absence (X-modifier.png icon in attendance cell)
      let attendance = null;
      const attendanceCell = $row.find('td.date-time, td.cell-bordered');
      const xModifier = attendanceCell.find('img[src*="X-modifier"]');
      if (xModifier.length > 0) {
        attendance = 0; // 0 = absent
      }

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

      swimmers.push({
        start_time: startTime,
        swimmer_name: swimmerName,
        age_text: ageText,
        instructor_name: instructorName,
        substitute_instructor: substituteInstructor,
        program: programText,
        zone: zone,
        attendance: attendance,
        balance_amount: balanceAmount,
        ...flags
      });
    });
  });
  
  console.log(`HTML Parser: Found ${swimmers.length} swimmers`);
  return swimmers;
}

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

    const locId = parseInt(req.body.location_id || req.file?.fieldname === 'html' && req.body.location_id || 1);
    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locId);

    if (!location) {
      return res.status(400).json({ ok: false, error: "Invalid location" });
    }

    const detectedDate =
      parseDateFromFilename(filename) ||
      parseDateFromHTML(html) ||
      todayISO();

    setActiveDate(detectedDate);

    // Save to location-specific folder with descriptive filename
    // Format: roll_sheet_{LOCATION_CODE}_{DATE}.html
    // Example: roll_sheet_SLW_2026-01-24.html (SwimLabs Westchester)
    //          roll_sheet_SSM_2026-01-24.html (SafeSplash Santa Monica)
    const locationDir = path.join(SCHEDULE_DIR, location.code);
    if (!fs.existsSync(locationDir)) fs.mkdirSync(locationDir, { recursive: true });
    const htmlFilename = `roll_sheet_${location.code}_${detectedDate}.html`;
    const htmlPath = path.join(locationDir, htmlFilename);
    fs.writeFileSync(htmlPath, html, "utf-8");

    const swimmers = parseHTMLRoster(html);
    if (swimmers.length === 0) {
      return res.status(400).json({ ok: false, error: "No swimmers found in HTML file" });
    }

    // Auto-export existing roster before clearing (if any exists)
    // Exports are stored on SERVER in subdirectories: exports/{LOCATION_CODE}/
    // Example: exports/SLW/ for SwimLabs Westchester
    //          exports/SSM/ for SafeSplash Santa Monica
    const existingRoster = db.prepare(`
      SELECT * FROM roster
      WHERE date = ? AND location_id = ? AND is_addon = 0
    `).all(detectedDate, locId);

    if (existingRoster.length > 0) {
      // Create export directory for this location on server
      const exportDir = path.join(EXPORT_DIR, location.code);
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      // Generate timestamp for filename
      // Format: roster_{LOCATION_CODE}_{DATE}_{TIMESTAMP}.json
      // Example: roster_SLW_2026-01-24_2026-01-24T15-30-45-123Z.json
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFilename = `roster_${location.code}_${detectedDate}_${timestamp}.json`;
      const exportPath = path.join(exportDir, exportFilename);

      // Save existing roster to JSON on server
      fs.writeFileSync(exportPath, JSON.stringify({
        location: location.name,
        location_code: location.code,
        date: detectedDate,
        exported_at: nowISO(),
        count: existingRoster.length,
        roster: existingRoster
      }, null, 2), 'utf-8');

      console.log(`[AUTO-EXPORT] Saved ${existingRoster.length} swimmers to server: ${location.code}/${exportFilename}`);
    }

    // Delete existing roster for this location/date
    db.prepare(`DELETE FROM roster WHERE date = ? AND location_id = ? AND is_addon = 0`).run(detectedDate, locId);

    const now = nowISO();
    const ins = db.prepare(`
      INSERT INTO roster (
        date, start_time, swimmer_name,
        instructor_name, substitute_instructor, zone, program, age_text,
        attendance, attendance_at,
        is_addon,
        flag_new, flag_makeup, flag_policy, flag_owes, flag_trial,
        balance_amount,
        location_id,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const tx = db.transaction((rows) => {
      for (const r of rows) {
        ins.run(
          detectedDate, r.start_time, r.swimmer_name,
          r.instructor_name || null, r.substitute_instructor || null, r.zone || null, r.program || null, r.age_text || null,
          r.attendance !== undefined ? r.attendance : null,
          r.flag_new || 0, r.flag_makeup || 0, r.flag_policy || 0, r.flag_owes || 0, r.flag_trial || 0,
          r.balance_amount !== undefined ? r.balance_amount : null,
          locId,
          now, now
        );
      }
    });

    tx(swimmers);

    audit(req, "html_upload", { 
      location: location.name,
      date: detectedDate,
      count: swimmers.length 
    });

    res.json({ ok: true, count: swimmers.length, date: detectedDate, location: location.name });
  } catch (error) {
    console.error("HTML upload error:", error);
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

// ==================== INSTRUCTOR MANAGEMENT ====================
app.get("/api/instructors", (req, res) => {
  try {
    const configPath = path.join(__dirname, "config", "instructors.json");

    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ ok: false, error: 'instructors.json not found' });
    }

    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { instructors, locationMapping } = configData;

    // Get current location from session/request (from location_id in query or default)
    const location_id = req.query.location_id || req.session?.location_id || 1;
    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(location_id);

    if (!location) {
      return res.json({ ok: true, instructors: [] });
    }

    const normalizeKey = (value) => String(value || "").trim().toLowerCase();
    const normalizedMapping = new Map(
      Object.entries(locationMapping || {}).map(([key, value]) => [normalizeKey(key), value])
    );
    const regionCandidates = [
      location.name,
      location.code,
      location.short_code,
      location.shortCode
    ].map(normalizeKey);
    const mappedRegion = regionCandidates
      .map((key) => normalizedMapping.get(key))
      .find(Boolean);

    // Map location name/code/short code to region
    const region = mappedRegion || location.name;

    // Filter instructors by region and format as "First L."
    const filtered = instructors
      .filter(i => i.location === region)
      .map(i => ({
        displayName: `${i.firstName} ${i.lastName.charAt(0)}.`,
        fullName: `${i.firstName} ${i.lastName}`,
        firstName: i.firstName,
        lastName: i.lastName
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.json({ ok: true, instructors: filtered, location: location.name, region });
  } catch (error) {
    console.error("Instructor fetch error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get all staff for admin panel (includes phone and birthday)
app.get("/api/staff", (req, res) => {
  try {
    const configPath = path.join(__dirname, "config", "instructors.json");

    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ ok: false, error: 'instructors.json not found' });
    }

    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { instructors } = configData;

    // Return all staff with phone and birthday
    const staff = instructors.map(i => ({
      id: `${i.firstName}_${i.lastName}`,
      firstName: i.firstName,
      lastName: i.lastName,
      location: i.location,
      phone: i.phone || '',
      birthday: i.birthday || ''
    })).sort((a, b) => a.lastName.localeCompare(b.lastName));

    res.json({ ok: true, staff });
  } catch (error) {
    console.error("Staff fetch error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ==================== STAFF AND LOCATION MANAGEMENT ====================

// Staff management endpoints
app.post("/api/admin/remove-staff", (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Staff ID required' });
    }

    const configPath = path.join(__dirname, "config", "instructors.json");
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ ok: false, error: 'instructors.json not found' });
    }

    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Find and remove staff by ID (firstName_lastName format)
    const [firstName, lastName] = id.split('_');
    const originalCount = configData.instructors.length;
    configData.instructors = configData.instructors.filter(i =>
      !(i.firstName === firstName && i.lastName === lastName)
    );

    if (configData.instructors.length === originalCount) {
      return res.status(404).json({ ok: false, error: 'Staff member not found' });
    }

    // Update timestamp
    configData.last_updated = new Date().toISOString();

    // Write back to file
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
    audit(req, "remove_staff", { id, firstName, lastName });

    res.json({ ok: true, message: 'Staff member removed successfully' });
  } catch (error) {
    console.error("Remove staff error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/add-staff", (req, res) => {
  try {
    const { firstName, lastName, location, phone, birthday } = req.body;

    if (!firstName || !lastName || !location) {
      return res.status(400).json({ ok: false, error: 'First name, last name, and location are required' });
    }

    const configPath = path.join(__dirname, "config", "instructors.json");
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ ok: false, error: 'instructors.json not found' });
    }

    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Check if staff already exists
    const exists = configData.instructors.some(i =>
      i.firstName === firstName && i.lastName === lastName
    );

    if (exists) {
      return res.status(400).json({ ok: false, error: 'Staff member already exists' });
    }

    // Add new staff
    configData.instructors.push({
      firstName,
      lastName,
      location,
      phone: phone || '',
      birthday: birthday || ''
    });

    // Sort by last name
    configData.instructors.sort((a, b) => a.lastName.localeCompare(b.lastName));

    // Update timestamp
    configData.last_updated = new Date().toISOString();

    // Write back to file
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
    audit(req, "add_staff", { firstName, lastName, location });

    res.json({ ok: true, message: 'Staff member added successfully' });
  } catch (error) {
    console.error("Add staff error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Location management endpoints
app.post("/api/admin/remove-location", (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Location ID required' });
    }

    // Set location as inactive instead of deleting
    const result = db.prepare(`UPDATE locations SET active = 0 WHERE id = ?`).run(id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Location not found' });
    }

    audit(req, "remove_location", { location_id: id });
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
    const { pin } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;

    // Load settings
    const settingsPath = path.join(__dirname, "config", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return res.status(500).json({ ok: false, error: 'settings.json not found' });
    }

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const correctPin = settings.admin_pin || "8118";

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
    if (pin === correctPin) {
      // Success - clear attempts and lockout
      pinAttempts.delete(clientIp);
      pinLockouts.delete(clientIp);

      audit(req, "admin_pin_success", { ip: clientIp });

      return res.json({
        ok: true,
        authenticated: true,
        expires_at: Date.now() + (2 * 60 * 60 * 1000) // 2 hours from now
      });
    }

    // Failed attempt
    const attempts = (pinAttempts.get(clientIp) || 0) + 1;
    pinAttempts.set(clientIp, attempts);

    audit(req, "admin_pin_failed", { ip: clientIp, attempts });

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

// ==================== ADMIN CLEAR ROSTER ====================
app.post("/api/clear-roster", (req, res) => {
  try {
    const { location_id } = req.body || {};
    const locId = location_id || 1;
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
      backup_file: backupFile
    });

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
    const schedDir = path.join(SCHEDULE_DIR, code);
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

app.listen(PORT, () => {
  console.log(`SwimLabs Announcer server running on http://localhost:${PORT}`);
});
