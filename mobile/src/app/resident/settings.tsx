import { StyleSheet, View } from 'react-native';
import { Database, LogOut, Server } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DetailRow,
  Screen,
  SectionHeader,
  Text,
} from '../../components';
import { useApiResource, useSession } from '../../hooks';
import { API_BASE_URL, DEFAULT_PROGRAM_ID, FALLBACK_RESIDENT_ID } from '../../config/env';
import { goBack } from '../../navigation/back';
import { fetchHealth } from '../../services/health';
import { colors, spacing } from '../../theme';
import { formatDateTime } from '../../utils/format';

/**
 * Settings — and the one screen that makes the app's assumptions visible.
 *
 * The API address, the fallback resident id and the health check are all on
 * screen on purpose. When a resident reports "the app is broken" the first
 * question is which server it is talking to, and this answers it without a
 * debugger.
 */
export default function SettingsScreen() {
  const { session, signOut } = useSession();
  const health = useApiResource(fetchHealth);

  const reachable = health.status === 'ready';
  const dbConnected = reachable && health.data?.database.connected === true;

  return (
    <Screen
      onRefresh={health.refresh}
      refreshing={health.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Settings" onBack={goBack} />

      <SectionHeader title="Connection" />
      <Card>
        <View style={styles.statusRow}>
          <Server color={reachable ? colors.success : colors.danger} size={18} />
          <Text variant="h3">{reachable ? 'API reachable' : health.status === 'loading' ? 'Checking…' : 'API unreachable'}</Text>
        </View>

        <DetailRow label="API base URL" value={API_BASE_URL} />
        <DetailRow
          label="Database"
          value={
            health.status === 'ready'
              ? `${health.data?.database.database_name ?? 'unknown'} · ${
                  dbConnected ? 'connected' : 'not connected'
                }`
              : health.status === 'loading'
                ? 'checking…'
                : 'unreachable'
          }
        />
        {health.data ? (
          <DetailRow label="Server time" value={formatDateTime(health.data.timestamp)} />
        ) : null}

        {health.error ? (
          <Banner
            tone="danger"
            title="Could not reach the API"
            message={`${health.error.message} — check EXPO_PUBLIC_API_URL, then reload the app.`}
          />
        ) : null}

        {dbConnected ? (
          <View style={styles.row}>
            <Database color={colors.success} size={14} />
            <Text variant="caption" tone="secondary">
              Server reported a healthy database connection
            </Text>
          </View>
        ) : null}
      </Card>

      <SectionHeader title="Session" />
      <Card>
        <DetailRow label="Signed in as" value={session?.residentName ?? '—'} />
        <DetailRow label="Role" value={session?.role === 'resident' ? 'Resident' : 'Coordinator'} />
        <DetailRow label="Resident id" value={String(session?.residentId ?? '—')} />
        <DetailRow label="Programme id" value={String(session?.programId ?? '—')} />
      </Card>

      <Banner
        tone="info"
        title="No authentication yet"
        message="This build has no sign-in endpoint, so the session above is chosen on the sign-in screen and cleared when you sign out."
      />

      <SectionHeader title="Defaults" />
      <Card>
        <DetailRow label="Fallback resident id" value={String(FALLBACK_RESIDENT_ID)} />
        <DetailRow label="Fallback programme id" value={String(DEFAULT_PROGRAM_ID)} />
        <Text variant="caption" tone="muted" style={styles.note}>
          Used only when a screen runs before anyone has signed in. Override with EXPO_PUBLIC_API_URL and
          EXPO_PUBLIC_FALLBACK_RESIDENT_ID.
        </Text>
      </Card>

      <View style={styles.actions}>
        <Button label="Re-test connection" variant="outline" onPress={health.refresh} />
        <Button
          label="Sign out"
          variant="danger"
          icon={LogOut}
          onPress={signOut}
          accessibilityHint="Clears the local session and returns to the sign-in screen"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  note: {
    marginTop: spacing.sm,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
});