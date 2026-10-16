const ExportService = require('../services/exportService');

/**
 * HTTP surface for schedule exports.
 *
 * The clients (Expo mobile + React Native Web) send a *report model* and receive
 * the same `.xlsx` workbook whichever screen asked for it, so the two grids
 * cannot drift apart in layout. Generation is synchronous and small (one sheet);
 * a coordinator pressing Export expects the file, not a job id.
 */
class ExportController {
  /**
   * `POST /api/v1/exports/workbook`
   *
   * Body: `{ fileName?, sheetName?, title?, subtitle?, meta?, columns?,
   * headerRows?, rows, legend? }`. Responds with the workbook as an
   * `application/vnd...spreadsheetml.sheet` attachment.
   */
  static async createWorkbook(req, res) {
    try {
      const report = req.body || {};
      const buffer = await ExportService.buildWorkbook(report);

      const requested = String(report.fileName || 'schedule').trim();
      // Never let a client-supplied name escape the header or land on a path.
      const safe = requested.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'schedule';
      const fileName = safe.toLowerCase().endsWith('.xlsx') ? safe : `${safe}.xlsx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', buffer.length);
      return res.status(200).send(Buffer.from(buffer));
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = ExportController;
