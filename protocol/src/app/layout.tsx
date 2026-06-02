import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "PawaSave Protocol — cNGN Lending Pool",
  description: "The first cNGN lending pool on Base. Supply cNGN to earn yield. Borrow cNGN against USDC collateral.",
  metadataBase: new URL("https://protocol.pawasave.xyz"),
  openGraph: {
    title: "PawaSave Protocol",
    description: "The first cNGN lending pool on Base.",
    url: "https://protocol.pawasave.xyz",
    siteName: "PawaSave Protocol",
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  )
}
