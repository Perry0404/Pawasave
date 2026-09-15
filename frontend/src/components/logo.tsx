'use client'

import { useId } from 'react'

/**
 * The brand mark. Deep blue → deep green glass tile with the wordmark knocked out.
 *
 * The gradient lives on the tile, not the letterform: at 32px the strokes are ~4px
 * wide and carry no visible colour, while the tile still shows the full ramp.
 * This is the only gradient in the product — see spec `frontend-ux-elevation` D21/D23.
 * Blue appears nowhere else in the system and must not leak into UI chrome.
 */
export default function Logo({ size = 32, className = '', rounded = true }: { size?: number; className?: string; rounded?: boolean }) {
  // Two logos on one page previously shared a hardcoded gradient id and the second
  // inherited the first's definition.
  const uid = useId().replace(/:/g, '')
  const tile = `ps-tile-${uid}`
  const sheen = `ps-sheen-${uid}`
  const rim = `ps-rim-${uid}`
  const face = `ps-face-${uid}`
  const cut = `ps-cut-${uid}`

  const radius = rounded ? 116 : 0

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      role="img"
      aria-label="PawaSave"
    >
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0A2A4A" />
          <stop offset="0.46" stopColor="#0A4A52" />
          <stop offset="1" stopColor="#0A6B42" />
        </linearGradient>

        {/* specular sweep — the highlight that reads as glass */}
        <linearGradient id={sheen} x1="60" y1="20" x2="330" y2="400" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.24" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.06" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>

        {/* inner rim light — bright top edge, faint bounce along the bottom */}
        <linearGradient id={rim} x1="256" y1="0" x2="256" y2="512" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.5" />
          <stop offset="0.38" stopColor="#FFFFFF" stopOpacity="0.07" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.16" />
        </linearGradient>

        {/* the mark itself, frosted rather than flat white */}
        <linearGradient id={face} x1="150" y1="120" x2="348" y2="392" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.97" />
          <stop offset="1" stopColor="#EAF4EF" stopOpacity="0.88" />
        </linearGradient>

        {/* counters are masked out, not overpainted, so the tile shows through them */}
        <mask id={cut}>
          <rect width="512" height="512" fill="#000" />
          <g fill="#fff">
            <rect x="132" y="120" width="78" height="272" rx="12" />
            <rect x="150" y="120" width="176" height="132" rx="66" />
            <rect x="150" y="246" width="198" height="146" rx="73" />
          </g>
          <g fill="#000">
            <rect x="208" y="150" width="82" height="72" rx="36" />
            <rect x="208" y="278" width="100" height="88" rx="44" />
          </g>
        </mask>
      </defs>

      <rect width="512" height="512" rx={radius} fill={`url(#${tile})`} />
      <rect width="512" height="512" rx={radius} fill={`url(#${sheen})`} />
      <rect
        x="1.5"
        y="1.5"
        width="509"
        height="509"
        rx={rounded ? radius - 1.5 : 0}
        fill="none"
        stroke={`url(#${rim})`}
        strokeWidth="3"
      />

      <rect width="512" height="512" fill={`url(#${face})`} mask={`url(#${cut})`} />
    </svg>
  )
}
