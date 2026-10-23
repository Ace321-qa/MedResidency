const db = require('../config/db');
const { evaluateOccupancy } = require('../utils/occupancy');

/**
 * Departmental seat limits: the check, and the audit trail for exceptions.
 *
 * ## What this service is for
 *
 * A rotation may declare how many residents can be in it at once
 * (`rotations.max_capacity`). Placing a resident is then not a question of
 * whether the *dates overlap* another posting but of how many people the
 * department actually holds, week by week — so this service reads the rotation's
 * existing assignments, hands them to the pure engine in `utils/occupancy`, and
 * returns a verdict the assignment path can act on.
 *
 * The division is deliberate: `utils/occupancy` decides *what* the situation is
 * (green, amber, red, blocked), and this file decides *what to do about it*
 * (allow, demand an exception, record it, refuse). A tier rule is arithmetic and
 * belongs in a pure function; a policy is I/O and belongs here.
 *
 * ## Why an exception is refused rather than warned
 *
 * The engine is the authority. A screen may render the same banner before the
 * write is attempted, but if the server allowed an Amber placement without a
 * rationale then every client — including one written later, or a `curl` — would
 * be able to fill a department past its limit and leave no trace. So the rule is
 * enforced on the write: Amber, Review and Red are refused unless the caller
 * supplies a reason, an approver and a faculty-supervision confirmation, and a
 * locked limit is refused whatever the caller supplies.
 */

const MAX_REASON_LENGTH = 500;
const MAX_APPROVER_LENGTH = 200;

/**
 * Read a rotation's seat limit and lock flag.
 *
 * When `forUpdate` is set the row is locked until the caller's transaction ends.
 * This is what makes the limit hold under concurrency: the check counts the
 * rotation's existing assignments and then inserts, and two coordinators doing
 * that at once would each read "3 of 3" and each write a fourth unless something
 * serialises them. The rotation row is the natural lock — every placement into
 * it takes the same one — so a second placement waits, re-counts against the
 * first's committed insert, and sees the true occupancy.
 *
 * `forUpdate` is honoured only inside a transaction; a bare pool connection has
 * autocommit on, and the lock would be released immediately, which is harmless
 * but pointless.
 *
 * @returns {Promise<{id:number, rotation_name:string, department_name:string,
 *   max_capacity:number|null, capacity_locked:boolean}|null>}
 */
async function loadRotation(conn, rotationId, forUpdate = false) {
  const [rows] = await conn.query(
    `SELECT id, rotation_name, department_name, max_capacity, capacity_locked
       FROM rotations
      WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [rotationId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const capacity = row.max_capacity === null ? null : Number(row.max_capacity);
  return {
    id: Number(row.id),
    rotation_name: row.rotation_name,
    department_name: row.department_name,
    max_capacity: capacity !== null && capacity > 0 ? capacity : null,
    capacity_locked: Number(row.capacity_locked) === 1,
  };
}

/**
 * Every assignment already standing in a rotation, as windows.
 *
 * Scoped by rotation rather than by block by default: a resident on the previous
 * block's last week and a resident on this block's first week are in the same
 * department at the same time, and a block-scoped count would miss it. The
 * engine ignores whatever falls outside the proposal's weeks, so reading the
 * whole rotation is both correct and simple.
 *
 * When the caller passes a `block` window — the rotation block being placed
 * into, read server-side by id — the query instead takes the spec's literal
 * rule, `start_date <= block.end_date AND end_date >= block.start_date`: every
 * row that overlaps the block at all, and nothing from blocks that do not. The
 * window may be wider or narrower than the proposal (a proposal drawn from grid
 * columns can run a day or two past the stored block dates), which is the point:
 * the block, not the picker's arithmetic, decides who is in the room.
 *
 * When `forUpdate` is set the rows are also locked, and — more importantly —
 * read as a *current* read. Under REPEATABLE READ a plain `SELECT` answers from
 * the transaction's snapshot, which was pinned by the first statement and never
 * sees a row another transaction committed after that. Locking the rotation row
 * alone would order the two transactions but still let the second count the
 * roster as it was *before* the first committed, so a capacity-1 rotation would
 * accept two residents. `FOR UPDATE` here forces the lower-locked read to see
 * the latest committed rows.
 */
async function loadConcurrentAssignments(conn, rotationId, proposal, forUpdate = false, block = null) {
  const window =
    block && block.start_date && block.end_date ? block : (proposal ?? {});
  const [rows] = await conn.query(
    `SELECT id AS assignment_id,
            resident_id,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
       FROM resident_rotation_assignments
      WHERE rotation_id = ?
        AND start_date <= ?
        AND end_date >= ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [rotationId, window.end_date, window.start_date],
  );
  return rows;
}

/** The programme's week-start weekday, as a number the engine understands. */
async function loadWeekStartDay(conn, programId) {
  if (!programId) return 0;
  const [rows] = await conn.query('SELECT week_start_day FROM programs WHERE id = ?', [programId]);
  return rows[0]?.week_start_day ?? 0;
}

/**
 * Evaluate a proposed placement against its rotation's seat limit.
 *
 * Returns the engine's verdict plus the rotation, so a caller has everything it
 * needs to build a message or an audit row without a second read.
 *
 * @param {object} conn - a pool or a transaction connection.
 * @param {object} input
 * @param {number} input.rotation_id
 * @param {{start_date:string, end_date:string}} input.proposal
 * @param {number} [input.program_id]
 * @param {number} [input.excludeAssignmentId] - the assignment being re-saved.
 * @param {boolean} [input.forUpdate] - lock the rotation row for the caller's
 *   transaction, so a concurrent placement cannot pass the same check.
 * @param {{start_date:string, end_date:string}} [input.block] - the rotation
 *   block being placed into, when the caller knows it (see
 *   `loadConcurrentAssignments` for what that changes). Callers read the block
 *   by id server-side and pass its stored dates; a client-supplied window is
 *   never trusted here.
 * @returns {Promise<{rotation:object|null, result:object}>}
 */
async function checkPlacement(conn, input) {
  const rotation = await loadRotation(conn, input.rotation_id, input.forUpdate === true);
  if (!rotation) {
    return { rotation: null, result: null };
  }

  const weekStartDay = await loadWeekStartDay(conn, input.program_id);
  const existing = await loadConcurrentAssignments(
    conn,
    input.rotation_id,
    input.proposal,
    input.forUpdate === true,
    input.block ?? null,
  );

  const result = evaluateOccupancy({
    existing,
    proposal: input.proposal,
    capacity: rotation.max_capacity,
    locked: rotation.capacity_locked,
    week_start_day: weekStartDay,
    excludeAssignmentId: input.excludeAssignmentId ?? null,
    // The person being placed. Without it the engine counts the proposal as an
    // anonymous extra, which is right for a "what would this look like" preview
    // but wrong when the caller knows who they are placing — the resident's own
    // existing rows would then be counted against them.
    residentId: input.resident_id ?? input.proposal?.resident_id ?? null,
    // The block, when known, so the engine's week arithmetic agrees with the
    // query's row filter rather than trusting the proposal's drawn window alone.
    block_window: input.block ?? null,
  });

  return { rotation, result };
}

/**
 * Normalise the exception payload a caller supplies for an over-capacity write.
 *
 * All three parts are required. The reason is what the exception *was*; the
 * approver is who owns it; and the faculty confirmation is the educational half
 * of the question — a seat limit that is exceeded is also a supervision limit
 * that is exceeded, and a coordinator agreeing to the first must confirm the
 * second still holds.
 *
 * @returns {{ok:true, values:object}|{ok:false, errors:string[]}}
 */
function normalizeException(input) {
  const errors = [];
  const reason = String(input?.exception_reason ?? '').trim();
  const approver = String(input?.exception_approver ?? '').trim();
  const faculty = input?.faculty_supervision_confirmed;
  const facultyConfirmed = faculty === true || faculty === 1 || faculty === '1' || faculty === 'true';

  if (reason === '') errors.push('Reason for Exception is required for a placement over capacity');
  else if (reason.length > MAX_REASON_LENGTH) {
    errors.push(`Reason for Exception must be ${MAX_REASON_LENGTH} characters or fewer`);
  }

  if (approver === '') errors.push('Approving Coordinator / Department Lead is required for a placement over capacity');
  else if (approver.length > MAX_APPROVER_LENGTH) {
    errors.push(`Approving Coordinator / Department Lead must be ${MAX_APPROVER_LENGTH} characters or fewer`);
  }

  if (!facultyConfirmed) {
    errors.push('Faculty Supervision & Educational Adequacy must be confirmed for a placement over capacity');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, values: { reason, approver, faculty_confirmed: 1 } };
}

/**
 * Record an accepted over-capacity placement.
 *
 * The audit row keeps its own snapshot of the numbers rather than pointing at
 * the engine's output at read time: the roster changes, and "why was this
 * allowed" must be answerable with the occupancy that was true *then*. Storing
 * only `assignment_id` would make the justification drift every time a
 * colleague was assigned or removed.
 */
async function recordException(conn, input) {
  const { assignment_id, resident_id, rotation, block_id, result, exception } = input;

  await conn.query(
    `INSERT INTO rotation_capacity_exceptions
       (assignment_id, resident_id, rotation_id, rotation_block_id, status, capacity,
        peak_occupancy, peak_weeks, reason, approver, faculty_confirmed, weekly_occupancy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      assignment_id ?? null,
      resident_id,
      rotation.id,
      block_id ?? null,
      result.status,
      result.capacity,
      result.peak,
      JSON.stringify(result.peak_weeks ?? []),
      exception.reason,
      exception.approver,
      exception.faculty_confirmed,
      JSON.stringify(result.weeks ?? []),
    ],
  );
}

/** The most recent exception recorded against an assignment, or `null`. */
async function findExceptionForAssignment(conn, assignmentId) {
  const [rows] = await conn.query(
    `SELECT id, status, capacity, peak_occupancy, peak_weeks, reason, approver,
            faculty_confirmed, weekly_occupancy, created_at
       FROM rotation_capacity_exceptions
      WHERE assignment_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [assignmentId],
  );
  return rows[0] ?? null;
}

module.exports = {
  MAX_APPROVER_LENGTH,
  MAX_REASON_LENGTH,
  checkPlacement,
  findExceptionForAssignment,
  loadRotation,
  normalizeException,
  recordException,
};
