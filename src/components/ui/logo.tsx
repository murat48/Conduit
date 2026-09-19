import React from 'react';

/**
 * The Conduit mark: a channel that comes back.
 *
 * Inline rather than an `<img>` so it takes `currentColor` — the same mark serves the header, a
 * disabled state and a one-colour context without three files existing to say the same thing.
 * The geometry matches public/logo.svg, which carries an explicit colour for places that have no
 * CSS to inherit from, such as a README.
 */
export const Logo: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 64 64" fill="none" role="img" aria-label="Conduit" className={className}>
    <path
      d="M43.76 15.21A20.5 20.5 0 1 0 43.76 48.79"
      stroke="currentColor"
      strokeWidth="11"
      strokeLinecap="round"
    />
    <circle cx="52.5" cy="32" r="5.5" fill="currentColor" />
  </svg>
);

export default Logo;
