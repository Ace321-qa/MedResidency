/**
 * End-to-end check that an approved rotation request paints the Master Grid.
 *
 *     node scripts/verify-approval-grid-reflection.js
 *
 * This is the integration counterpart to `verify-rotation-approval.js` (which
 * stubs the database): it runs against the real database and asserts the whole
 * path — the APPROVED row in `rotation_requests`, the backfill that repairs
 * historical approvals, and the exact query behind
 * `GET /api/v1/rotations/assignments/cohort` that the Master Rotation Grid
 * screen reads.
 *
 * The failure it catches is the one a coordinator actually sees: the Request
 * Queue says APPROVED, the resident is named, and the block cell in
 * `/program/master/grid` still says `+ Assign`.
 *
 * Requires the app's `.env` (the same `DB_*` the server uses). Exits non-zero on
 * any failed assertion.
 */

const assert = require('assert');

const db = require('../src/config/db');
const RotationService = require('../src/services/rotationService');
const { backfillApprovedRequests } = require('../src/scripts/backfillApprovedRequests');

const PROGRAM_ID = 1;
const ACADEMIC_YEAR = '2026/2027';
const PGY_LEVEL = 5;

const checks = [];
function check(name, assertion) {
  checks.push({ name, assertion });
}

/** The APPROVED request the coordinator is looking at, with the resident's name. */
async function targetRequest() {
  const [rows] = await db.query(
    `SELECT
        r.request_id,
        r.resident_id,
        r.program_id,
        r.department_clinic,
        DATE_FORMAT(r.start_date, '%Y-%m-%d') AS start_date,
        DATE_FORMAT(r.end_date, '%Y-%m-%d') AS end_date,
        CONCAT(res.first_name, ' ', COALESCE(res.middle_initial, ''), ' ', res.last_name) AS resident_name
       FROM rotation_requests r
       JOIN residents res ON res.id = r.resident_id
      WHERE r.status = 'APPROVED'
        AND r.program_id = ?
        AND res.first_name = 'Yasser'
        AND res.last_name = 'Taylor'
      ORDER BY r.request_id ASC
      LIMIT 1`,
    [PROGRAM_ID],
  );
  return rows[0] ?? null;
}

/** Everyone called Yasser Fahad Taylor in this programme — there are two. */
async function namesakes() {
  const [rows] = await db.query(
    `SELECT DISTINCT re.resident_id
       FROM residency_enrollments re
       JOIN residents r ON r.id = re.resident_id
      WHERE re.program_id = ? AND r.first_name = 'Yasser' AND r.last_name = 'Taylor'
      ORDER BY re.resident_id`,
    [PROGRAM_ID],
  );
  return rows.map((row) => row.resident_id);
}

async function assignmentCount(residentId, blockId) {
  const [[row]] = await db.query(
    'SELECT COUNT(*) AS n FROM resident_rotation_assignments WHERE resident_id = ? AND rotation_block_id = ?',
    [residentId, blockId],
  );
  return row.n;
}

async function main() {
  const request = await targetRequest();
  if (!request) {
    throw new Error('No APPROVED rotation request for Yasser Taylor in programme 1 — nothing to verify.');
  }
  const residentId = request.resident_id;
  console.log(
    `Approved request ${request.request_id}: ${request.resident_name.trim()} (resident ${residentId}), ` +
      `"${request.department_clinic}" ${request.start_date} → ${request.end_date}`,
  );

  // 1. Repair any stranded historical approvals, using the live service.
  const summary = await backfillApprovedRequests({ logger: (line) => console.log(`  backfill: ${line}`) });
  check('the backfill places every APPROVED request without error', () => {
    assert.deepStrictEqual(summary.failures, []);
    assert.ok(summary.processed >= 1, 'expected at least the target request to be processed');
  });

  // 2. Read the Master Grid exactly as the screen does.
  const grid = await RotationService.getCohortGrid({
    academic_year: ACADEMIC_YEAR,
    program_id: PROGRAM_ID,
    pgy_level: PGY_LEVEL,
  });
  console.log(`\nMaster Grid (GET /rotations/assignments/cohort) returned ${grid.length} cells.`);

  const residentCells = grid.filter((row) => row.resident_id === residentId);
  const block5 = residentCells.find((row) => row.block_number === 5);

  check('the grid still returns the resident', () => {
    assert.ok(residentCells.length > 0, 'the resident is missing from the cohort grid');
  });
  check('the grid has a Block 5 column for them', () => {
    assert.ok(block5, 'no Block 5 cell for the resident in the cohort grid');
  });
  check('Block 5 is assigned, not the `+ Assign` placeholder', () => {
    assert.strictEqual(block5.is_assigned, 1, 'Block 5 still reads unassigned');
    assert.ok(block5.rotation_name, 'Block 5 has no rotation_name');
  });
  check('Block 5 names the Internal Medicine rotation', () => {
    const name = String(block5.rotation_name ?? '');
    const code = String(block5.rotation_code ?? '');
    assert.ok(
      name === 'Internal Medicine Inpatient Wards' || code === 'IM-WARDS' || /internal medicine/i.test(name),
      `Block 5 rotation was name="${name}" code="${code}"`,
    );
  });
  check('the assignment covers the requested window', () => {
    assert.ok(
      block5.assignment_start_date_iso <= request.start_date,
      `${block5.assignment_start_date_iso} starts after the request`,
    );
    assert.ok(
      block5.assignment_end_date_iso >= request.end_date,
      `${block5.assignment_end_date_iso} ends before the request`,
    );
  });

  console.log(
    `\nBlock 5 cell → block_id=${block5.block_id} (${block5.block_start_date_iso}..${block5.block_end_date_iso}) ` +
      `is_assigned=${block5.is_assigned} rotation="${block5.rotation_name}" code=${block5.rotation_code} ` +
      `assignment ${block5.assignment_start_date_iso}..${block5.assignment_end_date_iso} ` +
      `(${block5.assigned_weeks}w, ${block5.assignment_type})\n`,
  );

  // 3. Re-running the backfill must not lay a second row over the first.
  const before = await assignmentCount(residentId, block5.block_id);
  await backfillApprovedRequests({ logger: () => {} });
  const after = await assignmentCount(residentId, block5.block_id);
  check('re-running the backfill does not duplicate the cell', () => {
    assert.strictEqual(after, before, `assignment count changed from ${before} to ${after}`);
    assert.strictEqual(after, 1, 'expected exactly one assignment in that cell');
  });

  // 3b. Every APPROVED request now has a rota row — the invariant the whole
  // repair exists for.
  const [[stranded]] = await db.query(
    `SELECT COUNT(*) AS n
       FROM rotation_requests r
      WHERE r.status = 'APPROVED'
        AND NOT EXISTS (
          SELECT 1 FROM resident_rotation_assignments a WHERE a.resident_id = r.resident_id
        )`,
  );
  check('no APPROVED request is left without any assignment at all', () => {
    assert.strictEqual(Number(stranded.n), 0, `${stranded.n} approved request(s) have no assignment`);
  });

  // 4. Report the lookalike, so a coordinator chasing the wrong row knows why it
  // still says `+ Assign`: matching by name would have painted the wrong person.
  const twins = await namesakes();
  for (const id of twins) {
    const cell = grid.find((row) => row.resident_id === id && row.block_number === 5);
    const owns = id === residentId ? 'owns the request' : 'has no request';
    console.log(
      `resident ${id} (${owns}): Block 5 ${cell && cell.is_assigned === 1 ? `= ${cell.rotation_name}` : '= + Assign'}`,
    );
  }

  let failed = 0;
  for (const { name, assertion } of checks) {
    try {
      assertion();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${checks.length} checks failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${checks.length} approval→grid reflection checks passed.`);
  }

  await db.end();
}

main().catch((error) => {
  console.error(error);
  db.end().catch(() => {});
  process.exit(1);
});
