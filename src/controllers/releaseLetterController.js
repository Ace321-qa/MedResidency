const ReleaseLetterService = require('../services/releaseLetterService');
const { isForeignKeyViolation, isEnumViolation } = require('../utils/mysqlErrors');

class ReleaseLetterController {
  /**
   * POST /api/v1/letters/generate
   */
  static async generateLetter(req, res) {
    try {
      const { resident_id, longitudinal_assignment_id, template_code, sent_status } = req.body;

      if (!resident_id) {
        return res.status(400).json({
          success: false,
          error:
            'Missing required field: resident_id. longitudinal_assignment_id is optional and is auto-resolved when omitted.',
        });
      }

      // The live database runs without STRICT_TRANS_TABLES, so an out-of-range
      // ENUM value is stored as '' instead of raising an error. Validate here.
      const validSentStatuses = ['DRAFT', 'GENERATED', 'SENT', 'ACKNOWLEDGED'];
      if (sent_status && !validSentStatuses.includes(sent_status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid sent_status value. Must be one of: ${validSentStatuses.join(', ')}`,
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
      console.error('Error in generateLetter controller:', error.message);

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
            'Invalid foreign key reference. Ensure resident_id, longitudinal_assignment_id and template_id exist.',
        });
      }

      if (isEnumViolation(error)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid sent_status value. Must be one of: DRAFT, GENERATED, SENT, ACKNOWLEDGED',
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Release letter generation failed',
        details: error.message,
      });
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
      console.error('Error in getResidentLetters controller:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch generated release letters',
        details: error.message,
      });
    }
  }
}

module.exports = ReleaseLetterController;