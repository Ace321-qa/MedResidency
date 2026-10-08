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

module.exports = { makeBuffer, makeSheetBuffer };
