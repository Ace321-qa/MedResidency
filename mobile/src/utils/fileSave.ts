import { Platform } from 'react-native';

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * The one place a generated file leaves the app.
 *
 * Two platforms, two completely different endings for a press on "Download", and
 * both of them have to work:
 *
 *  - **Web** has no file system the page may write to, so the bytes become a
 *    `Blob`, the blob becomes an object URL, and a hidden anchor is clicked.
 *    The URL is revoked afterwards, because a page that downloads six templates
 *    should not hold six copies of them in memory.
 *  - **Native** has a real file system, so the bytes are written into the cache
 *    directory and handed to the OS share sheet via `expo-sharing`. That is what
 *    makes the file land in Files, Gmail, Drive or AirDrop — a React Native app
 *    has no "downloads folder" it is allowed to write into silently.
 *
 * If the share sheet is unavailable (some Android builds, or the permission was
 * denied) the file has still been written, and its path is returned so the
 * caller can tell the user exactly where it went rather than reporting a
 * failure that did not happen.
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface SavedFile {
  fileName: string;
  /** `file://…` on native, `blob:…` on web. Empty when the platform only clicked. */
  uri: string;
  /** How the file reached the user, for the confirmation the screen shows. */
  via: 'share-sheet' | 'browser-download' | 'saved-to-app-cache';
}

/**
 * Save `.xlsx` bytes under `fileName`.
 *
 * Throws only when nothing could be done — the browser refused the anchor click
 * or the cache directory was unwritable. Every other outcome is a success, even
 * the one where the file simply sits in the app's own cache.
 */
export async function saveSpreadsheet(fileName: string, bytes: Uint8Array): Promise<SavedFile> {
  if (Platform.OS === 'web') {
    return saveOnWeb(fileName, bytes);
  }
  return saveOnDevice(fileName, bytes);
}

function saveOnWeb(fileName: string, bytes: Uint8Array): SavedFile {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoking synchronously can cancel the download in some browsers, so the URL
  // is kept alive just long enough for the click to be processed.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  return { fileName, uri: url, via: 'browser-download' };
}

async function saveOnDevice(fileName: string, bytes: Uint8Array): Promise<SavedFile> {
  const file = new FileSystem.File(FileSystem.Paths.cache, fileName);

  if (file.exists) file.delete();
  file.create();
  // `write` accepts bytes directly; no base64 round-trip needed.
  file.write(bytes);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: XLSX_MIME,
      dialogTitle: fileName,
      UTI: 'org.openxmlformats.spreadsheetml.sheet',
    });
    return { fileName, uri: file.uri, via: 'share-sheet' };
  }

  return { fileName, uri: file.uri, via: 'saved-to-app-cache' };
}

/** Human confirmation text for a finished download. */
export function describeSave(saved: SavedFile): string {
  switch (saved.via) {
    case 'browser-download':
      return `${saved.fileName} was downloaded to your browser's downloads folder.`;
    case 'share-sheet':
      return `${saved.fileName} is ready — choose where to save or send it.`;
    default:
      return `${saved.fileName} was saved to the app's cache: ${saved.uri}`;
  }
}
