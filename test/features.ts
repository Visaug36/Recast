import JSZip from 'jszip';
import type { Format } from '@/lib/registry/types';

/**
 * Looks inside a document and says which features it actually contains.
 *
 * This exists so a caveat can be checked rather than believed. `md → docx`
 * promised that links map to Word styles for three stages while the block
 * model was dropping them, and the pair kept producing a perfectly good Word
 * file the whole time — which is why nobody noticed. The only way to catch
 * that is to open the output and look.
 *
 * ## Block features are structural; inline features are anchored
 *
 * Headings, lists, tables, quotes and code are structures, and a probe can ask
 * whether the file contains one. Emphasis and links are not: every writer here
 * bolds a heading or a table header, so "the output contains a bold run" says
 * nothing about whether the *source's* emphasis came through. The first draft
 * of this file made exactly that mistake and reported four edges as carrying
 * emphasis they drop.
 *
 * So an inline claim is anchored to a word the fixture emphasises, or the host
 * the fixture links to, and the question becomes the one the caveat is really
 * making: is *that* word still emphasised, is *that* link still a link. The
 * anchor travels with the source format, because it is the source's content
 * that has to survive.
 */

export type Feature =
  | 'headings'
  | 'lists'
  | 'tables'
  | 'emphasis'
  | 'links'
  | 'images'
  | 'quotes'
  | 'code'
  | 'formulas'
  | 'merged cells'
  | 'speaker notes'
  | 'footnotes'
  | 'charts'
  | 'styling'
  | 'scripts';

/** Which features a file contains. A missing key means "this format cannot". */
export type Found = Partial<Record<Feature, boolean>>;

/**
 * What to look for when asking whether an inline feature survived.
 *
 * One word the fixture emphasises, and one host it links to. A format whose
 * fixture has neither leaves them out, and every inline claim on an edge
 * leaving it is reported as unexercised rather than quietly passing.
 */
export interface Anchors {
  emphasised?: string;
  linkedTo?: string;
}

export const ANCHORS: Record<Format, Anchors> = {
  md: { emphasised: 'bold', linkedTo: 'example.com' },
  html: { emphasised: 'every', linkedTo: 'example.com' },
  odt: { emphasised: 'bold', linkedTo: 'example.com' },
  // "Bold closing" is a bold run in an ordinary paragraph. The fixture also
  // bolds a word inside a table, which is a worse anchor: docx → rtf drops
  // tables, so an emphasis claim anchored there would fail for the wrong
  // reason and read as emphasis being lost.
  docx: { emphasised: 'Bold closing', linkedTo: 'example.com' },
  // Its one formatted run is the heading, which is also the only thing
  // rtf → md is asked to recognise.
  rtf: { emphasised: 'A large heading' },
  // pptxgenjs bolds the fixture's slide titles, and nothing else.
  pptx: { emphasised: 'Opening slide' },
  odp: {},
  epub: {},
  txt: {},
  csv: {},
  json: {},
  xlsx: {},
  ods: {},
  pdf: {},
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Escapes a fixture word so it can sit inside a pattern. */
const quote = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every entry in a package whose name matches, concatenated. */
async function entries(bytes: Uint8Array, pattern: RegExp): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (pattern.test(name) && !zip.files[name]!.dir) {
      parts.push(await zip.files[name]!.async('string'));
    }
  }
  return parts.join('\n');
}

/** Whether a package holds a file at all — an image part, a chart part. */
async function holds(bytes: Uint8Array, pattern: RegExp): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files).some((name) => pattern.test(name));
}

/**
 * Whether any part of a package mentions the host.
 *
 * A hyperlink in OOXML and ODF lives in a relationship file rather than beside
 * the text, so the whole package is the right place to look — and a nav
 * document's relative links to its own chapters never match, which is what
 * keeps an EPUB's table of contents from reading as a surviving link.
 */
async function packageLinksTo(bytes: Uint8Array, host?: string): Promise<boolean> {
  if (!host) return false;
  const all = await entries(bytes, /.*/);
  return all.includes(host);
}

// ---- Plain formats --------------------------------------------------------

function markdown(text: string, anchors: Anchors): Found {
  const emphasised = anchors.emphasised;
  return {
    headings: /^#{1,6} \S/m.test(text),
    lists: /^[ \t]*([-+]|\d+\.) \S/m.test(text),
    tables: /^\|.*\|[ \t]*$/m.test(text) && /^\|[\s:-]*-[\s|:-]*\|[ \t]*$/m.test(text),
    emphasis: emphasised
      ? new RegExp(
          `\\*\\*[^*]*${quote(emphasised)}[^*]*\\*\\*|\\*[^*\\n]*${quote(emphasised)}[^*\\n]*\\*|__[^_]*${quote(emphasised)}[^_]*__`,
        ).test(text)
      : false,
    links: anchors.linkedTo
      ? new RegExp(`\\[[^\\]]*\\]\\([^)]*${quote(anchors.linkedTo)}`).test(text)
      : false,
    images: /!\[[^\]]*\]\(/.test(text),
    quotes: /^> ?\S/m.test(text),
    code: /^ {0,3}(```|~~~)/m.test(text),
  };
}

function html(text: string, anchors: Anchors): Found {
  const emphasised = anchors.emphasised;
  return {
    headings: /<h[1-6][\s>]/i.test(text),
    lists: /<(ul|ol)[\s>]/i.test(text),
    tables: /<table[\s>]/i.test(text),
    emphasis: emphasised
      ? new RegExp(`<(strong|b|em|i)[^>]*>[^<]*${quote(emphasised)}`, 'i').test(text)
      : false,
    links: anchors.linkedTo
      ? new RegExp(`<a\\s[^>]*href="[^"]*${quote(anchors.linkedTo)}`, 'i').test(text)
      : false,
    images: /<img[\s>]/i.test(text),
    quotes: /<blockquote[\s>]/i.test(text),
    code: /<(pre|code)[\s>]/i.test(text),
    styling: /<style[\s>]|\sstyle=|<link[^>]+stylesheet/i.test(text),
    scripts: /<script[\s>]/i.test(text),
  };
}

/**
 * RTF, by its control words.
 *
 * `\b` turns bold on and `\b0` turns it off, so the anchor has to fall inside
 * a run that was switched on and not yet switched off.
 */
function rtf(text: string, anchors: Anchors): Found {
  const emphasised = anchors.emphasised;
  return {
    headings: /\\fs(3[0-9]|[4-9][0-9])\b/.test(text),
    lists: /\\bullet|\\pnlvlblt|\\listtext/.test(text),
    tables: /\\trowd/.test(text),
    // Paragraph by paragraph, because `\\b` on a heading three paragraphs up is
    // not emphasis on this word — the first draft of this matched exactly that
    // and reported md → rtf as carrying emphasis it drops.
    emphasis: emphasised
      ? text
          .split(/\\par\b/)
          .some((paragraph) =>
            new RegExp(
              `\\\\[bi](?![0-9a-z])(?:(?!\\\\[bi]0)[\\s\\S])*?${quote(emphasised)}`,
            ).test(paragraph),
          )
      : false,
    links: anchors.linkedTo ? text.includes(anchors.linkedTo) : false,
    images: /\\pict/.test(text),
  };
}

/** Plain text holds words and blank lines, and nothing a caveat names. */
function plain(): Found {
  return {};
}

function json(text: string): Found {
  return { tables: /\[\s*{/.test(text) };
}

// ---- Packages -------------------------------------------------------------

/**
 * Word.
 *
 * `quotes` and `code` ask whether the paragraph carries a **named style**,
 * because that is what the caveat claims: "map to Word styles". A paragraph
 * that merely looks like a quotation — indented, italic, direct formatting —
 * is not what was promised, and is not what a reader restyling the document
 * would find.
 */
async function docx(bytes: Uint8Array, anchors: Anchors): Promise<Found> {
  const xml = await entries(bytes, /^word\/(document|footnotes)\.xml$/);
  const emphasised = anchors.emphasised;
  const styled = (name: RegExp) =>
    new RegExp(`<w:pStyle[^>]+w:val="[^"]*${name.source}[^"]*"`, 'i').test(xml);

  return {
    headings: /w:pStyle[^>]+w:val="Heading\d/.test(xml),
    lists: /<w:numPr[\s>/]/.test(xml),
    tables: /<w:tbl[\s>]/.test(xml),
    // A run that is switched on, not one that carries w:val="false".
    emphasis: emphasised
      ? new RegExp(
          `<w:r>(?:(?!</w:r>).)*<w:(?:b|i)\\s*/>(?:(?!</w:r>).)*<w:t[^>]*>[^<]*${quote(emphasised)}`,
          's',
        ).test(xml)
      : false,
    links: await packageLinksTo(bytes, anchors.linkedTo),
    images: await holds(bytes, /^word\/media\//),
    quotes: styled(/Quote/),
    code: styled(/(Code|Preformatted|SourceText)/),
    'merged cells': /<w:gridSpan[\s>/]|<w:vMerge[\s>/]/.test(xml),
    footnotes: /<w:footnoteReference[\s>/]/.test(xml),
    charts: await holds(bytes, /^word\/charts\//),
  };
}

/** ODT and ODP share a content.xml dialect, so they share a probe. */
async function opendocument(bytes: Uint8Array, anchors: Anchors): Promise<Found> {
  const xml = await entries(bytes, /^(content|styles)\.xml$/);
  const emphasised = anchors.emphasised;

  // Which text styles are actually bold or italic, so a span can be judged by
  // what its style does rather than by the fact that it has one.
  const strong = new Set<string>();
  for (const style of xml.matchAll(
    /<style:style style:name="([^"]+)" style:family="text">([\s\S]*?)<\/style:style>/g,
  )) {
    if (/font-weight="bold"|font-style="italic"/.test(style[2]!)) strong.add(style[1]!);
  }

  const emphasisedRun = emphasised
    ? [...xml.matchAll(/<text:span text:style-name="([^"]+)"[^>]*>([^<]*)</g)].some(
        (span) => strong.has(span[1]!) && span[2]!.includes(emphasised),
      )
    : false;

  return {
    headings: /<text:h[\s>]/.test(xml),
    lists: /<text:list[\s>]/.test(xml),
    tables: /<table:table[\s>]/.test(xml),
    emphasis: emphasisedRun,
    links: await packageLinksTo(bytes, anchors.linkedTo),
    images: /<draw:image[\s>]/.test(xml),
    quotes: /text:style-name="Quotations"/.test(xml),
    code: /text:style-name="Preformatted_20_Text"/.test(xml),
    'merged cells': /table:number-columns-spanned="[2-9]/.test(xml),
    'speaker notes': /<presentation:notes[\s>]/.test(xml),
    footnotes: /<text:note[\s>]/.test(xml),
    charts: /<draw:object[^>]+chart/.test(xml),
  };
}

async function pptx(bytes: Uint8Array, anchors: Anchors): Promise<Found> {
  const slides = await entries(bytes, /^ppt\/slides\/slide\d+\.xml$/);
  const emphasised = anchors.emphasised;
  return {
    // pptxgenjs writes plain text boxes rather than title placeholders, so the
    // first paragraph of the first shape is what a reader sees as the title.
    headings: /<a:t>[^<]+<\/a:t>/.test(slides),
    lists: /<a:buChar[\s>/]|<a:buAutoNum[\s>/]|marL="[1-9]/.test(slides),
    tables: /<a:tbl[\s>]/.test(slides),
    emphasis: emphasised
      ? new RegExp(
          `<a:r>(?:(?!</a:r>).)*\\b[bi]="(?:1|true)"(?:(?!</a:r>).)*<a:t>[^<]*${quote(emphasised)}`,
          's',
        ).test(slides)
      : false,
    links: await packageLinksTo(bytes, anchors.linkedTo),
    images: await holds(bytes, /^ppt\/media\//),
    'speaker notes': await holds(bytes, /^ppt\/notesSlides\/notesSlide\d+\.xml$/),
    charts: await holds(bytes, /^ppt\/charts\//),
  };
}

async function xlsx(bytes: Uint8Array): Promise<Found> {
  const sheets = await entries(bytes, /^xl\/worksheets\/sheet\d+\.xml$/);
  const styles = await entries(bytes, /^xl\/styles\.xml$/);
  return {
    tables: /<row[\s>]/.test(sheets),
    formulas: /<f[\s>]/.test(sheets),
    'merged cells': /<mergeCell[\s>/]/.test(sheets),
    images: await holds(bytes, /^xl\/media\//),
    charts: await holds(bytes, /^xl\/charts\//),
    // Every workbook has a default fill and font; more than the defaults is
    // formatting somebody chose.
    styling:
      /<fills count="([3-9]|\d\d)/.test(styles) ||
      /<fonts count="([2-9]|\d\d)/.test(styles),
  };
}

async function ods(bytes: Uint8Array): Promise<Found> {
  const xml = await entries(bytes, /^content\.xml$/);
  return {
    tables: /<table:table-row[\s>]/.test(xml),
    formulas: /table:formula=/.test(xml),
    'merged cells': /table:number-columns-spanned="[2-9]/.test(xml),
    images: /<draw:image[\s>]/.test(xml),
    charts: /<draw:object[^>]+chart/.test(xml),
    styling: /<style:table-cell-properties[\s>]/.test(xml),
  };
}

/**
 * An EPUB is XHTML in a box.
 *
 * The navigation document is skipped: its links point at the book's own
 * chapters, and counting them would report every book as carrying links.
 */
async function epub(bytes: Uint8Array, anchors: Anchors): Promise<Found> {
  const text = await entries(bytes, /\.(x?html)$/);
  const found = html(text, anchors);
  return {
    ...found,
    links: await packageLinksTo(bytes, anchors.linkedTo),
    styling: found.styling || (await holds(bytes, /\.css$/)),
    images: await holds(bytes, /\.(png|jpe?g|gif|svg)$/),
  };
}

/**
 * A PDF, read as PDF syntax rather than as a picture.
 *
 * A `/Link` annotation is how a PDF records a hyperlink, so its absence is a
 * real answer. Everything else a caveat says about a PDF — headings, lists,
 * tables, emphasis — is about how the page looks, and a PDF records the
 * position of text runs rather than what they mean. Those claims are reported
 * as unverifiable rather than guessed at.
 */
function pdf(bytes: Uint8Array, anchors: Anchors): Found {
  const raw = decode(bytes);
  return {
    links:
      /\/Subtype\s*\/Link/.test(raw) ||
      (anchors.linkedTo ? raw.includes(anchors.linkedTo) : false),
    images: /\/Subtype\s*\/Image/.test(raw),
  };
}

// ---- The dispatcher -------------------------------------------------------

/** What this file actually contains, judged against the source's anchors. */
export async function featuresOf(
  format: Format,
  bytes: Uint8Array,
  anchors: Anchors,
): Promise<Found> {
  switch (format) {
    case 'md':
      return markdown(decode(bytes), anchors);
    case 'html':
      return html(decode(bytes), anchors);
    case 'rtf':
      return rtf(decode(bytes), anchors);
    case 'txt':
    case 'csv':
      return plain();
    case 'json':
      return json(decode(bytes));
    case 'docx':
      return docx(bytes, anchors);
    case 'odt':
    case 'odp':
      return opendocument(bytes, anchors);
    case 'pptx':
      return pptx(bytes, anchors);
    case 'xlsx':
      return xlsx(bytes);
    case 'ods':
      return ods(bytes);
    case 'epub':
      return epub(bytes, anchors);
    case 'pdf':
      return pdf(bytes, anchors);
  }
}

/**
 * The features a format can hold at all.
 *
 * A caveat promising that headings survive into plain text would be nonsense,
 * and a probe answering `false` would read as a broken promise rather than an
 * impossible one. A "dropped" claim about something the target cannot express
 * is reported as holding by construction; a "survives" claim about one is a
 * caveat that cannot be true.
 */
const CAN_HOLD: Record<Format, Feature[]> = {
  md: ['headings', 'lists', 'tables', 'emphasis', 'links', 'images', 'quotes', 'code'],
  html: [
    'headings',
    'lists',
    'tables',
    'emphasis',
    'links',
    'images',
    'quotes',
    'code',
    'styling',
    'scripts',
  ],
  rtf: ['headings', 'lists', 'tables', 'emphasis', 'links', 'images'],
  txt: [],
  csv: [],
  json: ['tables'],
  docx: [
    'headings',
    'lists',
    'tables',
    'emphasis',
    'links',
    'images',
    'quotes',
    'code',
    'merged cells',
    'footnotes',
    'charts',
  ],
  odt: [
    'headings',
    'lists',
    'tables',
    'emphasis',
    'links',
    'images',
    'quotes',
    'code',
    'merged cells',
    'footnotes',
    'charts',
  ],
  odp: [
    'headings',
    'lists',
    'tables',
    'emphasis',
    'links',
    'images',
    'speaker notes',
    'charts',
  ],
  pptx: [
    'headings',
    'lists',
    'tables',
    'emphasis',
    'links',
    'images',
    'speaker notes',
    'charts',
  ],
  xlsx: ['tables', 'formulas', 'merged cells', 'images', 'charts', 'styling'],
  ods: ['tables', 'formulas', 'merged cells', 'images', 'charts', 'styling'],
  epub: [
    'headings',
    'lists',
    'tables',
    'emphasis',
    'links',
    'images',
    'quotes',
    'code',
    'styling',
  ],
  // Emphasis is listed because a PDF really can carry it, as a second embedded
  // face. The probe leaves it undefined rather than answering "no": a PDF
  // records where a run was drawn, not that it meant anything, so the claim is
  // reported as unverifiable instead of as true by construction.
  pdf: ['links', 'images', 'emphasis'],
};

export function canHold(format: Format, feature: Feature): boolean {
  return CAN_HOLD[format].includes(feature);
}
