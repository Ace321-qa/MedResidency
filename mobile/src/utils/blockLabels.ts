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
 * name its block shows the rotation alone rather than guessing.
 */

export interface BlockRef {
  block_number?: number | null;
  block_name?: string | null;
}

/**
 * `Block 5` — or `Block 6` for a block stored as "BLOCK 6", since the number
 * normalises a name that was typed in any casing, and the raw name only when
 * the assignment carries no block number.
 *
 * @returns `null` when the assignment names no block at all.
 */
export function blockLabel(block: BlockRef | null | undefined): string | null {
  const number = Number(block?.block_number);
  if (Number.isInteger(number) && number > 0) return `Block ${number}`;

  const name = typeof block?.block_name === 'string' ? block.block_name.trim() : '';
  return name === '' ? null : name;
}

/**
 * `Block 5: Internal Medicine Inpatient Wards`, or the rotation name alone when
 * no block is known.
 */
export function rotationTitle(block: BlockRef | null | undefined, rotationName: string): string {
  const label = blockLabel(block);
  return label ? `${label}: ${rotationName}` : rotationName;
}
