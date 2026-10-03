const RotationService = require('../services/rotationService');
const { isCheckConstraintViolation } = require('../utils/mysqlErrors');

class RotationController {
  /**
   * GET /api/v1/rotations/blocks?program_id=1
   */
  static async getBlocks(req, res) {
    try {
      const { program_id } = req.query;

      // Validation Defense: Ensure program_id query parameter is provided
      if (!program_id) {
        return res.status(400).json({
          success: false,
          error: 'Missing required query parameter: program_id'
        });
      }

      const blocks = await RotationService.getBlocksByProgram(program_id);

      return res.status(200).json({
        success: true,
        count: blocks.length,
        data: blocks
      });
    } catch (error) {
      console.error('Error in getBlocks controller:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        details: error.message
      });
    }
  }

  /**
   * POST /api/v1/rotations/blocks
   */
  static async createBlock(req, res) {
    try {
      const { program_id, academic_year, block_number, block_name, start_date, end_date } = req.body;

      // Validation Defense: Verify all required fields exist
      if (!program_id || !academic_year || !block_number || !block_name || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields. Required: program_id, academic_year, block_number, block_name, start_date, end_date'
        });
      }

      // Call the service layer to insert into MySQL
      const newBlock = await RotationService.createBlock(req.body);

      return res.status(201).json({
        success: true,
        message: 'Academic block created successfully',
        data: newBlock
      });
    } catch (error) {
      console.error('Error in createBlock controller:', error.message);

      // Handle MySQL Duplicate Entry Constraint Error (Error Code ER_DUP_ENTRY / 1062)
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: 'Duplicate block entry. This block number already exists for this academic year.'
        });
      }

      // Handle MySQL Check Constraint Violation (Error Code ER_CHECK_CONSTRAINT_VIOLATED / 3819)
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid dates. The end_date must be greater than or equal to start_date.'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Database operation failed',
        details: error.message
      });
    }
}

  /**
   * GET /api/v1/rotations?program_id=1
   */
  static async getRotations(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const rotations = await RotationService.getRotationsByProgram(program_id);
      return res.status(200).json({ success: true, count: rotations.length, data: rotations });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch rotations', details: error.message });
    }
  }

  /**
   * POST /api/v1/rotations/assignments
   */
  static async createAssignment(req, res) {
    try {
      const { resident_id, rotation_id, rotation_block_id, start_date, end_date } = req.body;

      if (!resident_id || !rotation_id || !rotation_block_id || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: resident_id, rotation_id, rotation_block_id, start_date, end_date'
        });
      }

      const assignment = await RotationService.assignResidentToRotation(req.body);
      return res.status(201).json({
        success: true,
        message: 'Resident rotation assignment created successfully',
        data: assignment
      });
    } catch (error) {
      if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
        return res.status(404).json({
          success: false,
          error: 'Invalid foreign key reference. Ensure resident_id, rotation_id, and rotation_block_id exist.'
        });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid dates. end_date must be greater than or equal to start_date.'
        });
      }
      return res.status(500).json({ success: false, error: 'Assignment failed', details: error.message });
    }
  }

  /**
   * GET /api/v1/rotations/assignments/resident/:resident_id
   */
  static async getResidentSchedule(req, res) {
    try {
      const { resident_id } = req.params;
      const schedule = await RotationService.getScheduleByResident(resident_id);
      return res.status(200).json({ success: true, count: schedule.length, data: schedule });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch schedule', details: error.message });
    }
  }
}

module.exports = RotationController;