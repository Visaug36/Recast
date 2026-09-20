/**
 * The CJK fonts, fetched only when a document actually contains CJK.
 *
 * Roboto — what every other PDF Recast writes uses — has no CJK glyphs, so those
 * characters used to be replaced and the conversion refused outright if there
 * was nothing else in the document. A person whose document is in Japanese got
 * a refusal and nothing else.
 *
 * Three faces rather than one pan-CJK blob: a combined font is three to four
 * times the size and almost nobody needs two of them at once. See
 * `public/fonts/README.md` for where they come from and why they are TTF.
 */

export type CjkVariant = 'jp' | 'sc' | 'kr';

interface Face {
  /** The name pdfmake knows it by, and the file served from our own origin. */
  font: string;
  file: string;
}

export const FACES: Record<CjkVariant, Face> = {
  jp: { font: 'NotoSansJP', file: 'NotoSansJP.ttf' },
  sc: { font: 'NotoSansSC', file: 'NotoSansSC.ttf' },
  kr: { font: 'NotoSansKR', file: 'NotoSansKR.ttf' },
};

/** Hiragana and katakana. Their presence is what makes a document Japanese. */
const KANA: [number, number][] = [
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
  [0xff66, 0xff9d],
];

/** Hangul: the syllables, the jamo they are built from, and the half-width set. */
const HANGUL: [number, number][] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xffa0, 0xffdc],
];

/**
 * Which face a document needs.
 *
 * Hangul means Korean, kana means Japanese, and anything else that reached here
 * is Han, which the Simplified Chinese subset covers either way.
 *
 * **Hangul is asked first, and that is a choice with a cost.** The Korean face
 * carries the 11,172 modern syllables and the jamo, and no Han at all — so a
 * Korean document quoting hanja loses the hanja, which `renderPdf` then replaces
 * and names in a warning. The other order would lose every syllable of a
 * document that is mostly Korean, which is worse: one face is embedded per
 * document, and the script the document is actually written in should be the
 * one that renders.
 */
export function variantFor(codePoints: Iterable<number>): CjkVariant {
  let japanese = false;
  for (const code of codePoints) {
    if (HANGUL.some(([start, end]) => code >= start && code <= end)) return 'kr';
    if (KANA.some(([start, end]) => code >= start && code <= end)) japanese = true;
  }
  return japanese ? 'jp' : 'sc';
}

/**
 * Every code point a TrueType font can draw, read from its own `cmap`.
 *
 * The alternative was a coverage table generated at build time, but these fonts
 * need four thousand ranges each to describe — 27 KB of string per face, which
 * would then be free to drift away from the file it describes. Reading the real
 * table costs a few milliseconds and cannot be wrong.
 *
 * Handles the two subtable formats a modern font uses: 4 for the BMP and 12 for
 * everything above it. A format-4 segment can in principle map some of its
 * range to .notdef through `idRangeOffset`, which this does not follow — so it
 * could in principle over-claim. Checked against fontTools for both faces Recast
 * ships: 6886 and 7946 code points, exactly, with nothing over-claimed and
 * nothing missed. Worth re-checking if the fonts are ever replaced.
 */
export function readCmap(ttf: ArrayBuffer): Set<number> {
  const view = new DataView(ttf);
  const covered = new Set<number>();

  const tables = view.getUint16(4);
  let cmapOffset = 0;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    if (tag === 'cmap') cmapOffset = view.getUint32(record + 8);
  }
  if (!cmapOffset) return covered;

  const subtables = view.getUint16(cmapOffset + 2);
  for (let i = 0; i < subtables; i++) {
    const offset = cmapOffset + view.getUint32(cmapOffset + 4 + i * 8 + 4);
    const format = view.getUint16(offset);

    if (format === 4) {
      const segments = view.getUint16(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        // The last segment is the 0xFFFF terminator, not real coverage.
        if (start === 0xffff) continue;
        for (let code = start; code <= end && code !== 0xffff; code++) covered.add(code);
      }
    } else if (format === 12) {
      const groups = view.getUint32(offset + 12);
      for (let g = 0; g < groups; g++) {
        const row = offset + 16 + g * 12;
        const start = view.getUint32(row);
        const end = view.getUint32(row + 4);
        // A malformed group could otherwise spin for a very long time.
        if (end < start || end - start > 0x10000) continue;
        for (let code = start; code <= end; code++) covered.add(code);
      }
    }
  }

  return covered;
}

/**
 * Where the fonts are served from.
 *
 * Resolved against the worker's own URL, so it follows `basePath` without the
 * worker having to be told what it is. Nothing here reaches another origin.
 */
function fontUrl(file: string): string {
  const base =
    typeof self !== 'undefined' && self.location
      ? self.location.href
      : 'http://localhost/recast-worker/';
  return new URL(`../fonts/${file}`, base).href;
}

export interface LoadedFace {
  font: string;
  bytes: Uint8Array;
  covers: Set<number>;
}

const cache = new Map<CjkVariant, Promise<LoadedFace>>();

/**
 * Fetches a face and reads its coverage, once per session.
 *
 * The bytes go into pdfmake's virtual file system as they are. Its own fonts
 * are base64 strings, which costs a third again in size for nothing —
 * `addVirtualFileSystem` takes `{ data }` and stores anything that is not a
 * string untouched.
 */
export function loadFace(variant: CjkVariant): Promise<LoadedFace> {
  const existing = cache.get(variant);
  if (existing) return existing;

  const face = FACES[variant];
  const loading = (async () => {
    const response = await fetch(fontUrl(face.file));
    if (!response.ok) {
      throw new Error(`font ${face.file} responded ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return { font: face.font, bytes: new Uint8Array(buffer), covers: readCmap(buffer) };
  })();

  cache.set(variant, loading);
  return loading;
}

/** Test seam: forget what has been fetched. */
export function resetFaces(): void {
  cache.clear();
}
