declare global {
  interface Window {
    PaychantWidget?: new (config: PaychantConfig) => PaychantInstance
  }
}

interface PaychantConfig {
  env: 'sandbox' | 'production'
  action: 'buy' | 'sell'
  selectedAsset?: string
  partnerApiKey: string
  partnerLogoUrl?: string
  partnerThemeColor?: string
  email?: string
  callback?: {
    onStatus?: (status: PaychantStatus) => void
    onClose?: () => void
  }
}

interface PaychantInstance {
  openWindow: () => void
}

export interface PaychantStatus {
  status: string
  reference?: string
  transactionId?: string
  amount?: number
  currency?: string
}

const PAYCHANT_API_KEY = process.env.NEXT_PUBLIC_PAYCHANT_API_KEY || ''
const PAYCHANT_ENV = (process.env.NEXT_PUBLIC_PAYCHANT_ENV || 'sandbox') as 'sandbox' | 'production'

export function loadPaychantScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.PaychantWidget) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://static.paychant.com/widget/v1/paychant-widget.min.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Paychant widget'))
    document.head.appendChild(script)
  })
}

export async function openDeposit(
  email: string,
  onStatus: (s: PaychantStatus) => void,
  onClose?: () => void
) {
  await loadPaychantScript()
  if (!window.PaychantWidget) throw new Error('Paychant not loaded')

  const widget = new window.PaychantWidget({
    env: PAYCHANT_ENV,
    action: 'buy',
    selectedAsset: 'base_usdc',
    partnerApiKey: PAYCHANT_API_KEY,
    partnerLogoUrl: '/icon-192.png',
    partnerThemeColor: '#059669',
    email,
    callback: { onStatus, onClose },
  })
  widget.openWindow()
}

export async function openWithdraw(
  email: string,
  onStatus: (s: PaychantStatus) => void,
  onClose?: () => void
) {
  await loadPaychantScript()
  if (!window.PaychantWidget) throw new Error('Paychant not loaded')

  const widget = new window.PaychantWidget({
    env: PAYCHANT_ENV,
    action: 'sell',
    selectedAsset: 'base_usdc',
    partnerApiKey: PAYCHANT_API_KEY,
    partnerLogoUrl: '/icon-192.png',
    partnerThemeColor: '#059669',
    email,
    callback: { onStatus, onClose },
  })
  widget.openWindow()
}
