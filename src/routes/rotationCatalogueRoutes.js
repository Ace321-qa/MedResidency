const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const ctrl = require('../controllers/rotationCatalogueController');

/**
 * Rotations Catalogue — create, edit, delete and bulk-manage the programme's
 * rotation definitions.
 *
 * `/template` is declared before the parameterised routes so a workbook
 * download can never be read as an id, and the import takes the file as the
 * multipart `file` field (Multer memory storage) plus `program_id`, exactly as
 * the roster and master-grid imports do.
 */
router.get('/template', ctrl.downloadTemplate);
router.post('/import', upload.single('file'), ctrl.importCatalogue);

router.get('/', ctrl.getCatalogue);
router.post('/', ctrl.createRotation);
router.put('/:id', ctrl.updateRotation);
router.delete('/:id', ctrl.deleteRotation);

module.exports = router;
