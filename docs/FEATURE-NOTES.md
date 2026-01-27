# Feature Notes (v5.0)

## Report backfill behavior
- System/Admin **Report Uploads** supports historical uploads by explicit **As-Of Date**.
- Each upload is stored as a separate row (no overwrites) keyed by location, report type, and effective date.
- Duplicate uploads (same location/type/date + identical hash) are rejected with a warning.

## MASTER location gating
- Selecting **MASTER** requires a manager PIN.
- MASTER is always view-only: uploads, edits, exports, and deletes are blocked in the UI.
- MASTER aggregates data across all active locations and supports a location filter.

## Announcement confirmation logging
- Roster “📣” announcements now prompt for **Confirm announcement**.
- Confirmations are stored in `announcement_confirmations` and logged in the activity log for auditability.
