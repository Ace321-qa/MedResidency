const RotationService = require('../services/rotationService');
const LongitudinalService = require('../services/longitudinalService');
const RotationCapacityService = require('../services/rotationCapacityService');
const ReleaseLetterService = require('../services/releaseLetterService');
const db = require('../config/db');
const { isCheckConstraintViolation } = require('../utils/mysqlErrors');

/**
 * Turn a thrown error into a response.
 *
 * The services raise `error.statusCode` for input they reject themselves — a
 * block window that cannot end on the right weekday, say — while MySQL failures
 * arrive as `code`s. Both are handled here so the controller methods stay about
 * routing rather than about error shapes.
 */
function respondWithError(res, error, fallbackMessage) {
  if (error.statusCode === 400) {
    return res.status(400).json({ success: false, error: error.message });
  }
  return res.status(500).json({ success: false, error: fallbackMessage, details: error.message });
}

class RotationController {
  static async getBlocks(req, res) {
    try {
      const { program_id, academic_year } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required query parameter: program_id' });
      }
      const blocks = await RotationService.getBlocksByProgram(program_id, academic_year || null);
      return res.status(200).json({ success: true, count: blocks.length, data: blocks });
    } catch (error) {
      console.error('Error in getBlocks controller:', error.message);
      return res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
    }
  }

  /**
   * `GET /rotations/blocks/dates` — derive a block window.
   *
   * The block forms must not reimplement `weeks * 7 - 1`: the client mirror in
   * `mobile/src/utils/dateCalc.ts` agrees with `src/utils/blockDates.js` today,
   * but only the server knows the programme's `week_start_day`, so this endpoint
   * is the authority for what "a 4-week block" means for the programme in
   * question. The same derivation runs again inside the create and update paths.
   */
  static async getBlockDates(req, res) {
    try {
      const { program_id, start_date, duration_weeks, end_date } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing required query parameter: program_id' });
      }

      // With no start date the caller only wants the programme's rules — the
      // week-start day, the day a block therefore ends on, and the default
      // length. A form needs those before it can label its own end-date field,
      // and asking it to send a date it has not chosen yet is a workaround.
      if (!start_date) {
        const calendar = await RotationService.getBlockCalendar(program_id);
        if (!calendar) {
          return res.status(404).json({ success: false, error: 'Programme not found' });
        }
        return res.status(200).json({ success: true, data: { ...calendar, start_date: null, end_date: null, duration_weeks: calendar.default_block_duration_weeks, errors: [] } });
      }

      const window = await RotationService.resolveBlockDates({
        programId: program_id,
        startDate: start_date,
        durationWeeks: duration_weeks,
        endDate: end_date,
      });

      if (window.errors.length > 0) {
        return res.status(400).json({ success: false, error: window.errors.join(' ') });
      }

      return res.status(200).json({ success: true, data: window });
    } catch (error) {
      console.error('Error in getBlockDates controller:', error.message);
      return res.status(500).json({ success: false, error: 'Failed to derive block dates', details: error.message });
    }
  }

  /**
   * `POST /rotations/blocks/generate` — complete an academic year to thirteen
   * blocks.
   *
   * Idempotent, so the block list can call it on open without asking: a complete
   * year writes nothing and returns `created: []`. `academic_year` is optional
   * and defaults to the year containing today.
   */
  static async generateBlocks(req, res) {
    try {
      const programId = Number(req.body?.program_id ?? req.query?.program_id);
      if (!Number.isInteger(programId) || programId <= 0) {
        return res.status(400).json({ success: false, error: 'Missing required field: program_id' });
      }

      const result = await RotationService.ensureAcademicBlocks(
        programId,
        req.body?.academic_year ?? req.query?.academic_year ?? null,
      );
      const message =
        result.created.length === 0
          ? `${result.academic_year} already has its full block calendar.`
          : `${result.created.length} block${result.created.length === 1 ? '' : 's'} created for ${result.academic_year}.`;

      return res.status(result.created.length > 0 ? 201 : 200).json({
        success: true,
        message,
        data: {
          academic_year: result.academic_year,
          duration_weeks: result.duration_weeks,
          created: result.created,
          skipped: result.skipped,
        },
      });
    } catch (error) {
      console.error('Error in generateBlocks controller:', error.message);
      if (typeof error.statusCode === 'number') {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      return respondWithError(res, error, 'Could not generate the academic calendar.');
    }
  }

  static async createBlock(req, res) {
    try {
      const { program_id, academic_year, block_number, block_name, start_date } = req.body;
      if (!program_id || !academic_year || !block_number || !block_name || !start_date) {
        return res.status(400).json({ success: false, error: 'Missing required fields. Required: program_id, academic_year, block_number, block_name, start_date, end_date or duration_weeks' });
      }
      // `end_date` is no longer mandatory: a duration is enough, and the server
      // derives the last day of the block from the programme's week-start day.
      const hasWindow = Boolean(req.body.end_date) || Boolean(req.body.duration_weeks);
      if (!hasWindow) {
        return res.status(400).json({ success: false, error: 'Missing required fields: end_date or duration_weeks' });
      }

      const newBlock = await RotationService.createBlock(req.body);
      return res.status(201).json({ success: true, message: 'Academic block created successfully', data: newBlock });
    } catch (error) {
      console.error('Error in createBlock controller:', error.message);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Duplicate block entry. This block number already exists for this academic year.' });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({ success: false, error: 'Invalid dates. The end_date must be greater than or equal to start_date.' });
      }
      return respondWithError(res, error, 'Database operation failed');
    }
  }

  static async getRotations(req, res) {
    try {
      const { program_id } = req.query;
      if (!program_id) {
        return res.status(400).json({ success: false, error: 'Missing query parameter: program_id' });
      }
      const rotations = await RotationService.getRotationsByProgram(program_id);
      return res.status(200).json({ success: true, count: rotations.length, data: rotations });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch rotations', details: error.message });
    }
  }

  static async createAssignment(req, res) {
    try {
      const { resident_id, rotation_id, rotation_block_id, start_date, end_date } = req.body;
      if (!resident_id || !rotation_id || !rotation_block_id || !start_date || !end_date) {
        return res.status(400).json({ success: false, error: 'Missing required fields: resident_id, rotation_id, rotation_block_id, start_date, end_date' });
      }
      const assignment = await RotationService.assignResidentToRotation(req.body);
      return res.status(201).json({ success: true, message: 'Resident rotation assignment created successfully', data: assignment });
    } catch (error) {
      if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
        return res.status(404).json({ success: false, error: 'Invalid foreign key reference. Ensure resident_id, rotation_id, and rotation_block_id exist.' });
      }
      // An over-capacity placement is not a malformed request: it is a valid
      // request this department's seat limit refuses. The verdict travels with
      // the refusal so the screen can render the same banner it previewed,
      // rather than a generic error string with the numbers stripped out.
      if (error.requires_exception || (error.capacity && error.capacity.status === 'BLOCKED')) {
        return res.status(409).json({
          success: false,
          error: error.message,
          capacity: error.capacity,
          requires_exception: error.requires_exception === true,
        });
      }
      if (typeof error.statusCode === 'number') {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          capacity: error.capacity ?? undefined,
        });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({ success: false, error: 'Invalid dates. end_date must be greater than or equal to start_date.' });
      }
      return res.status(500).json({ success: false, error: 'Assignment failed', details: error.message });
    }
  }

  /**
   * `POST /rotations/assignments/check-capacity` — preview an over-capacity
   * decision before committing to it.
   *
   * The assignment modal needs the tier *before* the coordinator fills in a
   * rationale, so it can decide whether to show the amber banner, the red
   * escalation, or a hard stop at all. Deriving that on the client would mean a
   * second implementation of the tier table; this endpoint runs the same engine
   * the write runs, so what the screen promises and what the server enforces
   * cannot drift.
   */
  static async checkCapacity(req, res) {
    try {
      const { rotation_id, start_date, end_date, program_id, exclude_assignment_id } = req.body ?? {};
      if (!rotation_id || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: rotation_id, start_date, end_date',
        });
      }
      const outcome = await RotationCapacityService.checkPlacement(db, {
        rotation_id,
        program_id: program_id ?? null,
        proposal: { start_date, end_date },
        excludeAssignmentId: exclude_assignment_id ?? null,
      });
      if (!outcome.rotation) {
        return res.status(404).json({ success: false, error: `Rotation ${rotation_id} was not found` });
      }
      return res.status(200).json({
        success: true,
        data: {
          rotation_id: outcome.rotation.id,
          rotation_name: outcome.rotation.rotation_name,
          department_name: outcome.rotation.department_name,
          ...outcome.result,
        },
      });
    } catch (error) {
      console.error('Error in checkCapacity controller:', error.message);
      return res.status(500).json({ success: false, error: 'Capacity check failed', details: error.message });
    }
  }

  static async getResidentSchedule(req, res) {
    try {
      const { resident_id } = req.params;
      const schedule = await RotationService.getScheduleByResident(resident_id);
      return res.status(200).json({ success: true, count: schedule.length, data: schedule });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch schedule', details: error.message });
    }
  }

  static async updateBlock(req, res) {
    try {
      const { block_id } = req.params;
      if (!block_id) {
        return res.status(400).json({ success: false, error: 'Missing required fields: block_id' });
      }
      const block = await RotationService.getBlockById(block_id);
      if (!block) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }
      // A patch that omits a field keeps the stored one; the date window is
      // re-derived from whatever survives, using the programme's week-start day.
      if (req.body.start_date === undefined && req.body.end_date === undefined && req.body.duration_weeks === undefined) {
        return res.status(400).json({ success: false, error: 'Missing required fields: start_date, end_date or duration_weeks' });
      }
      await RotationService.updateBlock(block_id, req.body);
      const updated = await RotationService.getBlockById(block_id);
      return res.status(200).json({ success: true, data: updated });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Duplicate block entry. This block number already exists for this academic year.' });
      }
      if (isCheckConstraintViolation(error)) {
        return res.status(400).json({ success: false, error: 'Invalid dates. The end_date must be greater than or equal to start_date.' });
      }
      return respondWithError(res, error, 'Failed to update block');
    }
  }

  static async deleteBlock(req, res) {
    try {
      const { block_id } = req.params;
      const block = await RotationService.getBlockById(block_id);
      if (!block) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }
      const hasDeps = await RotationService.hasDependentAssignments(block_id);
      if (hasDeps) {
        return res.status(409).json({ success: false, error: 'Cannot delete block with dependent resident assignments. Remove or reassign dependencies first.' });
      }
      await RotationService.deleteBlock(block_id);
      return res.status(200).json({ success: true, message: 'Block deleted successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to delete block', details: error.message });
    }
  }

  static async getAssignments(req, res) {
    try {
      const filters = req.query;
      const data = await RotationService.getAssignments(filters);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch assignments', details: error.message });
    }
  }

  static async getCohortGrid(req, res) {
    try {
      const { academic_year } = req.query;
      if (!academic_year) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required query parameter: academic_year' });
      }
      const data = await RotationService.getCohortGrid(req.query);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      console.error('Error in getCohortGrid controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to fetch cohort grid', details: error.message });
    }
  }

  static async getLongitudinalMatrix(req, res) {
    try {
      const { academic_year } = req.query;
      if (!academic_year) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required query parameter: academic_year' });
      }
      const data = await LongitudinalService.getLongitudinalMatrix(req.query);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      console.error('Error in getLongitudinalMatrix controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to fetch longitudinal matrix', details: error.message });
    }
  }

  /**
   * `PATCH /rotations/blocks/:block_id/finalized`
   *
   * Marks a block's schedule settled so its notices may be dispatched, or
   * returns it to draft. The body is `{ is_finalized: boolean }`.
   */
  static async setBlockFinalized(req, res) {
    try {
      const { block_id } = req.params;
      if (req.body?.is_finalized === undefined) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required body field: is_finalized' });
      }
      const data = await RotationService.setBlockFinalized(block_id, Boolean(req.body.is_finalized));
      return res.status(200).json({ success: true, data });
    } catch (error) {
      if (error.statusCode === 404) {
        return res.status(404).json({ success: false, error: error.message });
      }
      if (error.statusCode === 409) {
        return res.status(409).json({ success: false, error: error.message });
      }
      console.error('Error in setBlockFinalized controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to update finalization', details: error.message });
    }
  }

  /**
   * `POST /rotations/grid/notices/preview`
   *
   * The confirmation summary: how many residents and departments a dispatch
   * would cover, and which blocks are still draft. Reads only.
   */
  static async previewRotationNotices(req, res) {
    try {
      const { program_id, block_id, start_date, end_date, academic_year } = req.body ?? {};
      if (!program_id) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required body field: program_id' });
      }
      const data = await ReleaseLetterService.planRotationNotices({
        program_id,
        block_id,
        start_date,
        end_date,
        academic_year,
      });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      console.error('Error in previewRotationNotices controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to preview notices', details: error.message });
    }
  }

  /**
   * `POST /rotations/grid/send-notices`
   *
   * Dispatch the rotation notices for a block or window: one stored letter per
   * assignment plus a resident notification each.
   */
  static async sendRotationNotices(req, res) {
    try {
      const {
        program_id,
        block_id,
        start_date,
        end_date,
        academic_year,
        template_code,
        send_to_coordinators,
        notify_residents,
        sent_by_user_id,
        recipient_dept_head,
        coordinator_name,
        program_director_name,
        regenerate,
      } = req.body ?? {};

      if (!program_id) {
        return res
          .status(400)
          .json({ success: false, error: 'Missing required body field: program_id' });
      }

      const data = await ReleaseLetterService.dispatchRotationNotices({
        program_id,
        block_id,
        start_date,
        end_date,
        academic_year,
        template_code,
        send_to_coordinators: send_to_coordinators !== false,
        notify_residents: notify_residents !== false,
        sent_by_user_id,
        recipient_dept_head,
        coordinator_name,
        program_director_name,
        regenerate: Boolean(regenerate),
      });

      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Error in sendRotationNotices controller:', error.message);
      return res
        .status(500)
        .json({ success: false, error: 'Failed to dispatch notices', details: error.message });
    }
  }
}

module.exports = RotationController;
