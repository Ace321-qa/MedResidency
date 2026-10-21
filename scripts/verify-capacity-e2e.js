/**
 * End-to-end check of the departmental seat-limit feature.
 *
 *     node scripts/verify-capacity-e2e.js
 *
 * Requires the API to be running (`npm start`) and against the real database.
 *
 * The brief's test matrix is the spine of this file: three residents fit
 * (Green), a fourth for one week is Amber, a fifth is Red. What makes those
 * worth running end-to-end rather than against the engine alone is that the
 * decision has to survive the whole path — the controller, the transaction, the
 * audit table, and the cohort query the grid reads — and that the *hospital
 * rota is left untouched* throughout. A capacity limit that worked but leaked a
 * fifth resident into the block would pass a unit test and fail a programme.
 *
 * Everything it creates is disposable and removed in `finally`: residents are
 * only ever assigned to a scratch rotation, so a failure mid-run cannot leave a
 * stray posting on a live ward.
 *
 * The last case is the one that would pass without it: eight placements fired at
 * once against a capacity-3 rotation, requiring that exactly three are seated.
 * A read-then-write with no lock satisfies every sequential case above and still
 * admits a fourth resident under a race — which is precisely when a departmental
 * seat limit matters.
 */

const db = require('../src/config/db');

const API = process.env.API_URL || 'http://localhost:5001/api/v1';

let passed = 0;
const failures = [];

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

function checkThat(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function main() {
  // A scratch rotation with capacity 3, and three residents. The rotation is the
  // subject of every case, so nothing here can touch a real department's rota.
  const ABBR = 'ZZ CAP E2E';
  const NAME = 'ZZ Capacity E2E Rotation';

  console.log('-- setup: a scratch rotation with capacity 3 --');

  // Remove anything a previous run left behind, by abbreviation.
  const [stale] = await db.query('SELECT id FROM rotations WHERE rotation_code = ?', [ABBR]);
  for (const row of stale) {
    await db.query('DELETE FROM rotation_capacity_exceptions WHERE rotation_id = ?', [row.id]);
    await db.query('DELETE FROM resident_rotation_assignments WHERE rotation_id = ?', [row.id]);
    await db.query('DELETE FROM rotations WHERE id = ?', [row.id]);
  }

  const created = await api('/rotations/catalogue', {
    method: 'POST',
    body: { program_id: 1, full_name: NAME, department: 'QA', abbreviation: ABBR, max_capacity: 3 },
  });
  check('the scratch rotation is created', created.status, 201);
  const rotationId = created.body.data.id;
  check('the capacity round-trips', created.body.data.max_capacity, 3);

  const [[block]] = await db.query(
    `SELECT id, block_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS s, DATE_FORMAT(end_date, '%Y-%m-%d') AS e
       FROM rotation_blocks WHERE program_id = 1 AND academic_year LIKE '2026%' AND block_number = 1 LIMIT 1`,
  );
  checkThat('a block to test against exists', Boolean(block));
  if (!block) throw new Error('no block to test with');

  const [residents] = await db.query(
    'SELECT id FROM residents ORDER BY id DESC LIMIT 6',
  );
  const [r1, r2, r3, r4, r5] = residents.map((row) => row.id);

  const window = { start: block.s, end: block.e };

  async function assign(residentId, from = window.start, to = window.end, exception = null, blockId = block.id) {
    return api('/rotations/assignments', {
      method: 'POST',
      body: {
        resident_id: residentId,
        rotation_id: rotationId,
        rotation_block_id: blockId,
        start_date: from,
        end_date: to,
        assignment_type: 'PARTIAL_BLOCK',
        ...(exception ?? {}),
      },
    });
  }

  try {
    console.log('\n-- Test 1: three residents fit (Green) --');
    for (const resident of [r1, r2, r3]) {
      const result = await assign(resident);
      checkThat(
        `resident ${resident} is placed`,
        result.status === 201,
        `status ${result.status}: ${JSON.stringify(result.body)}`,
      );
      if (result.status !== 201) throw new Error(`cannot place resident ${resident}`);
      check(`resident ${resident} is green`, result.body.data.capacity.status, 'GREEN');
    }
    // A *fourth distinct* resident is over the limit. Re-placing r1 would not
    // be: a resident already in the rotation is the same person, so counting
    // their row twice would be the phantom overcapacity this engine now avoids.
    const c1 = await assign(r4);
    check('placing a 4th resident is refused without a rationale', c1.status, 409);
    check('and the verdict is not green', c1.body.capacity.status !== 'GREEN', true);

    console.log('\n-- a resident already in the rotation does not count twice --');
    const repl = await assign(r1);
    check('re-placing an existing resident is allowed', repl.status, 201);
    check('and stays green, because it is the same person', repl.body.data.capacity.status, 'GREEN');
    check('the peak is the three distinct residents', repl.body.data.capacity.peak, 3);
    // Remove the row the re-place just added so the rest of the run sees three.
    await db.query(
      'DELETE FROM resident_rotation_assignments WHERE id = ?',
      [repl.body.data.assignment_id],
    );

    console.log('\n-- Test 2: a 4th resident for one week is Amber --');
    const [weekOneStart] = block.s.split('-');
    // One week only: the block's first seven days.
    const day = new Date(`${block.s}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 6);
    const oneWeekEnd = day.toISOString().slice(0, 10);

    const amberDry = await assign(r4, block.s, oneWeekEnd);
    check('a one-week overage is refused without a rationale', amberDry.status, 409);
    check('the tier is AMBER', amberDry.body.capacity.status, 'AMBER');
    check('it names a required rationale', amberDry.body.requires_exception, true);

    const amber = await assign(r4, block.s, oneWeekEnd, {
      exception_reason: 'E2E: clinic hand-over week.',
      exception_approver: 'E2E Program Lead',
      faculty_supervision_confirmed: true,
    });
    check('with a full rationale it is accepted', amber.status, 201);
    check('and the exception is recorded', amber.body.data.exception_recorded, true);
    void weekOneStart;

    const audit = await db.query(
      'SELECT status, capacity, peak_occupancy, reason, approver, faculty_confirmed FROM rotation_capacity_exceptions WHERE rotation_id = ? ORDER BY id DESC LIMIT 1',
      [rotationId],
    );
    check('exactly one audit row exists', audit[0].length, 1);
    check('the audit row keeps the tier', audit[0][0].status, 'AMBER');
    check('the audit row keeps the capacity', audit[0][0].capacity, 3);
    check('the audit row keeps the peak', audit[0][0].peak_occupancy, 4);
    check('the audit row keeps the approver', audit[0][0].approver, 'E2E Program Lead');

    console.log('\n-- Test 3: a 5th resident is Red --');
    const red = await assign(r5, block.s, oneWeekEnd);
    check('the 5th is refused', red.status, 409);
    check('the tier is RED', red.body.capacity.status, 'RED');
    check('it is two over', red.body.capacity.over_by, 2);
    check('the peak is five', red.body.capacity.peak, 5);

    console.log('\n-- the preview endpoint agrees with the write --');
    const preview = await api('/rotations/assignments/check-capacity', {
      method: 'POST',
      body: {
        rotation_id: rotationId,
        program_id: 1,
        // The resident being proposed, so the preview counts people exactly as
        // the write does.
        resident_id: r5,
        start_date: block.s,
        end_date: oneWeekEnd,
      },
    });
    check('the preview succeeds', preview.status, 200);
    check('and returns the same tier the write did', preview.body.data.status, 'RED');
    check('and the same peak', preview.body.data.peak, 5);

    console.log('\n-- a locked limit refuses even with a rationale --');
    await api(`/rotations/catalogue/${rotationId}`, { method: 'PUT', body: { capacity_locked: true } });
    const locked = await assign(r5, block.s, oneWeekEnd, {
      exception_reason: 'E2E: trying anyway.',
      exception_approver: 'E2E Program Lead',
      faculty_supervision_confirmed: true,
    });
    check('a locked limit is refused', locked.status, 409);
    check('the tier is BLOCKED', locked.body.capacity.status, 'BLOCKED');
    check('and no exception is offered', locked.body.capacity.requires_exception, false);
    check('no audit row was written for it',
      (await db.query('SELECT COUNT(*) n FROM rotation_capacity_exceptions WHERE rotation_id = ?', [rotationId]))[0][0].n,
      1);
    await api(`/rotations/catalogue/${rotationId}`, { method: 'PUT', body: { capacity_locked: false } });

    console.log('\n-- the cohort grid carries the capacity, for the cell tag --');
    const grid = await api(`/rotations/assignments/cohort?program_id=1&academic_year=2026-2027`);
    check('the cohort grid loads', grid.status, 200);
    const cells = (grid.body.data ?? []).filter((row) => row.rotation_id === rotationId && row.block_id === block.id);
    checkThat('the scratch rotation appears in the grid', cells.length > 0);
    if (cells.length > 0) {
      check('the cell carries the rotation capacity', cells[0].rotation_max_capacity, 3);
      check('and the block occupancy', cells[0].rotation_block_occupancy, 4);
    }

    console.log('\n-- the boundary is the WEEK, not the range --');
    // The next block starts the day after this one ends: no shared week, so a
    // fifth resident there is green even though the ranges abut.
    const [nextBlockRows] = await db.query(
      `SELECT id, DATE_FORMAT(start_date, '%Y-%m-%d') AS s, DATE_FORMAT(end_date, '%Y-%m-%d') AS e
         FROM rotation_blocks WHERE program_id = 1 AND academic_year LIKE '2026%' AND block_number = 2 LIMIT 1`,
    );
    const nextBlock = nextBlockRows[0];
    if (nextBlock) {
      const next = await assign(r5, nextBlock.s, nextBlock.e, null, nextBlock.id);
      check('the next block is green', next.status, 201);
      if (next.status === 201) {
        check('and reports green', next.body.data.capacity.status, 'GREEN');
        check('and needs no exception', next.body.data.exception_recorded, false);
      }
    }

    // --- Concurrency ---
    //
    // The limit is only worth having if it holds when two coordinators place a
    // resident at the same instant. A read-then-write with no lock passes every
    // sequential test above and still admits a fourth resident under a race, so
    // this is the case that actually pins the guarantee: fire more placements
    // than the limit at once and require that exactly `capacity` succeed.
    console.log('\n-- the limit holds under concurrent placements --');
    const RACE_ABBR = 'ZZ CAP RACE';
    const [staleRace] = await db.query('SELECT id FROM rotations WHERE rotation_code = ?', [RACE_ABBR]);
    for (const row of staleRace) {
      await db.query('DELETE FROM rotation_capacity_exceptions WHERE rotation_id = ?', [row.id]);
      await db.query('DELETE FROM resident_rotation_assignments WHERE rotation_id = ?', [row.id]);
      await db.query('DELETE FROM rotations WHERE id = ?', [row.id]);
    }

    // Capacity 3, and more than three residents arriving together. The scratch
    // rotation is separate so this cannot disturb the state the cases above
    // reason about.
    const raceRotation = await api('/rotations/catalogue', {
      method: 'POST',
      body: { program_id: 1, full_name: 'ZZ Cap Race Rotation', department: 'QA', abbreviation: RACE_ABBR, max_capacity: 3 },
    });
    const raceId = raceRotation.body.data.id;
    const [moreResidents] = await db.query('SELECT id FROM residents ORDER BY id DESC LIMIT 8');
    try {
      const attempts = moreResidents.map((row) =>
        api('/rotations/assignments', {
          method: 'POST',
          body: {
            resident_id: row.id,
            rotation_id: raceId,
            rotation_block_id: block.id,
            start_date: block.s,
            end_date: block.e,
            assignment_type: 'PARTIAL_BLOCK',
          },
        }),
      );
      const results = await Promise.all(attempts);
      const accepted = results.filter((result) => result.status === 201).length;
      const refused = results.filter((result) => result.status === 409).length;
      const [raceRows] = await db.query(
        'SELECT COUNT(*) n FROM resident_rotation_assignments WHERE rotation_id = ?',
        [raceId],
      );
      check('every attempt got a definite answer', accepted + refused, results.length);
      check('exactly the capacity were seated', accepted, 3);
      check('the rest were refused', refused, results.length - 3);
      check('and the table agrees', raceRows[0].n, 3);
      checkThat('no attempt failed with a server error (no deadlock)', results.every((r) => r.status < 500));
    } finally {
      await db.query('DELETE FROM rotation_capacity_exceptions WHERE rotation_id = ?', [raceId]);
      await db.query('DELETE FROM resident_rotation_assignments WHERE rotation_id = ?', [raceId]);
      await db.query('DELETE FROM rotations WHERE id = ?', [raceId]);
    }
  } finally {
    console.log('\n-- cleanup --');
    await db.query('DELETE FROM rotation_capacity_exceptions WHERE rotation_id = ?', [rotationId]);
    await db.query('DELETE FROM resident_rotation_assignments WHERE rotation_id = ?', [rotationId]);
    await db.query('DELETE FROM rotations WHERE id = ?', [rotationId]);
    // The race rotation is cleaned in its own `finally` above, but cover it here
    // too: a throw between its creation and that block would otherwise leave it.
    const [raceLeft] = await db.query('SELECT id FROM rotations WHERE rotation_code = ?', ['ZZ CAP RACE']);
    for (const row of raceLeft) {
      await db.query('DELETE FROM rotation_capacity_exceptions WHERE rotation_id = ?', [row.id]);
      await db.query('DELETE FROM resident_rotation_assignments WHERE rotation_id = ?', [row.id]);
      await db.query('DELETE FROM rotations WHERE id = ?', [row.id]);
    }
    const [left] = await db.query('SELECT COUNT(*) n FROM rotations WHERE rotation_code = ?', [ABBR]);
    check('the scratch rotation is gone', left[0].n, 0);
    const [raceGone] = await db.query('SELECT COUNT(*) n FROM rotations WHERE rotation_code = ?', ['ZZ CAP RACE']);
    check('the race rotation is gone', raceGone[0].n, 0);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`\nAll ${passed} capacity end-to-end checks passed.`);
}

main()
  .then(() => db.end())
  .catch(async (error) => {
    console.error(error);
    await db.end().catch(() => {});
    process.exit(1);
  });
