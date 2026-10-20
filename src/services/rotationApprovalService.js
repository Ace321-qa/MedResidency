const { rotationMatchKey, rotationLooseKey } = require('../utils/rotationMatch');
const { MAX_ABBREVIATION_LENGTH, MAX_NAME_LENGTH } = require('../utils/excel/catalogue');
const {
  MASTER_GRID_START,
  WEEKS_PER_BLOCK,
  blockWindow,
  weekNumberForDate,
  weeksSpanned,
} = require('../utils/masterGridCalendar');
const { academicYearForDate, academicYearMatchValues } = require('../utils/academicYear');
const { DAY_NAMES, normalizeWeekStartDay } = require('../utils/blockDates');
const LongitudinalService = require('./longitudinalService');

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
 * Three rules, each earned from a real mismatch between the queue and the grid:
 *
 *  - **Block by greatest overlap, not by containment.** A request carries a
 *    window, not a block number, and the window routinely straddles two rows of
 *    `rotation_blocks` (a resident asking for "Block 5" whose stored block starts
 *    a week later). Picking the block that merely contains the first day lands
 *    the badge one column to the left; picking the block that shares the most
 *    days lands it where the resident — and the grid header — expect it.
 *  - **Window kept inside the block the grid draws.** `rotation_blocks` rows can
 *    be a week out of step with the 13-block calendar the Master Grid renders
 *    (`masterGridCalendar`), so a request that exactly matches the column the
 *    coordinator sees can otherwise be shortened by a week. The window is
 *    clamped to the *rendered* window for the resolved block number — a request
 *    that already matches it survives verbatim, and one that overruns it cannot
 *    spill into the neighbouring column.
 *  - **Rotation matched exactly as the importer matches it** — case- and
 *    punctuation-insensitive name, then the code, then a contains fallback, then
 *    auto-catalogue. `rotationMatch.js` is shared with the importer precisely so
 *    the same human text cannot resolve to two different rows.
 *
 * The block calendar itself is repaired lazily: a request inside the 13-block
 * grid whose block row is missing gets that row created, so a future request is
 * never refused for want of a calendar nobody has drawn yet. A request outside
 * the grid is refused with a sentence the coordinator can act on, because an
 * approval that silently paints nothing is the bug this service exists to close.
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
 * The resident a request names, matched strictly on `resident_id`.
 *
 * `rotation_requests.resident_id` is `NOT NULL` and points at `residents.id`, so
 * there is no legacy row without one and no name to fall back to — which is the
 * point. This programme holds two distinct residents both named "Yasser Fahad
 * Taylor", so matching a request by name would place the wrong person on the
 * rota. The id is checked against `residents` so a dangling reference is refused
 * with a sentence rather than surfacing later as a foreign-key 500.
 */
async function resolveResident(conn, request) {
  const residentId = Number(request.resident_id);
  if (!Number.isInteger(residentId) || residentId <= 0) {
    throw reject(400, 'The request is missing a resident and cannot be placed on the rota.');
  }

  const [rows] = await conn.query('SELECT id FROM residents WHERE id = ? LIMIT 1', [residentId]);
  if (!rows[0]) {
    throw reject(
      400,
      `The request names resident ${residentId}, who is not in the resident register. ` +
        'Correct the request before approving it.',
    );
  }
  return residentId;
}

/**
 * The block that shares the most days with `[start, end]`.
 *
 * Overlap is measured inclusively (`2026-10-18`…`2026-10-24` is seven days), an
 * exact window match is worth the whole span, an active block breaks a tie
 * before the block number does, and the lower block number breaks a remaining
 * tie so the choice is deterministic.
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
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date_iso,
            DATEDIFF(LEAST(end_date, ?), GREATEST(start_date, ?)) + 1 AS overlap_days
       FROM rotation_blocks
      WHERE program_id = ?
        AND start_date <= ?
        AND end_date >= ?
      ORDER BY overlap_days DESC, is_active DESC, block_number ASC
      LIMIT 1`,
    [end, start, programId, end, start],
  );
  return rows[0] ?? null;
}

/** A block for `blockNumber` in `academicYear`, matched under both spellings. */
async function findBlockByNumber(conn, programId, blockNumber, academicYear) {
  const years = academicYearMatchValues(academicYear);
  const [rows] = await conn.query(
    `SELECT id, block_number, block_name,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date_iso,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date_iso
       FROM rotation_blocks
      WHERE program_id = ?
        AND block_number = ?
        AND academic_year IN (${years.map(() => '?').join(', ')})
      ORDER BY is_active DESC, id ASC
      LIMIT 1`,
    [programId, blockNumber, ...years],
  );
  return rows[0] ?? null;
}

/**
 * The `rotation_blocks` row for the request's block, created from the 13-block
 * calendar when the programme has not drawn it yet.
 *
 * Only reached when no block overlaps the request — blocks 1–7 normally cover
 * the year — so this fills the future blocks (8…13) rather than rewriting a
 * calendar already in use. Returns `null` when the request falls outside the
 * 52-week grid, which the caller turns into an actionable 4xx.
 */
async function ensureBlock(conn, programId, start) {
  const week = weekNumberForDate(start, MASTER_GRID_START);
  if (!week) return null;
  const blockNumber = Math.ceil(week / WEEKS_PER_BLOCK);

  const academicYear = academicYearForDate(start);
  if (!academicYear) return null;

  const existing = await findBlockByNumber(conn, programId, blockNumber, academicYear);
  if (existing) return existing;

  const window = blockWindow(blockNumber, MASTER_GRID_START);
  if (!window) return null;

  const blockName = `Block ${blockNumber}`;
  try {
    const [result] = await conn.query(
      `INSERT INTO rotation_blocks
         (program_id, academic_year, block_number, block_name, start_date, end_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [programId, academicYear, blockNumber, blockName, window.start, window.end],
    );
    return {
      id: result.insertId,
      block_number: blockNumber,
      block_name: blockName,
      start_date_iso: window.start,
      end_date_iso: window.end,
    };
  } catch (error) {
    // A concurrent approval drew the same block first; take theirs.
    if (error.code === 'ER_DUP_ENTRY') {
      return findBlockByNumber(conn, programId, blockNumber, academicYear);
    }
    throw error;
  }
}

/**
 * The window the assignment is recorded against.
 *
 * The Master Grid paints a block from `masterGridCalendar`, so an assignment
 * hanging off block N belongs to block N's *rendered* window. When that window
 * overlaps the request the rendered one is used (which is how a resident who
 * asked for exactly "Block 5" keeps the full four weeks even though the stored
 * `rotation_blocks` row for that number is a week adrift); otherwise the stored
 * row's own window is the only sensible clamp.
 */
function windowBounds(block, start, end) {
  const rendered = blockWindow(block.block_number, MASTER_GRID_START);
  if (rendered && !(end < rendered.start || start > rendered.end)) {
    return { start: rendered.start, end: rendered.end };
  }
  return { start: block.start_date_iso, end: block.end_date_iso };
}

/**
 * The rotation a request names, or a new active rotation catalogued from it.
 *
 * The match fields are `rotation_name` and `rotation_code` — the same two the
 * Master Grid importer registers — so the same human text always resolves to the
 * same row. Nothing here looks at `department_name`: the importer never does, and
 * matching it here would let "Internal Medicine" find an "Internal Medicine
 * Inpatient Wards" row on the approval path while the importer catalogued a
 * brand-new "Internal Medicine", which is exactly the drift `rotationMatch.js`
 * exists to prevent.
 *
 * A request that came from the catalogue pick-list carries the chosen rotation's
 * own `rotation_id`, and that wins outright: the resident picked a row and the
 * coordinator approving it should place them on *that* row, not on whatever the
 * department string happens to match. The id is re-checked against the programme
 * and must still be active — a rotation retired between the request and the
 * approval falls through to the name match rather than being resurrected.
 */
async function resolveRotation(conn, programId, departmentClinic, rotationId) {
  const wantedId = Number(rotationId);
  if (Number.isInteger(wantedId) && wantedId > 0) {
    const [byIdRows] = await conn.query(
      `SELECT id, rotation_code, rotation_name, department_name
         FROM rotations
        WHERE id = ? AND program_id = ? AND is_active = 1
        LIMIT 1`,
      [wantedId, programId],
    );
    if (byIdRows[0]) return { ...byIdRows[0], catalogued: false };
  }

  const name = String(departmentClinic ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) {
    throw reject(400, 'The request names no rotation, so there is nothing to place on the rota.');
  }

  // Active rotations are the ones a new request may join; every code the
  // programme has ever used (active or retired) is read separately so a freshly
  // catalogued abbreviation cannot collide with a retired one.
  const [rows] = await conn.query(
    `SELECT id, rotation_code, rotation_name, department_name
       FROM rotations
      WHERE program_id = ? AND is_active = 1
      ORDER BY id ASC`,
    [programId],
  );
  const [codeRows] = await conn.query(
    'SELECT rotation_code FROM rotations WHERE program_id = ?',
    [programId],
  );

  const wantedExact = rotationMatchKey(name);
  const wantedLoose = rotationLooseKey(name);

  const byExact = rows.find(
    (row) => rotationMatchKey(row.rotation_name) === wantedExact || rotationMatchKey(row.rotation_code) === wantedExact,
  );
  if (byExact) return { ...byExact, catalogued: false };

  const byLoose = rows.find(
    (row) => rotationLooseKey(row.rotation_name) === wantedLoose || rotationLooseKey(row.rotation_code) === wantedLoose,
  );
  if (byLoose) return { ...byLoose, catalogued: false };

  if (wantedLoose.length >= 4) {
    const byContains = rows.find((row) => {
      const looseName = rotationLooseKey(row.rotation_name);
      const looseCode = rotationLooseKey(row.rotation_code);
      return [looseName, looseCode].some(
        (key) => key.length >= 4 && (key.includes(wantedLoose) || wantedLoose.includes(key)),
      );
    });
    if (byContains) return { ...byContains, catalogued: false };
  }

  // Nothing matched: catalogue it, mirroring the importer's abbreviation rule so
  // the same name never yields two different codes.
  const takenCodes = new Set(
    codeRows.map((row) => String(row.rotation_code ?? '').trim().toLowerCase()).filter(Boolean),
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

/**
 * The canonical Title-case name of a weekday, or `null`.
 *
 * `normalizeWeekStartDay` already accepts the MySQL enum (`WEDNESDAY`), the
 * display name (`Wednesday`), the abbreviation (`Wed`) and a numeric weekday;
 * this narrows its `SUNDAY`-style result to the form the rest of the service and
 * the app speak in.
 */
function canonicalDay(day) {
  const enumDay = normalizeWeekStartDay(day);
  if (!enumDay) return null;
  return DAY_NAMES[DAY_NAMES.indexOf(enumDay)] ?? enumDay;
}

/**
 * The weekdays a clinic request names.
 *
 * Two shapes arrive here. A form that offers checkboxes sends `clinic_days`; the
 * older single-select sends `day_of_week`. Free text is matched against the day
 * names only as a last resort, because this is the field that decides which
 * sessions a resident is released for — guessing "Weds" is worth doing, guessing
 * between Tuesday and Thursday is not.
 */
function requestedClinicDays(request) {
  const raw = [request.clinic_days, request.days, request.day_of_week, request.clinic_day]
    .find((value) => value !== undefined && value !== null && value !== '');

  const candidates = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim().startsWith('[')
      ? safeJsonArray(raw)
      : String(raw ?? '').split(/[,;]/);

  const days = [];
  for (const candidate of candidates) {
    const day = canonicalDay(candidate);
    if (day && !days.includes(day)) days.push(day);
  }
  return days;
}

/** `[...]` as stored in a JSON column, or `[]` when it is not valid JSON. */
function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The `SUNDAY`-style enum spelling of a calendar day name. */
function dayEnum(day) {
  const name = canonicalDay(day);
  return name ? name.toUpperCase() : null;
}

/** `+ ANC (Wed)`, or `+ ANC (Wed, Fri)` for a multi-day release. */
function clinicBadgeLabel(clinicCode, clinicDays, fallbackName) {
  const label = String(clinicCode ?? '').trim() || String(fallbackName ?? '').trim();
  const short = (clinicDays ?? []).map((day) => canonicalDay(day)?.slice(0, 3)).filter(Boolean);
  if (!label) return short.length > 0 ? `+ (${short.join(', ')})` : '+ Clinic';
  return short.length > 0 ? `+ ${label} (${short.join(', ')})` : `+ ${label}`;
}

/**
 * The clinic a clinic request names, matched the way the clinic pick-list
 * matches it, or `null` when the programme runs no such clinic.
 *
 * A `rotation_id` on the request is deliberately ignored: the two pick-lists
 * share a form, so a clinic chosen from the *Rotations Catalogue* tail carries a
 * rotation id that has nothing to do with `longitudinal_clinic_types`. The name
 * is namespaced by source on the way in (`clinic:antenatal care clinic (anc)` vs
 * `rotation:7`) and matched on the bare name here.
 *
 * `ACTIVE` only: a clinic the programme has retired has no grid to place anyone
 * on, so the assignment is still recorded — it is still a real decision and the
 * coordinator is told what did not land — but nothing is written to a matrix.
 */
async function resolveClinicType(conn, programId, departmentClinic) {
  const name = String(departmentClinic ?? '').trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return null;

  const [rows] = await conn.query(
    `SELECT id, clinic_code, clinic_name, default_day_of_week
       FROM longitudinal_clinic_types
      WHERE program_id = ? AND is_active = 1
      ORDER BY id ASC`,
    [programId],
  );

  const wanted = rotationMatchKey(name);
  const loose = rotationLooseKey(name);
  return (
    rows.find((row) => rotationMatchKey(row.clinic_name) === wanted) ??
    rows.find((row) => rotationMatchKey(row.clinic_code) === wanted) ??
    rows.find(
      (row) =>
        rotationLooseKey(row.clinic_name) === loose || rotationLooseKey(row.clinic_code) === loose,
    ) ??
    null
  );
}

class RotationApprovalService {
  /**
   * Place an approved request onto the rota and return the assignment the grid
   * will read.
   *
   * @param {import('mysql2/promise').PoolConnection} conn An open connection;
   *   the caller owns the transaction.
   * @param {object} request The `rotation_requests` row (needs `resident_id`,
   *   `program_id`, `department_clinic`, `start_date`, `end_date`, and optionally
   *   `rotation_id` when the resident picked a catalogue entry).
   * @returns {Promise<object>}
   */
  static async syncApprovedRequest(conn, request) {
    const start = isoDate(request.start_date);
    const end = isoDate(request.end_date);
    if (!start || !end || end < start) {
      throw reject(400, 'The request has no valid date window and cannot be placed on the rota.');
    }

    const residentId = await resolveResident(conn, request);

    const programId = await resolveProgramId(conn, request);
    if (!programId) {
      throw reject(400, 'The request could not be tied to a programme, so there is no block calendar to read.');
    }

    const block =
      (await resolveBlock(conn, programId, start, end)) ?? (await ensureBlock(conn, programId, start));
    if (!block) {
      throw reject(
        400,
        `No rotation block covers ${start} to ${end} for this programme, and the date falls outside ` +
          'the 13-block academic calendar. Move the request inside the academic year, then approve again.',
      );
    }

    // Clamp the window to the block the grid renders so the badge can never spill
    // into the neighbouring column, while the resident's stated window survives.
    const bounds = windowBounds(block, start, end);
    const assignStart = start < bounds.start ? bounds.start : start;
    const assignEnd = end > bounds.end ? bounds.end : end;
    if (assignStart > assignEnd) {
      throw reject(
        400,
        `The request window ${start} to ${end} does not sit inside block ${block.block_number}. ` +
          'Check the block calendar, then approve again.',
      );
    }
    const coversWholeBlock = assignStart === bounds.start && assignEnd === bounds.end;
    const assignmentType = coversWholeBlock ? 'FULL_BLOCK' : 'PARTIAL_BLOCK';

    // A clinic request stops here. It is a release for one recurring session a
    // week, not a posting: the resident keeps the hospital rotation their block
    // already names, and overwriting that row would erase a decision the
    // coordinator made. So the two kinds of request are stored in two tables —
    // the block rota in `resident_rotation_assignments`, the release in
    // `resident_longitudinal_assignments` — and only the Master Grid merges them.
    if (String(request.request_type ?? 'HOSPITAL').toUpperCase() === 'CLINIC') {
      return this.#placeClinicRequest(conn, {
        request,
        residentId,
        programId,
        block,
        assignStart,
        assignEnd,
        assignedWeeks: weeksSpanned(assignStart, assignEnd),
      });
    }

    const rotation = await resolveRotation(conn, programId, request.department_clinic, request.rotation_id);

    const [existing] = await conn.query(
      `SELECT id FROM resident_rotation_assignments
        WHERE resident_id = ?
          AND rotation_block_id = ?
        LIMIT 1`,
      [residentId, block.id],
    );

    const assignedWeeks = weeksSpanned(assignStart, assignEnd);
    let assignmentId;
    let created;
    if (existing[0]) {
      const [result] = await conn.query(
        `UPDATE resident_rotation_assignments
            SET rotation_id = ?, start_date = ?, end_date = ?, assigned_weeks = ?,
                assignment_type = ?, notes = ?
          WHERE id = ?`,
        [rotation.id, assignStart, assignEnd, assignedWeeks, assignmentType, NOTES, existing[0].id],
      );
      assignmentId = existing[0].id;
      created = result.affectedRows === 0;
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
      catalogued_rotation: Boolean(rotation.catalogued),
    };
  }

  /**
   * Record an approved clinic request as a recurring release.
   *
   * Nothing here writes `resident_rotation_assignments`: the block rota is a
   * different question from "which clinic session is this resident released for",
   * and answering the second by rewriting the first is how an approved clinic
   * request used to erase a hospital rotation.
   *
   * The row therefore lands in `resident_longitudinal_assignments`, keyed on the
   * request that made it so re-approving rewrites it rather than stacking a
   * second one. When the clinic is one the programme actually runs
   * (`longitudinal_clinic_types`) the session is *also* written onto that clinic's
   * own matrix, because that is the grid the clinic's supervisor reads; a clinic
   * the resident typed that no coordinator has catalogued is recorded here and
   * shown as a notation on the Master Grid, with no matrix to place it in.
   *
   * @private
   */
  static async #placeClinicRequest(conn, { request, residentId, programId, block, assignStart, assignEnd, assignedWeeks }) {
    const name = String(request.department_clinic ?? '').trim();
    if (!name) {
      throw reject(400, 'The request names no clinic, so there is nothing to place on the clinic.');
    }

    const clinic = await resolveClinicType(conn, programId, name);
    const requested = requestedClinicDays(request);
    const days = requested.length > 0
      ? requested
      : clinic?.default_day_of_week
        ? [canonicalDay(clinic.default_day_of_week)].filter(Boolean)
        : DAY_NAMES.slice(0, 5);

    const [residentRows] = await conn.query(
      'SELECT CONCAT(first_name, \' \', last_name) AS resident_name FROM residents WHERE id = ? LIMIT 1',
      [residentId],
    );
    const residentName = residentRows[0]?.resident_name ?? null;

    const summary = `Clinic release: ${name}${days.length > 0 ? ` (${days.map((day) => day.slice(0, 3)).join(', ')})` : ''}`;
    const daysJson = JSON.stringify(days);

    const [existing] = await conn.query(
      `SELECT id FROM resident_longitudinal_assignments
        WHERE source_request_id = ?
        LIMIT 1`,
      [request.request_id],
    );

    let assignmentId;
    let created;
    if (existing[0]) {
      await conn.query(
        `UPDATE resident_longitudinal_assignments
            SET clinic_type_id = ?, day_of_week = ?, clinic_days = ?, start_date = ?, end_date = ?,
                notes = ?, summary = ?, assignment_source = 'CLINIC_REQUEST', is_active = 1
          WHERE id = ?`,
        [
          clinic?.id ?? null,
          dayEnum(days[0]),
          daysJson,
          assignStart,
          assignEnd,
          NOTES,
          summary,
          existing[0].id,
        ],
      );
      assignmentId = existing[0].id;
      created = false;
    } else {
      const [result] = await conn.query(
        `INSERT INTO resident_longitudinal_assignments
           (resident_id, clinic_type_id, site_name, supervisor_name, day_of_week, clinic_days,
            start_date, end_date, notes, summary, source_request_id, assignment_source, is_active)
         VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, 'CLINIC_REQUEST', 1)`,
        [
          residentId,
          clinic?.id ?? null,
          dayEnum(days[0]),
          daysJson,
          assignStart,
          assignEnd,
          NOTES,
          summary,
          request.request_id ?? null,
        ],
      );
      assignmentId = result.insertId;
      created = true;
    }

    // A catalogued clinic owns a grid, and the grid is where the clinic's
    // supervisor reads who is coming. A clinic the programme does not run has no
    // grid: the request is still recorded, and the Master Grid says so.
    let grid = [];
    if (clinic) {
      grid = await LongitudinalService.placeClinicRequestOnGrid({
        conn,
        programId,
        clinicTypeId: clinic.id,
        days,
        residentName: residentName ?? '',
      });
    }

    return {
      assignment_id: assignmentId,
      resident_id: residentId,
      rotation_id: null,
      rotation_name: name,
      rotation_block_id: block.id,
      block_number: block.block_number,
      block_name: block.block_name,
      start_date: assignStart,
      end_date: assignEnd,
      assigned_weeks: assignedWeeks,
      assignment_type: 'CLINIC_RELEASE',
      notes: NOTES,
      created,
      catalogued_rotation: false,
      clinic_id: clinic?.id ?? null,
      clinic_code: clinic?.clinic_code ?? null,
      clinic_name: clinic?.clinic_name ?? name,
      clinic_days: days,
      clinic_days_enum: days.map(dayEnum),
      badge_label: clinicBadgeLabel(clinic?.clinic_code, days, name),
      matrix_records: grid,
      catalogued_clinic: Boolean(clinic),
    };
  }
}

module.exports = RotationApprovalService;
