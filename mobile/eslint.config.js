// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

// react-native-svg turns any element carrying a touchable prop into a responder.
// On web it does that by writing `onResponderGrant`/`onResponderTerminate` and
// friends onto the raw DOM node (`<circle>`, `<text>`), props React does not
// recognise, so it warns on every render. Those handlers are redundant on web
// anyway: the library forwards `onPress` to `onClick` itself.
//
// So an SVG primitive must never be given a touchable prop. Interaction belongs
// to a real view layered over the drawing.
//
// The rule resolves the element through the file's own imports rather than
// matching the JSX name, so `Text as SvgText` is caught as well — an alias is
// the obvious way this would otherwise slip through, and a name-based selector
// silently allows it.
const MESSAGE =
  'SVG elements must not carry touch handlers: react-native-svg forwards them to the DOM as responder props, which React warns about. Put the handler on a Pressable view layered over the drawing instead.';

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      local: {
        rules: {
          'no-touch-handlers-on-svg': {
            meta: {
              type: 'problem',
              docs: {
                description: 'Disallow touch handlers on react-native-svg primitives.',
              },
              messages: { svgTouch: MESSAGE },
              schema: [],
            },
            create(context) {
              // The SVG primitive modules this package exports. Only these are
              // inert; everything else in the package (Svg, Defs, ...) either
              // wraps the drawing or is not a touch target.
              const primitives = new Set([
                'Circle',
                'Ellipse',
                'G',
                'Image',
                'Line',
                'Marker',
                'Path',
                'Polygon',
                'Polyline',
                'Rect',
                'Text',
                'TextPath',
                'TSpan',
                'Use',
              ]);
              const touchable = new Set(['onPress', 'onPressIn', 'onPressOut', 'onLongPress']);

              // Local names bound to those primitives, so aliases are covered.
              const bound = new Set();

              return {
                ImportDeclaration(node) {
                  if (node.source.value !== 'react-native-svg') return;
                  for (const specifier of node.specifiers) {
                    if (specifier.type !== 'ImportSpecifier') continue;
                    const imported = specifier.imported?.name ?? specifier.imported?.value;
                    if (imported && primitives.has(imported)) {
                      bound.add(specifier.local.name);
                    }
                  }
                },
                JSXOpeningElement(node) {
                  if (node.name.type !== 'JSXIdentifier' || !bound.has(node.name.name)) return;
                  for (const attribute of node.attributes) {
                    if (attribute.type !== 'JSXAttribute') continue;
                    if (touchable.has(attribute.name?.name)) {
                      context.report({ node: attribute, messageId: 'svgTouch' });
                    }
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'local/no-touch-handlers-on-svg': 'error',
    },
  },
]);
