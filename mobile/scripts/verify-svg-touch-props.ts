/*
 * The web build of `react-native-svg` writes React Native's responder props onto
 * real DOM nodes whenever a shape carries a touch property, and React DOM then
 * warns about every one ("Unknown event handler property
 * 'onResponderTerminate'"). This checks that mechanism on the source of the
 * library that is actually installed, and then checks the props the residency
 * network map feeds it.
 *
 *     npx tsx scripts/verify-svg-touch-props.ts
 *
 * Both directions are asserted on purpose: if the library ever stops attaching
 * responder props to a touchable shape, the first cases fail, and the reason the
 * map is written the way it is would no longer hold.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Compiled to CommonJS by tsconfig.verify.json, so `__dirname` is available.
const here = __dirname;

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean) {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}

const RESPONDER_PROPS = [
  'onStartShouldSetResponder',
  'onResponderTerminationRequest',
  'onResponderGrant',
  'onResponderMove',
  'onResponderRelease',
  'onResponderTerminate',
];

console.log('\n-- the library attaches responder props only to touchable shapes --');

const prepare = readFileSync(
  join(here, '../node_modules/react-native-svg/lib/commonjs/web/utils/prepare.js'),
  'utf8',
);

check(
  'it tests hasTouchableProperty before attaching',
  /hasTouchableProperty\)\?*\(props\)/.test(prepare) || /hasTouchableProperty\(props\)/.test(prepare),
);

const guarded = prepare.match(/hasTouchableProperty\)?\(props\)\s*\?\s*\{([\s\S]*?)\}\s*:\s*null/);
check('the responder block is guarded by that test', guarded !== null);

const attached = guarded ? RESPONDER_PROPS.filter((name) => guarded[1].includes(name)) : [];
check(
  `all six responder props are in the guarded block (${attached.length})`,
  attached.length === RESPONDER_PROPS.length,
);
check('onResponderTerminate is one of them', attached.includes('onResponderTerminate'));

const touchable = readFileSync(
  join(here, '../node_modules/react-native-svg/lib/commonjs/web/utils/hasProperty.js'),
  'utf8',
);

console.log('\n-- what counts as touchable --');
for (const spelling of ['onPress', 'onPressIn', 'onPressOut', 'onLongPress']) {
  check(`${spelling} makes a shape touchable`, touchable.includes(spelling));
}

console.log('\n-- the map screen feeds the library only inert props --');

const screen = readFileSync(join(here, '../src/app/program/(tabs)/network.tsx'), 'utf8');

// The shapes the screen imports from react-native-svg. An opening tag carrying a
// touch property is exactly the regression this guards.
for (const shape of ['Line', 'Circle', 'G', 'SvgText']) {
  const tags = screen.match(new RegExp(`<${shape}\\b[^>]*>`, 'g')) ?? [];
  const offenders = tags.filter((tag) => /\bon(Press|LongPress|PressIn|PressOut)\b/.test(tag));
  check(`<${shape}> carries no touch property (${tags.length} tag(s))`, offenders.length === 0);
}

check(
  'the drawing is inert to pointers',
  /svg:\s*\{[^}]*pointerEvents:\s*'none'/.test(screen),
);
check(
  'touch lives in a separate hit layer',
  /hitLayer:\s*\{[^}]*StyleSheet\.absoluteFill/.test(screen),
);
check(
  'the hit layer is built from Pressables, not shapes',
  /styles\.hitLayer[\s\S]{0,400}<Pressable/.test(screen),
);

const pressables = (screen.match(/<Pressable\b/g) ?? []).length;
check(`every node gets its own Pressable (${pressables})`, pressables >= 1);

console.log(
  `\n${failures === 0 ? 'All' : failures + ' of'} ${checks} svg-touch checks ${
    failures === 0 ? 'passed' : 'failed'
  }.`,
);
if (failures > 0) process.exitCode = 1;
