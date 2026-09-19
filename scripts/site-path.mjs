/**
 * Prints the path a GitHub Pages project site is served from, e.g. `/Recast`.
 *
 * Read from `homepage` in package.json, which is committed, rather than from
 * the git remote. A remote is per-checkout state: this container has reset it
 * to the pre-rename URL at the start of three separate sessions, and because
 * GitHub redirects the old URL it keeps working while quietly handing over the
 * previous name. A local check then builds and serves at the same wrong prefix
 * and passes, because both halves agree.
 *
 * CI derives the same value independently from GITHUB_REPOSITORY and fails if
 * the two disagree, so the committed value cannot go stale either.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { homepage } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!homepage) {
  console.error('package.json has no "homepage", so the site path is unknown.');
  process.exit(1);
}

/** `/Recast/` → `/Recast`; a root-hosted site prints nothing, which is correct. */
export const sitePath = new URL(homepage).pathname.replace(/\/$/, '');

/** The whole published URL, for the absolute metadata the Open Graph tags need. */
export const siteUrl = homepage.endsWith('/') ? homepage : `${homepage}/`;

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // `--url` for the metadata base, the bare path for basePath. One committed
  // source for both, so a local build carries the same og:url CI publishes.
  console.log(process.argv.includes('--url') ? siteUrl : sitePath);
}
