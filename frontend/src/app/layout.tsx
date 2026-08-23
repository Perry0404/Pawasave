import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ConfirmProvider } from '@/components/confirm-dialog'
import ServiceWorkerRegister from '@/components/service-worker-register'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'PawaSave — Save Smarter for Your Business',
  description: 'Nigerian fintech platform to save in USDC, join Esusu circles, and grow your business savings.',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'PawaSave',
  },
  // Base app registration (dashboard.base.org) — verifies domain ownership.
  other: {
    'base:app_id': '6a7a5fd689d920176739d27e',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#059669',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body className={inter.className}><ConfirmProvider>{children}</ConfirmProvider><ServiceWorkerRegister /></body>
    </html>
  )
}
