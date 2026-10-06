/**
 * Stable colour and label for a rotation.
 *
 * The master grid is a rota read at arm's length: the point of colouring a cell
 * is to recognise "the blue block" across three columns without reading it. That
 * only works if the mapping is **stable**, so the index is derived from the
 * rotation's code with a string hash rather than from its position in a list —
 * otherwise adding one rotation would repaint the whole grid and every colour a
 * coordinator had learned would now mean something else.
 *
 * The label always carries the meaning too. Colour is the fast path, never the
 * only one.
 */

import { categoricalColors } from '../theme';

export interface RotationBadgePalette {
  foreground: string;
  surface: string;
  border: string;
}

/**
 * A small non-negative integer hash of a rotation code.
 *
 * FNV-1a, truncated: enough to spread short codes like `CARD`, `EMER` and
 * `SURG` across the palette without pulling in a dependency.
 */
function hashCode(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The palette for a rotation.
 *
 * Falls back to the last (neutral slate) entry rather than throwing: a rotation
 * row with a missing or blank code still needs a readable badge.
 */
export function rotationPalette(rotationCode: string | null | undefined, rotationId?: number | null): RotationBadgePalette {
  const key = (rotationCode ?? '').trim() || (rotationId ? `id:${rotationId}` : 'unassigned');
  return categoricalColors[hashCode(key) % categoricalColors.length];
}

/**
 * The badge text.
 *
 * Prefers the short code (`CARD`) because a matrix cell is ~110pt wide, and
 * falls back to the first word of the name (`Cardiology`) when there is no code.
 */
export function rotationBadgeLabel(
  rotationCode: string | null | undefined,
  rotationName: string | null | undefined,
): string {
  const code = (rotationCode ?? '').trim();
  if (code) return code;
  const name = (rotationName ?? '').trim();
  if (!name) return 'Unassigned';
  return name.split(/\s+/)[0];
}

/** `Cardiology · 4 weeks` — the accessible description of a cell. */
export function rotationCellDescription(
  rotationCode: string | null | undefined,
  rotationName: string | null | undefined,
  assignedWeeks: number | null | undefined,
): string {
  const name = (rotationName ?? '').trim();
  const weeks = typeof assignedWeeks === 'number' && Number.isFinite(assignedWeeks) ? assignedWeeks : null;
  const weeksLabel = weeks === null ? '' : `, ${weeks} week${weeks === 1 ? '' : 's'}`;
  return `${name || 'Unassigned'}${weeksLabel}`;
}