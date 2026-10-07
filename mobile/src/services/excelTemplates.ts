import * as DocumentPicker from 'expo-document-picker';

import { API_BASE_URL } from '../config/env';
import { buildXlsx, type XlsxCellValue } from '../utils/xlsx';
import { saveSpreadsheet, type SavedFile } from '../utils/fileSave';

/**
 * Excel templates: download, pick, upload.
 *
 * The rule this module exists to enforce: **pressing "Download" always ends
 * with a real .xlsx on the user's disk.** The API is asked for the file first,
 * because the server's template is the one the import endpoint will parse — but
 * if the API is unreachable, timing out or answering with an error page, the
 * same workbook is built locally instead. A dead backend must never turn into a
 * dead button.
 *
 * Uploads go the other way: the file is picked once and POSTed as multipart
 * form data, and whatever the server says about the rows is flattened into
 * sentences the screen can render in an inline banner — "Row 4: Corporate ID is
 * required" — rather than a JSON blob nobody can read.
 */

/** The four workbooks this app hands out. */
export type TemplateKind = 'roster' | 'master' | 'ccc' | 'timesheet';

export interface TemplateSpec {
  fileName: string;
  /** API path serving the same workbook, or `null` when there is no endpoint. */
  endpoint: string | null;
  sheetName: string;
  rows: XlsxCellValue[][];
}

export const ROSTER_COLUMNS = [
  'First Name',
  'Middle Name',
  'Last Name',
  'Corporate ID',
  'PGY Level',
  'Email',
  'Mobile',
  'Training Site',
  'Start Date (YYYY-MM-DD)',
  'Expected Completion Date (YYYY-MM-DD)',
] as const;

/** Thirteen block columns, because the cohort grid reserves all of them. */
const MASTER_COLUMNS: XlsxCellValue[] = [
  'Resident Corporate ID',
  'Resident Name',
  ...Array.from({ length: 13 }, (_, index) => `Block ${index + 1}`),
];

const CCC_ROWS: XlsxCellValue[][] = [
  ['Academic Day / Clinic', 'Resident Pairings', 'Faculty Leads', 'Catchup Pools'],
]

export const ATTENDANCE_STATUSES_FOR_TEMPLATE = [
  'PRESENT',
  'ON_CALL',
  'ABSENT',
  'SICK_LEAVE',
  'ANNUAL_LEAVE',
  'ACADEMIC_LEAVE',
] as const;

const TEMPLATES: Record<TemplateKind, TemplateSpec> = {
  roster: {
    fileName: 'roster_template.xlsx',
    endpoint: '/roster/template',
    sheetName: 'Roster',
    rows: [
      [...ROSTER_COLUMNS],
      [
        'Amina',
        'K',
        'Hassan',
        'EMP-100234',
        1,
        'amina.hassan@example.org',
        '+971500000001',
        'Central Hospital',
        '2026-07-01',
        '2029-06-30',
      ],
    ],
  },
  master: {
    fileName: 'master_grid_template.xlsx',
    endpoint: '/rotations/import/master/template',
    sheetName: 'Master Grid',
    rows: [
      MASTER_COLUMNS,
      ['', '', ...emptyMasterRow()],
    ],
  },
  ccc: {
    fileName: 'ccc_matrix_template.xlsx',
    endpoint: '/rotations/import/ccc/template',
    sheetName: 'CCC Matrix',
    rows: CCC_ROWS,
  },
  timesheet: {
    fileName: 'monthly_timesheet_template.xlsx',
    endpoint: '/attendance/template',
    sheetName: 'Timesheet',
    rows: [
      [
        'Shift Date (YYYY-MM-DD)',
        'Attendance Status',
        'Clock In (YYYY-MM-DD HH:MM:SS)',
        'Clock Out (YYYY-MM-DD HH:MM:SS)',
        'Total Hours',
        'Notes',
      ],
      ['2026-10-01', 'PRESENT', '2026-10-01 08:00:00', '2026-10-01 17:00:00', 8, 'Regular day shift'],
      ['2026-10-02', 'ON_CALL', '2026-10-02 08:00:00', '2026-10-03 08:00:00', 24, 'Continuous duty'],
      ['2026-10-03', 'ANNUAL_LEAVE', '', '', 0, 'Approved annual leave'],
    ],
  },
};

/** Thirteen blank block cells, so the row is visible as a filled-in row shape. */
function emptyMasterRow(): XlsxCellValue[] {
  return Array.from({ length: 13 }, () => '');
}

export function templateSpec(kind: TemplateKind): TemplateSpec {
  return TEMPLATES[kind];
}

export interface DownloadOutcome extends SavedFile {
  /** Where the bytes came from. `device` means the API was bypassed. */
  source: 'server' | 'device';
}

/**
 * Download one template and save it through `saveSpreadsheet`.
 *
 * The API gets a short deadline on purpose: this button is pressed *because*
 * something else is not working, and a 15-second spinner before a local
 * fallback would defeat the point of having one.
 */
export async function downloadTemplate(kind: TemplateKind): Promise<DownloadOutcome> {
  const spec = TEMPLATES[kind];
  const fromServer = spec.endpoint ? await fetchTemplateBytes(spec.endpoint) : null;

  const bytes = fromServer ?? buildXlsx(spec.rows, spec.sheetName);
  const saved = await saveSpreadsheet(spec.fileName, bytes);

  return { ...saved, source: fromServer ? 'server' : 'device' };
}

async function fetchTemplateBytes(endpoint: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, { signal: controller.signal });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    // An error body or an empty reply is not a workbook; treat it as absence.
    if (buffer.byteLength < 100) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- upload ----------------------------------------------------------------

/** One row-level complaint, already formatted for a banner. */
export interface ImportIssue {
  row?: number;
  field?: string;
  message: string;
}

export interface ImportOutcome {
  success: boolean;
  /** `Row 4: Corporate ID is required` — the exact wording shown to the user. */
  issues: string[];
  /** Short sentence for a successful import. */
  summary?: string;
  /** True when the API could not be reached at all, so the problem is the connection. */
  unreachable?: boolean;
}

/** Pick a spreadsheet off the device, or `null` when the picker was cancelled. */
export async function pickSpreadsheet(): Promise<DocumentPicker.DocumentPickerAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream',
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || result.assets.length === 0) return null;
  return result.assets[0];
}

/**
 * POST a picked file to `endpoint`, with extra form fields (`program_id`, …).
 *
 * Failures are never thrown at the screen as a raw error: the server's
 * `{ row, field, message }` array is flattened into sentences, and a rejected
 * network call becomes a single `unreachable` issue so the banner can say the
 * API is down instead of printing `Network request failed`.
 */
export async function uploadSpreadsheet(
  endpoint: string,
  file: DocumentPicker.DocumentPickerAsset,
  fields: Record<string, string | number> = {},
): Promise<ImportOutcome> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  form.append('file', file as unknown as Blob);

  let body: any;
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, { method: 'POST', body: form });
    body = await response.json().catch(() => null);
    if (!body) {
      return { success: false, issues: ['The server returned a response that was not JSON.'], unreachable: true };
    }
  } catch {
    return {
      success: false,
      issues: [`Could not reach ${API_BASE_URL.replace(/^https?:\/\//, '')} — check the API address in Settings.`],
      unreachable: true,
    };
  }

  if (body.success === true) {
    const count = body.added?.length ?? body.updated ?? body.count;
    return {
      success: true,
      issues: [],
      summary: typeof count === 'number' ? `${count} row${count === 1 ? '' : 's'} imported.` : 'Import complete.',
    };
  }

  return { success: false, issues: flattenIssues(body) };
}

/** Turn every error shape the API emits into `Row N: field message` sentences. */
export function flattenIssues(body: any): string[] {
  const issues: ImportIssue[] = [];

  const raw: any[] = Array.isArray(body?.errors)
    ? body.errors
    : Array.isArray(body?.issues)
      ? body.issues
      : [];

  for (const entry of raw) {
    if (typeof entry === 'string') {
      issues.push({ message: entry });
      continue;
    }
    issues.push({
      row: typeof entry.row === 'number' ? entry.row : entry.row !== undefined ? Number(entry.row) : undefined,
      field: entry.field ?? entry.column ?? undefined,
      message: entry.message ?? entry.error ?? 'is invalid',
    });
  }

  if (issues.length === 0 && (body?.error || body?.message)) {
    issues.push({ message: String(body.error ?? body.message) });
  }

  const sentences = issues.map((issue) => {
    const where = Number.isFinite(issue.row) ? `Row ${issue.row}: ` : '';
    const what = issue.field ? `${issue.field} ${issue.message}` : issue.message;
    return `${where}${what}`;
  });

  return sentences.length > 0 ? sentences : ['The file was rejected for an unknown reason.'];
}

// Convenience wrappers, so a screen names the workbook it cares about.

export const downloadRosterTemplate = () => downloadTemplate('roster');
export const downloadMasterGridTemplate = () => downloadTemplate('master');
export const downloadCccTemplate = () => downloadTemplate('ccc');
export const downloadMonthlyTimesheetTemplate = () => downloadTemplate('timesheet');

export const uploadRoster = (file: DocumentPicker.DocumentPickerAsset, programId?: number) =>
  uploadSpreadsheet('/roster/import', file, programId ? { program_id: programId } : {});

export const uploadMasterGrid = (
  file: DocumentPicker.DocumentPickerAsset,
  fields: { program_id: number; academic_year: string },
) => uploadSpreadsheet('/rotations/import/master', file, fields);

export const uploadCccMatrix = (
  file: DocumentPicker.DocumentPickerAsset,
  fields: { program_id: number; academic_year: string },
) => uploadSpreadsheet('/rotations/import/ccc', file, fields);

export const uploadTimesheet = (file: DocumentPicker.DocumentPickerAsset, residentId: number) =>
  uploadSpreadsheet('/attendance/import', file, { resident_id: residentId });
