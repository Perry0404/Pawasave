import { AbiCoder, keccak256, concat } from "ethers"

/**
 * Dividend record-date list for PawaMerkleDividend: one leaf per holder,
 *   leaf = keccak256(keccak256(abi.encode(account, amount)))
 * hashed pairwise in sorted order, matching OpenZeppelin's MerkleProof. Anyone can rebuild the list
 * from token balances at the record block and check it gives the published root.
 */
export type Entitlement = { account: string; amount: bigint }

export function leafHash(e: Entitlement): string {
  return keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [e.account, e.amount])))
}

const pair = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])))

export function buildTree(entitlements: Entitlement[]) {
  if (entitlements.length === 0) throw new Error("no holders")
  const leaves = entitlements.map(leafHash)
  const layers: string[][] = [leaves]
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1]
    const next: string[] = []
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i])
    layers.push(next)
  }
  const root = layers[layers.length - 1][0]
  const proof = (index: number) => {
    const out: string[] = []
    for (let l = 0; l < layers.length - 1; l++) {
      const sibling = index ^ 1
      if (sibling < layers[l].length) out.push(layers[l][sibling])
      index = Math.floor(index / 2)
    }
    return out
  }
  return { root, proof, leaves }
}

/**
 * Pro-rata split of `total` over holdings at the record block, rounded down so the sum never
 * exceeds what was received. Tokens in the redemption vault are attributed to the holders who
 * locked them, by the caller.
 */
export function proRata(total: bigint, holdings: { account: string; units: bigint }[]): Entitlement[] {
  const supply = holdings.reduce((s, h) => s + h.units, 0n)
  if (supply === 0n) throw new Error("no supply")
  return holdings.filter((h) => h.units > 0n).map((h) => ({ account: h.account, amount: (total * h.units) / supply }))
}
