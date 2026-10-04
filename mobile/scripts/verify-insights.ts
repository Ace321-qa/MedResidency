import { formatDate, formatHours, toNumber } from '../src/utils/format';
import {
  summarizeDutyHours,
  summarizeSchedule,
  summarizeLeaves,
  groupScheduleByBlock,
} from '../src/utils/insights';
import {
  deriveProgramsFromResidents,
  filterResidents,
  residentFullName,
  residentSubtitle,
} from '../src/utils/residents';

/*
 * Integration check for the pure logic in src/utils.
 *
 * These functions decide whether a resident is on a rotation, how many duty
 * hours fall inside a reporting window, and which leave requests are awaiting a
 * decision. They are pure, so they can be checked directly against real API
 * payloads instead of being eyeballed in a simulator.
 *
 * This script lives outside src/ so it can never end up in an app bundle.
 *
 * Requires the backend to be running:
 *   cd .. && npm start
 *   npx tsc scripts/verify-insights.ts --ignoreConfig --outDir /tmp/verify \
 *       --module commonjs --target es2022 --moduleResolution node \
 *       --esModuleInterop --skipLibCheck --ignoreDeprecations 6.0
 *   node /tmp/verify/verify-insights.js
 *
 * It caught a real defect once already: the duty-hour window compared
 * `formatDate` output ("05 Jul 2026") lexically against "2026-07-04", so every
 * shift looked like it fell outside every window. Range comparisons now go
 * through `toComparableDate`.
 */

/** Trailing slash required: paths are resolved relative to this, not concatenated. */
const API_ROOT = 'http://localhost:5001/api/v1/';

async function get(path: string) {
  const url = new URL(path, API_ROOT);
  const response = await fetch(url);
  const body = await response.json();

  if (!response.ok || !body.success) {
    throw new Error(`${url.pathname} -> ${response.status}: ${body.error ?? body.message ?? 'request failed'}`);
  }

  return body.data;
}

const failures: string[] = [];

function assert(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures.push(label);
}

(async () => {
  const roster = await get('residents?limit=50');
  const sched = await get('rotations/assignments/resident/1');
  const att = await get('attendance/resident/1');
  const lv = await get('leaves/resident/1');

  // --- roster derivations -------------------------------------------------
  const programs = deriveProgramsFromResidents(roster);
  console.log('\nprograms:', JSON.stringify(programs));
  assert('roster has 12 residents', roster.length === 12, `got ${roster.length}`);
  assert('4 distinct programmes derived', programs.length === 4, `got ${programs.length}`);
  assert(
    'program 1 counts 7 residents',
    programs.find((p) => p.programId === 1)?.residentCount === 7,
    String(programs.find((p) => p.programId === 1)?.residentCount),
  );
  assert(
    'un-enrolled residents are excluded',
    programs.reduce((s, p) => s + p.residentCount, 0) === 10,
    String(programs.reduce((s, p) => s + p.residentCount, 0)),
  );

  const r1 = roster.find((r: any) => r.resident_id === 1);
  assert('full name includes middle initial', residentFullName(r1) === 'Omar K. Al-Nouri', residentFullName(r1));
  assert('subtitle is PGY + specialty', residentSubtitle(r1) === 'PGY-1 · Family Medicine', residentSubtitle(r1));
  assert('search by pgy works', filterResidents(roster, 'pgy-3').length === 1, String(filterResidents(roster, 'pgy-3').length));
  assert('search by name works', filterResidents(roster, 'nouri').length === 1);
  assert('search miss returns 0', filterResidents(roster, 'zzzz').length === 0);

  // --- schedule -----------------------------------------------------------
  const s = summarizeSchedule(sched);
  console.log('\nschedule:', JSON.stringify({ current: !!s.current, next: !!s.next, last: !!s.last, completed: s.completedCount, totalWeeks: s.totalWeeks }));
  assert('no ACTIVE rotation (July block is past)', s.current === null);
  assert('no upcoming rotation', s.next === null);
  assert('one completed rotation', s.completedCount === 1);
  assert('last rotation is the July block', s.last?.rotation_name === 'Family Medicine Continuity Clinic');
  assert('assigned_weeks DECIMAL string parsed to 4', s.totalWeeks === 4, String(s.totalWeeks));
  const blocks = groupScheduleByBlock(sched);
  assert('one block group', blocks.length === 1, String(blocks.length));
  assert('block phase COMPLETED', blocks[0].phase === 'COMPLETED', blocks[0].phase);
  assert('block date range formatted', /\d{1,2} \w{3} \d{4}/.test(blocks[0].dateRange), blocks[0].dateRange);

  // --- duty hours ---------------------------------------------------------
  const d = summarizeDutyHours(att);
  console.log('\nduty:', JSON.stringify(d));
  assert('DECIMAL "28.00" parsed', toNumber(att[0].total_hours) === 28);
  assert('one breach detected', d.totalBreaches === 1, String(d.totalBreaches));
  assert('old logs are outside the 7-day window', d.windowShifts === 0, String(d.windowShifts));
  assert('window hours are 0, not all-time', d.windowHours === 0, String(d.windowHours));
  assert('average is null when window empty', d.averageShiftHours === null);
  assert('formatHours renders the DECIMAL', formatHours(att[0].total_hours) === '28 h', formatHours(att[0].total_hours));

  // window that CONTAINS the July shifts
  const inWindow = summarizeDutyHours(att, new Date(2026, 6, 10)); // 10 Jul 2026
  console.log('duty @10 Jul:', JSON.stringify(inWindow));
  assert('window shift count correct', inWindow.windowShifts === 3, String(inWindow.windowShifts));
  assert('window hours = 28 + 8.5 = 36.5', inWindow.windowHours === 36.5, String(inWindow.windowHours));
  assert('breach inside window counted once', inWindow.windowBreaches === 1);
  assert(
    'average uses only shifts WITH hours (2, not 3)',
    inWindow.averageShiftHours === 18.25,
    String(inWindow.averageShiftHours),
  );

  // --- leaves -------------------------------------------------------------
  const l = summarizeLeaves(lv);
  console.log('\nleaves:', JSON.stringify(l));
  assert('one pending request', l.pendingCount === 1, String(l.pendingCount));
  assert('two approved', l.approvedCount === 2, String(l.approvedCount));
  assert('approved days sum to 22', l.approvedDays === 22, String(l.approvedDays));
  assert('next pending is the study leave', l.nextPending?.leave_type === 'STUDY_LEAVE', String(l.nextPending?.leave_type));

  // --- date handling ------------------------------------------------------
  console.log('\ndate: shift_date', att[0].shift_date, '->', formatDate(att[0].shift_date));
  assert('local-date parse does not throw', formatDate(att[0].shift_date) !== '—');
  assert('leave date is already YYYY-MM-DD', formatDate(lv[0].start_date) === '10 Aug 2026', formatDate(lv[0].start_date));

  // Throwing rather than setting an exit code, so this script needs no Node
  // type definitions to compile standalone.
  if (failures.length > 0) {
    throw new Error(`${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  }
  console.log(`\nALL ${'checks passed'}`);
})();
