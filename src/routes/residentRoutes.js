const express = require('express');
const router = express.Router();
const residentController = require('../controllers/residentController');

// POST /api/v1/residents/onboard - Full onboarding registration
router.post('/onboard', residentController.onboardResident);

// GET /api/v1/residents - List residents (supports ?program_id=1&limit=50&offset=0)
router.get('/', residentController.getAllResidents);

// GET /api/v1/residents/:id - Single resident detailed profile
router.get('/:id', residentController.getResidentById);

// PUT /api/v1/residents/:id - Update resident profile information
router.put('/:id', residentController.updateResident);

// DELETE /api/v1/residents/:id/enrollment - Remove a programme enrollment only
router.delete('/:id/enrollment', residentController.removeEnrollment);

// DELETE /api/v1/residents/:id - Delete the resident (blocked while history exists)
router.delete('/:id', residentController.deleteResident);

module.exports = router;