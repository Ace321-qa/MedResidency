const express = require('express');
const router = express.Router();
const ReleaseLetterController = require('../controllers/releaseLetterController');

// Map URL routes to controller functions.
//
// The template routes live here, under /api/v1/letters/templates, because the
// template *is* part of the release-letter engine: the same service validates
// and stores it that mail-merges it. Nothing here overlaps with the resident
// letter route below — '/templates' and '/resident/:id' are distinct prefixes.

// --- Mail-merge templates ---------------------------------------------------
router.get('/templates', ReleaseLetterController.listTemplates);
router.post('/templates', ReleaseLetterController.createTemplate);
router.put('/templates/:id', ReleaseLetterController.updateTemplate);
router.delete('/templates/:id', ReleaseLetterController.deleteTemplate);

// --- Generation, preview and dispatch log ----------------------------------
// Mail-merge a release letter from the programme's template in one transaction.
router.post('/generate', ReleaseLetterController.generateLetter);

// Run the same merge without writing, for the live preview box.
router.post('/preview', ReleaseLetterController.previewLetter);

// The coordinator's dispatched letters log (optional ?program_id= filter).
router.get('/', ReleaseLetterController.listLetters);

// Fetch generated release letters for a resident.
router.get('/resident/:resident_id', ReleaseLetterController.getResidentLetters);

module.exports = router;
