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
import { reportColumnCount, reportToHtml } from '../src/utils/scheduleExport/model';
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
  blockReport.rows[2].some((entryCell) => Boolean(entryCell.fill) && entryCell.text.includes('CARD')),
);

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

// --- Renderers --------------------------------------------------------------

async function checkRenderers(): Promise<void> {
  const pdf = await renderReportPdf(blockReport);
  assertTrue('PDF begins with %PDF-', String.fromCharCode(...pdf.slice(0, 5)) === '%PDF-');
  assertTrue('PDF is non-trivial', pdf.length > 1200);

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
