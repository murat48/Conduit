# Skill files used during development

Submission requirement: teams cite the specific skill file(s) they used. All three are
vendored into this repository under `.claude/skills/` so the exact revision we worked
against can be inspected.

| Skill | Path in this repo | Source |
|---|---|---|
| Frontend & Wallets (official) | `.claude/skills/stellar-dapp/` | https://github.com/stellar/stellar-dev-skill/tree/main/skills/dapp |
| Anchors (community) | `.claude/skills/stellar-anchors/SKILL.md` | https://raw.githubusercontent.com/CheesecakeLabs/stellar-anchor-skill/main/SKILL.md |
| Soroswap SDK (community) | `.claude/skills/soroswap-sdk/SKILL.md` | https://raw.githubusercontent.com/soroswap/sdk/main/skills/soroswap-sdk/SKILL.md |

## `skills/dapp/` — Frontend & Wallets

The dapp skill keeps `SKILL.md` thin and splits the detail into `react.md`,
`data-fetching.md` and `smart-accounts.md`; all four are vendored so the cross-references
in `SKILL.md` resolve.

Used for the wallet layer. The skill's multi-wallet section pointed to Stellar Wallets Kit,
which replaced the Freighter-only integration the project started with.

What came out of it:
- `src/hooks/use-freighter.ts` — a single signing path through Stellar Wallets Kit
  (Freighter, xBull, Lobstr, Albedo, …). The kit is loaded dynamically because it is
  browser-only, and the network is pinned to testnet since the kit defaults to public.
- Wallet switch / disconnect controls on every page.

Deviation worth noting: the skill documents the kit's v1 API
(`new StellarWalletsKit({...})`). The published package is v2.6.0, which exposes a static
class (`StellarWalletsKit.init({ modules: defaultModules() })`), so the implementation
follows the package's own typings.

## Anchors skill — SEP-1 / 6 / 10 / 12 / 38

The direct reference for the fiat rail. Its pitfall list shaped the module more than the
happy path did.

What came out of it:
- `src/lib/anchor.ts` — SEP-1 discovery, SEP-10 authentication, SEP-38 quotes and
  indicative prices, SEP-6 deposit/withdraw, SEP-12 customer records, transaction polling
  with backoff, and the memo-carrying withdrawal payment.
- `src/types/anchor.ts` — response types, with every field verified against live responses
  from `tr-mock-anchor.fly.dev` rather than taken from the docs.

Pitfalls from the skill that turned into code:
- The SEP-10 challenge is verified **before** signing (server signature, sequence 0, source
  account, home domain, `web_auth_domain`); the wallet is never asked to sign an
  unverified challenge.
- Withdrawals require the exact `memo` / `memo_type` from the anchor response; the module
  refuses to continue when the anchor returns no memo.
- Deposits need a trustline, otherwise the anchor parks the payment in `pending_trust`;
  the UI opens the trustline before starting a deposit.
- Firm quotes expire and are treated as recoverable: the anchor falls back to the live rate
  and the UI never promises the quoted amount as final.
- JWT lifetimes vary. This anchor answers `403 {"type":"authentication_required"}` (not
  401), and `pollTransaction` re-authenticates once mid-flow when that happens.
- Amounts are decimal strings throughout; no floats are used for balances.

## Soroswap SDK skill — DEX integration

Used for endpoint shapes, request field names and the stroop-denominated amounts.

What came out of it:
- `src/lib/api.ts` — keeps the documented `getQuote → buildTransaction → sendTransaction`
  interface, but talks to the Soroswap router contract directly.

Deviation worth noting: the Routing API does not index testnet pools. `/pools?network=testnet`
returns an empty list and every pair we tried answered "No path found", while the pools are
live on chain (the factory holds 236 pairs). So quotes are read from
`router_get_amounts_out` and swaps go through `swap_exact_tokens_for_tokens`, keeping the
skill's interface and units. On mainnet the same code can switch back to the API.
