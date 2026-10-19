/**
 * Backfill: put every already-APPROVED rotation request onto the rota.
 *
 *     node src/scripts/backfillApprovedRequests.js [--dry-run] [--quiet]
 *
 * The live `PATCH /requests/rotation/:id` handler writes the assignment in the
 * same transaction as the status flip (see `rotationApprovalService`). Requests
 * approved *before* that handler existed therefore sit at APPROVED with no
 * `resident_rotation_assignments` row, so the coordinator's queue shows a
 * rotation the Master Grid never paints. This script walks every APPROVED row
 * and replays exactly the same `syncApprovedRequest` the endpoint calls — there
 * is deliberately no second copy of the resolution rules here, so the backfill
 * cannot disagree with the live path it is repairing.
 *
 * It is safe to run repeatedly and safe to run while the API is serving: each
 * request is its own transaction, the upsert keys on `(resident_id,
 * rotation_block_id)` so replaying a request rewrites its row instead of
 * duplicating it, and a request that cannot be placed (no programme, a window
 * outside the academic calendar) is reported and skipped without touching the
 * rest.
 *
 * Exit code is 0 when every request was placed (or with `--dry-run`), 1 when any
 * request failed, so it can gate a deploy step.
 */

const db = require('../config/db');
const RotationApprovalService = require('../services/rotationApprovalService');

const APPROVED_SQL = `
  SELECT
    request_id,
    resident_id,
    program_id,
    request_type,
    department_clinic,
    DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
    DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
    status
  FROM rotation_requests
  WHERE status = 'APPROVED'
  ORDER BY request_id ASC
`;

/**
 * Replay every APPROVED request through the approval service.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Resolve and report, committing nothing.
 * @param {(line: string) => void} [options.logger]
 * @param {import('mysql2/promise').Pool} [options.pool]
 * @returns {Promise<object>} A summary the caller (and the verifier) can assert on.
 */
async function backfillApprovedRequests({ dryRun = false, logger = () => {}, pool = db } = {}) {
  const [requests] = await pool.query(APPROVED_SQL);

  const summary = {
    dryRun: Boolean(dryRun),
    processed: 0,
    created: 0,
    updated: 0,
    cataloguedRotations: 0,
    assignments: [],
    failures: [],
  };

  for (const request of requests) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const assignment = await RotationApprovalService.syncApprovedRequest(conn, request);
      if (dryRun) await conn.rollback();
      else await conn.commit();

      summary.processed += 1;
      if (assignment.created) summary.created += 1;
      else summary.updated += 1;
      if (assignment.catalogued_rotation) summary.cataloguedRotations += 1;

      summary.assignments.push({
        requestId: request.request_id,
        residentId: assignment.resident_id,
        blockNumber: assignment.block_number,
        rotationBlockId: assignment.rotation_block_id,
        rotationId: assignment.rotation_id,
        rotationName: assignment.rotation_name,
        startDate: assignment.start_date,
        endDate: assignment.end_date,
        created: assignment.created,
      });

      logger(
        `${dryRun ? '[dry-run] ' : ''}request ${request.request_id} (resident ${request.resident_id}) ` +
          `-> block ${assignment.block_number} as "${assignment.rotation_name}"` +
          `${assignment.created ? '' : ' (rewrote the existing row)'}`,
      );
    } catch (error) {
      await conn.rollback().catch(() => {});
      summary.failures.push({
        requestId: request.request_id,
        residentId: request.resident_id,
        statusCode: error.statusCode ?? null,
        message: error.message,
      });
      logger(`request ${request.request_id} (resident ${request.resident_id}) FAILED: ${error.message}`);
    } finally {
      conn.release();
    }
  }

  return summary;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const quiet = args.has('--quiet');

  const summary = await backfillApprovedRequests({
    dryRun,
    logger: quiet ? () => {} : (line) => console.log(line),
  });

  console.log(
    `\n${summary.processed} approved request(s) placed ` +
      `(${summary.created} inserted, ${summary.updated} rewrote an existing row` +
      `${summary.cataloguedRotations ? `, ${summary.cataloguedRotations} rotation(s) catalogued` : ''}` +
      `${summary.failures.length ? `, ${summary.failures.length} failed` : ''})` +
      `${dryRun ? ' [dry-run: nothing committed]' : ''}.`,
  );

  if (summary.failures.length > 0) {
    console.error('\nRequests that could not be placed:');
    for (const failure of summary.failures) {
      console.error(`  request ${failure.requestId} (resident ${failure.residentId}): ${failure.message}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => {
      // The pool would keep the event loop alive; this script is a one-shot.
      db.end().catch(() => {});
    });
}

module.exports = { backfillApprovedRequests };
