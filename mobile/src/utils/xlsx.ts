import * as XLSX from 'xlsx';
export type XlsxCellValue = string | number | boolean | null | undefined;

/** One sheet of a multi-sheet workbook: its name, its rows and its merges. */
export interface XlsxSheetSpec {
  name: string;
  rows: XlsxCellValue[][];
  merges?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
}

export function buildXlsx(
  rows: unknown[][],
  sheetName = 'Sheet1',
  merges?: { s: { r: number; c: number }; e: { r: number; c: number } }[],
): ArrayBuffer | Uint8Array | Blob {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (merges && merges.length > 0) {
    ws['!merges'] = merges as any;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/**
 * Build a workbook with more than one sheet.
 *
 * `buildXlsx` writes exactly one sheet, which is right for the flat import
 * templates but not for the CCC template: its matrix or roster sheet and its
 * metadata sheet have to live in the same file, because the import reads the
 * first sheet for the grid and the metadata sheet for the banner and the backup
 * pools. Sheet names are unique and non-empty by construction, so a payload
 * that produced two sheets called `Metadata` would be a caller bug rather than
 * something to silently merge.
 */
export function buildXlsxSheets(
  sheets: XlsxSheetSpec[],
  fallbackName = 'Sheet1',
): ArrayBuffer | Uint8Array | Blob {
  if (sheets.length === 0) {
    return buildXlsx([[]], fallbackName);
  }
  const wb = XLSX.utils.book_new();
  sheets.forEach((sheet, index) => {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    if (sheet.merges && sheet.merges.length > 0) {
      ws['!merges'] = sheet.merges as any;
    }
    const name = sheet.name?.trim() || (index === 0 ? fallbackName : `Sheet${index + 1}`);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

export function parseXlsx(buffer: ArrayBuffer | Uint8Array): any[][] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
}

export const xlsx = { buildXlsx, buildXlsxSheets, parseXlsx };
export default xlsx;
