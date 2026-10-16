const express = require('express');
const router = express.Router();
const NotificationController = require('../controllers/notificationController');

// Map URL routes to controller functions.

// A resident's notifications, newest first (supports ?type=, ?unread=, ?limit=, ?offset=)
router.get('/resident/:resident_id', NotificationController.listForResident);

// Badge count — declared before the list route's siblings for clarity; the
// extra path segment means it can never be captured by `/resident/:resident_id`.
router.get('/resident/:resident_id/unread-count', NotificationController.unreadCount);

// Mark every unread notification read for a resident
router.patch('/resident/:resident_id/read-all', NotificationController.markAllRead);

// Post a read receipt for one notification
router.patch('/:id/read', NotificationController.markRead);

// System-originated alert (SYSTEM_ALERT / GENERAL), e.g. from an admin tool
router.post('/', NotificationController.create);

module.exports = router;
