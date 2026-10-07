const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rotationRequestController');

router.post('/', ctrl.create);

module.exports = router;
