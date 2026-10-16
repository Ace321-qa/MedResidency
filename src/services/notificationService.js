const db = require('../config/db');

/**
 * Notifications — the persisted record behind the bell in the resident app.
 *
 * Until now there was no `notifications` table and the mobile screen rendered
 * sample rows. Every system event that a resident should be told about (a
 * duty-hour breach, a leave decision, a rotation approval) now writes a row
 * here, and the app reads it back and posts read receipts.
 *
 * ## Recipient identity
 *
 * The notifications table keys on `users.id`, not `residents.id`, so the schema
 * survives the arrival of real authentication (a resident and a coordinator
 * both become `users`). No auth exists yet, so a resident is provisionally
 * provisioned a `users` row on first notification — `resolveUserIdForResident`
 * upserts one keyed by `residents.id` and is safe to run before every insert.
 * When sign-in lands, it can claim the same row instead of creating a second
 * identity.
 *
 * ## Schema
 *
 * This repository ships no migration runner, so the DDL lives here behind a
 * memoised `ensureSchema()`, matching how `RotationRequestController` and
 * `LongitudinalService` bring up their own tables. `scripts/migrate-notifications.js`
 * runs the same DDL as an explicit step.
 *
 * ## Trigger safety
 *
 * A system event must never fail because a notification could not be written —
 * a rejected leave request stays rejected even if this table is unreachable.
 * Triggers therefore call `notifyResidentSafe`, which logs and swallows.
 */

/** Mirrors the `type` enum on `notifications`. */
const NOTIFICATION_TYPES = [
  'DUTY_HOUR_BREACH',
  'LEAVE_STATUS',
  'ROTATION_APPROVAL',
  'SYSTEM_ALERT',
  'GENERAL',
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Provisional identity table. `resident_id` is unique so a resident maps to at
 * most one user; `program_id` is carried for the coordinator rows that auth
 * will create. Nothing else in the app reads this table yet.
 */
const USERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role ENUM('RESIDENT', 'COORDINATOR') NOT NULL DEFAULT 'RESIDENT',
    full_name VARCHAR(255) NOT NULL DEFAULT '',
    email VARCHAR(191) NULL,
    resident_id BIGINT UNSIGNED NULL,
    program_id BIGINT UNSIGNED NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_users_resident (resident_id),
    INDEX idx_users_program (program_id),

    CONSTRAINT fk_users_resident
      FOREIGN KEY (resident_id) REFERENCES residents(id)
      ON DELETE CASCADE ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const NOTIFICATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type ENUM('DUTY_HOUR_BREACH', 'LEAVE_STATUS', 'ROTATION_APPROVAL', 'SYSTEM_ALERT', 'GENERAL') NOT NULL DEFAULT 'GENERAL',
    reference_id BIGINT UNSIGNED NULL,
    reference_type VARCHAR(100) NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_notifications_user
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE ON UPDATE CASCADE,

    INDEX idx_notifications_user_read (user_id, is_read),
    INDEX idx_notifications_created (created_at DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

/** Memoised so the DDL runs once per process; reset on failure so it retries. */
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(USERS_TABLE_SQL);
      await db.query(NOTIFICATIONS_TABLE_SQL);
      return true;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/** The SELECT list shared by the read endpoints; timestamps as wall-clock strings. */
const NOTIFICATION_SELECT = `
  SELECT
    id,
    user_id,
    title,
    message,
    type,
    reference_id,
    reference_type,
    is_read,
    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at,
    DATE_FORMAT(read_at, '%Y-%m-%d %H:%i') AS read_at
  FROM notifications
`;

/** mysql2 hands back `is_read` as `0`/`1`; the app expects a boolean. */
function toNotification(row) {
  if (!row) return row;
  return { ...row, is_read: Boolean(row.is_read) };
}

function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function clampOffset(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

class NotificationService {
  static async ensureSchema() {
    return ensureSchema();
  }

  static getNotificationTypes() {
    return [...NOTIFICATION_TYPES];
  }

  /**
   * Map a resident to their `users.id`, provisioning the row on first use.
   *
   * `INSERT ... SELECT` only writes when the resident exists, and the
   * `ON DUPLICATE KEY` clause makes the call idempotent and race-safe: a second
   * concurrent insert adopts the existing row instead of erroring. mysql2 only
   * returns a usable `insertId` on the duplicate path because of the
   * `LAST_INSERT_ID(id)` assignment.
   *
   * `executor` lets a caller run this on a transaction connection so the
   * identity row commits with the event that needed it.
   */
  static async resolveUserIdForResident(residentId, executor = db) {
    const id = toPositiveInt(residentId);
    if (!id) return null;

    // Look the resident up first rather than `INSERT ... SELECT`: the latter
    // puts `r.id` in scope and makes the upsert's `id` ambiguous on MariaDB.
    const [residents] = await executor.query(
      `SELECT first_name, last_name FROM residents WHERE id = ? LIMIT 1;`,
      [id],
    );
    if (residents.length === 0) return null;

    const fullName = `${residents[0].first_name} ${residents[0].last_name}`.trim();

    const [result] = await executor.query(
      `INSERT INTO users (role, resident_id, full_name, is_active)
       VALUES ('RESIDENT', ?, ?, 1)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), full_name = VALUES(full_name);`,
      [id, fullName],
    );

    const userId = Number(result.insertId);
    return userId > 0 ? userId : null;
  }

  /**
   * Persist one notification. `executor` may be a transaction connection.
   */
  static async create(payload, executor = db) {
    const {
      user_id,
      title,
      message,
      type = 'GENERAL',
      reference_id = null,
      reference_type = null,
    } = payload;

    const safeType = NOTIFICATION_TYPES.includes(type) ? type : 'GENERAL';

    const [result] = await executor.query(
      `INSERT INTO notifications
         (user_id, title, message, type, reference_id, reference_type)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        user_id,
        title,
        message,
        safeType,
        toPositiveInt(reference_id),
        reference_type || null,
      ],
    );

    return {
      id: result.insertId,
      user_id,
      title,
      message,
      type: safeType,
      reference_id: toPositiveInt(reference_id),
      reference_type: reference_type || null,
      is_read: false,
    };
  }

  /**
   * Resolve the resident's user and persist a notification for them. Throws on
   * failure; use `notifyResidentSafe` from event triggers so a notification
   * problem can never roll back the business action that raised it.
   */
  static async notifyResident(residentId, payload, executor = db) {
    const userId = await NotificationService.resolveUserIdForResident(residentId, executor);
    if (!userId) return null;
    return NotificationService.create({ user_id: userId, ...payload }, executor);
  }

  /**
   * The trigger-facing entry point: ensure the schema, then write, and swallow
   * any failure. Returns the notification, or `null` when it could not be
   * written.
   */
  static async notifyResidentSafe(residentId, payload, executor = db) {
    try {
      await ensureSchema();
      return await NotificationService.notifyResident(residentId, payload, executor);
    } catch (error) {
      console.error(
        `[notifications] could not record "${payload && payload.type}" for resident ${residentId}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * List a user's notifications, newest first, with the totals the badge needs.
   *
   * Accepts either `user_id` or `resident_id`; the latter is resolved through
   * `users` so a caller that only knows the resident (the app today) does not
   * need the internal id.
   */
  static async list(options = {}) {
    await ensureSchema();

    const { type, unread_only: unreadOnly } = options;
    const limit = clampLimit(options.limit);
    const offset = clampOffset(options.offset);

    let userId = toPositiveInt(options.user_id);
    if (!userId) userId = await NotificationService.resolveUserIdForResident(options.resident_id);
    if (!userId) {
      return { user_id: null, data: [], total: 0, unread: 0, limit, offset };
    }

    const clauses = ['user_id = ?'];
    const params = [userId];

    if (type && NOTIFICATION_TYPES.includes(type)) {
      clauses.push('type = ?');
      params.push(type);
    }
    if (unreadOnly) clauses.push('is_read = 0');

    const where = clauses.join(' AND ');

    // Total is scoped to the active filter; the unread count is not, because it
    // drives the bell badge and must not change when the list is filtered.
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS total FROM notifications WHERE ${where};`,
      params,
    );
    const [[unread]] = await db.query(
      `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0;`,
      [userId],
    );

    const [rows] = await db.query(
      `${NOTIFICATION_SELECT}
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?;`,
      [...params, limit, offset],
    );

    return {
      user_id: userId,
      data: rows.map(toNotification),
      total: Number(totals.total) || 0,
      unread: Number(unread.unread) || 0,
      limit,
      offset,
    };
  }

  /** Unread notification count for the badge. */
  static async getUnreadCount(options = {}) {
    await ensureSchema();

    let userId = toPositiveInt(options.user_id);
    if (!userId) userId = await NotificationService.resolveUserIdForResident(options.resident_id);
    if (!userId) return 0;

    const [[row]] = await db.query(
      `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0;`,
      [userId],
    );
    return Number(row.unread) || 0;
  }

  /**
   * Mark one notification read. Scoped to the owner so one user can never post
   * a read receipt against another's row. Idempotent: re-reading an already-read
   * notification succeeds and leaves `read_at` untouched.
   */
  static async markRead(notificationId, options = {}) {
    await ensureSchema();

    const id = toPositiveInt(notificationId);
    if (!id) return { found: false, changed: false, notification: null };

    let userId = toPositiveInt(options.user_id);
    if (!userId) userId = await NotificationService.resolveUserIdForResident(options.resident_id);
    if (!userId) return { found: false, changed: false, notification: null };

    const [rows] = await db.query(
      `SELECT id, user_id, is_read FROM notifications WHERE id = ? AND user_id = ? LIMIT 1;`,
      [id, userId],
    );
    if (rows.length === 0) return { found: false, changed: false, notification: null };

    if (!Boolean(rows[0].is_read)) {
      await db.query(
        `UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND user_id = ?;`,
        [id, userId],
      );
    }

    const [updated] = await db.query(`${NOTIFICATION_SELECT} WHERE id = ?;`, [id]);
    return { found: true, changed: !Boolean(rows[0].is_read), notification: toNotification(updated[0]) };
  }

  /** Mark every unread notification read for a user. Returns how many changed. */
  static async markAllRead(options = {}) {
    await ensureSchema();

    let userId = toPositiveInt(options.user_id);
    if (!userId) userId = await NotificationService.resolveUserIdForResident(options.resident_id);
    if (!userId) return { changed: 0, unread: 0 };

    const [result] = await db.query(
      `UPDATE notifications SET is_read = 1, read_at = NOW()
        WHERE user_id = ? AND is_read = 0;`,
      [userId],
    );

    return { changed: result.affectedRows, unread: 0 };
  }
}

module.exports = NotificationService;
