import type { ViewStyle } from 'react-native';

/**
 * Shadows, used sparingly.
 *
 * Two levels only:
 *  - `card`   a hairline lift for content that sits on the canvas.
 *  - `raised` for things that float above the page (sheets, sticky bars).
 *
 * Android needs `elevation`, iOS needs shadow* plus an opaque background colour
 * on the same view, so each level carries both.
 */
const shadowTint = '#0B2033';

export const shadow = {
  card: {
    shadowColor: shadowTint,
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  raised: {
    shadowColor: shadowTint,
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
} as const satisfies Record<string, ViewStyle>;