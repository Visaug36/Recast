import { engineFor } from '@/lib/registry/engines';
import type { Format } from '@/lib/registry/types';

/**
 * The text inside a document, whatever the document is.
 *
 * Half of what a caveat promises is about words rather than structure — "you
 * keep the words", "only the values survive", "slide text only, in reading
 * order". Checking those means reading the output back, and Recast already
 * owns a reader for every format it writes.
 *
 * **This is circular on purpose, and the circle is bounded.** If a reader is
 * broken, a claim checked through it could pass wrongly. That trade is worth
 * taking because the readers are tested directly and against fixtures produced
 * by other tools in `converters.test.ts`, while the alternative — a second
 * parser per format, written here — would be a second thing to keep true. What
 * this must never be used for is checking a claim about the reader's own edge:
 * `pdf → txt` is not checked by reading its output with `pdf → txt`.
 */
const READERS: Partial<Record<Format, Format>> = {
  docx: 'txt',
  pdf: 'txt',
  rtf: 'txt',
  odt: 'md',
  odp: 'txt',
  pptx: 'txt',
  epub: 'md',
  xlsx: 'txt',
  ods: 'txt',
};

/** Formats that are already text, and need no reader at all. */
const PLAIN: Format[] = ['md', 'txt', 'csv', 'json', 'html'];

export async function readBack(format: Format, bytes: Uint8Array): Promise<string> {
  if (PLAIN.includes(format)) return new TextDecoder().decode(bytes);

  const via = READERS[format];
  if (!via) throw new Error(`no way to read ${format} back`);

  const load = engineFor(format, via);
  if (!load) throw new Error(`no ${format} → ${via} engine to read with`);

  const convert = await load();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const result = await convert(new File([copy], `read-back.${format}`));
  const parts = await Promise.all(
    result.files.map(async (file) =>
      new TextDecoder().decode(new Uint8Array(await file.blob.arrayBuffer())),
    ),
  );
  return parts.join('\n');
}

/** Which reader `readBack` would use, so a test can refuse to check its own edge. */
export function readerFor(format: Format): Format | undefined {
  return PLAIN.includes(format) ? undefined : READERS[format];
}
