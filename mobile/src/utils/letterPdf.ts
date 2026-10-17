import { Platform } from 'react-native';

import * as FileSystem from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { formatDate, formatDateRange, formatTime } from './format';
import { parseLetterBody, type LetterBlock } from './letterPreview';
import type { SavedFile } from './fileSave';
import type { ReleaseLetter } from '../types/api';

/**
 * Renders a generated release letter to a PDF the resident can keep or send.
 *
 * The web *screen* already shows the letter, but a screenshot is not a letter —
 * a hospital department wants a document. This turns the same parsed blocks the
 * preview uses into a printable page, so what is downloaded matches what was
 * read, down to the unresolved `{{TOKEN}}` fields, which stay highlighted rather
 * than silently blanked.
 *
 * Two platforms, two endings, same as `fileSave`:
 *
 *  - **Native** rasterises the HTML through the OS print engine with
 *    `Print.printToFileAsync`, moves the temporary PDF to a meaningful filename,
 *    and hands it to the share sheet.
 *  - **Web** has no file system to write a PDF into (the web build of
 *    `expo-print` only calls `window.print()`), so the letter opens in a print
 *    window where "Save as PDF" is the browser's own destination.
 *
 * The letterhead is inlined and self-contained: no external fonts, images or
 * stylesheets, because the render runs offline and anything fetched might not be
 * there when it matters.
 */

/** One `Label` / `Value` pair in the letterhead table. */
interface MetaRow {
  label: string;
  value: string;
}

/** A filename-safe stem from the letter's subject or resident name. */
function letterFileName(letter: ReleaseLetter): string {
  const stem = (letter.letter_subject || `Release letter ${letter.resident_name}`)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || 'release-letter'}.pdf`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `{{TOKEN}}` runs become a highlighted `<mark>`; everything else is escaped. */
function inlineHtml(text: string): string {
  const parts = text.split(/(\{\{\s*[A-Z0-9_]+\s*\}\})/g);
  return parts
    .map((part) => {
      const match = /^\{\{\s*([A-Z0-9_]+)\s*\}\}$/.exec(part);
      if (match) {
        const label = match[1].replace(/_/g, ' ').toLowerCase();
        return `<mark class="unresolved">${escapeHtml(label)}</mark>`;
      }
      return escapeHtml(part);
    })
    .join('');
}

function blockHtml(block: LetterBlock): string {
  if (block.kind === 'fields' && block.rows) {
    const rows = block.rows
      .map(
        (row) =>
          `<tr><th>${escapeHtml(row.label)}</th><td>${inlineHtml(row.value)}</td></tr>`,
      )
      .join('');
    return `<table class="fields">${rows}</table>`;
  }

  const text = block.spans.map((span) => span.text).join('');
  if (block.kind === 'heading') return `<h2 class="block heading">${inlineHtml(text)}</h2>`;
  if (block.kind === 'salutation') return `<p class="block salutation">${inlineHtml(text)}</p>`;
  if (block.kind === 'closing' || block.kind === 'signature') {
    return `<p class="block closing">${inlineHtml(text)}</p>`;
  }
  return `<p class="block">${inlineHtml(text)}</p>`;
}

/**
 * The letterhead: who it is about, who it is addressed to, and the release
 * window — everything a department head needs to place the letter without
 * reading it twice. Rows with no value are dropped rather than shown blank.
 */
function metaRows(letter: ReleaseLetter): MetaRow[] {
  const rows: MetaRow[] = [
    { label: 'Date issued', value: formatDate(letter.letter_issue_date ?? letter.created_at) },
    { label: 'To', value: letter.recipient_dept_head },
    { label: 'Department', value: letter.hospital_department_name ?? '' },
    { label: 'Resident', value: letter.resident_name },
    { label: 'Program', value: letter.program_name ?? letter.specialty_name ?? '' },
    {
      label: 'Release window',
      value: formatDateRange(letter.release_start_date, letter.release_end_date),
    },
  ];

  const schedule = [letter.day_of_week, letter.start_time ? formatTime(letter.start_time) : '']
    .filter(Boolean)
    .join(' · ');
  if (schedule) rows.push({ label: 'Weekly schedule', value: schedule });

  const site = [letter.clinic_name ?? letter.rotation_name, letter.site_name]
    .filter(Boolean)
    .join(' · ');
  if (site) rows.push({ label: 'Release to', value: site });

  // The destination preceptor wins: `supervising_faculty` mirrors it for older
  // rows, but when the two ever disagree the receiving hospital's own record is
  // the one the letter is citing.
  const supervisor =
    letter.destination_supervising_faculty ??
    letter.supervising_faculty ??
    letter.supervisor_name;
  if (supervisor) rows.push({ label: 'Destination supervisor', value: supervisor });

  if (letter.program_director_name) {
    rows.push({ label: 'Program director', value: letter.program_director_name });
  }
  if (letter.coordinator_name) {
    rows.push({ label: 'Coordinator', value: letter.coordinator_name });
  }

  return rows.filter((row) => row.value.trim().length > 0);
}

/** The complete, self-contained HTML document for one letter. */
export function letterHtml(letter: ReleaseLetter): string {
  const blocks = parseLetterBody(letter.generated_letter_body);
  const rows = metaRows(letter)
    .map(
      (row) =>
        `<div class="meta-row"><span class="meta-label">${escapeHtml(row.label)}</span><span class="meta-value">${escapeHtml(row.value)}</span></div>`,
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(letterFileName(letter).replace(/\.pdf$/, ''))}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #1a2233;
    margin: 0;
    padding: 48px 56px;
    font-size: 14px;
    line-height: 1.6;
  }
  .letterhead { border-bottom: 2px solid #1f3a63; padding-bottom: 16px; margin-bottom: 24px; }
  .institution { font-size: 16px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: #1f3a63; }
  .letterhead-sub { font-size: 12px; color: #5b6b83; margin-top: 2px; }
  h1.subject { font-size: 20px; line-height: 1.3; margin: 20px 0 4px; }
  .meta { margin: 20px 0 28px; border: 1px solid #d7deea; border-radius: 8px; padding: 12px 16px; }
  .meta-row { display: flex; gap: 12px; padding: 3px 0; }
  .meta-label { flex: 0 0 150px; color: #5b6b83; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  .meta-value { flex: 1; font-weight: 500; }
  h2.block.heading { font-size: 15px; margin: 18px 0 6px; }
  p.block { margin: 0 0 12px; }
  p.salutation, p.closing { margin: 0 0 12px; }
  table.fields { border-collapse: collapse; margin: 0 0 14px; }
  table.fields th { text-align: left; color: #5b6b83; font-weight: 500; padding: 2px 16px 2px 0; vertical-align: top; }
  table.fields td { padding: 2px 0; }
  mark.unresolved { background: #fdf0d5; color: #8a5a00; font-weight: 700; border-radius: 3px; padding: 0 4px; }
  .footer { margin-top: 36px; border-top: 1px solid #d7deea; padding-top: 10px; font-size: 11px; color: #5b6b83; }
</style>
</head>
<body>
  <div class="letterhead">
    <div class="institution">${escapeHtml(letter.institution_name ?? 'Residency Program')}</div>
    <div class="letterhead-sub">Official Release &amp; Rotation Letter</div>
  </div>

  <h1 class="subject">${inlineHtml(letter.letter_subject)}</h1>
  <div class="meta">${rows}</div>

  ${blocks.map(blockHtml).join('\n  ') || '<p class="block">This letter has no body text yet.</p>'}

  <div class="footer">
    Issued via the residency management system on ${escapeHtml(formatDate(letter.letter_issue_date ?? letter.created_at))}.
  </div>
</body>
</html>`;
}

/**
 * Build the PDF and hand it to the platform's save/share path.
 *
 * Returns the same `SavedFile` shape as `fileSave`, so callers share one
 * confirmation UI. On web nothing is written — the browser's print dialog is the
 * save step — so the returned `uri` is empty and `via` is `browser-download`.
 */
export async function downloadLetterPdf(letter: ReleaseLetter): Promise<SavedFile> {
  const fileName = letterFileName(letter);
  const html = letterHtml(letter);

  if (Platform.OS === 'web') {
    return printOnWeb(fileName, html);
  }
  return printOnDevice(fileName, html);
}

function printOnWeb(fileName: string, html: string): SavedFile {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    throw new Error('Allow pop-ups for this site to download the letter as a PDF.');
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  // The styles are inline and there are no images to wait for, but the print
  // dialog opens blank if it is called before the document has laid out.
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 250);

  return { fileName, uri: '', via: 'browser-download' };
}

async function printOnDevice(fileName: string, html: string): Promise<SavedFile> {
  const { uri } = await Print.printToFileAsync({ html });

  // printToFileAsync always writes into the cache with a random name; give the
  // file the letter's name so the share sheet offers something recognisable.
  const destination = new FileSystem.File(FileSystem.Paths.cache, fileName);
  if (destination.exists) destination.delete();
  await new FileSystem.File(uri).move(destination);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(destination.uri, {
      mimeType: 'application/pdf',
      dialogTitle: fileName,
      UTI: 'com.adobe.pdf',
    });
    return { fileName, uri: destination.uri, via: 'share-sheet' };
  }

  return { fileName, uri: destination.uri, via: 'saved-to-app-cache' };
}
