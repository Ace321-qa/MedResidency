const db = require('../config/db');

/**
 * Resident messages — the mailbox behind the resident's Letters tab.
 *
 * A resident writes to the programme office: a rotation overlap, a schedule
 * conflict, a duty-hours question. The message lives in one of three folders,
 * and the folder is what the screen reads:
 *
 *  - `DRAFT` — written, not sent. Only the resident sees it.
 *  - `SENT`   — delivered to the programme office. The programme reads the same
 *               row from its own side, so there is exactly one record of what
 *               was said rather than a sent copy and a received copy that can
 *               drift apart.
 *  - `INBOX`  — a message the programme office sent back to the resident.
 *
 * The schema below is the one the API contract specifies. This repository ships
 * no migration runner, so the DDL lives here behind a memoised
 * `ensureSchema()` — the same approach `RotationRequestController`,
 * `NotificationService` and `LongitudinalService` take against the
 * pre-existing Hostinger database.
 *
 * `is_read` is a plain boolean rather than a `read_at` timestamp: the inbox
 * only needs "has the resident seen this", and a second column would have to
 * be kept in step with it.
 */
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS resident_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    resident_id BIGINT UNSIGNED NOT NULL,
    program_id BIGINT UNSIGNED NOT NULL,
    recipient_department VARCHAR(255) NULL,
    subject VARCHAR(255) NOT NULL,
    body LONGTEXT NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
    folder ENUM('INBOX', 'DRAFT', 'SENT') NOT NULL DEFAULT 'SENT',
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_res_folder (resident_id, folder),
    INDEX idx_res_program (program_id, folder)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/** The three folders the API and the screen agree on. */
const VALID_FOLDERS = ['INBOX', 'DRAFT', 'SENT'];
/**
 * The categories the compose form offers.
 *
 * A closed set on purpose: the category is what the programme office sorts a
 * raised issue by, so a value the database does not know would file the message
 * nowhere.
 */
const VALID_CATEGORIES = [
  'ROTATION_ISSUE',
  'SCHEDULE_CONFLICT',
  'DUTY_HOURS_INQUIRY',
  'GENERAL',
];

const MAX_SUBJECT_LENGTH = 255;
const MAX_BODY_LENGTH = 20000;
const MAX_RECIPIENT_LENGTH = 255;

/** Memoised DDL — every handler awaits this before touching the table. */
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(TABLE_SQL);
      return true;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/** The columns every read shares, so the two queries cannot drift apart. */
const MESSAGE_SELECT = `
  SELECT m.id,
         m.resident_id,
         m.program_id,
         m.recipient_department,
         m.subject,
         m.body,
         m.category,
         m.folder,
         m.is_read,
         m.created_at,
         m.updated_at,
         CONCAT(r.first_name, ' ', r.last_name) AS resident_name
    FROM resident_messages m
    LEFT JOIN residents r ON r.id = m.resident_id`;

/** A trimmed string, or `null` when it is absent or only whitespace. */
function trimToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

class ResidentMessageService {
  /**
   * The three boxes for one resident.
   *
   * One statement rather than three: the folders are disjoint views of the same
   * rows, so reading them separately would let a row written between two
   * queries appear in one box and not the other.
   */
  static async listForResident(residentId) {
    await ensureSchema();

    const [rows] = await db.query(
      `${MESSAGE_SELECT}
        WHERE m.resident_id = ?
        ORDER BY m.updated_at DESC, m.id DESC`,
      [residentId],
    );

    const boxes = { inbox: [], drafts: [], sent: [] };
    for (const row of rows) {
      if (row.folder === 'DRAFT') boxes.drafts.push(row);
      else if (row.folder === 'INBOX') boxes.inbox.push(row);
      else boxes.sent.push(row);
    }
    return boxes;
  }

  /**
   * The programme office's view of the issues raised against it.
   *
   * A `SENT` row *is* the delivery: the resident wrote it, the programme reads
   * it. There is no second copy to keep in step, and no way for the two sides
   * to disagree about what was said.
   */
  static async listForProgram(programId, options = {}) {
    await ensureSchema();

    const folder = VALID_FOLDERS.includes(String(options.folder).toUpperCase())
      ? String(options.folder).toUpperCase()
      : 'SENT';

    const [rows] = await db.query(
      `${MESSAGE_SELECT}
        WHERE m.program_id = ? AND m.folder = ?
        ORDER BY m.created_at DESC, m.id DESC`,
      [programId, folder],
    );
    return rows;
  }

  /** One message by id, or `null`. */
  static async readOne(id) {
    await ensureSchema();
    const [rows] = await db.query(`${MESSAGE_SELECT} WHERE m.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  }

  /** Write a message. `folder` decides whether it is a draft or a delivery. */
  static async create({
    residentId,
    programId,
    recipientDepartment = null,
    subject,
    body,
    category = 'GENERAL',
    folder = 'SENT',
  }) {
    await ensureSchema();

    const [result] = await db.query(
      `INSERT INTO resident_messages
         (resident_id, program_id, recipient_department, subject, body, category, folder, is_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        residentId,
        programId,
        recipientDepartment ? String(recipientDepartment).slice(0, MAX_RECIPIENT_LENGTH) : null,
        String(subject).slice(0, MAX_SUBJECT_LENGTH),
        String(body),
        category,
        folder,
      ],
    );

    return ResidentMessageService.readOne(result.insertId);
  }

  /**
   * Change the parts of a message that are allowed to change.
   *
   * `resident_id`, `program_id` and `id` are not editable: they say who the
   * message is about, and a message that could be re-pointed at another
   * resident would be a way to write into someone else's mailbox.
   */
  static async update(id, changes) {
    await ensureSchema();

    const columns = {
      recipient_department: 'recipient_department',
      subject: 'subject',
      body: 'body',
      category: 'category',
      folder: 'folder',
      is_read: 'is_read',
    };

    const assignments = [];
    const params = [];

    for (const [key, column] of Object.entries(columns)) {
      if (!(key in changes) || changes[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      params.push(changes[key]);
    }

    if (assignments.length === 0) {
      return ResidentMessageService.readOne(id);
    }

    params.push(id);
    await db.query(
      `UPDATE resident_messages SET ${assignments.join(', ')} WHERE id = ?`,
      params,
    );

    return ResidentMessageService.readOne(id);
  }

  /**
   * Delete one of the resident's own messages.
   *
   * Only drafts and inbox copies may go. A `SENT` row is the programme's record
   * of what a resident said to it, so it is not the resident's to erase.
   */
  static async remove(id, residentId) {
    await ensureSchema();

    const [result] = await db.query(
      'DELETE FROM resident_messages WHERE id = ? AND resident_id = ? AND folder <> ?',
      [id, residentId, 'SENT'],
    );
    return result.affectedRows > 0;
  }
}

module.exports = ResidentMessageService;
module.exports.VALID_FOLDERS = VALID_FOLDERS;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
module.exports.MAX_SUBJECT_LENGTH = MAX_SUBJECT_LENGTH;
module.exports.MAX_BODY_LENGTH = MAX_BODY_LENGTH;
module.exports.MAX_RECIPIENT_LENGTH = MAX_RECIPIENT_LENGTH;
module.exports.ensureSchema = ensureSchema;
module.exports.trimToNull = trimToNull;
