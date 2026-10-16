const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rotationRequestController');

router.post('/', ctrl.create);
router.get('/', ctrl.list);
router.patch('/:id', ctrl.decide);

module.exports = router;
