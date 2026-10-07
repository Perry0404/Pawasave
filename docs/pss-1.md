# PSS-1 — Pawa Securities Standard, v1

**Status:** design stage (not built, not licensed). Last updated 2026-09-30.
**One line:** PawaSave's standard for bringing *licensed* Nigerian securities onto Base so
they can be held, earn cNGN dividends, and be borrowed against.

---

## 1. Why now — the facts that changed

- **ISA 2025** (signed March 2025) defines digital assets, including tokens representing
  debt or equity, as **securities** under SEC Nigeria. Issuers, platforms, custodians and
  advisers dealing in them must be **SEC-licensed** (fit-and-proper, capital adequacy).
- **Aug 2026:** SEC approved tokenized shares and bonds on the **NASD OTC exchange**, with
  Canadian vendor **Blockstation** running issuance, trading, clearing and settlement on
  its ledger. First public digital-securities offering scheduled for September 2026.
- SEC's **Accelerated Regulatory Incubation Program (ARIP)** is the sandbox for new
  digital-asset models. NGX is exploring tokenized RWAs with the SEC; open questions remain
  on approved DLT, custody, settlement finality and **CSCS interoperability**.
- **Precedent on Base already live through PawaSave:** GetEquity's DPRI (Dangote IPO) and
  gNTB (T-bill fund, 15.5% p.a.) trade on Base via one Market contract, cNGN-settled.

**Implication:** tokenized Nigerian securities are now legal and regulator-endorsed. But
PawaSave cannot lawfully *issue* tokenized NGX shares on its own. PSS-1 must be built
**with licensed partners**, not around them.

## 2. Positioning — standard + distribution + collateral, not issuer

| Role | Who | Why |
|---|---|---|
| Issuer / sponsor | Licensed broker-dealer, or a licensed tokenizer (GetEquity, NASD) | ISA 2025 licensing |
| Custodian of the real shares | Licensed custodian holding shares in a **CSCS nominee** account | 1:1 backing |
| Standard, identity, distribution, collateral | **PawaSave** | Users, BVN identity, cNGN, lending |

NASD/Blockstation proves Nigeria will tokenize securities, but on a domestic ledger that
isn't composable with global stablecoin liquidity or DeFi. **PSS-1 makes those securities
useful on Base: holdable in a wallet, paying dividends in cNGN, and accepted as collateral.**

## 3. Technical design

### 3.1 Token: ERC-3643 (T-REX)
The regulated-token standard. It gives what SEC will expect:
- **Identity Registry** linking a wallet to a verified identity and country code.
- **Compliance modules** enforcing eligibility and transfer rules inside `transfer()`.
- **Agent powers**: freeze, forced transfer, and recovery (court orders, lost keys, deceased
  holders). These are centralising, and must be disclosed and governed by the custody
  multisig (the Gnosis Safe).

### 3.2 Identity: BVN-bound claims
- PawaSave's existing Strails BVN onboarding becomes an **ONCHAINID claim** ("KYC'd Nigerian
  resident, BVN-verified"), signed by a trusted claim issuer (PawaSave, or the licensed
  partner's KYC provider). No PII onchain, only the claim.
- One verification unlocks every PSS-1 asset: a portable, reusable onchain identity.

### 3.3 Backing: provable 1:1
- Custodian holds the real shares in a CSCS nominee account.
- **Mint only against custodian confirmation; burn on redemption.** Daily reconciliation.
- **Proof of reserve:** custodian publishes a signed attestation (EAS on Base) of nominee
  holdings per ticker; the token's `totalSupply()` must never exceed it. A mismatch pauses
  minting.

### 3.4 Corporate actions
- **Dividends:** snapshot holders at the record date, custodian funds the cNGN, holders
  claim through a Merkle claim contract (or auto-credit for PawaSave-custodied wallets).
- **Bonus / rights issues:** snapshot + mint to holders; rights as a separate time-limited
  token.
- **AGM voting:** off-chain via the custodian's proxy, weighted by snapshot (v2: onchain).

### 3.5 The real novelty: collateral-aware compliance
ERC-3643 and tokenized stocks are not new. What few have done well:
- A compliance module that **whitelists the PawasaveLend / Morpho vault** as an eligible
  holder, so a verified user can **post tokenized NGX shares as collateral and borrow
  cNGN** without the transfer being blocked, and liquidations can only sell to eligible
  holders.
- **cNGN-native corporate actions** (dividends straight to wallets in naira stablecoin).
- **BVN-bound portable identity** for Nigerian investors.

This extends PawaSave's asset-backed lending moat: every
tokenized Nigerian security becomes collateral.

## 4. Legal and regulatory path

- **Licences:** issuing, custodying or operating a trading platform for PSS-1 tokens needs SEC
  licensing under ISA 2025. PawaSave should enter as a **technology/distribution partner**
  to licensed entities, then decide whether to seek its own licence.
- **Sandbox:** apply to **ARIP** jointly with a licensed broker and custodian for a
  limited pilot (Nigerian residents only, capped size).
- **Foreign investors:** letting global holders buy with USDC touches **CBN FX rules**
  (foreign portfolio investment, Certificate of Capital Importation). Out of scope for v1.
  Nigerian residents with cNGN only.
- **Needs counsel before any pilot:** legal characterisation of the token (receipt,
  depositary interest or security), holder rights vs the nominee, insolvency remoteness
  of the custody account, and the ARIP application.

## 5. Phased plan with gates

| Phase | What | Gate to next |
|---|---|---|
| 0 — Now | This spec; ERC-3643 testnet demo with a mock NGX share; treat GetEquity tokens (gNTB, DPRI) as the first PSS-1-compatible assets; **borrow cNGN against gNTB/DPRI** | Demo works end to end; counsel memo |
| 1 — Sandbox | ARIP application with licensed broker + custodian; pilot **one NGX stock**, residents only, capped | SEC no-objection; clean reconciliation for 90 days |
| 2 — Distribution | Partner with NASD/Blockstation or NGX as the Base distribution and collateral bridge; add bonds | Volume and zero reserve breaks |
| 3 — Open standard | Other Nigerian issuers adopt PSS-1; foreign access once CBN/SEC path is clear | — |

## 6. Risks

- **Regulatory:** operating outside a licence is the biggest risk. Never mint real-security
  tokens before SEC sign-off.
- **Custody/counterparty:** tokens are only as good as the custodian and the nominee
  account's insolvency remoteness.
- **Smart-contract:** audit the compliance modules and agent roles; agent keys under the
  Gnosis Safe.
- **Liquidity:** Nigerian single-stock liquidity is thin; collateral haircuts must be
  conservative, reusing the fair-value floor lesson from the tokenized-stock sell path.
- **Competition:** NASD/Blockstation has the licence head start. PSS-1 wins by
  **complementing** them (Base composability + lending), not racing them.

## Sources
- ISA 2025 overview: https://techcabal.com/2025/05/09/investments-and-securities-act-nigeria-2025/
- ISA 2025 digital assets: https://ng.andersen.com/the-investment-and-securities-act-2025-a-new-era-for-digital-assets-and-financial-disclosure/
- SEC approves tokenized equities on NASD: https://www.bloomberg.com/news/articles/2026-08-04/nigeria-approves-tokenized-assets-to-boost-capital-market-growth
- NASD / Blockstation details: https://www.ecofinagency.com/news-finances/0508-57987-nigeria-clears-tokenized-shares-and-bonds-for-trading-on-nasd
- NGX on-chain, CSCS interoperability, ARIP: https://technext24.com/interview/chinonso-obiefule-ngx-on-chain/
- ERC-3643 spec: https://eips.ethereum.org/EIPS/eip-3643
- ERC-3643 vs ERC-1400 comparison: https://protofire.io/guides/rwa-token-standards/
- GetEquity Base mainnet addresses: https://getequity.io/docs/onchain/ethereum-addresses.md
