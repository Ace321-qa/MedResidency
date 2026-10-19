/**
 * Block labels for rotation titles and tags.
 *
 * A block carries two names and only one of them is trustworthy. `block_number`
 * is the block's place in the academic calendar — set by the calendar, never
 * typed. `block_name` is coordinator-typed free text, and production's block 5
 * is literally named "Pediatrics": a rotation category entered where a block
 * name belongs, which is how the resident Today dashboard came to read
 * "Pediatrics: Internal Medicine Inpatient Wards" for a resident standing on
 * the Internal Medicine wards.
 *
 * So every screen that prefixes or tags a rotation with its block goes through
 * here: the number when there is one, the stored name only when there is no
 * number to read, and nothing at all when there is neither. A title that cannot
 * name its block shows the rotation alone rather than guessing. Block headings
 * use `blockTitle`, for exactly the same reason.
 */

import { normalizeAcademicYear } from './academicYear';

export interface BlockRef {
  block_number?: number | null;
  block_name?: string | null;
}

/** A block plus the year its card heading carries. */
export interface BlockTitleRef extends BlockRef {
  academic_year?: string | null;
}

/** A block name is only trustworthy when it actually looks like one. */
const BLOCK_NAME_PATTERN = /^block\s*(\d+)$/i;

/**
 * `Block 5` — or `Block 6` for a block stored as "BLOCK 6", since the number
 * normalises a name typed in any casing.
 *
 * @returns `null` when the assignment carries no block number *and* no
 * block-shaped name. Refusing a name like "Pediatrics" is the point: a payload
 * from an older server (or any other write path that loses `block_number`) must
 * degrade to the rotation name alone, never resurrect the stale category as a
 * title prefix. A genuine custom block name ("Orientation Week") is dropped for
 * the same reason — the title shows the rotation, which is never wrong, whereas
 * guessing from free text was exactly the bug.
 */
export function blockLabel(block: BlockRef | null | undefined): string | null {
  const number = Number(block?.block_number);
  if (Number.isInteger(number) && number > 0) return `Block ${number}`;

  const name = typeof block?.block_name === 'string' ? block.block_name.trim() : '';
  const digits = BLOCK_NAME_PATTERN.exec(name);
  return digits ? `Block ${digits[1]}` : null;
}

/**
 * `Block 5 · 2026-2027` — the heading a block card is allowed to have.
 *
 * The year is normalised for display because the column holds both "2026-2027"
 * and "2026/2027" for the same academic year. The label itself still comes from
 * `blockLabel`, so a coordinator-typed rotation category can never become a
 * card title; a block with neither a number nor a block-shaped name is labelled
 * "Unnamed block" rather than borrowing text from the rotation it contains.
 */
export function blockTitle(block: BlockTitleRef | null | undefined): string {
  const label = blockLabel(block) ?? 'Unnamed block';
  const year = normalizeAcademicYear(block?.academic_year);
  return year ? `${label} · ${year}` : label;
}

/**
 * `Block 5: Internal Medicine Inpatient Wards`, or the rotation name alone when
 * no block is known.
 */
export function rotationTitle(block: BlockRef | null | undefined, rotationName: string): string {
  const label = blockLabel(block);
  return label ? `${label}: ${rotationName}` : rotationName;
}
