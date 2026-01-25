-- SwimLabs Announcer v5.0 ULTIMATE - Complete Database Migration
-- Run this to upgrade from v4.0 to v5.0

-- ==================== NEW TABLES ====================

-- Swimmer Notes System
CREATE TABLE IF NOT EXISTS swimmer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  swimmer_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE INDEX IF NOT EXISTS idx_swimmer_notes_lookup 
  ON swimmer_notes(location_id, swimmer_name, date);

-- Attendance History (auto-populated when attendance marked)
CREATE TABLE IF NOT EXISTS attendance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  swimmer_name TEXT NOT NULL,
  attendance TEXT NOT NULL, -- 'present', 'absent', 'late'
  marked_at TEXT NOT NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_history_swimmer 
  ON attendance_history(swimmer_name, date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_history_location 
  ON attendance_history(location_id, date DESC);

-- Multi-Week Absence Tracking
CREATE TABLE IF NOT EXISTS absence_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  swimmer_name TEXT NOT NULL,
  program TEXT,
  weeks_absent INTEGER DEFAULT 0,
  last_attended TEXT,
  has_makeup_booked INTEGER DEFAULT 0,
  makeup_attended INTEGER DEFAULT 0,
  
  -- Contact tracking
  contact_status TEXT DEFAULT 'not_contacted',
  contacted_at TEXT,
  contacted_by TEXT,
  outcome TEXT, -- 'enrolled', 'not_interested', 'follow_up'
  follow_up_date TEXT,
  notes TEXT,
  
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  FOREIGN KEY (location_id) REFERENCES locations(id),
  UNIQUE(location_id, swimmer_name)
);

CREATE INDEX IF NOT EXISTS idx_absence_tracking_weeks 
  ON absence_tracking(weeks_absent DESC, contact_status);

-- Trial Follow-Up System
CREATE TABLE IF NOT EXISTS trial_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  trial_date TEXT NOT NULL,
  week_start TEXT NOT NULL, -- Monday of calendar week
  swimmer_name TEXT NOT NULL,
  age_text TEXT,
  program TEXT,
  instructor_name TEXT,
  
  -- Attendance
  attendance TEXT DEFAULT 'pending', -- 'attended', 'no_show', 'pending'
  marked_at TEXT,
  
  -- Contact workflow
  contact_status TEXT DEFAULT 'not_contacted',
  contacted_at TEXT,
  contacted_by TEXT,
  
  -- Outcome
  outcome TEXT, -- 'enrolled', 'not_interested', 'follow_up'
  follow_up_date TEXT,
  follow_up_notes TEXT,
  
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  FOREIGN KEY (location_id) REFERENCES locations(id),
  UNIQUE(location_id, trial_date, swimmer_name)
);

CREATE INDEX IF NOT EXISTS idx_trial_tracking_week 
  ON trial_tracking(week_start DESC, location_id);
CREATE INDEX IF NOT EXISTS idx_trial_tracking_followup 
  ON trial_tracking(follow_up_date) WHERE outcome = 'follow_up';

-- Instructor Observations (Evaluations)
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  instructor_name TEXT NOT NULL,
  
  -- Safe Start (2 yes/no)
  safe_start_permission INTEGER DEFAULT 0,
  safe_start_rules INTEGER DEFAULT 0,
  
  -- Swimmer Interaction (3 yes/no)
  interaction_names INTEGER DEFAULT 0,
  interaction_expressions INTEGER DEFAULT 0,
  interaction_joy INTEGER DEFAULT 0,
  
  -- Time Management (4 yes/no)
  time_on_time INTEGER DEFAULT 0,
  time_equal INTEGER DEFAULT 0,
  time_transitions INTEGER DEFAULT 0,
  time_utilized INTEGER DEFAULT 0,
  
  -- Skill Tracking (4 yes/no)
  tracking_reviewed INTEGER DEFAULT 0,
  tracking_match INTEGER DEFAULT 0,
  tracking_updated INTEGER DEFAULT 0,
  tracking_notes INTEGER DEFAULT 0,
  
  -- Class Safety (6 checkboxes)
  safety_1 INTEGER DEFAULT 0,
  safety_2 INTEGER DEFAULT 0,
  safety_3 INTEGER DEFAULT 0,
  safety_4 INTEGER DEFAULT 0,
  safety_5 INTEGER DEFAULT 0,
  safety_6 INTEGER DEFAULT 0,
  
  -- Signatures
  manager_signature TEXT,
  manager_date TEXT,
  instructor_signature TEXT,
  instructor_date TEXT,
  
  created_at TEXT NOT NULL,
  pdf_path TEXT,
  
  FOREIGN KEY (location_id) REFERENCES locations(id)
);

CREATE INDEX IF NOT EXISTS idx_observations_lookup 
  ON observations(location_id, date DESC);

-- Observation Skill Sections (Warm Up, Skill 1, 2, Ending)
CREATE TABLE IF NOT EXISTS observation_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL,
  skill_section TEXT NOT NULL, -- 'warmup', 'skill1', 'skill2', 'ending'
  demonstration_quality INTEGER DEFAULT 0,
  notes TEXT,
  FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

-- Swimmer Performance in Observations (7 columns per swimmer per skill)
CREATE TABLE IF NOT EXISTS observation_swimmers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_skill_id INTEGER NOT NULL,
  swimmer_name TEXT NOT NULL,
  skill TEXT,
  num_turns INTEGER,
  correct_step INTEGER DEFAULT 0,
  cue_words TEXT,
  tactile_manipulation INTEGER DEFAULT 0,
  appropriate_feedback INTEGER DEFAULT 0,
  FOREIGN KEY (observation_skill_id) REFERENCES observation_skills(id) ON DELETE CASCADE
);

-- Admin Action Log
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  user_identifier TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_log_created 
  ON admin_log(created_at DESC);

-- ==================== COLUMN ADDITIONS ====================

-- Add program_color to roster for color-coding
-- (SQLite doesn't have IF NOT EXISTS for ALTER, so wrapped in a check via application)

-- Note: These ALTER statements should be run conditionally by the application:
-- ALTER TABLE roster ADD COLUMN program_color TEXT;

-- Migration complete!
-- Next: Initialize config files and directories
