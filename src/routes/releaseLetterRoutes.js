const express = require('express');
const router = express.Router();
const ReleaseLetterController = require('../controllers/releaseLetterController');

// Map URL routes to controller functions

// Mail-merge a release letter from the STANDARD-RELEASE template
router.post('/generate', ReleaseLetterController.generateLetter);

// Fetch generated release letters for a resident
router.get('/resident/:resident_id', ReleaseLetterController.getResidentLetters);

module.exports = router;