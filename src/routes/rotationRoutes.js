const express = require('express');
const router = express.Router();
const RotationController = require('../controllers/rotationController');
const RotationExportController = require('../controllers/rotationExportController');

// Map URL routes to controller functions

// Master Rotation Grid download. Declared before every `/assignments/...`
// route so the literal `export` can never be read as a dynamic id.
router.get('/export/master', RotationExportController.exportMaster);

// Block Routes
router.get('/blocks', RotationController.getBlocks);
router.get('/blocks/dates', RotationController.getBlockDates);
// The literal `/blocks/generate` is declared before the parameterless POST so
// it can never be mistaken for a block payload.
router.post('/blocks/generate', RotationController.generateBlocks);
router.post('/blocks', RotationController.createBlock);
router.put('/blocks/:block_id', RotationController.updateBlock);
router.delete('/blocks/:block_id', RotationController.deleteBlock);

// Rotation Definition Routes
router.get('/', RotationController.getRotations);

// Resident Assignment Routes
router.post('/assignments', RotationController.createAssignment);
router.get('/assignments', RotationController.getAssignments);

// The seat-limit preview. Declared before `/assignments/:id`-style routes (and
// alongside the literal `/assignments/cohort` below) so `check-capacity` can
// never be captured as a dynamic id.
router.post('/assignments/check-capacity', RotationController.checkCapacity);

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
