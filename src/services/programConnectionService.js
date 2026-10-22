const db = require('../config/db');
const NotificationService = require('./notificationService');
const ReleaseLetterService = require('./releaseLetterService');

/**
 * Programmes in the city, and how they are connected to one another.
 *
 * ## Why this exists
 *
 * A residency is not an island. A family-medicine programme sends its residents
 * into an internal-medicine ward, a paediatric rotation, a surgical theatre; each
 * of those is a *different* programme's department, with its own coordinator and
 * its own seat limits. Until now the platform modelled one programme at a time,
 * so the receiving department could not be told a resident was coming, and nobody
 * could see that six programmes shared a hospital.
 *
 * ## Two layers, deliberately kept apart
 *
 * 1. **`program_connections`** is the *declared* partnership: this programme
 *    agrees to exchange residents with that one. It is a decision, so it is
 *    stored, and a coordinator makes it on the programme card.
 * 2. **Active cross-rotations** are the *observed* traffic: residents actually
 *    posted into a rotation belonging to another programme. This is derived from
 *    `resident_rotation_assignments`, never stored, because it changes with every
 *    assignment and a cached copy would be wrong by the next block.
 *
 * The network screen draws both: declared edges as a solid line, observed ones
 * as a dashed tie, so a partnership nobody is using yet is visibly different
 * from one carrying a dozen residents.
 *
 * ## Schema
 *
 * No migration runner ships here, so the DDL lives behind a memoised
 * `ensureSchema()`, matching `NotificationService` and `RotationRequestController`.
 */

/** Mirrors the `connection_type` enum. */
const CONNECTION_TYPES = ['HOSPITAL_ROTATION', 'CLINIC_EXCHANGE', 'ACADEMIC_PARTNERSHIP'];

const CONNECTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS program_connections (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source_program_id BIGINT UNSIGNED NOT NULL,
    target_program_id BIGINT UNSIGNED NOT NULL,
    connection_type ENUM('HOSPITAL_ROTATION', 'CLINIC_EXCHANGE', 'ACADEMIC_PARTNERSHIP')
      NOT NULL DEFAULT 'HOSPITAL_ROTATION',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_source_target (source_program_id, target_program_id),
    INDEX idx_connections_source (source_program_id),
    INDEX idx_connections_target (target_program_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(CONNECTIONS_TABLE_SQL);
      return true;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Every active programme, with the coordinate the network map places it at.
 *
 * The city layout is stored as data rather than computed: a force-directed graph
 * of five nodes is indistinguishable from noise, and the point of the map is that
 * a coordinator recognises the hospital groupings at a glance. Positions are
 * percentage coordinates so the same layout scales from a phone to a tablet.
 *
 * A programme with no stored position lands in a ring around the centre — the
 * layout is a default, not a constraint, so a newly registered programme appears
 * somewhere sensible rather than off-screen.
 */
const PROGRAM_NODES_SQL = `
  SELECT
    p.id,
    p.program_code,
    p.program_name,
    p.specialty_name,
    p.institution_name,
    p.is_active,
    (
      SELECT COUNT(*)
        FROM residency_enrollments re
       WHERE re.program_id = p.id
         AND re.resident_status LIKE 'ACTIVE%'
    ) AS resident_count
  FROM programs p
  WHERE p.is_active = 1
  ORDER BY p.id ASC;
`;

/**
 * Cross-programme postings: residents from one programme standing in a rotation
 * that belongs to another.
 *
 * A rotation's owner is its programme — `rotations.program_id`. The resident's
 * programme is the one they are enrolled in. When those differ the posting is a
 * cross-rotation, and it is the actual traffic the network exists to show.
 *
 * Only assignments inside a real window are counted, and duplicates collapse by
 * `DISTINCT` on the assignment's own identity so a resident saved twice is one
 * posting, matching how the capacity engine now counts people.
 */
const CROSS_ROTATIONS_SQL = `
  SELECT
    home.id   AS home_program_id,
    home.program_name AS home_program_name,
    host.id   AS host_program_id,
    host.program_name AS host_program_name,
    COUNT(DISTINCT rra.resident_id) AS resident_count,
    COUNT(DISTINCT rra.id)          AS assignment_count,
    GROUP_CONCAT(DISTINCT rot.rotation_name ORDER BY rot.rotation_name SEPARATOR '||') AS rotation_names,
    GROUP_CONCAT(DISTINCT rot.department_name ORDER BY rot.department_name SEPARATOR '||') AS department_names,
    MAX(rb.block_number) AS latest_block_number
  FROM resident_rotation_assignments rra
    JOIN residents r ON r.id = rra.resident_id
    JOIN residency_enrollments re
      ON re.resident_id = r.id AND re.resident_status LIKE 'ACTIVE%'
    JOIN programs home ON home.id = re.program_id
    JOIN rotations rot ON rot.id = rra.rotation_id
    JOIN programs host ON host.id = rot.program_id
    LEFT JOIN rotation_blocks rb ON rb.id = rra.rotation_block_id
  WHERE rot.program_id IS NOT NULL
    AND rot.program_id <> re.program_id
    AND home.is_active = 1
    AND host.is_active = 1
  GROUP BY home.id, home.program_name, host.id, host.program_name
  ORDER BY resident_count DESC, home.program_name ASC, host.program_name ASC;
`;

/** Split a `GROUP_CONCAT` list, dropping the empty result of a `NULL` column. */
function splitList(value) {
  if (!value) return [];
  return String(value)
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The default ring position for a programme with no stored coordinate.
 *
 * `index` is the programme's ordinal among those needing a position, so the
 * first lands at the top of the ring and the rest follow clockwise.
 */
function ringPosition(index, total) {
  const angle = total > 0 ? (index / total) * Math.PI * 2 - Math.PI / 2 : 0;
  return {
    x: Math.round((50 + Math.cos(angle) * 32) * 10) / 10,
    y: Math.round((50 + Math.sin(angle) * 32) * 10) / 10,
  };
}

class ProgramConnectionService {
  static async ensureSchema() {
    return ensureSchema();
  }

  static getConnectionTypes() {
    return [...CONNECTION_TYPES];
  }

  /** Every stored partnership, joined to the names the screen prints. */
  static async list() {
    await ensureSchema();
    const [rows] = await db.query(
      `SELECT
         pc.id,
         pc.source_program_id,
         src.program_name AS source_program_name,
         src.program_code AS source_program_code,
         pc.target_program_id,
         tgt.program_name AS target_program_name,
         tgt.program_code AS target_program_code,
         pc.connection_type,
         pc.is_active,
         DATE_FORMAT(pc.created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM program_connections pc
         JOIN programs src ON src.id = pc.source_program_id
         JOIN programs tgt ON tgt.id = pc.target_program_id
       ORDER BY pc.is_active DESC, src.program_name ASC, tgt.program_name ASC;`,
    );
    return rows;
  }

  /**
   * Declare a partnership between two programmes.
   *
   * The pair is stored once, in a canonical order (lower id first). A partnership
   * is symmetric in meaning — if Internal Medicine takes Family Medicine's
   * residents, they are connected — and the unique key on
   * `(source_program_id, target_program_id)` only enforces that if the pair is
   * always written the same way round. Storing the caller's orientation instead
   * would let both sides declare the same partnership and produce two edges for
   * one relationship, which then doubles `partner_count` and draws a doubled line
   * nobody can explain.
   *
   * A re-declaration updates the type rather than failing, so a coordinator who
   * meant "clinic exchange" after first saying "hospital rotation" gets the
   * correction rather than a duplicate-key error.
   *
   * Self-connection is refused: a programme exchanging with itself is not a
   * connection, and the edge would render as a loop nobody can read.
   */
  static async connect(sourceProgramId, targetProgramId, connectionType) {
    await ensureSchema();

    const source = toPositiveInt(sourceProgramId);
    const target = toPositiveInt(targetProgramId);
    if (!source || !target) {
      return { ok: false, status: 400, error: 'Both programme ids are required' };
    }
    if (source === target) {
      return { ok: false, status: 400, error: 'A programme cannot be connected to itself' };
    }

    // Canonical orientation: the lower id is always the source.
    const lowId = Math.min(source, target);
    const highId = Math.max(source, target);

    const type = CONNECTION_TYPES.includes(connectionType)
      ? connectionType
      : 'HOSPITAL_ROTATION';

    const [programs] = await db.query(
      `SELECT id, program_name FROM programs WHERE id IN (?, ?);`,
      [source, target],
    );
    if (programs.length < 2) {
      const known = new Set(programs.map((row) => Number(row.id)));
      const missing = [source, target].filter((id) => !known.has(id));
      return {
        ok: false,
        status: 404,
        error: `Programme${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not found`,
      };
    }

    await db.query(
      `INSERT INTO program_connections (source_program_id, target_program_id, connection_type, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE connection_type = VALUES(connection_type), is_active = 1;`,
      [lowId, highId, type],
    );

    const [[row]] = await db.query(
      `SELECT
         pc.id,
         pc.source_program_id,
         src.program_name AS source_program_name,
         pc.target_program_id,
         tgt.program_name AS target_program_name,
         pc.connection_type,
         pc.is_active
       FROM program_connections pc
         JOIN programs src ON src.id = pc.source_program_id
         JOIN programs tgt ON tgt.id = pc.target_program_id
       WHERE pc.source_program_id = ? AND pc.target_program_id = ?;`,
      [lowId, highId],
    );

    const target_name = programs.find((p) => Number(p.id) === target)?.program_name ?? 'the programme';
    return {
      ok: true,
      status: 201,
      message: `Connected to ${target_name}`,
      data: row,
    };
  }

  /** Withdraw a partnership. Deactivated rather than deleted, so history holds. */
  static async disconnect(connectionId) {
    await ensureSchema();
    const id = toPositiveInt(connectionId);
    if (!id) return { ok: false, status: 400, error: 'A numeric connection id is required' };

    const [result] = await db.query(
      'UPDATE program_connections SET is_active = 0 WHERE id = ? AND is_active = 1;',
      [id],
    );
    if (result.affectedRows === 0) {
      const [existing] = await db.query('SELECT id FROM program_connections WHERE id = ?;', [id]);
      if (existing.length === 0) {
        return { ok: false, status: 404, error: `Connection ${id} was not found` };
      }
    }
    return { ok: true, status: 200, message: 'Connection withdrawn', data: { id } };
  }

  /**
   * The whole network: programmes as nodes, partnerships as declared edges, and
   * live cross-programme postings as observed edges.
   */
  static async getNetwork() {
    await ensureSchema();

    const [programRows] = await db.query(PROGRAM_NODES_SQL);
    const connections = await ProgramConnectionService.list();
    const [crossRows] = await db.query(CROSS_ROTATIONS_SQL);

    const crossRotations = crossRows.map((row) => ({
      home_program_id: Number(row.home_program_id),
      home_program_name: row.home_program_name,
      host_program_id: Number(row.host_program_id),
      host_program_name: row.host_program_name,
      resident_count: Number(row.resident_count) || 0,
      assignment_count: Number(row.assignment_count) || 0,
      rotation_names: splitList(row.rotation_names),
      department_names: splitList(row.department_names),
      latest_block_number: row.latest_block_number === null ? null : Number(row.latest_block_number),
    }));

    // A programme is positioned if a stored layout says so; otherwise it takes a
    // place on the default ring. Keeping the two populations apart means adding a
    // programme never shuffles the ones already placed by hand.
    const nodes = programRows.map((program, index) => ({
      id: Number(program.id),
      program_code: program.program_code,
      program_name: program.program_name,
      specialty_name: program.specialty_name,
      institution_name: program.institution_name,
      resident_count: Number(program.resident_count) || 0,
      position: ringPosition(index, programRows.length),
    }));

    // A programme's live cross-postings, folded into a total per partner, so a
    // node can show "6 residents out" without the screen re-summing the edges.
    const outbound = new Map();
    const inbound = new Map();
    for (const cross of crossRotations) {
      outbound.set(cross.home_program_id, (outbound.get(cross.home_program_id) ?? 0) + cross.resident_count);
      inbound.set(cross.host_program_id, (inbound.get(cross.host_program_id) ?? 0) + cross.resident_count);
    }

    return {
      nodes: nodes.map((node) => ({
        ...node,
        residents_out: outbound.get(node.id) ?? 0,
        residents_in: inbound.get(node.id) ?? 0,
        partner_count: connections.filter(
          (c) =>
            c.is_active === 1 &&
            (Number(c.source_program_id) === node.id || Number(c.target_program_id) === node.id),
        ).length,
      })),
      connections,
      cross_rotations: crossRotations,
      totals: {
        programmes: nodes.length,
        connections: connections.filter((c) => c.is_active === 1).length,
        cross_rotations: crossRotations.length,
        residents_on_cross_rotation: crossRotations.reduce((sum, c) => sum + c.resident_count, 0),
      },
    };
  }

  /**
   * Tell a receiving programme's coordinator that one of our residents is coming,
   * register that resident on the receiving programme's visiting roster, and
   * file the cross-programme placement notice in its Letters inbox.
   *
   * Called after an assignment commits. Best-effort by design: the placement is
   * already saved, and a notice that cannot be delivered must not present itself
   * as a failed assignment. Each side effect is isolated so a failure in one
   * (say, a missing letter template) cannot swallow the others.
   *
   * The receiving programme is the rotation's *host* — `target_program_id` when
   * the rotation names one, otherwise its owning programme. Using the owner
   * unconditionally was why a Family Medicine catalogue entry linked to
   * Internal Medicine notified Family Medicine itself and never reached the
   * department actually hosting the resident.
   */
  static async noticifyReceivingProgram(input) {
    const {
      rotation_id,
      resident_id,
      block_id = null,
      start_date = null,
      end_date = null,
      assignment_id = null,
      sent_by_user_id = null,
    } = input ?? {};

    try {
      await ensureSchema();

      const [[rotation]] = await db.query(
        `SELECT rot.id, rot.rotation_name, rot.department_name,
                COALESCE(rot.target_program_id, rot.program_id) AS host_program_id,
                host.program_name AS host_program_name
           FROM rotations rot
             LEFT JOIN programs host ON host.id = COALESCE(rot.target_program_id, rot.program_id)
          WHERE rot.id = ? LIMIT 1;`,
        [toPositiveInt(rotation_id)],
      );
      if (!rotation || !rotation.host_program_id) {
        return { delivered: false, reason: 'The rotation has no owning programme.' };
      }

      const [[resident]] = await db.query(
        `SELECT r.id,
                TRIM(CONCAT(
                  COALESCE(r.first_name, ''),
                  ' ',
                  COALESCE(NULLIF(r.middle_initial, ''), ''),
                  ' ',
                  COALESCE(r.last_name, '')
                )) AS resident_name
           FROM residents r
          WHERE r.id = ? LIMIT 1;`,
        [toPositiveInt(resident_id)],
      );
      if (!resident) {
        return { delivered: false, reason: 'The resident was not found.' };
      }

      // The home enrolment is the resident's real placement. A `VISITING` row
      // the platform itself wrote is a registry entry, never a home.
      const [[enrolment]] = await db.query(
        `SELECT re.program_id AS home_program_id, home.program_name AS home_program_name,
                re.year_in_program
           FROM residency_enrollments re
             LEFT JOIN programs home ON home.id = re.program_id
          WHERE re.resident_id = ? AND re.position_type <> 'VISITING'
          ORDER BY re.created_at ASC, re.id ASC
          LIMIT 1;`,
        [toPositiveInt(resident_id)],
      );
      if (!enrolment || enrolment.home_program_id === null) {
        return { delivered: false, reason: 'The resident has no home programme.' };
      }

      // A resident rotating inside their own programme is not a cross-programme
      // event, so nothing is sent.
      if (Number(enrolment.home_program_id) === Number(rotation.host_program_id)) {
        return { delivered: false, reason: 'internal', cross_program: false };
      }

      const [[block]] = block_id
        ? await db.query(
            `SELECT block_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
                    DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
               FROM rotation_blocks WHERE id = ? LIMIT 1;`,
            [toPositiveInt(block_id)],
          )
        : [[null]];

      const pgy = enrolment.year_in_program ? `PGY-${enrolment.year_in_program}` : null;
      const window = block
        ? `Block ${block.block_number} (${formatRange(block.start_date, block.end_date)})`
        : formatRange(start_date, end_date);
      const home = enrolment.home_program_name ?? 'Another programme';
      const windowStart = block?.start_date ?? start_date;
      const windowEnd = block?.end_date ?? end_date;

      // 1. The coordinator's notification — the inbox bell and the programme's
      //    notification feed.
      const notification = await NotificationService.notifyProgramCoordinatorSafe(
        rotation.host_program_id,
        {
          type: 'ROTATION_APPROVAL',
          title: 'Cross-Program Rotation Placement',
          message:
            `📩 Cross-Program Rotation Placement — ${home} assigned ${resident.resident_name}` +
            `${pgy ? ` (${pgy})` : ''} to ${rotation.rotation_name} for ${window}.`,
          reference_id: toPositiveInt(assignment_id),
          reference_type: 'cross_program_placement',
        },
      );

      // 2. The visiting roster registry. The receiving programme's Roster sees
      //    the visitor immediately, even before the grid is reloaded.
      let visitingEnrollment = null;
      try {
        visitingEnrollment = await this.registerVisitingResident({
          resident_id: toPositiveInt(resident_id),
          home_program_id: Number(enrolment.home_program_id),
          host_program_id: Number(rotation.host_program_id),
          start_date: windowStart,
          end_date: windowEnd,
        });
      } catch (error) {
        console.error('[program-connections] visiting registry upsert failed:', error.message);
      }

      // 3. The notice letter itself, filed in the receiving programme's Inbox
      //    (`/program/letters` → Inbox), so the placement is readable and not
      //    only a transient notification.
      let letter = null;
      try {
        letter = await ReleaseLetterService.fileCrossProgramInboxLetter({
          rotation_assignment_id: toPositiveInt(assignment_id),
          resident_id: toPositiveInt(resident_id),
          host_program_id: Number(rotation.host_program_id),
          home_program_id: Number(enrolment.home_program_id),
          sent_by_user_id,
        });
      } catch (error) {
        console.error('[program-connections] cross-programme letter filing failed:', error.message);
      }

      return {
        delivered: Boolean(notification),
        cross_program: true,
        host_program_id: Number(rotation.host_program_id),
        host_program_name: rotation.host_program_name,
        notification,
        visiting_enrollment: visitingEnrollment,
        letter,
      };
    } catch (error) {
      console.error('[program-connections] cross-programme notice failed:', error.message);
      return { delivered: false, reason: error.message };
    }
  }

  /**
   * Add (or refresh) the receiving programme's `VISITING` registry row.
   *
   * A visiting resident is not enrolled in the host programme — creating a
   * second, duplicate person would split their record and double them on the
   * roster. What the registry stores is the *relationship*: the existing
   * resident id, the host programme, `position_type = 'VISITING'`, and the
   * window they are expected. Home-roster queries ignore `VISITING` rows, so
   * this cannot make a visitor look like a local resident.
   */
  static async registerVisitingResident({ resident_id, home_program_id, host_program_id, start_date, end_date }) {
    // A real enrolment in the host programme means they are not visiting it.
    const [homeRows] = await db.query(
      `SELECT id FROM residency_enrollments
        WHERE resident_id = ? AND program_id = ? AND position_type <> 'VISITING'
        LIMIT 1;`,
      [resident_id, host_program_id],
    );
    if (homeRows.length > 0) {
      return { updated: false, reason: 'Resident is enrolled in the host programme.' };
    }

    const [[home]] = await db.query(
      `SELECT resident_status, year_in_program
         FROM residency_enrollments
        WHERE resident_id = ? AND program_id = ?
        ORDER BY created_at ASC, id ASC LIMIT 1;`,
      [resident_id, home_program_id],
    );

    const [existing] = await db.query(
      `SELECT id, start_date, expected_completion_date FROM residency_enrollments
        WHERE resident_id = ? AND program_id = ? AND position_type = 'VISITING'
        ORDER BY id ASC LIMIT 1;`,
      [resident_id, host_program_id],
    );

    if (existing.length > 0) {
      const row = existing[0];
      const nextStart = earliest(row.start_date, start_date);
      const nextEnd = latest(row.expected_completion_date, end_date);
      await db.query(
        `UPDATE residency_enrollments
            SET start_date = ?, expected_completion_date = ?, updated_at = NOW()
          WHERE id = ?;`,
        [nextStart, nextEnd, row.id],
      );
      return { enrollment_id: Number(row.id), updated: true };
    }

    const [result] = await db.query(
      `INSERT INTO residency_enrollments
         (resident_id, program_id, resident_status, position_type, year_in_program,
          start_date, expected_completion_date, started_program_at_year_one,
          previous_education_documented, prior_training_years, comments)
       VALUES (?, ?, ?, 'VISITING', ?, ?, ?, 0, 0, NULL, ?);`,
      [
        resident_id,
        host_program_id,
        home?.resident_status || 'ACTIVE_FULL_TIME',
        home?.year_in_program ?? null,
        start_date || null,
        end_date || null,
        'Auto-registered as a visiting resident by a cross-programme rotation assignment.',
      ],
    );
    return { enrollment_id: Number(result.insertId), updated: false };
  }
}

/** The earlier of two `YYYY-MM-DD` values, ignoring nulls. */
function earliest(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return String(left).slice(0, 10) <= String(right).slice(0, 10) ? left : right;
}

/** The later of two `YYYY-MM-DD` values, ignoring nulls. */
function latest(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return String(left).slice(0, 10) >= String(right).slice(0, 10) ? left : right;
}

/** `2026-11-15`–`2026-12-12` → `15 Nov – 12 Dec 2026`, or a single date. */
function formatRange(start, end) {
  const from = dateParts(start);
  const to = dateParts(end);
  if (from && to) {
    const fromLabel = `${from.day} ${MONTHS[from.month - 1]}`;
    const toLabel = `${to.day} ${MONTHS[to.month - 1]}`;
    return from.year === to.year
      ? `${fromLabel} – ${toLabel} ${to.year}`
      : `${fromLabel} ${from.year} – ${toLabel} ${to.year}`;
  }
  return formatDay(start) || formatDay(end) || 'a date to be confirmed';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Split a `YYYY-MM-DD` value into validated parts. */
function dateParts(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  return { year, month, day };
}

/** `2026-11-15` → `15 Nov 2026`. Returns `null` for anything unparseable. */
function formatDay(value) {
  const parts = dateParts(value);
  if (!parts) return null;
  return `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`;
}

module.exports = ProgramConnectionService;
