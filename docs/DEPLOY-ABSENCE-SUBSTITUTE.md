# SwimLabs Announcer: Absence & Substitute Detection

## 🎯 What This Adds

### 1. **Auto-Detect Absences**
- Detects `cancel.png` icon in iClassPro roll sheets
- Automatically marks swimmers as absent (attendance = 0)
- Shows "⚠️ Pre-marked absent" indicator in UI

### 2. **Detect Substitute Instructors**
- Detects asterisk (*) after instructor name
- Shows orange "SUB" badge next to substitute's name
- Hover shows original instructor (e.g., "Subbing for Robert M.")
- Tracks both substitute and original instructor in database

---

## 📦 Files Included

1. **enhanced-html-parser.js** - New HTML parser with detection logic
2. **substitute-tracking-migration.sql** - Database schema updates
3. **ui-substitute-enhancements.js** - UI code for displaying subs
4. **DEPLOY-ABSENCE-SUBSTITUTE.md** - This file

---

## 🚀 Deployment Steps

### **Step 1: Backup Database**

```bash
cd ~/Desktop/announcer
cp data/app.db data/app-backup-before-sub-tracking.db
```

---

### **Step 2: Update Database Schema**

```bash
sqlite3 data/app.db < substitute-tracking-migration.sql
```

**Verify:**
```bash
sqlite3 data/app.db "PRAGMA table_info(roster);"
# Should show new columns: is_substitute, original_instructor
```

---

### **Step 3: Update server.js**

Open `server.js` and find the `parseIclassProHTML` function (around line 1400-1600).

**Replace the entire function** with the code from `enhanced-html-parser.js`.

Key sections to replace:
- The main parsing loop
- Instructor extraction
- Absence detection via cancel.png
- Substitute detection via asterisk

**Test:**
```bash
node -c server.js
# Should show no errors
```

---

### **Step 4: Update index.html**

#### **A. Add CSS for SUB Badge**

Find your `<style>` section and add:

```css
.badge.sub {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.5px;
  border: 1px solid rgba(249,115,22,0.45);
  background: rgba(249,115,22,0.15);
  color: rgb(249,115,22);
}

.badge.sub:hover {
  background: rgba(249,115,22,0.25);
  transform: scale(1.05);
  transition: all 0.15s ease;
}
```

#### **B. Update Instructor Column Rendering**

In the `loadRoster()` function, find where instructor is rendered (look for "instructor_name").

Replace:
```javascript
const tdInst = document.createElement('td');
tdInst.textContent = kid.instructor_name || '—';
tr.appendChild(tdInst);
```

With the enhanced code from `ui-substitute-enhancements.js` (lines 10-35).

#### **C. Add Pre-Marked Absence Indicator**

In the `renderAttendance()` function, add the pre-mark indicator from `ui-substitute-enhancements.js` (lines 67-78).

---

### **Step 5: Restart Server**

```bash
cd ~/Desktop/announcer
node server.js
```

---

### **Step 6: Test Upload**

1. **Upload a roll sheet with:**
   - ✅ Pre-marked absence (cancel.png icon)
   - ✅ Substitute instructor (name with asterisk)

2. **Verify in Roster tab:**
   - ✅ Absent swimmers show "⚠️ Pre-marked absent"
   - ✅ Substitute instructors show orange "SUB" badge
   - ✅ Hovering SUB badge shows original instructor

3. **Verify in Database:**
```bash
sqlite3 data/app.db "SELECT swimmer_name, instructor_name, is_substitute, original_instructor, attendance FROM roster WHERE is_substitute = 1 OR attendance = 0 LIMIT 10;"
```

---

### **Step 7: Commit to GitHub**

```bash
git add server.js index.html substitute-tracking-migration.sql
git commit -m "Feature: Auto-detect absences and substitute instructors"
git push origin main
```

---

## 🔍 How It Works

### **Absence Detection:**

1. HTML parser finds `<img src="...cancel.png">` in date-time cell
2. Sets `attendance = 0` for that swimmer
3. UI shows warning indicator
4. Absence tracked in attendance_history

### **Substitute Detection:**

1. HTML parser finds instructor list under "Instructors:"
2. Detects asterisk (*) after name: `"Alomari, Khaled*"`
3. Sets:
   - `instructor_name = "Khaled Alomari"` (the sub)
   - `is_substitute = 1`
   - `original_instructor = "Robert Macfarlane"` (from header)
4. UI shows "SUB" badge with tooltip

---

## 📊 Example Data

### **Roll Sheet Header:**
```
GROUP: Beginner 3 on Sun: 8:30 - 9:00 with Robert M.

Instructors:
* Alomari, Khaled*
* Macfarlane, Robert
```

### **Parsed Result:**
```javascript
{
  swimmer_name: "John Doe",
  instructor_name: "Khaled Alomari",
  is_substitute: 1,
  original_instructor: "Robert Macfarlane",
  attendance: null
}
```

### **UI Display:**
```
Instructor: Khaled Alomari [SUB]
            ^^^^^^^^^^^^^    ^^^^
            (substitute)   (hover: "Subbing for Robert Macfarlane")
```

---

## 🎨 Visual Examples

### **Pre-Marked Absence:**
```
┌─────────────────────────────────────┐
│ ⚠️ Pre-marked absent                │
│ ┌──────┬────────┬───────┐          │
│ │ Here │ Absent │ Clear │          │
│ └──────┴────────┴───────┘          │
│      (Absent is already active)     │
└─────────────────────────────────────┘
```

### **Substitute Indicator:**
```
┌──────────────────────────┐
│ Instructor               │
├──────────────────────────┤
│ Khaled Alomari  [SUB]    │
│                  ^^^^^    │
│       Orange badge with   │
│   "Subbing for Robert M." │
└──────────────────────────┘
```

---

## 🐛 Troubleshooting

### **Absences Not Detecting:**

Check HTML source:
```bash
grep "cancel.png" Roll_Sheets.html
```

Should find icon references.

### **Substitutes Not Detecting:**

Check instructor format:
```bash
grep -A 3 "Instructors:" Roll_Sheets.html
```

Should show asterisk after sub's name.

### **Database Errors:**

```bash
sqlite3 data/app.db "PRAGMA integrity_check;"
sqlite3 data/app.db "SELECT * FROM roster LIMIT 1;"
```

---

## ✅ Success Criteria

After deployment:

- [ ] Roll sheets with cancel.png auto-mark absences
- [ ] Substitute instructors show SUB badge
- [ ] Hovering SUB badge shows original instructor
- [ ] Database tracks is_substitute and original_instructor
- [ ] Pre-marked absences show warning indicator
- [ ] All existing functionality still works

---

## 🚀 Next Steps

With this foundation, you can now:

1. **Track substitute frequency** - Report on which instructors sub most
2. **Absence patterns** - Use pre-marked data for retention tracking
3. **Auto-notifications** - Alert when subs are scheduled
4. **Historical analysis** - Analyze impact of subs on attendance

---

## 📝 Notes

- Substitute detection is **class-level**, not swimmer-level
- All swimmers in a class with a sub get `is_substitute = 1`
- Pre-marked absences are auto-applied on upload
- Staff can still manually change attendance after upload

---

**Questions? Check the code comments in the provided files!**
