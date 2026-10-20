const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const LongitudinalController = require('../controllers/longitudinalController');

router.get('/clinic-types', LongitudinalController.getClinicTypes);
router.post('/clinic-types', LongitudinalController.createClinicType);
router.put('/clinic-types/:id', LongitudinalController.updateClinicType);
router.delete('/clinic-types/:id', LongitudinalController.deleteClinicType);
router.get('/specialized-clinics', LongitudinalController.getSpecializedClinics);
router.post('/specialized-clinics/clone', LongitudinalController.cloneSpecializedClinic);
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
router.post('/supervisor-assignments/randomize', LongitudinalController.randomizeSupervisorAllocations);
router.patch('/supervisor-assignments/:assignment_id/rotate', LongitudinalController.rotateSupervisor);

router.get('/cycle-schedule', LongitudinalController.getCycleSchedule);
router.get('/cycles', LongitudinalController.getCycles);
router.put('/cycle-schedule/header', LongitudinalController.updateCycleHeader);
router.delete('/cycle-schedule/header/:id', LongitudinalController.deleteCycleHeader);
router.put('/cycle-schedule/slot', LongitudinalController.updateCycleSlot);
router.post('/cycle-schedule/backup', LongitudinalController.updateBackupFaculty);
router.get('/cycle-schedule/absences', LongitudinalController.getCycleAbsences);
router.post('/cycle-schedule/absences', LongitudinalController.updateDayAbsences);
router.get('/cycle-schedule/columns', LongitudinalController.getMatrixColumns);
router.post('/cycle-schedule/columns', LongitudinalController.addClinicColumn);
router.put('/cycle-schedule/columns/:clinic_number', LongitudinalController.renameClinicColumn);
router.delete('/cycle-schedule/columns/:clinic_number', LongitudinalController.deleteClinicColumn);
router.post('/cycle-schedule/randomize', LongitudinalController.randomizeSupervisors);

router.get('/matrix/template', LongitudinalController.downloadMatrixTemplate);
router.post('/matrix/import', upload.single('file'), LongitudinalController.importMatrix);
router.post('/matrix/template', LongitudinalController.downloadMatrixTemplate);
router.get('/matrix/export/pdf', LongitudinalController.exportMatrixPdf);
router.post('/matrix/export/pdf', LongitudinalController.exportMatrixPdf);


module.exports = router;