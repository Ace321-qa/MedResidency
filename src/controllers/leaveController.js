const LeaveService = require('../services/leaveService');
const {
  isCheckConstraintViolation,
  isForeignKeyViolation,
  isEnumViolation,
} = require('../utils/mysqlErrors');

class LeaveController {
  /**
   * POST /api/v1/leaves/request
   */
  static async requestLeave(req, res) {
    try {
      const {
        resident_id,
        leave_type,
        other_leave_specify,
        start_date,
        end_date,
        total_days,
        reason,
      } = req.body;

      if (!resident_id || !leave_type || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          error:
            'Missing required fields: resident_id, leave_type, start_date, end_date',
        });
      }

      const validTypes = LeaveService.getLeaveTypes();
      if (!validTypes.includes(leave_type)) {
        return res.status(400).json({
          success: false,
          error: `Invalid leave_type value. Must be one of: ${validTypes.join(', ')}`,
        });
      }

      if (leave_type === 'OTHER_LEAVE' && !other_leave_specify) {
        return res.status(400).json({
          success: false,
          error: 'other_leave_specify is required when leave_type is OTHER_LEAVE',
        });
      }

      const request = await LeaveService.submitLeaveRequest(req.body);

      return res.status(201).json({
        success: true,
        message: 'Leave request submitted successfully',
        data: request,
      });
    } catch (error) {
      console.error('Error in requestLeave controller:', error.message);

      if (isForeignKeyViolation(error)) {
        return res.status(404).json({
          success: false,
          error: 'Invalid foreign key reference. Ensure resident_id exists.',
        });
      }

      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid dates. The end_date must be greater than or equal to start_date.',
        });
      }

      if (isEnumViolation(error)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid value submitted for a leave field.',
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Database operation failed',
        details: error.message,
      });
    }
  }

  /**
   * GET /api/v1/leaves/resident/:resident_id
   */
  static async getResidentLeaves(req, res) {
    try {
      const { resident_id } = req.params;
      const leaves = await LeaveService.getLeavesByResident(resident_id);

      return res.status(200).json({
        success: true,
        count: leaves.length,
        data: leaves,
      });
    } catch (error) {
      console.error('Error in getResidentLeaves controller:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch leave requests',
        details: error.message,
      });
    }
  }

  /**
   * PATCH /api/v1/leaves/:id/status
   */
  static async updateStatus(req, res) {
    try {
      const { id } = req.params;
      const { status, reviewed_by_user_id, rejection_reason } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          error:
            'Missing required field: status. Must be one of: APPROVED, APPROVED_BY_CHIEF, REJECTED, CANCELLED',
        });
      }

      const validStatuses = ['PENDING', 'APPROVED_BY_CHIEF', 'APPROVED', 'REJECTED', 'CANCELLED'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status value. Must be one of: ${validStatuses.join(', ')}`,
        });
      }

      if (status === 'REJECTED' && !rejection_reason) {
        return res.status(400).json({
          success: false,
          error: 'rejection_reason is required when a request is REJECTED',
        });
      }

      const updated = await LeaveService.updateLeaveStatus(id, req.body);

      return res.status(200).json({
        success: true,
        message: `Leave request ${id} updated to ${status}`,
        data: updated,
      });
    } catch (error) {
      console.error('Error in updateLeaveStatus controller:', error.message);

      if (error.statusCode === 404) {
        return res.status(404).json({ success: false, error: error.message });
      }

      if (error.statusCode === 409) {
        return res.status(409).json({ success: false, error: error.message });
      }

      return res.status(500).json({
        success: false,
        error: 'Database operation failed',
        details: error.message,
      });
    }
  }
}

module.exports = LeaveController;