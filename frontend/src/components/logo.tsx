'use client'

export default function Logo({ size = 32, className = '', rounded = true }: { size?: number; className?: string; rounded?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      className={className}
    >
      <defs>
        <linearGradient id="pawa-b" x1="150" y1="120" x2="360" y2="392" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2DD4C4" />
          <stop offset="1" stopColor="#12B981" />
        </linearGradient>
      </defs>
      {/* navy badge */}
      <rect width="512" height="512" rx={rounded ? 116 : 0} fill="#0A0E1A" />
      {/* B mark */}
      <g fill="url(#pawa-b)">
        <rect x="132" y="120" width="78" height="272" rx="12" />
        <rect x="150" y="120" width="176" height="132" rx="66" />
        <rect x="150" y="246" width="198" height="146" rx="73" />
      </g>
      {/* counters */}
      <g fill="#0A0E1A">
        <rect x="208" y="150" width="82" height="72" rx="36" />
        <rect x="208" y="278" width="100" height="88" rx="44" />
      </g>
    </svg>
  )
}