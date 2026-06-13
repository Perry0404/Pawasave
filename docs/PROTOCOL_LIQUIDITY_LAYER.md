# PawaSave — Protocol-to-Protocol Liquidity Layer (Strategic Vision)

## Summary
Beyond direct retail borrowing, PawaSave will evolve into a **backend liquidity and
yield infrastructure layer** for the broader Nigerian fintech ecosystem. Instead of
relying solely on individual retail or SME borrowers, we open a **B2B liquidity
protocol** that lets other fintech applications integrate directly with PawasaveLend.

## How it works
Partner platforms (savings apps, payment companies, neobanks, Esusu/Ajo platforms,
etc.) connect to PawaSave via clean **APIs and SDKs**. When their users need:

- **Yield generation** on cNGN holdings
- **Local-currency swaps / routing**
- **Access to cNGN liquidity** for their customers

…the partner app routes the request through PawaSave's backend. **PawasaveLend handles
the entire DeFi plumbing** — collateral management, interest-rate application, borrowing
mechanics, and settlement — transparently behind the scenes.

## The closed-loop system
- **Consumer app (PawaSave)** provides steady **retail supply** via P-AUTO.
- **Partner applications** generate consistent, programmatic **borrowing demand**.
- Liquidity flows efficiently between retail suppliers and partner-driven use cases.
- PawaSave earns via **routing fees, reserve factor, and usage-based charges**.

## Why this matters (and how it ties to our yield model)
This is the answer to the hardest question in the protocol: **where does borrow demand
come from?** Today the pool earns ≈0% supply yield because there are no borrowers. The
B2B layer turns partner fintechs into a reliable, programmatic borrower base — which is
exactly what funds a sustainable supplier APY (instead of paying yield from treasury).
It converts "27% is a target" into "27% is sourced from real borrowing demand."

## Strategic benefits
- Transforms PawaSave from a standalone lending protocol into **foundational
  infrastructure** for the Nigerian stablecoin economy.
- Solves **borrower acquisition** by leveraging partners' distribution networks.
- Lets other fintechs offer cNGN yield/borrowing **without building their own DeFi stack**.
- Strong **network effects**: more integrations → deeper, more stable liquidity.

## Architecture implications (what we build toward)
A dual-sided platform that powers the ecosystem while we retain control of the core
lending engine:

1. **Partner API + SDK** — authenticated, rate-limited, per-partner API keys; idempotent
   request/settlement; webhooks for state changes.
2. **Per-partner accounting** — credit lines, exposure caps, and usage metering per
   integrating app.
3. **Settlement & routing** — programmatic supply/borrow/repay and cNGN routing on Base.
4. **Risk controls** — per-partner and per-user borrow caps, circuit breakers, and a
   robust oracle (these stop being "nice to have" once external apps borrow at scale).

## Security prerequisites (load-bearing for B2B — from the audit)
Opening the protocol to other apps raises the stakes on several audit items. These become
**must-fix before any partner integration**, not just before retail scale:

- **FIND-SC-17** per-user (and per-partner) borrow caps — prevent one integrator draining
  the pool.
- **FIND-SC-20 / SC-22 / SC-13** robust oracle (deviation circuit breaker, staleness
  enforced everywhere) — external borrowers magnify oracle-manipulation incentive.
- **FIND-SC-11 / SC-14 / SC-15** exact pool accounting + compound interest — partners
  reconcile against our numbers; drift is unacceptable.
- **FIND-SC-25** updatable interest-rate model — tune rates as partner demand grows.
- **FIND-INFRA-04** runtime feature flags / kill-switch — disable a misbehaving partner
  instantly without redeploy.
- **FIND-API-05** persistent, per-partner rate limiting (Redis/Upstash).
- **FIND-3P-05 / 3P-06 / SC-21** institutional key management (multisig/HSM) — partners
  require it for due diligence.

> Bottom line: the audit remediation isn't just hygiene — it's the prerequisite checklist
> for becoming credible B2B infrastructure. We fix it now while TVL≈0, then open the
> partner layer on a hardened base.
