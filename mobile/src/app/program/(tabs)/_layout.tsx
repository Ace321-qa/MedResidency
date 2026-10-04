import { Tabs } from 'expo-router';
import { BarChart3, ClipboardList, LayoutDashboard, Library, Users } from 'lucide-react-native';

import { TAB_BAR_STYLE, tabBarIcon } from '../../../navigation/tabBar';

/**
 * Coordinator tabs. Same five-tab budget as the resident side, allocated to the
 * jobs a programme coordinator actually does: check the programme's state,
 * look up a resident, manage the rotation catalogue, clear the leave queue, and
 * read reports.
 */
export default function ProgramTabsLayout() {
  return (
    <Tabs screenOptions={TAB_BAR_STYLE}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Programme',
          tabBarIcon: tabBarIcon(LayoutDashboard),
        }}
      />
      <Tabs.Screen
        name="roster"
        options={{
          title: 'Roster',
          tabBarIcon: tabBarIcon(Users),
        }}
      />
      <Tabs.Screen
        name="rotations"
        options={{
          title: 'Rotations',
          tabBarIcon: tabBarIcon(Library),
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: 'Approvals',
          tabBarIcon: tabBarIcon(ClipboardList),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          tabBarIcon: tabBarIcon(BarChart3),
        }}
      />
    </Tabs>
  );
}