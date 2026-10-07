const db = require('../config/db');
const {
  generateMasterGridTemplate,
  parseMasterGrid,
  generateCccTemplate,
  parseCcc,
} = require('../utils/excel/grid');
const { academicYearMatchValues } = require('../utils/academicYear');

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/** `sunday`, `Sun` and `SUN` all become `SUNDAY`; anything else is `null`. */
function normalizeDay(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (DAYS.includes(text)) return text;
  if (text.length < 2) return null;
  return DAYS.find((day) => day.startsWith(text.slice(0, 3))) ?? null;
}

/** Split a comma/newline separated list into trimmed, non-empty tokens. */
function tokens(value) {
  return String(value ?? '')
    .replace(/[\r\n;]+/g, ',')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

/** Whole weeks between two `YYYY-MM-DD` dates, to two decimals. */
function weeksBetween(startDate, endDate) {
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 864e5;
  if (!Number.isFinite(days)) return 4;
  return Math.round(((days + 1) / 7) * 100) / 100 || 4;
}

async function resolveProgram(conn, requestedId) {
  const programId = Number(requestedId) || null;
  const [rows] = programId
    ? await conn.query('SELECT id, program_name FROM programs WHERE id = ?', [programId])
    : await conn.query('SELECT id, program_name FROM programs ORDER BY id ASC LIMIT 1');
  return rows[0] ?? null;
}

class RotationImportController {
  static async masterTemplate(req, res) {
    try {
      res.setHeader('Content-Disposition', 'attachment; filename="master_grid_template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(generateMasterGridTemplate(13));
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async cccTemplate(req, res) {
    try {
      res.setHeader('Content-Disposition', 'attachment; filename="ccc_matrix_template.xlsx"');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(generateCccTemplate());
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Import the cohort master grid.
   *
   * One row per resident, one column per block, the cell naming a rotation. The
   * block supplies the dates and the rotation supplies the identity; every cell
   * is validated before anything is written, and a cell names a rotation that
   * does not exist it comes back as a row/column error rather than being
   * skipped. A silently skipped block is a resident with no rota.
   */
  static async importMaster(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }

    let parsed;
    try {
      parsed = parseMasterGrid(req.file.buffer);
    } catch (error) {
      return res
        .status(400)
        .json({ success: false, issues: [{ field: 'File', message: error.message }] });
    }

    const academicYear = String(req.body.academic_year ?? '').trim();

    const conn = await db.getConnection();
    try {
      const program = await resolveProgram(conn, req.body.program_id);
      if (!program) {
        return res
          .status(400)
          .json({ success: false, issues: [{ field: 'Programme', message: 'no programme exists' }] });
      }
      if (!academicYear) {
        return res.status(400).json({
          success: false,
          issues: [{ field: 'Academic year', message: 'is required' }],
        });
      }

      const yearValues = academicYearMatchValues(academicYear);
      const [blocks] = await conn.query(
        `SELECT id, block_number, start_date, end_date
           FROM rotation_blocks
          WHERE program_id = ? AND is_active = 1 AND academic_year IN (?)
          ORDER BY block_number ASC`,
        [program.id, yearValues],
      );
      if (!blocks.length) {
        return res.status(400).json({
          success: false,
          issues: [
            {
              field: 'Academic year',
              message: `no active rotation blocks exist for ${academicYear}. Create the block calendar first.`,
            },
          ],
        });
      }
      const blocksByNumber = new Map(blocks.map((block) => [block.block_number, block]));

      const [rotations] = await conn.query(
        `SELECT id, rotation_code, rotation_name
           FROM rotations
          WHERE program_id = ? AND is_active = 1`,
        [program.id],
      );
      const rotationsByName = new Map();
      for (const rotation of rotations) {
        rotationsByName.set(rotation.rotation_name.trim().toLowerCase(), rotation);
        rotationsByName.set(rotation.rotation_code.trim().toLowerCase(), rotation);
      }

      const issues = [];
      if (parsed.cells.length === 0) {
        issues.push({ field: 'File', message: 'no resident rows were found under the header' });
      }

      const corporateIds = [...new Set(parsed.cells.map((cell) => cell.corporateId))].filter(
        (id) => id !== '',
      );
      const residentsByCorporateId = new Map();
      if (corporateIds.length > 0) {
        const [residents] = await conn.query(
          `SELECT r.id, ri.identifier_value
             FROM residents r
             JOIN resident_identifiers ri
               ON ri.resident_id = r.id AND ri.identifier_type = 'CORPORATE_ID'
             JOIN residency_enrollments e
               ON e.resident_id = r.id AND e.program_id = ?
            WHERE ri.identifier_value IN (?)`,
          [program.id, corporateIds],
        );
        for (const resident of residents) {
          residentsByCorporateId.set(resident.identifier_value, resident.id);
        }
      }

      const planned = [];
      for (const cell of parsed.cells) {
        if (cell.corporateId === '') {
          issues.push({ row: cell.row, field: 'Corporate ID', message: 'is required' });
          continue;
        }
        const residentId = residentsByCorporateId.get(cell.corporateId);
        if (!residentId) {
          issues.push({
            row: cell.row,
            field: 'Corporate ID',
            message: `${cell.corporateId} is not an enrolled resident in ${program.program_name}`,
          });
          continue;
        }
        for (const [numberText, rotationName] of Object.entries(cell.rotations)) {
          const blockNumber = Number(numberText);
          const block = blocksByNumber.get(blockNumber);
          if (!block) {
            issues.push({
              row: cell.row,
              field: `Block ${blockNumber}`,
              message: `has no rotation block in ${academicYear}`,
            });
            continue;
          }
          const rotation = rotationsByName.get(rotationName.trim().toLowerCase());
          if (!rotation) {
            issues.push({
              row: cell.row,
              field: `Block ${blockNumber}`,
              message: `"${rotationName}" is not a rotation in this programme`,
            });
            continue;
          }
          planned.push({ residentId, block, rotation });
        }
      }

      if (issues.length > 0) {
        return res.status(400).json({ success: false, issues });
      }

      await conn.beginTransaction();
      for (const entry of planned) {
        await conn.query(
          'DELETE FROM resident_rotation_assignments WHERE resident_id = ? AND rotation_block_id = ?',
          [entry.residentId, entry.block.id],
        );
        await conn.query(
          `INSERT INTO resident_rotation_assignments
             (resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type)
           VALUES (?, ?, ?, ?, ?, ?, 'FULL_BLOCK')`,
          [
            entry.residentId,
            entry.rotation.id,
            entry.block.id,
            entry.block.start_date,
            entry.block.end_date,
            weeksBetween(entry.block.start_date, entry.block.end_date),
          ],
        );
      }
      await conn.commit();

      return res.json({
        success: true,
        updated: planned.length,
        summary: `${planned.length} block assignment${planned.length === 1 ? '' : 's'} saved across ${
          parsed.cells.length
        } resident row${parsed.cells.length === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      await conn.rollback();
      return res.status(400).json({ success: false, error: error.message });
    } finally {
      conn.release();
    }
  }

  /**
   * Import the CCC longitudinal matrix.
   *
   * Each row names an academic day and clinic, the residents paired to it and
   * the faculty leading it. The clinic resolves against this programme's clinic
   * types (by name, or failing that by day); residents must resolve to enrolled
   * residents. Faculty leads are stored by name and linked to a supervisor
   * record only when one matches — the faculty register is often sparse, and a
   * missing link must not stop the pairing being recorded.
   */
  static async importCcc(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file was uploaded.' });
    }

    let parsed;
    try {
      parsed = parseCcc(req.file.buffer);
    } catch (error) {
      return res
        .status(400)
        .json({ success: false, issues: [{ field: 'File', message: error.message }] });
    }

    const academicYear = String(req.body.academic_year ?? '').trim();

    const conn = await db.getConnection();
    try {
      const program = await resolveProgram(conn, req.body.program_id);
      if (!program) {
        return res
          .status(400)
          .json({ success: false, issues: [{ field: 'Programme', message: 'no programme exists' }] });
      }
      if (!academicYear) {
        return res.status(400).json({
          success: false,
          issues: [{ field: 'Academic year', message: 'is required' }],
        });
      }

      const yearValues = academicYearMatchValues(academicYear);
      const [window] = await conn.query(
        `SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
           FROM rotation_blocks
          WHERE program_id = ? AND is_active = 1 AND academic_year IN (?)`,
        [program.id, yearValues],
      );
      if (!window[0]?.start_date || !window[0]?.end_date) {
        return res.status(400).json({
          success: false,
          issues: [
            {
              field: 'Academic year',
              message: `no active rotation blocks exist for ${academicYear}, so the CCC window cannot be determined. Create the block calendar first.`,
            },
          ],
        });
      }
      const windowStart = window[0].start_date;
      const windowEnd = window[0].end_date;

      const [clinics] = await conn.query(
        `SELECT id, clinic_name, default_day_of_week, start_time, end_time
           FROM longitudinal_clinic_types
          WHERE program_id = ? AND is_active = 1`,
        [program.id],
      );

      const [slotSites] = await conn.query(
        `SELECT clinic_type_id, site_name
           FROM longitudinal_clinic_slots
          WHERE is_active = 1 AND site_name IS NOT NULL AND site_name <> ''`,
      );
      const siteByClinic = new Map();
      for (const slot of slotSites) {
        if (!siteByClinic.has(slot.clinic_type_id)) siteByClinic.set(slot.clinic_type_id, slot.site_name);
      }

      const [residents] = await conn.query(
        `SELECT r.id, r.first_name, r.last_name, ri.identifier_value
           FROM residents r
           JOIN residency_enrollments e ON e.resident_id = r.id AND e.program_id = ?
           LEFT JOIN resident_identifiers ri
             ON ri.resident_id = r.id AND ri.identifier_type = 'CORPORATE_ID'`,
        [program.id],
      );
      const residentsByIdentifier = new Map();
      const residentsByName = new Map();
      for (const resident of residents) {
        if (resident.identifier_value) {
          residentsByIdentifier.set(String(resident.identifier_value).trim(), resident.id);
        }
        residentsByName.set(`${resident.first_name} ${resident.last_name}`.trim().toLowerCase(), resident.id);
      }

      const [faculty] = await conn.query(
        `SELECT id, first_name, last_name
           FROM faculty_supervisors
          WHERE program_id = ? AND is_active = 1`,
        [program.id],
      );
      const facultyByName = new Map();
      for (const supervisor of faculty) {
        facultyByName.set(`${supervisor.first_name} ${supervisor.last_name}`.trim().toLowerCase(), supervisor.id);
      }

      const issues = [];
      if (parsed.rows.length === 0) {
        issues.push({ field: 'File', message: 'no clinic rows were found under the header' });
      }

      const planned = [];
      for (const row of parsed.rows) {
        const [dayPart, ...nameParts] = row.dayClinic.split(/[—–\-:]/).map((part) => part.trim());
        const day = normalizeDay(dayPart);
        const clinicName = nameParts.join(' ').trim().toLowerCase();

        let clinic = null;
        if (clinicName) {
          clinic = clinics.find((candidate) => candidate.clinic_name.trim().toLowerCase() === clinicName);
          if (!clinic) {
            clinic = clinics.find((candidate) => {
              const name = candidate.clinic_name.trim().toLowerCase();
              return name.includes(clinicName) || clinicName.includes(name);
            });
          }
        }
        if (!clinic && day) clinic = clinics.find((candidate) => candidate.default_day_of_week === day);
        if (!clinic) {
          issues.push({
            row: row.row,
            field: 'Academic Day / Clinic',
            message: `"${row.dayClinic}" does not match a clinic in this programme`,
          });
          continue;
        }

        const resolvedDay = day ?? normalizeDay(clinic.default_day_of_week);
        if (!resolvedDay) {
          issues.push({
            row: row.row,
            field: 'Academic Day / Clinic',
            message: `"${row.dayClinic}" does not name a day of the week`,
          });
          continue;
        }

        const pairingTokens = tokens(row.pairings);
        if (pairingTokens.length === 0) {
          issues.push({ row: row.row, field: 'Resident Pairings', message: 'needs at least one resident' });
          continue;
        }

        const facultyNames = tokens(row.faculty);
        let rowHadBadResident = false;
        for (const token of pairingTokens) {
          const residentId =
            residentsByIdentifier.get(token) ?? residentsByName.get(token.toLowerCase()) ?? null;
          if (!residentId) {
            issues.push({
              row: row.row,
              field: 'Resident Pairings',
              message: `"${token}" is not an enrolled resident`,
            });
            rowHadBadResident = true;
          }
        }
        if (rowHadBadResident) continue;

        for (const token of pairingTokens) {
          const residentId =
            residentsByIdentifier.get(token) ?? residentsByName.get(token.toLowerCase()) ?? null;
          planned.push({
            row: row.row,
            residentId,
            clinic,
            day: resolvedDay,
            facultyNames,
            facultyIds: facultyNames.map((name) => facultyByName.get(name.toLowerCase()) ?? null),
            site: siteByClinic.get(clinic.id) ?? '',
            notes: row.catchup ? `Catch-up pool: ${row.catchup}` : null,
            startDate: windowStart,
            endDate: windowEnd,
          });
        }
      }

      if (issues.length > 0) {
        return res.status(400).json({ success: false, issues });
      }

      await conn.beginTransaction();
      for (const entry of planned) {
        await conn.query(
          `DELETE FROM resident_longitudinal_assignments
            WHERE resident_id = ? AND clinic_type_id = ? AND day_of_week = ?`,
          [entry.residentId, entry.clinic.id, entry.day],
        );
        await conn.query(
          `INSERT INTO resident_longitudinal_assignments
             (resident_id, clinic_type_id, site_name, supervisor_name, faculty_supervisor_id,
              day_of_week, start_time, end_time, start_date, end_date, notes, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            entry.residentId,
            entry.clinic.id,
            entry.site,
            entry.facultyNames.join(', ') || '',
            entry.facultyIds.find((id) => id != null) ?? null,
            entry.day,
            entry.clinic.start_time ?? '10:30:00',
            entry.clinic.end_time ?? '14:00:00',
            entry.startDate,
            entry.endDate,
            entry.notes,
          ],
        );
      }
      await conn.commit();

      return res.json({
        success: true,
        updated: planned.length,
        summary: `${planned.length} clinic pairing${planned.length === 1 ? '' : 's'} saved across ${
          parsed.rows.length
        } clinic row${parsed.rows.length === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      await conn.rollback();
      return res.status(400).json({ success: false, error: error.message });
    } finally {
      conn.release();
    }
  }
}

module.exports = RotationImportController;