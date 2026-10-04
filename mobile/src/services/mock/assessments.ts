import type { Tone } from '../../theme';

/**
 * Types for the mock assessments below.
 *
 * There is no `assessments` table in the database and no assessment endpoint in
 * the API, so these shapes are a proposal for what the backend would return —
 * not a description of something that exists. When the endpoint is written,
 * move these types to `src/types/api.ts` and delete this file.
 */

export type MockAssessmentStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'AWAITING_REVIEW' | 'COMPLETED';

export interface MockAssessment {
  id: string;
  title: string;
  /** The rotation or block the assessment belongs to. */
  context: string;
  category: 'Clinical' | 'Academic' | 'Professional' | 'Simulation';
  dueDate: string;
  status: MockAssessmentStatus;
  /** 0–100, present only once completed. */
  score: number | null;
  evaluator: string | null;
  feedback: string | null;
}

export const MOCK_ASSESSMENT_STATUS_LABEL: Record<MockAssessmentStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  AWAITING_REVIEW: 'Awaiting review',
  COMPLETED: 'Completed',
};

export const MOCK_ASSESSMENT_STATUS_TONE: Record<MockAssessmentStatus, Tone> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  SUBMITTED: 'info',
  AWAITING_REVIEW: 'warning',
  COMPLETED: 'success',
};

const MOCK_ASSESSMENTS: MockAssessment[] = [
  {
    id: 'mock-assessment-1',
    title: 'Mini-CEX — Difficult Patient Encounter',
    context: 'Family Medicine Continuity Clinic',
    category: 'Clinical',
    dueDate: '2026-10-18',
    status: 'AWAITING_REVIEW',
    score: null,
    evaluator: 'Dr. A. Bensaid',
    feedback: null,
  },
  {
    id: 'mock-assessment-2',
    title: 'Direct Observation of Procedural Skill (DOPS)',
    context: 'Family Medicine Continuity Clinic',
    category: 'Clinical',
    dueDate: '2026-10-30',
    status: 'NOT_STARTED',
    score: null,
    evaluator: 'Dr. A. Bensaid',
    feedback: null,
  },
  {
    id: 'mock-assessment-3',
    title: 'Case-Based Discussion (CBD)',
    context: 'Academic Half-Day',
    category: 'Academic',
    dueDate: '2026-09-25',
    status: 'COMPLETED',
    score: 78,
    evaluator: 'Dr. M. Al-Hamad',
    feedback:
      'Clear reasoning and appropriate escalation. Build more explicit cost awareness when discussing management options.',
  },
  {
    id: 'mock-assessment-4',
    title: 'OSCE — Cardiac Arrest Station',
    context: 'Resuscitation Simulation Lab',
    category: 'Simulation',
    dueDate: '2026-11-12',
    status: 'IN_PROGRESS',
    score: null,
    evaluator: 'Simulation Faculty',
    feedback: null,
  },
  {
    id: 'mock-assessment-5',
    title: 'Medical Student Teaching Evaluation',
    context: 'Undergraduate Rotation',
    category: 'Professional',
    dueDate: '2026-08-20',
    status: 'COMPLETED',
    score: 91,
    evaluator: 'Dr. H. Nasser',
    feedback: 'Excellent bedside teaching. Consider documenting learning objectives beforehand.',
  },
];

/**
 * Sample assessments. Resolves after a short delay so loading states are real
 * while this mock is in place — that code has to work anyway once the API
 * exists.
 */
export async function fetchMockAssessments(): Promise<MockAssessment[]> {
  await delay(350);
  return MOCK_ASSESSMENTS.map((item) => ({ ...item }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}