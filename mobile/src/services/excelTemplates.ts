import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

import { API_BASE_URL } from '../config/env';
import { buildXlsx, type XlsxCellValue } from '../utils/xlsx';
import { saveSpreadsheet, type SavedFile } from '../utils/fileSave';
import { allWeeks, formatDmy, MASTER_GRID_START } from '../utils/masterGridCalendar';

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

/** The six workbooks this app hands out. */
export type TemplateKind = 'roster' | 'master' | 'ccc' | 'timesheet' | 'catalogue' | 'faculty';

export interface TemplateSpec {
  fileName: string;
  /** API path serving the same workbook, or `null` when there is no endpoint. */
  endpoint: string | null;
  sheetName: string;
  rows: XlsxCellValue[][];
  merges?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
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

/** The rotation catalogue's three columns, in the order the API parses them. */
export const CATALOGUE_COLUMNS = [
  'Full Rotation Name',
  'Hospital Department',
  'Abbreviation',
] as const;

/**
 * The faculty preceptor workbook's five columns, in the order the API parses
 * them. `src/utils/excel/faculty.js` builds the same header strings, so a sheet
 * made on this device and one downloaded from the API are the same file.
 */
export const FACULTY_COLUMNS = [
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Specialty',
] as const;

/** The three realistic rows the server's template ships. */
const FACULTY_SAMPLE_ROWS: XlsxCellValue[][] = [
  ['Hassan', 'Al-Hussein', 'hassan.alhussein@hamad.qa', '+974 4439 1111', 'Family Medicine'],
  ['Areen', 'Al-Mansouri', 'areen.almansouri@hamad.qa', '+974 4439 2222', 'Family Medicine'],
  ['Omar', 'Siddiqui', 'omar.siddiqui@hamad.qa', '+974 4439 3333', 'Internal Medicine'],
];

/**
 * Sample catalogue rows — identical to the ones `src/utils/excel/catalogue.js`
 * ships, so a workbook built on this device and one downloaded from the API
 * are the same file as far as the import is concerned. They are real rotations
 * rather than placeholders: importing the untouched template gives a new
 * programme five usable rows, and importing it twice upserts the same five.
 */
const CATALOGUE_SAMPLE_ROWS: XlsxCellValue[][] = [
  ['Continuity Clinic', 'Primary Health Care', 'PHC'],
  ['Inpatient Medicine', 'Internal Medicine', 'MED-INP'],
  ['General Surgery Inpatient', 'Department of Surgery', 'SURG-INP'],
  ['Pediatrics Outpatient', 'Pediatrics', 'PEDS-OPD'],
  ['Emergency Department', 'Emergency Medicine', 'EMERG-OPD'],
];

/**
 * The Continuity of Care Clinics (CCC) matrix workbook's header row.
 *
 * The offline copy built on this device must match the one the API serves
 * (`src/utils/excel/grid.js`): the importer reads the first sheet and matches
 * these columns by name, so the header strings are a format contract.
 */
const PRIMARY_CARE_CLINICS_ROWS: XlsxCellValue[][] = [
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
  catalogue: {
    fileName: 'rotations_catalogue_template.xlsx',
    endpoint: '/rotations/catalogue/template',
    sheetName: 'Rotations',
    rows: [[...CATALOGUE_COLUMNS], ...CATALOGUE_SAMPLE_ROWS],
  },
  faculty: {
    fileName: 'faculty_preceptors_template.xlsx',
    endpoint: '/longitudinal/faculty-supervisors/template',
    sheetName: 'Faculty',
    rows: [[...FACULTY_COLUMNS], ...FACULTY_SAMPLE_ROWS],
  },
  master: {
    fileName: 'master_grid_template.xlsx',
    endpoint: '/rotations/import/master/template',
    sheetName: 'Master Grid',
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 2, c: 0 } },
      { s: { r: 0, c: 1 }, e: { r: 2, c: 1 } },
      { s: { r: 0, c: 2 }, e: { r: 2, c: 2 } },
      { s: { r: 0, c: 3 }, e: { r: 2, c: 3 } },
      { s: { r: 0, c: 4 }, e: { r: 2, c: 4 } },
      { s: { r: 0, c: 5 }, e: { r: 0, c: 8 } },
      { s: { r: 0, c: 9 }, e: { r: 0, c: 12 } },
      { s: { r: 0, c: 13 }, e: { r: 0, c: 16 } },
      { s: { r: 0, c: 17 }, e: { r: 0, c: 20 } },
      { s: { r: 0, c: 21 }, e: { r: 0, c: 24 } },
      { s: { r: 0, c: 25 }, e: { r: 0, c: 28 } },
      { s: { r: 0, c: 29 }, e: { r: 0, c: 32 } },
      { s: { r: 0, c: 33 }, e: { r: 0, c: 36 } },
      { s: { r: 0, c: 37 }, e: { r: 0, c: 40 } },
      { s: { r: 0, c: 41 }, e: { r: 0, c: 44 } },
      { s: { r: 0, c: 45 }, e: { r: 0, c: 48 } },
      { s: { r: 0, c: 49 }, e: { r: 0, c: 52 } },
      { s: { r: 0, c: 53 }, e: { r: 0, c: 56 } },
    ],
    rows: [
      [
        'Resident Level',
        'Resident Name',
        'Corp. ID',
        'Mobile',
        'Email',
        'Block 1',
        '',
        '',
        '',
        'Block 2',
        '',
        '',
        '',
        'Block 3',
        '',
        '',
        '',
        'Block 4',
        '',
        '',
        '',
        'Block 5',
        '',
        '',
        '',
        'Block 6',
        '',
        '',
        '',
        'Block 7',
        '',
        '',
        '',
        'Block 8',
        '',
        '',
        '',
        'Block 9',
        '',
        '',
        '',
        'Block 10',
        '',
        '',
        '',
        'Block 11',
        '',
        '',
        '',
        'Block 12',
        '',
        '',
        '',
        'Block 13',
        '',
        '',
        '',
      ],
      [
        '',
        '',
        '',
        '',
        '',
        '28/06/2026',
        '05/07/2026',
        '12/07/2026',
        '19/07/2026',
        '26/07/2026',
        '02/08/2026',
        '09/08/2026',
        '16/08/2026',
        '23/08/2026',
        '30/08/2026',
        '06/09/2026',
        '13/09/2026',
        '20/09/2026',
        '27/09/2026',
        '04/10/2026',
        '11/10/2026',
        '18/10/2026',
        '25/10/2026',
        '01/11/2026',
        '08/11/2026',
        '15/11/2026',
        '22/11/2026',
        '29/11/2026',
        '06/12/2026',
        '13/12/2026',
        '20/12/2026',
        '27/12/2026',
        '03/01/2027',
        '10/01/2027',
        '17/01/2027',
        '24/01/2027',
        '31/01/2027',
        '07/02/2027',
        '14/02/2027',
        '21/02/2027',
        '28/02/2027',
        '07/03/2027',
        '14/03/2027',
        '21/03/2027',
        '28/03/2027',
        '04/04/2027',
        '11/04/2027',
        '18/04/2027',
        '25/04/2027',
        '02/05/2027',
        '09/05/2027',
        '16/05/2027',
        '23/05/2027',
        '30/05/2027',
        '06/06/2027',
        '13/06/2027',
        '20/06/2027',
      ],
      [
        '',
        '',
        '',
        '',
        '',
        '04/07/2026',
        '11/07/2026',
        '18/07/2026',
        '25/07/2026',
        '01/08/2026',
        '08/08/2026',
        '15/08/2026',
        '22/08/2026',
        '29/08/2026',
        '05/09/2026',
        '12/09/2026',
        '19/09/2026',
        '26/09/2026',
        '03/10/2026',
        '10/10/2026',
        '17/10/2026',
        '24/10/2026',
        '31/10/2026',
        '07/11/2026',
        '14/11/2026',
        '21/11/2026',
        '28/11/2026',
        '05/12/2026',
        '12/12/2026',
        '19/12/2026',
        '26/12/2026',
        '02/01/2027',
        '09/01/2027',
        '16/01/2027',
        '23/01/2027',
        '30/01/2027',
        '06/02/2027',
        '13/02/2027',
        '20/02/2027',
        '27/02/2027',
        '06/03/2027',
        '13/03/2027',
        '20/03/2027',
        '27/03/2027',
        '03/04/2027',
        '10/04/2027',
        '17/04/2027',
        '24/04/2027',
        '01/05/2027',
        '08/05/2027',
        '15/05/2027',
        '22/05/2027',
        '29/05/2027',
        '05/06/2027',
        '12/06/2027',
        '19/06/2027',
        '26/06/2027',
      ],
      [
        'PGY-1',
        'Sample Resident A — delete this row',
        'SAMPLE-001',
        '+971500000001',
        'sample.a@example.org',
        'Medicine Inpatient',
        'Medicine Inpatient',
        'Medicine Inpatient',
        'Medicine Inpatient',
        'Ped OPD',
        'Ped OPD',
        'NICU',
        'NICU',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      [
        'PGY-2',
        'Sample Resident B — delete this row',
        'SAMPLE-002',
        '+971500000002',
        'sample.b@example.org',
        'PHC',
        '',
        '',
        '',
        'Emergency Medicine',
        'Ped Inpatient',
        'Ped Inpatient',
        'Ped Inpatient',
        'Specialty OPD',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
    ],
  },
  ccc: {
    fileName: 'continuity_of_care_clinics_matrix_template.xlsx',
    endpoint: '/rotations/import/ccc/template',
    sheetName: 'Continuity of Care Clinics (CCC) Matrix',
    rows: PRIMARY_CARE_CLINICS_ROWS,
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

export interface TemplateOptions {
  /**
   * Master grid only: the day Block 1 begins. The workbook's start-date and
   * end-date rows are regenerated from it, so an offline template built on the
   * device carries the same week windows as the one the API would serve for the
   * Coordinator's chosen start day.
   */
  startDate?: string;
}

/**
 * The master workbook's date rows for `startDate`, keeping the block-heading
 * row and the two sample residents exactly as the static spec lays them out.
 */
function buildMasterTemplateRows(startDate: string): XlsxCellValue[][] {
  const base = TEMPLATES.master.rows;
  const weeks = allWeeks(startDate);
  const startRow: XlsxCellValue[] = ['', '', '', '', '', ...weeks.map((week) => formatDmy(week.start))];
  const endRow: XlsxCellValue[] = ['', '', '', '', '', ...weeks.map((week) => formatDmy(week.end))];
  return [base[0], startRow, endRow, ...base.slice(3)];
}

export function templateSpec(kind: TemplateKind, options: TemplateOptions = {}): TemplateSpec {
  const spec = TEMPLATES[kind];
  const startDate = options.startDate ?? MASTER_GRID_START;
  if (kind === 'master') {
    return { ...spec, rows: buildMasterTemplateRows(startDate) };
  }
  return spec;
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
export async function downloadTemplate(
  kind: TemplateKind,
  options: TemplateOptions = {},
): Promise<DownloadOutcome> {
  const spec = templateSpec(kind, options);
  const endpoint = spec.endpoint && options.startDate && kind === 'master'
    ? `${spec.endpoint}?start_date=${encodeURIComponent(options.startDate)}`
    : spec.endpoint;
  const fromServer = endpoint ? await fetchTemplateBytes(endpoint) : null;

  let bytes: any = fromServer ?? buildXlsx(spec.rows, spec.sheetName, spec.merges as any);
  if (bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(bytes);
  }
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
 * Put the picked file on `form` under `field` as a real multipart file part.
 *
 * The two platforms disagree about what a "file" is, and sending the wrong
 * shape is invisible on the client: the request goes out, and the API answers
 * `No file was uploaded` because Multer never saw a part with a filename.
 *
 * - **Web** hands back a `DocumentPickerAsset`, a plain object. The browser's
 *   `FormData.append` only accepts `string | Blob`, so appending the object
 *   itself stringifies it to `[object Object]` and the server receives a text
 *   field. The asset's own `file` — the `File` the `<input type="file">`
 *   produced — is the blob that must be sent, named so the part carries the
 *   `.xlsx` filename.
 * - **iOS/Android** have no `File`; React Native's `FormData` is the one that
 *   understands `{ uri, name, type }` and streams the bytes from the copy the
 *   picker wrote to the cache directory.
 */
async function appendPickedFile(
  form: FormData,
  field: string,
  file: DocumentPicker.DocumentPickerAsset,
): Promise<void> {
  if (Platform.OS === 'web') {
    let blob: Blob | null = file.file ?? null;
    if (!blob) {
      // The asset still knows where the bytes are; read them back if the
      // picker ever stops attaching the `File` itself.
      const response = await fetch(file.uri);
      blob = await response.blob();
    }
    form.append(field, blob, file.name);
    return;
  }

  form.append(field, {
    uri: file.uri,
    name: file.name,
    type: file.mimeType ?? 'application/octet-stream',
  } as any);
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
  try {
    await appendPickedFile(form, 'file', file);
  } catch {
    return {
      success: false,
      issues: [`The file "${file.name}" could not be read for upload — try picking it again.`],
      unreachable: true,
    };
  }

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
    // The server knows how many cells it skipped and which rotations it had
    // to catalogue, so its summary ("412 assignments saved … 3 rotations
    // catalogued. 140 cells left unassigned.") is what the banner should
    // show. Only endpoints that send no summary fall back to a count line.
    const serverSummary = typeof body.summary === 'string' ? body.summary.trim() : '';
    const count = body.added?.length ?? body.updated ?? body.count;
    return {
      success: true,
      issues: [],
      summary: serverSummary || (typeof count === 'number' ? `${count} row${count === 1 ? '' : 's'} imported.` : 'Import complete.'),
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
export const downloadCatalogueTemplate = () => downloadTemplate('catalogue');
export const downloadFacultyTemplate = () => downloadTemplate('faculty');

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

/**
 * Upload a filled-in catalogue workbook.
 *
 * The server upserts on the programme's unique abbreviation, so re-uploading
 * the same file updates the rows it names instead of duplicating them.
 */
export const uploadCatalogue = (file: DocumentPicker.DocumentPickerAsset, programId: number) =>
  uploadSpreadsheet('/rotations/catalogue/import', file, { program_id: programId });

/**
 * Upload a filled-in faculty preceptor workbook.
 *
 * The server validates the whole file and inserts inside one transaction, so a
 * rejected sheet rolls back and names the offending rows instead of leaving a
 * half-imported faculty pool behind.
 */
export const uploadFacultySupervisors = (
  file: DocumentPicker.DocumentPickerAsset,
  programId: number,
) => uploadSpreadsheet('/longitudinal/faculty-supervisors/import', file, { program_id: programId });
