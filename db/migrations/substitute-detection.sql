-- SwimLabs Announcer: Substitute Detection Migration
-- Run this: sqlite3 data/app.db < substitute-detection.sql

-- Add columns for tracking substitute instructors
ALTER TABLE roster ADD COLUMN is_substitute INTEGER DEFAULT 0;
ALTER TABLE roster ADD COLUMN original_instructor TEXT;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_roster_substitute ON roster(is_substitute);

-- Verify the changes
.schema roster

-- Test query to see substitutes (after uploading roll sheet)
-- SELECT start_time, swimmer_name, instructor_name, is_substitute, original_instructor 
-- FROM roster WHERE is_substitute = 1 LIMIT 10;
