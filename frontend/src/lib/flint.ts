// Client-side helpers to call our secure API routes (FlintAPI key stays server-side)

export interface RampResult {
  transactionId: string
  reference: string
  // on-ramp: bank details to pay into
  bankName?: string
  bankCode?: string
  accountNumber?: string
  accountName?: string
  amount?: number
  // off-ramp: deposit address for stablecoin
  depositAddress?: string
}

export interface Bank {
  name: string
  code: string
}

export async function initiateDeposit(amountNaira: number): Promise<RampResult> {
  const res = await fetch('/api/ramp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'on', amount: amountNaira }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Deposit failed')
  return data
}

export async function initiateWithdrawal(
  amountNaira: number,
  bankCode: string,
  accountNumber: string
): Promise<RampResult> {
  const res = await fetch('/api/ramp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'off', amount: amountNaira, bankCode, accountNumber }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Withdrawal failed')
  return data
}

export async function getBanks(): Promise<Bank[]> {
  const res = await fetch('/api/ramp/banks')
  if (!res.ok) return []
  const data = await res.json()
  return data.banks || []
}
