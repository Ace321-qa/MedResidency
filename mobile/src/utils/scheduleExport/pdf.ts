import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';

import { base64ToBytes, toBytes } from './bytes';
import {
  expandRowSpans,
  reportColumnCount,
  reportToHtml,
  type ReportCell,
  type ReportModel,
} from './model';

/**
 * PDF renderer.
 *
 * The document is drawn with **pdfmake**, on every platform. pdfmake's browser
 * bundle is pure JavaScript and produces a real vector PDF, so the same layout
 * object gives a coordinator the same file on iOS, Android and the web build —
 * including a true "Page X of Y" footer, which `expo-print` cannot express.
 *
 * On a device, if the pdfmake bundle cannot run for any reason, the renderer
 * falls back to `expo-print` rendering the same report's HTML: a slightly
 * different footer is a far better outcome than a failed download.
 */

let fontsRegistered = false;

/** Register the bundled Roboto face once, before the first document. */
function ensureFonts(): void {
  if (fontsRegistered) return;
  fontsRegistered = true;
  pdfMake.addVirtualFileSystem(pdfFonts as unknown as Record<string, string>);
  pdfMake.fonts = {
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  };
}

const GRID_LAYOUT = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => '#CBD5E1',
  vLineColor: () => '#CBD5E1',
  paddingLeft: () => 2,
  paddingRight: () => 2,
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

type PdfNode = Record<string, unknown>;

function cellToNode(entry: ReportCell): PdfNode {
  const node: PdfNode = { text: entry.text };
  if (entry.fill) node.fillColor = entry.fill;
  if (entry.textColor) node.color = entry.textColor;
  if (entry.bold) node.bold = true;
  if (entry.align) node.alignment = entry.align;
  if (entry.colSpan && entry.colSpan > 1) node.colSpan = entry.colSpan;
  return node;
}

function legendNodes(report: ReportModel): PdfNode[] {
  if (!report.legend || report.legend.length === 0) return [];
  const items = report.legend.map((entry) => ({
    width: 'auto',
    margin: [0, 0, 12, 0] as [number, number, number, number],
    columns: [
      {
        width: 8,
        canvas: [{ type: 'rect', x: 0, y: 0, w: 8, h: 8, color: entry.color, lineColor: '#CBD5E1' }],
      },
      { width: 3, text: ' ' },
      { width: 'auto', text: entry.label, fontSize: 7, color: '#475569' },
    ],
  }));
  return [{ columns: items, margin: [0, 6, 0, 0] as [number, number, number, number] }];
}

function buildDocDefinition(report: ReportModel): PdfNode {
  const columnCount = Math.max(1, reportColumnCount(report));
  // A handful of wide columns size to their content; a dense week-by-week grid
  // is instead forced to share the page width rather than overflow it. An
  // explicit array (not a single scalar) keeps `widths.length` in lock-step with
  // every expanded body row, which is the invariant pdfmake checks.
  const widths: unknown[] = new Array(columnCount).fill(columnCount > 16 ? '*' : 'auto');
  // Expand every row to exactly `columnCount` cells: a merged `colSpan` cell is
  // followed by its `N - 1` placeholders so no column index is ever undefined.
  const body = report.rows.map((row) => expandRowSpans(row, columnCount).map(cellToNode));

  const content: PdfNode[] = [
    { text: 'MedResidency', fontSize: 9, bold: true, color: '#12558C', characterSpacing: 1.5 },
    { text: report.title, fontSize: 15, bold: true, margin: [0, 2, 0, 1] },
  ];
  if (report.subtitle) content.push({ text: report.subtitle, fontSize: 10, color: '#475569' });
  if (report.meta.length > 0) {
    content.push({
      margin: [0, 4, 0, 4],
      stack: report.meta.map((line) => ({
        text: [
          { text: `${line.label}: `, color: '#64748B' },
          { text: line.value, bold: true },
        ],
        fontSize: 8,
        margin: [0, 1, 0, 0],
      })),
    });
  }
  content.push({
    table: {
      headerRows: report.headerRows,
      widths,
      body,
      dontBreakRows: true,
    },
    layout: { ...GRID_LAYOUT },
  });
  content.push(...legendNodes(report));

  return {
    pageSize: 'A4',
    pageOrientation: report.orientation,
    pageMargins: [18, 18, 18, 30],
    defaultStyle: { font: 'Roboto', fontSize: 8 },
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: `MedResidency · ${report.title}`, fontSize: 7, color: '#94A3B8' },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: '#64748B', alignment: 'right' },
      ],
      margin: [18, 4, 18, 0],
    }),
    content,
  };
}

async function renderWithPdfMake(report: ReportModel): Promise<Uint8Array> {
  ensureFonts();
  const buffer = await pdfMake.createPdf(buildDocDefinition(report)).getBuffer();
  return toBytes(buffer as unknown as Uint8Array);
}

/** Native safety net: render the same report's HTML through `expo-print`. */
async function renderWithExpoPrint(report: ReportModel): Promise<Uint8Array> {
  const Print = await import('expo-print');
  const result = await Print.printToFileAsync({ html: reportToHtml(report), base64: true });
  if (result.base64) return base64ToBytes(result.base64);
  const FileSystem = await import('expo-file-system');
  const file = new FileSystem.File(result.uri);
  return toBytes(await file.bytes());
}

/**
 * Render a report as PDF bytes.
 *
 * pdfmake first; on a device, `expo-print` is the fallback. On the web build a
 * pdfmake failure propagates, because there is no HTML-to-PDF fallback there.
 */
export async function renderReportPdf(report: ReportModel): Promise<Uint8Array> {
  try {
    return await renderWithPdfMake(report);
  } catch (error) {
    // On the web build there is no HTML-to-PDF fallback, so surface the failure;
    // on a device, `expo-print` renders the same report through a WebView.
    if (typeof document !== 'undefined') throw error;
    return renderWithExpoPrint(report);
  }
}
