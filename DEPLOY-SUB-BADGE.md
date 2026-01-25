# 🚀 Deploy Absence & Substitute Detection

## ⚡ Quick Deploy (5 Steps)

### **Step 1: Update Database**

```bash
cd ~/Desktop/announcer

# Add new columns
sqlite3 data/app.db < add-substitute-tracking.sql

# Verify
sqlite3 data/app.db "PRAGMA table_info(roster);" | grep substitute
```

Should show: `is_substitute` and `original_instructor` columns.

---

### **Step 2: Update server.js**

```bash
nano server.js
```

**Find the `parseIclassProHTML` function** (around line 1400-1600):
- Press `Ctrl+W`, search for: `function parseIclassProHTML`

**Replace the ENTIRE function** with the code from:
- `enhanced-parseIclassProHTML.js`

**Save:** `Ctrl+O`, `Enter`, `Ctrl+X`

---

### **Step 3: Update index.html - Add CSS**

```bash
nano index.html
```

**Find this section** (around line 300):
- Press `Ctrl+W`, search for: `.badge.addon`

**After `.badge.addon` and `.badge.over`, add:**
- Copy code from `sub-badge-css.css`

---

### **Step 4: Update index.html - Add Rendering**

**Still in index.html**, find the instructor rendering:
- Press `Ctrl+W`, search for: `instructor_name`
- Look for these lines:
  ```javascript
  const tdInst = document.createElement('td');
  tdInst.textContent = kid.instructor_name || '—';
  tr.appendChild(tdInst);
  ```

**Replace those 3 lines** with the code from:
- `sub-badge-rendering.js`

**Save:** `Ctrl+O`, `Enter`, `Ctrl+X`

---

### **Step 5: Restart & Test**

```bash
# Restart server
node server.js
```

**In browser:**
1. Upload your `Roll_Sheets__Roster_Test_.html`
2. Go to Roster tab
3. Look for Khaled Alomari - should show orange **[SUB]** badge
4. Hover badge - should say "Subbing for Robert Macfarlane"

---

## ✅ What You'll See

### **Before:**
```
Instructor
-----------
Khaled Alomari
```

### **After:**
```
Instructor
-----------
Khaled Alomari [SUB]
                ^^^^
         (hover: "Subbing for Robert Macfarlane")
```

---

## 🎨 Visual Result

```
┌─────────────────────────────────────┐
│ Swimmer       | Instructor          │
├─────────────────────────────────────┤
│ John Doe      | Khaled Alomari [SUB]│
│ Jane Smith    | Khaled Alomari [SUB]│
│               |         ^             │
│               |    Orange badge       │
│               | Hover shows original  │
└─────────────────────────────────────┘
```

---

## 📋 Files You Need

1. **add-substitute-tracking.sql** - Database update
2. **enhanced-parseIclassProHTML.js** - Parser function (for server.js)
3. **sub-badge-css.css** - CSS styles (for index.html)
4. **sub-badge-rendering.js** - Rendering code (for index.html)
5. **DEPLOY-SUB-BADGE.md** - This file

---

## 🐛 Troubleshooting

### **Badge Not Showing:**

Check database:
```bash
sqlite3 data/app.db "SELECT swimmer_name, instructor_name, is_substitute, original_instructor FROM roster WHERE is_substitute = 1 LIMIT 5;"
```

Should show rows with `is_substitute = 1`.

### **Parser Not Detecting:**

Check roll sheet has asterisk:
```bash
grep "Alomari" Roll_Sheets__Roster_Test_.html
```

Should show: `Alomari, Khaled*`

### **CSS Not Applied:**

Clear browser cache: `Ctrl+Shift+R`

---

## 📤 Commit to GitHub

```bash
git add server.js index.html add-substitute-tracking.sql
git commit -m "Feature: Detect and display substitute instructors with SUB badge"
git push origin main
```

---

## ✅ Success Checklist

- [ ] Database has new columns
- [ ] server.js parseIclassProHTML function updated
- [ ] index.html has SUB badge CSS
- [ ] index.html has SUB badge rendering code
- [ ] Server restarted
- [ ] Roll sheet uploaded
- [ ] SUB badge visible in Roster tab
- [ ] Hover shows original instructor

---

**All files ready to deploy!** 🎉
