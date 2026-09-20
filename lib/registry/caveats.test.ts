import { describe, expect, it } from 'vitest';
import { converters } from './table';
import { engineFor } from './engines';
import { ANCHORS, canHold, featuresOf, type Feature, type Found } from '@/test/features';
import JSZip from 'jszip';
import { readBack } from '@/test/read-back';
import { MAX_PDF_COLUMNS, MAX_PDF_COLUMNS_LANDSCAPE } from './converters/_blocks-to-pdf';
import { fixture, MARKER } from '@/test/fixtures';
import type { ConvertFn, Format, OutputFile } from './types';

/**
 * Every caveat is a promise, and this is where the promises are kept.
 *
 * Thirty-eight of Recast's forty-four edges carry a caveat, and each one makes
 * specific claims — "links and emphasis carry over", "headings map to Word
 * styles", "only the values survive". Until this file existed, nothing checked
 * a single one of them. `index.test.ts` asserted that a lossy converter *has* a
 * caveat; nothing asked whether it was true.
 *
 * That gap is not hypothetical. `md → docx` told people links mapped to Word
 * styles for three stages while `parseMarkdown` was stripping every inline run
 * before the writer saw it. The pair produced a perfectly good Word file the
 * whole time, which is exactly why nobody noticed, and routing spread the
 * sentence onto every pair that passes through that edge.
 *
 * ## How it works
 *
 * A caveat is split into sentences, and **every sentence must appear in
 * `CLAIMS` below**, matched exactly. That is the part that makes this hold up:
 * rewording a caveat fails the suite until somebody decides what the new words
 * promise. There is no fallback, no fuzzy match and no default.
 *
 * Each sentence carries claims, and a claim is one of:
 *
 * - `survives` / `dropped` — a feature must be found, or not found, in the
 *   real output, by opening it and looking (`test/features.ts`).
 * - `keeps` / `loses` / `order` — text that must, or must not, come through,
 *   read back with Recast's own reader for that format.
 * - `shape` — a bespoke assertion, for a claim about structure.
 * - `unverifiable` — with a reason. A caveat that cannot be turned into an
 *   assertion says so here rather than being weakened into something
 *   checkable and meaningless.
 *
 * ## What a passing run does not mean
 *
 * A claim about a feature the fixture does not contain is **not exercised**,
 * and is reported as such rather than counted as passing. A test that cannot
 * fail is worse than no test — this repository has shipped eight of those in
 * one file before. `it('exercises as much of the promise surface as it can')`
 * pins the unexercised list so it cannot quietly grow.
 */

// ---- The claim language ---------------------------------------------------

interface Seen {
  edge: string;
  from: Format;
  to: Format;
  sourceFound: Found;
  outFound: Found;
  /** The output's text, read back with Recast's own reader for that format. */
  outText: string;
  outBytes: Uint8Array;
  outFiles: OutputFile[];
  /** Names of the files inside the output, when it is a package. */
  parts: string[];
  /** The markup inside those files, for a claim about a package's structure. */
  partText: string;
  /**
   * The same edge run again on a twenty-column workbook, where there is one.
   *
   * The ordinary fixture is three columns wide, so every claim about what
   * happens to a sheet too wide for the page was unexercised until this.
   */
  wide?: { text: string; bytes: Uint8Array };
}

type Claim =
  | { survives: Feature[] }
  | { dropped: Feature[] }
  | { keeps: string[] }
  | { loses: string[] }
  | { order: string[] }
  | { shape: string; check: (seen: Seen) => string | null }
  | { unverifiable: string };

/** What happened to every claim on one edge. */
interface Verdict {
  held: string[];
  failed: string[];
  /** The fixture has no such thing, so the claim was never put to the test. */
  notExercised: string[];
  /** The target format cannot express it, so the claim holds by construction. */
  byConstruction: string[];
  unverifiable: string[];
}

// ---- Helpers the shape checks use -----------------------------------------

const lines = (text: string) => text.split(/\r?\n/);
const headings = (md: string) => lines(md).filter((line) => /^#{1,6} \S/.test(line));

/** How many pipe tables a Markdown document contains. */
function pipeTables(md: string): number {
  return lines(md).filter((line) => /^\|[\s:-]*-[\s|:-]*\|[ \t]*$/.test(line)).length;
}

/**
 * Whether a PDF's pages are wider than they are tall.
 *
 * `/MediaBox [0 0 w h]`, which is the page box in points — the one place a PDF
 * says which way round it is.
 */
function isLandscape(bytes: Uint8Array): boolean {
  const box = /\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(
    new TextDecoder().decode(bytes),
  );
  if (!box) return false;
  return Number(box[1]) > Number(box[2]);
}

/** Blocks separated by a blank line, ignoring leading and trailing space. */
function blocks(text: string): string[] {
  return text
    .trim()
    .split(/\n[ \t]*\n/)
    .filter((block) => block.trim().length > 0);
}

// ---- Every sentence, and what it promises ---------------------------------

const CLAIMS: Record<string, Claim[]> = {
  // ---- Text documents into Markdown ----
  'Headings, lists, links and emphasis carry over.': [
    { survives: ['headings', 'lists', 'links', 'emphasis'] },
  ],
  'Fonts, colours and page layout do not.': [
    {
      unverifiable:
        'Markdown has no syntax for a font, a colour or a page, so nothing in the output could carry them. True by the shape of the target rather than by anything the engine does.',
    },
  ],
  'Headings, lists, tables and emphasis carry over.': [
    { survives: ['headings', 'lists', 'tables', 'emphasis'] },
  ],
  'Headings, lists, tables, links and emphasis carry over.': [
    { survives: ['headings', 'lists', 'tables', 'links', 'emphasis'] },
  ],
  'Styling, scripts, images and anything that depends on layout are dropped.': [
    { dropped: ['styling', 'scripts', 'images'] },
    { loses: ['console.log', 'font-family'] },
  ],

  // ---- Into plain text ----
  'You keep the words and the paragraph breaks.': [
    { keeps: [MARKER] },
    {
      shape: 'the output has more than one paragraph',
      check: (seen) =>
        blocks(seen.outText).length > 1
          ? null
          : `only ${blocks(seen.outText).length} paragraph in the output`,
    },
  ],
  'All formatting is dropped.': [
    {
      shape: 'no markup leaked into the plain text',
      check: (seen) => {
        const leaked = [/\*\*/, /<\/?[a-z]+>/i, /\\[a-z]+\d*\s/, /^#{1,6} /m].filter(
          (pattern) => pattern.test(seen.outText),
        );
        return leaked.length ? `markup in the output: ${leaked.join(', ')}` : null;
      },
    },
  ],

  // ---- Markdown into everything ----
  'Inline emphasis and links are not carried.': [{ dropped: ['emphasis', 'links'] }],
  'Headings, lists, quotes, code blocks and tables map to OpenDocument styles.': [
    { survives: ['headings', 'lists', 'quotes', 'code', 'tables'] },
  ],
  'Headings, lists, quotes, code blocks and tables map to Word styles.': [
    { survives: ['headings', 'lists', 'quotes', 'code', 'tables'] },
  ],
  'Inline emphasis and links are not carried, and raw HTML is dropped.': [
    { dropped: ['emphasis', 'links'] },
    {
      unverifiable:
        'The Markdown fixture contains no raw HTML block, so the second half of this sentence has nothing to act on. Adding one would make it checkable.',
    },
  ],
  'Rendered with Recast’s own typography, not your Markdown preview’s.': [
    {
      unverifiable:
        'A claim about which typography was used, against an unnamed other renderer. There is nothing to compare the output to.',
    },
  ],
  'Headings, lists and quotes survive as formatted text.': [
    { survives: ['headings', 'lists'] },
    {
      unverifiable:
        'RTF marks a quotation with an indent, which is indistinguishable from any other indented paragraph, so "quotes survived" cannot be read back out of the file.',
    },
  ],
  'Tables become tab-separated lines, and inline emphasis and links are not carried.': [
    { dropped: ['tables', 'emphasis', 'links'] },
    { keeps: ['alpha', 'beta'] },
  ],
  'A standalone HTML document with semantic tags and no stylesheet, so it takes on whatever styles surround it.':
    [
      {
        shape: 'a whole document, with no stylesheet of its own',
        check: (seen) => {
          if (!/<html[\s>]/i.test(seen.outText)) return 'no <html> element';
          if (/<style[\s>]|<link[^>]+stylesheet/i.test(seen.outText)) {
            return 'the document carries a stylesheet';
          }
          return null;
        },
      },
    ],
  'The one target that keeps inline emphasis and links intact.': [
    { survives: ['emphasis', 'links'] },
  ],
  'Each top-level heading starts a chapter.': [
    {
      shape: 'one chapter in the book per top-level heading in the source',
      check: (seen) => {
        const chapters = seen.parts.filter(
          (name) => /\.x?html$/.test(name) && !/nav|toc/i.test(name),
        ).length;
        // The Markdown fixture has a single `#`, so a book with two chapters
        // would mean something other than a top-level heading started one.
        return chapters === 1 ? null : `1 top-level heading in, ${chapters} chapters out`;
      },
    },
  ],
  'The book is unstyled, and images, inline emphasis and links are not carried.': [
    { dropped: ['styling', 'images', 'emphasis', 'links'] },
  ],
  'Each blank-line-separated block becomes a paragraph in the default style.': [
    {
      shape: 'as many paragraphs out as blank-line-separated blocks in',
      check: (seen) => {
        // Read back through docx → txt, which writes one line per paragraph.
        const out = lines(seen.outText).filter((line) => line.trim()).length;
        return out === 3 ? null : `3 blocks in, ${out} paragraphs out`;
      },
    },
  ],
  'Set in a single typeface at one size.': [
    {
      shape: 'one typeface embedded in the PDF',
      check: (seen) => {
        const raw = new TextDecoder().decode(seen.outBytes);
        const faces = new Set(
          (raw.match(/\/BaseFont\s*\/([A-Za-z0-9+#-]+)/g) ?? []).map((name) =>
            // Subset prefixes such as `AAAAAB+Roboto` are the same face.
            name.replace(/\/BaseFont\s*\/([A-Z]{6}\+)?/, ''),
          ),
        );
        return faces.size <= 1 ? null : `${faces.size} faces: ${[...faces].join(', ')}`;
      },
    },
  ],
  'Long lines wrap to the page width.': [
    {
      unverifiable:
        'Where a line broke is a fact about the drawn page. A PDF records the positions of text runs, not that one of them is a continuation of another, so this cannot be read back.',
    },
  ],

  // ---- Word, RTF and PDF as sources ----
  'Styles are approximated and the page is laid out again from scratch, so breaks, headers, footers and columns will not match Word.':
    [
      {
        unverifiable:
          'A claim that the output does not match what Word would have produced. Checking it needs Word.',
      },
    ],
  'Headings, emphasis and lists survive as formatted text.': [
    { survives: ['headings', 'emphasis', 'lists'] },
  ],
  'Tables, images and precise spacing do not.': [{ dropped: ['tables', 'images'] }],
  'Heading levels are ranked by the font sizes RTF records, largest first, so they are an estimate — a pull quote set large reads as a heading.':
    [
      {
        shape: 'the largest run in the source became the top heading',
        check: (seen) => {
          const first = headings(seen.outText)[0];
          if (!first) return 'no headings in the output';
          return first.includes('A large heading')
            ? null
            : `the top heading is ${JSON.stringify(first)}`;
        },
      },
    ],
  'Tables and images are dropped.': [{ dropped: ['tables', 'images'] }],
  'Only the text layer comes across.': [{ keeps: [MARKER] }],
  'Columns may interleave, and a scanned PDF has no text to extract.': [
    {
      unverifiable:
        'Both halves need a fixture Recast does not have: a multi-column PDF, and a scanned one. The scanned case is covered by a refusal in _pdfread.ts rather than by this pair.',
    },
  ],
  'Headings are ranked by type size, and paragraphs are split where the line spacing widens — both are inferences, because a PDF records neither.':
    [
      {
        shape: 'the largest text in the PDF became a heading',
        check: (seen) => {
          const first = headings(seen.outText)[0];
          if (!first) return 'no headings in the output';
          return first.includes('A printed heading')
            ? null
            : `the top heading is ${JSON.stringify(first)}`;
        },
      },
    ],
  'Two short paragraphs set close together can still run into one.': [
    {
      unverifiable:
        'A statement of where the inference fails, not a promise about the output. There is nothing here to hold Recast to.',
    },
  ],
  'Images, tables and multi-column layouts are dropped.': [
    { dropped: ['images', 'tables'] },
  ],

  // ---- EPUB ----
  'Chapters are read in spine order and joined into one document.': [
    { order: ['Chapter one', 'Chapter two', 'Chapter three'] },
  ],
  'The cover, table of contents, metadata and styling are dropped.': [
    { dropped: ['images', 'styling'] },
    { loses: ['A test book'] },
  ],

  // ---- Spreadsheets ----
  'Cell values and sheet names carry over.': [{ keeps: [MARKER, 'Sales', 'Notes'] }],
  'Formulas, charts, images and cell formatting are dropped.': [
    { dropped: ['formulas', 'charts', 'images', 'styling'] },
    { loses: ['SUM('] },
  ],
  'One pipe table per sheet.': [
    {
      shape: 'one pipe table per sheet in the workbook',
      check: (seen) =>
        pipeTables(seen.outText) === 2
          ? null
          : `2 sheets in, ${pipeTables(seen.outText)} pipe tables out`,
    },
  ],
  'Formatting, formulas and merged cells are dropped.': [
    { dropped: ['formulas', 'merged cells'] },
    { loses: ['SUM('] },
  ],
  'Tab-separated, one block per sheet.': [
    {
      shape: 'a tab-separated block per sheet',
      check: (seen) => {
        if (!seen.outText.includes('\t')) return 'no tabs in the output';
        const out = blocks(seen.outText).length;
        return out === 2 ? null : `2 sheets in, ${out} blocks out`;
      },
    },
  ],
  'Only the values survive.': [{ keeps: [MARKER, '4000'] }, { loses: ['SUM('] }],
  'Each sheet is drawn as a plain table.': [{ keeps: [MARKER] }],
  'A sheet wider than 12 columns turns the page sideways, and past 18 columns the rest are cut off.':
    [
      {
        shape: 'the numbers in the sentence are the numbers in the code',
        check: () =>
          MAX_PDF_COLUMNS === 12 && MAX_PDF_COLUMNS_LANDSCAPE === 18
            ? null
            : `the code says ${MAX_PDF_COLUMNS} and ${MAX_PDF_COLUMNS_LANDSCAPE}`,
      },
      {
        shape: 'a three-column sheet is left upright',
        check: (seen) =>
          isLandscape(seen.outBytes) ? 'the narrow workbook was turned sideways' : null,
      },
      {
        shape: 'a twenty-column sheet turns the page and keeps eighteen of them',
        check: (seen) => {
          if (!seen.wide) return 'no wide workbook for this format';
          if (!isLandscape(seen.wide.bytes)) return 'the wide workbook stayed upright';
          if (!seen.wide.text.includes('Col18')) return 'column 18 did not survive';
          if (seen.wide.text.includes('Col19')) return 'column 19 was not cut off';
          return null;
        },
      },
    ],
  'Charts and formatting are dropped.': [{ dropped: ['charts', 'styling'] }],
  'Values become Word tables.': [{ survives: ['tables'] }, { keeps: [MARKER] }],
  'Each sheet becomes an array of objects keyed by its first row.': [
    {
      shape: 'an array of objects per sheet, keyed by the header row',
      check: (seen) => {
        const parsed = JSON.parse(seen.outText) as unknown;
        const sheets = Array.isArray(parsed)
          ? { only: parsed }
          : (parsed as Record<string, unknown>);
        for (const [name, rows] of Object.entries(sheets)) {
          if (!Array.isArray(rows)) return `${name} is not an array`;
          const first = rows[0] as Record<string, unknown> | undefined;
          if (!first) continue;
          if (name === 'Sales' && !('Region' in first)) {
            return `Sales rows are keyed ${JSON.stringify(Object.keys(first))}`;
          }
        }
        return null;
      },
    },
  ],
  'Formulas, charts and formatting are dropped, and every value arrives as a string.': [
    { loses: ['SUM('] },
    {
      shape: 'every value is a string',
      check: (seen) => {
        const parsed = JSON.parse(seen.outText) as Record<string, unknown[]>;
        for (const rows of Object.values(parsed)) {
          for (const row of rows) {
            for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
              if (typeof value !== 'string') return `${key} is a ${typeof value}`;
            }
          }
        }
        return null;
      },
    },
  ],
  'Becomes a pipe table, with the first row treated as the header.': [
    {
      shape: "the CSV's first row is the table header",
      check: (seen) => {
        const first = lines(seen.outText).find((line) => line.startsWith('|'));
        if (!first) return 'no pipe table in the output';
        return /Region/.test(first) && /Revenue/.test(first)
          ? null
          : `the header row is ${JSON.stringify(first)}`;
      },
    },
  ],
  'An array of objects becomes rows, with the keys as the header row.': [
    {
      shape: 'the header row carries the object keys',
      check: (seen) =>
        /region/i.test(seen.outText) && /revenue/i.test(seen.outText)
          ? null
          : 'the keys are not in the output',
    },
  ],
  'Nested objects are flattened to dotted keys — `address.city` — and arrays inside a value become comma-separated text.':
    [
      {
        shape: 'a nested key is flattened and an array is joined',
        check: (seen) => {
          if (!/lead\.name/.test(seen.outText)) return 'no dotted key in the output';
          return /priority,\s?q1|priority, q1/.test(seen.outText)
            ? null
            : 'the array was not joined into text';
        },
      },
    ],

  // ---- Slides ----
  'Slide text only, in reading order.': [
    { order: ['Opening slide', MARKER, 'Second slide', 'Point one'] },
  ],
  'Layout, images, charts and speaker notes formatting are dropped.': [
    { dropped: ['images', 'charts'] },
  ],
  'One heading per slide with its bullets beneath.': [
    {
      shape: 'one heading per slide',
      check: (seen) => {
        const count = headings(seen.outText).length;
        return count === 2 ? null : `2 slides in, ${count} headings out`;
      },
    },
  ],
  'Everything visual about the deck is dropped.': [
    {
      unverifiable:
        '"Everything visual" names no feature, so there is nothing specific to look for. The checkable half of it is the sentence above, which is already checked.',
    },
  ],
  'Each top-level heading starts a slide.': [
    {
      shape: 'one slide in the deck per top-level heading in the source',
      check: (seen) => {
        const slides =
          seen.to === 'pptx'
            ? seen.parts.filter((name) => /ppt\/slides\/slide\d+\.xml$/.test(name)).length
            : (seen.partText.match(/<draw:page\b/g) ?? []).length;
        return slides === 1 ? null : `1 top-level heading in, ${slides} slides out`;
      },
    },
  ],
  'A table becomes one bullet per row, and images, inline emphasis and links are not carried.':
    [{ dropped: ['images', 'emphasis', 'links'] }, { keeps: ['alpha', 'beta'] }],
  'The deck is unstyled, a table becomes one bullet per row, and images, inline emphasis and links are not carried.':
    [{ dropped: ['images', 'emphasis', 'links'] }, { keeps: ['alpha', 'beta'] }],
};

// ---- Running them ---------------------------------------------------------

const FIXTURES: Partial<Record<Format, string>> = {
  docx: 'sample.docx',
  odt: 'sample.odt',
  md: 'sample.md',
  txt: 'sample.txt',
  rtf: 'sample.rtf',
  pdf: 'sample.pdf',
  html: 'sample.html',
  epub: 'sample.epub',
  xlsx: 'sample.xlsx',
  ods: 'sample.ods',
  csv: 'sample.csv',
  json: 'sample.json',
  pptx: 'sample.pptx',
  odp: 'sample.odp',
};

/** Sources that also have a workbook too wide for any page. */
const WIDE: Partial<Record<Format, string>> = {
  xlsx: 'wide.xlsx',
  ods: 'wide.ods',
};

/** Splits a caveat the way a reader does: one sentence, one claim. */
function sentences(caveat: string): string[] {
  return caveat
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

async function run(from: Format, to: Format) {
  const load = engineFor(from, to);
  if (!load) throw new Error(`no engine for ${from} → ${to}`);
  const convert = await load();
  const source = fixture(FIXTURES[from]!);
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  const result = await convert(fixture(FIXTURES[from]!));
  const outBytes = new Uint8Array(await result.files[0]!.blob.arrayBuffer());

  // The anchors travel with the source: it is the source's emphasis and the
  // source's link that the caveat promises will or will not come through.
  const anchors = ANCHORS[from];

  return {
    sourceFound: await featuresOf(from, sourceBytes, anchors),
    outFound: await featuresOf(to, outBytes, anchors),
    outText: await readBack(to, outBytes),
    outBytes,
    outFiles: result.files,
    ...(await insideOf(outBytes)),
    ...(WIDE[from] ? { wide: await runWide(convert, WIDE[from]!, to) } : {}),
  };
}

/** The same edge, on a workbook wider than any page can hold. */
async function runWide(convert: ConvertFn, name: string, to: Format) {
  const result = await convert(fixture(name));
  const bytes = new Uint8Array(await result.files[0]!.blob.arrayBuffer());
  return { text: await readBack(to, bytes), bytes };
}

/** What is inside a package: its file names and its markup. */
async function insideOf(
  bytes: Uint8Array,
): Promise<{ parts: string[]; partText: string }> {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return { parts: [], partText: '' };
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  const markup = await Promise.all(
    parts
      .filter((name) => /\.(xml|opf|x?html|rels)$/.test(name))
      .map((name) => zip.files[name]!.async('string')),
  );
  return { parts, partText: markup.join('\n') };
}

function judge(claims: Claim[], seen: Seen): Verdict {
  const verdict: Verdict = {
    held: [],
    failed: [],
    notExercised: [],
    byConstruction: [],
    unverifiable: [],
  };

  for (const claim of claims) {
    if ('unverifiable' in claim) {
      verdict.unverifiable.push(claim.unverifiable);
      continue;
    }

    if ('survives' in claim) {
      for (const feature of claim.survives) {
        const what = `${feature} survives`;
        if (!canHold(seen.to, feature)) {
          verdict.failed.push(`${what}, but .${seen.to} cannot express it at all`);
        } else if (seen.outFound[feature] === undefined) {
          verdict.unverifiable.push(`${what} — nothing in a .${seen.to} records it`);
        } else if (!seen.sourceFound[feature]) {
          verdict.notExercised.push(
            `${what} — the .${seen.from} fixture has no ${feature}`,
          );
        } else if (seen.outFound[feature]) {
          verdict.held.push(what);
        } else {
          verdict.failed.push(`${what}, but the output has no ${feature}`);
        }
      }
    }

    if ('dropped' in claim) {
      for (const feature of claim.dropped) {
        const what = `${feature} dropped`;
        if (canHold(seen.to, feature) && seen.outFound[feature] === undefined) {
          verdict.unverifiable.push(`${what} — nothing in a .${seen.to} records it`);
        } else if (!seen.sourceFound[feature]) {
          verdict.notExercised.push(
            `${what} — the .${seen.from} fixture has no ${feature}`,
          );
        } else if (!canHold(seen.to, feature)) {
          verdict.byConstruction.push(`${what} — .${seen.to} cannot express it`);
        } else if (!seen.outFound[feature]) {
          verdict.held.push(what);
        } else {
          verdict.failed.push(`${what}, but the output still has ${feature}`);
        }
      }
    }

    if ('keeps' in claim) {
      for (const text of claim.keeps) {
        if (seen.outText.includes(text))
          verdict.held.push(`keeps ${JSON.stringify(text)}`);
        else verdict.failed.push(`should keep ${JSON.stringify(text)}, and does not`);
      }
    }

    if ('loses' in claim) {
      for (const text of claim.loses) {
        if (seen.outText.includes(text)) {
          verdict.failed.push(
            `should lose ${JSON.stringify(text)}, and it is still there`,
          );
        } else {
          verdict.held.push(`loses ${JSON.stringify(text)}`);
        }
      }
    }

    if ('order' in claim) {
      let at = -1;
      let broke: string | null = null;
      for (const text of claim.order) {
        const next = seen.outText.indexOf(text, at + 1);
        if (next === -1) broke = `${JSON.stringify(text)} is missing`;
        else if (next < at) broke = `${JSON.stringify(text)} came too early`;
        else at = next;
        if (broke) break;
      }
      if (broke) verdict.failed.push(`reading order: ${broke}`);
      else verdict.held.push(`reads in order: ${claim.order.join(' → ')}`);
    }

    if ('shape' in claim) {
      const problem = claim.check(seen);
      if (problem) verdict.failed.push(`${claim.shape}: ${problem}`);
      else verdict.held.push(claim.shape);
    }
  }

  return verdict;
}

/**
 * The promises Recast does not keep, as of the run that first checked them.
 *
 * Each one is a caveat claiming something the output does not do. They are
 * pinned here so the suite is honest about the state of the product rather
 * than green because nobody looked — and so that fixing one is a deliberate
 * act that removes a line from this list.
 */
const BROKEN = [
  // The words claim the opposite of a limit the project has written down.
  // `docx → rtf` runs through the shared block model, which carries no inline
  // runs, so the fixture's bold paragraph arrives as plain text. Nine other
  // caveats state this limit correctly; this one states its reverse. Headings
  // and lists do survive, and the RTF's `\b` on a heading is the heading's own
  // formatting rather than emphasis that was carried.
  'docx → rtf — emphasis survives, but the output has no emphasis',

  // A real gap, and the sibling proves it. `md → odt` writes
  // `text:style-name="Quotations"` and `"Preformatted_20_Text"`, both declared
  // in styles.xml. The Word writer gives a quotation an indent and italics,
  // and a code block the Consolas face, both as direct formatting — so a
  // reader restyling the document finds nothing to restyle.
  'md → docx — quotes survives, but the output has no quotes',
  'md → docx — code survives, but the output has no code',
];

// ---- The tests ------------------------------------------------------------

const withCaveats = converters.filter((converter) => converter.caveat);

describe('a caveat is a promise', () => {
  it('has every sentence of every caveat written down as a claim', () => {
    const unknown: string[] = [];
    for (const converter of withCaveats) {
      for (const sentence of sentences(converter.caveat!)) {
        if (!(sentence in CLAIMS))
          unknown.push(`${converter.from} → ${converter.to}: ${sentence}`);
      }
    }

    // No fallback and no fuzzy match on purpose. Rewording a caveat fails here
    // until somebody says what the new words promise.
    expect(unknown).toEqual([]);
  });

  it('keeps every promise it makes, on real output', async () => {
    const failures: string[] = [];

    for (const converter of withCaveats) {
      const seenBase = await run(converter.from, converter.to);
      const seen: Seen = {
        edge: `${converter.from} → ${converter.to}`,
        from: converter.from,
        to: converter.to,
        ...seenBase,
      };

      for (const sentence of sentences(converter.caveat!)) {
        const claims = CLAIMS[sentence];
        if (!claims) continue;
        const verdict = judge(claims, seen);
        for (const failure of verdict.failed) failures.push(`${seen.edge} — ${failure}`);
      }
    }

    // Not `toEqual([])`. Three promises are broken today, and they are listed
    // rather than quietly corrected, because deciding between "fix the words"
    // and "fix the writer" is not this file's call to make. Anything that is
    // not on the list fails the suite, and a line that stops failing has to be
    // taken off it.
    expect(failures.sort()).toEqual([...BROKEN].sort());
  }, 600_000);

  it('says how much of the promise surface it actually reaches', async () => {
    const report = await surveyed();

    // A claim about something the fixture does not contain never runs, and a
    // check that cannot fail is worse than no check. These lists are pinned so
    // they can only change deliberately: putting a chart in a fixture takes a
    // line off the first, and a new caveat about something no fixture has puts
    // one on.
    expect(report.notExercised).toMatchSnapshot('not exercised');
    expect(report.unverifiable).toMatchSnapshot('unverifiable');
    expect(report.byConstruction).toMatchSnapshot('true by construction');
    expect(report.checked).toBeGreaterThanOrEqual(111);
  }, 600_000);
});

/** Every verdict on every edge, for the coverage report. */
async function surveyed() {
  const notExercised: string[] = [];
  const unverifiable: string[] = [];
  const byConstruction: string[] = [];
  let checked = 0;

  for (const converter of withCaveats) {
    const seen: Seen = {
      edge: `${converter.from} → ${converter.to}`,
      from: converter.from,
      to: converter.to,
      ...(await run(converter.from, converter.to)),
    };

    for (const sentence of sentences(converter.caveat!)) {
      const verdict = judge(CLAIMS[sentence] ?? [], seen);
      checked += verdict.held.length + verdict.failed.length;
      for (const item of verdict.notExercised)
        notExercised.push(`${seen.edge} — ${item}`);
      for (const item of verdict.byConstruction)
        byConstruction.push(`${seen.edge} — ${item}`);
      for (const item of verdict.unverifiable)
        unverifiable.push(`${seen.edge} — ${item}`);
    }
  }

  return { notExercised, unverifiable, byConstruction, checked };
}
