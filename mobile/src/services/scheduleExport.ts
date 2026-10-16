import { apiClient } from './client';
import { describeSave, saveFile, type ExportFormat, type SavedFile } from '../utils/fileSave';
import {
  buildCccMatrixReport,
  buildMasterGridReport,
  captureReportView,
  renderReportDocx,
  renderReportPdf,
  type CaptureTarget,
  type CccMatrixReportInput,
  type MasterGridReportInput,
  type ReportModel,
} from '../utils/scheduleExport';

/**
 * Schedule export orchestration.
 *
 * The screens describe *what* to export (a grid report or a CCC matrix report);
 * this service decides *how* each format is produced:
 *
 *   - `.xlsx` is rendered by the backend, because a styled workbook with
 *     colour-coded cells cannot be written by the client's SheetJS build. The
 *     report model is posted and the bytes come back.
 *   - `.pdf`, `.docx` are rendered on-device from the same model.
 *   - `.jpg`/`.png` capture the offscreen report view the screen owns.
 *
 * Keeping the branch here means a screen never imports a renderer directly, and
 * adding a format is one case in `generate`.
 */

export type { ExportFormat, SavedFile };
export { describeSave };

export interface MasterExportInput extends MasterGridReportInput {
  programId: number;
}

export interface CccExportInput extends CccMatrixReportInput {
  programId: number;
}

/**
 * Render a report, save it under the format's extension, and return both the
 * saved-file record and the confirmation sentence the screen should show.
 */
export async function downloadScheduleReport(
  report: ReportModel,
  format: ExportFormat,
  imageTarget?: CaptureTarget,
): Promise<{ saved: SavedFile; confirmation: string }> {
  const bytes = await generate(report, format, imageTarget);
  const saved = await saveFile(`${report.fileName}.${format}`, bytes, format);
  return { saved, confirmation: describeSave(saved) };
}

export async function exportMasterGrid(
  input: MasterExportInput,
  format: ExportFormat,
  imageTarget?: CaptureTarget,
): Promise<Uint8Array> {
  return generate(buildMasterGridReport(input), format, imageTarget);
}

export async function exportCccMatrix(
  input: CccExportInput,
  format: ExportFormat,
  imageTarget?: CaptureTarget,
): Promise<Uint8Array> {
  return generate(buildCccMatrixReport(input), format, imageTarget);
}

async function generate(
  report: ReportModel,
  format: ExportFormat,
  imageTarget?: CaptureTarget,
): Promise<Uint8Array> {
  switch (format) {
    case 'xlsx': {
      const response = await apiClient.post<ArrayBuffer>('/exports/workbook', report, {
        responseType: 'arraybuffer',
      });
      return new Uint8Array(response.data);
    }
    case 'pdf':
      return renderReportPdf(report);
    case 'docx':
      return renderReportDocx(report);
    case 'jpg':
      if (!imageTarget) throw new Error('JPEG export needs a report capture target.');
      return captureReportView(imageTarget, 'jpg');
    case 'png':
      if (!imageTarget) throw new Error('PNG export needs a report capture target.');
      return captureReportView(imageTarget, 'png');
  }
}
