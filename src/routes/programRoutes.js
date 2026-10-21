const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/programController');

/**
 * Programme management.
 *
 * The registry the coordinator area and the sign-in picker both read. `GET` also
 * accepts `?active=true` so the picker can hide deactivated programmes while the
 * management screen shows everything.
 *
 * The literal routes are declared before `/:id`, so `/network` is the network
 * report rather than a request for programme "network".
 */
router.get('/network', ctrl.getNetwork);
router.get('/connection-types', ctrl.getConnectionTypes);
router.post('/connections', ctrl.createConnection);
router.delete('/connections/:id', ctrl.deleteConnection);

router.get('/', ctrl.getPrograms);
router.post('/', ctrl.createProgram);
router.get('/:id/connections', ctrl.getProgramConnections);
router.put('/:id', ctrl.updateProgram);
router.delete('/:id', ctrl.deleteProgram);

module.exports = router;
