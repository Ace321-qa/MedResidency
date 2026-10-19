const db = require('../config/db');
const LongitudinalService = require('../services/longitudinalService');
const { buildCccTemplatePayload } = require('../services/cccTemplateService');
const { buildCccPdf } = require('../utils/pdf/matrix');
const { buildCccTemplateBuffer, parseCccMatrixFile } = require('../utils/excel/ccc');
const SupervisorService = require('../services/supervisorService');
const { generateFacultyTemplate, parseFacultyFile } = require('../utils/excel/faculty');
const { generateCccMatrixTemplate, buildDynamicTemplate } = require('../utils/excel/ccc');
const { normalizeName, bestMatch } = require('./cccMatrixController');

/**
 * Resolve a name from a filled workbook against the programme's roster or
 * faculty map: an exact normalized hit first, then the closest known key
 * within the fuzzy tolerance. The same person is spelled several ways across
 * the two sides — `Ahmad A Smith` on record, `Ahmad Smith` in the sheet — and
 * a rota written against the wrong person is worse than no import at all.
 */
function lookupFuzzy(map, name) {
  const norm = normalizeName(name);
  if (norm && map.has(norm)) return map.get(norm);
  const key = bestMatch(name, [...map.keys()]);
  return key ? map.get(key) : null;
}

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
   * Adds a clinic to a programme's Continuity of Care Clinics (CCC) catalog — either a
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

  /**
   * `PUT /longitudinal/clinic-types/:id`
   *
   * Renames (or otherwise edits) a clinic for the active programme. The row's
   * id and code never change, so slots, supervisor pairings and resident
   * assignments that reference the clinic keep resolving.
   */
  static async updateClinicType(req, res) {
    try {
      const { id } = req.params;
      const data = await LongitudinalService.updateClinicType(id, req.body.program_id, req.body);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `DELETE /longitudinal/clinic-types/:id`
   *
   * Soft-deletes a clinic (`is_active = 0`) so the chip is removed from the
   * active pool while its slots, pairings and assignment history stay intact.
   * `program_id` scopes the operation and is read from the body or the query
   * string so a plain `DELETE` request can still pin the programme.
   */
  static async deleteClinicType(req, res) {
    try {
      const { id } = req.params;
      // A body-less DELETE leaves `req.body` undefined in Express, so the query
      // string is a fallback rather than an alternative.
      const programId = (req.body ?? {}).program_id ?? req.query.program_id;
      const data = await LongitudinalService.deleteClinicType(id, programId);
      return res.status(200).json({ success: true, message: 'Clinic deactivated', data });
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
      // Optional: the Continuity of Care Clinics (CCC) matrix scopes by year, a resident's
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

  /**
   * POST /api/v1/longitudinal/supervisor-assignments/randomize
   * Body: { program_id, clinic_type_id?, rotation_months?, randomize?, rationale? }
   *
   * Reallocates supervising faculty across the clinic supervisor assignments in
   * one atomic, audited rotation run.
   */
  static async randomizeSupervisorAllocations(req, res) {
    try {
      const { program_id, clinic_type_id, rotation_months, randomize, rationale } = req.body ?? {};
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      const data = await SupervisorService.randomizeSupervisors({
        programId: program_id,
        clinicTypeId: clinic_type_id,
        rotationMonths: rotation_months,
        randomize: randomize === undefined ? true : Boolean(randomize),
        rationale,
      });
      return res.status(200).json({ success: true, ...data });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getCycleSchedule(req, res) {
    try {
      const { program_id, cycle_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getCycleSchedule(program_id, { cycleId: cycle_id });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async updateCycleHeader(req, res) {
    try {
      const { program_id } = req.body;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      const result = await LongitudinalService.updateCycleHeader(program_id, req.body);
      return res.status(200).json({
        success: true,
        data: result.cycle,
        headers: result.headers ?? [],
        header: result.header ?? null,
        slots: result.createdSlots ?? [],
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `DELETE /longitudinal/cycle-schedule/header/:id`
   *
   * Removes one day row from a cycle's CCC week (the grid's "- Remove Row"
   * control). The cycle's remaining headers come back in sequence order so the
   * caller can patch local state without a full refetch.
   */
  static async deleteCycleHeader(req, res) {
    try {
      const { program_id } = req.query;
      const { id } = req.params;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.deleteCycleHeader(program_id, id);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async updateCycleSlot(req, res) {
    try {
      const { slot_id } = req.body;
      if (!slot_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: slot_id' });
      }
      const result = await LongitudinalService.updateCycleSlot(slot_id, req.body);
      return res.status(200).json({ success: true, data: result.slot, warnings: result.warnings });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `GET /longitudinal/cycles`
   *
   * The programme's CCC cycles, oldest first, for the week navigator's cycle
   * list and academic-year filter. `start_date` is already a plain `YYYY-MM-DD`.
   */
  static async getCycles(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getCycles(program_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `GET /longitudinal/cycle-schedule/absences`
   *
   * The leave registry for a cycle: one row per resident or faculty member
   * absent on a CCC day, feeding the Leaves column's badge summary.
   */
  static async getCycleAbsences(req, res) {
    try {
      const { program_id, cycle_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getCycleAbsences(program_id, cycle_id || null);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `POST /longitudinal/cycle-schedule/absences`
   *
   * Replace one CCC day's absences from the Leaves column modal. The payload
   * carries the selected residents and faculty plus the leave reason and an
   * optional coverage note; resident absences are mirrored into the attendance
   * log server-side.
   */
  static async updateDayAbsences(req, res) {
    try {
      const { program_id, day_of_week } = req.body || {};
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      if (!day_of_week) {
        return res.status(400).json({ success: false, error: 'Missing required field: day_of_week' });
      }
      const data = await LongitudinalService.updateDayAbsences(program_id, req.body);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `GET /longitudinal/cycle-schedule/columns`
   *
   * The numbered clinic columns of the CCC grid (`Clinic 1..N`), plus any
   * coordinator-set labels. Also embedded in every cycle-schedule response.
   */
  static async getMatrixColumns(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.getMatrixColumns(program_id);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /** `POST /longitudinal/cycle-schedule/columns` — append a clinic column. */
  static async addClinicColumn(req, res) {
    try {
      const { program_id } = req.body || {};
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      const data = await LongitudinalService.addClinicColumn(program_id);
      return res.status(201).json({ success: true, count: data.length, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /** `PUT /longitudinal/cycle-schedule/columns/:clinic_number` — rename a column. */
  static async renameClinicColumn(req, res) {
    try {
      const { program_id, label } = req.body || {};
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      const data = await LongitudinalService.renameClinicColumn(program_id, req.params.clinic_number, label ?? '');
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /** `DELETE /longitudinal/cycle-schedule/columns/:clinic_number` — remove a column. */
  static async deleteClinicColumn(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const data = await LongitudinalService.deleteClinicColumn(program_id, req.params.clinic_number);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async updateBackupFaculty(req, res) {
    try {
      const { program_id, day_of_week } = req.body;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      if (!day_of_week) {
        return res.status(400).json({ success: false, error: 'Missing required field: day_of_week' });
      }
      const data = await LongitudinalService.updateBackupFaculty(program_id, req.body);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `POST /longitudinal/cycle-schedule/randomize`
   *
   * Randomise or rotate supervising faculty across a cycle's clinic slots. The
   * optional `day_of_week` restricts the shuffle to one CCC day; `rationale` is
   * recorded against every reassignment in the audit trail.
   */

  static async createFacultySupervisor(req, res) {
    try {
      const { program_id, first_name, last_name } = req.body || {};
      if (!program_id || !first_name || !last_name) {
        return res.status(400).json({ success: false, error: 'Missing required fields: program_id, first_name, last_name' });
      }
      const data = await LongitudinalService.createFacultySupervisor(req.body);
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async updateFacultySupervisor(req, res) {
    try {
      const { id } = req.params;
      const { program_id } = req.body || {};
      if (!id || !program_id) {
        return res.status(400).json({ success: false, error: 'Missing required fields: program_id' });
      }
      const data = await LongitudinalService.updateFacultySupervisor(id, program_id, req.body);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async deleteFacultySupervisor(req, res) {
    try {
      const { id } = req.params;
      const { program_id } = req.query || req.body || {};
      if (!id || !program_id) {
        return res.status(400).json({ success: false, error: 'Missing required query param: program_id' });
      }
      const data = await LongitudinalService.deleteFacultySupervisor(id, program_id);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `GET /longitudinal/faculty-supervisors/template`
   *
   * The downloadable `.xlsx` sample preceptor list: eight columns and three
   * realistic rows that demonstrate the expected formats.
   */
  static async downloadFacultyTemplate(req, res) {
    try {
      const buffer = generateFacultyTemplate();
      res.setHeader('Content-Disposition', 'attachment; filename="faculty_preceptors_template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      return res.send(buffer);
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * `POST /longitudinal/faculty-supervisors/import`
   *
   * Bulk-register preceptors from an uploaded workbook. The whole file is
   * validated before a single row is written, and the batch runs inside one
   * transaction: a rejected file rolls back and names the offending rows
   * (`Row 4: First Name and Last Name are required`) rather than leaving a
   * half-imported faculty pool behind.
   */
  static async importFacultySupervisors(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }

    const programId = Number((req.body ?? {}).program_id);
    if (!Number.isInteger(programId) || programId <= 0) {
      return res.status(400).json({ success: false, error: 'program_id is required to import faculty.' });
    }

    let parsed;
    try {
      parsed = parseFacultyFile(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ success: false, issues: [{ message: error.message }] });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const issues = [...parsed.errors];

      // Duplicates *within the file* are caught here; duplicates against the
      // database need a query, done once for the whole batch.
      const byName = new Map();
      const byEmail = new Map();
      const clean = new Set();
      for (const row of parsed.rows) {
        const nameKey = `${row.first_name} ${row.last_name}`.toLowerCase();
        const emailKey = row.email ? row.email.toLowerCase() : null;

        const nameDup = byName.get(nameKey);
        const emailDup = emailKey ? byEmail.get(emailKey) : undefined;
        if (nameDup || emailDup) {
          issues.push({
            row: row.row,
            field: nameDup ? 'Name' : 'Email',
            message: `duplicates row ${nameDup ?? emailDup} in this file`,
          });
          continue;
        }
        byName.set(nameKey, row.row);
        if (emailKey) byEmail.set(emailKey, row.row);
        clean.add(row.row);
      }

      const [existing] = await conn.query(
        'SELECT first_name, last_name, email FROM faculty_supervisors WHERE program_id = ?',
        [programId],
      );
      const existingNames = new Set(
        existing.map((f) => `${f.first_name} ${f.last_name}`.toLowerCase()),
      );
      const existingEmails = new Set(
        existing.filter((f) => f.email).map((f) => String(f.email).toLowerCase()),
      );

      for (const row of parsed.rows) {
        if (!clean.has(row.row)) continue;
        const nameKey = `${row.first_name} ${row.last_name}`.toLowerCase();
        const emailKey = row.email ? row.email.toLowerCase() : null;
        if (existingNames.has(nameKey)) {
          issues.push({
            row: row.row,
            field: 'Name',
            message: `Dr. ${row.first_name} ${row.last_name} already exists in this programme`,
          });
        } else if (emailKey && existingEmails.has(emailKey)) {
          issues.push({
            row: row.row,
            field: 'Email',
            message: `${row.email} already belongs to a faculty member`,
          });
        }
      }

      if (issues.length > 0) {
        await conn.rollback();
        return res.status(400).json({ success: false, issues });
      }

const added = [];
      for (const row of parsed.rows) {
        const [result] = await conn.query(
          `INSERT INTO faculty_supervisors
             (program_id, first_name, last_name, title, clinical_title, faculty_appointment, administrative_role, email, phone, specialty, is_active, created_at, updated_at)
            VALUES (?, ?, ?, 'Dr.', ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [programId, row.first_name, row.last_name, row.clinical_title, row.faculty_appointment, row.administrative_role, row.email, row.phone, row.specialty],
        );
        added.push(result.insertId);
      }

      await conn.commit();

      return res.status(201).json({
        success: true,
        added,
        count: added.length,
        summary: `Successfully imported ${added.length} faculty preceptor${added.length === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      await conn.rollback();
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error.message });
    } finally {
      conn.release();
    }
  }

  static async randomizeSupervisors(req, res) {
    try {
      const { program_id } = req.body;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }
      const data = await LongitudinalService.randomizeSupervisors(program_id, {
        cycleId: req.body.cycle_id,
        dayOfWeek: req.body.day_of_week || null,
        rotationMonths: req.body.rotation_months,
        randomize: req.body.randomize !== false,
        rationale: req.body.rationale || null,
      });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async downloadMatrixTemplate(req, res) {
    try {
      const options = {
        viewMode: req.query.viewMode,
        clinicCount: req.query.clinicCount,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        cycle: req.query.cycle,
        academicYear: req.query.academicYear,
        duration: req.query.duration,
        programId: req.query.program_id ? Number(req.query.program_id) : undefined,
        rotationMonths: req.query.rotationMonths ? Number(req.query.rotationMonths) : undefined,
        rationale: req.query.rationale || undefined,
      };
      let buffer;
      const bodyPayload = req.body && Array.isArray(req.body.days) && Array.isArray(req.body.columns)
        ? req.body
        : null;
      if (bodyPayload) {
        buffer = buildCccTemplateBuffer(bodyPayload);
      } else if (options.programId) {
        const payload = await buildCccTemplatePayload({ programId: options.programId, viewMode: options.viewMode === 'roster' ? 'roster' : 'matrix', rotationMonths: options.rotationMonths, rationale: options.rationale });
        buffer = buildCccTemplateBuffer(payload);
      } else if (req.query.viewMode || req.query.clinicCount) {
        buffer = buildDynamicTemplate(options);
      } else {
        buffer = generateCccMatrixTemplate();
      }
      res.setHeader('Content-Disposition', 'attachment; filename="Continuity_of_Care_Clinics_Template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      return res.send(buffer);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  static async importMatrix(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }

    const programId = Number((req.body ?? {}).program_id);
    if (!Number.isInteger(programId) || programId <= 0) {
      return res.status(400).json({ success: false, error: 'program_id is required to import the matrix.' });
    }

    let parsed;
    try {
      const columns = await LongitudinalService.getMatrixColumns(programId);
      parsed = parseCccMatrixFile(req.file.buffer, { columns });
    } catch (error) {
      return res.status(400).json({ success: false, issues: [{ message: error.message }] });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const issues = [...(parsed.errors || [])];
      const residentMap = new Map();
      const facultyMap = new Map();
      const facultyNameToId = new Map();

      const [residents] = await conn.query(
        `SELECT r.id, r.first_name, r.middle_initial, r.last_name, re.year_in_program
           FROM residents r
           INNER JOIN residency_enrollments re ON re.resident_id = r.id AND re.program_id = ?
          WHERE re.resident_status IN ('ACTIVE_FULL_TIME','ACTIVE_PART_TIME','STARTED_OFF_CYCLE','LEAVE_OF_ABSENCE')
          ORDER BY r.id`,
        [programId],
      );
      for (const r of residents) {
        const full = LongitudinalService.formatResidentName ? LongitudinalService.formatResidentName(`${r.first_name} ${r.middle_initial || ''} ${r.last_name}`) : `${r.first_name} ${r.last_name}`.trim();
        const norm = normalizeName(full);
        if (norm && !residentMap.has(norm)) {
          residentMap.set(norm, { id: r.id, name: full, pgy: r.year_in_program });
        }
      }

      const [faculty] = await conn.query(
        'SELECT id, first_name, last_name, is_active FROM faculty_supervisors WHERE program_id = ?',
        [programId],
      );
      for (const f of faculty) {
        const full = LongitudinalService.formatFacultyName ? LongitudinalService.formatFacultyName(`${f.first_name} ${f.last_name}`) : `Dr. ${f.first_name} ${f.last_name}`.trim();
        const norm = normalizeName(full);
        if (norm) {
          if (!facultyMap.has(norm)) facultyMap.set(norm, { id: f.id, name: full });
          facultyNameToId.set(norm, f.id);
        }
      }

      const clean = [];
      for (const row of parsed.rows || []) {
        let ok = true;
        const resNames = Array.isArray(row.residents) ? row.residents : [];
        let r1 = null, r2 = null;
        if (resNames[0]) {
          const n = resNames[0];
          const m = lookupFuzzy(residentMap, n);
          if (!m) {
            issues.push({ row: row.row, field: 'Resident 1', message: `Resident '${n}' not found in active program roster` });
            ok = false;
          } else { r1 = m; }
        }
        if (resNames[1]) {
          const n = resNames[1];
          const m = lookupFuzzy(residentMap, n);
          if (!m) {
            issues.push({ row: row.row, field: 'Resident 2', message: `Resident '${n}' not found in active program roster` });
            ok = false;
          } else { r2 = m; }
        }
        const facultyCell = row.faculty || null;
        let sf = null;
        if (facultyCell) {
          const m = lookupFuzzy(facultyMap, facultyCell);
          if (!m) {
            issues.push({ row: row.row, field: 'Supervising Faculty', message: `Faculty '${facultyCell}' not found in faculty list` });
            ok = false;
          } else { sf = m; }
        }
        let fic = null;
        if (row.inCharge) {
          const m = lookupFuzzy(facultyMap, row.inCharge);
          if (!m) {
            issues.push({ row: row.row, field: 'Faculty In-charge', message: `Faculty '${row.inCharge}' not found in faculty list` });
            ok = false;
          } else { fic = m; }
        }
        if (!ok) continue;
        clean.push({ ...row, r1, r2, sf, fic });
      }

      const seen = new Map();
      for (const c of clean) {
        const day = c.dayOfWeek;
        const clinic = c.clinicTitle || c.clinicNumber;
        const key = `${day}||${clinic}`.toLowerCase();
        if (seen.has(key)) {
          issues.push({ row: c.row, message: `Duplicate entry for Day and Clinic: ${day} / ${clinic}` });
          continue;
        }
        seen.set(key, c.row);
      }

      if (issues.length > 0) {
        await conn.rollback();
        return res.status(400).json({ success: false, issues });
      }

      let cycleId = null;
      const meta = parsed.metadata || {};
      if (req.body.cycle_id) {
        cycleId = Number(req.body.cycle_id);
      } else {
        const cn = meta.cycleNumber ? (String(meta.cycleNumber).toLowerCase().startsWith('cycle') ? String(meta.cycleNumber) : `Cycle ${meta.cycleNumber}`) : null;
        const sd = meta.weekStartCalendarDate || meta.startDate || null;
        if (cn && sd) {
          const [rows] = await conn.query('SELECT id FROM primary_care_cycles WHERE program_id = ? AND cycle_number = ? AND start_date = ?', [programId, cn, sd]);
          if (rows[0]) cycleId = rows[0].id;
        }
        if (!cycleId && cn) {
          const [rows] = await conn.query('SELECT id FROM primary_care_cycles WHERE program_id = ? AND cycle_number = ? ORDER BY id DESC LIMIT 1', [programId, cn]);
          if (rows[0]) cycleId = rows[0].id;
        }
      }
      if (!cycleId) {
        const [rows] = await conn.query('SELECT id FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
        if (rows[0]) cycleId = rows[0].id;
      }
      if (!cycleId) {
        const [res] = await conn.query('INSERT INTO primary_care_cycles (program_id, cycle_number, week_number, start_date) VALUES (?, ?, ?, CURDATE())', [programId, 'Cycle 1', 'Week 1']);
        cycleId = res.insertId;
      }

      // The clinic columns are read once for the whole import; a sheet whose
      // title names a column the programme does not have yet appends it and
      // refreshes the cached list rather than re-reading per row.
      let matrixColumns = await LongitudinalService.getMatrixColumns(programId);

      let inserted = 0;
      const sessions = [];
      for (const c of clean) {
        const dow = c.dayOfWeek;
        const shift = c.shift;
        const [h] = await conn.query('SELECT id, in_charge_faculty_id, in_charge_faculty_name FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ?', [cycleId, dow]);
        let headerId = h[0]?.id;
        const inChargeName = c.fic?.name || h[0]?.in_charge_faculty_name || null;
        const inChargeId = c.fic?.id || h[0]?.in_charge_faculty_id || null;
        if (!headerId) {
          const [r] = await conn.query('INSERT INTO primary_care_daily_headers (cycle_id, day_of_week, shift_time, pgy_level, in_charge_faculty_id, in_charge_faculty_name) VALUES (?, ?, ?, ?, ?, ?)', [cycleId, dow, shift, c.pgy, inChargeId, inChargeName]);
          headerId = r.insertId;
        } else {
          await conn.query('UPDATE primary_care_daily_headers SET shift_time = COALESCE(NULLIF(?, ""), shift_time), pgy_level = COALESCE(NULLIF(?, ""), pgy_level), in_charge_faculty_id = COALESCE(?, in_charge_faculty_id), in_charge_faculty_name = COALESCE(NULLIF(?, ""), in_charge_faculty_name) WHERE id = ?', [shift, c.pgy, inChargeId, inChargeName, headerId]);
        }

        let clinicNum = c.clinicNumber;
        if (!clinicNum && c.clinicTitle) {
          const m2 = String(c.clinicTitle).match(/(\d+)/);
          if (m2) clinicNum = Number(m2[1]);
        }
        if (!clinicNum) clinicNum = 1;
        if (!matrixColumns.find((x) => Number(x.clinic_number) === Number(clinicNum))) {
          matrixColumns = await LongitudinalService.addClinicColumn(programId);
        }

        const [slot] = await conn.query('SELECT id FROM primary_care_clinic_slots WHERE daily_header_id = ? AND clinic_number = ?', [headerId, clinicNum]);
        if (slot[0]) {
          await conn.query('UPDATE primary_care_clinic_slots SET resident_1_name = ?, resident_2_name = ?, faculty_name = ?, faculty_id = ? WHERE id = ?', [c.r1.name, c.r2?.name || null, c.sf?.name || null, c.sf?.id || null, slot[0].id]);
        } else {
          await conn.query('INSERT INTO primary_care_clinic_slots (daily_header_id, clinic_number, resident_1_name, resident_2_name, faculty_name, faculty_id) VALUES (?, ?, ?, ?, ?, ?)', [headerId, clinicNum, c.r1.name, c.r2?.name || null, c.sf?.name || null, c.sf?.id || null]);
        }
        inserted++;
        sessions.push(dow);
      }

      await conn.commit();
      return res.status(201).json({
        success: true,
        count: inserted,
        sessions: [...new Set(sessions)].length,
        summary: `Successfully imported ${inserted} clinic slots across ${[...new Set(sessions)].length} sessions`,
      });
    } catch (error) {
      await conn.rollback();
      if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    } finally {
      conn.release();
    }
  }

  static async exportMatrixPdf(req, res) {
    try {
      const programId = Number(req.query.program_id || req.body?.program_id);
      if (!Number.isInteger(programId) || programId <= 0) {
        return res.status(400).json({ success: false, error: 'program_id is required' });
      }
      const payload = await buildCccTemplatePayload({
        programId,
        viewMode: (req.query.viewMode || req.body?.viewMode) === 'roster' ? 'roster' : 'matrix',
        rotationMonths: req.query.rotationMonths ? Number(req.query.rotationMonths) : (req.body?.rotationMonths ? Number(req.body.rotationMonths) : undefined),
        rationale: req.query.rationale || req.body?.rationale || undefined,
      });
      const buffer = buildCccPdf(payload);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuity_of_Care_Clinics.pdf"');
      return res.send(buffer);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }
}

module.exports = LongitudinalController;