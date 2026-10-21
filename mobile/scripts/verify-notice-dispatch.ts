import {
  departmentsWithoutRecipient,
  describeBlockNumbers,
  describeDepartmentRows,
  describeDispatchOutcome,
  describeResidentRows,
  describeSendReadiness,
  plannedLetterCount,
  uniqueResidentCount,
} from '../src/utils/noticeDispatch';
import type {
  RotationNoticeDepartment,
  RotationNoticeDispatchResult,
  RotationNoticePlan,
} from '../src/types/api';

/*
 * Checks the counts and wording of the "Send Notice Letter" confirmation.
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-notice-dispatch.js
 *
 * These numbers are what a coordinator reads before agreeing to write to
 * departments outside their own programme, so a miscount is a real harm rather
 * than a cosmetic one. Two of them are easy to get wrong in opposite directions:
 *
 *  - Letters are counted per *assignment*, residents per *person*. A resident
 *    split across two rotations gets two letters and one notification, and a
 *    summary that used one number for both would overstate the audience.
 *  - A draft block must *refuse* the send, not merely warn, because the whole
 *    point of finalization is that a schedule still being edited is not
 *    announced to another hospital.
 *
 * Pure, so it runs under plain `node` with no React Native runtime.
 */

const failures: string[] = [];
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(
      `  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`,
    );
  }
}

function department(overrides: Partial<RotationNoticeDepartment> = {}): RotationNoticeDepartment {
  return {
    department_name: 'Internal Medicine',
    resident_count: 2,
    has_recipient: true,
    recipient_email: 'coord@example.com',
    ...overrides,
  } as RotationNoticeDepartment;
}

function plan(overrides: Partial<RotationNoticePlan> = {}): RotationNoticePlan {
  return {
    program_id: 1,
    block_ids: [5],
    draft_block_ids: [],
    targets: [
      { rotation_assignment_id: 1, resident_id: 1, resident_name: 'A', department_name: 'D' },
      { rotation_assignment_id: 2, resident_id: 2, resident_name: 'B', department_name: 'D' },
    ],
    residents: [
      { resident_id: 1, resident_name: 'A', pgy_level: 'PGY-1', assignment_count: 1 },
      { resident_id: 2, resident_name: 'B', pgy_level: 'PGY-2', assignment_count: 1 },
    ],
    departments: [department()],
    ...overrides,
  } as RotationNoticePlan;
}

console.log('-- letters are per assignment, residents are per person --');
{
  // One resident, two assignments: two letters, one notification.
  const split = plan({
    targets: [
      { rotation_assignment_id: 10, resident_id: 1, resident_name: 'A', department_name: 'D1' },
      { rotation_assignment_id: 11, resident_id: 1, resident_name: 'A', department_name: 'D2' },
      { rotation_assignment_id: 12, resident_id: 2, resident_name: 'B', department_name: 'D2' },
    ],
    residents: [
      { resident_id: 1, resident_name: 'A', pgy_level: 'PGY-1', assignment_count: 2 },
      { resident_id: 2, resident_name: 'B', pgy_level: 'PGY-2', assignment_count: 1 },
    ],
  });
  check('two people, three letters', [uniqueResidentCount(split), plannedLetterCount(split)], [2, 3]);
  check('an empty plan has no letters', plannedLetterCount(plan({ targets: [] })), 0);
  check('a null plan has no residents', uniqueResidentCount(null), 0);
  check('a null plan has no letters', plannedLetterCount(null), 0);
}

console.log('-- departments without an address are surfaced, not hidden --');
{
  const departments = [
    department({ department_name: 'Has one', has_recipient: true }),
    department({ department_name: 'Has none', has_recipient: false }),
  ];
  check('only the addressless department is returned', departmentsWithoutRecipient(departments).length, 1);
  check(
    'and it is the right one',
    departmentsWithoutRecipient(departments)[0]?.department_name,
    'Has none',
  );
  check('a null list is empty', departmentsWithoutRecipient(null).length, 0);
}

console.log('\n-- block wording --');
check('one block is singular', describeBlockNumbers([5]), 'Block 5');
check('several blocks are plural', describeBlockNumbers([5, 6]), 'Blocks 5, 6');
check('duplicates collapse', describeBlockNumbers([6, 5, 5]), 'Blocks 5, 6');
check('they are sorted', describeBlockNumbers([9, 4, 7]), 'Blocks 4, 7, 9');
check('nothing becomes "this view"', describeBlockNumbers([]), 'this view');
check('a null list becomes "this view"', describeBlockNumbers(null), 'this view');
check('nonsense is discarded', describeBlockNumbers([0, -1, Number.NaN]), 'this view');

console.log('\n-- readiness: a draft block refuses, an empty plan refuses --');
{
  check(
    'a finalized plan with targets is ready',
    describeSendReadiness(plan(), { sendToCoordinators: true, notifyResidents: true }),
    { ready: true, reason: null },
  );
  check(
    'a draft block refuses',
    describeSendReadiness(plan({ draft_block_ids: [5] }), {
      sendToCoordinators: true,
      notifyResidents: true,
    }).ready,
    false,
  );
  check(
    'and the reason names the block',
    describeSendReadiness(plan({ draft_block_ids: [5] }), {
      sendToCoordinators: true,
      notifyResidents: true,
    }).reason,
    'Block 5 still draft. Finalize the block before sending notices.',
  );
  check(
    'an empty plan refuses',
    describeSendReadiness(plan({ targets: [] }), {
      sendToCoordinators: true,
      notifyResidents: true,
    }).ready,
    false,
  );
  check(
    'choosing no recipient group refuses',
    describeSendReadiness(plan(), { sendToCoordinators: false, notifyResidents: false }).reason,
    'Choose at least one recipient group to send to.',
  );
  check(
    'choosing only residents is enough',
    describeSendReadiness(plan(), { sendToCoordinators: false, notifyResidents: true }).ready,
    true,
  );
  check(
    'choosing only departments is enough',
    describeSendReadiness(plan(), { sendToCoordinators: true, notifyResidents: false }).ready,
    true,
  );
  check(
    'no plan is not ready, and offers no false reason',
    describeSendReadiness(null, { sendToCoordinators: true, notifyResidents: true }),
    { ready: false, reason: null },
  );
}

console.log('\n-- department rows: busiest first --');
{
  const rows = describeDepartmentRows([
    department({ department_name: 'Small', resident_count: 1 }),
    department({ department_name: 'Big', resident_count: 9 }),
    department({ department_name: 'Medium', resident_count: 4 }),
  ]);
  check('ordered by resident count', rows.map((row) => row.label), ['Big', 'Medium', 'Small']);
  check('the detail counts residents', rows[0]?.detail, '9 residents');
  check('one resident reads singular', rows[2]?.detail, '1 resident');
  check(
    'an addressless department is flagged',
    describeDepartmentRows([department({ has_recipient: false })])[0]?.warning,
    true,
  );
  check('an addressable department is not flagged', rows[0]?.warning, false);
  check('a null list is empty', describeDepartmentRows(null).length, 0);
  check(
    'ties fall back to the name',
    describeDepartmentRows([
      department({ department_name: 'Zeta', resident_count: 2 }),
      department({ department_name: 'Alpha', resident_count: 2 }),
    ]).map((row) => row.label),
    ['Alpha', 'Zeta'],
  );
}

console.log('\n-- resident rows --');
{
  const rows = describeResidentRows([
    { resident_id: 1, resident_name: 'A', pgy_level: 'PGY-3', assignment_count: 1 },
    { resident_id: 2, resident_name: 'B', pgy_level: 'PGY-3', assignment_count: 2 },
  ]);
  check('a single assignment shows the level alone', rows[0]?.detail, 'PGY-3');
  check('a split block says how many letters', rows[1]?.detail, 'PGY-3 · 2 assignments');
  check(
    'a missing level is stated, not blank',
    describeResidentRows([{ resident_id: 3, resident_name: 'C', pgy_level: null, assignment_count: 1 }])[0]
      ?.detail,
    'PGY level not recorded',
  );
  check('a null list is empty', describeResidentRows(null).length, 0);
}

console.log('\n-- outcome line --');
{
  const base = {
    template_code: 'STANDARD-ROTATION-NOTICE',
    dispatch_type: 'FINALIZED_MASTER_GRID',
    letters_sent: 40,
    letters_without_recipient: 0,
    residents_notified: 18,
    departments: [],
    skipped: [],
  } as unknown as RotationNoticeDispatchResult;

  check(
    'both groups are reported',
    describeDispatchOutcome({ ...base, send_to_coordinators: true, notify_residents: true }),
    '40 letters stored for 0 departments; 18 residents notified.',
  );
  check(
    'only departments',
    describeDispatchOutcome({ ...base, send_to_coordinators: true, notify_residents: false }),
    '40 letters stored for 0 departments.',
  );
  check(
    'only residents',
    describeDispatchOutcome({ ...base, send_to_coordinators: false, notify_residents: true }),
    '18 residents notified.',
  );
  check(
    'one letter reads singular',
    describeDispatchOutcome({
      ...base,
      send_to_coordinators: true,
      notify_residents: false,
      letters_sent: 1,
    }),
    '1 letter stored for 0 departments.',
  );
  check(
    'neither group says nothing was sent',
    describeDispatchOutcome({ ...base, send_to_coordinators: false, notify_residents: false }),
    'Nothing was sent.',
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${passed} notice-dispatch checks passed.`);
