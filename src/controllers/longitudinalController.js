const LongitudinalService = require('../services/longitudinalService');

class LongitudinalController {
  static async getClinicTypes(req, res) {
    try {
      const { program_id, include_inactive } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getClinicTypes(program_id, {
        includeInactive: include_inactive === '1' || include_inactive === 'true',
      });
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `POST /longitudinal/clinic-types`
   *
   * Adds a clinic to a programme's Primary Care Clinics catalog — either a
   * pre-defined one chosen from the catalog or a hand-typed custom name. Existing
   * rows are reactivated, so this is safe to call for names already on record.
   */
  static async createClinicType(req, res) {
    try {
      const { program_id, clinic_name } = req.body;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      if (!clinic_name || !String(clinic_name).trim()) {
        return res.status(400).json({ success: false, error: 'Missing required field: clinic_name' });
      }
      const data = await LongitudinalService.createClinicType(req.body);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
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
      const { program_id, academic_year } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      // Optional: the Primary Care Clinics matrix scopes by year, a resident's
      // profile wants the whole longitudinal record.
      const data = await LongitudinalService.getAllLongitudinalAssignments(program_id, academic_year || null);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `GET /longitudinal/faculty-supervisors`
   *
   * `include_inactive=1` widens the list to departed faculty, which a
   * coordinator needs when editing an assignment that has already run.
   */
  static async getFacultySupervisors(req, res) {
    try {
      const { program_id, include_inactive, clinic_type_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getFacultySupervisors(program_id, {
        includeInactive: include_inactive === '1' || include_inactive === 'true',
        clinicTypeId: clinic_type_id || undefined,
      });
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
      const required = ['program_id', 'clinic_type_id', 'faculty_supervisor_id', 'start_date'];
      for (const k of required) {
        if (!req.body[k]) {
          return res.status(400).json({ success: false, error: `Missing required field: ${k}` });
        }
      }
      // `end_date` is derived from the start date and `rotation_period_months`,
      // so it is optional here; when it is sent it must agree.
      const data = await LongitudinalService.createSupervisorAssignment(req.body);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
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
