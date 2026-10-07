const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const ctrl = require('../controllers/rotationImportController');

router.get('/master/template', ctrl.masterTemplate);
router.get('/ccc/template', ctrl.cccTemplate);

module.exports = router;
