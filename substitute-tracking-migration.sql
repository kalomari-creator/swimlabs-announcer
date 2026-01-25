-- Database Migration: Add Substitute Tracking
-- Run this in your SQLite database

-- Add new columns to roster table for substitute tracking
ALTER TABLE roster ADD COLUMN is_substitute INTEGER DEFAULT 0;
ALTER TABLE roster ADD COLUMN original_instructor TEXT;

-- Create index for substitute queries
CREATE INDEX IF NOT EXISTS idx_roster_substitute 
  ON roster(is_substitute, original_instructor);

-- Update attendance_history to track when absences were pre-marked
ALTER TABLE attendance_history ADD COLUMN pre_marked INTEGER DEFAULT 0;

-- VERIFICATION QUERIES:
-- Check if columns exist:
PRAGMA table_info(roster);

-- Test substitute detection:
SELECT start_time, swimmer_name, instructor_name, is_substitute, original_instructor
FROM roster 
WHERE is_substitute = 1
LIMIT 10;

-- Test pre-marked absences:
SELECT start_time, swimmer_name, attendance
FROM roster
WHERE attendance = 0
LIMIT 10;
