export default function Orb({ state = 'idle' }) {
  const label = state === 'idle' ? 'idle' : state;
  return (
    <div className={`fraymus-orb is-${state}`} role="img" aria-label={`F.R.A.Y.M.U.S. is ${label}`}>
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <circle className="orb-glow" cx="110" cy="110" r="70" />
        <circle className="orb-ring ring-a" cx="110" cy="110" r="92" />
        <circle className="orb-ring ring-b" cx="110" cy="110" r="74" />
        <circle className="orb-ring ring-c" cx="110" cy="110" r="56" />
        <circle className="orb-core" cx="110" cy="110" r="16" />
        <circle className="orb-hot" cx="110" cy="110" r="5" />
      </svg>
      <div className="orb-state">{label}</div>
    </div>
  );
}
