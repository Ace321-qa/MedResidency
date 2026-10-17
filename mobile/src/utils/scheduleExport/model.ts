/**
 * The schedule report model: one description of a table that every export
 * format renders.
 *
 * The Master Rotation Grid and the CCC matrix each build one `ReportModel` from
 * data they already hold. Excel (server-side), PDF (pdfmake), Word (docx) and the
 * on-screen image view all read that same model, so the four files a coordinator
 * downloads can never disagree about what the schedule says — the failure mode a
 * per-format builder invites.
 *
 * This module is deliberately dependency-free (no React, no React Native, no
 * renderer libraries) so it can be unit-checked under plain `node` and imported
 * from a screen without dragging a renderer into the bundle.
 */

export type ReportAlign = 'left' | 'center' | 'right';

export interface ReportCell {
  text: string;
  /** Solid background, `#RRGGBB`. Used to colour-code rotation cells. */
  fill?: string;
  /** Text colour, `#RRGGBB`. */
  textColor?: string;
  bold?: boolean;
  align?: ReportAlign;
  /** How many columns this cell spans (a merged "Block 3" heading spans four). */
  colSpan?: number;
  /**
   * A header cell whose text should run top-to-bottom rather than across.
   *
   * The weekly sub-columns carry a date window (`28/06–04/07`) far wider than
   * their column, so a raster/HTML renderer paints the run rotated — the same
   * orientation the on-screen matrix uses. Excel, PDF and Word ignore the flag:
   * they size the column (or wrap the text) instead, which is the natural way
   * each of those formats keeps the full string visible.
   */
  vertical?: boolean;
}

export interface ReportColumn {
  /** Column heading, shown when the report has no explicit heading row. */
  header?: string;
  /** Width in points, for PDF/Excel column sizing. */
  width?: number;
  align?: ReportAlign;
}

export interface ReportMetaLine {
  label: string;
  value: string;
}

export interface ReportLegendEntry {
  label: string;
  color: string;
}

export interface ReportModel {
  /** Name without extension; the engine appends the right one per format. */
  fileName: string;
  /** Excel sheet name (Excel caps this at 31 characters). */
  sheetName: string;
  title: string;
  subtitle?: string;
  meta: ReportMetaLine[];
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** Leading `rows` that are headings and should repeat across page breaks. */
  headerRows: number;
  legend?: ReportLegendEntry[];
  orientation: 'landscape' | 'portrait';
  /** Docx-only: labelled sign-off blocks printed beneath the table. */
  signatures?: string[];
}

/** A plain text cell, the common case. */
export function cell(
  text: string | number | null | undefined,
  options: Omit<ReportCell, 'text'> = {},
): ReportCell {
  return { text: text === null || text === undefined ? '' : String(text), ...options };
}

/** A coloured data cell, for the rotation-biased grids. */
export function coloredCell(
  text: string | number | null | undefined,
  fill: string | undefined,
  textColor: string | undefined,
  options: Omit<ReportCell, 'text' | 'fill' | 'textColor'> = {},
): ReportCell {
  return {
    text: text === null || text === undefined ? '' : String(text),
    fill,
    textColor,
    ...options,
  };
}

/** A merged heading cell spanning `span` columns. */
export function spanningCell(
  text: string | number | null | undefined,
  span: number,
  options: Omit<ReportCell, 'text' | 'colSpan'> = {},
): ReportCell {
  return { text: text === null || text === undefined ? '' : String(text), colSpan: Math.max(1, span), ...options };
}

/** How many columns a row occupies, counting spans. */
export function rowColumnCount(row: ReportCell[]): number {
  return row.reduce((total, entry) => total + Math.max(1, entry.colSpan ?? 1), 0);
}

/** The widest row/column count a report describes, counting spans. */
export function reportColumnCount(report: Pick<ReportModel, 'columns' | 'rows'>): number {
  const widestRow = report.rows.reduce((widest, row) => Math.max(widest, rowColumnCount(row)), 0);
  return Math.max(report.columns.length, widestRow);
}

/** True when the report has anything worth rendering. */
export function isRenderableReport(report: ReportModel | null | undefined): report is ReportModel {
  return Boolean(report && Array.isArray(report.rows) && report.rows.length > 0);
}

/**
 * Expand one row so it holds exactly `columnCount` cells, the form pdfmake
 * requires.
 *
 * A merged heading is written once in the model (`colSpan: 4`), which ExcelJS
 * and Word understand directly — they merge *from* a single leading cell. pdfmake
 * is stricter: it indexes every column position of every row, so a `colSpan: N`
 * cell must be followed by `N - 1` placeholders, otherwise the columns it covers
 * evaluate to `undefined` and pdfmake throws "Malformed table row, a cell is
 * undefined". This turns `[Day, catchup(colSpan 3)]` into
 * `[Day, catchup, {}, {}]`, and pads any genuinely short trailing row to the
 * full width as well.
 */
export function expandRowSpans(row: ReportCell[], columnCount: number): ReportCell[] {
  const width = Math.max(1, columnCount);
  const expanded: ReportCell[] = [];
  for (const entry of row) {
    expanded.push(entry);
    const span = Math.max(1, entry.colSpan ?? 1);
    for (let filled = 1; filled < span && expanded.length < width; filled += 1) {
      expanded.push({ text: '' });
    }
  }
  while (expanded.length < width) expanded.push({ text: '' });
  return expanded;
}

/** `#RRGGBB`/`#RGB` normalised to upper-case, or undefined when unreadable. */
export function normalizeHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [r, g, b] = hex;
    return `#${(r + r + g + g + b + b).toUpperCase()}`;
  }
  return undefined;
}

/** Escape text for safe insertion into the exported HTML. */
export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The institutional header band: brand, title, subtitle and the meta list. */
function renderHeaderBand(report: ReportModel): string {
  const parts: string[] = ['<header class="report-header">'];
  parts.push('<p class="brand">MedResidency</p>');
  parts.push(`<h1>${escapeHtml(report.title)}</h1>`);
  if (report.subtitle) parts.push(`<p class="subtitle">${escapeHtml(report.subtitle)}</p>`);
  if (report.meta.length > 0) {
    parts.push('<dl class="meta">');
    for (const line of report.meta) {
      parts.push(`<div><dt>${escapeHtml(line.label)}</dt><dd>${escapeHtml(line.value)}</dd></div>`);
    }
    parts.push('</dl>');
  }
  return `${parts.join('')}</header>`;
}

/**
 * Serialise a report to a self-contained HTML document.
 *
 * Used for the native `expo-print` PDF fallback, and available to any web canvas
 * path. It mirrors the pdfmake layout (institutional header band, bordered grid,
 * shaded header rows) so the two renderers stay visually close.
 */
export function reportToHtml(report: ReportModel): string {
  const rows: string[] = [];
  report.rows.forEach((row, rowIndex) => {
    const isHeader = rowIndex < report.headerRows;
    const cells = row
      .map((entry) => {
        const styles: string[] = [];
        if (entry.fill) styles.push(`background:${entry.fill}`);
        if (entry.textColor) styles.push(`color:${entry.textColor}`);
        if (entry.bold || isHeader) styles.push('font-weight:700');
        if (entry.align) styles.push(`text-align:${entry.align}`);
        const spanAttr = entry.colSpan && entry.colSpan > 1 ? ` colspan="${entry.colSpan}"` : '';
        const classes = [isHeader ? 'head' : '', entry.vertical ? 'vertical' : ''].filter(Boolean).join(' ');
        return `<td class="${classes}" style="${styles.join(';')}"${spanAttr}>${escapeHtml(
          entry.text,
        )}</td>`;
      })
      .join('');
    rows.push(`<tr>${cells}</tr>`);
  });

  const legend =
    report.legend && report.legend.length > 0
      ? `<div class="legend">${report.legend
          .map(
            (entry) =>
              `<span class="legend-item"><i style="background:${entry.color}"></i>${escapeHtml(entry.label)}</span>`,
          )
          .join('')}</div>`
      : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: ${report.orientation}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; }
  .report-header { border-bottom: 3px solid #0f2c45; padding-bottom: 8px; margin-bottom: 12px; }
  .brand { color: #12558c; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
  h1 { font-size: 18px; margin: 4px 0; }
  .subtitle { margin: 0; color: #475569; font-size: 12px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 24px; margin: 8px 0 0; }
  .meta div { display: flex; gap: 6px; font-size: 11px; }
  .meta dt { color: #64748b; }
  .meta dd { margin: 0; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  td { border: 1px solid #cbd5e1; padding: 3px 5px; font-size: 9px; vertical-align: top; white-space: pre-line; }
  td.head { background: #0f2c45; color: #ffffff; text-align: center; }
  /* A rotated date header reads top-to-bottom so a full week window fits a
     column too narrow to hold it horizontally, matching the on-screen matrix. */
  td.vertical { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; text-transform: uppercase; }
  .legend { margin-top: 10px; font-size: 10px; color: #475569; display: flex; flex-wrap: wrap; gap: 12px; }
  .legend-item { display: inline-flex; align-items: center; gap: 4px; }
  .legend-item i { width: 10px; height: 10px; display: inline-block; border: 1px solid #cbd5e1; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
${renderHeaderBand(report)}
<table>${rows.join('')}</table>
${legend}
</body>
</html>`;
}
