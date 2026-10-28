/**
 * Inline SVG marks for the carbon page.
 *
 * The page deliberately depends on no icon package: the shared primitives'
 * icon set is host-versioned, and a rename there would take the whole panel
 * down for a row that only needs six small glyphs. All marks inherit
 * `currentColor` and size from the caller.
 */

function svgProps({ size = 16, className, ...rest }) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.25,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    className,
    ...rest,
  };
}

export function LeafIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13.25 2.75C8.1 2.75 3.6 5.4 3.6 9.7a2.9 2.9 0 0 0 5.5 1.4c1.3-2.5 2.7-5.2 4.15-8.35Z" />
      <path d="M2.9 14c1.4-3.8 4.1-6.6 7.4-8.3" />
    </svg>
  );
}

export function RefreshIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13 6.6A5.1 5.1 0 1 0 13.2 9" />
      <path d="M13 2.9v3.8H9.2" />
    </svg>
  );
}

export function CarIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.4 9.4 3.3 6.7A1.1 1.1 0 0 1 4.34 6h7.32a1.1 1.1 0 0 1 1.04.7l.9 2.7" />
      <path d="M1.9 9.4h12.2v3.1a.5.5 0 0 1-.5.5h-.9a.5.5 0 0 1-.5-.5v-.6H3.8v.6a.5.5 0 0 1-.5.5H2.4a.5.5 0 0 1-.5-.5V9.4Z" />
      <path d="M4.6 11.2h.01M11.4 11.2h.01" strokeWidth="2" />
    </svg>
  );
}

export function KettleIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.9 6.2h8.2v5.1a2.4 2.4 0 0 1-2.4 2.4H6.3a2.4 2.4 0 0 1-2.4-2.4V6.2Z" />
      <path d="M12.1 7.2h.9a1.25 1.25 0 0 1 0 2.5h-.9" />
      <path d="M6.2 3.4c0 .8.7 1 .7 1.9M9.1 3.1c0 .8.7 1 .7 1.9" />
    </svg>
  );
}

export function PhoneIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <rect x="5.1" y="2.3" width="5.8" height="11.4" rx="1.4" />
      <path d="M7.3 11.9h1.4" />
    </svg>
  );
}

export function InfoIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 7.2v3.4M8 5.1h.01" strokeWidth="1.6" />
    </svg>
  );
}

export function ChevronIcon({ open = false, ...props }) {
  return (
    <svg {...svgProps(props)} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}>
      <path d="m6.2 3.9 4 4.1-4 4.1" />
    </svg>
  );
}

export function SparkIcon(props) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2.2 9.5 6l3.8 1.5L9.5 9 8 12.8 6.5 9 2.7 7.5 6.5 6 8 2.2Z" />
    </svg>
  );
}
