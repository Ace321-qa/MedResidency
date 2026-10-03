const express = require('express');
const router = express.Router();
const AttendanceController = require('../controllers/attendanceController');

// Map URL routes to controller functions

// Log daily attendance (auto-evaluates duty hour breach)
router.post('/', AttendanceController.logAttendance);

// Fetch attendance logs + violation details for a resident
router.get('/resident/:resident_id', AttendanceController.getResidentAttendance);

module.exports = router;
