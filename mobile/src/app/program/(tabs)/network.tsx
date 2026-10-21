import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ArrowLeftRight, Building2, Link2, Network as NetworkIcon } from 'lucide-react-native';
import Svg, { Circle, G, Line, Text as SvgText } from 'react-native-svg';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
  StatusBadge,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchResidencyNetwork } from '../../../services/programs';
import { colors, radius, spacing } from '../../../theme';
import {
  declaredEdges,
  describeCrossRotation,
  describeFocus,
  describeNetwork,
  describeNodeTraffic,
  nodeHitArea,
  nodeInitials,
  nodeLabel,
  nodeRadius,
  observedEdges,
  project,
} from '../../../utils/networkDiagram';
import type { NetworkNode, ResidencyNetwork } from '../../../types/api';

/**
 * Residency Network — the citywide view of who rotates into whom.
 *
 * A coordinator's own programme is one box in a city of programmes, and until
 * now the app showed them only their own. This screen draws the whole picture:
 * every active programme as a node, the partnerships declared between them, and
 * the cross-programme postings actually standing today.
 *
 * ## Why the diagram is paired with a list
 *
 * A node map is the fastest way to see the shape of a network, and the worst way
 * to read a single fact from it: overlapping edges on a small screen defeat any
 * amount of care taken with the layout. So the map is the overview and the rows
 * below it are the detail, and every relationship drawn as a line is also
 * written as a sentence. A coordinator who cannot use the map loses nothing.
 *
 * ## Declared versus observed
 *
 * A solid line is a declared partnership; a dashed line is residents actually
 * moving along it. The two are drawn differently on purpose — a partnership with
 * nobody on it is a plan, not a working relationship, and merging them would
 * flatter an empty agreement into looking like traffic.
 */

const DIAGRAM_SIZE = 300;
const NODE_INSET = 26;

export default function NetworkScreen() {
  const { session } = useSession();
  const network = useApiResource(fetchResidencyNetwork);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focusOnly, setFocusOnly] = useState(false);

  const data = network.data ?? null;

  const selected = useMemo(
    () => data?.nodes.find((node) => node.id === selectedId) ?? null,
    [data, selectedId],
  );

  const focusId = session?.programId ?? null;

  return (
    <Screen
      onRefresh={network.refresh}
      refreshing={network.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Residency Network" subtitle={session?.programLabel ?? 'Citywide view'} />

      {network.isLoading ? <SkeletonList rows={5} /> : null}

      {network.error ? (
        <ErrorState
          title="Could not load the residency network"
          message={network.error.message}
          onRetry={network.refresh}
        />
      ) : null}

      {data ? (
        <>
          <Banner
            tone="info"
            title="How the city is connected"
            message={describeNetwork(data)}
          />

          <View style={styles.tiles}>
            <StatTile
              value={String(data.totals.programmes)}
              label="Programmes"
              icon={Building2}
            />
            <StatTile
              value={String(data.totals.connections)}
              label="Partnerships"
              icon={Link2}
            />
            <StatTile
              value={String(data.totals.residents_on_cross_rotation)}
              label="On cross rotations"
              icon={ArrowLeftRight}
            />
          </View>

          <Card>
            <View style={styles.mapHeader}>
              <Text variant="h3">Connections map</Text>
              <Button
                label={focusOnly ? 'Show all programmes' : 'Focus my programme'}
                variant="ghost"
                fullWidth={false}
                disabled={focusId === null}
                onPress={() => setFocusOnly((value) => !value)}
                accessibilityHint="Highlight the cross-programme rotations involving your own programme."
              />
            </View>

            <NetworkMap
              network={data}
              selectedId={selectedId}
              onSelect={setSelectedId}
              focusId={focusOnly ? focusId : null}
            />

            <View style={styles.legend}>
              <LegendItem swatch={<View style={styles.solidSwatch} />} label="Declared partnership" />
              <LegendItem swatch={<View style={styles.dashedSwatch} />} label="Residents moving today" />
            </View>

            {focusOnly && focusId !== null ? (
              <Text variant="bodySmall" tone="secondary">
                {describeFocus(data, focusId)}
              </Text>
            ) : null}

            <Text variant="caption" tone="muted">
              Node size shows how many residents a programme holds. Tap a programme for its detail.
            </Text>
          </Card>

          {selected ? <NodeDetail node={selected} /> : null}

          <SectionHeader
            title="Cross-programme rotations"
            trailing={
              data.cross_rotations.length > 0 ? String(data.cross_rotations.length) : undefined
            }
          />

          {data.cross_rotations.length > 0 ? (
            <Text variant="caption" tone="muted">
              Where residents are standing right now, and in which programme&apos;s departments.
            </Text>
          ) : null}

          {data.cross_rotations.length === 0 ? (
            <Card>
              <EmptyState
                icon={NetworkIcon}
                title="No cross-programme rotations today"
                message="Every resident is currently placed in a rotation owned by their own programme. Cross-programme postings appear here as soon as one is made."
              />
            </Card>
          ) : (
            <View style={styles.list}>
              {data.cross_rotations.map((cross) => (
                <Card key={`${cross.home_program_id}-${cross.host_program_id}`}>
                  <View style={styles.crossRow}>
                    <StatusBadge
                      label={`${cross.resident_count} resident${cross.resident_count === 1 ? '' : 's'}`}
                      tone="info"
                    />
                    <Text variant="bodySmall" tone="secondary">
                      {describeCrossRotation(cross)}
                    </Text>
                  </View>
                  {cross.department_names.length > 0 ? (
                    <Text variant="caption" tone="muted">
                      Departments: {cross.department_names.join(', ')}
                    </Text>
                  ) : null}
                </Card>
              ))}
            </View>
          )}

          <SectionHeader title="Programmes" trailing={String(data.nodes.length)} />

          <Text variant="caption" tone="muted">
            Every active programme, and what it is exchanging.
          </Text>

          <View style={styles.list}>
            {data.nodes.map((node) => (
              <Card key={node.id}>
                <View style={styles.nodeRow}>
                  <View style={styles.nodeTitle}>
                    <Text variant="body">
                      {node.program_name}
                      {node.id === focusId ? ' (you)' : ''}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {node.program_code}
                      {node.institution_name ? ` · ${node.institution_name}` : ''}
                    </Text>
                  </View>
                  {focusId !== null && node.id !== focusId && data.connections.some(
                    (connection) =>
                      connection.is_active === 1 &&
                      ((connection.source_program_id === focusId && connection.target_program_id === node.id) ||
                        (connection.target_program_id === focusId && connection.source_program_id === node.id)),
                  ) ? (
                    <StatusBadge label="Connected" tone="success" checked />
                  ) : null}
                </View>
                <Text variant="bodySmall" tone="secondary">
                  {node.resident_count} enrolled · {describeNodeTraffic(node)}
                </Text>
              </Card>
            ))}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

/**
 * The node map.
 *
 * Drawn with `react-native-svg` so lines and labels scale with the container
 * rather than being positioned with absolute offsets that break at a different
 * width.
 *
 * ## Why nothing inside the SVG is pressable
 *
 * The shapes here deliberately carry no `onPress`. Giving one to a `<Circle>`
 * makes `react-native-svg` register a responder for it, and on web that means
 * writing `onResponderGrant`/`onResponderTerminate` onto the underlying
 * `<circle>` — props React does not recognise on a DOM node, so it warns on
 * every render. The handlers are not even needed there, because on web the
 * library forwards `onPress` to `onClick` itself.
 *
 * Touch therefore lives in a layer of real views above the drawing, one per
 * node, positioned from the same `project()` calls that place the circles. That
 * is where a responder belongs, it keeps each node's hit area its own, and the
 * whole drawing stays a single tap target per programme instead of one giant
 * rectangle over all of them.
 */
function NetworkMap({
  network,
  selectedId,
  onSelect,
  focusId,
}: {
  network: ResidencyNetwork;
  selectedId: number | null;
  onSelect: (id: number) => void;
  focusId: number | null;
}) {
  const declared = declaredEdges(network);
  const observed = observedEdges(network);

  return (
    <View style={styles.diagram}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${DIAGRAM_SIZE} ${DIAGRAM_SIZE}`}
        style={styles.svg}
      >
        {/* Declared partnerships first, so a line never covers a node. */}
        {declared.map((edge) => {
          const from = project(edge.from.position, DIAGRAM_SIZE, NODE_INSET);
          const to = project(edge.to.position, DIAGRAM_SIZE, NODE_INSET);
          return (
            <Line
              key={`declared-${edge.id}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={colors.border}
              strokeWidth={2}
            />
          );
        })}

        {observed.map((edge) => {
          const from = project(edge.from.position, DIAGRAM_SIZE, NODE_INSET);
          const to = project(edge.to.position, DIAGRAM_SIZE, NODE_INSET);
          return (
            <Line
              key={`observed-${edge.from.id}-${edge.to.id}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={colors.primary}
              strokeWidth={2 + Math.min(3, edge.residents)}
              strokeDasharray="6 4"
            />
          );
        })}

        {network.nodes.map((node) => {
          const point = project(node.position, DIAGRAM_SIZE, NODE_INSET);
          const radius = nodeRadius(node.resident_count);
          const isFocus = focusId !== null && node.id === focusId;
          const isSelected = selectedId === node.id;
          return (
            <G key={node.id}>
              <Circle
                cx={point.x}
                cy={point.y}
                r={radius}
                fill={isFocus ? colors.primary : colors.surfaceMuted}
                stroke={isSelected ? colors.primary : colors.border}
                strokeWidth={isSelected || isFocus ? 3 : 1.5}
              />
              <SvgText
                x={point.x}
                y={point.y + 4}
                fontSize={radius > 14 ? 12 : 10}
                fontWeight="600"
                fill={isFocus ? colors.onPrimary : colors.textPrimary}
                textAnchor="middle"
              >
                {nodeInitials(node)}
              </SvgText>
              <SvgText
                x={point.x}
                y={point.y + radius + 12}
                fontSize={9}
                fill={colors.textMuted}
                textAnchor="middle"
              >
                {nodeLabel(node)}
              </SvgText>
            </G>
          );
        })}
      </Svg>

      {/* The touch layer: one view per node, over the drawing rather than in it. */}
      <View style={styles.hitLayer}>
        {network.nodes.map((node) => (
          <Pressable
            key={`hit-${node.id}`}
            style={[styles.nodeHit, nodeHitArea(node, DIAGRAM_SIZE, NODE_INSET)]}
            onPress={() => onSelect(node.id)}
            accessibilityRole="button"
            accessibilityLabel={`${node.program_name}, ${node.resident_count} residents`}
            accessibilityState={{ selected: selectedId === node.id }}
            accessibilityHint="Shows this programme's detail."
          />
        ))}
      </View>
    </View>
  );
}

function NodeDetail({ node }: { node: NetworkNode }) {
  return (
    <Card>
      <View style={styles.detailHeader}>
        <Text variant="h3">{node.program_name}</Text>
        <StatusBadge label={`${node.resident_count} residents`} tone="neutral" />
      </View>
      {node.specialty_name ? (
        <Text variant="bodySmall" tone="secondary">
          {node.specialty_name}
          {node.institution_name ? ` · ${node.institution_name}` : ''}
        </Text>
      ) : null}
      <Text variant="bodySmall">{describeNodeTraffic(node)}</Text>
      <Text variant="caption" tone="muted">
        {node.partner_count} declared partnership{node.partner_count === 1 ? '' : 's'} ·{' '}
        {node.residents_out} resident{node.residents_out === 1 ? '' : 's'} out · {node.residents_in} in
      </Text>
    </Card>
  );
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <View style={styles.legendItem}>
      {swatch}
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  mapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  diagram: {
    aspectRatio: 1,
    width: '100%',
    marginTop: spacing.sm,
  },
  svg: {
    // Static geometry only — every touch target is a view in `hitLayer`.
    pointerEvents: 'none',
  },
  hitLayer: {
    ...StyleSheet.absoluteFill,
  },
  nodeHit: {
    position: 'absolute',
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  solidSwatch: {
    width: 22,
    height: 2,
    backgroundColor: colors.border,
  },
  dashedSwatch: {
    width: 22,
    height: 3,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
  },
  list: {
    gap: spacing.sm,
  },
  crossRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
    marginBottom: spacing.xs,
  },
  nodeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  nodeTitle: {
    gap: 2,
    flexShrink: 1,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
});
