import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { invoke } from './allowance';
import { MANDATE_CONFIG, SOROSWAP_ROUTER_CONFIG } from './constants';
import { SignTransactionFn } from '@/types/anchor';

// Client for the mandate contract (contracts/mandate/src/lib.rs).
//
// The difference from the plain allowance path in ./allowance.ts is where the rule lives. There,
// the owner approves the automation wallet directly, so the cap is the only thing the chain knows
// about — which asset, at which price, how often are all decided by this browser. Here the owner
// approves the *contract*, and the contract holds the rule: allowed assets, a spending cap per
// window, price bounds and an expiry. The automation wallet can only ask; it cannot exceed.
//
// One call does what delegated mode used to do in three transactions (pull, swap, hand back), and
// atomically: either the whole thing settles or nothing moved, so funds can never be stranded in
// the automation wallet mid-flow.

export interface MandateTerms {
  delegate: string;
  assets: string[]; // contract addresses; the base asset (USDC) is implicit
  capPerWindow: bigint; // base-asset stroops per window
  windowLedgers: number;
  buyBelow: bigint; // base stroops per unit; 0 = no bound
  sellAbove: bigint; // base stroops per unit; 0 = no bound
  expirationLedger: number;
}

// An `execute` call runs through three contracts, and each reports failure the same way, as
// `Error(Contract, #N)`. The mandate's own codes start at 100 precisely so they cannot be
// confused with the token's (single digits) or the router's (5xx) — which means a refusal can
// be attributed to whoever actually refused.
const MANDATE_ERRORS: Record<number, string> = {
  // The mandate contract.
  100: 'no mandate is registered for this wallet',
  101: 'the mandate has expired; set a new one',
  102: 'this asset is not covered by the mandate',
  103: 'this would exceed the mandate spending limit for the current window',
  104: 'invalid amount',
  105: 'the mandate terms are invalid',
  106: 'the input and output asset are the same',
  107: 'the mandate only covers trades against USDC',
  108: 'arithmetic overflow',
  // The token contract, reached through the mandate's transfer_from and its payout transfer.
  9: 'the allowance you granted the mandate contract does not cover this amount, or it expired',
  // Raised on the final hop to the owner. The contract itself never needs a trustline — a
  // contract address holds its SAC balance in contract storage — but the owner is a classic
  // account and does. Verified on testnet: the call reverts whole, so nothing is left behind.
  13: 'your wallet has no trustline for the asset being bought; open it once and the rule runs',
  // The router: the swap could not return the minimum the mandate's price bound demands.
  507: 'the market price is outside the bounds set in your mandate',
};

const server = (): rpc.Server => new rpc.Server(SOROSWAP_ROUTER_CONFIG.RPC_URL);
const readOnlySource = (): Account => new Account(Keypair.random().publicKey(), '0');

// Turns `Error(Contract, #4)` into something a user can act on, and leaves anything else alone.
function describe(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/Error\(Contract, #(\d+)\)/);
  const known = code ? MANDATE_ERRORS[Number(code[1])] : undefined;
  return known ? new Error(known) : (error instanceof Error ? error : new Error(message));
}

const entry = (key: string, val: xdr.ScVal): xdr.ScMapEntry =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

// A Rust `#[contracttype]` struct serialises as an ScMap whose symbol keys are sorted, and
// stellar-sdk has no schema-aware encoder for it — so it is built by hand, the same way
// reflector.ts builds the oracle's asset enum. The order below is the sorted order; changing it
// produces a map the contract will not accept.
const termsToScVal = (terms: MandateTerms): xdr.ScVal =>
  xdr.ScVal.scvMap([
    entry('assets', xdr.ScVal.scvVec(terms.assets.map(asset => new Address(asset).toScVal()))),
    entry('buy_below', nativeToScVal(terms.buyBelow, { type: 'i128' })),
    entry('cap_per_window', nativeToScVal(terms.capPerWindow, { type: 'i128' })),
    entry('delegate', new Address(terms.delegate).toScVal()),
    entry('expiration_ledger', nativeToScVal(terms.expirationLedger, { type: 'u32' })),
    entry('sell_above', nativeToScVal(terms.sellAbove, { type: 'i128' })),
    entry('window_ledgers', nativeToScVal(terms.windowLedgers, { type: 'u32' })),
  ]);

interface RawTerms {
  delegate: string;
  assets: string[];
  cap_per_window: bigint;
  window_ledgers: number;
  buy_below: bigint;
  sell_above: bigint;
  expiration_ledger: number;
}

const termsFromNative = (raw: RawTerms): MandateTerms => ({
  delegate: raw.delegate,
  assets: raw.assets,
  capPerWindow: BigInt(raw.cap_per_window),
  windowLedgers: raw.window_ledgers,
  buyBelow: BigInt(raw.buy_below),
  sellAbove: BigInt(raw.sell_above),
  expirationLedger: raw.expiration_ledger,
});

// Read-only contract call. Simulation is enough — nothing is submitted, so no signature is needed.
async function read(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const transaction = new TransactionBuilder(readOnlySource(), {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(MANDATE_CONFIG.CONTRACT).call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server().simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw describe(new Error(simulation.error.split('\n')[0]));
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new Error('the mandate contract state is archived and must be restored first');
  }
  if (!simulation.result) {
    throw new Error(`mandate ${method} returned no result`);
  }
  return scValToNative(simulation.result.retval);
}

/** The mandate currently registered for this wallet, or null if there is none. */
export async function getMandate(owner: string): Promise<MandateTerms | null> {
  const raw = (await read('get_mandate', new Address(owner).toScVal())) as RawTerms | null;
  return raw ? termsFromNative(raw) : null;
}

/** Base already spent inside the owner's current window, in stroops. */
export async function getSpent(owner: string): Promise<bigint> {
  return BigInt((await read('spent', new Address(owner).toScVal())) as string | number | bigint);
}

/**
 * The ledger the network is on now — what a mandate's `expirationLedger` is measured against.
 *
 * Read so an expired mandate can be named before anything is signed. The contract only raises
 * #101 from inside `execute`, which is after the wallet prompt and after the user thinks the
 * trade is under way.
 */
export async function getLedgerSequence(): Promise<number> {
  const { sequence } = await server().getLatestLedger();
  return sequence;
}

/**
 * Register the rule. This is the one signature the owner gives: after it, the automation wallet
 * works inside these limits and needs nothing further from them.
 */
export async function setMandate(
  owner: string,
  terms: MandateTerms,
  signTransaction: SignTransactionFn
): Promise<string> {
  try {
    const { hash } = await invoke({
      source: owner,
      contract: MANDATE_CONFIG.CONTRACT,
      method: 'set_mandate',
      args: [new Address(owner).toScVal(), termsToScVal(terms)],
      signTransaction,
    });
    console.log(`✅ Mandate set for ${terms.delegate.slice(0, 6)}… until ledger ${terms.expirationLedger}`);
    return hash;
  } catch (error) {
    throw describe(error);
  }
}

/**
 * Cancel the rule. Nothing else is required to stop the automation wallet: it never held an
 * allowance of its own, so removing the mandate removes the only route it had.
 */
export async function revokeMandate(
  owner: string,
  signTransaction: SignTransactionFn
): Promise<string> {
  try {
    const { hash } = await invoke({
      source: owner,
      contract: MANDATE_CONFIG.CONTRACT,
      method: 'revoke',
      args: [new Address(owner).toScVal()],
      signTransaction,
    });
    return hash;
  } catch (error) {
    throw describe(error);
  }
}

// ── History, read from the chain ─────────────────────────────────────────────────────────
//
// Every state change emits an event whose topics are ["mandate", <kind>, <owner>], so RPC can
// return one wallet's history and nobody else's. This is the authoritative record of what the
// automation actually did: it survives a cleared browser and a judge can verify each entry
// against stellar.expert. What it cannot show is why the rule *declined* to act — a skipped
// row never reaches the chain — so the local journal in automation.ts still has a job.

export type MandateEventKind = 'executed' | 'set' | 'revoked';

export interface MandateEvent {
  kind: MandateEventKind;
  id: string; // RPC cursor id; unique and stable, so it doubles as a React key
  ledger: number;
  at: string; // ISO 8601
  txHash: string;
  owner: string;
  delegate?: string;
  assetIn?: string;
  assetOut?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  capPerWindow?: bigint;
  expirationLedger?: number;
}

export interface MandateHistory {
  events: MandateEvent[]; // newest first
  /** The earliest ledger this RPC still holds. Anything older is gone, not missing. */
  oldestLedger: number;
  /** True when the window starts after the mandate did, so the list may be incomplete. */
  truncated: boolean;
}

const EVENT_KINDS: MandateEventKind[] = ['executed', 'set', 'revoked'];

/** How far one getEvents call actually scans forward. Measured against testnet RPC, kept under it. */
const SCAN_CHUNK_LEDGERS = 8_000;
/** ~1.5 days at 5s ledgers — enough for a demo session without a dozen round trips. */
const DEFAULT_LOOKBACK_LEDGERS = 24_000;

const decode = (base64: string): unknown => scValToNative(xdr.ScVal.fromXDR(base64, 'base64'));

interface RawEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: string[];
  value: string;
  inSuccessfulContractCall: boolean;
}

function toMandateEvent(raw: RawEvent): MandateEvent | null {
  const kind = decode(raw.topic[1]) as MandateEventKind;
  if (!EVENT_KINDS.includes(kind)) return null;

  const data = decode(raw.value) as Record<string, unknown>;
  const address = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  const amount = (value: unknown): bigint | undefined =>
    value === undefined || value === null ? undefined : BigInt(value as string | number | bigint);

  return {
    kind,
    id: raw.id,
    ledger: raw.ledger,
    at: raw.ledgerClosedAt,
    txHash: raw.txHash,
    // The owner is the third topic; the contract puts it there so this query can filter on it.
    owner: decode(raw.topic[2]) as string,
    delegate: address(data.delegate),
    assetIn: address(data.asset_in),
    assetOut: address(data.asset_out),
    amountIn: amount(data.amount_in),
    amountOut: amount(data.amount_out),
    capPerWindow: amount(data.cap_per_window),
    expirationLedger: data.expiration_ledger as number | undefined,
  };
}

/**
 * One wallet's mandate history, straight from the chain.
 *
 * `ledgers` bounds how far back to look. Soroban RPC keeps roughly seven days of events on
 * testnet and answers with the window it actually holds, which is reported back as
 * `oldestLedger` so the UI can say "this is everything the network still has" rather than
 * implying the wallet has no older activity.
 */
export async function fetchMandateHistory(
  owner: string,
  options: { ledgers?: number; limit?: number } = {}
): Promise<MandateHistory> {
  const { ledgers = DEFAULT_LOOKBACK_LEDGERS, limit = 200 } = options;
  const ownerTopic = new Address(owner).toScVal().toXDR('base64');

  const request = async (startLedger: number) => {
    const response = await fetch(SOROSWAP_ROUTER_CONFIG.RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: {
          startLedger,
          filters: [
            {
              type: 'contract',
              contractIds: [MANDATE_CONFIG.CONTRACT],
              // '*' matches the kind, so one query covers executed / set / revoked.
              topics: [['*', '*', ownerTopic]],
            },
          ],
          pagination: { limit },
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`RPC getEvents HTTP ${response.status}`);
    }
    return (await response.json()) as {
      result?: { events: RawEvent[]; oldestLedger: number; latestLedger: number };
      error?: { message: string };
    };
  };

  const { sequence } = await server().getLatestLedger();
  const collected = new Map<string, MandateEvent>();
  let oldestLedger = sequence;
  let truncated = false;

  // Walked backwards a chunk at a time, deliberately. Each request scans only a bounded window
  // forward from its own startLedger, so a single wide query comes back empty — the scan ends
  // before it ever reaches the recent events, and the RPC reports that as success rather than
  // as an error. Measured on testnet: ~10k ledgers per scan, hence the chunk below.
  for (let offset = SCAN_CHUNK_LEDGERS; ; offset += SCAN_CHUNK_LEDGERS) {
    const start = Math.max(1, sequence - offset);
    const body = await request(start);

    if (body.error || !body.result) {
      // Past the retention floor: those ledgers are gone, not empty.
      truncated = true;
      break;
    }

    oldestLedger = body.result.oldestLedger;
    for (const raw of body.result.events) {
      if (!raw.inSuccessfulContractCall) continue;
      const event = toMandateEvent(raw);
      if (event) collected.set(event.id, event);
    }

    if (collected.size >= limit) break;
    if (start <= oldestLedger) break; // reached everything the network still holds
    if (offset >= ledgers) {
      truncated = start > oldestLedger; // stopped by the caller's window, not by retention
      break;
    }
  }

  return {
    events: [...collected.values()].sort((a, b) => b.ledger - a.ledger).slice(0, limit),
    oldestLedger,
    truncated,
  };
}

/**
 * Run one swap under the mandate, signed by the automation wallet. The owner's funds move
 * straight from their wallet to the pool and back, in a single transaction.
 */
export async function executeMandate(params: {
  owner: string;
  delegate: string;
  assetIn: string;
  assetOut: string;
  amountIn: bigint;
  amountOutMin?: bigint;
  signTransaction: SignTransactionFn;
}): Promise<{ hash: string; amountOut: bigint }> {
  const { owner, delegate, assetIn, assetOut, amountIn, amountOutMin = BigInt(0), signTransaction } = params;

  if (amountIn <= BigInt(0)) {
    throw new Error('The amount to trade must be greater than zero');
  }

  try {
    const { hash, returnValue } = await invoke({
      source: delegate,
      contract: MANDATE_CONFIG.CONTRACT,
      method: 'execute',
      args: [
        new Address(owner).toScVal(),
        new Address(assetIn).toScVal(),
        new Address(assetOut).toScVal(),
        nativeToScVal(amountIn, { type: 'i128' }),
        nativeToScVal(amountOutMin, { type: 'i128' }),
      ],
      signTransaction,
    });

    const amountOut = returnValue
      ? BigInt(scValToNative(returnValue) as string | number | bigint)
      : BigInt(0);
    return { hash, amountOut };
  } catch (error) {
    throw describe(error);
  }
}
