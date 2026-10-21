import {
  declaredEdges,
  describeCrossRotation,
  describeFocus,
  describeNetwork,
  describeNodeTraffic,
  isConnected,
  nodeHitArea,
  nodeInitials,
  nodeLabel,
  nodeRadius,
  observedEdges,
  project,
  sameProgram,
} from '../src/utils/networkDiagram';
import type { ResidencyNetwork } from '../src/types/api';

/*
 * Checks the residency-network geometry and wording.
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-network-diagram.js
 *
 * The map's arithmetic is what this file guards, because a wrong edge still
 * renders as a plausible line. Three things bite in particular:
 *
 *  - Node size must follow *area*, not radius. A linear radius makes a programme
 *    of forty look sixteen times one of ten, which is a lie about scale.
 *  - A declared partnership is symmetric, so `isConnected` must say yes whichever
 *    way round the pair is stored.
 *  - An edge whose programme is not on the map must be dropped, not drawn to the
 *    origin — a line to nowhere is worse than no line.
 *
 * Pure, so it runs under plain `node` with no React Native runtime.
 */

const failures: string[] = [];
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(
      `  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`,
    );
  }
}

function node(id: number, name: string, x: number, y: number, residents: number) {
  return {
    id,
    program_code: `P${id}`,
    program_name: name,
    specialty_name: null,
    institution_name: null,
    resident_count: residents,
    position: { x, y },
    residents_out: 0,
    residents_in: 0,
    partner_count: 0,
  };
}

function network(partial: Partial<ResidencyNetwork>): ResidencyNetwork {
  return {
    nodes: [],
    connections: [],
    cross_rotations: [],
    totals: { programmes: 0, connections: 0, cross_rotations: 0, residents_on_cross_rotation: 0 },
    ...partial,
  };
}

console.log('-- project: percentages into the drawing area --');
check('the centre maps to the centre', project({ x: 50, y: 50 }, 100, 0), { x: 50, y: 50 });
check('the origin maps to the origin', project({ x: 0, y: 0 }, 100, 0), { x: 0, y: 0 });
check('the far corner maps to the far corner', project({ x: 100, y: 100 }, 100, 0), {
  x: 100,
  y: 100,
});
check('an inset keeps the point inside the box', project({ x: 0, y: 0 }, 100, 10), { x: 10, y: 10 });
check('a position beyond the box is clamped', project({ x: 250, y: -50 }, 100, 0), {
  x: 100,
  y: 0,
});
check('an unreadable position falls back to the centre', project({ x: NaN, y: NaN }, 100, 0), {
  x: 50,
  y: 50,
});

console.log('\n-- nodeRadius: area, not radius, carries the scale --');
check('an empty programme is the minimum', nodeRadius(0), 9);
check('one resident is the minimum plus its root', nodeRadius(1), 11.2);
check('the radius grows with the square root', nodeRadius(4), 13.4);
check('a huge programme is capped', nodeRadius(10000), 22);
check('a negative count is treated as zero', nodeRadius(-5), 9);
check('an unreadable count is treated as zero', nodeRadius(Number.NaN), 9);
// The point of the square root: quadrupling the cohort must not quadruple the
// radius. Linear growth would put 40 at four times the size of 10.
{
  const small = nodeRadius(10);
  const large = nodeRadius(40);
  checkThat('quadrupling the cohort less than doubles the radius', large < small * 2);
  checkThat('but the radius still grows', large > small);
}

console.log('\n-- sameProgram tolerates string ids --');
check('equal numbers match', sameProgram(3, 3), true);
check('a string id matches its number', sameProgram('3', 3), true);
check('different programmes do not match', sameProgram(3, 4), false);
check('null never matches', sameProgram(null, 3), false);

console.log('\n-- isConnected: a partnership is symmetric --');
{
  const connections = [
    {
      id: 1,
      source_program_id: 2,
      source_program_name: 'B',
      target_program_id: 1,
      target_program_name: 'A',
      connection_type: 'HOSPITAL_ROTATION' as const,
      is_active: 1,
    },
  ];
  check('the stored direction reads as connected', isConnected(connections, 2, 1), true);
  check('the reverse direction reads as connected too', isConnected(connections, 1, 2), true);
  check('an unrelated pair is not connected', isConnected(connections, 1, 3), false);
  check(
    'a withdrawn connection is not a connection',
    isConnected([{ ...connections[0], is_active: 0 }], 1, 2),
    false,
  );
}

console.log('\n-- edges: drawn between real nodes only --');
{
  const data = network({
    nodes: [node(1, 'Family Medicine', 50, 18, 162), node(2, 'Internal Medicine', 82, 50, 1)],
    connections: [
      {
        id: 7,
        source_program_id: 1,
        source_program_name: 'Family Medicine',
        target_program_id: 2,
        target_program_name: 'Internal Medicine',
        connection_type: 'HOSPITAL_ROTATION',
        is_active: 1,
      },
      {
        id: 8,
        source_program_id: 1,
        source_program_name: 'Family Medicine',
        target_program_id: 99,
        target_program_name: 'A programme not on the map',
        connection_type: 'CLINIC_EXCHANGE',
        is_active: 1,
      },
      {
        id: 9,
        source_program_id: 1,
        source_program_name: 'Family Medicine',
        target_program_id: 2,
        target_program_name: 'Internal Medicine',
        connection_type: 'ACADEMIC_PARTNERSHIP',
        is_active: 0,
      },
    ],
    cross_rotations: [
      {
        home_program_id: 1,
        home_program_name: 'Family Medicine',
        host_program_id: 2,
        host_program_name: 'Internal Medicine',
        resident_count: 3,
        assignment_count: 3,
        rotation_names: ['Inpatient Medicine'],
        department_names: ['Internal Medicine'],
        latest_block_number: 6,
      },
      {
        home_program_id: 5,
        home_program_name: 'Not on the map',
        host_program_id: 2,
        host_program_name: 'Internal Medicine',
        resident_count: 1,
        assignment_count: 1,
        rotation_names: ['X'],
        department_names: [],
        latest_block_number: null,
      },
    ],
  });

  const declared = declaredEdges(data);
  check('only the active connection between two on-map programmes is drawn', declared.length, 1);
  check('the drawn edge is the expected pair', declared[0]?.from.id, 1);
  check('and ends at the partner', declared[0]?.to.id, 2);

  const observed = observedEdges(data);
  check('only the on-map cross-rotation is drawn', observed.length, 1);
  check('it carries its resident count for the stroke weight', observed[0]?.residents, 3);
  check('a null network yields no edges', declaredEdges(null).length + observedEdges(null).length, 0);
}

console.log('\n-- labels --');
check('a code is preferred as the label', nodeLabel({ program_code: 'IM-01', program_name: 'Internal Medicine' }), 'IM-01');
check(
  'a long name is clipped when there is no code',
  nodeLabel({ program_code: '', program_name: 'A Very Long Programme Name Indeed' }),
  'A Very Long P…',
);
check('initials come from the words', nodeInitials({ program_name: 'Family Medicine Residency' }), 'FMR');
check('single letters are skipped', nodeInitials({ program_name: 'A B Pediatrics' }), 'P');
check('at most three initials', nodeInitials({ program_name: 'One Two Three Four Five' }), 'OTT');
check('a nameless programme has no initials', nodeInitials({ program_name: '' }), '');

console.log('\n-- descriptions --');
check('an idle connected node says so', describeNodeTraffic({ ...node(1, 'A', 0, 0, 5), partner_count: 2 }), 'Connected to 2 programmes, none in use yet');
check('an isolated node says so', describeNodeTraffic(node(1, 'A', 0, 0, 5)), 'No connections yet');
check('outbound traffic is named', describeNodeTraffic({ ...node(1, 'A', 0, 0, 5), residents_out: 3 }), '3 residents out');
check('inbound traffic is named', describeNodeTraffic({ ...node(1, 'A', 0, 0, 5), residents_in: 2 }), '2 in');
check('an outgoing and incoming node reads both', describeNodeTraffic({ ...node(1, 'A', 0, 0, 5), residents_out: 3, residents_in: 2 }), '3 residents out · 2 in');

{
  const cross = {
    home_program_id: 1,
    home_program_name: 'Family Medicine',
    host_program_id: 2,
    host_program_name: 'Internal Medicine',
    resident_count: 3,
    assignment_count: 3,
    rotation_names: ['Inpatient Medicine'],
    department_names: ['Internal Medicine'],
    latest_block_number: 6,
  };
  check(
    'a single rotation is named',
    describeCrossRotation(cross),
    '3 Family Medicine residents in Inpatient Medicine at Internal Medicine (latest Block 6)',
  );
  check(
    'several rotations are counted, not listed',
    describeCrossRotation({ ...cross, rotation_names: ['A', 'B'], resident_count: 1 }),
    '1 Family Medicine resident in 2 rotations at Internal Medicine (latest Block 6)',
  );
}

console.log('\n-- the summary sentence --');
check('a lone programme is explained', describeNetwork(network({ totals: { programmes: 1, connections: 0, cross_rotations: 0, residents_on_cross_rotation: 0 } })), 'Only one programme is registered, so there are no connections to show yet.');
check(
  'no connections says so',
  describeNetwork(network({ totals: { programmes: 4, connections: 0, cross_rotations: 0, residents_on_cross_rotation: 0 } })),
  '4 programmes are registered but none are connected yet. Connect two to start sharing rotations.',
);
check(
  'a declared partnership with nobody on it is not flattered',
  describeNetwork(network({ totals: { programmes: 4, connections: 1, cross_rotations: 0, residents_on_cross_rotation: 0 } })),
  '1 partnership declared across 4 programmes, none in use this year.',
);
check(
  'traffic is counted',
  describeNetwork(network({ totals: { programmes: 4, connections: 2, cross_rotations: 1, residents_on_cross_rotation: 3 } })),
  '2 partnerships across 4 programmes, carrying 3 residents on 1 cross-programme rotation.',
);
check('a null network is reported as loading', describeNetwork(null), 'Loading the citywide network…');

{
  const data = network({
    nodes: [node(1, 'Family Medicine', 0, 0, 5), node(2, 'Internal Medicine', 0, 0, 5)],
    cross_rotations: [
      {
        home_program_id: 1,
        home_program_name: 'Family Medicine',
        host_program_id: 2,
        host_program_name: 'Internal Medicine',
        resident_count: 2,
        assignment_count: 2,
        rotation_names: ['Wards'],
        department_names: [],
        latest_block_number: 6,
      },
    ],
  });
  check(
    'focus names the partner traffic',
    describeFocus(data, 1),
    'Family Medicine has 2 residents exchanging with 1 partner programme today.',
  );
  check(
    'a programme with no exchanges says so',
    describeFocus({ ...data, cross_rotations: [] }, 1),
    'Family Medicine has no residents on a cross-programme rotation today.',
  );
  check('no focus, no sentence', describeFocus(data, null), null);
}

/*
 * The touch layer.
 *
 * Nothing inside the SVG may be pressable. `react-native-svg` converts an
 * element carrying any touchable prop into a responder and, on web, writes
 * `onResponderGrant`/`onResponderTerminate` and friends onto the raw DOM node —
 * props React does not recognise, so it warns on every render. Interaction lives
 * in a view per node instead, and these checks hold that layer to the geometry
 * the circles are drawn with.
 */
function checkHitAreas(): void {
  const size = 300;
  const inset = 26;
  const at = (x: number, y: number) => nodeHitArea({ position: { x, y } }, size, inset);
  const pct = (value: unknown) => Number.parseFloat(String(value));

  const topLeft = at(0, 0);

  // A node at 0,0 sits at the inset, so its hit area starts before its centre by
  // the padding: this is what keeps a corner node tappable rather than clipped.
  checkThat('a corner hit area is a percentage', String(topLeft.left).endsWith('%'));
  checkThat('a hit area is square', topLeft.width === topLeft.height);

  const leftPct = pct(topLeft.left);
  const widthPct = pct(topLeft.width);
  checkThat('a corner hit area reaches past its circle centre', leftPct + widthPct > leftPct);

  const centre = at(50, 50);
  checkThat('a centred node starts left of the middle', pct(centre.left) < 50);

  // A hit area must be big enough to touch. The smallest node radius is 9, and
  // with 6 units of padding the target is at least 30 units across on a 300 box.
  checkThat('the smallest target clears 30 units across', pct(centre.width) >= (30 / size) * 100);

  // Every node gets a target whose centre is the projected point, so a tap lands
  // on the programme whose circle was drawn there.
  const drawn = project({ x: 50, y: 50 }, size, inset);
  const areaCentreX = pct(centre.left) + pct(centre.width) / 2;
  checkThat(
    'a hit area is centred on its circle',
    Math.abs((areaCentreX / 100) * size - drawn.x) < 0.001,
  );

  // Clamping still applies: an out-of-range coordinate cannot push a target off
  // the drawing area.
  const wild = at(999, -999);
  checkThat('an out-of-range node is clamped inside the box', pct(wild.left) + pct(wild.width) <= 100);
}

function checkThat(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}`);
  }
}

checkHitAreas();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${passed} network-diagram checks passed.`);
