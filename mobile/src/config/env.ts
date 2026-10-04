import { Platform } from 'react-native';

/**
 * Where the app points, and who it is acting as.
 *
 * Security note: this file is bundled *into* the app, so anything here is
 * visible to anyone who unzips the build. Only the API's public address belongs
 * here — never a database password, never an admin token. The MySQL credentials
 * live only in the Node backend's environment.
 */

/** Fallback used when EXPO_PUBLIC_API_URL is not set. */
const DEFAULT_API_URL = 'http://localhost:5001/api/v1';

/**
 * Set the API address without editing code:
 *   EXPO_PUBLIC_API_URL=http://192.168.1.20:5001/api/v1
 *
 * iOS simulator and web can reach a backend on the same machine via localhost.
 * A physical phone cannot — use the computer's LAN address. The Android
 * emulator cannot either: it maps the host machine to 10.0.2.2, which is applied
 * automatically below.
 */
const configuredUrl = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_URL;

function withAndroidEmulatorHost(url: string): string {
  if (Platform.OS !== 'android') return url;
  return url.replace('//localhost', '//10.0.2.2').replace('//127.0.0.1', '//10.0.2.2');
}

export const API_BASE_URL = withAndroidEmulatorHost(configuredUrl).replace(/\/+$/, '');

/** Host and port only, for error copy that tells the user what to check. */
export const API_HOST_LABEL = API_BASE_URL.replace(/^https?:\/\//, '').replace(/\/api\/v\d+.*$/, '');

/** Fallback resident id, used only before anyone has signed in. */
const DEFAULT_RESIDENT_ID = 1;

/** Fallback programme id, used only before anyone has signed in. */
const DEFAULT_PROGRAM = 1;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resident the app falls back to when no one has signed in.
 *
 * The database ships one fully populated resident (id 1), which makes it the
 * only sensible default for first-run. Once a session exists this value is
 * ignored — see `SessionProvider` — and it is shown on the Settings screen so
 * the assumption is visible rather than hidden.
 */
export const FALLBACK_RESIDENT_ID = positiveIntFromEnv(
  process.env.EXPO_PUBLIC_FALLBACK_RESIDENT_ID,
  DEFAULT_RESIDENT_ID,
);

/** Programme whose roster is shown in the coordinator area by default. */
export const DEFAULT_PROGRAM_ID = positiveIntFromEnv(
  process.env.EXPO_PUBLIC_FALLBACK_PROGRAM_ID,
  DEFAULT_PROGRAM,
);

/** How long a single API call may take before the user is told it failed. */
export const REQUEST_TIMEOUT_MS = 15000;