import type { Tone } from '../../theme';

/**
 * Mock notifications.
 *
 * The database has no notifications table and the API has no notifications
 * endpoint. These entries are derived from data the app *does* have (leave
 * status, duty-hour breaches, upcoming rotations) so the interface can be
 * reviewed honestly, but the content itself is fabricated.
 */

export interface MockNotification {
  id: string;
  category: 'academic' | 'compliance' | 'schedule' | 'administrative';
  title: string;
  body: string;
  /** `YYYY-MM-DD HH:MM`, the format the app formats elsewhere. */
  timestamp: string;
  read: boolean;
  /** Optional in-app destination, e.g. `/(resident)/duty-hours`. */
  href?: string;
}

export const MOCK_NOTIFICATION_TONE: Record<MockNotification['category'], Tone> = {
  academic: 'info',
  compliance: 'danger',
  schedule: 'neutral',
  administrative: 'warning',
};

export const MOCK_NOTIFICATION_CATEGORY_LABEL: Record<MockNotification['category'], string> = {
  academic: 'Academic',
  compliance: 'Compliance',
  schedule: 'Schedule',
  administrative: 'Administrative',
};

const MOCK_NOTIFICATIONS: MockNotification[] = [
  {
    id: 'mock-notification-1',
    category: 'compliance',
    title: 'Duty-hour breach recorded',
    body:
      'A 28-hour continuous shift on 07 Jul 2026 exceeded the 24-hour limit plus the 4-hour transition period allowed by your program rule set. Discuss this with your program director.',
    timestamp: '2026-07-07 08:12',
    read: false,
    href: '/(resident)/duty-hours',
  },
  {
    id: 'mock-notification-2',
    category: 'administrative',
    title: 'Study leave awaiting approval',
    body:
      'Your study-leave request for 10–14 Aug 2026 (5 days) is still pending a decision from the chief resident.',
    timestamp: '2026-09-28 03:31',
    read: false,
    href: '/(resident)/requests',
  },
  {
    id: 'mock-notification-3',
    category: 'schedule',
    title: 'Rotation schedule published',
    body:
      'Block 4 (05 Oct – 01 Nov 2026) has been added to your rotation schedule. Review your assignment before the block begins.',
    timestamp: '2026-10-01 09:00',
    read: false,
  },
  {
    id: 'mock-notification-4',
    category: 'academic',
    title: 'ACGME-I logging reminder',
    body:
      'Remember to log every shift, including on-call hours. Unlogged time cannot be counted towards your annual duty-hour total.',
    timestamp: '2026-09-30 07:45',
    read: true,
  },
  {
    id: 'mock-notification-5',
    category: 'administrative',
    title: 'Release letter acknowledged',
    body:
      'The release letter for your Antenatal Care Clinic was marked as sent by the residency office on 03 Oct 2026.',
    timestamp: '2026-10-03 06:24',
    read: true,
  },
];

export async function fetchMockNotifications(): Promise<MockNotification[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return MOCK_NOTIFICATIONS.map((item) => ({ ...item }));
}

export async function fetchMockUnreadNotificationCount(): Promise<number> {
  const all = await fetchMockNotifications();
  return all.filter((item) => !item.read).length;
}