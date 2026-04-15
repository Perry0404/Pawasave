'use client'

export default function Logo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      className={className}
    >
      <defs>
        <linearGradient id="pawa-g" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">
          <stop stopColor="#10B981" />
          <stop offset="1" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      {/* P stem */}
      <path d="M18 12 H34 V108 H18 Z" fill="url(#pawa-g)" />
      {/* P bowl */}
      <path
        d="M34 12 H60 C82 12 96 26 96 44 C96 62 82 76 60 76 H34 V60 H58 C70 60 78 54 78 44 C78 34 70 28 58 28 H34 Z"
        fill="url(#pawa-g)"
      />
      {/* S curve bottom */}
      <path
        d="M42 68 H62 C84 68 102 80 102 96 C102 108 90 116 72 116 H34 V100 H70 C80 100 86 96 86 90 C86 82 78 76 66 76 H34"
        fill="url(#pawa-g)"
        opacity="0.85"
      />
    </svg>
  )
}
