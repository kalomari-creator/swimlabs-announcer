'use strict';

const fs = require('fs');
const path = require('path');

const parsers = require('../lib/managerReportParsers');

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function isHumanName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/\b(booked|retained|totals)\b/i.test(t)) return false;
  // Simple heuristic: at least 2 alpha tokens.
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  if (!parts.every((p) => /[A-Za-z]/.test(p))) return false;
  return true;
}

const fixturesDir = path.resolve(__dirname, '..', 'tests', 'fixtures', 'retention');
if (!fs.existsSync(fixturesDir)) {
  fail(`Missing fixtures dir: ${fixturesDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.toLowerCase().endsWith('.html'))
  .map((f) => path.join(fixturesDir, f));

if (!files.length) {
  fail(`No retention HTML fixtures found in ${fixturesDir}`);
  process.exit(1);
}

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const out = parsers.parseRetentionReport(html);

  if (!out || !Array.isArray(out.instructors)) {
    fail(`${path.basename(file)}: parse output missing instructors array`);
    continue;
  }

  if (out.instructors.length <= 0) {
    fail(`${path.basename(file)}: instructors count is 0`);
    continue;
  }

  const first = out.instructors[0];
  if (!isHumanName(first.instructor)) {
    fail(`${path.basename(file)}: first instructor looks wrong: ${JSON.stringify(first.instructor)}`);
  }

  for (const row of out.instructors) {
    if (!isHumanName(row.instructor)) {
      fail(`${path.basename(file)}: bad instructor name: ${JSON.stringify(row.instructor)}`);
      break;
    }
    if (typeof row.booked !== 'number' || Number.isNaN(row.booked)) {
      fail(`${path.basename(file)}: booked not a number for ${row.instructor}: ${JSON.stringify(row.booked)}`);
      break;
    }
    if (typeof row.retained !== 'number' || Number.isNaN(row.retained)) {
      fail(`${path.basename(file)}: retained not a number for ${row.instructor}: ${JSON.stringify(row.retained)}`);
      break;
    }
    if (typeof row.percent_retained !== 'number' || Number.isNaN(row.percent_retained)) {
      fail(`${path.basename(file)}: percent_retained not a number for ${row.instructor}: ${JSON.stringify(row.percent_retained)}`);
      break;
    }
  }

  const bracket = out.date_bracket?.raw || out.date_bracket?.as_of || null;
  if (!bracket) {
    fail(`${path.basename(file)}: missing date_bracket`);
  }

  console.log(`${path.basename(file)}: OK (${out.instructors.length} instructors)`);
}

if (!process.exitCode) {
  console.log('Retention parser fixtures: PASS');
}
