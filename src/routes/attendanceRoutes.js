const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const AttendanceController = require('../controllers/attendanceController');
const AttendanceImportController = require('../controllers/attendanceImportController');

// Map URL routes to controller functions

// Monthly timesheet workbook: the blank template, and a bulk import of it.
// Registered before `/resident/:resident_id` so `/template` is never read as a
// resident id.
router.get('/template', AttendanceImportController.template);
router.post('/import', upload.single('file'), AttendanceImportController.import);

// Log daily attendance (auto-evaluates duty hour breach)
router.post('/', AttendanceController.logAttendance);

// Fetch attendance logs + violation details for a resident
router.get('/resident/:resident_id', AttendanceController.getResidentAttendance);

module.exports = router;
