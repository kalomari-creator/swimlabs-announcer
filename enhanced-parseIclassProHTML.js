// SwimLabs Announcer: Enhanced HTML Parser with Absence & Substitute Detection
// REPLACE your parseIclassProHTML function in server.js with this entire function

function parseIclassProHTML(html) {
  const $ = cheerio.load(html);
  const data = { kids: [], blocks: new Set() };

  // Parse each class section
  $('.condensed-mode > div').each((_, classBlock) => {
    const $class = $(classBlock);

    // === PARSE HEADER INFO ===
    const headerText = $class.find('.full-width-header span').first().text();
    const dateText = $class.find('.full-width-header .no-wrap').last().text().trim();
    
    // Extract program, level, time, and instructor
    const programMatch = headerText.match(/^(\w+(?:-\w+)?):?\s+(.+?)\s+on\s+\w+:\s+([\d:]+\s*-\s*[\d:]+)\s+with\s+(.+)$/);
    if (!programMatch) return;

    const [, program, level, timeRange, primaryInstructor] = programMatch;
    const [startTime, endTime] = timeRange.split('-').map(t => t.trim());

    // === DETECT SUBSTITUTE INSTRUCTOR ===
    let actualInstructor = primaryInstructor.trim();
    let isSubstitute = false;
    let substituteInstructor = null;
    let originalInstructor = primaryInstructor.trim();

    // Check instructor list for asterisk (indicates sub)
    const instructorList = [];
    $class.find('th:contains("Instructors:")').next().find('li').each((_, li) => {
      const name = $(li).text().trim();
      instructorList.push(name);
      
      // Asterisk indicates substitute
      if (name.endsWith('*')) {
        isSubstitute = true;
        substituteInstructor = name.replace('*', '').trim();
      }
    });

    // If substitute detected, use them as actual instructor
    if (isSubstitute && substituteInstructor) {
      actualInstructor = substituteInstructor;
      // Reformat name: "Last, First" -> "First Last"
      if (actualInstructor.includes(',')) {
        const parts = actualInstructor.split(',').map(p => p.trim());
        actualInstructor = `${parts[1]} ${parts[0]}`;
      }
      // Keep original instructor from header
      if (primaryInstructor.includes(',')) {
        const parts = primaryInstructor.split(',').map(p => p.trim());
        originalInstructor = `${parts[1]} ${parts[0]}`;
      }
    } else {
      // No sub, format the primary instructor name
      if (actualInstructor.includes(',')) {
        const parts = actualInstructor.split(',').map(p => p.trim());
        actualInstructor = `${parts[1]} ${parts[0]}`;
      }
    }

    // === PARSE ZONE ===
    let zone = null;
    const zoneText = $class.find('th:contains("Zone:")').next().text().trim();
    const zoneMatch = zoneText.match(/Zone\s*(\d+)/i);
    if (zoneMatch) {
      zone = parseInt(zoneMatch[1]);
    }

    // === PARSE DATE ===
    const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!dateMatch) return;
    
    const [, month, day, year] = dateMatch;
    const classDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

    // === CREATE START_TIME (DATE + TIME) ===
    const start_time = `${classDate} ${convertTo24Hour(startTime)}`;
    data.blocks.add(start_time);

    // === PARSE EACH SWIMMER ===
    $class.find('table.roll-sheet tbody tr').each((_, row) => {
      const $row = $(row);
      
      // Skip header rows
      if ($row.find('th').length > 0) return;

      // === PARSE SWIMMER NAME ===
      const nameText = $row.find('.student .student-name').text().trim();
      if (!nameText) return;

      // === PARSE AGE ===
      const ageText = $row.find('.student .student-age').text().trim();

      // === DETECT PRE-MARKED ABSENCE ===
      // iClassPro marks absences with cancel.png icon in the date-time cell
      const hasAbsenceIcon = $row.find('.date-time img[src*="cancel.png"]').length > 0;
      
      // If absence detected, set attendance to 0 (absent)
      const preMarkedAttendance = hasAbsenceIcon ? 0 : null;

      // === PARSE FLAGS ===
      let flag_new = 0;
      let flag_trial = 0;
      let flag_makeup = 0;
      let flag_policy = 0;
      let flag_owes = 0;

      // Check for icons
      $row.find('.icons img').each((_, img) => {
        const src = $(img).attr('src') || '';
        if (src.includes('1st-time') || src.includes('new')) flag_new = 1;
        if (src.includes('trial') || src.includes('birthday')) flag_trial = 1;
        if (src.includes('makeup') || src.includes('gift')) flag_makeup = 1;
        if (src.includes('policy') || src.includes('waiver')) flag_policy = 1;
        if (src.includes('balance') || src.includes('money')) flag_owes = 1;
      });

      // === CREATE SWIMMER RECORD ===
      const swimmer = {
        start_time,
        swimmer_name: nameText,
        age_text: ageText || '',
        program: `${program} - ${level}`,
        instructor_name: actualInstructor,
        is_substitute: isSubstitute ? 1 : 0,
        original_instructor: isSubstitute ? originalInstructor : null,
        zone: zone,
        flag_new,
        flag_trial,
        flag_makeup,
        flag_policy,
        flag_owes,
        attendance: preMarkedAttendance,
        is_addon: 0
      };

      data.kids.push(swimmer);
    });
  });

  return {
    kids: data.kids,
    blocks: Array.from(data.blocks).sort()
  };
}

// Helper function - add this if it doesn't exist
function convertTo24Hour(time12h) {
  const [time, modifier] = time12h.split(/([ap]m)/i);
  let [hours, minutes] = time.split(':');
  hours = parseInt(hours);

  if (modifier && modifier.toLowerCase() === 'pm' && hours !== 12) {
    hours += 12;
  } else if (modifier && modifier.toLowerCase() === 'am' && hours === 12) {
    hours = 0;
  }

  return `${String(hours).padStart(2, '0')}:${minutes || '00'}:00`;
}
