const RotationService = require('../services/rotationService');
const ExportService = require('../services/exportService');
const { normalizeAcademicYear } = require('../utils/academicYear');
const { buildMasterGridExportReport } = require('../utils/excel/grid');

/**
 * HTTP surface for the Master Rotation Grid download.
 *
 * `GET /api/v1/rotations/export/master` renders the same 52-week grid the
 * mobile and web screens paint, straight from the database, so a coordinator
 * can pull the rota as a workbook without the client first serialising a report
 * model. The file is byte-for-byte the layout `POST /api/v1/exports/workbook`
 * produces, because both hand the renderer the same kind of model.
 */

/** What a caller that omits `academic_year` gets. */
const DEFAULT_ACADEMIC_YEAR = '2026-2027';

/** A whole number above zero, or null when the value is absent/not numeric. */
function positiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * An infrastructure failure wears a mysql2 `code` (ECONNREFUSED, ETIMEDOUT,
 * ER_*) or sets `fatal`; a data problem does not. They are worth telling apart
 * only so the client can retry a 503 instead of re-reading a 400.
 */
function isInfrastructureError(error) {
  return Boolean(error && (error.fatal === true || (typeof error.code === 'string' && /^(ER_|ECONN|ETIMEDOUT|PROTOCOL_)/.test(error.code))));
}

class RotationExportController {
  /**
   * `GET /api/v1/rotations/export/master?academic_year=2026/2027&program_id=1`
   *
   * The academic year is accepted in either spelling (`2026/2027` or
   * `2026-2027`) and normalised before it reaches SQL, where
   * `rotation_blocks.academic_year` holds the hyphenated form and older rows
   * still hold the slash one. Responds with the workbook as an
   * `application/vnd...spreadsheetml.sheet` attachment.
   */
  static async exportMaster(req, res) {
    try {
      const rawYear = req.query.academic_year ?? req.body?.academic_year;
      const academicYear = normalizeAcademicYear(rawYear) || DEFAULT_ACADEMIC_YEAR;
      const programId = positiveInt(req.query.program_id ?? req.body?.program_id);
      const pgyLevel = positiveInt(req.query.pgy_level ?? req.body?.pgy_level);
      const gridStart = req.query.start_date ?? req.body?.start_date ?? null;

      const rows = await RotationService.getCohortGrid({
        academic_year: academicYear,
        program_id: programId,
        pgy_level: pgyLevel,
      });

      if (!Array.isArray(rows) || rows.length === 0) {
        const error = new Error(
          `No master grid data for academic year ${academicYear}${programId ? ` and program ${programId}` : ''}. ` +
            'Create the programme blocks for this year (or check the academic year spelling) before exporting.',
        );
        error.statusCode = 400;
        throw error;
      }

      const programCode = String(rows[0]?.program_code ?? '').trim();
      const programLabel = String(rows[0]?.specialty_name ?? '').trim();
      const report = buildMasterGridExportReport(rows, {
        academicYear,
        gridStart,
        programCode,
        programLabel,
        cohortLabel: pgyLevel ? `PGY-${pgyLevel}` : 'All levels',
      });

      const buffer = await ExportService.buildWorkbook(report);

      // The header carries the normalised year, so a caller asking for
      // `2026/2027` still downloads `Master_Rotation_Grid_2026-2027.xlsx`.
      const fileName = `Master_Rotation_Grid_${academicYear}.xlsx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', buffer.length);
      return res.status(200).send(Buffer.from(buffer));
    } catch (error) {
      // A crash here used to happen before a response was written — reading a
      // property off an unassigned grid cell threw a TypeError and Express
      // answered with an unhandled 500. Every path now lands in this catch and
      // answers JSON, with the full stack on the server for forensics.
      console.error('Master Grid Excel Export Crash:', error);
      const status = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : isInfrastructureError(error)
          ? 503
          : 400;
      // A deliberate `statusCode` (e.g. "no grid data for this year") carries a
      // message worth showing verbatim; anything unexpected reports the generic
      // line the client contract expects, with the real reason in `details`.
      const message = Number.isInteger(error?.statusCode)
        ? error.message || 'Master grid export failed.'
        : 'Failed to generate Excel file';
      return res.status(status).json({
        success: false,
        error: message,
        details: error?.message || String(error),
      });
    }
  }
}

module.exports = RotationExportController;
