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
 * The connection is a stub. `syncApprovedRequest` takes its connection as an
 * argument precisely so this file needs no MySQL server, and a test that
 * required one would not have been run.
 */

const assert = require('assert');

const RotationApprovalService = require('../src/services/rotationApprovalService');
const { weeksSpanned } = require('../src/utils/masterGridCalendar');

const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (error) {
    console.log(`FAIL  ${label}`);
    console.log(`        ${error.message}`);
    failures.push(label);
  }
}

/** Collapse whitespace so the SQL can be matched without concerning formatting. */
function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

/**
 * A connection shaped like `mysql2`'s: `query(sql, params)` resolves to
 * `[rows, fields]`. Every read is served from `state`; every write is recorded
 * in `state.writes` so a test can assert on the exact statement and parameters.
 */
function makeConn(state = {}) {
  const writes = [];
  const conn = {
    writes,
    async query(sql, params = []) {
      const text = normalize(sql);

      if (/FROM residency_enrollments/i.test(text)) {
        return [state.enrollmentProgramId ? [{ program_id: state.enrollmentProgramId }] : [], []];
      }

      if (/FROM rotation_blocks/i.test(text)) {
        const [programId, start] = params;
        const block = (state.blocks ?? []).find(
          (candidate) =>
            candidate.program_id === programId &&
            candidate.start_date_iso <= start &&
            candidate.end_date_iso >= start,
        );
        return [block ? [block] : [], []];
      }

      if (/FROM rotations/i.test(text)) {
        if (/SELECT id, rotation_code, rotation_name, department_name/i.test(text)) {
          return [state.rotations ?? [], []];
        }
        if (/SELECT rotation_code/i.test(text)) {
          return [(state.rotations ?? []).map((rotation) => ({ rotation_code: rotation.rotation_code })), []];
        }
      }

      if (/FROM resident_rotation_assignments/i.test(text) && /SELECT id/i.test(text)) {
        return [state.existingAssignment ? [{ id: state.existingAssignment.id }] : [], []];
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

/** Block 6 of the 2026/2027 calendar, as the Master Grid draws it. */
const BLOCK_SIX = {
  id: 106,
  program_id: 4,
  block_number: 6,
  block_name: 'Block 6',
  is_active: 1,
  start_date_iso: '2026-10-18',
  end_date_iso: '2026-11-14',
};

const INTERNAL_MEDICINE = {
  id: 31,
  rotation_code: 'INTERNAL MEDICINE',
  rotation_name: 'Internal Medicine',
  department_name: 'Internal Medicine',
};

function request(overrides = {}) {
  return {
    resident_id: 88,
    program_id: 4,
    request_type: 'HOSPITAL',
    department_clinic: 'Internal Medicine',
    start_date: '2026-10-18',
    end_date: '2026-11-14',
    ...overrides,
  };
}

async function main() {
  console.log('\n-- an approved full-block request becomes one grid row --');

  await (async () => {
    const state = { blocks: [BLOCK_SIX], rotations: [INTERNAL_MEDICINE] };
    const conn = makeConn(state);
    const result = await RotationApprovalService.syncApprovedRequest(conn, request());

    check('the assignment points at the resolved rotation', () => {
      assert.strictEqual(result.rotation_id, INTERNAL_MEDICINE.id);
    });
    check('the assignment lands in Block 6', () => {
      assert.strictEqual(result.rotation_block_id, BLOCK_SIX.id);
      assert.strictEqual(result.block_number, 6);
    });
    check('the window is the block window', () => {
      assert.strictEqual(result.start_date, '2026-10-18');
      assert.strictEqual(result.end_date, '2026-11-14');
    });
    check('a whole-block window is FULL_BLOCK', () => {
      assert.strictEqual(result.assignment_type, 'FULL_BLOCK');
    });
    check('the row is attributed to the queue', () => {
      assert.strictEqual(result.notes, 'Approved via Resident Request Queue');
    });
    check('it is a real insert, not an update', () => {
      assert.strictEqual(result.created, true);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertAssignment').length, 1);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'updateAssignment').length, 0);
    });
    check('exactly one assignment statement is issued', () => {
      const assignmentWrites = conn.writes.filter(
        (w) => w.op === 'insertAssignment' || w.op === 'updateAssignment',
      );
      assert.strictEqual(assignmentWrites.length, 1);
    });
    check('the stored week count matches the window', () => {
      const insert = conn.writes.find((w) => w.op === 'insertAssignment');
      // (resident, rotation, block, start, end, weeks, type, notes)
      assert.strictEqual(insert.params[5], weeksSpanned('2026-10-18', '2026-11-14'));
      assert.strictEqual(insert.params[5], 4);
    });
  })();

  console.log('\n-- the department name resolves case- and punctuation-insensitively --');

  await (async () => {
    const conn = makeConn({ blocks: [BLOCK_SIX], rotations: [INTERNAL_MEDICINE] });
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ department_clinic: '  internal-medicine ' }),
    );
    check('"internal-medicine" finds "Internal Medicine"', () => {
      assert.strictEqual(result.rotation_id, INTERNAL_MEDICINE.id);
      assert.strictEqual(result.catalogued_rotation, false);
    });
    check('and does not catalogue a second rotation', () => {
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertRotation').length, 0);
    });
  })();

  await (async () => {
    const conn = makeConn({ blocks: [BLOCK_SIX], rotations: [INTERNAL_MEDICINE] });
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ department_clinic: 'InternalMedicine' }),
    );
    check('"InternalMedicine" matches on the space-less key', () => {
      assert.strictEqual(result.rotation_id, INTERNAL_MEDICINE.id);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertRotation').length, 0);
    });
  })();

  await (async () => {
    const conn = makeConn({ blocks: [BLOCK_SIX], rotations: [INTERNAL_MEDICINE] });
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ department_clinic: 'Internal Medicine Ward' }),
    );
    check('a longer name falls back to the catalogue entry it contains', () => {
      assert.strictEqual(result.rotation_id, INTERNAL_MEDICINE.id);
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertRotation').length, 0);
    });
  })();

  console.log('\n-- an unknown department is catalogued, never silently dropped --');

  await (async () => {
    const conn = makeConn({ blocks: [BLOCK_SIX], rotations: [], nextRotationId: 91 });
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ department_clinic: 'Rheumatology' }),
    );
    check('a new rotation is inserted', () => {
      assert.strictEqual(conn.writes.filter((w) => w.op === 'insertRotation').length, 1);
    });
    check('and the assignment references it', () => {
      assert.strictEqual(result.rotation_id, 91);
      assert.strictEqual(result.rotation_name, 'Rheumatology');
      assert.strictEqual(result.catalogued_rotation, true);
    });
    check('the auto-code is the upper-cased name', () => {
      const insert = conn.writes.find((w) => w.op === 'insertRotation');
      assert.strictEqual(insert.params[1], 'RHEUMATOLOGY');
    });
  })();

  console.log('\n-- approving the same request twice rewrites the same row --');

  await (async () => {
    const conn = makeConn({
      blocks: [BLOCK_SIX],
      rotations: [INTERNAL_MEDICINE],
      existingAssignment: { id: 500 },
    });
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
  })();

  console.log('\n-- a request that overruns its block is clamped into it --');

  await (async () => {
    const conn = makeConn({ blocks: [BLOCK_SIX], rotations: [INTERNAL_MEDICINE] });
    const result = await RotationApprovalService.syncApprovedRequest(
      conn,
      request({ start_date: '2026-11-01', end_date: '2026-12-31' }),
    );
    check('the window stops at the block end', () => {
      assert.strictEqual(result.start_date, '2026-11-01');
      assert.strictEqual(result.end_date, '2026-11-14');
    });
    check('a short window is PARTIAL_BLOCK', () => {
      assert.strictEqual(result.assignment_type, 'PARTIAL_BLOCK');
    });
  })();

  console.log('\n-- a request with no block calendar is refused, not half-applied --');

  await (async () => {
    const conn = makeConn({ blocks: [], rotations: [INTERNAL_MEDICINE] });
    let thrown = null;
    try {
      await RotationApprovalService.syncApprovedRequest(conn, request());
    } catch (error) {
      thrown = error;
    }
    check('it throws a 400 the coordinator can act on', () => {
      assert.ok(thrown, 'expected a rejection');
      assert.strictEqual(thrown.statusCode, 400);
      assert.match(thrown.message, /No rotation block covers/i);
    });
    check('and writes nothing', () => {
      assert.strictEqual(
        conn.writes.filter((w) => w.op === 'insertAssignment' || w.op === 'updateAssignment').length,
        0,
      );
    });
  })();

  console.log('\n-- a request with no programme falls back to the enrolment --');

  await (async () => {
    const conn = makeConn({
      blocks: [BLOCK_SIX],
      rotations: [INTERNAL_MEDICINE],
      enrollmentProgramId: 4,
    });
    const result = await RotationApprovalService.syncApprovedRequest(conn, request({ program_id: 0 }));
    check('the enrolment programme is used', () => {
      assert.strictEqual(result.rotation_block_id, BLOCK_SIX.id);
    });
  })();

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll rotation-approval checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
