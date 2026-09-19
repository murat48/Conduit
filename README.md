# Conduit

<img src="public/logo.svg" alt="Conduit" width="120"/>

**A programmable TRY ⇄ Stellar rail.** Money enters from a Turkish bank account, follows a rule
the user signed once, and leaves back to the same bank account — without the user ever handing
over a private key.

- **Live:** [conduit-psi-three.vercel.app](https://conduit-psi-three.vercel.app)
- **Track:** Scale · **Network:** Stellar Testnet
- **Anchor:** `tr-mock-anchor.fly.dev` (SEP-1 / 6 / 10 / 12 / 38, TRY ⇄ USDC)
- **DEX:** Soroswap router contract, called directly on-chain
- **Skills used:** see [SKILLS.md](SKILLS.md)

---

## The problem

A freelancer in Istanbul invoices abroad and is paid in dollars. Converting, saving and cashing
out to lira are manual decisions at a screen, and each one is a chance to be late.

Crypto tooling does not fix this. A DEX can swap but cannot reach a bank account. An exchange
reaches a bank account but takes custody first. And the automation that does exist — trading bots
— asks for the one thing nobody should give away: the private key.

Conduit closes the loop, and runs the middle under a mandate the user can revoke at any moment.

## What it does

```
TRY  ──SEP-6 deposit──▶  USDC  ──Soroswap──▶  asset  ──price target──▶  USDC  ──SEP-6 withdraw──▶  TRY
    (bank transfer)              (buy rule)              (sell rule)                  (bank transfer)
```

Every leg runs end to end on testnet:

| Leg | What happens |
|---|---|
| **On-ramp** | SEP-10 login → SEP-12 customer record → SEP-38 firm quote → SEP-6 deposit ([anchor.ts](src/lib/anchor.ts)) |
| **Trigger** | A watcher follows incoming USDC by Horizon cursor, so payments that landed while the tab was closed are still processed |
| **Buy** | *Portfolio* splits the arriving USDC across assets. *Buy & sell* takes one position on a price condition ([automation.ts](src/lib/automation.ts)) |
| **Sell** | An exit rule sells a configured share once the target is reached — only what this rule bought, and once |
| **Off-ramp** | The proceeds continue into a SEP-6 withdrawal to the registered IBAN, in the same rule execution |

The rule can be written as a form, or in plain language: a tool-calling model turns
*"40% XLM, 30% AQUA, leave the rest in dollars"* into fields, and asks a question rather than
inventing a number the user never gave ([ai/strategy.ts](src/lib/ai/strategy.ts)).

## The mandate: automation without custody

The owner signs one Soroban contract ([contracts/mandate](contracts/mandate/src/lib.rs), deployed
at `CAAPS6MYLC2DQ4TPOCRDKBCG4HVSQ35P4PCGQ7LAIISHQSPCP4RJ7DPO`) recording which assets may be
traded, how much may leave per window, the price bounds and an expiry. Three properties carry the
design:

**The allowance goes to the contract, never to the automation wallet.** The owner approves *this
contract* as the token spender, so the automation wallet holds no spending power of its own. It
can ask; the contract refuses anything the mandate does not cover. Revoking is one call.

**The proceeds cannot be redirected** — the recipient is not a parameter:

```rust
// Forward the proceeds; the contract holds nothing between calls.
TokenClient::new(&env, &asset_out).transfer(&contract, &owner, &amount_out);
```

A compromised automation key therefore cannot steal. It can force unwanted swaps inside the
owner's own declared limits — value erosion, not theft.

**Price bounds are enforced on the executed trade**, not on a reading taken beforehand. A bound
becomes the minimum output the swap must return, and the router reverts atomically if the market
cannot deliver it. No oracle to go stale, and no gap between checking a price and acting on it.

17 contract tests cover the cap resetting with its window, both bounds, expiry, revocation, a
wrong delegate, legs that bypass the base asset, and owner isolation.

### How this got here

Three attempts at the same problem, in order:

| | | Why it was not enough |
|---|---|---|
| **v1** | Grid bot; the automation wallet holds the balance ([/price](src/app/price/page.tsx)) — **the version that won DoraHacks** | Nothing on chain caps what it may do |
| **v2** | Classic multisig, bot as co-signer ([MultisigSwapTrader.ts](src/lib/MultisigSwapTrader.ts)) | Thresholds are per operation *category*, not per amount or asset; and 2-of-2 needs a signature per trade, which defeats automation |
| **v3** | Mandate contract | Current design |

`/price` is kept rather than deleted: it is the awarded version, and it is what made the shape of
the mandate obvious. Its key was brought up to the non-extractable model; its spending limits are
still v1, and the page says so.

### Where the keys live

The automation key is generated `extractable: false` and stored in IndexedDB as a `CryptoKey`
([secure-key.ts](src/lib/secure-key.ts)) — the browser signs with it but cannot read it back, so
there is no seed in storage to lift. Not a complete defence: a script on this origin can still
*use* it while the page is open. What it removes is exfiltration.

Signing in needs no extension either. [passkey.ts](src/lib/passkey.ts) derives a Stellar account
from WebAuthn's PRF output, so the user keeps a passkey their platform already syncs and no seed
is stored anywhere. Not a smart account, and the reason is the anchor: SEP-10 authenticates a
*classic keypair* signing a challenge, a contract account needs SEP-45, and this anchor serves
only the former — a smart account could not deposit or withdraw, which is most of the product.
The derived key is held six hours rather than for the life of the tab.

## Stellar integration

| SEP | Use |
|---|---|
| **SEP-1** | `stellar.toml` discovery |
| **SEP-10** | Challenge–response login; the challenge is verified *before* signing |
| **SEP-12** | Customer record and TRY payout IBAN |
| **SEP-38** | Firm quotes, and the TRY reference rate shown across the app |
| **SEP-6** | Programmatic deposit and withdrawal, with polling and status handling |
| **SEP-40** | Reflector oracle read, shown beside the pool price so the testnet gap is visible |
| **SEP-41** | `approve` / `transfer_from` / `balance` for delegated execution |

Quotes are read from the chain, not an indexer: Soroswap's routing API does not index testnet
pools, so [api.ts](src/lib/api.ts) keeps the SDK's call shape but simulates
`router_get_amounts_out` and submits the swap directly. Reference prices come from `get_reserves`,
which is spot — asking does not move it.

Three pitfalls that turned into code: withdrawals need the anchor's exact memo, so the client
refuses to send an unattributable payment when none comes back; deposits need a trustline first or
the anchor parks the payment in `pending_trust`; and a swap needs a trustline for **both** of its
assets — SAC error `#13` does not say which side failed, which sent one debugging session down the
wrong path.

## Running it

**Prerequisites:** Node 18+, and a Stellar testnet wallet funded from
[friendbot](https://friendbot.stellar.org) — or no wallet at all, using a passkey.

```bash
git clone https://github.com/murat48/Conduit.git
cd conduit && npm install
touch .env.local             # see below
npm run dev                  # http://localhost:3000
```

```env
# Required
NEXT_PUBLIC_ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev

# Optional
TELEGRAM_BOT_TOKEN=          # server-side only — never prefix with NEXT_PUBLIC_
AI_PROVIDER=anthropic        # or 'gemini'
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

> Deploying publicly: `/api/ai/strategy` spends the key above with no authentication or rate
> limit, and `/api/telegram` proxies a single bot token. Both are fine for a single-operator demo
> and need attention before the link is shared widely.

### Walkthrough (≈10 minutes, all on testnet)

1. **Connect** — a wallet extension, or **Create passkey** for an account with no extension at
   all. A brand-new account offers to fund itself from Friendbot.
2. **Log in to the anchor** — one signature, no password.
3. **On-ramp** → request a TRY deposit. A sandbox button simulates the bank transfer; USDC arrives
   within seconds.
4. **Off-ramp** → save a TRY payout IBAN (SEP-12). Any valid-format IBAN works on testnet.
5. **Automation** → set a rule, choose **delegated** signing, approve the mandate once.
6. **Trigger it** — deposit again, or send USDC from anywhere. The watcher picks it up within 15
   seconds.
7. **History** shows every leg with its hash, verifiable on
   [stellar.expert](https://stellar.expert/explorer/testnet).

> Nobody else trades these pools, so a price target that is not already met will not be met on its
> own. To show the sell leg firing for real:
> ```
> node scripts/pool.cjs status                 # what every pool is priced at
> node scripts/pool.cjs push AQUA 0.0235384    # buy until the pool sits there
> ```
> It funds a throwaway Friendbot account, so it costs nothing and touches none of your keys.
>
> Thin testnet pools (EURC, XAU, ETH, SOL, BTC) will correctly refuse large amounts on price
> impact. Use XLM or AQUA for a smooth demo.

## Repository map

```
contracts/mandate/           # Soroban: the rule the owner signs, enforced on chain
scripts/pool.cjs             # testnet pools: read prices, or move one to a rule's target
src/
├── app/page.tsx             # the product: on-ramp · off-ramp · automation · AI · history
├── app/price/               # v1 grid bot (the awarded version)
├── app/api/                 # server-only proxies: ai, telegram
└── lib/
    ├── anchor.ts            # SEP-1/6/10/12/38 client
    ├── automation.ts        # rule engine: trigger → buy → exit → off-ramp
    ├── mandate.ts           # mandate client: set · execute · revoke · history
    ├── passkey.ts           # sign in with no extension: WebAuthn PRF → Ed25519
    ├── secure-key.ts        # non-extractable automation key in IndexedDB
    ├── api.ts               # Soroswap router, called on-chain
    └── ai/strategy.ts       # plain language → rule fields
```

## Status and limitations

**Working today:** the whole loop, on testnet, against a live anchor — including the mandate
contract, deployed and enforcing assets, cap, price bounds and expiry on chain rather than being a
plan.

- The anchor is a TRY **mock** anchor. Production needs a licensed Turkish anchor; the client is
  SEP-compliant and switches by changing one domain.
- The rule lives in `localStorage`, so it runs **while a tab is open**. The payment trigger catches
  up on deposits that arrived while it was closed; a price-triggered exit does not.
- Testnet pool prices sit far from the real market — measured at the time of writing, XLM about
  41% below the Reflector rate. Rules fire on the pool's price, because that is the market the
  swap is filled in. The oracle rate is shown alongside so the gap is visible rather than
  misleading.
- **Buy & sell does not run under the mandate.** Its sell leg pulls the asset rather than USDC,
  which needs a second allowance, a re-signature whenever the target moves, and it opens a band
  between spot and the fill where the rule fires and the contract refuses. The guarantee is kept
  where it holds cleanly — portfolio mode — and buy & sell runs on the automation wallet's own
  budget instead.
- Buy & sell holds **one** position. Several price-conditional positions is a contract change, not
  a UI one: a mandate carries a single `buy_below` for every asset it covers, and one shared bound
  is meaningless across assets priced decades apart.
- `/price` still runs the v1 model: its wallet holds the balance it trades with, uncapped.

**Roadmap**

1. **Server-side watcher or permissionless keepers** — the mandate already makes this safe, since
   the contract decides what is allowed rather than the caller. Rules would keep running with the
   browser closed: the one structural limitation left.
2. **Per-asset price bounds in the mandate** — `assets` becomes a list of
   `{ asset, buy_below, sell_above }`, which is what buy & sell needs to run under it and to hold
   more than one position.
3. **Bring the mandate's limits to `/price`**, so the repository stops carrying two security
   models.
4. **Production anchor** and a TRY-denominated savings rule set.

## Demo

**[conduit-psi-three.vercel.app](https://conduit-psi-three.vercel.app)** — nothing costs anything:
fund from Friendbot, and the bank leg is simulated. A passkey is bound to the domain it was made
on, so one made here derives a different account from one made against a local dev server; the app
offers to fund the new one.

Video walkthrough: _<!-- fill in: re-record against the current flow -->_

---

Testnet software, built for a hackathon. Automated trading carries risk; nothing here is financial
advice. MIT — see [LICENSE](LICENSE).
