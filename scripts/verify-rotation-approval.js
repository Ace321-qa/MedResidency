/**
 * Checks the bridge from the Request Queue to the rota.
 *
 *     node scripts/verify-rotation-approval.js
 *
 * The bug this guards against is a queue and a rota that disagree: a request
 * flipped to APPROVED while `resident_rotation_assignments` stayed empty, so the
 * Master Rotation Grid kept the resident in the unassigned `+ Assign` cell. The
 * contract under test is therefore not "a function ran" but "an approved request
 * leaves exactly the row the grid reads" — the right block, the right rotation,
 * a window inside that block, and no duplicate on a second approval.
 *
 * The block half of that contract is the subtle one. A request carries a date
 * window and the window routinely straddles two rows of `rotation_blocks`; the
 * fixtures below reproduce the production shape — a request for 18 Oct – 14 Nov
 * that overlaps the stored Block 4 by seven days and the stored Block 5 by
 * twenty-one — so a regression to "the block holding the first day" is caught.
 *
 * The connection is a stub. `syncApprovedRequest` takes its connection as an
 * argument precisely so this file needs no MySQL server, and a test that
 * required one would not have been run.
 */

const assert = require('assert');

const RotationApprovalService = require('../src/services/rotationApprovalService');
const { diffDays } = require('../src/utils/blockDates');
const { MASTER_GRID_START, blockWindow } = require('../src/utils/masterGridCalendar');

/**
 * A stub of the mysql2 `query` surface: every read is answered from `state`,
 * every write is recorded on `conn.writes` so a test can assert on the exact
 * statement and parameters.
 */
function makeConn(state = {}) {
  const writes = [];
  const conn = {
    writes,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (/FROM residents/i.test(text)) {
        return [state.residentExists === false ? [] : [{ id: params[0] }], []];
      }

      if (/FROM residency_enrollments/i.test(text)) {
        return [state.enrollmentProgramId ? [{ program_id: state.enrollmentProgramId }] : [], []];
      }

      if (/FROM rotation_blocks/i.test(text)) {
        if (/overlap_days/i.test(text)) {
          const [qEnd, qStart, programId] = params;
          const overlap = (block) => {
            const from = block.start_date_iso > qStart ? block.start_date_iso : qStart;
            const to = block.end_date_iso < qEnd ? block.end_date_iso : qEnd;
            const days = diffDays(from, to);
            return days === null ? 0 : days + 1;
          };
          const candidates = (state.blocks ?? [])
            .filter(
              (block) =>
                block.program_id === programId &&
                block.start_date_iso <= qEnd &&
                block.end_date_iso >= qStart,
            )
            .sort(
              (a, b) =>
                overlap(b) - overlap(a) ||
                (b.is_active ?? 0) - (a.is_active ?? 0) ||
                a.block_number - b.block_number,
            );
          return [candidates.slice(0, 1), []];
        }

        const [programId, blockNumber] = params;
        const block = (state.blocks ?? []).find(
          (candidate) => candidate.program_id === programId && candidate.block_number === blockNumber,
        );
        return [block ? [block] : [], []];
      }

      if (/FROM rotations/i.test(text)) {
        if (/^SELECT rotation_code/i.test(text)) {
          return [(state.rotations ?? []).map((row) => ({ rotation_code: row.rotation_code })), []];
        }
        return [state.rotations ?? [], []];
      }

      if (/FROM resident_rotation_assignments/i.test(text) && /SELECT id/i.test(text)) {
        return [state.existingAssignment ? [{ id: state.existingAssignment.id }] : [], []];
      }

      if (/^INSERT INTO rotation_blocks/i.test(text)) {
        writes.push({ op: 'insertBlock', sql: text, params });
        return [{ insertId: state.nextBlockId ?? 900 }, []];
      }

      if (/^INSERT INTO rotations/i.test(text)) {
        writes.push({ op: 'insertRotation', sql: text, params });
        return [{ insertId: state.nextRotationId ?? 77 }, []];
      }

      if (/^INSERT INTO resident_rotation_assignments/i.test(text)) {
        writes.push({ op: 'insertAssignment', sql: text, params });
        return [{ insertId: state.nextAssignmentId ?? 500 }, []];
      }

      if (/^UPDATE resident_rotation_assignments/i.test(text)) {
        writes.push({ op: 'updateAssignment', sql: text, params });
        return [{ affectedRows: 1 }, []];
      }

      throw new Error(`unstubbed SQL: ${text}`);
    },
  };
  return conn;
}

/**
 * The production shape for 2026/2027: Block 5 is stored a week adrift of the
 * grid (25 Oct – 19 Nov) while the app draws it as 18 Oct – 14 Nov, which is
 * exactly the ambiguity the overlap rule has to survive.
 */
const BLOCK_FOUR = {
  id: 4,
  program_id: 1,
  block_number: 4,
  block_name: 'Block 4',
  is_active: 1,
  start_date_iso: '2026-09-27',
  end_date_iso: '2026-10-24',
};

const BLOCK_FIVE = {
  id: 8,
  program_id: 1,
  block_number: 5,
  block_name: 'Block 5',
  is_active: 1,
  start_date_iso: '2026-10-25',
  end_date_iso: '2026-11-19',
};

const INTERNAL_MEDICINE = {
  id: 31,
  rotation_code: 'IM-WARDS',
  rotation_name: 'Internal Medicine',
  department_name: 'Internal Medicine',
};

function request(overrides = {}) {
  return {
    resident_id: 254,
    program_id: 1,
    request_type: 'HOSPITAL',
    department_clinic: 'Internal Medicine',
    start_date: '2026-10-18',
    end_date: '2026-11-14',
    ...overrides,
  };
}

function fixture(overrides = {}) {
  return { blocks: [BLOCK_FOUR, BLOCK_FIVE], rotations: [INTERNAL_MEDICINE], ...overrides };
}

const checks = [];
function check(name, assertion) {
  checks.push({ name, assertion });
}

async function expectRejection(fn, statusCode, pattern, label) {
  let thrown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  check(`${label}: rejects with ${statusCode}`, () => {
    assert.ok(thrown, 'expected the call to be rejected');
    assert.strictEqual(thrown.statusCode, statusCode);
    assert.match(thrown.message, pattern);
  });
}

async function main() {
  console.log('\n-- a request that straddles two blocks lands in the block it overlaps most --');
  {
    const conn = makeConn(fixture());
    const result = await RotationApprovalService.syncApprovedRequest(conn, request());
    check('picks Block 5, not the Block 4 that holds the first day', () => {
      assert.strictEqual(result.rotation_block_id, BLOCK_FIVE.id);
      assert.strictEqual(result.block_number, 5);
    });
    check('preserves the resident window 18 Oct – 14 Nov', () => {
      assert.strictEqual(result.start_date, '2026-10-18');
      assert.strictEqual(result.end_date, '2026-11-14');
    });
    check('records the four weeks the grid will draw', () => {
      assert.strictEqual(result.assigned_weeks, 4);
      assert.strictEqual(result.assignment_type, 'FULL_BLOCK');
    });
    check('names the rotation from the catalogue', () => {
      assert.strictEqual(result.rotation_id, INTERNAL_MEDICINE.id);
      assert.strictEqual(result.rotation_name, 'Internal Medicine');
      assert.strictEqual(result.catalogued_rotation, false);
    });
    check('inserts one assignment row', () => {
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertAssignment').length, 1);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'updateAssignment').length, 0);
    });
  }

  console.log('\n-- a window that overruns its block is clamped to it --');
  {
    const conn = makeConn(fixture());
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ start_date: '2026-11-01', end_date: '2026-12-31' }),
    );
    check('keeps the resident start and stops at the block end', () => {
      assert.strictEqual(result.start_date, '2026-11-01');
      assert.strictEqual(result.end_date, '2026-11-14');
      assert.strictEqual(result.assignment_type, 'PARTIAL_BLOCK');
    });
  }

  console.log('\n-- the rotation name is matched the way the importer matches it --');
  for (const [typed, why] of [
    ['  internal-medicine ', 'punctuation and case'],
    ['InternalMedicine', 'the space-less key'],
    ['internal medicine inpatient war', 'a prefix the contains-fallback can reach'],
  ]) {
    const conn = makeConn(fixture());
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ department_clinic: typed }),
    );
    check(`"${typed}" finds the catalogue row (${why})`, () => {
      assert.strictEqual(result.rotation_id, INTERNAL_MEDICINE.id);
      assert.strictEqual(result.catalogued_rotation, false);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertRotation').length, 0);
    });
  }

  console.log('\n-- a name the catalogue does not hold is catalogued once, not dropped --');
  {
    const conn = makeConn(fixture({ rotations: [], nextRotationId: 91 }));
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ department_clinic: 'Rheumatology' }),
    );
    check('inserts the rotation with the upper-cased name as its code', () => {
      const inserts = conn.writes.filter((w) => w.op === 'insertRotation');
      assert.strictEqual(inserts.length, 1);
      assert.strictEqual(inserts[0].params[1], 'RHEUMATOLOGY');
      assert.strictEqual(inserts[0].params[2], 'Rheumatology');
    });
    check('and points the assignment at it', () => {
      assert.strictEqual(result.rotation_id, 91);
      assert.strictEqual(result.rotation_name, 'Rheumatology');
      assert.strictEqual(result.catalogued_rotation, true);
    });
  }

  console.log('\n-- the queue picks the same catalogue row the importer would --');
  {
    const wards = {
      id: 5,
      rotation_code: 'IM-WARDS',
      rotation_name: 'Internal Medicine Inpatient Wards',
      department_name: 'Internal Medicine',
    };
    const conn = makeConn(fixture({ rotations: [wards] }));
    const result = await RotationApprovalService.syncApprovedRequest(conn, request());
    check('"Internal Medicine" joins the wards row instead of cataloguing a rival', () => {
      assert.strictEqual(result.rotation_id, 5);
      assert.strictEqual(result.rotation_name, 'Internal Medicine Inpatient Wards');
      assert.strictEqual(result.catalogued_rotation, false);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertRotation').length, 0);
    });
  }

  console.log('\n-- a malformed request is refused before anything is written --');
  {
    const noResident = makeConn(fixture({ residentExists: false }));
    await expectRejection(
      () => RotationApprovalService.syncApprovedRequest(noResident, request()),
      400,
      /not in the resident register/i,
      'an unknown resident',
    );

    const noWindow = makeConn(fixture());
    await expectRejection(
      () => RotationApprovalService.syncApprovedRequest(noWindow, request({ end_date: '2026-10-01' })),
      400,
      /valid date window/i,
      'an inverted window',
    );

    const noProgramme = makeConn({ blocks: [BLOCK_FIVE], rotations: [INTERNAL_MEDICINE] });
    await expectRejection(
      () => RotationApprovalService.syncApprovedRequest(noProgramme, request({ program_id: 0 })),
      400,
      /tied to a programme/i,
      'a request with no programme',
    );

    for (const conn of [noResident, noWindow, noProgramme]) {
      check('and writes no assignment', () => {
        assert.strictEqual(
          conn.writes.filter((w) => w.op === 'insertAssignment' || w.op === 'updateAssignment').length,
          0,
        );
      });
    }
  }

  console.log('\n-- an in-grid request whose calendar row is missing has the block drawn --');
  {
    const conn = makeConn({ blocks: [], rotations: [INTERNAL_MEDICINE], nextBlockId: 930 });
    const result = await RotationApprovalService.syncApprovedRequest(conn, request());
    check('creates the canonical Block 5 row', () => {
      const inserts = conn.writes.filter((w) => w.op === 'insertBlock');
      assert.strictEqual(inserts.length, 1);
      const window = blockWindow(5, MASTER_GRID_START);
      assert.strictEqual(inserts[0].params[2], 5);
      assert.strictEqual(inserts[0].params[3], 'Block 5');
      assert.strictEqual(inserts[0].params[4], window.start);
      assert.strictEqual(inserts[0].params[5], window.end);
    });
    check('and writes the assignment against it', () => {
      assert.strictEqual(result.rotation_block_id, 930);
      assert.strictEqual(result.block_number, 5);
      assert.strictEqual(result.start_date, '2026-10-18');
      assert.strictEqual(result.end_date, '2026-11-14');
    });
  }

  console.log('\n-- a request outside the academic calendar is refused with a sentence to act on --');
  {
    const conn = makeConn({ blocks: [], rotations: [INTERNAL_MEDICINE] });
    await expectRejection(
      () =>
        RotationApprovalService.syncApprovedRequest(
          conn,
          request({ start_date: '2025-01-06', end_date: '2025-02-02' }),
        ),
      400,
      /outside the 13-block academic calendar/i,
      'a date before the grid',
    );
    check('and draws no block', () => {
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertBlock').length, 0);
    });
  }

  console.log('\n-- approving the same request twice rewrites the same row --');
  {
    const conn = makeConn(fixture({ existingAssignment: { id: 500 } }));
    const result = await RotationApprovalService.syncApprovedRequest(conn, request());
    check('the existing row is updated, not duplicated', () => {
      assert.strictEqual(result.created, false);
      assert.strictEqual(result.assignment_id, 500);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertAssignment').length, 0);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'updateAssignment').length, 1);
    });
    check('the update targets the found row', () => {
      const update = conn.writes.find((w) => w.op === 'updateAssignment');
      assert.strictEqual(update.params.at(-1), 500);
    });
  }

  console.log('\n-- a request with no programme falls back to the enrolment --');
  {
    const conn = makeConn(fixture({ enrollmentProgramId: 1 }));
    const result = await RotationApprovalService.syncApprovedRequest(conn, request({ program_id: 0 }));
    check('the enrolment programme is used', () => {
      assert.strictEqual(result.rotation_block_id, BLOCK_FIVE.id);
    });
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
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} rotation-approval checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
