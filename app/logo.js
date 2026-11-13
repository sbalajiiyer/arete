// The Arete mark: an "A" drawn as a ridge line (an arête) with the crossbar picked out in amber.
export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Arete" style={{ display: 'block', flex: 'none' }}>
      <rect width="32" height="32" rx="7" fill="#14304d" />
      <path d="M7.5 24 16 8l8.5 16" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 18.5h8" fill="none" stroke="#e8a317" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}
