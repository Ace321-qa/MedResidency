import { captureRef } from 'react-native-view-shot';

import { base64ToBytes } from './bytes';

/**
 * Image renderer.
 *
 * A JPEG/PNG of the schedule is what actually gets pasted into an email or a
 * group chat, so it is a first-class output rather than a screenshot of the
 * app. The caller renders the offscreen report view and hands us its ref; the
 * grid on screen scrolls horizontally, so snapshotting the live table would
 * clip every column past the viewport — the report view is laid out to the full
 * grid width instead.
 *
 * `react-native-view-shot` ships a web implementation (backed by html2canvas),
 * so the same call works in the browser build.
 */

export type RasterFormat = 'jpg' | 'png';

export type CaptureTarget = Parameters<typeof captureRef>[0];

export async function captureReportView(node: CaptureTarget, format: RasterFormat = 'jpg'): Promise<Uint8Array> {
  const base64 = await captureRef(node, {
    format,
    quality: format === 'jpg' ? 0.95 : 1,
    result: 'base64',
  });
  return base64ToBytes(base64);
}
