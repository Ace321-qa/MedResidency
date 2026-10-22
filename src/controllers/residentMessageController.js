const NotificationService = require('../services/notificationService');
const ResidentMessageService = require('../services/residentMessageService');

/**
 * Resident messages — the API behind the resident's Letters tab.
 *
 * The endpoints are thin on purpose: the screen does the wording, this does
 * the arithmetic of what is allowed. A message that fails validation is
 * refused with a sentence the resident can act on, because a rejected compose
 * that says "400 Bad Request" is a compose the resident cannot fix.
 */

const { VALID_CATEGORIES, VALID_FOLDERS } = ResidentMessageService;

/** A positive integer id, or `null`. */
function toPositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function badRequest(res, messages) {
  return res.status(400).json({ success: false, errors: messages });
}

class ResidentMessageController {
  /**
   * GET /api/v1/messages?resident_id=N
   *
   * The three boxes in one response. A resident opens the tab and wants all of
   * them at once — the tab counts are drawn from this same payload — so
   * splitting it into three requests would only make the screen flash.
   */
  static async list(req, res) {
    try {
      const residentId = toPositiveInt(req.query.resident_id);
      if (!residentId) {
        return badRequest(res, ['A resident id is required.']);
      }

      const boxes = await ResidentMessageService.listForResident(residentId);

      return res.json({
        success: true,
        count: boxes.inbox.length + boxes.drafts.length + boxes.sent.length,
        data: boxes,
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/v1/messages/program/:program_id
   *
   * The programme office's side of the same rows: everything residents have
   * raised against this programme, with the resident's name attached.
   */
  static async listForProgram(req, res) {
    try {
      const programId = toPositiveInt(req.params.program_id);
      if (!programId) {
        return badRequest(res, ['A programme id is required.']);
      }

      const messages = await ResidentMessageService.listForProgram(programId, {
        folder: req.query.folder,
      });

      return res.json({ success: true, count: messages.length, data: messages });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * POST /api/v1/messages
   *
   * Saves a draft or sends to the programme office. The two differ only in the
   * folder the row lands in — and in what the send does afterwards: a sent
   * message alerts the programme's coordinator, because a message that arrives
   * silently is a message nobody reads.
   */
  static async create(req, res) {
    try {
      const {
        resident_id,
        program_id,
        recipient_department,
        subject,
        body,
        category = 'GENERAL',
        folder = 'SENT',
      } = req.body ?? {};

      const problems = [];

      const residentId = toPositiveInt(resident_id);
      if (!residentId) problems.push('A resident id is required.');

      const programId = toPositiveInt(program_id);
      if (!programId) problems.push('A programme id is required.');

      const trimmedSubject = typeof subject === 'string' ? subject.trim() : '';
      if (!trimmedSubject) problems.push('A subject is required.');
      else if (trimmedSubject.length > ResidentMessageService.MAX_SUBJECT_LENGTH) {
        problems.push(`Subject must be ${ResidentMessageService.MAX_SUBJECT_LENGTH} characters or fewer.`);
      }

      const trimmedBody = typeof body === 'string' ? body.trim() : '';
      if (!trimmedBody) problems.push('A message body is required.');
      else if (trimmedBody.length > ResidentMessageService.MAX_BODY_LENGTH) {
        problems.push(`Message body must be ${ResidentMessageService.MAX_BODY_LENGTH} characters or fewer.`);
      }

      const normalizedCategory = String(category).toUpperCase();
      if (!VALID_CATEGORIES.includes(normalizedCategory)) {
        problems.push(`Category must be one of ${VALID_CATEGORIES.join(', ')}.`);
      }

      const normalizedFolder = String(folder).toUpperCase();
      // A resident may write a draft or send a message; they may not file
      // something into their own inbox, which is the programme's to write.
      if (!['DRAFT', 'SENT'].includes(normalizedFolder)) {
        problems.push('A message is either saved as a draft or sent to the programme office.');
      }

      const recipient = ResidentMessageService.trimToNull(recipient_department);
      if (recipient && recipient.length > ResidentMessageService.MAX_RECIPIENT_LENGTH) {
        problems.push(
          `Recipient must be ${ResidentMessageService.MAX_RECIPIENT_LENGTH} characters or fewer.`,
        );
      }

      if (problems.length > 0) return badRequest(res, problems);

      const message = await ResidentMessageService.create({
        residentId,
        programId,
        recipientDepartment: recipient,
        subject: trimmedSubject,
        body: trimmedBody,
        category: normalizedCategory,
        folder: normalizedFolder,
      });

      if (normalizedFolder === 'SENT') {
        // Best-effort: the message is already durable, so a notification that
        // could not be written must not undo the delivery.
        await NotificationService.notifyProgramCoordinatorSafe(programId, {
          type: 'SYSTEM_ALERT',
          title: `Raised issue: ${trimmedSubject}`,
          message:
            (recipient ? `A resident raised an issue with ${recipient}. ` : 'A resident raised an issue. ') +
            'Open Letters to read it.',
          reference_id: message?.id ?? null,
          reference_type: 'resident_messages',
        });
      }

      return res.status(201).json({ success: true, data: { message } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * PATCH /api/v1/messages/:id
   *
   * Edits a draft, sends it, or marks an inbox message read. The message must
   * belong to the resident making the request — a message id on its own is not
   * authority to read or rewrite somebody else's mail.
   */
  static async update(req, res) {
    try {
      const id = toPositiveInt(req.params.id);
      if (!id) return badRequest(res, ['A message id is required.']);

      const residentId = toPositiveInt(req.body?.resident_id);
      if (!residentId) return badRequest(res, ['A resident id is required.']);

      const existing = await ResidentMessageService.readOne(id);
      if (!existing || Number(existing.resident_id) !== residentId) {
        return res.status(404).json({ success: false, error: 'Message not found.' });
      }

      const changes = {};
      const problems = [];

      if ('subject' in (req.body ?? {})) {
        const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
        if (!subject) problems.push('A subject is required.');
        else if (subject.length > ResidentMessageService.MAX_SUBJECT_LENGTH) {
          problems.push(
            `Subject must be ${ResidentMessageService.MAX_SUBJECT_LENGTH} characters or fewer.`,
          );
        } else {
          changes.subject = subject;
        }
      }

      if ('body' in (req.body ?? {})) {
        const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
        if (!body) problems.push('A message body is required.');
        else if (body.length > ResidentMessageService.MAX_BODY_LENGTH) {
          problems.push(
            `Message body must be ${ResidentMessageService.MAX_BODY_LENGTH} characters or fewer.`,
          );
        } else {
          changes.body = body;
        }
      }

      if ('category' in (req.body ?? {})) {
        const category = String(req.body.category).toUpperCase();
        if (!VALID_CATEGORIES.includes(category)) {
          problems.push(`Category must be one of ${VALID_CATEGORIES.join(', ')}.`);
        } else {
          changes.category = category;
        }
      }

      if ('recipient_department' in (req.body ?? {})) {
        const recipient = ResidentMessageService.trimToNull(req.body.recipient_department);
        if (recipient && recipient.length > ResidentMessageService.MAX_RECIPIENT_LENGTH) {
          problems.push(
            `Recipient must be ${ResidentMessageService.MAX_RECIPIENT_LENGTH} characters or fewer.`,
          );
        } else {
          changes.recipient_department = recipient;
        }
      }

      if ('folder' in (req.body ?? {})) {
        const folder = String(req.body.folder).toUpperCase();
        if (!['DRAFT', 'SENT'].includes(folder)) {
          problems.push('A message is either saved as a draft or sent to the programme office.');
        } else {
          changes.folder = folder;
        }
      }

      if ('is_read' in (req.body ?? {})) {
        changes.is_read = req.body.is_read ? 1 : 0;
      }

      if (problems.length > 0) return badRequest(res, problems);

      const message = await ResidentMessageService.update(id, changes);

      // Sending a draft is the moment the programme office needs to know.
      if (changes.folder === 'SENT' && existing.folder === 'DRAFT') {
        await NotificationService.notifyProgramCoordinatorSafe(existing.program_id, {
          type: 'SYSTEM_ALERT',
          title: `Raised issue: ${message?.subject ?? existing.subject}`,
          message:
            (message?.recipient_department
              ? `A resident raised an issue with ${message.recipient_department}. `
              : 'A resident raised an issue. ') +
            'Open Letters to read it.',
          reference_id: message?.id ?? id,
          reference_type: 'resident_messages',
        });
      }

      return res.json({ success: true, data: { message } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * DELETE /api/v1/messages/:id
   *
   * Removes a draft. A sent message is the programme's record and is refused.
   */
  static async remove(req, res) {
    try {
      const id = toPositiveInt(req.params.id);
      if (!id) return badRequest(res, ['A message id is required.']);

      const residentId = toPositiveInt(req.query.resident_id ?? req.body?.resident_id);
      if (!residentId) return badRequest(res, ['A resident id is required.']);

      const removed = await ResidentMessageService.remove(id, residentId);
      if (!removed) {
        return res.status(404).json({
          success: false,
          error: 'Message not found, or it has already been sent and is part of the programme record.',
        });
      }

      return res.json({ success: true, data: { id } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = ResidentMessageController;
module.exports.VALID_FOLDERS = VALID_FOLDERS;
