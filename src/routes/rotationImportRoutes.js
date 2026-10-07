const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const ctrl = require('../controllers/rotationImportController');

/**
 * Excel import for the coordinator grids.
 *
 * Templates are plain GETs; imports take the workbook as a multipart `file`
 * field plus `program_id` and `academic_year` so the parser can resolve block
 * columns and clinic names against the right programme.
 */
router.get('/master/template', ctrl.masterTemplate);
router.post('/master', upload.single('file'), ctrl.importMaster);

router.get('/ccc/template', ctrl.cccTemplate);
router.post('/ccc', upload.single('file'), ctrl.importCcc);

module.exports = router;