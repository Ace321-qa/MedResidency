/**
 * Verifier: block-scoped occupancy for the Master Rotation Grid capacity engine.
 *
 * The invariant under test is the one the capacity engine promises: a placement
 * into one block is counted against *that block's* date window alone. A prior
 * block whose assignments ended before the target block began must never be
 * summed into the target block's seat count, and duplicate rows a single
 * resident holds in the same window must count as one person.
 *
 * Everything runs inside one transaction that is always rolled back in
 * `finally`, so nothing is committed to the shared database. The scenario is
 * written from a clean state (the rotation's rows in the two blocks are
 * deleted within the transaction, then re-seeded) and the original rows are
 * restored by the rollback.
 *
 *   Block 5 (2026-10-18..2026-11-14): 3 residents on IM-WARDS (capacity 3)
 *   Block 6 (2026-11-15..2026-12-12): 1 resident on IM-WARDS
 *   Then: preview another resident for Block 6 -> must read 1/3, GREEN.
 *
 * The cell counter, the modal's dropdown chip and the over-capacity banner are
 * all covered: the first two read `rotation_block_occupancy`, whose SQL this
 * file runs verbatim against the same snapshot, and the banner reads the
 * `checkPlacement` verdict the server hands the app.
 */
const db = require('../src/config/db');
const { checkPlacement } = require('../src/services/rotationCapacityService');
const { capacityOptionLabel, isAtCapacity } = require('../mobile/src/utils/capacityRules');

const ROTATION = 5; // IM-WARDS, max_capacity 3
const BLOCK5 = { id: 8, start: '2026-10-18', end: '2026-11-14' };
const BLOCK6 = { id: 9, start: '2026-11-15', end: '2026-12-12' };

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}  (actual ${JSON.stringify(actual)})`);
  if (ok) passed += 1;
  else failures.push(name);
}

/** The distinct-resident count the grid's cell tag and modal chip read. */
const OCC_SQL = `
  SELECT COUNT(DISTINCT occ_rra.resident_id) AS occ
    FROM resident_rotation_assignments occ_rra
   WHERE occ_rra.rotation_id = ?
     AND occ_rra.start_date <= ?
     AND occ_rra.end_date >= ?`;

async function main() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Start from the directive's clean state: no IM-WARDS rows in either block.
    await conn.query(
      'DELETE FROM resident_rotation_assignments WHERE rotation_id = ? AND rotation_block_id IN (?, ?)',
      [ROTATION, BLOCK5.id, BLOCK6.id],
    );

    const seed = async (residentId, block) => {
      const [res] = await conn.query(
        `INSERT INTO resident_rotation_assignments
           (resident_id, rotation_id, rotation_block_id, start_date, end_date, assignment_type)
         VALUES (?, ?, ?, ?, ?, 'FULL_BLOCK')`,
        [residentId, ROTATION, block.id, block.start, block.end],
      );
      return res.insertId;
    };

    // Block 5: three residents. Block 6: one resident.
    await seed(244, BLOCK5);
    await seed(247, BLOCK5);
    await seed(248, BLOCK5);
    await seed(249, BLOCK6);

    console.log('-- Block cell counters (the SQL the grid tag/modal chip read) --');
    const [[b6]] = await conn.query(OCC_SQL, [ROTATION, BLOCK6.end, BLOCK6.start]);
    const [[b5]] = await conn.query(OCC_SQL, [ROTATION, BLOCK5.end, BLOCK5.start]);
    check('Block 6 seat count is 1', Number(b6.occ), 1);
    check('Block 5 seat count is 3', Number(b5.occ), 3);
    check('the Block 6 chip reads 1/3', capacityOptionLabel('Internal Medicine Inpatient Wards', 3, Number(b6.occ)), 'Internal Medicine Inpatient Wards (1/3)');
    check('the Block 6 chip is not FULL', isAtCapacity(3, Number(b6.occ)), false);

    console.log('\n-- preview another resident for Block 6 --');
    const b6Preview = await checkPlacement(conn, {
      rotation_id: ROTATION,
      program_id: 1,
      resident_id: 999,
      proposal: { start_date: BLOCK6.start, end_date: BLOCK6.end },
    });
    check('status is GREEN', b6Preview.result.status, 'GREEN');
    check('peak is 2 (the one Block 6 resident + the proposal)', b6Preview.result.peak, 2);
    check('capacity is 3', b6Preview.result.capacity, 3);
    check('every Block 6 week counts 2', b6Preview.result.weeks.map((w) => w.count), [2, 2, 2, 2]);
    check('no Block 5 week appears in the verdict', b6Preview.result.weeks.map((w) => w.week_start), [
      '2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06',
    ]);
    check('no exception required', b6Preview.result.requires_exception, false);

    console.log('\n-- preview another resident for Block 5 (the full block) --');
    const b5Preview = await checkPlacement(conn, {
      rotation_id: ROTATION,
      program_id: 1,
      resident_id: 998,
      proposal: { start_date: BLOCK5.start, end_date: BLOCK5.end },
    });
    check('status is RED', b5Preview.result.status, 'RED');
    check('peak is 4 (three Block 5 residents + the proposal)', b5Preview.result.peak, 4);

    console.log('\n-- duplicate rows in Block 6 count as one person --');
    await seed(1, BLOCK6);
    await seed(1, BLOCK6);
    await seed(1, BLOCK6);
    const [[b6dup]] = await conn.query(OCC_SQL, [ROTATION, BLOCK6.end, BLOCK6.start]);
    check('Block 6 seat count stays 2 after duplicate rows', Number(b6dup.occ), 2);
    const dupPreview = await checkPlacement(conn, {
      rotation_id: ROTATION,
      program_id: 1,
      resident_id: 997,
      proposal: { start_date: BLOCK6.start, end_date: BLOCK6.end },
    });
    check('preview peak is 3, not 5', dupPreview.result.peak, 3);

    console.log('\n-- a proposal window that spills across both blocks counts each week on its own --');
    // A mis-aligned window starting inside Block 5 and running into Block 6.
    const spill = await checkPlacement(conn, {
      rotation_id: ROTATION,
      program_id: 1,
      resident_id: 996,
      proposal: { start_date: '2026-11-08', end_date: '2026-11-21' },
    });
    // Week 11-08 holds the three Block 5 residents + the proposal; the weeks
    // from 11-15 hold Block 6's two. The peak is the busiest single week, not
    // the sum of both blocks.
    check('peak is 4 (the Block 5 week the window actually overlaps)', spill.result.peak, 4);
    check('the window spans four weeks', spill.result.weeks.length, 4);
  } finally {
    await conn.rollback();
    conn.release();
  }

  console.log(`\n${failures.length === 0 ? `All ${passed} checks passed.` : `${failures.length} FAILED: ${failures.join('; ')}`}`);
  await db.end();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await db.end().catch(() => {});
  process.exit(1);
});
