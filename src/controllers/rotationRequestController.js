const db = require('../config/db');

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
 * PENDING → APPROVED | REJECTED. Approving does not itself create a rotation
 * assignment; that stays a coordinator action on the rota, because silently
 * writing a schedule row from a resident's request would bypass block dates.
 */

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rotation_requests (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    resident_id INT NOT NULL,
    program_id INT NOT NULL,
    request_type VARCHAR(16) NOT NULL DEFAULT 'HOSPITAL',
    department_clinic VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    decision_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_rotation_requests_program (program_id, status),
    INDEX idx_rotation_requests_resident (resident_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const VALID_TYPES = ['HOSPITAL', 'CLINIC'];
const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

/** Memoised DDL — every handler awaits this before touching the table. */
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db
      .query(TABLE_SQL)
      .then(() => true)
      .catch((error) => {
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
        start_date,
        end_date,
        reason,
      } = req.body ?? {};

      const problems = [];
      if (!Number.isInteger(Number(resident_id)) || Number(resident_id) <= 0) {
        problems.push('A resident is required.');
      }
      if (!VALID_TYPES.includes(String(request_type).toUpperCase())) {
        problems.push('Request type must be HOSPITAL or CLINIC.');
      }
      if (typeof department_clinic !== 'string' || department_clinic.trim() === '') {
        problems.push('A department or clinic name is required.');
      }

      const start = toIsoDate(start_date);
      const end = toIsoDate(end_date);
      if (!start) problems.push('Start date must be in YYYY-MM-DD format.');
      if (!end) problems.push('End date must be in YYYY-MM-DD format.');
      if (start && end && end < start) problems.push('End date cannot be before the start date.');
      if (problems.length > 0) return badRequest(res, problems);

      const [result] = await db.query(
        `INSERT INTO rotation_requests
           (resident_id, program_id, request_type, department_clinic, start_date, end_date, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          Number(resident_id),
          Number(program_id) || 0,
          String(request_type).toUpperCase(),
          department_clinic.trim().slice(0, 255),
          start,
          end,
          typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
        ],
      );

      const rows = await RotationRequestController.#readOne(result.insertId);
      return res.json({ success: true, request: rows[0] ?? null });
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
                r.start_date, r.end_date, r.reason, r.status, r.decision_reason,
                r.created_at, r.decided_at,
                CONCAT(res.first_name, ' ', res.last_name) AS resident_name
           FROM rotation_requests r
           LEFT JOIN residents res ON res.id = r.resident_id
           ${where}
          ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC`,
        params,
      );

      return res.json({ success: true, data: rows });
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

      const [result] = await db.query(
        `UPDATE rotation_requests
            SET status = ?, decision_reason = ?, decided_at = NOW()
          WHERE request_id = ?`,
        [status, typeof decisionReason === 'string' ? decisionReason.trim() : null, requestId],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Request not found.' });
      }

      const rows = await RotationRequestController.#readOne(requestId);
      return res.json({ success: true, request: rows[0] ?? null });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async #readOne(requestId) {
    const [rows] = await db.query(
      `SELECT r.*, CONCAT(res.first_name, ' ', res.last_name) AS resident_name
         FROM rotation_requests r
         LEFT JOIN residents res ON res.id = r.resident_id
        WHERE r.request_id = ?`,
      [requestId],
    );
    return rows;
  }
}

module.exports = RotationRequestController;
