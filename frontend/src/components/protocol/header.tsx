"use client"
import { Wallet, ExternalLink, FileText } from "lucide-react"
import Link from "next/link"
import Logo from "@/components/logo"
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
    <header className="border-b border-gray-800 px-4 sm:px-6 py-3 sm:py-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-2">
        {/* Brand */}
        <Link href="/protocol" className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Logo size={32} className="shrink-0" />
          <div className="truncate">
            <span className="font-bold text-white text-base sm:text-lg">PawaSave</span>
            <span className="text-gray-500 text-base sm:text-lg"> Protocol</span>
          </div>
          <span className="hidden sm:inline-block ml-1 text-xs bg-brand-900 text-brand-400 border border-brand-800 px-2 py-0.5 rounded-full font-medium whitespace-nowrap">
            Base Mainnet
          </span>
        </Link>

        {/* Actions */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <Link
            href="/whitepaper"
            className="hidden sm:inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition"
          >
            <FileText className="w-4 h-4" />
            Whitepaper
          </Link>

          <a
            href="https://basescan.org"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex text-gray-500 hover:text-gray-300 transition"
            aria-label="Base block explorer"
          >
            <ExternalLink className="w-4 h-4" />
          </a>

          {!address ? (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="proto-btn flex items-center gap-2 text-sm px-3 sm:px-5 py-2"
            >
              <Wallet className="w-4 h-4" />
              <span className="hidden xs:inline">{connecting ? "Connecting…" : "Connect Wallet"}</span>
              <span className="xs:hidden">{connecting ? "…" : "Connect"}</span>
            </button>
          ) : wrongChain ? (
            <button onClick={onSwitch} className="bg-orange-600 hover:bg-orange-700 text-white font-semibold px-3 sm:px-4 py-2 rounded-xl text-sm transition whitespace-nowrap">
              Switch to Base
            </button>
          ) : (
            <button
              onClick={onDisconnect}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 sm:px-4 py-2 rounded-xl text-sm font-medium transition whitespace-nowrap"
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
