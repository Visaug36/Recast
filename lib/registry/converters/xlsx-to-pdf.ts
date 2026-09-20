import type { ConversionResult, ProgressFn } from '../types';
import { outputFile } from '../shared';
import { readWorkbook } from './_sheet';
import {
  MAX_PDF_COLUMNS,
  MAX_PDF_COLUMNS_LANDSCAPE,
  clippedWarning,
  pdfTable,
  tableWasClipped,
  turnedSidewaysNote,
  widestRow,
} from './_blocks-to-pdf';
import { pdfDocument, renderPdf, requireContent } from './_pdf';

/**
 * A workbook, drawn.
 *
 * The page is turned to fit the widest sheet rather than always being one way
 * round. Upright holds twelve columns and landscape eighteen, so a narrow
 * sheet is set the way a document is, and a wide one gets the extra six
 * columns before anything is cut off.
 *
 * Landscape used to be unconditional, which made every three-column sheet a
 * sideways page for the benefit of a wide one that might not be there, and
 * clipped at twelve anyway — so the orientation cost something on every
 * conversion and bought nothing on the one it was for.
 */
export async function convert(
  input: File,
  onProgress?: ProgressFn,
): Promise<ConversionResult> {
  const { sheets, warnings } = await readWorkbook(input, onProgress);
  const many = sheets.length > 1;

  const widest = widestRow(sheets.map((sheet) => sheet.rows));
  const landscape = widest > MAX_PDF_COLUMNS;
  const limit = landscape ? MAX_PDF_COLUMNS_LANDSCAPE : MAX_PDF_COLUMNS;

  const content: Record<string, unknown>[] = [];
  let clipped = false;

  for (const [index, sheet] of sheets.entries()) {
    if (sheet.rows.length === 0) continue;
    if (many) {
      content.push({
        text: sheet.name,
        style: 'h2',
        pageBreak: index > 0 ? 'before' : undefined,
      });
    }
    if (tableWasClipped(sheet.rows, limit)) clipped = true;
    content.push(pdfTable(sheet.rows, limit));
  }

  onProgress?.({ phase: 'writing' });
  const render = await renderPdf(
    pdfDocument(requireContent(content, 'data'), {
      ...(landscape ? { pageOrientation: 'landscape' } : {}),
    }),
  );

  const notes = [...warnings, ...render.warnings];
  // The clipping first, because it is the only one of the two that lost
  // anything; turning the page is a note about how it was drawn.
  if (landscape) notes.unshift(turnedSidewaysNote(widest));
  if (clipped) notes.unshift(clippedWarning('Sheets', limit));

  return {
    files: [outputFile(input.name, 'pdf', render.bytes)],
    warnings: notes.length ? notes : undefined,
  };
}
