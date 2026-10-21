// Step 1: Import our Hostinger MySQL connection pool
const db = require('../config/db');
const NotificationService = require('./notificationService');
const ProgramConnectionService = require('./programConnectionService');
const RotationCapacityService = require('./rotationCapacityService');
const { ensureTargetProgramColumn } = require('../utils/ensureTargetProgram');
const {
  academicYearForDate,
  academicYearMatchValues,
  normalizeAcademicYear,
} = require('../utils/academicYear');
const {
  DAY_NAMES,
  addDays,
  describeWindow,
  diffDays,
  resolveBlockWindow,
  weekEndDay,
} = require('../utils/blockDates');

/**
 * How many blocks a standard academic year holds: 13 × 4 weeks = 52 weeks.
 *
 * The Master Rotation Grid has always drawn thirteen columns from the calendar
 * (`mobile/src/utils/masterGridCalendar.ts`), so the block table is the thing
 * that disagreed with it — production stopped at Block 7 because each block was
 * added by hand.
 */
const STANDARD_BLOCKS_PER_YEAR = 13;

/**
 * Memoises the `rotation_blocks.is_finalized` DDL for the process lifetime.
 * Declared at module scope (not on the class) so it survives across calls
 * without being re-created per request; cleared on failure by the ensure method.
 */
let finalizedColumnPromise = null;

/**
 * Scalar subquery yielding one display identifier per resident.
 *
 * `resident_identifiers.is_primary` is set on every identifier row in this
 * schema, so it cannot pick a single row per resident. Joining that table
 * multiplies each resident by how many identifiers they hold, which silently
 * inflates any row-per-resident grid. A correlated subquery with an explicit
 * preference order keeps the row count exact; FIELD() returns 0 for an
 * unlisted type, so anything unexpected sorts last as a fallback.
 */
const PRIMARY_IDENTIFIER_SQL = `
  (
    SELECT ri.identifier_value
    FROM resident_identifiers ri
    WHERE ri.resident_id = r.id
    ORDER BY FIELD(ri.identifier_type, 'CORPORATE_ID', 'NATIONAL_ID', 'PASSPORT', 'LICENSE_NUMBER'), ri.id ASC
    LIMIT 1
  )`;

/**
 * Scalar subquery yielding one contact number per resident, or NULL.
 *
 * The cohort master grid has a Mobile / Contact row for every resident, but
 * `residents` carries no phone column and `resident_identifiers` is typed for
 * identity documents. Rather than hardcode an empty string the way
 * `getAssignments` does, the grid reads whichever identifier is actually a
 * contact and renders "not recorded" when none is — a false blank is
 * indistinguishable from a missing one, whereas NULL says the schema has nothing
 * to show.
 */
const CONTACT_IDENTIFIER_SQL = `
  (
    SELECT ri.identifier_value
    FROM resident_identifiers ri
    WHERE ri.resident_id = r.id
      AND UPPER(ri.identifier_type) IN ('MOBILE', 'MOBILE_NUMBER', 'PHONE', 'CONTACT', 'CONTACT_NUMBER')
    ORDER BY ri.is_primary DESC, ri.id ASC
    LIMIT 1
  )`;

/**
 * Scalar subquery yielding one email address per resident, or NULL.
 *
 * Email and mobile both live on `resident_identifiers` rather than
 * `residents`, so the Master Rotation Grid export resolves it the same
 * correlated-subquery way the roster does — never with a join, which would
 * multiply a resident by how many identifiers they hold.
 */
const EMAIL_IDENTIFIER_SQL = `
  (
    SELECT ri.identifier_value
    FROM resident_identifiers ri
    WHERE ri.resident_id = r.id
      AND UPPER(ri.identifier_type) IN ('EMAIL', 'E_MAIL', 'EMAIL_ADDRESS')
    ORDER BY ri.is_primary DESC, ri.id ASC
    LIMIT 1
  )`;

/**
 * The shared column list of the two cohort-grid queries.
 *
 * The enrolled cohort is driven from `rotation_blocks` (every resident/block
 * cell exists even when nothing is assigned) while the visiting cohort is
 * driven from `resident_rotation_assignments` (a visitor only has cells where
 * they actually rotate), but both project the same aliases — `re` is the
 * resident's relevant enrolment, `rb` the block, `rra`/`rot` the assignment and
 * its rotation — so one list serves both and the two row shapes can never
 * drift apart.
 *
 * `is_external` falls out of the aliases themselves: the enrolled query joins
 * `re` on `re.program_id = rb.program_id` (so the expression is 0), while the
 * visiting query joins the resident's *home* enrolment in another programme
 * (so it is 1). The home-programme name and code ride along for the badge the
 * grid draws beside a visitor, e.g. "FM Resident".
 */
const COHORT_GRID_COLUMNS = `
        re.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        r.first_name,
        r.last_name,
        ${PRIMARY_IDENTIFIER_SQL} AS employee_id,
        ${CONTACT_IDENTIFIER_SQL} AS contact_number,
        ${EMAIL_IDENTIFIER_SQL} AS email,
        re.year_in_program AS pgy_level,
        re.resident_status,
        -- Cross-programme provenance. Derived from the aliases above rather
        -- than hardcoded per query, so both rows answer it the same way.
        (re.program_id <> rb.program_id) AS is_external,
        re.program_id AS home_program_id,
        rb.program_id AS host_program_id,
        (
          SELECT hp.program_name FROM programs hp WHERE hp.id = re.program_id
        ) AS home_program_name,
        (
          SELECT hp.program_code FROM programs hp WHERE hp.id = re.program_id
        ) AS home_program_code,
        rb.program_id,
        p.program_code,
        p.specialty_name,
        p.week_start_day,
        rb.id AS block_id,
        rb.block_number,
        rb.block_name,
        rb.academic_year,
        rb.is_finalized,
        rb.start_date AS block_start_date,
        rb.end_date AS block_end_date,
        DATE_FORMAT(rb.start_date, '%Y-%m-%d') AS block_start_date_iso,
        DATE_FORMAT(rb.end_date, '%Y-%m-%d') AS block_end_date_iso,
        DAYNAME(rb.start_date) AS block_start_day,
        DAYNAME(rb.end_date) AS block_end_day,
        DATEDIFF(rb.end_date, rb.start_date) + 1 AS block_days,
        rra.id AS assignment_id,
        rra.rotation_id,
        rot.rotation_code,
        rot.rotation_name,
        rot.department_name,
        -- The departmental seat limit travels with the cell so the grid can show
        -- (n/capacity) without a second request per cell. NULL means the rotation
        -- has no limit, which is the ordinary case, not a zero.
        rot.max_capacity AS rotation_max_capacity,
        rot.capacity_locked AS rotation_capacity_locked,
        -- Distinct residents standing in this rotation during this block. Counted
        -- per block rather than per week: it is the figure a cell can show, and
        -- it is the same number the capacity engine reports as the peak when a
        -- block is fully held by one rotation. A partial block shows the whole
        -- block's occupancy, which is deliberate — the tag answers "how full is
        -- this department" at the granularity the grid draws.
        (
          SELECT COUNT(DISTINCT occ_rra.resident_id)
          FROM resident_rotation_assignments occ_rra
          WHERE occ_rra.rotation_id = rra.rotation_id
            AND occ_rra.start_date <= rb.end_date
            AND occ_rra.end_date >= rb.start_date
        ) AS rotation_block_occupancy,
        rra.start_date,
        rra.end_date,
        DATE_FORMAT(rra.start_date, '%Y-%m-%d') AS assignment_start_date_iso,
        DATE_FORMAT(rra.end_date, '%Y-%m-%d') AS assignment_end_date_iso,
        rra.assigned_weeks,
        rra.assignment_type,
        rra.notes,
        (rra.id IS NOT NULL) AS is_assigned,
        (
          SELECT COUNT(*)
          FROM resident_rotation_assignments cell_rra
          WHERE cell_rra.resident_id = re.resident_id
            AND cell_rra.rotation_block_id = rb.id
        ) AS assignment_count,
        -- Concurrent clinic releases. A clinic request is approved without
        -- touching the block rota (it is a release, not a posting), so the grid
        -- is where the two are put back together: the hospital rotation stays in
        -- the cell and each clinic session rides alongside it as a notation.
        -- Aggregated one row per cell because the badge is part of the cell, and
        -- a per-release row would multiply the resident's block across the grid.
        (
          SELECT GROUP_CONCAT(
                   CONCAT_WS('|', COALESCE(lct.clinic_code, ''), COALESCE(rla.day_of_week, ''), COALESCE(rla.clinic_days, ''), COALESCE(rla.summary, ''))
                   ORDER BY rla.start_date ASC, rla.id ASC SEPARATOR ';;'
                 )
          FROM resident_longitudinal_assignments rla
          LEFT JOIN longitudinal_clinic_types lct ON lct.id = rla.clinic_type_id
          WHERE rla.resident_id = re.resident_id
            AND rla.is_active = 1
            AND rla.start_date <= rb.end_date
            AND rla.end_date >= rb.start_date
        ) AS concurrent_clinics,
        (
          SELECT COUNT(*)
          FROM resident_longitudinal_assignments cell_rla
          WHERE cell_rla.resident_id = re.resident_id
            AND cell_rla.is_active = 1
            AND cell_rla.start_date <= rb.end_date
            AND cell_rla.end_date >= rb.start_date
        ) AS clinic_count,
        (
          SELECT COUNT(*)
          FROM resident_longitudinal_assignments cell_rla
          WHERE cell_rla.resident_id = re.resident_id
            AND cell_rla.source_request_id IS NULL
            AND cell_rla.is_active = 1
            AND cell_rla.start_date <= rb.end_date
            AND cell_rla.end_date >= rb.start_date
        ) AS standing_clinic_count`;

/** The three-letter form of a weekday, for a badge that has ~110pt to fit in. */
const SHORT_DAY = {
  SUNDAY: 'Sun',
  MONDAY: 'Mon',
  TUESDAY: 'Tue',
  WEDNESDAY: 'Wed',
  THURSDAY: 'Thu',
  FRIDAY: 'Fri',
  SATURDAY: 'Sat',
};

/**
 * A short, badge-sized name for a clinic.
 *
 * `clinic_code` is the coordinator's own label and is preferred when it is
 * present. A clinic the resident typed that no coordinator catalogued has no
 * code, so the name is recovered from the summary the approval wrote
 * (`Clinic release: <name> (<days>)`) rather than leaving the badge blank.
 */
function clinicBadgeName(release) {
  const code = String(release.code ?? '').trim();
  if (code) return code;

  const summary = String(release.summary ?? '').trim();
  const match = /^Clinic release:\s*(.+?)(?:\s*\([^)]*\))?$/.exec(summary);
  const name = (match?.[1] ?? summary).trim();
  if (!name) return '';
  // A typed name can be a sentence; a badge cannot. 18 characters is roughly
  // what fits next to a rotation code before the cell starts wrapping.
  return name.length > 18 ? `${name.slice(0, 17).trimEnd()}…` : name;
}

/**
 * Turn the cohort query's clinic aggregates into the badge the grid draws.
 *
 * `GROUP_CONCAT` is deliberate: the grain of the grid is one row per
 * resident/block/assignment, so a second JOIN or a second row per clinic release
 * would multiply every resident's block across the grid. The separator pair
 * (`;;` between releases, `|` inside one) is safe because none of the four fields
 * can contain either character.
 *
 * The label reads `+ ANC (Wed)` — clinic, then the days it releases. It is kept
 * short on purpose: the cell already carries the hospital rotation's own badge,
 * and this rides beside it. Standing rows a coordinator entered on the matrix
 * months ago have no `source_request_id`; they say "on the matrix" rather than
 * inventing a request, so the cell is honest about where the release came from.
 */
function decodeClinicColumns(row) {
  const clinicCount = Number(row.clinic_count) || 0;
  const standingCount = Number(row.standing_clinic_count) || 0;
  const releases = String(row.concurrent_clinics ?? '')
    .split(';;')
    .filter((entry) => entry.trim() !== '')
    .map((entry) => {
      const [code, day, daysJson, summary] = entry.split('|');
      return { code: code ?? '', day: day ?? '', days: daysJson ?? '', summary: summary ?? '' };
    })
    .map((entry) => {
      let days = [];
      try {
        const parsed = JSON.parse(entry.days);
        if (Array.isArray(parsed)) days = parsed;
      } catch {
        days = [];
      }
      if (days.length === 0 && entry.day) days = [entry.day];
      return {
        ...entry,
        days: days.map((value) => String(value).toUpperCase()).filter((value) => SHORT_DAY[value]),
      };
    })
    .map((entry) => ({ ...entry, name: clinicBadgeName(entry) }));

  const startsFromRequest = clinicCount > standingCount;
  const withAt = (limit) =>
    releases.slice(0, limit).map((release, index) => ({
      ...release,
      /** Where in the block the release sits, e.g. `B5.2`. */
      at: `B${row.block_number}.${index + 1}`,
    }));

  let label = null;
  let source = null;
  if (clinicCount > 0) {
    const shown = withAt(2);
    const parts = shown.map((release) => {
      const dayText = release.days.map((day) => SHORT_DAY[day]).join(', ');
      if (!release.name) return dayText ? `(${dayText})` : 'Clinic';
      return dayText ? `${release.name} (${dayText})` : release.name;
    });
    if (clinicCount > shown.length) parts.push(`+${clinicCount - shown.length} more`);
    label = `+ ${parts.join(', ')}`;
    source = startsFromRequest ? 'CLINIC_REQUEST' : 'MATRIX';
  }

  return {
    clinic_count: clinicCount,
    clinic_source: source,
    clinic_releases: withAt(3),
    concurrent_clinic_label: label,
  };
}

class RotationService {
  /**
   * Fetch all academic blocks for a specific residency program
   *
   * `academicYear` arrives in whichever shape a client used, so it is normalised
   * before it reaches SQL: the column holds "2026-2027" but callers also send
   * "2026/2027", and a literal comparison against the un-normalised value returns
   * zero rows for a year that plainly has blocks.
   *
   * @param {number} programId - e.g., 1 for Family Medicine
   */
  static async getBlocksByProgram(programId, academicYear = null) {
    await this.ensureFinalizedColumn();
    let query = `
      SELECT 
        b.id AS block_id,
        b.program_id,
        p.program_code,
        p.week_start_day,
        b.academic_year,
        b.block_number,
        b.block_name,
        b.start_date,
        b.end_date,
        b.is_finalized,
        DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date_iso,
        DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date_iso,
        DAYNAME(b.start_date) AS actual_start_day,
        DAYNAME(b.end_date) AS actual_end_day,
        DATEDIFF(b.end_date, b.start_date) + 1 AS block_days,
        (DATEDIFF(b.end_date, b.start_date) + 1) DIV 7 AS block_weeks
      FROM rotation_blocks b
      JOIN programs p ON p.id = b.program_id
      WHERE b.program_id = ?
    `;
    const params = [programId];
    const yearValues = academicYearMatchValues(academicYear);
    if (yearValues.length > 0) {
      query += ` AND b.academic_year IN (${yearValues.map(() => '?').join(', ')})`;
      params.push(...yearValues);
    }
    query += ' ORDER BY b.academic_year DESC, b.block_number ASC;';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * The week-start day and default block length a programme runs on.
   *
   * `programs.week_start_day` is what makes a block end on a Saturday (or a
   * Sunday) rather than on the same weekday it started, so every block write
   * reads it before deriving a date.
   *
   * @returns {Promise<{program_id:number, week_start_day:string|null,
   *   default_block_duration_weeks:number|null}|null>}
   */
  static async getBlockCalendarRules(programId) {
    const query = `
      SELECT id AS program_id, week_start_day, default_block_duration_weeks, academic_year_start_month
      FROM programs
      WHERE id = ?
    `;
    const [rows] = await db.query(query, [programId]);
    return rows[0] || null;
  }

  /**
   * Derive a block window from a start date and a duration, using the programme's
   * week-start day.
   *
   * Exposed as its own endpoint so a client never has to re-implement the
   * `weeks * 7 - 1` arithmetic: the forms call this and the API calls it again
   * on write, so what a coordinator sees in the calendar is exactly what gets
   * stored.
   *
   * @param {object} input
   * @param {number} input.programId
   * @param {string} input.startDate - `YYYY-MM-DD`.
   * @param {number} [input.durationWeeks] - Defaults to the programme's own
   *   `default_block_duration_weeks` (4 in practice).
   * @param {string} [input.endDate] - Cross-checked against the derived window.
   */
  static async resolveBlockDates({ programId, startDate, durationWeeks, endDate }) {
    const rules = await this.getBlockCalendarRules(programId);
    const hasDuration = durationWeeks !== undefined && durationWeeks !== null && durationWeeks !== '';
    const hasEnd = Boolean(endDate);

    // The programme default is only a *default*. An explicit end date means the
    // caller has already decided the length, so it must not then be rejected for
    // disagreeing with a four-week default — that is what made a legitimate
    // one-, two- or three-week block impossible to create.
    const weeks = hasDuration ? Number(durationWeeks) : hasEnd ? null : Number(rules?.default_block_duration_weeks) || 4;

    const window = resolveBlockWindow({
      start_date: startDate,
      end_date: endDate,
      duration_weeks: weeks,
      week_start_day: rules?.week_start_day,
    });

    return {
      ...window,
      week_start_day: rules?.week_start_day ?? null,
      default_block_duration_weeks: Number(rules?.default_block_duration_weeks) || null,
      window_label: window.start_date && window.end_date ? describeWindow(window.start_date, window.end_date) : null,
    };
  }

  /** The calendar rules alone, for a form that needs them before choosing a date. */
  static async getBlockCalendar(programId) {
    const rules = await this.getBlockCalendarRules(programId);
    if (!rules) return null;
    return {
      program_id: rules.program_id,
      week_start_day: rules.week_start_day ?? null,
      week_end_day: rules.week_start_day ? weekEndDay(rules.week_start_day) : null,
      default_block_duration_weeks: Number(rules.default_block_duration_weeks) || null,
    };
  }

  static async createBlock(blockData) {
    const { program_id, academic_year, block_number, block_name } = blockData;

    // Re-derive the window server-side. The client computes the same arithmetic,
    // but the stored dates are whatever this function decides, so a hand-edited
    // request cannot slip a block across a week boundary.
    const window = await this.resolveBlockDates({
      programId: program_id,
      startDate: blockData.start_date,
      durationWeeks: blockData.duration_weeks,
      endDate: blockData.end_date,
    });

    if (window.errors.length > 0) {
      const error = new Error(window.errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    const query = `
      INSERT INTO rotation_blocks 
        (program_id, academic_year, block_number, block_name, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?);
    `;
    const [result] = await db.query(query, [
      program_id,
      String(academic_year ?? '').trim(),
      block_number,
      block_name,
      window.start_date,
      window.end_date,
    ]);

    return {
      block_id: result.insertId,
      ...blockData,
      start_date: window.start_date,
      end_date: window.end_date,
      duration_weeks: window.duration_weeks,
    };
  }

  /**
   * The first day a block can start on when the year has no blocks at all.
   *
   * The programme says which month its academic year opens in (July for the
   * Family Medicine programme) and which weekday a block starts on (Sunday).
   * The anchor is the first occurrence of that weekday in the opening month, so
   * July 2026 opens on Sunday 05 July rather than on the 1st.
   */
  static academicYearAnchor(year, rules) {
    const startYear = Number(String(year).slice(0, 4));
    const month = Number(rules?.academic_year_start_month) || 7;
    const anchor = `${startYear}-${String(month).padStart(2, '0')}-01`;
    const target = DAY_NAMES.findIndex(
      (day) => day.toUpperCase() === String(rules?.week_start_day ?? '').trim().toUpperCase(),
    );
    if (target < 0) return anchor;
    const current = new Date(`${anchor}T00:00:00Z`).getUTCDay();
    return addDays(anchor, (target - current + 7) % 7);
  }

  /**
   * Complete an academic year to its standard thirteen blocks.
   *
   * The block list used to stop wherever typing stopped — production had seven
   * blocks for 2026-2027 while the Master Rotation Grid drew thirteen columns,
   * so assignments could not be made for Blocks 8-13 at all. This fills only the
   * **missing** numbers and never edits a block that already exists, because an
   * existing block may carry assignments and a coordinator's deliberate dates.
   *
   * Placement is sequential and non-overlapping:
   *
   *  - a trailing block (the usual case) starts the day after its predecessor
   *    ends, so the calendar has no gap;
   *  - a hole in the middle is placed backwards from the block that follows it,
   *    and is skipped — and reported — when there is not enough room, because
   *    guessing dates that overlap a real block is worse than leaving the gap
   *    visible.
   *
   * Idempotent: with thirteen blocks present it writes nothing. New rows are
   * named `Block N`, the official label, rather than inheriting a rotation name.
   *
   * @param {number} programId
   * @param {string|null} [academicYear] - Defaults to the year containing today.
   * @returns {Promise<{academic_year:string, created:object[], skipped:number[],
   *   duration_weeks:number}>}
   */
  static async ensureAcademicBlocks(programId, academicYear = null) {
    const rules = await this.getBlockCalendarRules(programId);
    if (!rules) {
      const error = new Error('That programme does not exist.');
      error.statusCode = 404;
      throw error;
    }

    const year = normalizeAcademicYear(academicYear) || academicYearForDate(new Date());
    const durationWeeks = Number(rules.default_block_duration_weeks) || 4;
    const blockDays = durationWeeks * 7;

    const yearValues = academicYearMatchValues(year);
    const [rows] = await db.query(
      `SELECT id, block_number,
              DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
         FROM rotation_blocks
        WHERE program_id = ? AND academic_year IN (${yearValues.map(() => '?').join(', ')})`,
      [programId, ...yearValues],
    );

    const existing = new Map(rows.map((row) => [Number(row.block_number), row]));
    const created = [];
    const skipped = [];

    for (let blockNumber = 1; blockNumber <= STANDARD_BLOCKS_PER_YEAR; blockNumber += 1) {
      if (existing.has(blockNumber)) continue;

      const previous = existing.get(blockNumber - 1) ?? null;
      const next = [...existing.values()]
        .filter((row) => Number(row.block_number) > blockNumber)
        .sort((a, b) => Number(a.block_number) - Number(b.block_number))[0] ?? null;

      let start = previous
        ? addDays(previous.end_date, 1)
        : this.academicYearAnchor(year, rules);
      let end = addDays(start, blockDays - 1);

      // A hole before an existing block: place it backwards from that block so
      // it cannot overlap it. Skip when the window would run into its
      // predecessor.
      if (next && end >= next.start_date) {
        end = addDays(next.start_date, -1);
        start = addDays(end, -(blockDays - 1));
        if (previous && start <= previous.end_date) {
          skipped.push(blockNumber);
          continue;
        }
      }

      const block = await this.createBlock({
        program_id: programId,
        academic_year: year,
        block_number: blockNumber,
        // The official label. A block heading is never a rotation name.
        block_name: `Block ${blockNumber}`,
        start_date: start,
        duration_weeks: durationWeeks,
      });

      existing.set(blockNumber, {
        id: block.block_id,
        block_number: blockNumber,
        start_date: block.start_date,
        end_date: block.end_date,
      });
      created.push(block);
    }

    return { academic_year: year, created, skipped, duration_weeks: durationWeeks };
  }

  /**
   * The rotations a programme may schedule onto — its own catalogue plus the
   * ones other programmes have targeted *at* it.
   *
   * A Family Medicine ward rotation linked to the Internal Medicine Residency
   * Program (`target_program_id`) has to appear on Internal Medicine's
   * assignment sheet as well as Family Medicine's own, or the receiving
   * programme could never place a visiting resident onto the ward it hosts.
   */
  static async getRotationsByProgram(programId) {
    await ensureTargetProgramColumn();
    const query = `
      SELECT
        r.id AS rotation_id,
        r.program_id,
        r.target_program_id,
        r.rotation_code,
        r.rotation_name,
        r.department_name,
        r.department_id,
        r.default_duration_weeks,
        r.is_active,
        r.max_capacity,
        r.capacity_locked
      FROM rotations r
      WHERE (r.program_id = ? OR r.target_program_id = ?) AND r.is_active = TRUE
      ORDER BY r.rotation_name ASC;
    `;
    const [rows] = await db.query(query, [programId, programId]);
    return rows;
  }

  /**
   * Place a resident in a rotation inside a block.
   *
   * `assigned_weeks` used to be hardcoded to `4.0` whenever the caller omitted
   * it, so a one-week clinic slot was stored as a four-week posting and every
   * duty-hour and progress calculation built on it was wrong. The duration is
   * now derived from the dates actually stored, and an explicit
   * `assigned_weeks` is still honoured for deliberately fractional postings.
   */
  static async assignResidentToRotation(assignmentData) {
    const {
      resident_id,
      rotation_id,
      rotation_block_id,
      start_date,
      end_date,
      assigned_weeks,
      assignment_type,
      notes,
    } = assignmentData;

    const days = diffDays(start_date, end_date);
    const derivedWeeks = days === null ? null : Math.round(((days + 1) / 7) * 100) / 100;

    // The window must sit inside the block it claims to belong to. Without this
    // the assignment is accepted and the cohort master grid — which draws columns
    // from the *block's* dates — silently renders a rotation in a block it does
    // not belong to. Half-block rotations stay legal; only an out-of-block window
    // is rejected.
    const block = await this.getBlockById(rotation_block_id);
    if (block) {
      const blockStart = block.start_date_iso;
      const blockEnd = block.end_date_iso;
      if (blockStart && blockEnd) {
        if (start_date < blockStart || end_date > blockEnd) {
          const error = new Error(
            `Assignment dates ${start_date} to ${end_date} fall outside ${block.block_name} ` +
              `(${blockStart} to ${blockEnd}).`,
          );
          error.statusCode = 400;
          throw error;
        }
      }
    }

    // The departmental seat limit. The check is on *weeks*, not on date ranges:
    // three residents may share a week, but a fourth is over capacity, and the
    // response says which weeks are affected so the coordinator can move the
    // posting rather than guess.
    //
    // The check runs inside the same transaction as the insert below, so two
    // coordinators placing a resident simultaneously cannot both read "3 of 3"
    // and both write a fourth. A read outside the write would make the limit a
    // suggestion under concurrency, which is exactly when a limit matters.
    const conn = await db.getConnection();
    let inTransaction = false;
    let exception = null;
    let capacityOutcome = null;
    try {
      await conn.beginTransaction();
      inTransaction = true;

      const programId = block?.program_id ?? null;
      const check = await RotationCapacityService.checkPlacement(conn, {
        rotation_id,
        program_id: programId,
        // The resident being placed: their own existing rows in this rotation
        // are the same person, not fellow occupants, so the count is a headcount.
        resident_id,
        proposal: { start_date, end_date },
        // Serialise concurrent placements into this rotation: the lock is held
        // until the commit below, so a second coordinator's count includes this
        // one's insert and the limit cannot be exceeded by a race.
        forUpdate: true,
      });
      capacityOutcome = check.result;

      if (check.result && check.result.status === 'BLOCKED') {
        const error = new Error(
          `${check.rotation.rotation_name} has locked its seat limit at ${check.rotation.max_capacity}. ` +
            `${check.result.message}`,
        );
        error.statusCode = 409;
        error.capacity = check.result;
        throw error;
      }

      if (check.result && check.result.requires_exception) {
        const normalized = RotationCapacityService.normalizeException(assignmentData);
        if (!normalized.ok) {
          const error = new Error(normalized.errors.join('; '));
          error.statusCode = 409;
          error.capacity = check.result;
          error.requires_exception = true;
          throw error;
        }
        exception = normalized.values;
      }

      const query = `
        INSERT INTO resident_rotation_assignments
          (resident_id, rotation_id, rotation_block_id, start_date, end_date, assigned_weeks, assignment_type, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `;
      const [result] = await conn.query(query, [
        resident_id,
        rotation_id,
        rotation_block_id,
        start_date,
        end_date,
        Number(assigned_weeks) > 0 ? Number(assigned_weeks) : derivedWeeks ?? 4.0,
        assignment_type || 'FULL_BLOCK',
        notes || null,
      ]);

      // The exception is written in the same transaction as the assignment it
      // excuses. An over-capacity placement with no audit row would be a
      // placement nobody can account for, so the two cannot be allowed to
      // diverge.
      if (exception && check.rotation) {
        await RotationCapacityService.recordException(conn, {
          assignment_id: result.insertId,
          resident_id,
          rotation: check.rotation,
          block_id: rotation_block_id,
          result: check.result,
          exception,
        });
      }

      await conn.commit();
      inTransaction = false;

      // Tell the resident their rota changed. Best-effort: a notification problem
      // must not fail an assignment the coordinator just created.
      await NotificationService.notifyResidentSafe(resident_id, {
        type: 'ROTATION_APPROVAL',
        title: 'Rotation assignment confirmed',
        message: `You have been assigned a ${(assignment_type || 'FULL_BLOCK')
          .toLowerCase()
          .replace(/_/g, ' ')} rotation from ${start_date} to ${end_date}.`,
        reference_id: result.insertId,
        reference_type: 'resident_rotation_assignments',
      });

      // And tell the receiving department, when it belongs to another programme.
      // Best-effort for the same reason — the placement is already committed —
      // and silent when the rotation is the resident's own programme.
      await ProgramConnectionService.noticifyReceivingProgram({
        rotation_id,
        resident_id,
        block_id: rotation_block_id,
        start_date,
        end_date,
        assignment_id: result.insertId,
      });

      return {
        assignment_id: result.insertId,
        ...assignmentData,
        assigned_weeks: Number(assigned_weeks) > 0 ? Number(assigned_weeks) : derivedWeeks,
        capacity: capacityOutcome,
        exception_recorded: exception !== null,
      };
    } catch (error) {
      if (inTransaction) await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  static async getScheduleByResident(residentId) {
    // `rb.block_number` is what every screen labels a rotation with: it is the
    // block's own metadata, whereas `rb.block_name` is coordinator-typed free
    // text and has held a rotation category — production has block 5 named
    // "Pediatrics", which is how a resident's dashboard once read "Pediatrics:
    // Internal Medicine Inpatient Wards".
    //
    // The dates are DATE_FORMATed to `YYYY-MM-DD` rather than left for mysql2 to
    // materialise as a UTC instant: the client parses a bare date as local
    // midnight, so the window cannot shift a day on a device in another tz.
    const query = `
      SELECT
        rra.id AS assignment_id,
        CONCAT(r.first_name, ' ', r.last_name) AS resident_name,
        rb.block_number,
        rb.block_name,
        rot.rotation_name,
        rot.department_name,
        DATE_FORMAT(rra.start_date, '%Y-%m-%d') AS start_date,
        DATE_FORMAT(rra.end_date, '%Y-%m-%d') AS end_date,
        rra.assigned_weeks,
        rra.assignment_type,
        rra.notes
      FROM resident_rotation_assignments rra
      JOIN residents r ON r.id = rra.resident_id
      JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
      JOIN rotations rot ON rot.id = rra.rotation_id
      WHERE rra.resident_id = ?
      ORDER BY rra.start_date ASC;
    `;
    const [rows] = await db.query(query, [residentId]);
    return rows;
  }

  static async getBlockById(blockId) {
    const query = `
      SELECT 
        b.id AS block_id,
        b.program_id,
        p.program_code,
        p.week_start_day,
        b.academic_year,
        b.block_number,
        b.block_name,
        b.start_date,
        b.end_date,
        b.is_active,
        DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date_iso,
        DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date_iso,
        DAYNAME(b.start_date) AS actual_start_day,
        DAYNAME(b.end_date) AS actual_end_day,
        DATEDIFF(b.end_date, b.start_date) + 1 AS block_days,
        (DATEDIFF(b.end_date, b.start_date) + 1) DIV 7 AS block_weeks
      FROM rotation_blocks b
      JOIN programs p ON p.id = b.program_id
      WHERE b.id = ?
    `;
    const [rows] = await db.query(query, [blockId]);
    return rows[0] || null;
  }

  static async hasDependentAssignments(blockId) {
    const query = `
      SELECT COUNT(*) AS count
      FROM resident_rotation_assignments
      WHERE rotation_block_id = ?
    `;
    const [rows] = await db.query(query, [blockId]);
    return rows[0].count > 0;
  }

  /**
   * Update a block, re-deriving its window from the programme's week-start day.
   *
   * An edit is as capable of breaking the Saturday/Sunday boundary as a create
   * is, so the same `weeks * 7 - 1` arithmetic runs here; `duration_weeks` may
   * be passed to resize the block rather than typing an end date by hand.
   */
  static async updateBlock(blockId, blockData) {
    const { block_name, block_number, academic_year } = blockData;
    const existing = await this.getBlockById(blockId);

    const window = await this.resolveBlockDates({
      programId: existing?.program_id ?? blockData.program_id,
      startDate: blockData.start_date ?? existing?.start_date_iso,
      durationWeeks: blockData.duration_weeks,
      endDate: blockData.end_date,
    });

    if (window.errors.length > 0) {
      const error = new Error(window.errors.join(' '));
      error.statusCode = 400;
      throw error;
    }

    const query = `
      UPDATE rotation_blocks
      SET block_name = ?, start_date = ?, end_date = ?, block_number = ?, academic_year = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const [result] = await db.query(query, [
      block_name ?? existing?.block_name,
      window.start_date,
      window.end_date,
      block_number ?? existing?.block_number,
      academic_year ?? existing?.academic_year,
      blockId,
    ]);
    return { affectedRows: result.affectedRows, start_date: window.start_date, end_date: window.end_date };
  }

  static async deleteBlock(blockId) {
    const query = `DELETE FROM rotation_blocks WHERE id = ?`;
    const [result] = await db.query(query, [blockId]);
    return { affectedRows: result.affectedRows };
  }

  /**
   * Add `rotation_blocks.is_finalized` when it is missing.
   *
   * Finalization is the coordinator's declaration that a block's schedule is
   * settled and may be sent out. It lives on the block rather than on each
   * assignment because a block is finalized as a unit — a half-finalized block
   * has no meaning, and a per-assignment flag would let one resident be notified
   * for a schedule still being edited around them.
   *
   * Memoised, and awaited by every reader that selects the column: those selects
   * name `is_finalized` unconditionally, so the DDL has to have converged before
   * they run or a fresh database answers "Unknown column" instead of an empty
   * grid. The promise is cleared on failure so a transient error can retry.
   */
  static async ensureFinalizedColumn() {
    if (!finalizedColumnPromise) {
      finalizedColumnPromise = (async () => {
        const [columns] = await db.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'rotation_blocks'
             AND COLUMN_NAME = 'is_finalized'`
        );
        if (columns.length === 0) {
          await db.query(
            `ALTER TABLE rotation_blocks
             ADD COLUMN is_finalized TINYINT(1) NOT NULL DEFAULT 0 AFTER end_date`
          );
        }
        return true;
      })().catch((error) => {
        finalizedColumnPromise = null;
        throw error;
      });
    }
    return finalizedColumnPromise;
  }

  /**
   * Mark a block finalized (or return it to draft).
   *
   * Returns the stored state rather than the requested one, so a caller that
   * asks for what is already true still reports the truth. Finalizing an empty
   * block is refused: there is nothing to send, and a finalized-empty block
   * would let the grid show a "ready" state for a block nobody has scheduled.
   */
  static async setBlockFinalized(blockId, isFinalized) {
    await this.ensureFinalizedColumn();

    const block = await this.getBlockById(blockId);
    if (!block) {
      const error = new Error(`Rotation block ${blockId} was not found.`);
      error.statusCode = 404;
      throw error;
    }

    const next = isFinalized ? 1 : 0;

    if (next === 1) {
      const [counts] = await db.query(
        `SELECT COUNT(*) AS assignment_count
         FROM resident_rotation_assignments
         WHERE rotation_block_id = ?;`,
        [blockId]
      );
      if (Number(counts[0]?.assignment_count ?? 0) === 0) {
        const error = new Error(
          'This block has no assignments yet, so there is nothing to finalize.'
        );
        error.statusCode = 409;
        throw error;
      }
    }

    await db.query(
      `UPDATE rotation_blocks SET is_finalized = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`,
      [next, blockId]
    );

    return {
      block_id: Number(blockId),
      block_number: block.block_number,
      academic_year: block.academic_year,
      is_finalized: next === 1,
    };
  }

  static async getAssignments(filters = {}) {
    const { program_id, academic_year, block_id, pgy_level } = filters;
    let query = `
      SELECT
        rra.id AS assignment_id,
        rra.resident_id,
        CONCAT(r.first_name, ' ', COALESCE(r.middle_initial, ''), ' ', r.last_name) AS resident_name,
        r.first_name, r.last_name, r.middle_initial,
        ri.identifier_value AS employee_id,
        '' AS phone_mobile,
        re.year_in_program AS pgy_level,
        rb.id AS block_id,
        rb.block_name,
        rb.block_number,
        rb.academic_year,
        rb.start_date AS block_start_date,
        rb.end_date AS block_end_date,
        rot.id AS rotation_id,
        rot.rotation_name,
        rot.department_name,
        rot.rotation_code,
        rra.start_date,
        rra.end_date,
        rra.assigned_weeks,
        rra.assignment_type,
        rra.notes
      FROM resident_rotation_assignments rra
      JOIN residents r ON r.id = rra.resident_id
      JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
      JOIN rotations rot ON rot.id = rra.rotation_id
      LEFT JOIN residency_enrollments re ON re.resident_id = r.id
      LEFT JOIN resident_identifiers ri ON ri.resident_id = r.id AND ri.is_primary = 1
      WHERE 1=1
    `;
    const params = [];
    if (program_id) { query += ' AND rb.program_id = ?'; params.push(program_id); }
    if (academic_year) { query += ' AND rb.academic_year = ?'; params.push(academic_year); }
    if (block_id) { query += ' AND rb.id = ?'; params.push(block_id); }
    if (pgy_level) { query += ' AND re.year_in_program = ?'; params.push(pgy_level); }
    query += ' ORDER BY rb.academic_year DESC, rb.block_number ASC, re.year_in_program DESC, r.first_name ASC, r.last_name ASC';
    const [rows] = await db.query(query, params);
    return rows;
  }

  /**
   * Cohort Master Grid: one row per resident per academic block, so a
   * coordinator sees the whole cohort mapped onto the block calendar in a
   * single response.
   *
   * The grid is driven from `rotation_blocks` and LEFT JOINed to assignments so
   * every resident/block cell is present even when nothing is assigned yet --
   * that missing assignment is the signal the grid exists to surface. Residents
   * are reached through `residency_enrollments` rather than a flat residents
   * scan so PGY level and enrolment status stay per-program.
   *
   * A block may legitimately hold more than one assignment for the same
   * resident (a partial block split across two rotations), so the row grain is
   * one resident/block/assignment rather than one resident/block.
   * `assignment_count` reports how many assignments share the cell so a client
   * pivoting residents-by-blocks can tell a split block from a duplicate row.
   *
   * The employee id comes from a correlated scalar subquery rather than a join:
   * `resident_identifiers.is_primary` is set on every identifier row in this
   * schema, so joining it multiplies each resident by their number of
   * identifiers and silently inflates the grid.
   *
   * `contact_number` is looked up the same way, preferring a contact-type
   * identifier. This schema's `residents` table has no phone column and
   * `resident_identifiers` currently holds only CORPORATE_ID, NATIONAL_ID,
   * PASSPORT and LICENSE_NUMBER, so the column is null today; it is selected
   * rather than hardcoded as `''` so a mobile number recorded later appears in
   * the grid without another migration of the query.
   *
   * Block dates are also returned DATE_FORMAT'd: mysql2 materialises a DATE
   * column at the server's local midnight, so the raw value is a UTC instant
   * whose local calendar day is the truth and whose `.slice(0, 10)` is a day
   * early for anyone west of the server's offset.
   *
   * Rows are ordered block-first so the client's column mapping is stable, and
   * within a block the senior cohort leads: `year_in_program` descending
   * (PGY-5 down to PGY-1), then first name, then last name. The grid renders
   * residents in the order they first appear, so this single ORDER BY sets the
   * on-screen top-down order. `year_in_program` is a small integer, so a plain
   * `DESC` is both correct and cheaper than the string-matching `CASE ... LIKE`
   * a free-text PGY column would require.
   *
   * Cross-programme rows ride along as well: residents *enrolled elsewhere*
   * who hold an assignment in one of this programme's rotations come back
   * flagged `is_external`, with `home_program_name` / `home_program_code`
   * carrying the programme they belong to. The receiving programme's grid
   * therefore shows the visitors it has to host (e.g. a Family Medicine
   * PGY-5 on Internal Medicine Inpatient Wards for Block 6), and the client
   * can draw them in a separate section with a home-programme badge.
   *
   * @param {object} filters
   * @param {string} filters.academic_year - Required. Accepts "2026/2027" or "2026-2027".
   * @param {number} [filters.program_id]  - Restrict to one program.
   * @param {number} [filters.pgy_level]   - Restrict to one year in program.
   * @param {string} [filters.resident_status] - Restrict to an enrolment status.
   */
  static async getCohortGrid(filters = {}) {
    const { program_id, pgy_level, resident_status } = filters;
    const yearValues = academicYearMatchValues(filters.academic_year);
    await this.ensureFinalizedColumn();

    // One year list, reused by both queries below.
    const yearInList = yearValues.map(() => '?').join(', ');

    // --- The enrolled cohort ---------------------------------------------
    // Driven from `rotation_blocks`: every resident/block cell is present even
    // when nothing is assigned yet, because that missing assignment is the
    // signal the grid exists to surface.
    let query = `
      SELECT
        ${COHORT_GRID_COLUMNS}
      FROM rotation_blocks rb
      JOIN programs p ON p.id = rb.program_id
      JOIN residency_enrollments re ON re.program_id = rb.program_id
      JOIN residents r ON r.id = re.resident_id
      LEFT JOIN resident_rotation_assignments rra
        ON rra.resident_id = re.resident_id AND rra.rotation_block_id = rb.id
      LEFT JOIN rotations rot ON rot.id = rra.rotation_id
      WHERE rb.academic_year IN (${yearInList})
    `;
    const params = [...yearValues];

    if (program_id) { query += ' AND rb.program_id = ?'; params.push(program_id); }
    if (pgy_level) { query += ' AND re.year_in_program = ?'; params.push(pgy_level); }
    if (resident_status) { query += ' AND re.resident_status = ?'; params.push(resident_status); }
    query += ' ORDER BY rb.block_number ASC, re.year_in_program DESC, r.first_name ASC, r.last_name ASC';

    const [internalRows] = await db.query(query, params);

    // --- The visiting cohort ---------------------------------------------
    // Cross-programme visibility: a Family Medicine resident posted onto an
    // Internal Medicine ward must appear on the *receiving* programme's grid
    // for that block, or the department that has to host them cannot see them
    // at all. Driven from the assignments themselves — a visitor only has
    // cells where they actually rotate — but projected through the exact same
    // column list, so both row shapes are interchangeable to a client.
    //
    // A visitor is a resident whose *home* enrolment (their most recent
    // enrolment outside this programme) points elsewhere, who holds at least
    // one assignment in a rotation this programme owns, inside a block this
    // programme owns. Residents who also hold an enrolment in the viewing
    // programme are excluded — they are already in the cohort above, and
    // showing them twice would double their rows.
    let externalRows = [];
    if (program_id) {
      await ensureTargetProgramColumn();
      let externalQuery = `
        SELECT
          ${COHORT_GRID_COLUMNS}
        FROM resident_rotation_assignments rra
        JOIN rotations rot ON rot.id = rra.rotation_id AND (rot.program_id = ? OR rot.target_program_id = ?)
        JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id AND rb.program_id = ?
        JOIN programs p ON p.id = rb.program_id
        JOIN residents r ON r.id = rra.resident_id
        JOIN residency_enrollments re ON re.id = (
          SELECT re2.id FROM residency_enrollments re2
          WHERE re2.resident_id = r.id AND re2.program_id <> rb.program_id
          ORDER BY re2.created_at DESC, re2.id DESC
          LIMIT 1
        )
        WHERE rb.academic_year IN (${yearInList})
          AND NOT EXISTS (
            SELECT 1 FROM residency_enrollments re_int
            WHERE re_int.resident_id = r.id AND re_int.program_id = rb.program_id
          )
      `;
      // A rotation counts for this programme when the programme owns it *or*
      // when another programme has targeted it here (`target_program_id`), so
      // a Family Medicine ward rotation linked to Internal Medicine lights up
      // the Internal Medicine grid. The block must still be this programme's
      // own — cells are drawn against the viewing programme's calendar.
      const externalParams = [program_id, program_id, program_id, ...yearValues];
      // The cohort filter applies to the visitor's *home* PGY level, so a
      // PGY-5 filter surfaces the FM PGY-5 rotating in, not a phantom level.
      if (pgy_level) { externalQuery += ' AND re.year_in_program = ?'; externalParams.push(pgy_level); }
      if (resident_status) { externalQuery += ' AND re.resident_status = ?'; externalParams.push(resident_status); }
      externalQuery += ' ORDER BY rb.block_number ASC, re.year_in_program DESC, r.first_name ASC, r.last_name ASC';

      const [rows] = await db.query(externalQuery, externalParams);
      externalRows = rows;
    }

    return [...internalRows, ...externalRows].map((row) => ({ ...row, ...decodeClinicColumns(row) }));
  }

  /**
   * Resolve an academic year to the programs and calendar window that define it.
   *
   * `resident_longitudinal_assignments` carries no academic-year column, so the
   * longitudinal matrix reaches the year indirectly: rotation_blocks are the
   * only table that maps a year onto a program and a date span.
   *
   * @param {string} academicYear - "2026/2027" or "2026-2027"; both are matched.
   * @param {number} [programId]
   * @returns {Promise<Array<{program_id:number, window_start:string, window_end:string}>>}
   */
  static async getAcademicYearScopes(academicYear, programId = null) {
    const yearValues = academicYearMatchValues(academicYear);

    let query = `
      SELECT
        program_id,
        MIN(start_date) AS window_start,
        MAX(end_date) AS window_end
      FROM rotation_blocks
      WHERE academic_year IN (${yearValues.map(() => '?').join(', ')})
    `;
    const params = [...yearValues];
    if (programId) { query += ' AND program_id = ?'; params.push(programId); }
    query += ' GROUP BY program_id ORDER BY program_id ASC';

    const [rows] = await db.query(query, params);
    return rows;
  }
}

module.exports = RotationService;
module.exports.PRIMARY_IDENTIFIER_SQL = PRIMARY_IDENTIFIER_SQL;
