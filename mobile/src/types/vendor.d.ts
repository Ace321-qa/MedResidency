/**
 * Ambient declarations for the few renderer libraries that ship no usable
 * types at the sub-path we import.
 *
 * - `pdfmake/build/pdfmake` and `pdfmake/build/vfs_fonts` are the browser
 *   bundles. Importing the package root instead would pull the Node build,
 *   which requires `fs`/`pdfkit` and cannot run on a device. The sub-paths have
 *   no type definitions, so they are declared loosely here and wrapped by the
 *   `renderReportPdf` function, which is the only place that touches them.
 */

declare module 'pdfmake/build/pdfmake' {
  interface PdfMake {
    addVirtualFileSystem(vfs: Record<string, string>): void;
    fonts?: Record<string, Record<string, string>>;
    createPdf(definition: unknown): {
      getBuffer: () => Promise<Uint8Array & { length: number }>;
      download: (defaultFileName?: string) => void;
    };
  }
  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string>;
  export default vfs;
}
