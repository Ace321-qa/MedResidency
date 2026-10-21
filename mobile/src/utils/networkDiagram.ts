import type {
  NetworkCrossRotation,
  NetworkNode,
  ProgramConnection,
  ResidencyNetwork,
} from '../types/api';
import type { DimensionValue } from 'react-native';

/**
 * Geometry and wording for the residency network map.
 *
 * Kept as pure functions, separate from the screen, for one reason: the map's
 * job is to make a relationship legible, and legibility is a property of the
 * arithmetic — where a line starts, whether two programmes are already
 * connected, how big a node is. Those rules can be checked without rendering
 * anything, and they are the part most likely to be got subtly wrong (an edge
 * drawn to the wrong node still looks like a line).
 *
 * The coordinate space is percentage (0–100) in both axes, matching what the
 * API returns, so the same node set renders on a phone and a tablet without the
 * layout being recomputed.
 */

const VB = 100;

/** Whether two programmes are the same programme, tolerating string ids. */
export function sameProgram(a: number | string | null, b: number | string | null): boolean {
  if (a === null || b === null) return false;
  return Number(a) === Number(b);
}

/**
 * Scale a percentage coordinate into an SVG viewBox of `size` units.
 *
 * Points are nudged inwards by `inset` so a node's circle and its label are not
 * clipped at the edge of the drawing area.
 */
export function project(
  position: { x: number; y: number },
  size: number,
  inset = 0,
): { x: number; y: number } {
  const usable = size - inset * 2;
  return {
    x: inset + (clampPercent(position.x) / VB) * usable,
    y: inset + (clampPercent(position.y) / VB) * usable,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(VB, Math.max(0, value));
}

/**
 * A node's radius, driven by how many residents it holds.
 *
 * Area, not radius, is what a reader compares — so the radius grows with the
 * square root of the count. A linear radius makes a programme with forty
 * residents look sixteen times the size of one with ten, which overstates it
 * badly on a map whose whole purpose is comparing scale.
 */
export function nodeRadius(residentCount: number, min = 9, max = 22): number {
  const count = Number.isFinite(residentCount) && residentCount > 0 ? residentCount : 0;
  const scaled = Math.sqrt(count) * 2.2;
  return Math.round(Math.min(max, Math.max(min, min + scaled)) * 10) / 10;
}

/**
 * A node's tappable area, positioned over the drawing rather than drawn in it.
 *
 * The map is not interactive *inside* the SVG. `react-native-svg` turns any
 * element carrying `onPress` into a responder target, and on web it does that by
 * spreading `onResponderGrant`/`onResponderTerminate` and friends onto the raw
 * DOM node (`<circle>`, `<text>`), which React rejects with an unknown-prop
 * warning. Those handlers are also redundant on web, where `react-native-svg`
 * already forwards `onPress` to `onClick`. So the shapes stay inert and the
 * touch target is a real view laid on top, which is where a responder belongs.
 *
 * The geometry is returned as percentages of the container because the SVG is a
 * square `viewBox` stretched to a square container: an SVG coordinate of `v` in
 * a box of `size` is at `v / size` of the box, whatever the box's pixel width.
 */
export function nodeHitArea(
  node: Pick<NetworkNode, 'position'>,
  size: number,
  inset = 0,
  padding = 6,
): { left: DimensionValue; top: DimensionValue; width: DimensionValue; height: DimensionValue } {
  const point = project(node.position, size, inset);
  const touchingNodes = nodeRadius(0) + padding;
  const diameter = touchingNodes * 2;
  return {
    left: `${((point.x - touchingNodes) / size) * 100}%`,
    top: `${((point.y - touchingNodes) / size) * 100}%`,
    width: `${(diameter / size) * 100}%`,
    height: `${(diameter / size) * 100}%`,
  };
}

/** A short label for a node: the code if it has one, otherwise the name clipped. */
export function nodeLabel(node: Pick<NetworkNode, 'program_code' | 'program_name'>): string {
  const code = String(node.program_code ?? '').trim();
  if (code) return code;
  const name = String(node.program_name ?? '').trim();
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}

/** The initials a node draws inside itself when it has no usable code. */
export function nodeInitials(node: Pick<NetworkNode, 'program_name'>): string {
  const words = String(node.program_name ?? '')
    .split(/\s+/)
    .filter((word) => word.length > 1);
  return words
    .slice(0, 3)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 3);
}

/** True when the two programmes already have an active declared partnership. */
export function isConnected(
  connections: ProgramConnection[],
  a: number | string,
  b: number | string,
): boolean {
  return connections.some(
    (connection) =>
      connection.is_active === 1 &&
      ((sameProgram(connection.source_program_id, a) && sameProgram(connection.target_program_id, b)) ||
        (sameProgram(connection.source_program_id, b) && sameProgram(connection.target_program_id, a))),
  );
}

/**
 * The declared edges to draw: each active connection resolved to its two nodes,
 * skipping any whose programme is not on the map (a withdrawn or deactivated
 * programme would otherwise produce an edge to nowhere).
 */
export function declaredEdges(
  network: ResidencyNetwork | null,
): { id: number; from: NetworkNode; to: NetworkNode; type: string }[] {
  if (!network) return [];
  const byId = new Map(network.nodes.map((node) => [node.id, node]));
  const edges: { id: number; from: NetworkNode; to: NetworkNode; type: string }[] = [];
  for (const connection of network.connections) {
    if (connection.is_active !== 1) continue;
    const from = byId.get(Number(connection.source_program_id));
    const to = byId.get(Number(connection.target_program_id));
    if (!from || !to) continue;
    edges.push({ id: connection.id, from, to, type: connection.connection_type });
  }
  return edges;
}

/**
 * The observed edges to draw: one per cross-programme posting, weighted by how
 * many residents travel it. Kept separate from the declared edges because a
 * partnership nobody is using yet must look different from one carrying traffic.
 */
export function observedEdges(
  network: ResidencyNetwork | null,
): { from: NetworkNode; to: NetworkNode; residents: number }[] {
  if (!network) return [];
  const byId = new Map(network.nodes.map((node) => [node.id, node]));
  const edges: { from: NetworkNode; to: NetworkNode; residents: number }[] = [];
  for (const cross of network.cross_rotations) {
    const from = byId.get(Number(cross.home_program_id));
    const to = byId.get(Number(cross.host_program_id));
    if (!from || !to) continue;
    edges.push({ from, to, residents: cross.resident_count });
  }
  return edges;
}

/** A one-line reading of how busy a node is, for its caption. */
export function describeNodeTraffic(node: NetworkNode): string {
  const out = node.residents_out;
  const inbound = node.residents_in;
  if (out === 0 && inbound === 0) {
    return node.partner_count > 0
      ? `Connected to ${node.partner_count} programme${node.partner_count === 1 ? '' : 's'}, none in use yet`
      : 'No connections yet';
  }
  const parts: string[] = [];
  if (out > 0) parts.push(`${out} resident${out === 1 ? '' : 's'} out`);
  if (inbound > 0) parts.push(`${inbound} in`);
  return parts.join(' · ');
}

/** The wording for one cross-programme posting, as a sentence. */
export function describeCrossRotation(cross: NetworkCrossRotation): string {
  const count = cross.resident_count;
  const rotations =
    cross.rotation_names.length === 1
      ? cross.rotation_names[0]
      : `${cross.rotation_names.length} rotations`;
  const block = cross.latest_block_number === null ? '' : ` (latest Block ${cross.latest_block_number})`;
  return `${count} ${cross.home_program_name} resident${count === 1 ? '' : 's'} in ${rotations} at ${cross.host_program_name}${block}`;
}

/**
 * The plain-language summary a coordinator reads before the diagram.
 *
 * Returns a sentence rather than counts, because "3 partnerships, 1 in use" is
 * read at a glance and 3 / 1 are not.
 */
export function describeNetwork(network: ResidencyNetwork | null): string {
  if (!network) return 'Loading the citywide network…';
  const { programmes, connections, cross_rotations: cross, residents_on_cross_rotation: residents } =
    network.totals;
  if (programmes <= 1) {
    return 'Only one programme is registered, so there are no connections to show yet.';
  }
  if (connections === 0) {
    return `${programmes} programmes are registered but none are connected yet. Connect two to start sharing rotations.`;
  }
  if (cross === 0) {
    return `${connections} partnership${connections === 1 ? '' : 's'} declared across ${programmes} programmes, none in use this year.`;
  }
  return `${connections} partnership${connections === 1 ? '' : 's'} across ${programmes} programmes, carrying ${residents} resident${residents === 1 ? '' : 's'} on ${cross} cross-programme rotation${cross === 1 ? '' : 's'}.`;
}

/**
 * The programmes sharing a hospital with the one in `focusId`, as a sentence.
 *
 * This is the answer to "who are we actually working with", so it counts the
 * observed traffic rather than the declared partnerships — a connection with
 * nobody on it is a plan, not a working relationship.
 */
export function describeFocus(network: ResidencyNetwork | null, focusId: number | null): string | null {
  if (!network || focusId === null) return null;
  const node = network.nodes.find((candidate) => candidate.id === focusId);
  if (!node) return null;
  const partners = network.cross_rotations.filter(
    (cross) => cross.home_program_id === focusId || cross.host_program_id === focusId,
  );
  if (partners.length === 0) {
    return `${node.program_name} has no residents on a cross-programme rotation today.`;
  }
  const total = partners.reduce((sum, cross) => sum + cross.resident_count, 0);
  return `${node.program_name} has ${total} resident${total === 1 ? '' : 's'} exchanging with ${partners.length} partner programme${partners.length === 1 ? '' : 's'} today.`;
}
