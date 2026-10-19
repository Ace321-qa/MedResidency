const { rotationMatchKey, rotationLooseKey } = require('../utils/rotationMatch');
const { MAX_ABBREVIATION_LENGTH, MAX_NAME_LENGTH } = require('../utils/excel/catalogue');
const { weeksSpanned } = require('../utils/masterGridCalendar');

/**
 * Placing an approved rotation request onto the rota.
 *
 * The Request Queue used to end at the word APPROVED: the request row flipped to
 * APPROVED and nothing was written to `resident_rotation_assignments`, so the
 * resident's name stayed unassigned in the Master Rotation Grid — the queue said
 * one thing and the rota another. This service is the single place that closes
 * that gap: it resolves the block the request sits in and the rotation the
 * request names, then upserts the assignment the grid reads.
 *
 * Two shapes of resolution, both mirroring the Master Grid importer so the same
 * human text always lands on the same rows:
 *
 *  - **Block** by date containment. The request carries a window, not a block
 *    number, so the block is whichever one in the programme's calendar holds the
 *    request's first day; an exact window match wins, an active block beats an
 *    inactive one, and a request that runs past its block is clamped to it rather
 *    than rejected — a resident asking to join "Block 6" is placed in Block 6.
 *  - **Rotation** by case- and punctuation-insensitive name, then a contains
 *    fallback, then auto-catalogue. A department this programme has never
 *    catalogued becomes a new active rotation, because the alternative is an
 *    approval that silently paints nothing.
 *
 * The upsert keys on `(resident_id, rotation_block_id)` and is a SELECT followed
 * by INSERT or UPDATE rather than `INSERT ... ON DUPLICATE KEY UPDATE`: no
 * unique key spans those columns, and it must not — a block can legitimately
 * hold two assignments for one resident (a split block), which is a shape the
 * cohort grid explicitly supports. Approving the same request twice therefore
 * rewrites the same row instead of laying a duplicate over it.
 *
 * Every statement runs on the caller's connection so the approval and the
 * assignment commit together and roll back together.
 */

const NOTES = 'Approved via Resident Request Queue';

/** An error the controller turns into a 4xx with the given message. */
function reject(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** `YYYY-MM-DD`, or `null` when the value is missing or not a date. */
function isoDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * The programme a request belongs to, preferring the one stored on the request
 * and falling back to the resident's enrolment when it is absent.
 */
async function resolveProgramId(conn, request) {
  const explicit = Number(request.program_id);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;

  const [rows] = await conn.query(
    'SELECT program_id FROM residency_enrollments WHERE resident_id = ? LIMIT 1',
    [request.resident_id],
  );
  const fallback = Number(rows[0]?.program_id);
  return Number.isInteger(fallback) && fallback > 0 ? fallback : null;
}

/**
 * The block that holds `start`. An exact `start_date`/`end_date` match is
 * preferred (the resident picked the block's own window), then an active block,
 * then the lowest block number.
 *
 * `is_active` orders the candidates rather than filtering them: the Master Grid
 * draws a block whether or not it is flagged active, so refusing an approval for
 * a block the coordinator can still see would put the queue and the rota back
 * out of step — the very split this service exists to close.
 */
async function resolveBlock(conn, programId, start, end) {
  const [rows] = await conn.query(
    `SELECT id, block_number, block_name,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date_iso,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date_iso
       FROM rotation_blocks
      WHERE program_id = ?
        AND start_date <= ?
        AND end_date >= ?
      ORDER BY (start_date = ? AND end_date = ?) DESC, is_active DESC, block_number ASC
      LIMIT 1`,
    [programId, start, start, start, end],
  );
  return rows[0] ?? null;
}

/**
 * The rotation a request names, or a freshly catalogued one.
 *
 * Returns `{ id, rotation_code, rotation_name, catalogued }` where `catalogued`
 * is true when this call inserted the row.
 */
async function resolveRotation(conn, programId, rawName) {
  const name = String(rawName ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (name === '') {
    throw reject(400, 'The request names no department or clinic, so it cannot be placed on the rota.');
  }

  const [rotations] = await conn.query(
    `SELECT id, rotation_code, rotation_name, department_name
       FROM rotations
      WHERE program_id = ?
      ORDER BY is_active DESC, id ASC`,
    [programId],
  );

  const wanted = rotationMatchKey(name);
  const wantedLoose = rotationLooseKey(name);

  // Exact key first (name, abbreviation or department), then the no-punctuation
  // key, then a contains fallback between keys of at least four characters.
  const hasKey = (rotation, keyOf, target) => {
    const fields = [rotation.rotation_name, rotation.rotation_code, rotation.department_name];
    return fields.some((field) => field != null && keyOf(field) === target);
  };
  const exact = rotations.find((rotation) => hasKey(rotation, rotationMatchKey, wanted));
  if (exact) return { ...exact, catalogued: false };

  const loose = rotations.find((rotation) => hasKey(rotation, rotationLooseKey, wantedLoose));
  if (loose) return { ...loose, catalogued: false };

  if (wantedLoose.length >= 4) {
    const near = rotations.find((rotation) => {
      const fields = [rotation.rotation_name, rotation.rotation_code, rotation.department_name];
      return fields.some((field) => {
        const key = rotationLooseKey(field);
        return key.length >= 4 && (key.includes(wantedLoose) || wantedLoose.includes(key));
      });
    });
    if (near) return { ...near, catalogued: false };
  }

  // Nothing matched: catalogue it, mirroring the importer's abbreviation rule so
  // the same name never yields two different codes.
  const [codeRows] = await conn.query(
    'SELECT rotation_code FROM rotations WHERE program_id = ?',
    [programId],
  );
  const takenCodes = new Set(
    codeRows
      .map((row) => String(row.rotation_code ?? '').trim().toLowerCase())
      .filter(Boolean),
  );

  const base = name.toUpperCase().slice(0, MAX_ABBREVIATION_LENGTH);
  let code = base;
  let suffix = 2;
  while (takenCodes.has(code.toLowerCase())) {
    const tail = `-${suffix}`;
    code = `${base.slice(0, MAX_ABBREVIATION_LENGTH - tail.length)}${tail}`;
    suffix += 1;
  }

  const [result] = await conn.query(
    `INSERT INTO rotations (program_id, rotation_code, rotation_name, department_name)
     VALUES (?, ?, ?, ?)`,
    [programId, code, name, name],
  );

  return {
    id: result.insertId,
    rotation_code: code,
    rotation_name: name,
    department_name: name,
    catalogued: true,
  };
}

class RotationApprovalService {
  /**
   * Place an approved request on the rota and return the assignment the grid
   * will read.
   *
   * @param {import('mysql2/promise').PoolConnection} conn An open connection;
   *   the caller owns the transaction.
   * @param {object} request The `rotation_requests` row (needs `resident_id`,
   *   `program_id`, `department_clinic`, `start_date`, `end_date`).
   * @returns {Promise<object>}
   */
  static async syncApprovedRequest(conn, request) {
    const residentId = Number(request.resident_id);
    const start = isoDate(request.start_date);
    const end = isoDate(request.end_date);
    if (!Number.isInteger(residentId) || residentId <= 0) {
      throw reject(400, 'The request is missing a resident and cannot be placed on the rota.');
    }
    if (!start || !end || end < start) {
      throw reject(400, 'The request has no valid date window and cannot be placed on the rota.');
    }

    const programId = await resolveProgramId(conn, request);
    if (!programId) {
      throw reject(400, 'The request could not be tied to a programme, so there is no block calendar to read.');
    }

    const block = await resolveBlock(conn, programId, start, end);
    if (!block) {
      throw reject(
        400,
        `No rotation block covers ${start} to ${end} for this programme. ` +
          'Create the block calendar for that period, then approve again.',
      );
    }

    // Clamp the window to the block so the assignment can never fall outside the
    // column the grid will render it in.
    const assignStart = start < block.start_date_iso ? block.start_date_iso : start;
    const assignEnd = end > block.end_date_iso ? block.end_date_iso : end;
    const coversWholeBlock =
      assignStart === block.start_date_iso && assignEnd === block.end_date_iso;
    const assignmentType = coversWholeBlock ? 'FULL_BLOCK' : 'PARTIAL_BLOCK';

    const rotation = await resolveRotation(conn, programId, request.department_clinic);

    const [existing] = await conn.query(
      `SELECT id FROM resident_rotation_assignments
        WHERE resident_id = ? AND rotation_block_id = ?
        ORDER BY id ASC LIMIT 1`,
      [residentId, block.id],
    );

    const assignedWeeks = weeksSpanned(assignStart, assignEnd);
    let assignmentId;
    let created;
    if (existing[0]) {
      assignmentId = existing[0].id;
      created = false;
      await conn.query(
        `UPDATE resident_rotation_assignments
            SET rotation_id = ?, start_date = ?, end_date = ?,
                assigned_weeks = ?, assignment_type = ?, notes = ?
          WHERE id = ?`,
        [rotation.id, assignStart, assignEnd, assignedWeeks, assignmentType, NOTES, assignmentId],
      );
    } else {
      const [result] = await conn.query(
        `INSERT INTO resident_rotation_assignments
           (resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [residentId, rotation.id, block.id, assignStart, assignEnd, assignedWeeks, assignmentType, NOTES],
      );
      assignmentId = result.insertId;
      created = true;
    }

    return {
      assignment_id: assignmentId,
      resident_id: residentId,
      rotation_id: rotation.id,
      rotation_name: rotation.rotation_name,
      rotation_block_id: block.id,
      block_number: block.block_number,
      block_name: block.block_name,
      start_date: assignStart,
      end_date: assignEnd,
      assigned_weeks: assignedWeeks,
      assignment_type: assignmentType,
      notes: NOTES,
      created,
      catalogued_rotation: rotation.catalogued,
    };
  }
}

module.exports = RotationApprovalService;
