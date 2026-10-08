import XLSX from 'xlsx';
import type { WorkSheet } from 'xlsx';
export type XlsxCellValue = string | number | boolean | null | undefined;

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

export function parseXlsx(buffer: ArrayBuffer | Uint8Array): any[][] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
}

export const xlsx = { buildXlsx, parseXlsx };
export default xlsx;
