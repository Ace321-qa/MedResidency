const express = require('express');
const router = express.Router();
const ExportController = require('../controllers/exportController');

// `POST /api/v1/exports/workbook` — render a schedule report to .xlsx.
router.post('/workbook', ExportController.createWorkbook);

module.exports = router;
