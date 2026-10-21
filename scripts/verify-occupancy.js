/**
 * Checks the weekly occupancy engine.
 *
 *     node scripts/verify-occupancy.js
 *
 * The bug this guards against is subtle and expensive: a seat limit enforced
 * against *postings* instead of *weeks*. Two residents on adjacent four-week
 * blocks share no week, and a resident on weeks 1–2 followed by one on weeks 3–4
 * is a hand-over, not a conflict — a range-overlap test rejects both, and every
 * rejection looks like a correct "capacity" decision from the outside.
 *
 * So the fixtures below are built around the week, not the range, and the
 * adjacency case is asserted explicitly.
 *
 * The database is not involved: this is a pure module, which is the point.
 */

const assert = require('assert');

const {
  classifyOccupancy,
  describeOccupancy,
  evaluateOccupancy,
  isFiniteCapacity,
  weekStartOf,
  weeksForWindow,
  normalizeWeekday,
} = require('../src/utils/occupancy');

const failures = [];
let passed = 0;

function check(name, actual, expected) {
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

/** A window helper so the fixtures read as dates rather than object literals. */
function window(start, end, extra = {}) {
  return { start_date: start, end_date: end, ...extra };
}

/**
 * A resident's posting, the way the loader hands them over.
 *
 * Every fixture now names its resident, because that is what the engine counts.
 * A fixture without one still works — the row id keeps it distinct — but it
 * would no longer be describing people, which is the whole subject here.
 */
function posting(start, end, residentId, extra = {}) {
  return { start_date: start, end_date: end, resident_id: residentId, ...extra };
}

/** `n` distinct residents all standing for the same window, ids 9001 upward. */
function cohort(start, end, n) {
  return Array.from({ length: n }, (_, index) => posting(start, end, 9001 + index));
}

/* ------------------------------------------------------------------ *
 * Week arithmetic
 * ------------------------------------------------------------------ */

console.log('-- weeksForWindow: the unit is the week, not the posting --');

check('a Sunday-start 4-week window is four weeks', weeksForWindow('2026-10-18', '2026-11-14', 0), [
  '2026-10-18',
  '2026-10-25',
  '2026-11-01',
  '2026-11-08',
]);
check('a one-day window is one week', weeksForWindow('2026-10-21', '2026-10-21', 0), ['2026-10-18']);
check('a 1-week window is one week', weeksForWindow('2026-10-18', '2026-10-24', 0), ['2026-10-18']);
check('an inverted window yields nothing', weeksForWindow('2026-11-14', '2026-10-18', 0), []);
check('an unreadable window yields nothing', weeksForWindow('nope', '2026-10-18', 0), []);

// Adjacent blocks must not share a week: this is the whole premise.
check(
  'adjacent 4-week blocks share no week',
  weeksForWindow('2026-10-18', '2026-11-14', 0).filter((week) =>
    weeksForWindow('2026-11-15', '2026-12-12', 0).includes(week),
  ),
  [],
);
check(
  'overlapping windows share exactly the overlap',
  weeksForWindow('2026-10-18', '2026-11-14', 0).filter((week) =>
    weeksForWindow('2026-11-08', '2026-12-05', 0).includes(week),
  ),
  ['2026-11-08'],
);

console.log('\n-- the week anchor follows the programme, not Sunday --');
check(
  'a Monday programme anchors weeks on Monday',
  weeksForWindow('2026-10-19', '2026-11-15', 1),
  ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'],
);
check('Sunday belongs to the Monday week that precedes its own', weekStartOf('2026-10-25', 1), '2026-10-19');
check('Saturday belongs to the Sunday week that precedes its own', weekStartOf('2026-10-24', 0), '2026-10-18');
check('a day name is accepted as the anchor', weekStartOf('2026-10-24', 'SUNDAY'), '2026-10-18');
check('an abbreviation is accepted too', weekStartOf('2026-10-25', 'mon'), '2026-10-19');
check('an unknown anchor falls back to Sunday', normalizeWeekday('Blursday'), 0);

/* ------------------------------------------------------------------ *
 * The tier table
 * ------------------------------------------------------------------ */

console.log('\n-- classifyOccupancy: the tier table --');

check('empty proposal against capacity 3', classifyOccupancy(0, 3, 0), 'GREEN');
check('at capacity is green', classifyOccupancy(3, 3, 4), 'GREEN');
check('under capacity is green', classifyOccupancy(2, 3, 4), 'GREEN');
check('1 over for 1 week is amber', classifyOccupancy(4, 3, 1), 'AMBER');
check('1 over for 2 weeks is review', classifyOccupancy(4, 3, 2), 'REVIEW');
check('1 over for 3 weeks is red', classifyOccupancy(4, 3, 3), 'RED');
check('1 over for 4 weeks is red', classifyOccupancy(4, 3, 4), 'RED');
check('2 over for 1 week is red, not amber', classifyOccupancy(5, 3, 1), 'RED');
check('3 over for 1 week is red', classifyOccupancy(6, 3, 1), 'RED');
check('1 over for 1 week is blocked when locked', classifyOccupancy(4, 3, 1, true), 'BLOCKED');
check('2 over is blocked when locked', classifyOccupancy(5, 3, 2, true), 'BLOCKED');
check('at capacity is still green when locked', classifyOccupancy(3, 3, 4, true), 'GREEN');
check('an unlimited rotation is always green', classifyOccupancy(9, null, 4), 'GREEN');
check('capacity 0 means unlimited', classifyOccupancy(9, 0, 4), 'GREEN');
check('a capacity of 1 over by 1 is amber', classifyOccupancy(2, 1, 1), 'AMBER');

console.log('\n-- isFiniteCapacity --');
check('null is unlimited', isFiniteCapacity(null), false);
check('undefined is unlimited', isFiniteCapacity(undefined), false);
check('0 is unlimited', isFiniteCapacity(0), false);
check('a negative is unlimited', isFiniteCapacity(-1), false);
check('a number string is a capacity', isFiniteCapacity('3'), true);
check('a fraction is a capacity', isFiniteCapacity(2.5), true);
check('garbage is unlimited', isFiniteCapacity('lots'), false);

/* ------------------------------------------------------------------ *
 * The full evaluation
 * ------------------------------------------------------------------ */

console.log('\n-- evaluateOccupancy: three residents in, fourth proposed --');

const BLOCK_5 = window('2026-10-18', '2026-11-14');
const BLOCK_6 = window('2026-11-15', '2026-12-12');

// Three residents already on Block 5, capacity 3.
const threeOnBlock5 = cohort('2026-10-18', '2026-11-14', 3);

{
  const result = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-11-14', 9104),
    capacity: 3,
  });
  check('the fixture itself is the 4-resident case', result.peak, 4);
  check('4 residents on Block 5 for 4 weeks is RED', result.status, 'RED');
  check('red needs an exception', result.requires_exception, true);
  check('red is still submittable with one', result.allowed, true);
  check('the overage is 1', result.over_by, 1);
  check('the peak is sustained for 4 weeks', result.sustained_weeks, 4);
  check('every week is reported', result.weeks.length, 4);
  check('the first week counts all four', result.weeks[0].count, 4);
  check('the worst week is the first peak', result.worst_week.week_start, '2026-10-18');
}

console.log('\n-- one week only: the amber case from the brief --');
{
  // Three standing for the whole block; the proposal is a single week.
  const result = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-10-24', 9104),
    capacity: 3,
  });
  check('a single over-capacity week is amber', result.status, 'AMBER');
  check('amber needs a rationale', result.requires_exception, true);
  check('amber is submittable', result.allowed, true);
  check('only one week is at the peak', result.sustained_weeks, 1);
}

console.log('\n-- two weeks: review --');
{
  const result = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-25', '2026-11-07', 9104),
    capacity: 3,
  });
  check('two weeks over is review', result.status, 'REVIEW');
  check('review is submittable', result.allowed, true);
  check('two weeks are at the peak', result.sustained_weeks, 2);
}

console.log('\n-- the fifth resident: two over in every week --');
{
  const result = evaluateOccupancy({
    existing: cohort('2026-10-18', '2026-11-14', 4),
    proposal: posting('2026-10-18', '2026-11-14', 9105),
    capacity: 3,
  });
  check('5 residents against 3 is red', result.status, 'RED');
  check('the overage is 2', result.over_by, 2);
  check('the peak is 5', result.peak, 5);
}

console.log('\n-- duplicate rows for one resident are one person --');
{
  // The phantom overcapacity: a resident whose posting was saved several times,
  // or imported alongside itself. The rows are real, the people are not, and
  // the engine must count the people.
  const duplicated = [
    posting('2026-10-18', '2026-11-14', 9201, { assignment_id: 701 }),
    posting('2026-10-18', '2026-11-14', 9201, { assignment_id: 702 }),
    posting('2026-10-18', '2026-11-14', 9201, { assignment_id: 703 }),
    posting('2026-10-18', '2026-11-14', 9201, { assignment_id: 704 }),
  ];
  const result = evaluateOccupancy({
    existing: duplicated,
    proposal: posting('2026-10-18', '2026-11-14', 9202),
    capacity: 3,
  });
  check('four rows for one resident plus a colleague is two people', result.peak, 2);
  check('so it is green, not red', result.status, 'GREEN');
  check('every week counts two', result.weeks.every((week) => week.count === 2), true);
}
{
  // Re-saving a resident: their own earlier rows must not count against them,
  // whether or not the caller excludes the row being edited.
  const result = evaluateOccupancy({
    existing: [
      posting('2026-10-18', '2026-11-14', 9201, { assignment_id: 801 }),
      posting('2026-10-18', '2026-11-14', 9202),
      posting('2026-10-18', '2026-11-14', 9203),
    ],
    proposal: posting('2026-10-18', '2026-11-14', 9201),
    capacity: 3,
  });
  check('a resident already in the rotation does not count twice', result.peak, 3);
  check('and the re-save is green', result.status, 'GREEN');
}

console.log('\n-- adjacency and hand-over are NOT conflicts --');
{
  const result = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-11-15', '2026-12-12', 9104),
    capacity: 3,
  });
  check('a resident on the next block is green', result.status, 'GREEN');
  check('no exception is needed', result.requires_exception, false);
  check('the peak is one (the proposal alone)', result.peak, 1);
}
{
  // Two residents hold weeks 1-2 each; the proposal takes weeks 3-4.
  const firstHalf = cohort('2026-10-18', '2026-10-31', 2);
  const secondHalf = cohort('2026-11-01', '2026-11-14', 2);
  const result = evaluateOccupancy({
    existing: [...firstHalf, ...secondHalf],
    proposal: posting('2026-11-01', '2026-11-14', 9301),
    capacity: 3,
  });
  check('half-block hand-over is green at capacity 3', result.status, 'GREEN');
  check('the first half is not counted against the second', result.weeks[0].count, 3);
}

console.log('\n-- a proposal into an empty rotation counts itself --');
{
  const result = evaluateOccupancy({
    existing: [],
    proposal: posting('2026-10-18', '2026-11-14', 9104),
    capacity: 3,
  });
  check('one resident alone is green', result.status, 'GREEN');
  check('the count is 1, not 0', result.peak, 1);
  check('every week counts one', result.weeks.every((week) => week.count === 1), true);
}

console.log('\n-- unlimited and locked --');
{
  const unlimited = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-11-14', 9104),
    capacity: null,
  });
  check('unlimited stays green however many', unlimited.status, 'GREEN');
  check('unlimited reports no capacity', unlimited.capacity, null);

  const locked = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-11-14', 9104),
    capacity: 3,
    locked: true,
  });
  check('a locked limit blocks rather than warns', locked.status, 'BLOCKED');
  check('a blocked placement is not allowed', locked.allowed, false);
  check('a blocked placement cannot be excused', locked.requires_exception, false);
}

console.log('\n-- re-saving an assignment does not count it against itself --');
{
  const existing = [
    posting('2026-10-18', '2026-11-14', 9401, { assignment_id: 501 }),
    posting('2026-10-18', '2026-11-14', 9402, { assignment_id: 502 }),
    posting('2026-10-18', '2026-11-14', 9403, { assignment_id: 503 }),
  ];
  // Somebody else joins: four people, one over the limit.
  const naive = evaluateOccupancy({
    existing,
    proposal: posting('2026-10-18', '2026-11-14', 9404),
    capacity: 3,
  });
  check('counting itself makes 4', naive.peak, 4);
  const excluded = evaluateOccupancy({
    existing,
    proposal: posting('2026-10-18', '2026-11-14', 9404, { assignment_id: 504 }),
    capacity: 3,
    excludeAssignmentId: 503,
  });
  check('excluding itself makes 3', excluded.peak, 3);
  check('and is green', excluded.status, 'GREEN');
}

console.log('\n-- an unnamed row is still counted once, not collapsed --');
{
  // An older caller that has not been taught about residents must not have its
  // rows silently merged into one person.
  const result = evaluateOccupancy({
    existing: [
      window('2026-10-18', '2026-11-14', { assignment_id: 601 }),
      window('2026-10-18', '2026-11-14', { assignment_id: 602 }),
      window('2026-10-18', '2026-11-14', { assignment_id: 603 }),
    ],
    proposal: posting('2026-10-18', '2026-11-14', 9501),
    capacity: 3,
  });
  check('three anonymous rows are three people', result.peak, 4);
  check('and the fourth is over the limit', result.status, 'RED');
}

console.log('\n-- unreadable dates degrade to "allowed", never to a crash --');
{
  const result = evaluateOccupancy({ existing: [], proposal: { start_date: '', end_date: '' }, capacity: 3 });
  check('a blank window is green', result.status, 'GREEN');
  check('a blank window is allowed', result.allowed, true);
  check('no weeks are reported', result.weeks.length, 0);
}

console.log('\n-- the message names the shape of the problem --');
{
  const amber = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-10-24', 9104),
    capacity: 3,
  });
  check('amber says temporary and asks for a rationale', /Temporary overcapacity/.test(amber.message), true);
  const red = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-11-14', 9104),
    capacity: 3,
  });
  check('red asks for a lead override', /programme-lead override/.test(red.message), true);
  check('the message carries the numbers', /4 residents against a limit of 3/.test(red.message), true);
  const blocked = evaluateOccupancy({
    existing: threeOnBlock5,
    proposal: posting('2026-10-18', '2026-11-14', 9104),
    capacity: 3,
    locked: true,
  });
  check('blocked says it cannot be made', /cannot be made/.test(blocked.message), true);
}

console.log('\n-- describeOccupancy is total over every status --');
{
  for (const status of ['GREEN', 'AMBER', 'REVIEW', 'RED', 'BLOCKED']) {
    const text = describeOccupancy(status, 4, 3, 2, [{ week_start: '2026-10-18' }]);
    check(`${status} describes itself`, typeof text === 'string' && text.length > 0, true);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${passed} occupancy checks passed.`);
