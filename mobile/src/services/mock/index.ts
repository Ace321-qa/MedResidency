/**
 * The single door into mock data.
 *
 * Screens that need placeholder data import from here rather than reaching into
 * individual files, which means `grep` finds every consumer in one place. When
 * the real endpoints exist, delete `src/services/mock/` and this file; the
 * TypeScript compiler will list every screen that needs updating.
 *
 * See ./README.md for the removal procedure.
 */
export {
  MOCK_ASSESSMENT_STATUS_LABEL,
  MOCK_ASSESSMENT_STATUS_TONE,
  fetchMockAssessments,
  type MockAssessment,
  type MockAssessmentStatus,
} from './assessments';
export {
  MOCK_NOTIFICATION_CATEGORY_LABEL,
  MOCK_NOTIFICATION_TONE,
  fetchMockNotifications,
  fetchMockUnreadNotificationCount,
  type MockNotification,
} from './notifications';
export {
  fetchMockTrainingProgress,
  type MockProgressMilestone,
  type MockTrainingProgress,
} from './progress';
export {
  fetchMockProgrammeReport,
  type MockCohortBreakdown,
  type MockProgrammeReport,
} from './programReports';