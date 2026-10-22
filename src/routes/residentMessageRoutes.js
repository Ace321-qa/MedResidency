const express = require('express');
const router = express.Router();
const ResidentMessageController = require('../controllers/residentMessageController');

/**
 * Resident messages — the resident's mailbox and the programme office's view
 * of the issues raised against it.
 *
 * The literal `/program/:program_id` route is declared before the root and the
 * `/:id` routes so the segment can never be read as a message id.
 */

// --- The programme office's queue of raised issues ----------------------------
router.get('/program/:program_id', ResidentMessageController.listForProgram);

// --- The resident's own boxes -------------------------------------------------
router.get('/', ResidentMessageController.list);
router.post('/', ResidentMessageController.create);
router.patch('/:id', ResidentMessageController.update);
router.delete('/:id', ResidentMessageController.remove);

module.exports = router;
