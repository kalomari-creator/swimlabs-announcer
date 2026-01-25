// UI Enhancement: Display Substitute Instructors
// Add this to index.html JavaScript section

// === MODIFY THE ROSTER RENDERING ===
// In your loadRoster() function, where you render the instructor column:

// BEFORE (old code):
/*
const tdInst = document.createElement('td');
tdInst.textContent = kid.instructor_name || '—';
tr.appendChild(tdInst);
*/

// AFTER (new code with sub indicator):
const tdInst = document.createElement('td');
if (kid.is_substitute && kid.original_instructor) {
  // Show substitute with badge
  const instDiv = document.createElement('div');
  instDiv.style.display = 'flex';
  instDiv.style.alignItems = 'center';
  instDiv.style.gap = '8px';
  instDiv.style.flexWrap = 'wrap';
  
  const instName = document.createElement('span');
  instName.textContent = kid.instructor_name;
  instName.style.fontWeight = '900';
  
  const subBadge = document.createElement('span');
  subBadge.className = 'badge sub';
  subBadge.textContent = 'SUB';
  subBadge.title = `Subbing for ${kid.original_instructor}`;
  subBadge.style.backgroundColor = 'rgba(249,115,22,0.15)';
  subBadge.style.borderColor = 'rgba(249,115,22,0.45)';
  subBadge.style.color = 'rgb(249,115,22)';
  subBadge.style.cursor = 'help';
  
  instDiv.appendChild(instName);
  instDiv.appendChild(subBadge);
  tdInst.appendChild(instDiv);
} else {
  tdInst.textContent = kid.instructor_name || '—';
}
tr.appendChild(tdInst);


// === ADD CSS FOR SUB BADGE ===
// Add to your <style> section:

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


// === AUTO-MARK PRE-MARKED ABSENCES ===
// In your loadRoster() function, after creating rows, auto-set attendance:

for (const kid of kids) {
  // If attendance was pre-marked as absent (0), mark it in the database
  if (kid.attendance === 0 && !kid.attendance_marked) {
    // Call API to mark as absent
    fetch('/api/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_time: kid.start_time,
        swimmer_name: kid.swimmer_name,
        attendance: 0,
        device_mode: deviceMode,
        auto_marked: true // Flag to indicate this was auto-detected
      })
    }).catch(err => console.log('Auto-mark absence failed:', err));
  }
}


// === VISUAL INDICATOR FOR PRE-MARKED ABSENCES ===
// In your renderAttendance() function, highlight pre-marked absences:

function renderAttendance(kid) {
  const w = document.createElement('div');
  w.className = 'attWrap';
  
  // If pre-marked absent, add visual indicator
  if (kid.attendance === 0) {
    const preMark = document.createElement('div');
    preMark.style.fontSize = '12px';
    preMark.style.color = 'rgba(239,68,68,0.8)';
    preMark.style.marginBottom = '4px';
    preMark.textContent = '⚠️ Pre-marked absent';
    w.appendChild(preMark);
  }
  
  // ... rest of attendance button rendering ...
}


// === USAGE NOTES ===
/*
1. Substitute instructors show with orange "SUB" badge
2. Hover over SUB badge to see original instructor name
3. Pre-marked absences show warning indicator
4. System auto-marks absences when upload detects cancel.png
5. Color coding:
   - SUB badge: Orange (rgba(249,115,22,...))
   - Pre-marked absence: Red warning
*/
