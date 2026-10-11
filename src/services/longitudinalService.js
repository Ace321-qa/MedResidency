const db = require('../config/db');
const { addMonths, describeWindow } = require('../utils/blockDates');
const RotationService = require('./rotationService');
const { PRIMARY_IDENTIFIER_SQL } = RotationService;
const {
  PRIMARY_CARE_DEFAULT_CLINICS,
  deriveClinicCode,
} = require('../utils/primaryCareClinics');

class LongitudinalService {
  static async getClinicTypes(programId, { includeInactive = false } = {}) {
    let query = `
      SELECT id, program_id, clinic_code, clinic_name, default_day_of_week, start_time, end_time, requires_release_letter, is_active
      FROM longitudinal_clinic_types
      WHERE program_id = ?
    `;
    const params = [programId];
    if (!includeInactive) {
      query += ' AND is_active = 1';
    }
    query += ' ORDER BY clinic_name ASC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Add a clinic to a programme's catalog, or bring an existing one back.
   *
   * The Primary Care Clinics view grows its chip pool from `longitudinal_clinic_types`,
   * so "add a clinic" ends here. The name is the identity a coordinator sees, but the
   * table keys on `(program_id, clinic_code)`; a clinic that is already on record —
   * active or not — is therefore found by name (case-insensitively, via the column
   * collation) and **reactivated**, so a clinic removed from the default pool still
   * comes back with the same row, code and assignment history. A genuinely new name
   * gets a code derived from it, made unique per programme, and is inserted active —
   * which is exactly what makes a hand-typed custom clinic persist for the programme.
   *
   * Only fields the caller actually sent are written: re-adding a clinic never clobbers
   * its recorded day or times.
   *
   * @param {object} data
   * @param {number} data.program_id
   * @param {string} data.clinic_name
   * @param {string} [data.clinic_code]
   * @param {string} [data.default_day_of_week]
   * @param {string} [data.start_time]
   * @param {string} [data.end_time]
   * @param {number} [data.requires_release_letter]
   */
  static async createClinicType(data) {
    const programId = Number(data.program_id);
    const clinicName = String(data.clinic_name ?? '').trim();
    if (!programId || !clinicName) {
      const error = new Error('program_id and a non-empty clinic_name are required.');
      error.statusCode = 400;
      throw error;
    }

    // Settable columns, in the order `getClinicTypes` selects them.
    const fields = {
      clinic_code: data.clinic_code ? String(data.clinic_code).trim() : undefined,
      clinic_name: clinicName,
      default_day_of_week: data.default_day_of_week || undefined,
      start_time: data.start_time ? String(data.start_time).slice(0, 5) : undefined,
      end_time: data.end_time ? String(data.end_time).slice(0, 5) : undefined,
      requires_release_letter:
        data.requires_release_letter !== undefined ? (data.requires_release_letter ? 1 : 0) : undefined,
    };

    const [matches] = await db.query(
      'SELECT id FROM longitudinal_clinic_types WHERE program_id = ? AND clinic_name = ? ORDER BY id ASC LIMIT 1',
      [programId, clinicName]
    );
    const existing = matches[0];

    let clinicId;
    if (existing) {
      clinicId = existing.id;
      const sets = ['updated_at = CURRENT_TIMESTAMP'];
      const params = [];
      for (const [column, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(value);
      }
      sets.push('is_active = 1');
      params.push(clinicId);
      await db.query(`UPDATE longitudinal_clinic_types SET ${sets.join(', ')} WHERE id = ?`, params);
    } else {
      const baseCode = deriveClinicCode(fields.clinic_code || clinicName);
      const code = await this.ensureUniqueClinicCode(programId, baseCode);
      const [result] = await db.query(
        `INSERT INTO longitudinal_clinic_types
           (program_id, clinic_code, clinic_name, default_day_of_week, start_time, end_time, requires_release_letter, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          programId,
          code,
          fields.clinic_name,
          fields.default_day_of_week || null,
          fields.start_time || null,
          fields.end_time || null,
          fields.requires_release_letter ?? 0,
        ]
      );
      clinicId = result.insertId;
    }

    const [rows] = await db.query(
      `SELECT id, program_id, clinic_code, clinic_name, default_day_of_week, start_time, end_time, requires_release_letter, is_active
       FROM longitudinal_clinic_types WHERE id = ?`,
      [clinicId]
    );
    return rows[0];
  }

  /** The first `baseCode`, `baseCode 2`, … `baseCode N` not taken in this programme. */
  static async ensureUniqueClinicCode(programId, baseCode) {
    let candidate = baseCode;
    let suffix = 2;
    for (;;) {
      const [rows] = await db.query(
        'SELECT id FROM longitudinal_clinic_types WHERE program_id = ? AND clinic_code = ? LIMIT 1',
        [programId, candidate]
      );
      if (rows.length === 0) return candidate;
      candidate = `${String(baseCode).slice(0, 47)} ${suffix}`;
      suffix += 1;
    }
  }

  /** The `longitudinal_clinic_types` row for an id, scoped to one programme. */
  static async findClinicType(clinicTypeId, programId) {
    const [rows] = await db.query(
      `SELECT id, program_id, clinic_code, clinic_name, default_day_of_week, start_time, end_time, requires_release_letter, is_active
       FROM longitudinal_clinic_types
       WHERE id = ? AND program_id = ?`,
      [clinicTypeId, programId]
    );
    return rows[0] || null;
  }

  /**
   * Rename (or otherwise edit) one of the programme's clinics.
   *
   * The row keeps its `id` and `clinic_code`, so the rename is transparent to
   * everything that already references the clinic by id — slots, supervisor
   * pairings and resident assignments all keep working; only the label every
   * screen displays changes. Only fields the caller actually sent are written,
   * matching `createClinicType`.
   *
   * A rename is rejected when the new name already belongs to another row of
   * the same programme, active or not: the client finds clinics by name, and
   * two rows answering to the same name would make the chip pool ambiguous.
   *
   * @param {number} clinicTypeId
   * @param {number} programId
   * @param {object} data
   * @param {string} [data.clinic_name]
   * @param {string} [data.default_day_of_week]
   * @param {string} [data.start_time]
   * @param {string} [data.end_time]
   * @param {number} [data.requires_release_letter]
   */
  static async updateClinicType(clinicTypeId, programId, data = {}) {
    const id = Number(clinicTypeId);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('A numeric clinic id is required.');
      error.statusCode = 400;
      throw error;
    }
    const program = Number(programId);
    if (!Number.isInteger(program) || program <= 0) {
      const error = new Error('program_id is required.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await this.findClinicType(id, program);
    if (!existing) {
      const error = new Error(`Clinic ${id} was not found for this programme.`);
      error.statusCode = 404;
      throw error;
    }

    const fields = {};
    if (data.clinic_name !== undefined) {
      const clinicName = String(data.clinic_name ?? '').trim();
      if (!clinicName) {
        const error = new Error('clinic_name cannot be empty.');
        error.statusCode = 400;
        throw error;
      }
      fields.clinic_name = clinicName;

      const [dupes] = await db.query(
        `SELECT id FROM longitudinal_clinic_types
          WHERE program_id = ? AND clinic_name = ? AND id <> ?
          ORDER BY id ASC LIMIT 1`,
        [program, clinicName, id]
      );
      if (dupes.length > 0) {
        const error = new Error(`A clinic named "${clinicName}" already exists for this programme.`);
        error.statusCode = 409;
        throw error;
      }
    }
    if (data.default_day_of_week !== undefined) {
      fields.default_day_of_week = data.default_day_of_week || null;
    }
    if (data.start_time !== undefined) {
      fields.start_time = data.start_time ? String(data.start_time).slice(0, 5) : null;
    }
    if (data.end_time !== undefined) {
      fields.end_time = data.end_time ? String(data.end_time).slice(0, 5) : null;
    }
    if (data.requires_release_letter !== undefined) {
      fields.requires_release_letter = data.requires_release_letter ? 1 : 0;
    }

    if (Object.keys(fields).length === 0) {
      const error = new Error('Nothing to update. Provide at least one field to change.');
      error.statusCode = 400;
      throw error;
    }

    const sets = [...Object.keys(fields).map((column) => `${column} = ?`), 'updated_at = CURRENT_TIMESTAMP'];
    await db.query(
      `UPDATE longitudinal_clinic_types SET ${sets.join(', ')} WHERE id = ? AND program_id = ?`,
      [...Object.values(fields), id, program]
    );

    return this.findClinicType(id, program);
  }

  /**
   * Soft-delete a clinic from the programme's available pool.
   *
   * The row is deactivated (`is_active = 0`) rather than removed, so the slots,
   * supervisor pairings and resident assignments that reference it keep their
   * ids and stay resolvable — historical data is preserved, which is the point
   * of the confirmation copy the client shows before calling this. A clinic
   * brought back later (via `createClinicType`) is reactivated with the same
   * row and code.
   *
   * @returns {Promise<{id: number, clinic_name: string, is_active: number}>}
   */
  static async deleteClinicType(clinicTypeId, programId) {
    const id = Number(clinicTypeId);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error('A numeric clinic id is required.');
      error.statusCode = 400;
      throw error;
    }
    const program = Number(programId);
    if (!Number.isInteger(program) || program <= 0) {
      const error = new Error('program_id is required.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await this.findClinicType(id, program);
    if (!existing) {
      const error = new Error(`Clinic ${id} was not found for this programme.`);
      error.statusCode = 404;
      throw error;
    }

    await db.query(
      'UPDATE longitudinal_clinic_types SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND program_id = ?',
      [id, program]
    );

    return { id, clinic_name: existing.clinic_name, clinic_code: existing.clinic_code, is_active: 0 };
  }

  static async getCycleSchedule(programId, options = {}) {
    const { cycleId } = options;
    let cycle = null;
    if (cycleId) {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE id = ? AND program_id = ?', [cycleId, programId]);
      cycle = cycles[0] || null;
    } else {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
      cycle = cycles[0] || null;
    }
    if (!cycle) {
      cycle = { id: null, program_id: programId, cycle_number: 'Cycle 1', week_number: 'Week 1', start_date: new Date().toISOString().split('T')[0] };
    }
    const [headers] = await db.query('SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? ORDER BY day_of_week', [cycle.id || 0]);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    for (const day of days) {
      const exists = headers.find(h => h.day_of_week === day);
      if (!exists) {
        await db.query('INSERT INTO primary_care_daily_headers (cycle_id, day_of_week, shift_time, pgy_level) VALUES (?, ?, ?, ?)',
          [cycle.id || 0, day, (day === 'Tuesday' || day === 'Thursday') ? '07:00 - 2:00' : '10:30 - 2:00',
           day === 'Sunday' ? 'PGY-3' : day === 'Monday' ? 'PGY-2' : day === 'Tuesday' ? 'FMC' : day === 'Wednesday' ? 'PGY-1' : 'FMC']);
      }
    }
    const [headers2] = await db.query('SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? ORDER BY day_of_week', [cycle.id || 0]);
    const allSlots = [];
    for (const h of headers2) {
      const [slots] = await db.query('SELECT * FROM primary_care_clinic_slots WHERE daily_header_id = ? ORDER BY clinic_number', [h.id]);
      if (slots.length === 0) {
        const inserts = [];
        for (let i = 1; i <= 12; i++) inserts.push([h.id, i, null, null, null, null]);
        if (inserts.length > 0) await db.query('INSERT INTO primary_care_clinic_slots (daily_header_id, clinic_number, resident_1_name, resident_2_name, faculty_name, faculty_id) VALUES ?', [inserts]);
        const [slots2] = await db.query('SELECT * FROM primary_care_clinic_slots WHERE daily_header_id = ? ORDER BY clinic_number', [h.id]);
        allSlots.push(...slots2);
      } else allSlots.push(...slots);
    }
    const headerIds = headers2.map(h=>h.id);
    const [backups] = await db.query('SELECT * FROM primary_care_backup_faculty WHERE daily_header_id IN (?)', [headerIds.length>0?headerIds:[0]]);
    const backupsByDay = {};
    for (const b of backups) { if (!backupsByDay[b.day_of_week]) backupsByDay[b.day_of_week] = []; backupsByDay[b.day_of_week].push(b); }
    return { cycle, dailyHeaders: headers2, slots: allSlots, backups: backupsByDay };
  }

  static async updateCycleHeader(programId, data = {}) {
    let cycleId = data.cycle_id;
    if (!cycleId) {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
      if (cycles.length > 0) cycleId = cycles[0].id;
      else {
        const [res] = await db.query('INSERT INTO primary_care_cycles (program_id, cycle_number, week_number, start_date) VALUES (?, ?, ?, ?)',
          [programId, data.cycle_number || 'Cycle 1', data.week_number || 'Week 1', data.start_date || new Date().toISOString().split('T')[0]]);
        cycleId = res.insertId;
      }
    }
    if (data.cycle_number !== undefined || data.week_number !== undefined || data.start_date !== undefined) {
      const sets = [], params = [];
      if (data.cycle_number !== undefined) { sets.push('cycle_number = ?'); params.push(data.cycle_number); }
      if (data.week_number !== undefined) { sets.push('week_number = ?'); params.push(data.week_number); }
      if (data.start_date !== undefined) { sets.push('start_date = ?'); params.push(data.start_date); }
      params.push(cycleId, programId);
      await db.query(`UPDATE primary_care_cycles SET ${sets.join(', ')} WHERE id = ? AND program_id = ?`, params);
    }
    if (data.dailyHeaders) {
      for (const dh of data.dailyHeaders) {
        const sets = [], params = [];
        if (dh.shift_time !== undefined) { sets.push('shift_time = ?'); params.push(dh.shift_time); }
        if (dh.pgy_level !== undefined) { sets.push('pgy_level = ?'); params.push(dh.pgy_level); }
        if (dh.in_charge_faculty_name !== undefined) { sets.push('in_charge_faculty_name = ?'); params.push(dh.in_charge_faculty_name); }
        if (sets.length > 0) { params.push(dh.id); await db.query(`UPDATE primary_care_daily_headers SET ${sets.join(', ')} WHERE id = ?`, params); }
      }
    }
    const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE id = ?', [cycleId]);
    return cycles[0];
  }

  static async updateCycleSlot(slotId, data = {}) {
    if (!slotId) { const e = new Error('slotId required'); e.statusCode = 400; throw e; }
    const sets = [], params = [];
    if (data.resident_1_name !== undefined) { sets.push('resident_1_name = ?'); params.push(data.resident_1_name); }
    if (data.resident_2_name !== undefined) { sets.push('resident_2_name = ?'); params.push(data.resident_2_name); }
    if (data.faculty_name !== undefined) { sets.push('faculty_name = ?'); params.push(data.faculty_name); }
    if (sets.length === 0) { const e = new Error('Nothing to update'); e.statusCode = 400; throw e; }
    params.push(slotId);
    await db.query(`UPDATE primary_care_clinic_slots SET ${sets.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query('SELECT * FROM primary_care_clinic_slots WHERE id = ?', [slotId]);
    return rows[0];
  }

  static async updateBackupFaculty(programId, data = {}) {
    const { cycle_id, day_of_week, faculty_list = [] } = data;
    let cycleId = cycle_id;
    if (!cycleId) {
      const [cycles] = await db.query('SELECT * FROM primary_care_cycles WHERE program_id = ? ORDER BY id DESC LIMIT 1', [programId]);
      if (cycles.length === 0) {
        const [res] = await db.query('INSERT INTO primary_care_cycles (program_id, cycle_number, week_number, start_date) VALUES (?, ?, ?, ?)',
          [programId, 'Cycle 1', 'Week 1', new Date().toISOString().split('T')[0]]);
        cycleId = res.insertId;
      } else cycleId = cycles[0].id;
    }
    let [headers] = await db.query('SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ?', [cycleId, day_of_week]);
    let dailyHeaderId = headers[0]?.id;
    if (!dailyHeaderId) {
      await db.query('INSERT INTO primary_care_daily_headers (cycle_id, day_of_week, shift_time, pgy_level) VALUES (?, ?, ?, ?)',
        [cycleId, day_of_week, (day_of_week === 'Tuesday' || day_of_week === 'Thursday') ? '07:00 - 2:00' : '10:30 - 2:00',
         day_of_week === 'Sunday' ? 'PGY-3' : day_of_week === 'Monday' ? 'PGY-2' : day_of_week === 'Tuesday' ? 'FMC' : day_of_week === 'Wednesday' ? 'PGY-1' : 'FMC']);
      const [h2] = await db.query('SELECT * FROM primary_care_daily_headers WHERE cycle_id = ? AND day_of_week = ?', [cycleId, day_of_week]);
      dailyHeaderId = h2[0].id;
    }
    await db.query('DELETE FROM primary_care_backup_faculty WHERE daily_header_id = ? AND day_of_week = ?', [dailyHeaderId, day_of_week]);
    const inserts = [];
    for (let i = 0; i < faculty_list.length; i++) {
      const f = faculty_list[i];
      inserts.push([dailyHeaderId, day_of_week, (f.faculty_name || f.name || '').replace(/^Dr\.\s*/i, ''), f.faculty_id || null, i + 1]);
    }
    if (inserts.length > 0) await db.query('INSERT INTO primary_care_backup_faculty (daily_header_id, day_of_week, faculty_name, faculty_id, priority_order) VALUES ?', [inserts]);
    const [rows] = await db.query('SELECT * FROM primary_care_backup_faculty WHERE daily_header_id = ? AND day_of_week = ? ORDER BY priority_order ASC', [dailyHeaderId, day_of_week]);
    return rows;
  }
}

module.exports = LongitudinalService;
