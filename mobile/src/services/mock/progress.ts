import type { Numeric } from '../../types/api';

/**
 * Mock progress and competency tracking.
 *
 * The `duty_hour_rules` and `duty_hour_violations` tables already exist, but the
 * API exposes no endpoint that aggregates them, so the figures below are
 * illustrative only. They are shaped around ACGME concepts (annual duty-hour
 * cap, procedural competency requirements) so the screen can be reviewed as a
 * design proposal.
 */

export interface MockProgressMilestone {
  id: string;
  label: string;
  detail: string;
  /** 0–100. */
  percent: number;
  state: 'not_started' | 'in_progress' | 'achieved';
}

export interface MockTrainingProgress {
  /** Hours against the annual cap, as recorded by the sample data. */
  annualHours: number;
  annualCap: number;
  averageWeeklyHours: number;
  weeksElapsed: number;
  /** Procedures the resident must log before they can apply for certification. */
  procedureRequirements: {
    procedure: string;
    required: number;
    logged: number;
  }[];
  milestones: MockProgressMilestone[];
}

const MOCK_PROGRESS: MockTrainingProgress = {
  annualHours: 1284.5,
  annualCap: 1802,
  averageWeeklyHours: 62.4,
  weeksElapsed: 21,
  procedureRequirements: [
    { procedure: 'Cardiopulmonary resuscitation (adult)', required: 20, logged: 18 },
    { procedure: 'Advanced airway management', required: 10, logged: 10 },
    { procedure: 'Central venous access', required: 10, logged: 6 },
    { procedure: 'Lumbar puncture', required: 5, logged: 2 },
    { procedure: 'Suturing and wound closure', required: 15, logged: 14 },
  ],
  milestones: [
    {
      id: 'mock-milestone-1',
      label: 'ACGME-I orientation complete',
      detail: 'Programme orientation and clinical policy training.',
      percent: 100,
      state: 'achieved',
    },
    {
      id: 'mock-milestone-2',
      label: 'Family Medicine Certification exam',
      detail: 'Two assessments must be completed before you may register.',
      percent: 65,
      state: 'in_progress',
    },
    {
      id: 'mock-milestone-3',
      label: 'Supervising faculty sign-off',
      detail: 'Required at the end of each longitudinal clinic block.',
      percent: 40,
      state: 'in_progress',
    },
    {
      id: 'mock-milestone-4',
      label: 'Scholarly activity presentation',
      detail: 'One case report or quality-improvement project per academic year.',
      percent: 0,
      state: 'not_started',
    },
  ],
};

export async function fetchMockTrainingProgress(): Promise<MockTrainingProgress> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    ...MOCK_PROGRESS,
    procedureRequirements: MOCK_PROGRESS.procedureRequirements.map((item) => ({ ...item })),
    milestones: MOCK_PROGRESS.milestones.map((item) => ({ ...item })),
  };
}

/** Convenience for rendering a DECIMAL-shaped number safely. */
export function formatSignedHours(value: Numeric): string {
  return `${value} h`;
}