-- SwimLabs Announcer: Add Substitute & Absence Tracking
-- Run this on your server: sqlite3 data/app.db < add-substitute-tracking.sql

-- Add columns for substitute tracking
ALTER TABLE roster ADD COLUMN is_substitute INTEGER DEFAULT 0;
ALTER TABLE roster ADD COLUMN original_instructor TEXT;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_roster_substitute ON roster(is_substitute);

-- Verify the changes
.schema roster
