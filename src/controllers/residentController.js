const residentService = require('../services/residentService');

/** Values `residency_enrollments.resident_status` is allowed to take. */
const ALLOWED_RESIDENT_STATUSES = [
  'ACTIVE_FULL_TIME',
  'ACTIVE_PART_TIME',
  'LEAVE_OF_ABSENCE',
  'STARTED_OFF_CYCLE',
  'GRADUATED',
  'WITHDRAWN',
];

const MAX_NAME_LENGTH = 100;
const MAX_IDENTIFIER_LENGTH = 100;
const MAX_PGY_LEVEL = 10;

/** A positive integer route id, or `null`. */
function parseResidentId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * POST /api/v1/residents/onboard
 * Controller to handle full onboarding registration
 */
async function onboardResident(req, res) {
  try {
    const { personal_info, identifiers, enrollment } = req.body;

    // 1. Validation: personal_info
    if (!personal_info) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: personal_info object is required',
      });
    }

    const requiredFields = ['first_name', 'last_name', 'date_of_birth', 'sex', 'nationality', 'citizenship_status'];
    const missingFields = requiredFields.filter((field) => !personal_info[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required personal_info fields: ${missingFields.join(', ')}`,
      });
    }

    // 2. Validation: enrollment
    if (enrollment && !enrollment.program_id) {
      return res.status(400).json({
        success: false,
        error: 'If enrollment is provided, program_id is required',
      });
    }

    // 3. Validation: identifiers
    if (identifiers && Array.isArray(identifiers)) {
      for (const ident of identifiers) {
        if (!ident.identifier_type || !ident.identifier_value) {
          return res.status(400).json({
            success: false,
            error: 'Each identifier must have identifier_type and identifier_value',
          });
        }
      }
    }

    // 4. Execute transactional onboarding
    const result = await residentService.onboardResident({
      personal_info,
      identifiers: identifiers || [],
      enrollment: enrollment || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Resident onboarded successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error during resident onboarding:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to onboard resident',
      error: error.message,
    });
  }
}

/**
 * GET /api/v1/residents
 * Controller to retrieve all residents
 */
async function getAllResidents(req, res) {
  try {
    const { program_id, limit, offset } = req.query;
    const residents = await residentService.getAllResidents({
      program_id: program_id ? Number(program_id) : undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });

    return res.status(200).json({
      success: true,
      count: residents.length,
      data: residents,
    });
  } catch (error) {
    console.error('Error fetching residents:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch residents',
      error: error.message,
    });
  }
}

/**
 * GET /api/v1/residents/:id
 * Controller to retrieve single resident profile
 */
async function getResidentById(req, res) {
  try {
    const residentId = req.params.id;
    const resident = await residentService.getResidentById(residentId);

    if (!resident) {
      return res.status(404).json({
        success: false,
        message: `Resident with ID ${residentId} not found`,
      });
    }

    return res.status(200).json({
      success: true,
      data: resident,
    });
  } catch (error) {
    console.error('Error fetching resident profile:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch resident profile',
      error: error.message,
    });
  }
}

/**
 * PUT /api/v1/residents/:id
 * Update a resident's profile information.
 *
 * Only the fields sent are changed. Names are required to stay non-empty when
 * they are sent, PGY level has to be a whole number inside the range the
 * `tinyint` column can hold, and status must be one of the values the roster
 * understands — so a typo becomes a 400 with a sentence rather than a row that
 * silently disappears from every filtered list.
 */
async function updateResident(req, res) {
  try {
    const residentId = parseResidentId(req.params.id);
    if (!residentId) {
      return res.status(400).json({
        success: false,
        error: 'A numeric resident id is required',
      });
    }

    const body = req.body ?? {};
    const payload = {};
    const errors = [];

    for (const field of ['first_name', 'last_name']) {
      if (body[field] === undefined) continue;
      const value = String(body[field] ?? '').trim();
      if (value === '') {
        errors.push(`${field === 'first_name' ? 'First name' : 'Last name'} is required`);
        continue;
      }
      if (value.length > MAX_NAME_LENGTH) {
        errors.push(`Name must be ${MAX_NAME_LENGTH} characters or fewer`);
        continue;
      }
      payload[field] = value;
    }

    if (body.middle_initial !== undefined) {
      const value = body.middle_initial === null ? '' : String(body.middle_initial).trim();
      payload.middle_initial = value === '' ? null : value;
    }

    if (body.pgy_level !== undefined && body.pgy_level !== null && body.pgy_level !== '') {
      const pgy = Number(body.pgy_level);
      if (!Number.isInteger(pgy) || pgy < 1 || pgy > MAX_PGY_LEVEL) {
        errors.push(`PGY level must be a whole number between 1 and ${MAX_PGY_LEVEL}`);
      } else {
        payload.pgy_level = pgy;
      }
    }

    if (
      body.resident_status !== undefined &&
      body.resident_status !== null &&
      body.resident_status !== ''
    ) {
      const status = String(body.resident_status).trim().toUpperCase();
      if (!ALLOWED_RESIDENT_STATUSES.includes(status)) {
        errors.push(`Resident status must be one of: ${ALLOWED_RESIDENT_STATUSES.join(', ')}`);
      } else {
        payload.resident_status = status;
      }
    }

    for (const field of ['corporate_id', 'email', 'mobile']) {
      if (body[field] === undefined) continue;
      const value = body[field] === null ? '' : String(body[field]).trim();
      if (value.length > MAX_IDENTIFIER_LENGTH) {
        errors.push(`${field.replace('_', ' ')} must be ${MAX_IDENTIFIER_LENGTH} characters or fewer`);
        continue;
      }
      if (field === 'email' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.push('Email must be a valid email address');
        continue;
      }
      payload[field] = value;
    }

    if (body.program_id !== undefined && body.program_id !== null && body.program_id !== '') {
      const programId = Number(body.program_id);
      if (Number.isInteger(programId) && programId > 0) payload.program_id = programId;
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'Nothing to update. Provide at least one of: first_name, last_name, middle_initial, corporate_id, email, mobile, pgy_level, resident_status',
      });
    }

    const updated = await residentService.updateResident(residentId, payload);
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: `Resident with ID ${residentId} not found`,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Resident updated successfully',
      data: updated,
    });
  } catch (error) {
    console.error('Error updating resident:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update resident',
      error: error.message,
    });
  }
}

/**
 * DELETE /api/v1/residents/:id
 * Delete a resident record, refusing by default when history depends on it.
 *
 * Pass `?cascade=true` to delete the history too. Without it, a resident with
 * attendance, rotations, leave, letters or duty-hour violations is refused with
 * the counts, because the foreign keys would otherwise erase compliance records
 * as an invisible side effect of removing a roster card.
 */
async function deleteResident(req, res) {
  try {
    const residentId = parseResidentId(req.params.id);
    if (!residentId) {
      return res.status(400).json({
        success: false,
        error: 'A numeric resident id is required',
      });
    }

    const cascade = req.query.cascade === 'true' || req.body?.cascade === true;
    const result = await residentService.deleteResident(residentId, { cascade });

    if (!result.found) {
      return res.status(404).json({
        success: false,
        message: `Resident with ID ${residentId} not found`,
      });
    }

    if (!result.deleted) {
      const summary = result.dependencies
        .map((entry) => `${entry.count} ${entry.label}${entry.count === 1 ? '' : 's'}`)
        .join(', ');
      return res.status(409).json({
        success: false,
        error: `Cannot delete this resident: ${summary} exist on their record. Unenroll them from the programme instead, or resend with ?cascade=true to delete the history too.`,
        dependencies: result.dependencies,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Resident removed successfully',
      data: { id: residentId },
    });
  } catch (error) {
    console.error('Error deleting resident:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete resident',
      error: error.message,
    });
  }
}

/**
 * DELETE /api/v1/residents/:id/enrollment
 * Remove a resident's programme enrollment without touching their record.
 */
async function removeEnrollment(req, res) {
  try {
    const residentId = parseResidentId(req.params.id);
    if (!residentId) {
      return res.status(400).json({
        success: false,
        error: 'A numeric resident id is required',
      });
    }

    const rawProgramId = req.query.program_id ?? req.body?.program_id;
    const programId = rawProgramId !== undefined && rawProgramId !== null && rawProgramId !== ''
      ? Number(rawProgramId)
      : null;

    if (programId !== null && (!Number.isInteger(programId) || programId <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'program_id must be a positive integer when provided',
      });
    }

    const result = await residentService.removeEnrollment(residentId, programId);
    if (!result.found) {
      return res.status(404).json({
        success: false,
        message: `Resident with ID ${residentId} not found`,
      });
    }

    if (result.removed === 0) {
      return res.status(404).json({
        success: false,
        message: programId
          ? `Resident ${residentId} is not enrolled in programme ${programId}`
          : `Resident ${residentId} has no programme enrollment`,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Resident unenrolled successfully',
      data: { resident_id: residentId, removed: result.removed },
    });
  } catch (error) {
    console.error('Error unenrolling resident:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to unenroll resident',
      error: error.message,
    });
  }
}

module.exports = {
  onboardResident,
  getAllResidents,
  getResidentById,
  updateResident,
  deleteResident,
  removeEnrollment,
};
