import { Tabs } from 'expo-router';
import {
  BarChart3,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Library,
  Network,
  Users,
} from 'lucide-react-native';

import { TAB_BAR_STYLE, tabBarIcon } from '../../../navigation/tabBar';

/**
 * Coordinator tabs. Same budget as the resident side, allocated to the jobs a
 * programme coordinator actually does: check the programme's state, look up a
 * resident, manage the rotation catalogue, author and read the release letters
 * the hospital is owed, clear the leave queue, and read reports — plus the
 * citywide residencies this one shares a hospital with.
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
        name="letters"
        options={{
          title: 'Letters',
          tabBarIcon: tabBarIcon(FileText),
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
      <Tabs.Screen
        name="network"
        options={{
          title: 'Network',
          tabBarIcon: tabBarIcon(Network),
        }}
      />
    </Tabs>
  );
}