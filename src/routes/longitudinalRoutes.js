const express = require('express');
const router = express.Router();
const LongitudinalController = require('../controllers/longitudinalController');

router.get('/clinic-types', LongitudinalController.getClinicTypes);
router.get('/assignments', LongitudinalController.getAllLongitudinalAssignments);
router.get('/assignments/resident/:resident_id', LongitudinalController.getResidentLongitudinalAssignments);
router.get('/faculty-supervisors', LongitudinalController.getFacultySupervisors);
router.get('/clinic-slots', LongitudinalController.getClinicSlots);
router.get('/supervisor-assignments', LongitudinalController.getSupervisorAssignments);
router.post('/supervisor-assignments', LongitudinalController.createSupervisorAssignment);
router.patch('/supervisor-assignments/:assignment_id/rotate', LongitudinalController.rotateSupervisor);

module.exports = router;
