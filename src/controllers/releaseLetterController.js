const ReleaseLetterService = require('../services/releaseLetterService');
const { isForeignKeyViolation, isEnumViolation } = require('../utils/mysqlErrors');

const VALID_SENT_STATUSES = ReleaseLetterService.SENT_STATUSES;

/** Translate service-thrown statusCode errors, then the MySQL-level failures. */
function sendError(res, error, fallbackMessage) {
  console.error(`Error in release letter controller: ${error.message}`);

  if (error.statusCode === 400) {
    return res.status(400).json({ success: false, error: error.message });
  }
  if (error.statusCode === 404) {
    return res.status(404).json({ success: false, error: error.message });
  }
  if (error.statusCode === 409) {
    return res.status(409).json({ success: false, error: error.message });
  }
  if (isForeignKeyViolation(error)) {
    return res.status(404).json({
      success: false,
      error:
        'Invalid foreign key reference. Ensure resident_id, assignment ids and template_id exist.',
    });
  }
  if (isEnumViolation(error)) {
    return res.status(400).json({
      success: false,
      error: `Invalid sent_status value. Must be one of: ${VALID_SENT_STATUSES.join(', ')}`,
    });
  }
  return res.status(500).json({
    success: false,
    error: fallbackMessage,
    details: error.message,
  });
}

class ReleaseLetterController {
  /**
   * POST /api/v1/letters/generate
   *
   * Mail-merges a letter inside one MySQL transaction: the letter row and the
   * assignment's release_letter_generated flag commit together, so a letter can
   * never exist for an assignment that claims it was never sent.
   */
  static async generateLetter(req, res) {
    try {
      const { resident_id, sent_status } = req.body;

      if (!resident_id) {
        return res.status(400).json({
          success: false,
          error:
            'Missing required field: resident_id. longitudinal_assignment_id and rotation_assignment_id are optional and are auto-resolved when omitted.',
        });
      }

      if (sent_status && !VALID_SENT_STATUSES.includes(sent_status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid sent_status value. Must be one of: ${VALID_SENT_STATUSES.join(', ')}`,
        });
      }

      const letter = await ReleaseLetterService.generateLetter(req.body);

      return res.status(201).json({
        success: true,
        message: letter.unresolved_placeholders.length
          ? `Release letter generated with unresolved placeholders: ${letter.unresolved_placeholders.join(', ')}`
          : 'Release letter generated successfully',
        data: letter,
      });
    } catch (error) {
      return sendError(res, error, 'Release letter generation failed');
    }
  }

  /**
   * POST /api/v1/letters/preview
   *
   * The same merge as /generate, without the transaction — the coordinator
   * reads the finished letter before anyone is told it exists.
   */
  static async previewLetter(req, res) {
    try {
      const { resident_id } = req.body;

      if (!resident_id) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: resident_id.',
        });
      }

      const preview = await ReleaseLetterService.previewLetter(req.body);

      return res.status(200).json({
        success: true,
        message: preview.unresolved_placeholders.length
          ? `Preview contains unresolved placeholders: ${preview.unresolved_placeholders.join(', ')}`
          : 'Preview merged successfully',
        data: preview,
      });
    } catch (error) {
      return sendError(res, error, 'Release letter preview failed');
    }
  }

  /**
   * GET /api/v1/letters/resident/:resident_id
   */
  static async getResidentLetters(req, res) {
    try {
      const { resident_id } = req.params;
      const letters = await ReleaseLetterService.getLettersByResident(resident_id);

      return res.status(200).json({
        success: true,
        count: letters.length,
        data: letters,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch generated release letters');
    }
  }

  /**
   * GET /api/v1/letters?program_id=X
   *
   * The coordinator's dispatch log: every letter merged from the programme's
   * templates, addressed to hospital department heads.
   */
  static async listLetters(req, res) {
    try {
      const program_id = req.query.program_id ? Number(req.query.program_id) : null;
      const letters = await ReleaseLetterService.getLettersByProgram(program_id);

      return res.status(200).json({
        success: true,
        count: letters.length,
        data: letters,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch dispatch letters');
    }
  }

  /**
   * GET /api/v1/letters/templates?program_id=X
   */
  static async listTemplates(req, res) {
    try {
      const program_id = req.query.program_id ? Number(req.query.program_id) : null;
      const templates = await ReleaseLetterService.listTemplates(program_id);

      return res.status(200).json({
        success: true,
        count: templates.length,
        data: templates,
      });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch release letter templates');
    }
  }

  /**
   * POST /api/v1/letters/templates
   */
  static async createTemplate(req, res) {
    try {
      const id = await ReleaseLetterService.createTemplate(req.body);
      return res.status(201).json({ success: true, id, data: { id } });
    } catch (error) {
      return sendError(res, error, 'Failed to create the release letter template');
    }
  }

  /**
   * PUT /api/v1/letters/templates/:id
   */
  static async updateTemplate(req, res) {
    try {
      await ReleaseLetterService.updateTemplate(req.params.id, req.body);
      return res.status(200).json({ success: true });
    } catch (error) {
      return sendError(res, error, 'Failed to update the release letter template');
    }
  }

  /**
   * DELETE /api/v1/letters/templates/:id
   */
  static async deleteTemplate(req, res) {
    try {
      await ReleaseLetterService.deleteTemplate(req.params.id);
      return res.status(200).json({ success: true });
    } catch (error) {
      return sendError(res, error, 'Failed to delete the release letter template');
    }
  }
}

module.exports = ReleaseLetterController;
