import type { Numeric } from '../../types/api';

/**
 * Mock programme-level figures for the coordinator Reports tab.
 *
 * These are aggregates the database could produce but the API does not expose —
 * cohort demographics, block fill rates, compliance counts. They are clearly
 * labelled as sample data in the UI so nobody mistakes them for real reporting.
 */

export interface MockCohortBreakdown {
  label: string;
  count: number;
}

export interface MockProgrammeReport {
  cohort: MockCohortBreakdown[];
  blockFill: {
    blockName: string;
    assignedResidents: number;
    totalWeeks: Numeric;
  }[];
  compliance: {
    shiftsLogged: number;
    flaggedBreaches: number;
    pendingLeaveRequests: number;
  };
  generatedAt: string;
}

const MOCK_REPORT: MockProgrammeReport = {
  cohort: [
    { label: 'PGY-1', count: 4 },
    { label: 'PGY-2', count: 3 },
    { label: 'PGY-3', count: 2 },
    { label: 'PGY-4', count: 1 },
  ],
  blockFill: [
    { blockName: 'Block 1', assignedResidents: 5, totalWeeks: '20.0' },
    { blockName: 'Block 2', assignedResidents: 3, totalWeeks: '12.0' },
    { blockName: 'Block 3', assignedResidents: 2, totalWeeks: '8.0' },
    { blockName: 'Block 4', assignedResidents: 0, totalWeeks: '0.0' },
  ],
  compliance: {
    shiftsLogged: 412,
    flaggedBreaches: 3,
    pendingLeaveRequests: 5,
  },
  generatedAt: '2026-10-04 08:00',
};

export async function fetchMockProgrammeReport(): Promise<MockProgrammeReport> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  return {
    ...MOCK_REPORT,
    cohort: MOCK_REPORT.cohort.map((item) => ({ ...item })),
    blockFill: MOCK_REPORT.blockFill.map((item) => ({ ...item })),
    compliance: { ...MOCK_REPORT.compliance },
  };
}