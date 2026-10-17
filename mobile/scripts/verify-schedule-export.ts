/**
 * Checks the schedule export engine: the report builders, the HTML serializer
 * and the PDF/Word renderers.
 *
 *     npx tsx scripts/verify-schedule-export.ts
 *
 * The contract under test is the one thing that must hold for a coordinator to
 * trust four different download buttons: the .xlsx, .pdf, .docx and .jpg of a
 * schedule are all produced from **one** report model, so they can never
 * disagree. This file therefore asserts the model's shape (column counts,
 * header rows, colour fills) and that each renderer turns that model into a
 * real file with the right magic bytes — not merely that a function ran without
 * throwing.
 */

import {
  buildCccMatrixReport,
} from '../src/utils/scheduleExport/cccMatrixReport';
import { buildMasterGridReport } from '../src/utils/scheduleExport/masterGrid';
import { pgyRank, sortResidentsByPgy } from '../src/utils/residentOrder';
import { expandRowSpans, reportColumnCount, reportToHtml } from '../src/utils/scheduleExport/model';
import { renderReportDocx } from '../src/utils/scheduleExport/docx';
import { renderReportPdf } from '../src/utils/scheduleExport/pdf';
import type {
  CohortGridCell,
  PrimaryCareCycleSchedule,
} from '../src/types/api';

const failures: string[] = [];

function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

function assertTrue(label: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
}

function gridRow(overrides: Partial<CohortGridCell>): CohortGridCell {
  return {
    resident_id: 1,
    resident_name: 'Dr. Ada Obi',
    first_name: 'Ada',
    last_name: 'Obi',
    employee_id: 'E100',
    contact_number: null,
    pgy_level: 1,
    resident_status: 'ACTIVE',
    program_id: 1,
    program_code: 'IM',
    week_start_day: 'SUNDAY',
    block_id: 100,
    block_number: 1,
    block_name: 'Block 1',
    academic_year: '2026-2027',
    block_start_date: '2026-06-28',
    block_end_date: '2026-07-25',
    block_start_date_iso: '2026-06-28',
    block_end_date_iso: '2026-07-25',
    block_start_day: 'SUNDAY',
    block_end_day: 'SATURDAY',
    block_days: 28,
    assignment_id: null,
    rotation_id: null,
    rotation_code: null,
    rotation_name: null,
    department_name: null,
    start_date: null,
    end_date: null,
    assignment_start_date_iso: null,
    assignment_end_date_iso: null,
    assigned_weeks: null,
    assignment_type: null,
    notes: null,
    is_assigned: 0,
    assignment_count: 0,
    ...overrides,
  };
}

// --- Master Rotation Grid report --------------------------------------------

const masterRows: CohortGridCell[] = [
  gridRow({
    assignment_id: 1,
    rotation_id: 5,
    rotation_code: 'CARD',
    rotation_name: 'Cardiology',
    assignment_start_date_iso: '2026-06-28',
    assignment_end_date_iso: '2026-07-11',
    start_date: '2026-06-28',
    end_date: '2026-07-11',
    is_assigned: 1,
  }),
  gridRow({
    resident_id: 2,
    resident_name: 'Dr. Ben Ade',
    pgy_level: 2,
    assignment_id: 2,
    rotation_id: 6,
    rotation_code: 'EMER',
    rotation_name: 'Emergency Medicine',
    assignment_start_date_iso: '2026-07-12',
    assignment_end_date_iso: '2026-07-25',
    start_date: '2026-07-12',
    end_date: '2026-07-25',
    is_assigned: 1,
  }),
];

const blockReport = buildMasterGridReport({
  rows: masterRows,
  startDate: '2026-06-28',
  viewMode: 'block',
  academicYear: '2026-2027',
  cohortLabel: 'All cohorts',
  programLabel: 'Internal Medicine',
  programCode: 'IM',
});

assert('block report has two header rows', blockReport.headerRows, 2);
assert('block report columns = resident + pgy + 13 blocks', reportColumnCount(blockReport), 15);
assert('block report has header rows plus one row per resident', blockReport.rows.length, 4);
assert('block legend names both rotations', blockReport.legend?.length, 2);
assertTrue(
  'block report colours a rotation cell',
  blockReport.rows.slice(2).some((row) => row.some((entryCell) => Boolean(entryCell.fill) && entryCell.text.includes('CARD'))),
);
// The grid reads senior-first: the PGY-2 fixture must precede the PGY-1 one.
assert('block report leads with the senior cohort', blockReport.rows[2][1].text, 'PGY-2');
assert('block report ends with the junior cohort', blockReport.rows[3][1].text, 'PGY-1');

const weeklyReport = buildMasterGridReport({
  rows: masterRows,
  startDate: '2026-06-28',
  viewMode: 'weekly',
  academicYear: '2026-2027',
  cohortLabel: 'PGY-1',
  programLabel: 'Internal Medicine',
  programCode: 'IM',
});

assert('weekly report spans resident + pgy + 52 weeks', reportColumnCount(weeklyReport), 54);
assert('weekly header row spans 13 four-column block banners', weeklyReport.rows[0].length, 15);
// The weekly sub-column must carry the 7-day window the on-screen matrix rotates
// down each column, not just the `1.1` code, or every export loses the dates.
assert('weekly sub-column header carries its 7-day window', weeklyReport.rows[1][2].text, '1.1\n28/06–04/07');
assertTrue('weekly date header is flagged for vertical rendering', weeklyReport.rows[1][2].vertical === true);
assert('block sub-column header carries its block window', blockReport.rows[1][2].text, '28/06–25/07');
assertTrue('block sub-column header is not forced vertical', !blockReport.rows[1][2].vertical);

// Excel rejects `: \ / ? * [ ]` in a worksheet name, so a report built from the
// display-form year (`2026/2027`) must not leave a slash in `sheetName` — that
// is what made the server's ExcelJS renderer answer 500.
const slashYearReport = buildMasterGridReport({
  rows: masterRows,
  startDate: '2026-06-28',
  viewMode: 'weekly',
  academicYear: '2026/2027',
  cohortLabel: 'All cohorts',
  programLabel: 'Internal Medicine',
  programCode: 'IM',
});
assertTrue(
  'master grid sheet name carries no Excel-invalid character',
  !/[\\/*?:[\]]/.test(slashYearReport.sheetName),
);
assertTrue('master grid sheet name is at most 31 characters', slashYearReport.sheetName.length <= 31);

// --- Cohort ordering (senior-first) -----------------------------------------

assert('pgyRank reads a bare number', pgyRank(3), 3);
assert('pgyRank strips the PGY- prefix', pgyRank('PGY-5'), 5);
assert('pgyRank treats a trailing plus as a half year', pgyRank('PGY-4+'), 4.5);
assert('pgyRank keeps a decimal level', pgyRank('4.5'), 4.5);
assert('pgyRank ranks an unknown level below PGY-1', pgyRank(null), 0);

const ordered = sortResidentsByPgy([
  { resident_id: 1, first_name: 'Zoe', last_name: 'Zed', employee_id: 'E9', pgy_level: 3 },
  { resident_id: 2, first_name: 'Amy', last_name: 'Ash', employee_id: 'E8', pgy_level: 3 },
  { resident_id: 3, first_name: 'Ben', last_name: 'Bell', employee_id: 'E7', pgy_level: 1 },
  { resident_id: 4, first_name: 'Cara', last_name: 'Cole', employee_id: 'E6', pgy_level: 5 },
]);
assert('residents sort PGY-5, then the PGY-3 pair, then PGY-1', ordered.map((r) => r.resident_id), [4, 2, 1, 3]);
assert('same-level residents tie-break on first name', ordered[1].first_name, 'Amy');

const html = reportToHtml(blockReport);
assertTrue('HTML serializer includes the report title', html.includes('Master Rotation Grid'));
assertTrue('HTML serializer paints cell fills', html.includes('background:#'));
assertTrue('HTML serializer carries the programme meta', html.includes('Internal Medicine'));

// --- CCC matrix report ------------------------------------------------------

const schedule: PrimaryCareCycleSchedule = {
  cycle: {
    id: 1,
    program_id: 1,
    cycle_number: '1',
    week_number: '1',
    start_date: '2026-06-28',
    rotation_window_months: 3,
    total_weeks: 12,
    end_date: '2026-09-19',
  },
  dailyHeaders: [
    {
      id: 10,
      cycle_id: 1,
      day_of_week: 'Sunday',
      shift_time: '10:30 - 14:00',
      pgy_level: 'PGY-3',
      in_charge_faculty_id: 5,
      in_charge_faculty_name: 'Dr. Incharge',
    },
  ],
  slots: [
    {
      id: 1,
      daily_header_id: 10,
      clinic_number: 1,
      resident_1_name: 'Dr. A',
      resident_2_name: null,
      faculty_name: 'Dr. F',
      faculty_id: 9,
    },
  ],
  backups: {
    Sunday: [
      { id: 1, daily_header_id: 10, day_of_week: 'Sunday', faculty_name: 'Dr. Backup', faculty_id: 7, priority_order: 1 },
    ],
  },
  absences: [
    {
      id: 1,
      program_id: 1,
      cycle_id: 1,
      daily_header_id: 10,
      day_of_week: 'Sunday',
      absence_date: '2026-06-28',
      person_type: 'RESIDENT',
      resident_id: 2,
      faculty_id: null,
      person_name: 'Dr. Away',
      leave_type: 'SICK_LEAVE',
      coverage_notes: null,
    },
  ],
  columns: [
    { clinic_number: 1, label: null },
    { clinic_number: 2, label: 'WBC' },
  ],
};

const cccReport = buildCccMatrixReport({
  schedule,
  programLabel: 'Internal Medicine',
  programCode: 'IM',
});

assert('CCC header row = Day + two clinics + Leaves', cccReport.rows[0].length, 4);
assert('CCC report = header + one day + one backup row', cccReport.rows.length, 3);
assert('CCC clinic column falls back to "Clinic 1"', cccReport.rows[0][1].text, 'Clinic 1');
assert('CCC clinic column honours a custom label', cccReport.rows[0][2].text, 'WBC');
assert('CCC day cell names the resident pair', cccReport.rows[1][1].text, 'Dr. A\nDr. F');
assert('CCC empty clinic reads Unassigned', cccReport.rows[1][2].text, 'Unassigned');
assert('CCC leaves cell counts the absent', cccReport.rows[1][3].text, '1 away\nDr. Away');

// --- Merged-cell expansion (the pdfmake "a cell is undefined" guard) ---------

assert('expanded row fills a colSpan with placeholders', expandRowSpans(
  [{ text: 'Day' }, { text: 'catchup', colSpan: 3 }],
  4,
).length, 4);
assert('expanded row keeps the spanning cell at its position', expandRowSpans(
  [{ text: 'Day' }, { text: 'catchup', colSpan: 3 }],
  4,
)[1].text, 'catchup');
assert('expanded row pads a short row to full width', expandRowSpans([{ text: 'Day' }], 3).length, 3);

// The backup row is the regression this guards: `[Day, catchup(colSpan 3)]` is
// two cells for a four-column table, which pdfmake rejects.
const backupRow = cccReport.rows[cccReport.rows.length - 1];
assert('CCC backup row is short before expansion', backupRow.length, 2);
assert('CCC backup row spans the full grid after expansion', expandRowSpans(backupRow, 4).length, 4);

// --- Renderers --------------------------------------------------------------

async function checkRenderers(): Promise<void> {
  // Node has no DOM, so `renderReportPdf` would otherwise fall back to
  // `expo-print` (unavailable here) and mask a genuine pdfmake failure behind an
  // unrelated parse error. Pretending a document exists forces pdfmake to
  // surface its own error, which is what these checks must catch.
  (globalThis as unknown as { document: unknown }).document = {};

  const pdf = await renderReportPdf(blockReport);
  assertTrue('PDF begins with %PDF-', String.fromCharCode(...pdf.slice(0, 5)) === '%PDF-');
  assertTrue('PDF is non-trivial', pdf.length > 1200);

  // The CCC report carries a `colSpan` backup row — the case that used to throw
  // "Malformed table row, a cell is undefined" — and the weekly grid carries
  // `colSpan: 4` block banners.
  const cccPdf = await renderReportPdf(cccReport);
  assertTrue('CCC PDF (colSpan row) begins with %PDF-', String.fromCharCode(...cccPdf.slice(0, 5)) === '%PDF-');
  const weeklyPdf = await renderReportPdf(weeklyReport);
  assertTrue('Weekly PDF (colSpan banners) begins with %PDF-', String.fromCharCode(...weeklyPdf.slice(0, 5)) === '%PDF-');

  const docx = await renderReportDocx(cccReport);
  assertTrue('DOCX begins with a zip signature (PK)', docx[0] === 0x50 && docx[1] === 0x4b);
  assertTrue('DOCX is non-trivial', docx.length > 1200);
}

checkRenderers()
  .then(() => {
    if (failures.length > 0) {
      console.log(`\n${failures.length} check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll schedule-export checks passed.');
    }
  })
  .catch((error) => {
    console.error('\nRenderer check threw:', error);
    process.exitCode = 1;
  });
