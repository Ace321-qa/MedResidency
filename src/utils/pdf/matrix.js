/**
 * A dependency-free PDF renderer for the CCC matrix and roster.
 *
 * The server deliberately ships no PDF library, so this module writes the PDF
 * object graph itself: one catalog, one page tree, two Helvetica fonts and a
 * content stream per page. That is enough for a table export — text, rules and
 * a repeating header row — and it keeps the export path identical to the Excel
 * path: both render the same `CccTemplatePayload`.
 *
 * Coordinates are PDF points with the origin bottom-left; layout is computed
 * top-down and flipped when the stream is written. Every string is mapped to
 * WinAnsi before it reaches the stream, so `Köhler` prints rather than breaks.
 */

const PAGE_WIDTH = 842; // A4 landscape
const PAGE_HEIGHT = 595;
const MARGIN = 24;

const FONT_REGULAR = 'F1';
const FONT_BOLD = 'F2';

/**
 * Helvetica advance widths in 1/1000 em, ASCII 32..126. Used to wrap and
 * truncate cell text to the column it is printed in — the only way a table
 * whose columns are narrower than its words still fits the page.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const ELLIPSIS = '…';

function charWidth(code) {
  if (code >= 32 && code <= 126) return HELVETICA_WIDTHS[code - 32];
  return 556;
}

/** The width of `text` at `size` points, in Helvetica metrics. */
function textWidth(text, size) {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    units += charWidth(text.charCodeAt(i));
  }
  return (units / 1000) * size;
}

/**
 * Map a string onto WinAnsi: the characters Helvetica prints in Latin-1 are
 * kept (and become single bytes in the stream), anything else becomes `?`.
 */
function toWinAnsi(text) {
  let out = '';
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code >= 32 && code <= 126) {
      out += char;
    } else if (code >= 160 && code <= 255) {
      out += char;
    } else if (char === '–' || char === '—') {
      out += '-';
    } else if (char === '‘' || char === '’') {
      out += "'";
    } else if (char === '“' || char === '”') {
      out += '"';
    } else if (char === '•') {
      out += '-';
    } else {
      out += '?';
    }
  }
  return out;
}

/** Wrap text to `width` points, breaking on spaces and hard-breaking long words. */
function wrapText(text, size, width) {
  const words = toWinAnsi(text).split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= width || line === '') {
      // A single word wider than the column is broken by characters.
      if (line === '' && textWidth(word, size) > width) {
        let chunk = '';
        for (const char of word) {
          if (textWidth(chunk + char, size) > width && chunk) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        line = chunk;
        continue;
      }
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Wrap to a line budget; the last line carries an ellipsis when cut. */
function wrapWithin(text, size, width, maxLines) {
  const lines = wrapText(text, size, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  let trimmed = last;
  while (trimmed.length > 1 && textWidth(trimmed + ELLIPSIS, size) > width) {
    trimmed = trimmed.slice(0, -1);
  }
  kept[maxLines - 1] = trimmed + ELLIPSIS;
  return kept;
}

/* -------------------------------------------------------------------------- *
 * Stream primitives.
 * -------------------------------------------------------------------------- */

/** Escape a WinAnsi string for a PDF literal `(...)`. */
function pdfString(text) {
  return toWinAnsi(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A text run: `BT` at x,y (PDF coordinates) with a font and size. */
function textRun(x, y, text, { font = FONT_REGULAR, size = 8 } = {}) {
  if (!text) return '';
  return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfString(text)}) Tj ET\n`;
}

function line(x1, y1, x2, y2, width = 0.4) {
  return `${width.toFixed(2)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`;
}

function rectStroke(x, y, width, height, lineWidth = 0.4) {
  return `${lineWidth.toFixed(2)} w ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S\n`;
}

function rectFill(x, y, width, height) {
  return `${(0.93).toFixed(2)} g ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re 0 g f\n`;
}

/* -------------------------------------------------------------------------- *
 * The table engine shared by the matrix and the roster renderers.
 * -------------------------------------------------------------------------- */

/**
 * Lay a table out and render it across as many pages as it needs.
 *
 * Row heights are fixed: a row holds `maxLines` of `fontSize` text with a
 * leading, so pagination is arithmetic rather than measurement. The header row
 * repeats at the top of every page.
 *
 * @param {object} options
 * @param {string[]} options.headers
 * @param {string[][]} options.rows
 * @param {number[]} options.widths column widths in points, summing to the table width
 * @param {string} options.title printed once at the top of the first page
 * @param {string[]} [options.footer] lines printed after the table
 * @param {number} [options.fontSize]
 * @param {number} [options.maxLines] lines a cell may hold before truncation
 * @returns {string[]} one content stream per page
 */
function renderTable({ headers, rows, widths, title = '', footer = [], fontSize = 7, maxLines = 4 }) {
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const cellPadding = 3;
  const leading = fontSize + 1.5;
  const rowHeight = maxLines * leading + cellPadding * 2;
  const headerHeight = rowHeight;
  const topMargin = MARGIN;

  // The banner block on page one: wrapped title, then space for the table.
  const titleLines = title ? wrapWithin(title, 7.5, tableWidth, 3) : [];
  const titleBlockHeight = titleLines.length > 0 ? titleLines.length * 10 + 8 : 0;

  const bodyTop = PAGE_HEIGHT - topMargin - titleBlockHeight - headerHeight;
  const footerBlockHeight = footer.length > 0 ? footer.length * 11 + 14 : 0;
  const pageCapacity = Math.max(
    1,
    Math.floor((bodyTop - MARGIN - (footer.length > 0 ? footerBlockHeight : 0)) / rowHeight),
  );

  const pages = [];
  let pageStream = '';
  let y = 0;
  let rowCursor = 0;

  const headerRow = (topY) => {
    let stream = rectFill(MARGIN, topY - headerHeight, tableWidth, headerHeight);
    let x = MARGIN;
    for (let index = 0; index < headers.length; index += 1) {
      const width = widths[index];
      const lines = wrapWithin(headers[index], fontSize + 0.5, width - cellPadding * 2, 2);
      const blockHeight = lines.length * leading;
      let lineY = topY - cellPadding - fontSize;
      void blockHeight;
      for (const text of lines) {
        stream += textRun(x + cellPadding, lineY, text, { font: FONT_BOLD, size: fontSize + 0.5 });
        lineY -= leading;
      }
      x += width;
    }
    stream += rectStroke(MARGIN, topY - headerHeight, tableWidth, headerHeight, 0.7);
    x = MARGIN;
    for (let index = 0; index < headers.length - 1; index += 1) {
      x += widths[index];
      stream += line(x, topY, x, topY - headerHeight, 0.3);
    }
    return stream;
  };

  // Page one carries the banner; later pages start with the header row.
  const startY = PAGE_HEIGHT - topMargin - titleBlockHeight;
  y = startY;
  pageStream += titleLines.map((text, index) => textRun(MARGIN, y - 8 - index * 10, text, { font: FONT_BOLD, size: 7.5 })).join('');
  if (titleLines.length > 0) y -= titleBlockHeight;
  pageStream += headerRow(y);
  y -= headerHeight;

  while (rowCursor < rows.length) {
    if (rowCursor > 0 && rowCursor % pageCapacity === 0) {
      pages.push(pageStream);
      pageStream = '';
      y = PAGE_HEIGHT - topMargin;
      pageStream += headerRow(y);
      y -= headerHeight;
    }

    const row = rows[rowCursor];
    let x = MARGIN;
    // A light rule under each row keeps wide rows readable.
    pageStream += line(MARGIN, y - rowHeight, MARGIN + tableWidth, y - rowHeight, 0.25);
    for (let index = 0; index < widths.length; index += 1) {
      const width = widths[index];
      const lines = wrapWithin(String(row[index] ?? ''), fontSize, width - cellPadding * 2, maxLines);
      let lineY = y - cellPadding - fontSize;
      for (const text of lines) {
        pageStream += textRun(x + cellPadding, lineY, text, { size: fontSize });
        lineY -= leading;
      }
      x += width;
    }
    // Column rules.
    x = MARGIN;
    for (let index = 0; index < widths.length - 1; index += 1) {
      x += widths[index];
      pageStream += line(x, y, x, y - rowHeight, 0.25);
    }
    y -= rowHeight;
    rowCursor += 1;
  }

  if (rows.length > 0) {
    pageStream += rectStroke(MARGIN, y, tableWidth, startY - titleBlockHeight - y, 0.7);
  }

  // The footer block belongs to the last page the table produced.
  if (footer.length > 0) {
    if (y - footerBlockHeight < MARGIN) {
      pages.push(pageStream);
      pageStream = '';
      y = PAGE_HEIGHT - topMargin;
    } else {
      y -= 8;
    }
    for (const text of footer) {
      const isHeading = text === text.toUpperCase() && /[A-Z]/.test(text) && !text.includes('  ');
      const lines = wrapWithin(text, isHeading ? 7.5 : 7, tableWidth, 2);
      for (const lineText of lines) {
        pageStream += textRun(MARGIN, y - 8, lineText, { font: isHeading ? FONT_BOLD : FONT_REGULAR, size: isHeading ? 7.5 : 7 });
        y -= 11;
      }
      y -= 2;
    }
  }

  pages.push(pageStream);
  return pages;
}

/* -------------------------------------------------------------------------- *
 * Payload -> rows, shared with the workbook renderer.
 * -------------------------------------------------------------------------- */

function matrixDayCell(day) {
  return [day.dayLabel, day.shift, day.pgy].filter((part) => String(part ?? '').length > 0).join(' | ');
}

function cellText(cell) {
  if (cell.isLeaves) {
    if (cell.residents.length === 0) return 'No leave';
    return cell.residents.join(', ');
  }
  const names = cell.residents.length > 0 ? cell.residents.join(' & ') : 'Unassigned';
  return cell.faculty ? `${names} / ${cell.faculty}` : names;
}

function rosterResidentsText(cell, pgy) {
  if (cell.residents.length === 0) return 'Unassigned';
  return `${cell.residents.join(' & ')} / ${pgy}`;
}

/** The banner line the workbook prints on row 1, as one PDF title line. */
function payloadTitle(payload) {
  return [
    `Academic Year: ${payload.academicYear}`,
    `Cycle: ${payload.cycleNumber}`,
    `Week Start Date: ${payload.weekStartDate}`,
    `Week End Date: ${payload.weekEndDate}`,
    `Duration / Window: ${payload.durationLabel}`,
  ].join('  |  ');
}

function footerLines(payload) {
  const lines = ['BACKUP / CATCHUP FACULTY POOLS'];
  if ((payload.backupPools ?? []).length === 0) {
    lines.push('No backup faculty set yet.');
  } else {
    for (const pool of payload.backupPools) {
      lines.push(`${pool.day} catchup: ${pool.names.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('ROTATION WINDOW & RATIONALE');
  if (payload.rationale) lines.push(payload.rationale);
  else lines.push('-');
  return lines;
}

/* -------------------------------------------------------------------------- *
 * Public API.
 * -------------------------------------------------------------------------- */

/** The matrix view: one row per day, one column per clinic plus Leaves. */
function matrixPages(payload) {
  const dayLabel = (day) => {
    // The day column prints `Mon 12 Oct`, rebuilt here exactly as the workbook does.
    return day.dayLabel;
  };
  void dayLabel;

  const clinicColumns = payload.columns.filter((column) => !column.isLeaves);
  const headers = ['DAY / SHIFT & PGY', 'IN-CHARGE FACULTY', ...clinicColumns.map((c) => c.title), 'Leaves / Away'];
  const rows = (payload.days ?? []).map((day) => [
    matrixDayCell(day),
    day.inCharge ? `Faculty In-charge: ${day.inCharge}` : 'Faculty In-charge: Unassigned',
    ...day.cells.map(cellText),
  ]);

  const leftWidths = [104, 96];
  const remaining = PAGE_WIDTH - MARGIN * 2 - leftWidths[0] - leftWidths[1];
  const columnCount = headers.length - 2;
  const clinicWidth = Math.floor(remaining / columnCount);
  const widths = [...leftWidths, ...Array(columnCount).fill(clinicWidth)];
  widths[widths.length - 1] += remaining - clinicWidth * columnCount;

  return renderTable({
    headers,
    rows,
    widths,
    title: payloadTitle(payload),
    footer: footerLines(payload),
    fontSize: columnCount > 8 ? 6.5 : 7,
    maxLines: 4,
  });
}

/** The roster view: one row per day per clinic, in reading order. */
function rosterPages(payload) {
  const headers = ['Day / Time & Session', 'Clinic Slot', 'Resident(s) & PGY Level', 'Supervising Faculty'];
  const rows = [];
  for (const day of payload.days ?? []) {
    const session = [
      matrixDayCell(day),
      `Faculty In-charge: ${day.inCharge || 'Unassigned'}`,
    ].join(' | ');
    for (const cell of day.cells) {
      if (cell.isLeaves) {
        rows.push([
          session,
          cell.title,
          cell.residents.length > 0 ? cell.residents.join(', ') : 'No one away',
          cell.leaveTypes.length > 0 ? cell.leaveTypes.join(', ') : '-',
        ]);
        continue;
      }
      rows.push([
        session,
        cell.title,
        rosterResidentsText(cell, day.pgy),
        cell.faculty || 'Unassigned',
      ]);
    }
  }

  const widths = [236, 108, 246, PAGE_WIDTH - MARGIN * 2 - 236 - 108 - 246];
  return renderTable({
    headers,
    rows,
    widths,
    title: payloadTitle(payload),
    footer: footerLines(payload),
    fontSize: 7,
    maxLines: 3,
  });
}

/**
 * Assemble the page streams into a finished PDF file.
 *
 * @param {string[]} pages one content stream per page
 * @returns {Buffer}
 */
function assemblePdf(pages) {
  const objects = [];
  const add = (number, body) => objects.push({ number, body });

  const pageNumbers = pages.map((_, index) => 5 + index * 2);
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(
    2,
    `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  add(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  add(4, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);

  pages.forEach((stream, index) => {
    const contentNumber = 5 + index * 2;
    const pageNumber = contentNumber + 1;
    add(contentNumber, null); // content stream, written as a stream object below
    add(
      pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /${FONT_REGULAR} 3 0 R /${FONT_BOLD} 4 0 R >> >> ` +
        `/Contents ${contentNumber} 0 R >>`,
    );
    objects[objects.length - 2].stream = stream;
  });

  const chunks = [];
  let offset = 0;
  const push = (text) => {
    const buffer = Buffer.isBuffer(text) ? text : Buffer.from(text, 'latin1');
    chunks.push(buffer);
    offset += buffer.length;
    return buffer.length;
  };

  push('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = [];
  const maxNumber = objects.reduce((max, object) => Math.max(max, object.number), 0);
  for (let number = 1; number <= maxNumber; number += 1) {
    const object = objects.find((candidate) => candidate.number === number);
    offsets[number] = offset;
    if (!object) continue;
    if (object.stream != null) {
      const body = Buffer.from(object.stream, 'latin1');
      push(`${number} 0 obj\n<< /Length ${body.length} >>\nstream\n`);
      push(body);
      push('\nendstream\nendobj\n');
    } else {
      push(`${number} 0 obj\n${object.body}\nendobj\n`);
    }
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${maxNumber + 1}\n0000000000 65535 f \n`;
  for (let number = 1; number <= maxNumber; number += 1) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${maxNumber + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * Render a CCC payload as a PDF.
 *
 * @param {object} payload the `CccTemplatePayload`
 * @returns {Buffer}
 */
function buildCccPdf(payload) {
  const pages = payload.viewMode === 'roster' ? rosterPages(payload) : matrixPages(payload);
  return assemblePdf(pages);
}

module.exports = {
  buildCccPdf,
  textWidth,
  wrapText,
  toWinAnsi,
};
