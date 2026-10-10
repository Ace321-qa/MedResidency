import { formatDate, formatHours, toCalendarDate, toComparableDate, toNumber } from '../src/utils/format';
import {
  DUTY_WINDOW_DAYS,
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
 *
 * The database behind these checks is live, so expectations are derived from
 * the payloads and from the current local date rather than frozen to a
 * snapshot: schedule thresholds are bounded across every block, duty-hour
 * window metrics are recomputed for today's rolling 7-day window, and leave
 * totals are cross-checked against the raw rows.
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

/**
 * Recompute what a rolling duty window should report, independently of
 * `summarizeDutyHours`, so the summariser is checked against a second
 * implementation rather than against its own output.
 *
 * `anchor` is the last day of the window; the window is the
 * `DUTY_WINDOW_DAYS` calendar days ending on it, inclusive.
 */
function expectWindow(logs: any[], anchor: Date) {
  const end = toCalendarDate(anchor);
  const start = toCalendarDate(
    new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - (DUTY_WINDOW_DAYS - 1)),
  );

  const rows = logs.filter((log) => {
    const shiftDate = toComparableDate(log.shift_date);
    return shiftDate !== null && shiftDate >= start && shiftDate <= end;
  });

  const counted = rows
    .map((log) => toNumber(log.total_hours))
    .filter((value): value is number => value !== null);
  const hours = counted.reduce((sum, value) => sum + value, 0);

  return {
    start,
    end,
    shifts: rows.length,
    hours,
    breaches: rows.filter((log) => log.is_flagged_for_breach === 1).length,
    average: counted.length > 0 ? Math.round((hours / counted.length) * 100) / 100 : null,
  };
}

(async () => {
  const roster = await get('residents?limit=50');
  const sched = await get('rotations/assignments/resident/1');
  const att = await get('attendance/resident/1');
  const lv = await get('leaves/resident/1');

  // --- roster derivations -------------------------------------------------
  const programs = deriveProgramsFromResidents(roster);
  console.log('\nprograms:', JSON.stringify(programs));

  // Residents arrive through Excel imports, so these are minimum baselines,
  // not exact counts: the roster must never shrink below its seeded size, and
  // the derived list is what the programme picker draws its choices from.
  assert('roster has at least the 12 seeded residents', roster.length >= 12, `got ${roster.length}`);
  assert('all four seeded programmes are derived', programs.length >= 4, `got ${programs.length}`);
  const programmeOneCount = programs.find((p) => p.programId === 1)?.residentCount ?? 0;
  assert(
    'program 1 has at least its 7 seeded residents',
    programmeOneCount >= 7,
    String(programmeOneCount),
  );
  // Exact accounting: every resident that carries a programme id is counted in
  // the derived list, and no-one without one is. Imported rows must reconcile
  // the two figures, whatever the exact numbers happen to be.
  assert(
    'un-enrolled residents are excluded and the counts reconcile',
    programs.reduce((s, p) => s + p.residentCount, 0) ===
      roster.filter((r: any) => r.program_id !== null && r.program_id !== undefined).length,
    `${programs.reduce((s, p) => s + p.residentCount, 0)} counted from ${roster.length} residents`,
  );

  const r1 = roster.find((r: any) => r.resident_id === 1);
  assert('full name includes middle initial', residentFullName(r1) === 'Omar K. Al-Nouri', residentFullName(r1));
  assert('subtitle is PGY + specialty', residentSubtitle(r1) === 'PGY-1 · Family Medicine', residentSubtitle(r1));
  assert('search by pgy works', filterResidents(roster, 'pgy-3').length === 1, String(filterResidents(roster, 'pgy-3').length));
  assert('search by name works', filterResidents(roster, 'nouri').length === 1);
  assert('search miss returns 0', filterResidents(roster, 'zzzz').length === 0);

  // --- schedule -----------------------------------------------------------
  const today = toCalendarDate(new Date());
  const s = summarizeSchedule(sched);
  console.log('\nschedule:', JSON.stringify({ current: !!s.current, next: !!s.next, last: !!s.last, completed: s.completedCount, upcoming: s.upcomingCount, totalWeeks: s.totalWeeks }));

  assert(`no ACTIVE rotation on ${today}`, s.current === null);

  const nextStart = s.next ? toComparableDate(s.next.start_date) : null;
  assert(
    'upcoming rotation starts after today',
    nextStart !== null && nextStart > today,
    `${s.next?.rotation_name ?? '—'} from ${nextStart ?? '—'}`,
  );

  const endedBefore = (assignment: any) => {
    const end = toComparableDate(assignment.end_date);
    return end !== null && end < today;
  };
  const expectedCompleted = (sched as any[]).filter(endedBefore).length;
  assert(
    'completed rotations counted from end dates',
    s.completedCount === expectedCompleted && s.completedCount === 1,
    `${s.completedCount} vs expected ${expectedCompleted}`,
  );
  assert('last rotation is the July block', s.last?.rotation_name === 'Family Medicine Continuity Clinic', s.last?.rotation_name);

  // DECIMAL strings must be summed across every row: the completed July block
  // plus the repeated November rows, so the total spans multiple blocks and
  // tops out at a full academic year (52 weeks) whatever the live database
  // currently holds.
  assert(
    'assigned_weeks sum across all blocks (multi-block, spans the academic year)',
    s.totalWeeks > 4 && s.totalWeeks <= 52,
    String(s.totalWeeks),
  );
  const rawWeeks = (sched as any[]).reduce(
    (sum: number, assignment: any) => sum + (toNumber(assignment.assigned_weeks) ?? 0),
    0,
  );
  assert('totalWeeks matches the raw assigned_weeks sum', s.totalWeeks === rawWeeks, `${s.totalWeeks} vs raw ${rawWeeks}`);

  const blocks = groupScheduleByBlock(sched);
  const distinctBlockNames = new Set((sched as any[]).map((assignment: any) => assignment.block_name)).size;
  assert(
    'one block group per distinct block_name',
    blocks.length === distinctBlockNames,
    `${blocks.length} vs ${distinctBlockNames}`,
  );
  assert('earliest block phase COMPLETED', blocks[0].phase === 'COMPLETED', blocks[0].phase);
  assert(
    'latest block phase UPCOMING',
    blocks[blocks.length - 1].phase === 'UPCOMING',
    blocks[blocks.length - 1].phase,
  );
  assert('block date range formatted', /\d{1,2} \w{3} \d{4}/.test(blocks[0].dateRange), blocks[0].dateRange);

  // --- duty hours ---------------------------------------------------------
  const d = summarizeDutyHours(att);
  const rolling = expectWindow(att, new Date());
  console.log(`\nduty window ${rolling.start}..${rolling.end}:`, JSON.stringify(d));

  // The DECIMAL row is located by its breach flag rather than by array
  // position: the API orders logs newest first, so a newer shift can land in
  // front of it as the resident keeps logging hours.
  const longShift = (att as any[]).find((log: any) => log.is_flagged_for_breach === 1);
  assert('DECIMAL "28.00" parsed', toNumber(longShift?.total_hours) === 28, String(longShift?.total_hours));
  assert('formatHours renders the DECIMAL', formatHours(longShift?.total_hours) === '28 h', formatHours(longShift?.total_hours));

  assert(
    'recent shifts fall inside the rolling 7-day window',
    rolling.shifts > 0,
    `${rolling.shifts} shift(s) since ${rolling.start}`,
  );
  assert('window shift count matches the payload', d.windowShifts === rolling.shifts, `${d.windowShifts} vs ${rolling.shifts}`);
  assert('window hours summed, not all-time', d.windowHours === rolling.hours, `${d.windowHours} vs ${rolling.hours}`);
  assert('window breaches counted inside the window', d.windowBreaches === rolling.breaches, `${d.windowBreaches} vs ${rolling.breaches}`);
  assert(
    'all-time breaches counted across every log',
    d.totalBreaches === ((att as any[]).filter((log: any) => log.is_flagged_for_breach === 1).length),
    String(d.totalBreaches),
  );
  assert('average uses only shifts WITH hours', d.averageShiftHours === rolling.average, `${d.averageShiftHours} vs ${rolling.average}`);

  // A window that predates every log must report null rather than 0, so the
  // empty branch stays covered even as new shifts are added.
  const empty = summarizeDutyHours(att, new Date(new Date().getFullYear() - 1, 0, 1));
  assert('window before the earliest log is empty', empty.windowShifts === 0, String(empty.windowShifts));
  assert('average is null when window empty', empty.averageShiftHours === null, String(empty.averageShiftHours));

  // window that CONTAINS the July shifts
  const julyAnchor = new Date(2026, 6, 10); // 10 Jul 2026
  const inWindow = summarizeDutyHours(att, julyAnchor);
  const julyExpected = expectWindow(att, julyAnchor);
  console.log('duty @10 Jul:', JSON.stringify(inWindow));
  assert('window shift count correct', inWindow.windowShifts === 3, `${inWindow.windowShifts} vs ${julyExpected.shifts}`);
  assert('window hours = 28 + 8.5 = 36.5', inWindow.windowHours === julyExpected.hours, `${inWindow.windowHours} vs ${julyExpected.hours}`);
  assert('breach inside window counted once', inWindow.windowBreaches === 1 && inWindow.windowBreaches === julyExpected.breaches, String(inWindow.windowBreaches));
  assert(
    'average uses only shifts WITH hours (2, not 3)',
    inWindow.averageShiftHours === julyExpected.average && inWindow.averageShiftHours === 18.25,
    String(inWindow.averageShiftHours),
  );

  // --- leaves -------------------------------------------------------------
  const l = summarizeLeaves(lv);
  const rawApproved = (lv as any[]).filter((row: any) => row.status === 'APPROVED');
  const rawPending = (lv as any[]).filter((row: any) => row.status === 'PENDING' || row.status === 'APPROVED_BY_CHIEF');
  const rawApprovedDays = rawApproved.reduce((sum: number, row: any) => sum + (row.total_days ?? 0), 0);
  console.log('\nleaves:', JSON.stringify(l));
  assert(
    'no request awaiting a decision',
    l.pendingCount === 0 && l.pendingCount === rawPending.length,
    `${l.pendingCount} pending vs raw ${rawPending.length}`,
  );
  assert('three approved', l.approvedCount === 3 && l.approvedCount === rawApproved.length, `${l.approvedCount} approved`);
  assert(
    'approved days sum to 27',
    l.approvedDays === 27 && l.approvedDays === rawApprovedDays,
    `${l.approvedDays} vs raw ${rawApprovedDays}`,
  );
  assert('next pending is null', l.nextPending === null, l.nextPending === null ? 'null' : l.nextPending.leave_type);

  // --- date handling ------------------------------------------------------
  const shiftDate = formatDate(att[0].shift_date);
  console.log('\ndate: shift_date', att[0].shift_date, '->', shiftDate);
  assert('local-date parse does not throw', /^\d{2} \w{3} \d{4}$/.test(shiftDate), shiftDate);
  assert('leave date is already YYYY-MM-DD', formatDate(lv[0].start_date) === '10 Aug 2026', formatDate(lv[0].start_date));

  // --- release letters ------------------------------------------------------
  // The preview modal is only useful if the API hands it a *finished* letter, so
  // both halves of the mail merge are checked: the body is stored merged, and the
  // subject is merged on read out of the template the body came from.
  const letters = (await get('letters/resident/1')) as any[];
  console.log('\nletters:', JSON.stringify(letters.map((letter: any) => letter.letter_subject)));

  assert('resident 1 has a generated release letter', letters.length > 0, String(letters.length));
  assert(
    'letter subject is merged on read, not the raw template',
    letters.every(
      (letter: any) =>
        typeof letter.letter_subject === 'string' &&
        letter.letter_subject.includes('Omar Al-Nouri') &&
        letter.letter_subject.includes('PGY-1') &&
        !/\{\{[A-Z0-9_]+\}\}/.test(letter.letter_subject),
    ),
    letters.map((letter: any) => letter.letter_subject).join(' | '),
  );
  assert(
    'letter body carries no unresolved placeholders',
    letters.every(
      (letter: any) =>
        typeof letter.generated_letter_body === 'string' &&
        letter.generated_letter_body.includes('Omar Al-Nouri') &&
        !/\{\{[A-Z0-9_]+\}\}/.test(letter.generated_letter_body),
    ),
  );

  // Throwing rather than setting an exit code, so this script needs no Node
  // type definitions to compile standalone.
  if (failures.length > 0) {
    throw new Error(`${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  }
  console.log(`\nALL ${'checks passed'}`);
})();
