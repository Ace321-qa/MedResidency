const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const LongitudinalController = require('../controllers/longitudinalController');

router.get('/clinic-types', LongitudinalController.getClinicTypes);
router.post('/clinic-types', LongitudinalController.createClinicType);
router.put('/clinic-types/:id', LongitudinalController.updateClinicType);
router.delete('/clinic-types/:id', LongitudinalController.deleteClinicType);
router.get('/assignments', LongitudinalController.getAllLongitudinalAssignments);
router.get('/assignments/resident/:resident_id', LongitudinalController.getResidentLongitudinalAssignments);
router.get('/faculty-supervisors', LongitudinalController.getFacultySupervisors);
router.get('/faculty-supervisors/template', LongitudinalController.downloadFacultyTemplate);
router.post('/faculty-supervisors/import', upload.single('file'), LongitudinalController.importFacultySupervisors);
router.post('/faculty-supervisors', LongitudinalController.createFacultySupervisor);
router.put('/faculty-supervisors/:id', LongitudinalController.updateFacultySupervisor);
router.delete('/faculty-supervisors/:id', LongitudinalController.deleteFacultySupervisor);
router.get('/clinic-slots', LongitudinalController.getClinicSlots);
router.get('/supervisor-assignments', LongitudinalController.getSupervisorAssignments);
router.post('/supervisor-assignments', LongitudinalController.createSupervisorAssignment);
router.patch('/supervisor-assignments/:assignment_id/rotate', LongitudinalController.rotateSupervisor);

router.get('/cycle-schedule', LongitudinalController.getCycleSchedule);
router.get('/cycles', LongitudinalController.getCycles);
router.put('/cycle-schedule/header', LongitudinalController.updateCycleHeader);
router.put('/cycle-schedule/slot', LongitudinalController.updateCycleSlot);
router.post('/cycle-schedule/backup', LongitudinalController.updateBackupFaculty);
router.post('/cycle-schedule/randomize', LongitudinalController.randomizeSupervisors);

module.exports = router;
