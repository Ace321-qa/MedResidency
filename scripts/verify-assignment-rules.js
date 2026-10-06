/**
 * Checks the assignment rules that only exist in a service method.
 *
 *     node scripts/verify-assignment-rules.js
 *
 * `assignResidentToRotation` is the one place a rotation is bound to a block, so
 * it is the one place where a bad window silently corrupts the cohort master
 * grid: the grid draws its columns from the *block's* dates, so an assignment
 * outside the block is accepted by the database and then rendered in the wrong
 * column. MySQL cannot catch that — the foreign key is on the block id, not on
 * the dates — which is why the containment check exists and why it needs a test
 * of its own.
 *
 * The rule is deliberately narrower than "must match the block". Half-block
 * rotations are a normal thing to schedule, so only a window that *overruns* the
 * block is rejected. Testing the boundary from both sides is the point: an
 * off-by-one here would reject every valid final day of a block.
 *
 * The database is stubbed. Nothing here needs a live MySQL server, and a test
 * that required one would not have been run.
 */

const assert = require('assert');

/* ------------------------------------------------------------------ *
 * Stub the pool before the service requires it.
 * ------------------------------------------------------------------ */

const queryLog = [];
const stubResults = [];

/** The block every case resolves to, unless a case overrides it. */
const DEFAULT_BLOCK = {
  id: 7,
  block_name: 'Block 3',
  start_date_iso: '2026-07-05',
  end_date_iso: '2026-08-01',
};

let blockToReturn = DEFAULT_BLOCK;

const dbStub = {
  async query(sql, params) {
    queryLog.push({ sql, params });
    // mysql2 resolves to `[rows, fields]`, and every read in this service takes
    // `rows[0]` — a single row for a by-id lookup. A double-wrapped fixture would
    // silently return an array where the service expects an object, which is the
    // kind of stub bug that makes a test pass while proving nothing.
    if (/^\s*SELECT/i.test(sql)) {
      const block = blockToReturn;
      return block ? [[block], []] : [[], []];
    }
    return [{ insertId: 999 }, []];
  },
  async execute(sql, params) {
    return dbStub.query(sql, params);
  },
};

require.cache[require.resolve('../src/config/db')] = {
  id: require.resolve('../src/config/db'),
  filename: require.resolve('../src/config/db'),
  loaded: true,
  exports: dbStub,
};

const RotationService = require('../src/services/rotationService');

/* ------------------------------------------------------------------ *
 * The assertions.
 * ------------------------------------------------------------------ */

const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${label}`);
    console.log(`        ${error.message}`);
    failures.push(label);
    return false;
  }
}

/** Statements actually issued, so "writes nothing" means no INSERT, not no query. */
function inserts() {
  return queryLog.filter((entry) => /^\s*INSERT/i.test(entry.sql));
}

/**
 * Assert the service refuses the assignment with a 4xx and a containment message.
 *
 * Returns true when it was rejected. The success case is asserted separately so a
 * rejection that never happens shows up as one clear failure rather than being
 * swallowed by a `catch` that cannot tell a rejection from its own sentinel.
 */
async function expectRejected(label, payload) {
  let rejected = false;

  try {
    await RotationService.assignResidentToRotation(payload);
  } catch (error) {
    rejected = true;
    check(`${label} (is a 400)`, () => {
      assert.strictEqual(error.statusCode, 400, `expected statusCode 400, got ${error.statusCode}`);
    });
    check(`${label} (explains the overrun)`, () => {
      assert.ok(/fall outside/i.test(error.message), `expected a containment message, got: ${error.message}`);
    });
  }

  check(label, () => assert.ok(rejected, 'expected the assignment to be rejected, but it was accepted'));
  return rejected;
}

function baseAssignment(overrides = {}) {
  return {
    resident_id: 42,
    rotation_id: 3,
    rotation_block_id: 7,
    start_date: '2026-07-05',
    end_date: '2026-08-01',
    assigned_weeks: 4,
    assignment_type: 'FULL_BLOCK',
    notes: null,
    ...overrides,
  };
}

async function main() {
  console.log('\n-- a window inside the block is accepted --');

  {
    const before = inserts().length;
    const result = await RotationService.assignResidentToRotation(baseAssignment());
    check('a full-block window is accepted', () => {
      assert.ok(result, 'expected a result');
      assert.strictEqual(result.assignment_id, 999);
    });
    check('exactly one row is inserted', () => {
      assert.strictEqual(inserts().length - before, 1);
      assert.match(inserts().at(-1).sql, /INSERT INTO resident_rotation_assignments/i);
    });
  }

  {
    // A half-block posting inside the window is normal scheduling and must not be
    // rejected. The narrowness of the rule is deliberate.
    await RotationService.assignResidentToRotation(
      baseAssignment({ start_date: '2026-07-05', end_date: '2026-07-18', assigned_weeks: 2 }),
    );
    check('a half-block window is accepted', () => assert.ok(true));
  }

  {
    // A single-day posting on the block's first day is the tightest legal case.
    await RotationService.assignResidentToRotation(
      baseAssignment({ start_date: '2026-07-05', end_date: '2026-07-05', assigned_weeks: 0.14 }),
    );
    check('a single-day window on the first day is accepted', () => assert.ok(true));
  }

  console.log('\n-- a window overrunning the block is rejected --');

  await expectRejected('a start one day before the block', baseAssignment({
    start_date: '2026-07-04',
    end_date: '2026-08-01',
  }));

  await expectRejected('an end one day after the block', baseAssignment({
    start_date: '2026-07-05',
    end_date: '2026-08-02',
  }));

  await expectRejected('a window entirely after the block', baseAssignment({
    start_date: '2026-08-02',
    end_date: '2026-08-29',
  }));

  await expectRejected('a window entirely before the block', baseAssignment({
    start_date: '2026-06-07',
    end_date: '2026-07-04',
  }));

  await expectRejected('a window spanning the whole year', baseAssignment({
    start_date: '2026-01-01',
    end_date: '2026-12-31',
  }));

  console.log('\n-- the boundaries themselves are inclusive --');

  {
    // Regression guard for the off-by-one. 2026-08-01 is a Saturday and the last
    // day of the block, so this must be accepted; 08-02 is the naive `weeks * 7`
    // answer that must be rejected.
    await RotationService.assignResidentToRotation(
      baseAssignment({ start_date: '2026-07-05', end_date: '2026-08-01' }),
    );
    check('the final day of the block is inside it', () => assert.ok(true));
  }

  {
    const before = inserts().length;
    await expectRejected('the day after the final day is outside it', baseAssignment({
      start_date: '2026-07-05',
      end_date: '2026-08-02',
    }));
    check('a rejected assignment writes nothing', () => {
      assert.strictEqual(inserts().length, before, 'expected no INSERT to be issued');
    });
  }

  console.log('\n-- assigned_weeks is derived when not supplied --');

  {
    const result = await RotationService.assignResidentToRotation(
      baseAssignment({ start_date: '2026-07-05', end_date: '2026-07-18', assigned_weeks: undefined }),
    );
    check('two weeks are derived from the dates', () => {
      assert.strictEqual(result.assigned_weeks, 2);
    });
  }

  {
    // Inclusive arithmetic: 28 days + 1 is 4 weeks, not 3.86.
    const result = await RotationService.assignResidentToRotation(
      baseAssignment({ start_date: '2026-07-05', end_date: '2026-08-01', assigned_weeks: undefined }),
    );
    check('a full four-week window derives 4, not 3.86', () => {
      assert.strictEqual(result.assigned_weeks, 4);
    });
  }

  {
    const result = await RotationService.assignResidentToRotation(
      baseAssignment({ start_date: '2026-07-06', end_date: '2026-07-12', assigned_weeks: 0 }),
    );
    check('a one-week window derives 1', () => {
      assert.strictEqual(result.assigned_weeks, 1);
    });
  }

  {
    const result = await RotationService.assignResidentToRotation(
      baseAssignment({ assigned_weeks: 4 }),
    );
    check('an explicit week count is not overwritten', () => {
      assert.strictEqual(result.assigned_weeks, 4);
    });
    check('and is the value sent to the database', () => {
      // assigned_weeks is the sixth bound parameter, after the two dates.
      assert.strictEqual(inserts().at(-1).params[5], 4);
    });
  }

  console.log('\n-- a block with no recorded dates --');

  {
    // Production block 5 is malformed. Rather than reject an assignment to it on
    // the strength of dates that do not exist, the check is skipped — the block's
    // own edit screen already warns about the window.
    blockToReturn = { ...DEFAULT_BLOCK, start_date_iso: null, end_date_iso: null };
    await RotationService.assignResidentToRotation(baseAssignment());
    check('an undated block does not reject the assignment', () => assert.ok(true));
    blockToReturn = DEFAULT_BLOCK;
  }

  {
    // A missing block is the database's problem to report via its foreign key,
    // not something to pre-empt with a confusing containment message.
    blockToReturn = null;
    await RotationService.assignResidentToRotation(baseAssignment());
    check('a missing block does not reject the assignment', () => assert.ok(true));
    blockToReturn = DEFAULT_BLOCK;
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll assignment-rule checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
