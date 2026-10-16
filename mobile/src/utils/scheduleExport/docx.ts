import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type ITableCellOptions,
} from 'docx';

import { base64ToBytes } from './bytes';
import { normalizeHex, reportColumnCount, type ReportCell, type ReportModel } from './model';

/**
 * Word renderer.
 *
 * Word gets the same grid as the other formats, plus something the others
 * cannot offer well: a real table a department can annotate, and optional
 * sign-off lines for a printed copy. Generated with `docx` and packed in
 * memory — nothing is written to disk on the device.
 */

const HEADER_FILL = '0F2C45';
const BORDER_COLOR = 'CBD5E1';
const MUTED = '64748B';

/** `docx` wants bare hex (no `#`); the model stores `#RRGGBB`. */
function docxColor(value: string | undefined): string | undefined {
  const hex = normalizeHex(value);
  return hex ? hex.slice(1) : undefined;
}

function alignmentFor(
  align: ReportCell['align'],
  fallback: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT,
): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  if (align === 'left') return AlignmentType.LEFT;
  return fallback;
}

function buildCell(entry: ReportCell, isHeader: boolean): TableCell {
  const fill = isHeader ? HEADER_FILL : docxColor(entry.fill);
  const color = isHeader ? 'FFFFFF' : docxColor(entry.textColor);
  const options: ITableCellOptions = {
    verticalAlign: VerticalAlign.CENTER,
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    children: [
      new Paragraph({
        alignment: alignmentFor(entry.align, isHeader ? AlignmentType.CENTER : AlignmentType.LEFT),
        children: [
          new TextRun({
            text: entry.text,
            bold: isHeader || entry.bold,
            color,
            size: isHeader ? 17 : 16,
          }),
        ],
      }),
    ],
    ...(entry.colSpan && entry.colSpan > 1 ? { columnSpan: entry.colSpan } : {}),
  };
  return new TableCell(options);
}

function buildTable(report: ReportModel): Table {
  const columnCount = Math.max(1, reportColumnCount(report));
  // A4 minus 1in side margins, in twips — split evenly across the grid.
  const contentWidth = report.orientation === 'landscape' ? 14_880 : 9_960;
  const columnWidth = Math.floor(contentWidth / columnCount);

  const rows = report.rows.map(
    (row, index) =>
      new TableRow({
        tableHeader: index < report.headerRows,
        children: row.map((entry) => buildCell(entry, index < report.headerRows)),
      }),
  );

  const edge = { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: Array.from({ length: columnCount }, () => columnWidth),
    borders: {
      top: edge,
      bottom: edge,
      left: edge,
      right: edge,
      insideHorizontal: edge,
      insideVertical: edge,
    },
    rows,
  });
}

function headerParagraphs(report: ReportModel): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: 'MedResidency', bold: true, color: '12558C', size: 18, characterSpacing: 30 }),
      ],
    }),
    new Paragraph({
      spacing: { after: report.subtitle ? 40 : 120 },
      children: [new TextRun({ text: report.title, bold: true, size: 32 })],
    }),
  ];

  if (report.subtitle) {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: report.subtitle, color: MUTED, size: 20 })],
      }),
    );
  }

  for (const line of report.meta) {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [
          new TextRun({ text: `${line.label}: `, color: MUTED, size: 16 }),
          new TextRun({ text: line.value, bold: true, size: 16 }),
        ],
      }),
    );
  }

  paragraphs.push(new Paragraph({ text: '', spacing: { after: 80 } }));
  return paragraphs;
}

function legendParagraph(report: ReportModel): Paragraph[] {
  if (!report.legend || report.legend.length === 0) return [];
  const runs: TextRun[] = [];
  report.legend.forEach((entry, index) => {
    if (index > 0) runs.push(new TextRun({ text: '   ' }));
    runs.push(new TextRun({ text: '■ ', color: docxColor(entry.color), size: 16 }));
    runs.push(new TextRun({ text: `${entry.label}  `, color: MUTED, size: 16 }));
  });
  return [new Paragraph({ spacing: { before: 120 }, children: runs })];
}

function signatureParagraphs(report: ReportModel): Paragraph[] {
  if (!report.signatures || report.signatures.length === 0) return [];
  return report.signatures.map(
    (label) =>
      new Paragraph({
        spacing: { before: 320 },
        children: [
          new TextRun({ text: `${label}: `, size: 18 }),
          new TextRun({ text: '______________________________', size: 18 }),
          new TextRun({ text: '     Date: ', size: 18 }),
          new TextRun({ text: '________________', size: 18 }),
        ],
      }),
  );
}

function buildDocument(report: ReportModel): Document {
  return new Document({
    creator: 'MedResidency',
    title: report.title,
    description: report.subtitle,
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation:
                report.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
                    size: 14,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          ...headerParagraphs(report),
          buildTable(report),
          ...legendParagraph(report),
          ...signatureParagraphs(report),
        ],
      },
    ],
  });
}

/** Render a report as `.docx` bytes. */
export async function renderReportDocx(report: ReportModel): Promise<Uint8Array> {
  const base64 = await Packer.toBase64String(buildDocument(report));
  return base64ToBytes(base64);
}
