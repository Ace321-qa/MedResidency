const express = require('express');
const router = express.Router();
const LeaveController = require('../controllers/leaveController');

// Map URL routes to controller functions

// Submit a new statutory leave request
router.post('/request', LeaveController.requestLeave);

// Fetch leave requests for a resident
router.get('/resident/:resident_id', LeaveController.getResidentLeaves);

// Program Director / Chief review decision
router.patch('/:id/status', LeaveController.updateStatus);

module.exports = router;