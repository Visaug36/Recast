import type { Metadata, Viewport } from 'next';
import { Schibsted_Grotesk, Spline_Sans_Mono } from 'next/font/google';
import { THEME_COLOR } from '@/lib/theme';
import { totals } from '@/lib/registry/matrix';
import './globals.css';

/* next/font downloads these at build time and serves them from Recast's own
   origin. No request reaches a font CDN when someone opens the page — which is
   what makes "files never leave your browser" checkable rather than asserted,
   and what lets the page keep working with the network unplugged.

   The design file links Google's stylesheet because a design file has to; the
   product must not, and `pnpm verify:browser` fails on any off-origin request. */
const grotesk = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-grotesk',
  display: 'swap',
});

const splineMono = Spline_Sans_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-spline-mono',
  display: 'swap',
});

/**
 * Next applies `basePath` to everything under `_next/`, but not to a path given
 * in `metadata.icons` — that one has to be prefixed here or it 404s on a Pages
 * project site. Empty string in dev and on Vercel, so the path is unchanged.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * Where the site is served from, for absolute metadata URLs.
 *
 * The workflow derives it from GITHUB_REPOSITORY, the same value the basePath
 * comes from, so a rename carries it. Unset in dev and in tests, where the
 * relative tags are correct and an absolute one would be a guess.
 */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

const counts = totals();

/**
 * What a tab says.
 *
 * Checked as a tab rather than as a string. Chrome gives a tab roughly 240px
 * with a handful open and 120px on a bad day, which is about 26 and 9
 * characters of title. The old one was 42 — it truncated at every width, so
 * "…in your browser" was never once read by anybody.
 *
 * 26 fits whole at 240 and degrades to "Recast — convert…", which is the two
 * words worth having. `template` puts a sub-page's own name first for the same
 * reason: at 120px "The full…" is a different tab and "Recast…" is not.
 */
export const metadata: Metadata = {
  title: {
    default: 'Recast — convert documents',
    template: '%s — Recast',
  },
  description: `Convert between ${counts.formats} document formats — ${counts.pairs} pairs — without uploading anything. Every conversion runs in your browser; there is no server to send a file to.`,
  applicationName: 'Recast',
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  openGraph: {
    type: 'website',
    siteName: 'Recast',
    locale: 'en',
    title: 'Recast — convert documents',
    description: `Convert between ${counts.formats} document formats — ${counts.pairs} pairs — without uploading anything. Every conversion runs in your browser; there is no server to send a file to.`,
    ...(siteUrl
      ? { url: siteUrl, images: [{ url: '/icon-512.png', width: 512, height: 512 }] }
      : {}),
  },
  twitter: { card: 'summary' },
  icons: {
    icon: [
      { url: `${basePath}/icon.svg`, type: 'image/svg+xml' },
      { url: `${basePath}/icon-32.png`, sizes: '32x32', type: 'image/png' },
      { url: `${basePath}/icon-16.png`, sizes: '16x16', type: 'image/png' },
    ],
    apple: `${basePath}/icon-180.png`,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR.dark },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${splineMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
