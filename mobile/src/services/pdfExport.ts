/**
 * CCC export facade: the one place the CCC screen asks for a file in any
 * format, so the screen never has to know which renderer produced it.
 *
 * The matrix screen already renders an off-screen report view and describes its
 * content as a `ReportModel`, which is enough for Word, images and the styled
 * workbook. PDF is the format that must agree with the *template* rather than
 * with the report, because a PDF of the matrix and the .xlsx template are two
 * views of the same week: same banner, same day rows, same clinic columns, same
 * backup pools. So the PDF is requested from the server, which renders it from
 * the very payload the screen built — and only when the API is unreachable does
 * the request fall back to the on-device renderer, which draws the same model
 * the screen displays.
 *
 * Rule for every branch here: a format either arrives or it throws. There is no
 * silent downgrade to a different file type, because a coordinator who asked for
 * a PDF and received a JPG would not notice until they tried to edit it.
 */

import { apiClient } from './client';
import { downloadScheduleReport, type ExportFormat, type SavedFile } from './scheduleExport';
import { describeSave, saveFile } from '../utils/fileSave';
import type { CaptureTarget, ReportModel } from '../utils/scheduleExport';
import type { CccTemplatePayload } from '../utils/cccTemplate';

/** How long the server gets to turn a payload into a PDF before we render it. */
const PDF_REQUEST_TIMEOUT_MS = 8000;

export interface CccExportRequest {
  /** The rendered report model — what the screen shows, and the fallback source. */
  report: ReportModel;
  /** The template payload — banner, day rows, columns, backup pools. */
  payload: CccTemplatePayload | null;
  programId: number;
  format: ExportFormat;
  /** Required for `jpg`/`png`, which capture the off-screen report view. */
  imageTarget?: CaptureTarget;
}

/**
 * Render `format` for the CCC matrix and save it, returning the saved-file
 * record and the sentence the screen shows.
 */
export async function downloadCccExport(
  request: CccExportRequest,
): Promise<{ saved: SavedFile; confirmation: string }> {
  const { format, payload, programId } = request;

  if (format === 'pdf') {
    const serverBytes = payload ? await fetchServerPdf(payload, programId) : null;
    if (serverBytes) {
      const saved = await saveFile(`${request.report.fileName}.pdf`, serverBytes, 'pdf');
      return { saved, confirmation: describeSave(saved) };
    }
    // The API is unreachable or answered with something that is not a PDF:
    // render the same model on this device rather than dropping the export.
    return downloadScheduleReport(request.report, format, request.imageTarget);
  }

  return downloadScheduleReport(request.report, format, request.imageTarget);
}

/**
 * Ask the server for a PDF of `payload`, or `null` when it cannot be trusted.
 *
 * A non-2xx status, a body too small to be a PDF and a network failure all mean
 * the same thing to the caller — no server bytes — so none of them throw here;
 * the fallback renderer decides what the user receives.
 */
export async function fetchServerPdf(
  payload: CccTemplatePayload,
  programId: number,
): Promise<Uint8Array | null> {
  try {
    const response = await apiClient.post<ArrayBuffer>(
      '/longitudinal/matrix/export/pdf',
      { ...payload, program_id: programId || null },
      {
        responseType: 'arraybuffer',
        timeout: PDF_REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const bytes = new Uint8Array(response.data ?? new ArrayBuffer(0));
    // A JSON error body arrives as bytes too; a PDF always starts with `%PDF`.
    if (bytes.byteLength < 100 || !startsWithPdfSignature(bytes)) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** `%PDF` — the only thing that proves the body is actually a PDF. */
function startsWithPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
