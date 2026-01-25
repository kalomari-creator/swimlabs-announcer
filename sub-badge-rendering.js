// SwimLabs Announcer: Instructor SUB Badge Rendering
// Replace the instructor column rendering in your loadRoster() function
// Find: const tdInst = document.createElement('td');
//       tdInst.textContent = kid.instructor_name || '—';
//       tr.appendChild(tdInst);
// Replace with this code:

// Instructor column with SUB badge
const tdInst = document.createElement('td');

if (kid.is_substitute && kid.original_instructor) {
  // This is a substitute instructor - show SUB badge
  const instDiv = document.createElement('div');
  instDiv.style.display = 'flex';
  instDiv.style.alignItems = 'center';
  instDiv.style.gap = '8px';
  instDiv.style.flexWrap = 'wrap';
  
  // Instructor name
  const instName = document.createElement('span');
  instName.textContent = kid.instructor_name;
  instName.style.fontWeight = '900';
  
  // SUB badge
  const subBadge = document.createElement('span');
  subBadge.className = 'badge sub';
  subBadge.textContent = 'SUB';
  subBadge.title = `Subbing for ${kid.original_instructor}`;
  
  instDiv.appendChild(instName);
  instDiv.appendChild(subBadge);
  tdInst.appendChild(instDiv);
} else {
  // Regular instructor - no badge
  tdInst.textContent = kid.instructor_name || '—';
}

tr.appendChild(tdInst);
