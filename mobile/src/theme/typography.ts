/**
 * Type scale.
 *
 * Deliberately plain: the iOS system font (San Francisco) and the Android
 * system font (Roboto). No decorative or downloaded font — a clinical tool
 * should look native to the device and stay legible to everyone.
 *
 * Sizes are in points and never below 11; anything smaller is unreadable on a
 * cheap Android panel. Line heights are ~1.45x so long clinical text stays
 * comfortable to read.
 */
export const typography = {
  /** Screen-level numbers, e.g. a dashboard figure. */
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  h1: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  h2: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  h3: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  /** Default reading size for names, messages and descriptions. */
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  /** Supporting text, list metadata. */
  bodySmall: { fontSize: 13, lineHeight: 19, fontWeight: '400' },
  /** Timestamps and footnotes. */
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  /**
   * Field labels and section eyebrows. Uppercase with wide letter spacing so it
   * reads as a label rather than a heading.
   */
  label: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.7 },
  button: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  /** Large figure inside a stat tile. */
  metric: { fontSize: 22, lineHeight: 26, fontWeight: '700' },
} as const;

export type TypographyVariant = keyof typeof typography;