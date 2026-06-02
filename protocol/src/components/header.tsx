"use client"
import { Wallet, ExternalLink } from "lucide-react"
import { shortAddr } from "@/lib/format"

interface Props {
  address: string | null
  wrongChain: boolean
  connecting: boolean
  onConnect: () => void
  onSwitch: () => void
  onDisconnect: () => void
}

export function Header({ address, wrongChain, connecting, onConnect, onSwitch, onDisconnect }: Props) {
  return (
    <header className="border-b border-gray-800 px-6 py-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">P</div>
          <div>
            <span className="font-bold text-white text-lg">PawaSave</span>
            <span className="text-gray-500 text-lg"> Protocol</span>
          </div>
          <span className="ml-2 text-xs bg-brand-900 text-brand-400 border border-brand-800 px-2 py-0.5 rounded-full font-medium">Base Mainnet</span>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="https://basescan.org"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gray-300 transition"
          >
            <ExternalLink className="w-4 h-4" />
          </a>

          {!address ? (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Wallet className="w-4 h-4" />
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          ) : wrongChain ? (
            <button onClick={onSwitch} className="bg-orange-600 hover:bg-orange-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition">
              Switch to Base
            </button>
          ) : (
            <button
              onClick={onDisconnect}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-4 py-2 rounded-xl text-sm font-medium transition"
            >
              <div className="w-2 h-2 bg-brand-500 rounded-full" />
              {shortAddr(address)}
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
