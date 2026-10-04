import { Tabs } from 'expo-router';
import { CalendarDays, ClipboardList, Gauge, LayoutDashboard, User } from 'lucide-react-native';

import { TAB_BAR_STYLE, tabBarIcon } from '../../../navigation/tabBar';

/**
 * Resident tabs.
 *
 * Five destinations, which is the practical maximum for a bottom bar before
 * labels stop being readable. Anything else a resident needs — logging a shift,
 * assessments, notifications, settings — is pushed onto the stack above, so the
 * tabs stay stable while features are added.
 *
 * `notifications` and `assessments` are not tabs on purpose: they are places to
 * *go* occasionally, not places to *be*.
 */
export default function ResidentTabsLayout() {
  return (
    <Tabs screenOptions={TAB_BAR_STYLE}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: tabBarIcon(LayoutDashboard),
        }}
      />
      <Tabs.Screen
        name="rotations"
        options={{
          title: 'Rotations',
          tabBarIcon: tabBarIcon(CalendarDays),
        }}
      />
      <Tabs.Screen
        name="duty-hours"
        options={{
          title: 'Duty hours',
          tabBarIcon: tabBarIcon(Gauge),
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: 'Requests',
          tabBarIcon: tabBarIcon(ClipboardList),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: tabBarIcon(User),
        }}
      />
    </Tabs>
  );
}