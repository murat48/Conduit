# Conduit — Speaker notes

English pitch. Approximately 3–4 minutes, depending on pace.

## 01 — Conduit

Conduit is a programmable rail between Turkish lira and Stellar. The idea is simple: money arrives, follows a rule you chose, and stays under your control. Our strongest implementation is delegated portfolio allocation. You authorize its limits at setup; the contract checks every subsequent swap. Today, this is a testnet prototype with simulated bank transfers.

**Sources / preparation notes:** README.md: introduction, Status and limitations. Scale track is recorded in the README. The cover describes the product direction; the mandate guarantee applies to delegated portfolio mode.

## 02 — The solution

A user can say: allocate forty percent to XLM, thirty percent to AQUA, and leave the rest in USDC. They approve the token allowance and set a mandate during setup. The delegate then requests swaps, but the contract enforces the allowed assets, spending cap, price bounds and expiry. Proceeds return to the owner. The delegate cannot choose another recipient. This limits its authority, although unwanted trades within those limits can still cost fees and slippage. The owner can revoke the mandate.

**Sources / preparation notes:** contracts/mandate/src/lib.rs: set_mandate, execute, revoke; src/app/page.tsx: mandateApplies; src/lib/automation.ts: portfolio execution. The allowance and mandate are separate setup transactions, so do not claim a single signature for the whole onboarding flow.

## 03 — PMF

Start with a freelancer managing income across Turkish lira and USDC. They want the same allocation each time money arrives, without repeating the same wallet actions. For illustration, one hundred USDC could be split forty percent into XLM, thirty percent into AQUA, and thirty percent left in USDC. This is an example rule, not a recommended investment. Our hypothesis is that bounded automation makes recurring allocation useful enough to repeat. The next validation step is user interviews and a small pilot measuring setup completion and repeat use. We are not claiming proven product-market fit.

**Sources / preparation notes:** README.md: The problem and What it does; src/lib/ai/strategy.ts. Audience and pilot metrics are proposed positioning and validation steps, not measured adoption. No market-size, customer, revenue or savings figures are asserted.

## 04 — Technical workflow

The anchor handles authentication, customer details, a quote, and the simulated TRY deposit. USDC arrives in the owner’s wallet. A browser watcher detects the payment and requests portfolio swaps through our Soroban mandate contract. Each allocation executes as one atomic pull, swap and return: if it fails, that transaction reverts. Stellar supplies the anchor standards and programmable settlement that connect these steps. The current watcher needs an open tab. Buy-and-sell mode uses a separately funded automation wallet; it does not have the same mandate protection. Next are background execution, per-asset bounds and a production anchor integration.

**Sources / preparation notes:** README.md: Stellar integration, Status and limitations, Roadmap; contracts/mandate/src/lib.rs: execute; src/app/page.tsx: mandateApplies; src/lib/automation.ts: POLL_INTERVAL_MS. Multiple allocations are separate transactions. The contract also enforces configured price bounds. Production anchor support has not been validated.

## 05 — The team

I am Murat Keskin, the project author. Conduit brings together the product interface, Stellar anchor integration and a custom Soroban mandate contract. The repository includes seventeen contract test cases covering behaviors such as spending limits, expiry, revocation and owner isolation. The next milestone is validating recurring use with users and integrating a production anchor. You can explore the testnet demo and source from the links on this slide. Conduit: your money, your rules.

**Sources / preparation notes:** Name is sourced from package.json author metadata; development role is inferred from project ownership and should be confirmed before presenting. No biography, employer, awards or adoption claims are added. Initials substitute for a team photo because none was provided. 17 #[test] cases are present in contracts/mandate/src/test.rs; tests were not rerun for this presentation. Demo URL is recorded in README.md, not availability-verified.
