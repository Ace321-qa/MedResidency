const LongitudinalService = require('../services/longitudinalService');

class LongitudinalController {
  static async getClinicTypes(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getClinicTypes(program_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getResidentLongitudinalAssignments(req, res) {
    try {
      const { resident_id } = req.params;
      const data = await LongitudinalService.getResidentLongitudinalAssignments(resident_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getAllLongitudinalAssignments(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getAllLongitudinalAssignments(program_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getFacultySupervisors(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getFacultySupervisors(program_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getClinicSlots(req, res) {
    try {
      const { clinic_type_id } = req.query;
      if (!clinic_type_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: clinic_type_id' });
      }
      const data = await LongitudinalService.getClinicSlots(clinic_type_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getSupervisorAssignments(req, res) {
    try {
      const { program_id, clinic_type_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getSupervisorAssignments(program_id, clinic_type_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async createSupervisorAssignment(req, res) {
    try {
      const required = ['program_id', 'clinic_type_id', 'faculty_supervisor_id', 'start_date', 'end_date'];
      for (const k of required) {
        if (!req.body[k]) {
          return res.status(400).json({ success: false, error: `Missing required field: ${k}` });
        }
      }
      const data = await LongitudinalService.createSupervisorAssignment(req.body);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async rotateSupervisor(req, res) {
    try {
      const { assignment_id } = req.params;
      const { faculty_supervisor_id, start_date, end_date, notes } = req.body;
      if (!faculty_supervisor_id || !start_date || !end_date) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }
      await LongitudinalService.rotateSupervisor(assignment_id, faculty_supervisor_id, start_date, end_date, notes);
      return res.status(200).json({ success: true, message: 'Supervisor rotated successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = LongitudinalController;
