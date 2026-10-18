const XLSX = require('xlsx');

/**
 * Build a one-sheet workbook from a table of rows.
 *
 * `merges` is optional and expressed the way SheetJS wants it (`{s,e}` cell
 * ranges). The master grid template needs it: thirteen "Block N" headings each
 * span four week columns, and the frozen left-hand headings span the three
 * header rows, which is what makes the sheet read like the institutional
 * spreadsheet rather than like a dump of one.
 */
function makeSheetBuffer(rows, sheetName = 'Sheet1', merges = []) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (merges.length > 0) ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** `makeSheetBuffer` for a single header row plus data rows. */
function makeBuffer(headers, rows, sheetName = 'Sheet1') {
  return makeSheetBuffer([headers, ...rows], sheetName);
}

/**
 * Build a workbook holding several sheets, in array order.
 *
 * The CCC template needs this: its matrix (or roster) sheet and its metadata
 * sheet are one file, because the import reads the first sheet for the grid and
 * the second for the banner, the rotation window and the backup pools. Every
 * sheet must have a unique, non-empty name, so a duplicate is a caller bug that
 * gets numbered rather than silently dropped.
 */
function makeWorkbookBuffer(sheets, fallbackName = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  sheets.forEach((sheet, index) => {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows || []);
    if (sheet.merges && sheet.merges.length > 0) ws['!merges'] = sheet.merges;
    let name = String(sheet.name || '').trim() || (index === 0 ? fallbackName : `Sheet${index + 1}`);
    let unique = name;
    let suffix = 2;
    while (used.has(unique.toLowerCase())) {
      unique = `${name.slice(0, 28)} ${suffix}`;
      suffix += 1;
    }
    used.add(unique.toLowerCase());
    XLSX.utils.book_append_sheet(wb, ws, unique);
  });
  if (wb.SheetNames.length === 0) {
    return makeSheetBuffer([], fallbackName);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { makeBuffer, makeSheetBuffer, makeWorkbookBuffer };
