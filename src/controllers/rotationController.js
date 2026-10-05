const RotationService = require('../services/rotationService');
const LongitudinalService = require('../services/longitudinalService');
const { isCheckConstraintViolation } = require('../utils/mysqlErrors');

class RotationController {
  static async getBlocks(req, res) {
    try {
      const { program_id, academic_year } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required query parameter: program_id' });
      }
      const blocks = await RotationService.getBlocksByProgram(program_id, academic_year || null);
      return res.status(200).json({ success: true, count: blocks.length, data: blocks });
    } catch (error) {
      console.error('Error in getBlocks controller:', error.message);
      return res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
    }
  }

  static async createBlock(req, res) {
    try {
      const { program_id, academic_year, block_number, block_name, start_date, end_date } = req.body;
      if (!program_id || !academic_year || !block_number || !block_name || !start_date || !end_date) {
        return res.status(400).json({ success: false, error: 'Missing required fields. Required: program_id, academic_year, block_number, block_name, start_date, end_date' });
      }
      const newBlock = await RotationService.createBlock(req.body);
      return res.status(201).json({ success: true, message: 'Academic block created successfully', data: newBlock });
    } catch (error) {
      console.error('Error in createBlock controller:', error.message);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Duplicate block entry. This block number already exists for this academic year.' });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({ success: false, error: 'Invalid dates. The end_date must be greater than or equal to start_date.' });
      }
      return res.status(500).json({ success: false, error: 'Database operation failed', details: error.message });
    }
  }

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

  static async createAssignment(req, res) {
    try {
      const { resident_id, rotation_id, rotation_block_id, start_date, end_date } = req.body;
      if (!resident_id || !rotation_id || !rotation_block_id || !start_date || !end_date) {
        return res.status(400).json({ success: false, error: 'Missing required fields: resident_id, rotation_id, rotation_block_id, start_date, end_date' });
      }
      const assignment = await RotationService.assignResidentToRotation(req.body);
      return res.status(201).json({ success: true, message: 'Resident rotation assignment created successfully', data: assignment });
    } catch (error) {
      if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
        return res.status(404).json({ success: false, error: 'Invalid foreign key reference. Ensure resident_id, rotation_id, and rotation_block_id exist.' });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({ success: false, error: 'Invalid dates. end_date must be greater than or equal to start_date.' });
      }
      return res.status(500).json({ success: false, error: 'Assignment failed', details: error.message });
    }
  }

  static async getResidentSchedule(req, res) {
    try {
      const { resident_id } = req.params;
      const schedule = await RotationService.getScheduleByResident(resident_id);
      return res.status(200).json({ success: true, count: schedule.length, data: schedule });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch schedule', details: error.message });
    }
  }

  static async updateBlock(req, res) {
    try {
      const { block_id } = req.params;
      const { program_id, academic_year, block_number, block_name, start_date, end_date } = req.body;
      if (!block_id || !program_id || !academic_year || !block_number || !block_name || !start_date || !end_date) {
        return res.status(400).json({ success: false, error: 'Missing required fields.' });
      }
      const block = await RotationService.getBlockById(block_id);
      if (!block) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }
      await RotationService.updateBlock(block_id, req.body);
      const updated = await RotationService.getBlockById(block_id);
      return res.status(200).json({ success: true, data: updated });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Duplicate block entry. This block number already exists for this academic year.' });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({ success: false, error: 'Invalid dates. The end_date must be greater than or equal to start_date.' });
      }
      return res.status(500).json({ success: false, error: 'Failed to update block', details: error.message });
    }
  }

  static async deleteBlock(req, res) {
    try {
      const { block_id } = req.params;
      const block = await RotationService.getBlockById(block_id);
      if (!block) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }
      const hasDeps = await RotationService.hasDependentAssignments(block_id);
      if (hasDeps) {
        return res.status(409).json({ success: false, error: 'Cannot delete block with dependent resident assignments. Remove or reassign dependencies first.' });
      }
      await RotationService.deleteBlock(block_id);
      return res.status(200).json({ success: true, message: 'Block deleted successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to delete block', details: error.message });
    }
  }

  static async getAssignments(req, res) {
    try {
      const filters = req.query;
      const data = await RotationService.getAssignments(filters);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch assignments', details: error.message });
    }
  }

  static async getCohortGrid(req, res) {
    try {
      const { academic_year } = req.query;
      if (!academic_year) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required query parameter: academic_year' });
      }
      const data = await RotationService.getCohortGrid(req.query);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      console.error('Error in getCohortGrid controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to fetch cohort grid', details: error.message });
    }
  }

  static async getLongitudinalMatrix(req, res) {
    try {
      const { academic_year } = req.query;
      if (!academic_year) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required query parameter: academic_year' });
      }
      const data = await LongitudinalService.getLongitudinalMatrix(req.query);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      console.error('Error in getLongitudinalMatrix controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to fetch longitudinal matrix', details: error.message });
    }
  }
}

module.exports = RotationController;
