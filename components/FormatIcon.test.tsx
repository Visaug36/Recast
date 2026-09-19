import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FORMATS } from '@/lib/registry';
import FormatIcon from './FormatIcon';
import StaffMark from './StaffMark';

const globals = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');

describe('the format tiles', () => {
  it('draws one for every format the registry declares', () => {
    // `Record<Format, Tile>` makes this a compile error rather than a runtime
    // one, so this is really asserting that nothing renders empty — a missing
    // tile would be a blank square beside a filename, which looks deliberate.
    for (const format of FORMATS) {
      const { container, unmount } = render(<FormatIcon format={format} />);
      const svg = container.querySelector('svg')!;

      expect(svg, format).not.toBeNull();
      // Markdown draws its field from a variable so it can invert in dark
      // mode; the other thirteen are one colour in both themes.
      expect(svg.querySelector('rect')?.getAttribute('fill'), format).toMatch(
        /^(#[0-9a-f]{6}|var\(--format-[a-z-]+\))$/,
      );
      expect(svg.querySelector('text')?.textContent, format).toBeTruthy();
      unmount();
    }
  });

  it('gives each format a colour of its own', () => {
    const fills = FORMATS.map((format) => {
      const { container, unmount } = render(<FormatIcon format={format} />);
      const fill = container.querySelector('rect')!.getAttribute('fill')!;
      unmount();
      return fill;
    });

    expect(fills).toHaveLength(FORMATS.length);

    // The point of the tiles is that a row is identifiable before its label is
    // read, which fails the moment two formats share a field colour.
    expect(new Set(fills).size).toBe(FORMATS.length);
  });

  it('marks the three OpenDocument formats apart from their siblings', () => {
    // .odt/.ods/.odp carry the same letters as Word/Excel/PowerPoint because
    // they are the same kind of document. The bar is the only thing telling
    // them apart at 20px, so it has to be there.
    for (const format of ['odt', 'ods', 'odp'] as const) {
      const { container, unmount } = render(<FormatIcon format={format} />);
      expect(container.querySelectorAll('rect'), format).toHaveLength(2);
      unmount();
    }

    for (const format of ['docx', 'xlsx', 'pptx'] as const) {
      const { container, unmount } = render(<FormatIcon format={format} />);
      expect(container.querySelectorAll('rect'), format).toHaveLength(1);
      unmount();
    }
  });

  it('scales from a job row to a format tile without redrawing', () => {
    const { container: small } = render(<FormatIcon format="pdf" size={20} />);
    const { container: large } = render(<FormatIcon format="pdf" size={64} />);

    // One viewBox, two sizes: the geometry is written once.
    expect(small.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(large.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(small.querySelector('svg')?.getAttribute('width')).toBe('20');
    expect(large.querySelector('svg')?.getAttribute('width')).toBe('64');
  });

  it('says nothing to a screen reader, because the filename already did', () => {
    const { container } = render(<FormatIcon format="docx" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

/**
 * Markdown's tile is the one format colour with a theme, and that is a rule
 * rather than something that happened to one tile.
 *
 * Its field is near-black, which is the format's identity — and invisible on a
 * dark card. Greying it down is the obvious repair and the wrong one: it lands
 * on `txt`, and the tiles exist so a row is identifiable before its label is
 * read. So it inverts, and these are the terms of the exception.
 */
describe('the one tile with a theme', () => {
  /** `--format-md: #1f1d26;` from one block of globals.css. */
  function variable(selector: string, name: string): string {
    const open = globals.indexOf('{', globals.indexOf(selector));
    const body = globals.slice(open, globals.indexOf('\n}', open));
    const found = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(body);
    if (!found) throw new Error(`no --${name} in ${selector}`);
    return found[1]!;
  }

  /** Rough perceived lightness, 0–1. Enough to tell inverted from greyed. */
  function lightness(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }

  /** Which formats draw their field from a variable rather than a literal. */
  function themed(): string[] {
    return FORMATS.filter((format) => {
      const { container, unmount } = render(<FormatIcon format={format} />);
      const fill = container.querySelector('rect')!.getAttribute('fill')!;
      unmount();
      return fill.startsWith('var(');
    });
  }

  it('is Markdown, and only Markdown', () => {
    // Thirteen formats keep one colour in both themes. A second themed tile is
    // a decision, not a detail, so it should arrive with its own reason.
    expect(themed()).toEqual(['md']);
  });

  it('inverts rather than greying, in both directions', () => {
    const lightField = variable(':root {', 'format-md');
    const darkField = variable(':root.dark {', 'format-md');

    expect(lightness(lightField)).toBeLessThan(0.3);
    expect(lightness(darkField)).toBeGreaterThan(0.7);

    // The letterform goes the other way, or the tile is a solid block.
    expect(lightness(variable(':root {', 'format-md-ink'))).toBeGreaterThan(0.7);
    expect(lightness(variable(':root.dark {', 'format-md-ink'))).toBeLessThan(0.3);
  });

  it("never lands on another format's colour in either theme", () => {
    // The failure this exception exists to avoid: greyed down for legibility,
    // Markdown becomes txt.
    const others = FORMATS.filter((format) => format !== 'md').map((format) => {
      const { container, unmount } = render(<FormatIcon format={format} />);
      const fill = container.querySelector('rect')!.getAttribute('fill')!;
      unmount();
      return fill;
    });

    for (const selector of [':root {', ':root.dark {']) {
      expect(others, selector).not.toContain(variable(selector, 'format-md'));
    }
  });
});

describe('the staff', () => {
  it('draws the same mark the favicon does', () => {
    // `scripts/make-icons.mjs` writes public/icon.svg and this component draws
    // it inline. Two copies of one drawing is one copy that goes stale, so the
    // geometry is compared rather than trusted.
    const favicon = readFileSync(join(process.cwd(), 'public', 'icon.svg'), 'utf8');
    const { container } = render(<StaffMark />);
    const inline = container.innerHTML;

    for (const part of [
      'rotate(12 32 30)',
      'd="M32 3 44 15 32 27 20 15z"',
      '#5b1d8e',
      '#f6f0fc',
    ]) {
      expect(favicon, `favicon: ${part}`).toContain(part);
      expect(inline, `inline: ${part}`).toContain(part);
    }
  });

  it('is tilted, and within the range the tilt was asked for', () => {
    const favicon = readFileSync(join(process.cwd(), 'public', 'icon.svg'), 'utf8');
    const angle = Number(/rotate\((\d+(?:\.\d+)?)/.exec(favicon)?.[1]);

    // Upright reads as a diagram of a staff. Past 12 the stone swings clear of
    // the shaft and the silhouette becomes an axe — see make-icons.mjs.
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeLessThanOrEqual(12);
  });
});
