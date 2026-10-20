const db = require('../config/db');
const NotificationService = require('../services/notificationService');
const RotationApprovalService = require('../services/rotationApprovalService');
const { DAY_NAMES, normalizeWeekStartDay } = require('../utils/blockDates');

/**
 * Rotation requests — a resident asking to be moved onto a hospital rotation
 * or a clinic session, and a coordinator approving or rejecting it.
 *
 * The endpoint this replaced returned `{ success: true }` without writing
 * anything, so a "submitted" request was a toast that went nowhere: there was
 * no row for the resident to see and nothing in the coordinator's queue. The
 * table below is the fix, created on first use because this repository ships no
 * schema migrations — the same approach the rest of the app takes against a
 * pre-existing Hostinger database.
 *
 * Statuses are deliberately a closed set so the queue can filter on them:
 * PENDING → APPROVED | REJECTED.
 *
 * Approving **places the resident on the rota**. An earlier revision stopped at
 * the status flip, which left the queue saying APPROVED while the Master
 * Rotation Grid still showed the resident unassigned — the queue and the rota
 * disagreeing about the same request. Approval now resolves the block and the
 * rotation and upserts the `resident_rotation_assignments` row the grid reads,
 * in the same transaction as the status change: either both land or neither
 * does, so the queue and the grid can never disagree again.
 */

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rotation_requests (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    resident_id INT NOT NULL,
    program_id INT NOT NULL,
    request_type VARCHAR(16) NOT NULL DEFAULT 'HOSPITAL',
    department_clinic VARCHAR(255) NOT NULL,
    rotation_id INT NULL,
    clinic_days JSON NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    decision_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_rotation_requests_program (program_id, status),
    INDEX idx_rotation_requests_resident (resident_id),
    INDEX idx_rotation_requests_rotation (rotation_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const VALID_TYPES = ['HOSPITAL', 'CLINIC'];
const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
/** Long enough for a paragraph of context, short enough for a queue column. */
const MAX_REASON_LENGTH = 500;
/**
 * The most recurring weekdays one clinic request may hold.
 *
 * Three is a deliberate ceiling, not an arbitrary one: a release is meant to fit
 * around the resident's hospital block, and asking for a clinic four or five days
 * a week is asking to not be on the block at all — a case the coordinator should
 * arrange directly rather than through a release.
 */
const MAX_CLINIC_DAYS = 3;

/** Memoised DDL — every handler awaits this before touching the table. */
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await db.query(TABLE_SQL);

      // A table created by an earlier revision has no `rotation_id`, and
      // `CREATE TABLE IF NOT EXISTS` silently skips it — which would leave the
      // catalogue pick-list writing a column that does not exist. The repo ships
      // no schema migrations, so the column is added here, once per process,
      // against a pre-existing Hostinger database.
      const [columns] = await db.query(
        `SHOW COLUMNS FROM rotation_requests LIKE 'rotation_id'`,
      );
      if (columns.length === 0) {
        await db.query(
          'ALTER TABLE rotation_requests ADD COLUMN rotation_id INT NULL AFTER department_clinic',
        );
        await db.query(
          'CREATE INDEX idx_rotation_requests_rotation ON rotation_requests (rotation_id)',
        );
      }

      // The recurring weekdays a clinic request asks for. A table created before
      // the request form offered a day picker has no such column, and
      // `CREATE TABLE IF NOT EXISTS` will not add one.
      const [dayColumns] = await db.query(
        `SHOW COLUMNS FROM rotation_requests LIKE 'clinic_days'`,
      );
      if (dayColumns.length === 0) {
        await db.query(
          'ALTER TABLE rotation_requests ADD COLUMN clinic_days JSON NULL AFTER rotation_id',
        );
      }
      return true;
    })().catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

/** `YYYY-MM-DD`, or `null` when the value is missing or not a date. */
function toIsoDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : value.trim();
}

/**
 * The recurring weekdays a clinic request names, normalised and ordered.
 *
 * Accepts the array the form sends (`['Wednesday']`), a JSON string of the same,
 * or the single `day_of_week` an older client posted, and reduces every shape to
 * canonical weekday names in institution order. Anything unrecognised is dropped
 * rather than rejected here — [`decide`] is where a request with no usable day is
 * refused, because it is the approval, not the writing down, that needs the days.
 *
 * @param {*} value
 * @returns {string[]|null} `null` when the request carries no day at all.
 */
function toClinicDays(value) {
  if (value === undefined || value === null || value === '') return null;

  let list = Array.isArray(value) ? value : [value];
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = value.split(',');
    }
  } else if (typeof value === 'string') {
    list = value.split(/[,;]/);
  }

  const wanted = new Set(
    list.map((day) => normalizeWeekStartDay(day)).filter((day) => Boolean(day)),
  );
  const ordered = DAY_NAMES.filter((day) => wanted.has(day));
  return ordered.length > 0 ? ordered : null;
}

function badRequest(res, messages) {
  return res.status(400).json({ success: false, errors: messages });
}

class RotationRequestController {
  /** POST /api/v1/requests/rotation */
  static async create(req, res) {
    try {
      await ensureTable();

      const {
        resident_id,
        program_id,
        request_type = 'HOSPITAL',
        department_clinic,
        // The canonical column is `department_clinic`, and that is what the app
        // sends. The two aliases are accepted because the domain model names the
        // field after the request type: `clinic_name` for a clinic request,
        // `department_name` for a hospital one. All three land in the one column.
        clinic_name,
        department_name,
        rotation_id,
        clinic_days,
        start_date,
        end_date,
        reason,
      } = req.body ?? {};

      const departmentClinic =
        [department_clinic, clinic_name, department_name].find(
          (value) => typeof value === 'string' && value.trim() !== '',
        ) ?? null;

      const problems = [];
      if (!Number.isInteger(Number(resident_id)) || Number(resident_id) <= 0) {
        problems.push('A resident is required.');
      }
      if (!VALID_TYPES.includes(String(request_type).toUpperCase())) {
        problems.push('Request type must be HOSPITAL or CLINIC.');
      }
      if (departmentClinic === null) {
        problems.push('A department or clinic name is required.');
      }
      const rotationId = Number(rotation_id);
      if (rotation_id !== undefined && rotation_id !== null && (!Number.isInteger(rotationId) || rotationId <= 0)) {
        problems.push('Rotation must be a valid catalogue selection.');
      }

      const start = toIsoDate(start_date);
      const end = toIsoDate(end_date);
      if (!start) problems.push('Start date must be in YYYY-MM-DD format.');
      if (!end) problems.push('End date must be in YYYY-MM-DD format.');
      if (start && end && end < start) problems.push('End date cannot be before the start date.');
      if (typeof reason === 'string' && reason.trim().length > MAX_REASON_LENGTH) {
        problems.push(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
      }

      // A clinic release is for one to three recurring weekdays; a request that
      // names none cannot be placed on a clinic grid, so it is refused here
      // rather than at approval time, when the resident is no longer watching.
      const clinicDays = toClinicDays(clinic_days ?? req.body?.day_of_week);
      if (String(request_type).toUpperCase() === 'CLINIC') {
        if (!clinicDays) {
          problems.push('Choose the weekday(s) the clinic runs on.');
        } else if (clinicDays.length > MAX_CLINIC_DAYS) {
          problems.push(`A clinic request can hold at most ${MAX_CLINIC_DAYS} days.`);
        }
      }

      if (problems.length > 0) return badRequest(res, problems);

      // A pick-list selection is a foreign key in everything but name: refuse a
      // rotation from another programme rather than store an id that can never
      // resolve when the coordinator approves the request.
      let rotationIdValue = null;
      if (Number.isInteger(rotationId) && rotationId > 0) {
        const [rotationRows] = await db.query(
          'SELECT id FROM rotations WHERE id = ? AND program_id = ?',
          [rotationId, Number(program_id) || 0],
        );
        if (rotationRows.length === 0) {
          return badRequest(res, ["That rotation is not in this programme's catalogue."]);
        }
        rotationIdValue = rotationId;
      }

      const [result] = await db.query(
        `INSERT INTO rotation_requests
           (resident_id, program_id, request_type, department_clinic, rotation_id, clinic_days, start_date, end_date, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          Number(resident_id),
          Number(program_id) || 0,
          String(request_type).toUpperCase(),
          departmentClinic.trim().slice(0, 255),
          rotationIdValue,
          clinicDays ? JSON.stringify(clinicDays) : null,
          start,
          end,
          typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
        ],
      );

      const rows = await RotationRequestController.#readOne(result.insertId);
      return res.status(201).json({ success: true, data: { request: rows[0] ?? null } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /** GET /api/v1/requests/rotation?program_id=&status=&resident_id= */
  static async list(req, res) {
    try {
      await ensureTable();

      const clauses = [];
      const params = [];

      if (req.query.program_id) {
        clauses.push('r.program_id = ?');
        params.push(Number(req.query.program_id));
      }
      if (req.query.resident_id) {
        clauses.push('r.resident_id = ?');
        params.push(Number(req.query.resident_id));
      }
      if (req.query.status && VALID_STATUSES.includes(String(req.query.status).toUpperCase())) {
        clauses.push('r.status = ?');
        params.push(String(req.query.status).toUpperCase());
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      const [rows] = await db.query(
        `SELECT r.request_id, r.resident_id, r.program_id, r.request_type, r.department_clinic,
                r.rotation_id, r.clinic_days,
                DATE_FORMAT(r.start_date, '%Y-%m-%d') AS start_date,
                DATE_FORMAT(r.end_date, '%Y-%m-%d') AS end_date,
                r.reason, r.status, r.decision_reason,
                r.created_at, r.decided_at,
                CONCAT(res.first_name, ' ', res.last_name) AS resident_name
           FROM rotation_requests r
           LEFT JOIN residents res ON res.id = r.resident_id
           ${where}
          ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC`,
        params,
      );

      return res.json({
        success: true,
        data: rows.map((row) => ({ ...row, clinic_days: toClinicDays(row.clinic_days) })),
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /** PATCH /api/v1/requests/rotation/:id */
  static async decide(req, res) {
    try {
      await ensureTable();

      const requestId = Number(req.params.id);
      const status = String(req.body?.status ?? '').toUpperCase();
      const decisionReason = req.body?.decision_reason ?? req.body?.reason ?? null;

      if (!Number.isInteger(requestId) || requestId <= 0) {
        return badRequest(res, ['A request id is required.']);
      }
      if (!['APPROVED', 'REJECTED'].includes(status)) {
        return badRequest(res, ['Status must be APPROVED or REJECTED.']);
      }
      if (status === 'REJECTED' && (typeof decisionReason !== 'string' || decisionReason.trim() === '')) {
        return badRequest(res, ['A rejection reason is required.']);
      }

      // The decision and the assignment it implies are one unit: an APPROVED
      // request with no rota row is the bug this endpoint exists to prevent, so
      // they commit together or not at all.
      let decided = null;
      let assignment = null;
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        const [result] = await conn.query(
          `UPDATE rotation_requests
              SET status = ?, decision_reason = ?, decided_at = NOW()
            WHERE request_id = ?`,
          [status, typeof decisionReason === 'string' ? decisionReason.trim() : null, requestId],
        );

        if (result.affectedRows === 0) {
          await conn.rollback();
          return res.status(404).json({ success: false, error: 'Request not found.' });
        }

        const rows = await RotationRequestController.#readOne(requestId, conn);
        decided = rows[0] ?? null;

        if (decided && status === 'APPROVED') {
          assignment = await RotationApprovalService.syncApprovedRequest(conn, decided);
        }

        await conn.commit();
      } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
      } finally {
        conn.release();
      }

      // Alert the requesting resident of the decision, once the write is durable.
      // Best-effort: a notification problem must not undo an approval.
      if (decided) {
        await NotificationService.notifyResidentSafe(decided.resident_id, {
          type: 'ROTATION_APPROVAL',
          title: `Rotation request ${status.toLowerCase()}`,
          message:
            `Your ${decided.request_type} request for ${decided.department_clinic} ` +
            `(${decided.start_date} to ${decided.end_date}) was ${status.toLowerCase()}` +
            (status === 'REJECTED' && decided.decision_reason
              ? `: ${decided.decision_reason}`
              : '.'),
          reference_id: requestId,
          reference_type: 'rotation_requests',
        });
      }

      return res.json({ success: true, data: { request: decided, assignment } });
    } catch (error) {
      // The approval service raises a 400/409 with a sentence the coordinator
      // can act on (no block calendar, no programme, the request is malformed),
      // so it is surfaced rather than flattened into a 500.
      if (typeof error.statusCode === 'number') {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
        return res.status(409).json({
          success: false,
          error: 'The request references a resident, rotation or block that no longer exists.',
        });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async #readOne(requestId, conn = db) {
    const [rows] = await conn.query(
      `SELECT
         r.request_id,
         r.resident_id,
         r.program_id,
         r.request_type,
         r.department_clinic,
         r.rotation_id,
         r.clinic_days,
         DATE_FORMAT(r.start_date, '%Y-%m-%d') AS start_date,
         DATE_FORMAT(r.end_date, '%Y-%m-%d') AS end_date,
         r.reason,
         r.status,
         r.decision_reason,
         r.created_at,
         r.decided_at,
         CONCAT(res.first_name, ' ', res.last_name) AS resident_name
         FROM rotation_requests r
         LEFT JOIN residents res ON res.id = r.resident_id
        WHERE r.request_id = ?`,
      [requestId],
    );
    return rows.map((row) => ({ ...row, clinic_days: toClinicDays(row.clinic_days) }));
  }
}

module.exports = RotationRequestController;
