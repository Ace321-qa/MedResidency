const express = require('express');
const router = express.Router();
const RotationController = require('../controllers/rotationController');

// Map URL routes to controller functions

// Block Routes
router.get('/blocks', RotationController.getBlocks);
router.post('/blocks', RotationController.createBlock);

// Rotation Definition Routes
router.get('/', RotationController.getRotations);

// Resident Assignment Routes
router.post('/assignments', RotationController.createAssignment);
router.get('/assignments/resident/:resident_id', RotationController.getResidentSchedule);

module.exports = router;