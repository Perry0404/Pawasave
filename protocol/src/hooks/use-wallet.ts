"use client"
import { useState, useEffect, useCallback } from "react"
import { ethers } from "ethers"
import { CHAIN_ID } from "@/lib/contracts"

export interface WalletState {
  address: string | null
  provider: ethers.BrowserProvider | null
  signer: ethers.JsonRpcSigner | null
  chainId: number | null
  connecting: boolean
  wrongChain: boolean
}

const BASE_CHAIN = {
  chainId:         `0x${CHAIN_ID.toString(16)}`,
  chainName:       "Base",
  nativeCurrency:  { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls:         ["https://mainnet.base.org"],
  blockExplorerUrls: ["https://basescan.org"],
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null, provider: null, signer: null,
    chainId: null, connecting: false, wrongChain: false,
  })

  const update = useCallback(async (eth: any) => {
    const provider = new ethers.BrowserProvider(eth)
    const network  = await provider.getNetwork()
    const chainId  = Number(network.chainId)
    const signer   = await provider.getSigner()
    const address  = await signer.getAddress()
    setState({ address, provider, signer, chainId, connecting: false, wrongChain: chainId !== CHAIN_ID })
  }, [])

  const connect = useCallback(async () => {
    const eth = (window as any).ethereum
    if (!eth) { alert("Please install MetaMask"); return }
    setState(s => ({ ...s, connecting: true }))
    try {
      await eth.request({ method: "eth_requestAccounts" })
      await update(eth)
    } catch {
      setState(s => ({ ...s, connecting: false }))
    }
  }, [update])

  const switchChain = useCallback(async () => {
    const eth = (window as any).ethereum
    if (!eth) return
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN.chainId }] })
    } catch (e: any) {
      if (e.code === 4902) {
        await eth.request({ method: "wallet_addEthereumChain", params: [BASE_CHAIN] })
      }
    }
  }, [])

  const disconnect = useCallback(() => {
    setState({ address: null, provider: null, signer: null, chainId: null, connecting: false, wrongChain: false })
  }, [])

  // Auto-reconnect if previously connected
  useEffect(() => {
    const eth = (window as any).ethereum
    if (!eth) return
    eth.request({ method: "eth_accounts" }).then((accounts: string[]) => {
      if (accounts.length > 0) update(eth)
    })
    eth.on("accountsChanged", (accounts: string[]) => {
      if (accounts.length === 0) disconnect()
      else update(eth)
    })
    eth.on("chainChanged", () => update(eth))
    return () => {
      eth.removeAllListeners?.("accountsChanged")
      eth.removeAllListeners?.("chainChanged")
    }
  }, [update, disconnect])

  return { ...state, connect, disconnect, switchChain }
}
