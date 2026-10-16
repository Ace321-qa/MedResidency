import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { BellOff, CheckCheck } from 'lucide-react-native';

import {
  AppHeader,
  Button,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
} from '../../components';
import { useApiResource, useSession } from '../../hooks';
import { goBack } from '../../navigation/back';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../services/notifications';
import type { Notification, NotificationType } from '../../types/api';
import { spacing, type Tone } from '../../theme';
import { formatDateTime } from '../../utils/format';
import { EMPTY_ARRAY } from '../../utils/empty';

/**
 * Notifications — persisted rows the backend writes when something happens to
 * this resident (a duty-hour breach, a leave decision, a rotation assignment).
 *
 * Read state is posted to the API rather than tracked in memory, so it survives
 * sign-out. The list polls every 30 seconds: there is no push channel, and a
 * decision made by a coordinator elsewhere should appear without a manual pull.
 */

type Filter = 'ALL' | 'UNREAD';

/** Category label and colour for each notification type. */
const TYPE_META: Record<NotificationType, { label: string; tone: Tone }> = {
  DUTY_HOUR_BREACH: { label: 'Compliance', tone: 'danger' },
  LEAVE_STATUS: { label: 'Administrative', tone: 'warning' },
  ROTATION_APPROVAL: { label: 'Schedule', tone: 'info' },
  SYSTEM_ALERT: { label: 'System', tone: 'danger' },
  GENERAL: { label: 'General', tone: 'neutral' },
};

/** Where a notification type takes the resident when tapped. */
const HREF_BY_TYPE: Partial<Record<NotificationType, Href>> = {
  DUTY_HOUR_BREACH: '/resident/duty-hours',
  LEAVE_STATUS: '/resident/requests',
  ROTATION_APPROVAL: '/resident/rotations',
};

export default function NotificationsScreen() {
  const router = useRouter();
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const notifications = useApiResource(() => fetchNotifications(residentId), [residentId]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [query, setQuery] = useState('');
  const [markingAll, setMarkingAll] = useState(false);

  const { setData } = notifications;
  const all = useMemo(() => notifications.data ?? (EMPTY_ARRAY as Notification[]), [
    notifications.data,
  ]);

  /** Poll on an interval without touching the pull-to-refresh indicator. */
  useEffect(() => {
    if (!residentId) return undefined;

    let cancelled = false;
    const tick = () => {
      fetchNotifications(residentId)
        .then((next) => {
          if (!cancelled) setData(next);
        })
        .catch(() => {});
    };

    const timer = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [residentId, setData]);

  const unreadCount = useMemo(() => all.filter((item) => !item.is_read).length, [all]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter((item) => (filter === 'ALL' ? true : !item.is_read))
      .filter((item) =>
        needle ? `${item.title} ${item.message}`.toLowerCase().includes(needle) : true,
      );
  }, [all, filter, query]);

  const markRead = (item: Notification) => {
    notifications.setData((current) =>
      current
        ? current.map((row) => (row.id === item.id ? { ...row, is_read: true } : row))
        : current,
    );
    markNotificationRead(item.id, residentId)
      .then((updated) =>
        notifications.setData((current) =>
          current ? current.map((row) => (row.id === updated.id ? updated : row)) : current,
        ),
      )
      .catch(() => {
        // Optimistic state stands; the next poll re-syncs with the server.
      });
  };

  const handlePress = (item: Notification) => {
    markRead(item);
    const target = HREF_BY_TYPE[item.type];
    if (target) router.push(target);
  };

  const markEverythingRead = async () => {
    setMarkingAll(true);
    try {
      await markAllNotificationsRead(residentId);
      notifications.setData((current) =>
        current ? current.map((row) => ({ ...row, is_read: true })) : current,
      );
    } catch {
      // Leave as-is; the next poll re-syncs.
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <Screen
      onRefresh={notifications.refresh}
      refreshing={notifications.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Notifications" onBack={goBack} />

      {notifications.isLoading ? <SkeletonList rows={5} /> : null}

      {notifications.error ? (
        <ErrorState
          title="Could not load"
          message={notifications.error.message}
          onRetry={notifications.refresh}
        />
      ) : null}

      <ChoiceGroup
        label="Filter notifications"
        columns={2}
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        options={[
          { value: 'ALL', label: `All (${all.length})` },
          { value: 'UNREAD', label: `Unread (${unreadCount})` },
        ]}
      />

      {notifications.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search notifications"
              value={query}
              onChangeText={setQuery}
              placeholder="Search notifications"
            />
          </View>

          {unreadCount > 0 ? (
            <Button
              label={`Mark all ${unreadCount} as read`}
              variant="outline"
              fullWidth={false}
              icon={CheckCheck}
              loading={markingAll}
              onPress={markEverythingRead}
              accessibilityHint="Marks every unread notification as read on the server"
            />
          ) : null}

          <SectionHeader title={`${visible.length} shown`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={BellOff}
                title="Nothing to read"
                message={
                  query
                    ? 'No notification matches that search.'
                    : 'No notifications yet. Duty-hour breaches, leave decisions and rotation approvals will appear here.'
                }
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((item: Notification, index) => (
                <ListRow
                  key={item.id}
                  title={item.title}
                  subtitle={item.message}
                  meta={`${TYPE_META[item.type].label} · ${formatDateTime(item.created_at)}`}
                  trailing={
                    <StatusBadge
                      label={item.is_read ? 'Read' : 'New'}
                      tone={item.is_read ? 'neutral' : TYPE_META[item.type].tone}
                    />
                  }
                  onPress={() => handlePress(item)}
                  last={index === visible.length - 1}
                  accessibilityHint={
                    HREF_BY_TYPE[item.type]
                      ? 'Opens this notification and marks it read'
                      : 'Marks this notification as read'
                  }
                />
              ))}
            </Card>
          )}

          <Text variant="caption" tone="muted" style={styles.footnote}>
            Notifications refresh automatically every 30 seconds.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginTop: spacing.md,
  },
  footnote: {
    marginTop: spacing.md,
  },
});
