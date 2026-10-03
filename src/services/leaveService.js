const db = require('../config/db');

// Mirrors the `leave_type` enum on resident_leave_requests
const LEAVE_TYPES = [
  'ANNUAL_LEAVE',
  'CASUAL_LEAVE',
  'SICK_LEAVE',
  'EMERGENCY_LEAVE',
  'HAJJ_LEAVE',
  'ACADEMIC_LEAVE',
  'STUDY_LEAVE',
  'EXAM_LEAVE',
  'OTHER_LEAVE',
];

// Chief sign-off workflow: PENDING -> APPROVED_BY_CHIEF -> APPROVED, terminal states close the request
const STATUS_TRANSITIONS = {
  PENDING: ['PENDING', 'APPROVED_BY_CHIEF', 'APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED_BY_CHIEF: ['APPROVED_BY_CHIEF', 'APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['APPROVED'],
  REJECTED: ['REJECTED'],
  CANCELLED: ['CANCELLED'],
};

/**
 * Inclusive day count between two YYYY-MM-DD dates, parsed as UTC to dodge timezone drift
 */
function countDays(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86400000) + 1;
}

class LeaveService {
  /**
   * Submit a new resident leave request. total_days is derived from the date
   * range when the client omits it, and the row is always created as PENDING.
   */
  static async submitLeaveRequest(leaveData) {
    const {
      resident_id,
      leave_type,
      other_leave_specify,
      start_date,
      end_date,
      total_days,
      reason,
    } = leaveData;

    const query = `
      INSERT INTO resident_leave_requests
        (resident_id, leave_type, other_leave_specify, start_date, end_date, total_days, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING');
    `;

    const [result] = await db.query(query, [
      resident_id,
      leave_type,
      other_leave_specify || null,
      start_date,
      end_date,
      total_days || countDays(start_date, end_date),
      reason || null,
    ]);

    return {
      request_id: result.insertId,
      ...leaveData,
      status: 'PENDING',
    };
  }

  /**
   * Review and update leave request status (APPROVED / APPROVED_BY_CHIEF / REJECTED / CANCELLED).
   * Throws a 409-tagged error when the transition is not allowed by the review workflow.
   */
  static async updateLeaveStatus(requestId, statusData) {
    const { status, reviewed_by_user_id, rejection_reason } = statusData;

    const [existing] = await db.query(
      `SELECT id, status FROM resident_leave_requests WHERE id = ?`,
      [requestId]
    );

    if (existing.length === 0) {
      const error = new Error(`Leave request ${requestId} not found`);
      error.statusCode = 404;
      throw error;
    }

    const currentStatus = existing[0].status;
    if (!STATUS_TRANSITIONS[currentStatus].includes(status)) {
      const error = new Error(
        `Cannot transition leave request from ${currentStatus} to ${status}`
      );
      error.statusCode = 409;
      throw error;
    }

    const query = `
      UPDATE resident_leave_requests
      SET status = ?, reviewed_by_user_id = ?, rejection_reason = ?
      WHERE id = ?;
    `;

    await db.query(query, [
      status,
      reviewed_by_user_id || null,
      rejection_reason || null,
      requestId,
    ]);

    return {
      request_id: requestId,
      previous_status: currentStatus,
      status,
      reviewed_by_user_id: reviewed_by_user_id || null,
    };
  }

  /**
   * Fetch leave requests for a resident
   */
  static async getLeavesByResident(residentId) {
    const query = `
      SELECT
        lr.id AS request_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        lr.leave_type,
        lr.other_leave_specify,
        DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
        DATE_FORMAT(lr.end_date, '%Y-%m-%d') AS end_date,
        lr.total_days,
        lr.reason,
        lr.status,
        lr.reviewed_by_user_id,
        lr.rejection_reason,
        lr.created_at,
        lr.updated_at
      FROM resident_leave_requests lr
      JOIN residents r ON r.id = lr.resident_id
      WHERE lr.resident_id = ?
      ORDER BY lr.start_date DESC;
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }

  /**
   * Leave types accepted by the API, shared with the controller for validation
   */
  static getLeaveTypes() {
    return [...LEAVE_TYPES];
  }
}

module.exports = LeaveService;