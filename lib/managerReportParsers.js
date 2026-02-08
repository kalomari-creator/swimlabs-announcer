'use strict';

const cheerio = require('cheerio');

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeInt(value) {
  const m = String(value || '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function safeFloat(value) {
  const m = String(value || '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function round2(n) {
  if (n == null) return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function parseHTMLTable(html) {
  const $ = cheerio.load(html || '');
  const tables = $('table');
  if (!tables.length) return { headers: [], rows: [] };

  let best = null;
  tables.each((_, table) => {
    const $table = $(table);
    const headers = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((__, cell) => normalizeSpace($(cell).text()))
      .get();

    const rows = [];
    $table
      .find('tr')
      .slice(1)
      .each((__, row) => {
        const cols = $(row)
          .find('td,th')
          .map((___, cell) => normalizeSpace($(cell).text()))
          .get();
        if (cols.length) rows.push(cols);
      });

    if (!best || rows.length > best.rows.length) {
      best = { headers, rows };
    }
  });

  return best || { headers: [], rows: [] };
}

function extractLabelValue($, label) {
  const labelNorm = normalizeSpace(label).toLowerCase();
  let found = null;

  $('strong').each((_, strong) => {
    const strongText = normalizeSpace($(strong).text()).toLowerCase();
    if (!strongText) return;

    // Handles "As Of Date:" and variants.
    const matches = strongText === `${labelNorm}:` || strongText === labelNorm || strongText.startsWith(labelNorm);
    if (!matches) return;

    const parentText = normalizeSpace($(strong).parent().text());
    const re = new RegExp(`^\\s*${escapeRegExp(label)}\\s*:?\\s*`, 'i');
    const value = normalizeSpace(parentText.replace(re, ''));
    if (value) found = value;
  });

  if (found) return found;

  // Fallback: plain text search.
  const stripped = normalizeSpace($.root().text());
  const re = new RegExp(`${escapeRegExp(label)}\\s*:\\s*([^\n\r]+)`, 'i');
  const m = stripped.match(re);
  return m && m[1] ? normalizeSpace(m[1]) : null;
}

function pickInstructorName($table) {
  const h2s = $table
    .find('h2')
    .map((_, h) => normalizeSpace($table.find(h).text()))
    .get()
    .filter(Boolean);

  const filtered = h2s.filter((t) => {
    const lower = t.toLowerCase();
    if (lower === 'totals') return false;
    if (lower.includes('booked') || lower.includes('retained')) return false;
    if (lower.includes('renewed bookings') || lower.includes('new bookings')) return false;
    return true;
  });

  return filtered[0] || null;
}

function parseTotalsFromRetentionTable($table) {
  const tbodies = $table.children('tbody').toArray();
  if (!tbodies.length) return { booked: null, retained: null, percent_retained: null };

  let totalsHeaderIdx = -1;
  for (let i = 0; i < tbodies.length; i += 1) {
    const h2 = normalizeSpace($table.find(tbodies[i]).find('h2').first().text()).toLowerCase();
    if (h2 === 'totals') {
      totalsHeaderIdx = i;
      break;
    }
  }

  const startIdx = totalsHeaderIdx >= 0 ? totalsHeaderIdx + 1 : 0;
  for (let j = startIdx; j < tbodies.length; j += 1) {
    const $tb = $table.find(tbodies[j]);

    const strongs = $tb
      .find('strong')
      .map((_, n) => normalizeSpace($table.find(n).text()))
      .get()
      .filter((t) => /\d/.test(t));

    if (strongs.length < 2) continue;

    const booked = safeInt(strongs[0]);
    const retained = safeInt(strongs[1]);

    // Percent retained usually lives in the retained cell as a <small>79.55%</small>.
    const smalls = $tb
      .find('small')
      .map((_, n) => normalizeSpace($table.find(n).text()))
      .get();

    const percentText = smalls.reverse().find((t) => t.includes('%')) || null;
    let percent = percentText ? safeFloat(percentText.replace('%', '')) : null;

    if (percent == null && booked != null && booked !== 0 && retained != null) {
      percent = (retained / booked) * 100;
    }

    return {
      booked,
      retained,
      percent_retained: round2(percent)
    };
  }

  return { booked: null, retained: null, percent_retained: null };
}

function parseRetentionReport(html) {
  const $ = cheerio.load(html || '');
  const warnings = [];

  const asOf = extractLabelValue($, 'As Of Date');
  const retainedDate = extractLabelValue($, 'Retained Date');

  const date_bracket = {
    as_of: asOf || null,
    retained: retainedDate || null,
    raw: [
      asOf ? `As Of Date: ${asOf}` : null,
      retainedDate ? `Retained Date: ${retainedDate}` : null
    ].filter(Boolean).join(' | ') || null
  };

  const instructors = [];

  const tables = $('table.report-table').toArray();
  if (!tables.length) warnings.push('No instructor retention tables found.');

  for (const table of tables) {
    const $table = $(table);

    const instructor = pickInstructorName($table);
    if (!instructor) continue;

    const totals = parseTotalsFromRetentionTable($table);
    if (totals.booked == null || totals.retained == null || totals.percent_retained == null) {
      warnings.push(`Could not parse totals for instructor: ${instructor}`);
    }

    instructors.push({
      instructor,
      booked: totals.booked,
      retained: totals.retained,
      percent_retained: totals.percent_retained,
      retention_percent: totals.percent_retained
    });
  }

  // De-dupe instructors if the HTML repeats tables (rare, but happens with print glitches).
  const seen = new Set();
  const deduped = [];
  for (const row of instructors) {
    const key = row.instructor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return { warnings, date_bracket, instructors: deduped };
}

function parseAgedAccountsReport(html) {
  const { headers, rows } = parseHTMLTable(html);
  const warnings = [];
  if (!rows.length) warnings.push('No aged accounts rows detected.');
  return { headers, rows, warnings };
}

function parseDropListReport(html) {
  const { headers, rows } = parseHTMLTable(html);
  const warnings = [];
  if (!rows.length) warnings.push('No drop list rows detected.');

  const entries = rows.map((cols) => ({ raw: cols }));
  return { headers, entries, warnings };
}

module.exports = {
  parseRetentionReport,
  parseAgedAccountsReport,
  parseDropListReport
};
