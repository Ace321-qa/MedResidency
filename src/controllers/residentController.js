const residentService = require('../services/residentService');

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

module.exports = {
  onboardResident,
  getAllResidents,
  getResidentById,
};
