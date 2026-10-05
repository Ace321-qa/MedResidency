const express = require('express');
const router = express.Router();
const RotationController = require('../controllers/rotationController');

// Map URL routes to controller functions

// Block Routes
router.get('/blocks', RotationController.getBlocks);
router.post('/blocks', RotationController.createBlock);
router.put('/blocks/:block_id', RotationController.updateBlock);
router.delete('/blocks/:block_id', RotationController.deleteBlock);

// Rotation Definition Routes
router.get('/', RotationController.getRotations);

// Resident Assignment Routes
router.post('/assignments', RotationController.createAssignment);
router.get('/assignments', RotationController.getAssignments);

// Grid / matrix routes.
//
// These literal segments are declared before any `:id`-style parameter below so
// "cohort" and "longitudinal" can never be captured as a dynamic ID. Mounting
// `/assignments/:id` first would swallow `/assignments/cohort` and answer 404
// with an unrelated handler (or fall through entirely).
router.get('/assignments/cohort', RotationController.getCohortGrid);
router.get('/assignments/longitudinal/matrix', RotationController.getLongitudinalMatrix);
router.get('/assignments/resident/:resident_id', RotationController.getResidentSchedule);

module.exports = router;
