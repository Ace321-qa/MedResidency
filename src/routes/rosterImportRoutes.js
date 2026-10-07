const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const RosterImportController = require('../controllers/rosterImportController');

router.get('/template', RosterImportController.downloadTemplate);
router.post('/import', upload.single('file'), RosterImportController.import);

module.exports = router;
