/**
 * MedResidency colour palette.
 *
 * The rule for this app: colour carries *meaning*, never decoration. A screen
 * is either neutral (structure and text) or it uses one semantic colour to say
 * something important — approved, needs attention, blocked, or in breach.
 *
 * Each semantic colour has two parts:
 *   - `*Text`   the readable foreground, dark enough to pass WCAG AA on its
 *                own `*Surface` background (all four are >= 4.5:1).
 *   - `*Surface` a very light background for banners and badges.
 *
 * Never mix a semantic foreground with a different semantic background, and
 * never rely on colour alone — every status also shows a text label.
 */

/** Raw hues. Only `colors` below should be imported by screens. */
const palette = {
  navy900: '#0B2033',
  navy800: '#0F2C45',
  navy700: '#12558C',
  navy600: '#0E4573',
  navy100: '#D8E6F2',
  navy50: '#EEF4F9',

  slate900: '#0F172A',
  slate700: '#334155',
  slate600: '#475569',
  slate500: '#64748B',
  slate400: '#94A3B8',
  slate300: '#CBD5E1',
  slate200: '#E2E8F0',
  slate100: '#EDF1F5',
  slate50: '#F6F8FA',
  white: '#FFFFFF',

  green700: '#15803D',
  green50: '#E8F5EC',
  amber800: '#92400E',
  amber50: '#FDF3E3',
  red700: '#B91C1C',
  red50: '#FDECEC',
} as const;

export const colors = {
  /** Brand blue. Used for primary actions, active states and key figures. */
  primary: palette.navy700,
  primaryDark: palette.navy800,
  primaryPressed: palette.navy600,
  primarySoft: palette.navy50,
  primaryBorder: palette.navy100,
  onPrimary: palette.white,

  /** Secondary actions and the header background. */
  secondary: palette.navy800,
  onSecondary: palette.white,

  /** App canvas. Slightly cooler than pure white so cards read as raised. */
  background: palette.slate50,
  surface: palette.white,
  surfaceMuted: palette.slate100,

  textPrimary: palette.slate900,
  textSecondary: palette.slate600,
  textMuted: palette.slate500,
  textInverse: palette.white,

  border: palette.slate200,
  borderStrong: palette.slate300,

  success: palette.green700,
  successSurface: palette.green50,
  warning: palette.amber800,
  warningSurface: palette.amber50,
  danger: palette.red700,
  dangerSurface: palette.red50,
  info: palette.navy700,
  infoSurface: palette.navy50,

  disabled: palette.slate100,
  disabledText: palette.slate400,

  /** Scrim behind modals and sheets. */
  overlay: 'rgba(11, 32, 51, 0.55)',
} as const;

/**
 * Maps a semantic tone to the colour pair used by badges, banners and rows.
 * Screens never hardcode these hexes.
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const toneColors: Record<Tone, { foreground: string; surface: string; border: string }> = {
  neutral: { foreground: colors.textSecondary, surface: colors.surfaceMuted, border: colors.border },
  info: { foreground: colors.info, surface: colors.infoSurface, border: colors.primaryBorder },
  success: { foreground: colors.success, surface: colors.successSurface, border: colors.success },
  warning: { foreground: colors.warning, surface: colors.warningSurface, border: colors.warning },
  danger: { foreground: colors.danger, surface: colors.dangerSurface, border: colors.danger },
};