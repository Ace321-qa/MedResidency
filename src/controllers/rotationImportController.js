const db = require('../config/db');
const {
  generateMasterGridTemplate,
  parseMasterGrid,
  generateCccTemplate,
  parseCcc,
} = require('../utils/excel/grid');
const { academicYearMatchValues } = require('../utils/academicYear');
const { MAX_ABBREVIATION_LENGTH, MAX_NAME_LENGTH } = require('../utils/excel/catalogue');
const {
  WEEKS_PER_BLOCK,
  clampWindow,
  weekWindow,
  weeksSpanned,
} = require('../utils/masterGridCalendar');

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

/**
 * Consecutive weeks carrying the same rotation, inside one block.
 *
 * `[{1,MED},{2,MED},{3,NICU},{4,NICU}]` becomes two runs — the shape a split
 * block has — while `[{1,MED},{2,MED},{3,MED},{4,MED}]` stays one run of four,
 * which is what makes a full-block rotation a single `FULL_BLOCK` row instead of
 * four. Gaps (`week 1` and `week 3` only) break the run deliberately: two
 * separate postings are two separate windows.
 *
 * Runs compare `rotation.identity` rather than `rotation.id`: a rotation the
 * import is about to catalogue has no id yet, and every pending week of it must
 * still group into the same run. The identity is `id:<n>` for a stored rotation
 * and `new:<key>` for one being created.
 *
 * @param {{week:number, rotation:{identity:string}}[]} entries Sorted by week.
 */
function runsOf(entries) {
  const runs = [];
  for (const entry of entries) {
    const current = runs[runs.length - 1];
    if (
      current &&
      current.rotation.identity === entry.rotation.identity &&
      entry.week === current.weeks[current.weeks.length - 1] + 1
    ) {
      current.weeks.push(entry.week);
      continue;
    }
    runs.push({ rotation: entry.rotation, weeks: [entry.week] });
  }
  return runs;
}

/**
 * How many warnings a single import carries into the response before the rest
 * are counted but not listed — a spreadsheet with a 52-week hole in every row
 * should still return a readable payload.
 */
const MAX_WARNINGS = 50;

/**
 * The key a rotation name or abbreviation matches on: lower-cased, with
 * punctuation collapsed to single spaces, so `Medicine Inpatient`,
 * `medicine  inpatient` and `MEDICINE-INPATIENT` are all one rotation.
 */
function rotationMatchKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The looser key behind the contains-fallback: no spaces either, so `PHC Clinic`
 * and `PHCCLINIC` line up. Only used after the exact key has missed.
 */
function rotationLooseKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
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
   * One row per resident, one column per week — 52 weeks across 13 blocks,
   * starting Sunday 28/06/2026. A 4-week rotation is one run of four weeks and
   * becomes one `FULL_BLOCK` assignment; a split block (2 weeks here, 2 there)
   * becomes one `PARTIAL_BLOCK` assignment per run, each carrying its own
   * date window, which is exactly how the grid draws it back.
   *
   * Validation is strict about *who* (an unknown Corporate ID aborts the file,
   * because a half-imported roster cannot be untangled) and forgiving about
   * *what*: a rotation name this programme has never catalogued is matched
   * case- and punctuation-insensitively against the catalogue by name and code,
   * and anything still unknown is catalogued as a new active rotation for the
   * programme — the grid is the institution's source of truth for its own
   * rota — so a workbook typed one abbreviation at a time imports cleanly.
   *
   * A week the file leaves blank stays blank (the merged-cell forward-fill has
   * already run in the parser), a week marked `Off`/`Unassigned` is an explicit
   * vacancy, and a week whose block calendar does not exist yet is skipped with
   * a warning — none of them fail the file, because the remaining weeks are
   * still exactly what the coordinator entered.
   *
   * Sample rows shipped with the template (`SAMPLE-001`, …) are skipped, so a
   * workbook uploaded untouched imports nothing instead of failing on two
   * residents who do not exist.
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
    let inTransaction = false;
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
        `SELECT id, block_number, block_name,
                DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date_iso,
                DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date_iso
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

      /**
       * Which block a week lands in.
       *
       * The date window wins, because that is what the workbook's column heads
       * say; a programme whose block dates have drifted off the 28/06 grid falls
       * back to the block number, which is what the merged "Block N" heading in
       * the file means.
       *
       * @returns {typeof blocks[number]|null}
       */
      const blockForWeek = (week) => {
        const window = weekWindow(week);
        if (!window) return null;
        const contained = blocks.find(
          (block) => block.start_date_iso <= window.start && window.start <= block.end_date_iso,
        );
        return contained ?? blocksByNumber.get(Math.ceil(week / WEEKS_PER_BLOCK)) ?? null;
      };

      const [rotations] = await conn.query(
        `SELECT id, rotation_code, rotation_name
           FROM rotations
          WHERE program_id = ? AND is_active = 1`,
        [program.id],
      );
      // Every code the programme has ever used, active or not, so an
      // auto-catalogued abbreviation cannot collide with a retired one.
      const [codeRows] = await conn.query(
        'SELECT rotation_code FROM rotations WHERE program_id = ?',
        [program.id],
      );
      const takenCodes = new Set(
        codeRows.map((row) => String(row.rotation_code ?? '').trim().toLowerCase()).filter(Boolean),
      );

      // rotation key -> rotation. Stored rotations carry their id; a rotation
      // this import is about to catalogue carries `id: null` until the
      // transaction inserts it. Both live in the same maps so the same cell
      // spelling always resolves to the same object (and thus the same run).
      const exactByKey = new Map();
      const looseByKey = new Map();
      const registerKeys = (rotation, name, code) => {
        const exact = rotationMatchKey(name);
        if (exact && !exactByKey.has(exact)) exactByKey.set(exact, rotation);
        const loose = rotationLooseKey(name);
        if (loose && !looseByKey.has(loose)) looseByKey.set(loose, rotation);
        if (code === undefined || code === null) return;
        const codeExact = rotationMatchKey(code);
        if (codeExact && !exactByKey.has(codeExact)) exactByKey.set(codeExact, rotation);
        const codeLoose = rotationLooseKey(code);
        if (codeLoose && !looseByKey.has(codeLoose)) looseByKey.set(codeLoose, rotation);
      };
      for (const rotation of rotations) {
        rotation.identity = `id:${rotation.id}`;
        registerKeys(rotation, rotation.rotation_name, rotation.rotation_code);
      }

      /**
       * The rotation a cell names — never a rejection.
       *
       * Exact key first (`medicine inpatient` = `MEDICINE INPATIENT`), then the
       * no-punctuation key (`PHCC` = `PHC-CC`), then a contains match between
       * 4-character keys (`Cardio` finds `Cardiology`) as a deliberate
       * near-miss fallback. Anything left over is catalogued as a new rotation
       * for this programme and registered in the maps, so the next cell with
       * the same spelling joins its run instead of cataloguing twice.
       *
       * Returns `null` only when the cell carries no name at all.
       */
      const resolveRotation = (value) => {
        const name = String(value)
          .trim()
          .slice(0, MAX_NAME_LENGTH);
        const exact = exactByKey.get(rotationMatchKey(name));
        if (exact) return exact;
        const loose = rotationLooseKey(name);
        if (!loose) return null;
        const near = looseByKey.get(loose);
        if (near) return near;
        if (loose.length >= 4) {
          for (const [key, rotation] of looseByKey) {
            if (key.length >= 4 && (key.includes(loose) || loose.includes(key))) return rotation;
          }
        }
        const pending = { id: null, rotation_name: name, rotation_code: null, identity: `new:${loose}` };
        registerKeys(pending, name);
        return pending;
      };

      const issues = [];
      if (parsed.cells.length === 0) {
        issues.push({ field: 'File', message: 'no resident rows were found under the header' });
      }

      // Non-fatal: cells the import cannot place. The file still succeeds —
      // a missing block in week 40 must not throw away weeks 1-39 — but the
      // coordinator is told exactly what was left unassigned.
      const warnings = [];
      let skippedCells = 0;
      let vacantCells = 0;
      const warn = (row, field, message) => {
        skippedCells += 1;
        if (warnings.length < MAX_WARNINGS) warnings.push({ row, field, message });
      };

      const residentCells = parsed.cells.filter(
        (cell) => !/^sample/i.test(String(cell.corporateId ?? '')),
      );
      const sampleRows = parsed.cells.length - residentCells.length;

      const corporateIds = [...new Set(residentCells.map((cell) => cell.corporateId))].filter(
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
      for (const cell of residentCells) {
        if (cell.corporateId === '') {
          issues.push({ row: cell.row, field: 'Corporate ID', message: 'is required' });
          continue;
        }
        const residentId = residentsByCorporateId.get(cell.corporateId);
        if (!residentId) {
          issues.push({
            row: cell.row,
            field: 'Corporate ID',
            message: `${cell.corporateId} not found`,
          });
          continue;
        }

        const weeks = Object.keys(cell.weeks)
          .map(Number)
          .sort((left, right) => left - right);
        if (weeks.length === 0) continue;

        // Resolve every week first, so one bad cell reports its own row/column
        // instead of failing halfway through a write.
        const byBlock = new Map();
        for (const week of weeks) {
          const rotationName = cell.weeks[week];
          if (rotationName == null) {
            // An explicit `Off`/`Unassigned`/`-` marker (the parser stores
            // those as null): a vacancy the coordinator asked for, not a
            // missing rotation.
            vacantCells += 1;
            continue;
          }
          const block = blockForWeek(week);
          if (!block) {
            warn(cell.row, `Week ${week}`, `has no rotation block in ${academicYear} — left unassigned`);
            continue;
          }
          const rotation = resolveRotation(rotationName);
          if (!rotation) {
            warn(cell.row, `Week ${week}`, `"${rotationName}" does not name a rotation — left unassigned`);
            continue;
          }
          if (!byBlock.has(block)) byBlock.set(block, []);
          byBlock.get(block).push({ week, rotation });
        }

        for (const [block, entries] of byBlock) {
          for (const run of runsOf(entries)) {
            const first = weekWindow(run.weeks[0]);
            const last = weekWindow(run.weeks[run.weeks.length - 1]);
            const window = clampWindow(first.start, last.end, block.start_date_iso, block.end_date_iso);
            if (!window) {
              warn(
                cell.row,
                `Week ${run.weeks[0]}`,
                `falls outside ${block.block_name} (${block.start_date_iso} to ${block.end_date_iso}) — left unassigned`,
              );
              continue;
            }
            planned.push({ residentId, block, rotation: run.rotation, window });
          }
        }
      }

      if (issues.length > 0) {
        return res.status(400).json({ success: false, issues });
      }
      if (planned.length === 0) {
        const detail =
          skippedCells > 0
            ? `no week could be placed against the ${academicYear} block calendar (${skippedCells} cell${
                skippedCells === 1 ? '' : 's'
              } left unassigned)`
            : 'no rotation cells were filled in under the header';
        return res.status(400).json({
          success: false,
          issues: [{ field: 'File', message: detail }],
        });
      }

      await conn.beginTransaction();
      inTransaction = true;

      // Auto-catalogue: rotations the workbook named that this programme did
      // not have. Inserted inside the transaction, after planning and before
      // any assignment references them, so a later failure — or a request that
      // never reaches here — leaves no catalogue rows behind.
      const createdRotations = [];
      for (const entry of planned) {
        if (entry.rotation.id != null) continue;
        const name = String(entry.rotation.rotation_name).trim();
        const base = name.toUpperCase().slice(0, MAX_ABBREVIATION_LENGTH);
        let code = base;
        let suffix = 2;
        while (takenCodes.has(code.toLowerCase())) {
          const tail = `-${suffix}`;
          code = `${base.slice(0, MAX_ABBREVIATION_LENGTH - tail.length)}${tail}`;
          suffix += 1;
        }
        takenCodes.add(code.toLowerCase());
        const [result] = await conn.query(
          `INSERT INTO rotations (program_id, rotation_code, rotation_name, department_name)
           VALUES (?, ?, ?, ?)`,
          [program.id, code, name, name],
        );
        entry.rotation.id = result.insertId;
        entry.rotation.rotation_code = code;
        entry.rotation.identity = `id:${result.insertId}`;
        createdRotations.push(name);
      }

      // The sheet is authoritative for a block it fills: replace whatever was
      // there rather than layering a second set of rows over it.
      const wiped = new Set();
      for (const entry of planned) {
        const key = `${entry.residentId}:${entry.block.id}`;
        if (wiped.has(key)) continue;
        wiped.add(key);
        await conn.query(
          'DELETE FROM resident_rotation_assignments WHERE resident_id = ? AND rotation_block_id = ?',
          [entry.residentId, entry.block.id],
        );
      }

      for (const entry of planned) {
        const coversWholeBlock =
          entry.window.start === entry.block.start_date_iso &&
          entry.window.end === entry.block.end_date_iso;
        await conn.query(
          `INSERT INTO resident_rotation_assignments
             (resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.residentId,
            entry.rotation.id,
            entry.block.id,
            entry.window.start,
            entry.window.end,
            weeksSpanned(entry.window.start, entry.window.end),
            coversWholeBlock ? 'FULL_BLOCK' : 'PARTIAL_BLOCK',
          ],
        );
      }

      await conn.commit();
      inTransaction = false;

      const rows = residentCells.length;
      const sampleNote = sampleRows > 0 ? ` ${sampleRows} sample row${sampleRows === 1 ? '' : 's'} ignored.` : '';
      const summaryParts = [
        `${planned.length} weekly assignment${planned.length === 1 ? '' : 's'} saved across ${rows} resident row${
          rows === 1 ? '' : 's'
        }.${sampleNote}`,
      ];
      if (createdRotations.length > 0) {
        summaryParts.push(
          `${createdRotations.length} new rotation${createdRotations.length === 1 ? '' : 's'} catalogued (${createdRotations.join(', ')}).`,
        );
      }
      if (vacantCells > 0) {
        summaryParts.push(`${vacantCells} cell${vacantCells === 1 ? '' : 's'} marked off/unassigned left empty.`);
      }
      if (skippedCells > 0) {
        summaryParts.push(
          `${skippedCells} cell${skippedCells === 1 ? '' : 's'} could not be placed against the block calendar and ${skippedCells === 1 ? 'was' : 'were'} left unassigned.`,
        );
      }
      return res.json({
        success: true,
        updated: planned.length,
        catalogued: createdRotations,
        warnings,
        skipped_cells: skippedCells,
        summary: summaryParts.join(' '),
      });
    } catch (error) {
      if (inTransaction) {
        await conn.rollback().catch(() => {});
      }
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