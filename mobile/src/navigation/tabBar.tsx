import type { ColorValue } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, dimensions } from '../theme';

/**
 * Shared tab-bar styling.
 *
 * The bottom tabs are the app's primary navigation, so they are defined once and
 * reused by both the resident and the coordinator layouts. Anything that
 * differs between the two roles stays in its own layout file.
 *
 * Types come from `expo-router`, not from `@react-navigation/*`: since SDK 56
 * the navigator packages are bundled with Expo Router and application code
 * should not import them directly.
 */

export interface TabBarIconProps {
  color: ColorValue;
  size: number;
  focused: boolean;
}

/** Icons are given an explicit size; 24 crowds the label on a small phone. */
export const TAB_ICON_SIZE = 22;

export function tabBarIcon(Icon: LucideIcon) {
  return function TabBarIcon({ color, size }: TabBarIconProps) {
    return <Icon color={color} size={size || TAB_ICON_SIZE} strokeWidth={1.9} />;
  };
}

export const TAB_BAR_STYLE = {
  headerShown: false,
  tabBarActiveTintColor: colors.primary,
  tabBarInactiveTintColor: colors.textMuted,
  tabBarHideOnKeyboard: true,
  tabBarLabelStyle: {
    fontSize: 11,
    fontWeight: '600' as const,
    marginTop: 2,
  },
  tabBarItemStyle: {
    paddingVertical: 6,
    minHeight: dimensions.touchTarget + 12,
  },
  tabBarStyle: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    // A hairline is enough separation; a shadow here would fight the content
    // scrolling above it.
    elevation: 0,
  },
} as const;