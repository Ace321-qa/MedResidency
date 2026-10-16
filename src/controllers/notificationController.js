const NotificationService = require('../services/notificationService');

/**
 * Notifications HTTP surface.
 *
 * Endpoints are resident-scoped (`/resident/:resident_id`) because the app's
 * only identity today is a chosen resident; the service resolves that to the
 * internal `users.id`. When authentication lands, a `user`-scoped alias can be
 * added without changing the service layer.
 */
class NotificationController {
  /**
   * GET /api/v1/notifications/resident/:resident_id
   * Query: type, unread (truthy), limit, offset
   */
  static async listForResident(req, res) {
    try {
      const residentId = Number(req.params.resident_id);
      if (!Number.isInteger(residentId) || residentId <= 0) {
        return res.status(400).json({ success: false, error: 'A valid resident_id is required.' });
      }

      const { type, limit, offset } = req.query;
      const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unread).toLowerCase());

      if (type && !NotificationService.getNotificationTypes().includes(type)) {
        return res.status(400).json({
          success: false,
          error: `Invalid type. Must be one of: ${NotificationService.getNotificationTypes().join(', ')}`,
        });
      }

      const result = await NotificationService.list({
        resident_id: residentId,
        type,
        unread_only: unreadOnly,
        limit,
        offset,
      });

      return res.status(200).json({
        success: true,
        count: result.data.length,
        total: result.total,
        unread: result.unread,
        limit: result.limit,
        offset: result.offset,
        data: result.data,
      });
    } catch (error) {
      console.error('Error in NotificationController.listForResident:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch notifications',
        details: error.message,
      });
    }
  }

  /**
   * GET /api/v1/notifications/resident/:resident_id/unread-count
   */
  static async unreadCount(req, res) {
    try {
      const residentId = Number(req.params.resident_id);
      if (!Number.isInteger(residentId) || residentId <= 0) {
        return res.status(400).json({ success: false, error: 'A valid resident_id is required.' });
      }

      const unread = await NotificationService.getUnreadCount({ resident_id: residentId });
      return res.status(200).json({ success: true, unread });
    } catch (error) {
      console.error('Error in NotificationController.unreadCount:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to count unread notifications',
        details: error.message,
      });
    }
  }

  /**
   * PATCH /api/v1/notifications/:id/read
   * Body: { resident_id } (or user_id)
   */
  static async markRead(req, res) {
    try {
      const { resident_id, user_id } = req.body ?? {};
      if (!resident_id && !user_id) {
        return res.status(400).json({
          success: false,
          error: 'resident_id is required to identify the notification owner.',
        });
      }

      const result = await NotificationService.markRead(req.params.id, {
        resident_id,
        user_id,
      });

      if (!result.found) {
        return res.status(404).json({ success: false, error: 'Notification not found.' });
      }

      return res.status(200).json({
        success: true,
        message: 'Notification marked as read',
        data: result.notification,
      });
    } catch (error) {
      console.error('Error in NotificationController.markRead:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to update notification',
        details: error.message,
      });
    }
  }

  /**
   * PATCH /api/v1/notifications/resident/:resident_id/read-all
   */
  static async markAllRead(req, res) {
    try {
      const residentId = Number(req.params.resident_id);
      if (!Number.isInteger(residentId) || residentId <= 0) {
        return res.status(400).json({ success: false, error: 'A valid resident_id is required.' });
      }

      const result = await NotificationService.markAllRead({ resident_id: residentId });
      return res.status(200).json({
        success: true,
        message: `${result.changed} notification(s) marked as read`,
        changed: result.changed,
        unread: result.unread,
      });
    } catch (error) {
      console.error('Error in NotificationController.markAllRead:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to update notifications',
        details: error.message,
      });
    }
  }

  /**
   * POST /api/v1/notifications
   * Body: { resident_id | user_id, title, message, type?, reference_id?, reference_type? }
   *
   * For server-originated `SYSTEM_ALERT` / `GENERAL` notices that are not tied
   * to one of the automatic triggers.
   */
  static async create(req, res) {
    try {
      const { resident_id, user_id, title, message, type, reference_id, reference_type } =
        req.body ?? {};

      if (!title || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: title, message',
        });
      }
      if (!resident_id && !user_id) {
        return res.status(400).json({
          success: false,
          error: 'A recipient is required: pass resident_id or user_id.',
        });
      }

      const validTypes = NotificationService.getNotificationTypes();
      if (type && !validTypes.includes(type)) {
        return res.status(400).json({
          success: false,
          error: `Invalid type. Must be one of: ${validTypes.join(', ')}`,
        });
      }

      let notification;
      if (user_id) {
        notification = await NotificationService.create({
          user_id: Number(user_id),
          title,
          message,
          type: type || 'GENERAL',
          reference_id,
          reference_type,
        });
      } else {
        notification = await NotificationService.notifyResident(Number(resident_id), {
          title,
          message,
          type: type || 'GENERAL',
          reference_id,
          reference_type,
        });
      }

      if (!notification) {
        return res.status(404).json({
          success: false,
          error: 'Recipient not found. Ensure resident_id exists.',
        });
      }

      return res.status(201).json({
        success: true,
        message: 'Notification created',
        data: notification,
      });
    } catch (error) {
      console.error('Error in NotificationController.create:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to create notification',
        details: error.message,
      });
    }
  }
}

module.exports = NotificationController;
