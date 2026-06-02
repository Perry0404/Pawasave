import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "PawaSave Protocol — cNGN Lending Pool",
  description: "The first cNGN lending pool on Base. Supply cNGN to earn yield. Borrow cNGN against USDC collateral.",
}

export default function ProtocolLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans antialiased">
      {children}
    </div>
  )
}
