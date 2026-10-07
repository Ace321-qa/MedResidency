import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';

import { radius, shadow, spacing, toneColors, type Tone } from '../theme';
import { Text } from '../components/Text';

/**
 * In-app notifications.
 *
 * The API has no notifications table, so there is no websocket and no push to
 * wait for. What a resident *does* need is an answer to "did that go through?"
 * the instant they submit something — a rotation request that vanishes into a
 * spinner is indistinguishable from one that failed.
 *
 * `notify()` raises a toast that slides in from the top, stays long enough to
 * read, and dismisses itself. The same notice is kept in a module-level list,
 * so a screen can also render the ones raised during this session.
 *
 * Module-level rather than context-only: a submit handler inside a deep
 * component would otherwise need the provider's value threaded down to it.
 * The provider itself only owns the visible toast.
 */

export interface InAppNotice {
  id: string;
  title: string;
  message?: string;
  tone: Tone;
  /** Epoch milliseconds. */
  raisedAt: number;
}

interface NotifyInput {
  title: string;
  message?: string;
  tone?: Tone;
}

const SESSION_NOTICES: InAppNotice[] = [];
const LISTENERS = new Set<(notice: InAppNotice) => void>();
let sequence = 0;

function raise({ title, message, tone = 'info' }: NotifyInput): InAppNotice {
  const notice: InAppNotice = {
    id: `notice-${Date.now()}-${(sequence += 1)}`,
    title,
    message,
    tone,
    raisedAt: Date.now(),
  };

  SESSION_NOTICES.unshift(notice);
  if (SESSION_NOTICES.length > 50) SESSION_NOTICES.pop();

  for (const listener of LISTENERS) listener(notice);
  return notice;
}

/** Notices raised during this app session, newest first. */
export function sessionNotices(): InAppNotice[] {
  return [...SESSION_NOTICES];
}

interface InAppNotificationValue {
  notify: (input: NotifyInput) => void;
  notices: InAppNotice[];
  dismissLatest: () => void;
}

const InAppNotificationContext = createContext<InAppNotificationValue | null>(null);

const TOAST_DISMISS_AFTER_MS = 6000;

export function InAppNotificationProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState<InAppNotice | null>(null);
  // Lazy state, not a ref: the value is read during render (to animate the
  // toast in) as well as in handlers, and a ref must not be read in render.
  const [opacity] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      setVisible(null);
    });
  }, [opacity]);

  const notify = useCallback(
    (input: NotifyInput) => {
      const notice = raise(input);
      setVisible(notice);
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, TOAST_DISMISS_AFTER_MS);
    },
    [hide, opacity],
  );

  const [notices, setNotices] = useState<InAppNotice[]>(() => [...SESSION_NOTICES]);

  useEffect(() => {
    const listener = (notice: InAppNotice) => {
      setNotices((current) => [notice, ...current].slice(0, 50));
    };
    LISTENERS.add(listener);
    return () => {
      LISTENERS.delete(listener);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const dismissLatest = useCallback(() => hide(), [hide]);

  const value = useMemo<InAppNotificationValue>(
    () => ({ notify, notices, dismissLatest }),
    [notify, notices, dismissLatest],
  );

  const palette = visible ? toneColors[visible.tone] : toneColors.info;

  return (
    <InAppNotificationContext.Provider value={value}>
      {children}

      {visible ? (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.toast,
            {
              top: insets.top + spacing.sm,
              backgroundColor: palette.surface,
              borderColor: palette.border,
              opacity,
            },
          ]}
        >
          <View accessible accessibilityRole="alert" accessibilityLabel={`${visible.title}. ${visible.message ?? ''}`} style={styles.toastBody}>
            <View style={[styles.rail, { backgroundColor: palette.foreground }]} />
            <View style={styles.toastText}>
              <Text variant="h3" style={{ color: palette.foreground }}>
                {visible.title}
              </Text>
              {visible.message ? (
                <Text variant="bodySmall" style={{ color: palette.foreground }}>
                  {visible.message}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={hide}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Dismiss notification"
              style={styles.close}
            >
              <X color={palette.foreground} size={16} strokeWidth={2.6} />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </InAppNotificationContext.Provider>
  );
}

export function useInAppNotifications(): InAppNotificationValue {
  const value = useContext(InAppNotificationContext);
  if (!value) {
    throw new Error('useInAppNotifications must be used inside <InAppNotificationProvider>.');
  }
  return value;
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 1000,
    borderRadius: radius.md,
    borderWidth: 1,
    ...shadow.raised,
    ...(Platform.OS === 'web' ? { maxWidth: 480, alignSelf: 'center' } : null),
  },
  toastBody: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    alignItems: 'flex-start',
  },
  rail: {
    width: 6,
    alignSelf: 'stretch',
    borderRadius: radius.pill,
  },
  toastText: {
    flex: 1,
    gap: spacing.xxs,
  },
  close: {
    padding: spacing.xxs,
  },
});
