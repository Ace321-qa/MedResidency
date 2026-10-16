const ExcelJS = require('exceljs');

/**
 * Publication-grade spreadsheet generation for the scheduling screens.
 *
 * The Master Rotation Grid and the Continuous Care Clinics matrix both need a
 * workbook that looks like the institutional spreadsheet a coordinator would
 * have built by hand: merged Block headings, colour-coded rotation cells, frozen
 * headings and explicit column widths. SheetJS (community `xlsx`) can write the
 * values and the merges but not a single fill or border, so this service uses
 * ExcelJS instead and renders from a *report model* the client sends — the same
 * model that feeds the PDF, Word and image exporters, so all four formats agree
 * about what the schedule says.
 *
 * The model is deliberately generic. A caller describes the table; it never
 * describes ExcelJS. That keeps the mobile client free of any ExcelJS-specific
 * detail and lets the layout rules (header band, borders, freeze panes, colour
 * fills) live in exactly one place.
 */

const HEADER_FILL = 'FF0F2C45'; // navy800 — the same header the app's own chrome uses
const HEADER_TEXT = 'FFFFFFFF';
const BORDER_COLOR = 'FFCBD5E1'; // slate300

/** ExcelJS wants one letter per column; 52 weeks plus four label columns fits in `ZZ`. */
function columnLetter(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/**
 * `#RRGGBB` (or `#RGB`) to the `FFRRGGBB` ref ExcelJS stores.
 *
 * An unparseable colour is dropped rather than guessed at: a wrong fill is
 * worse than a plain white cell, because the whole point of the colour is that
 * a coordinator reads the rota without reading the text.
 */
function toArgb(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `FF${hex.split('').map((c) => c + c).join('')}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex}`.toUpperCase();
  return null;
}

/** A cell payload may be a bare value or the rich `{ text, fill, ... }` shape. */
function normalizeCell(raw) {
  if (raw === null || raw === undefined) return { text: '' };
  if (typeof raw === 'object') {
    const span = Number(raw.colSpan);
    return {
      text: raw.text ?? raw.value ?? '',
      fill: raw.fill ?? null,
      textColor: raw.textColor ?? raw.color ?? null,
      bold: Boolean(raw.bold),
      align: raw.align ?? null,
      colSpan: Number.isFinite(span) && span > 1 ? Math.floor(span) : 1,
    };
  }
  return { text: String(raw) };
}

/** The stacked text a merged master-grid cell shows, one rotation per line. */
function cellText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

/**
 * The longest line in a cell, counted in characters.
 *
 * Column width is sized to the longest *line*, not the whole string, because
 * every data cell wraps: a four-line CCC day cell should not stretch its column
 * to the width of all four lines run together.
 */
function longestLineLength(value) {
  return cellText(value)
    .split('\n')
    .reduce((longest, line) => Math.max(longest, line.length), 0);
}

function thinBorder() {
  return {
    top: { style: 'thin', color: { argb: BORDER_COLOR } },
    left: { style: 'thin', color: { argb: BORDER_COLOR } },
    bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
    right: { style: 'thin', color: { argb: BORDER_COLOR } },
  };
}

/**
 * Render one report model to an `.xlsx` buffer.
 *
 * Validation is strict on the one thing that must never be wrong (`rows` must
 * be an array) and forgiving about everything cosmetic, so a slightly different
 * client still produces a usable file instead of a 500.
 */
async function buildWorkbook(report) {
  const payload = report && typeof report === 'object' ? report : {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) {
    const error = new Error('A schedule export needs at least one row.');
    error.statusCode = 400;
    throw error;
  }

  const declaredColumns = Array.isArray(payload.columns) ? payload.columns : [];
  const headerRows = Math.max(0, Math.min(rows.length, Number(payload.headerRows) || 0));

  // The column count is the widest row, counting spans, so a merged heading row
  // never truncates the data underneath it.
  const columnCount = rows.reduce((widest, row) => {
    const count = (Array.isArray(row) ? row : []).reduce(
      (sum, cell) => sum + normalizeCell(cell).colSpan,
      0,
    );
    return Math.max(widest, count);
  }, declaredColumns.length);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MedResidency';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(String(payload.sheetName || 'Schedule').slice(0, 31), {
    views: [{ state: 'frozen' }],
  });

  /** Where the first data row lands, so freeze panes can split there. */
  let currentRow = 1;
  const span = Math.max(1, columnCount);

  if (payload.title) {
    const titleRow = sheet.getRow(currentRow);
    titleRow.getCell(1).value = cellText(payload.title);
    titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: HEADER_TEXT } };
    titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    titleRow.height = 26;
    if (span > 1) sheet.mergeCells(currentRow, 1, currentRow, span);
    currentRow += 1;
  }

  if (payload.subtitle) {
    const subtitleRow = sheet.getRow(currentRow);
    subtitleRow.getCell(1).value = cellText(payload.subtitle);
    subtitleRow.getCell(1).font = { size: 11, italic: true, color: { argb: 'FF334155' } };
    if (span > 1) sheet.mergeCells(currentRow, 1, currentRow, span);
    currentRow += 1;
  }

  const meta = Array.isArray(payload.meta) ? payload.meta : [];
  for (const entry of meta) {
    if (!entry) continue;
    const metaRow = sheet.getRow(currentRow);
    metaRow.getCell(1).value = `${entry.label}:`;
    metaRow.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF475569' } };
    if (span > 2) {
      metaRow.getCell(2).value = cellText(entry.value ?? '');
      metaRow.getCell(2).font = { size: 10, color: { argb: 'FF0F172A' } };
      sheet.mergeCells(currentRow, 2, currentRow, span);
    } else {
      metaRow.getCell(2).value = cellText(entry.value ?? '');
    }
    currentRow += 1;
  }

  if (payload.title || payload.subtitle || meta.length > 0) {
    currentRow += 1; // one breathing row between the masthead and the grid
  }

  const tableStart = currentRow;

  // The widest content seen per column, measured only from the grid itself —
  // never the masthead and never a merged banner cell, whose text spans several
  // columns and would otherwise inflate whichever column it happens to start in.
  const measuredChars = new Array(span).fill(0);

  rows.forEach((rawRow, rowIndex) => {
    const cells = Array.isArray(rawRow) ? rawRow : [];
    const excelRow = sheet.getRow(currentRow);
    const isHeader = rowIndex < headerRows;
    let column = 1;

    for (const rawCell of cells) {
      const cell = normalizeCell(rawCell);
      const target = excelRow.getCell(column);
      target.value = cellText(cell.text);
      target.border = thinBorder();

      if (cell.colSpan === 1) {
        const length = longestLineLength(cell.text);
        if (length > measuredChars[column - 1]) measuredChars[column - 1] = length;
      }

      if (isHeader) {
        target.font = { bold: true, color: { argb: HEADER_TEXT }, size: 10 };
        target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
        target.alignment = { vertical: 'middle', horizontal: cell.align || 'center', wrapText: true };
      } else {
        target.font = {
          bold: cell.bold,
          size: 10,
          color: toArgb(cell.textColor) ? { argb: toArgb(cell.textColor) } : { argb: 'FF0F172A' },
        };
        const fill = toArgb(cell.fill);
        if (fill) {
          target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        }
        target.alignment = {
          vertical: 'middle',
          horizontal: cell.align || 'left',
          wrapText: true,
        };
      }

      if (cell.colSpan > 1) {
        const end = Math.min(column + cell.colSpan - 1, span);
        if (end > column) {
          sheet.mergeCells(currentRow, column, currentRow, end);
          // Carry the border across the merge so the grid lines stay unbroken.
          for (let c = column; c <= end; c += 1) {
            excelRow.getCell(c).border = thinBorder();
          }
        }
        column = end + 1;
      } else {
        column += 1;
      }
    }

    const perLine = String(cells.map((c) => normalizeCell(c).text).join('')).length;
    excelRow.height = isHeader ? 30 : perLine > 120 ? 40 : 20;
    currentRow += 1;
  });

  const legend = Array.isArray(payload.legend) ? payload.legend : [];
  if (legend.length > 0) {
    currentRow += 1;
    const legendRow = sheet.getRow(currentRow);
    legendRow.getCell(1).value = 'Legend';
    legendRow.getCell(1).font = { bold: true, size: 10 };
    currentRow += 1;
    for (const entry of legend) {
      if (!entry) continue;
      const row = sheet.getRow(currentRow);
      row.getCell(1).value = cellText(entry.label ?? '');
      const argb = toArgb(entry.color);
      if (argb) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
      currentRow += 1;
    }
  }

  // Column widths: sized from the widest content the grid actually holds, then
  // clamped so no column stretches absurdly wide (a per-line length of 200 in a
  // report's declared width must not become a 200-character column). The 14–28
  // character window keeps every column legible at the sheet's font size, with
  // `wrapText` letting long names and multi-line cells wrap inside it.
  for (let index = 0; index < span; index += 1) {
    const declared = Number(declaredColumns[index] && declaredColumns[index].width);
    const measured = measuredChars[index];
    const base = measured > 0 ? measured : Number.isFinite(declared) && declared > 0 ? declared : 12;
    sheet.getColumn(index + 1).width = Math.min(Math.max(base + 3, 14), 28);
  }

  if (payload.freezeHeader !== false && headerRows > 0) {
    sheet.views = [{ state: 'frozen', ySplit: tableStart - 1 + headerRows, xSplit: 0 }];
  } else {
    sheet.views = [{ state: 'frozen', ySplit: Math.max(0, tableStart - 1) }];
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildWorkbook, toArgb, columnLetter };
