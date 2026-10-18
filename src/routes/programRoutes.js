const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/programController');

/**
 * Programme management.
 *
 * The registry the coordinator area and the sign-in picker both read. `GET` also
 * accepts `?active=true` so the picker can hide deactivated programmes while the
 * management screen shows everything.
 */
router.get('/', ctrl.getPrograms);
router.post('/', ctrl.createProgram);
router.put('/:id', ctrl.updateProgram);
router.delete('/:id', ctrl.deleteProgram);

module.exports = router;
