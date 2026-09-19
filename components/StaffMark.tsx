/**
 * The staff, drawn rather than fetched.
 *
 * Same geometry as `public/icon.svg`, which `scripts/make-icons.mjs` writes —
 * a shaft with a cut stone at its head, tilted 12° so it reads as something
 * held rather than a diagram of itself. The two are kept in step by a test.
 *
 * **12 is the ceiling, not a middle.** The tilt was asked for at 12–15°, and
 * the stone stops crowning the shaft between 12 and 13: it is 24 units across
 * on a 7-unit shaft, so past that its lower facet swings clear and opens a
 * notch on the left, which is an axe. Steeper would mean redrawing the head,
 * and the head is the design's. Reasoning in `docs/DECISIONS.md` and the `TILT`
 * comment in `scripts/make-icons.mjs`; a test fails above 12.
 *
 * The two hex literals are deliberate. Everywhere else a component must use a
 * token, but this drawing has to match `public/icon.svg` exactly, and a favicon
 * written to disk cannot read a CSS variable.
 */
export default function StaffMark({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect width="64" height="64" rx="12" fill="#5b1d8e" />
      <g transform="rotate(12 32 30)">
        <rect x="28.5" y="24" width="7" height="34" rx="1.5" fill="#f6f0fc" />
        <path d="M32 3 44 15 32 27 20 15z" fill="#f6f0fc" />
      </g>
    </svg>
  );
}
