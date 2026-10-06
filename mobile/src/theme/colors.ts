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

  // Categorical hues for the rota badges. Dark enough to pass AA on their own
  // light surface, matching the semantic colours above.
  teal800: '#0F766E',
  teal50: '#E4FBF7',
  indigo800: '#3730A3',
  indigo50: '#EEF2FF',
  purple800: '#6B21A8',
  purple50: '#F7EBFF',
  pink800: '#A61E4D',
  pink50: '#FDF0F5',
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

/**
 * Categorical colours for the rota badges, indexed by rotation.
 *
 * The semantic palette above answers "is this approved or blocked". This one
 * answers a different question — *which rotation is this* — and that is a
 * categorical problem with no natural order, so it needs its own set of hues
 * rather than an abuse of `warning`/`success`.
 *
 * Two rules keep it honest:
 *
 *  1. **Colour never carries the meaning alone.** Every badge is labelled with
 *     the rotation's code, and the grid prints a legend. The hues are there to
 *     make a column scannable, not to be the only way to read it.
 *  2. **The assignment is stable.** A rotation's index is derived from its code
 *     (see `rotationBadge` in `utils/rotationBadges.ts`), so a rotation keeps
 *     the same colour between sessions instead of shuffling on every render.
 */
export const categoricalColors: readonly {
  foreground: string;
  surface: string;
  border: string;
}[] = [
  { foreground: palette.navy700, surface: palette.navy50, border: palette.navy100 },
  { foreground: palette.teal800, surface: palette.teal50, border: '#99F6E4' },
  { foreground: palette.purple800, surface: palette.purple50, border: '#E9D5FF' },
  { foreground: palette.amber800, surface: palette.amber50, border: '#FDE68A' },
  { foreground: palette.indigo800, surface: palette.indigo50, border: '#C7D2FE' },
  { foreground: palette.green700, surface: palette.green50, border: '#BBF7D0' },
  { foreground: palette.pink800, surface: palette.pink50, border: '#FBCFE8' },
  { foreground: palette.red700, surface: palette.red50, border: '#FECACA' },
  { foreground: palette.slate700, surface: palette.slate50, border: palette.slate200 },
];