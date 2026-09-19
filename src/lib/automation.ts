import { Horizon } from '@stellar/stellar-sdk';
import { getAnchorInfo, getIndicativePrice, payWithdraw, pollTransaction, startWithdraw, stellarAssetId } from './anchor';
import { getAssetPrices } from './prices';
import { checkTokenTrustline } from './trustline';
import { getTokenBalance } from './allowance';
import { executeMandate, getMandate, getSpent, MandateTerms } from './mandate';
import { soroswapAPI } from './api';
import { ANCHOR_CONFIG, ASSET_CONFIGS, ASSET_OPTIONS, DEFAULT_ASSET_CONFIG, SOROSWAP_ROUTER_CONFIG } from './constants';
import { ensureTokenTrustline } from './trustline';
import { SignTransactionFn } from '@/types/anchor';

// "When money arrives, do this" rule engine.
// Trigger: USDC payments landing in the wallet (Horizon), not the anchor's own transaction record,
// because Horizon's cursor lets us process payments that arrived while the page was closed.

export interface AutomationRule {
  enabled: boolean;
  senderFilter: 'anchor' | 'any' | 'address';
  senderAddress: string; // used when senderFilter === 'address'
  minAmount: string; // USDC
  // Allocation rows: what share of the incoming USDC is converted into which asset.
  // If the total is below 100, the remainder stays in USDC.
  allocations: AutomationAllocation[];
  maxPriceImpact: string; // % — rows above this threshold are skipped ('' = no check)
  signer: 'wallet' | 'bot'; // approved via wallet, or signed silently by the automation wallet
  // Delegated mode: the funds never leave the owner's wallet. The bot pulls each swap's input with
  // an on-chain allowance the owner signed once, and the router sends the output straight back.
  // Only meaningful with signer === 'bot'.
  delegated: boolean;
  mode: 'portfolio' | 'trade'; // portfolio split or buy & sell
  trade: TradeConfig;
  minUsdTry: string; // optional gate: the rule idles while USD/TRY is below this ('' = off)
  telegramBotToken: string;
  telegramChatId: string;
}

export interface AutomationAllocation {
  asset: string; // contract address (from ASSET_OPTIONS)
  percent: number; // used when type is 'percent'
  amount?: string; // fixed USDC amount, used when type is 'amount'
  type?: 'percent' | 'amount'; // defaults to 'percent'
}

// Buy & sell mode: buys when money arrives, sells when the price target is hit, optionally cashing out to TRY.
// If asset is USDC nothing is bought; the rule becomes "cash out to TRY when USD/TRY reaches X".
export interface TradeConfig {
  asset: string;
  buyPercent: number; // share of the incoming USDC to buy with
  // Thresholds are denominated in USDC: that is the currency both legs actually trade against,
  // so a target here moves only with the asset, not with the lira.
  buyBelowUsdc: string; // buy only while the price is below this USDC value ('' = no condition)
  sellAboveUsdc: string; // sell once the price reaches this USDC value ('' = exit disabled)
  sellPercent: number; // share of the held asset to sell
  offramp: boolean; // after selling, cash out to TRY via SEP-6
}

// Result of a single allocation row
export interface AutomationLeg {
  symbol: string;
  percent: number;
  fixedAmount?: string; // set when the row is a fixed USDC amount rather than a share
  swapped?: string;
  received?: string;
  txHash?: string;
  error?: string;
  /**
   * What the row originally asked for, in USDC. Set only when the mandate's window cap trimmed
   * the order down — `swapped` is then what was actually bought and the difference stayed put.
   */
  requested?: string;
}

export interface AutomationEvent {
  id: string; // Horizon paging_token
  /**
   * Where the record came from. 'local' is this browser's journal, which also holds the
   * decisions that never reached the chain; 'chain' is reconstructed from the mandate
   * contract's events and survives a cleared browser. Absent on records written before the
   * distinction existed, which are local by definition.
   */
  source?: 'local' | 'chain';
  at: string;
  from: string;
  amount: string;
  status: 'executed' | 'skipped' | 'failed';
  reason?: string;
  legs?: AutomationLeg[];
  // Kept for compatibility with older single-target records
  swapped?: string;
  received?: string;
  targetSymbol?: string;
  txHash?: string;
}

interface HorizonPaymentRecord {
  id: string;
  paging_token: string;
  type: string;
  created_at: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  from?: string;
  to?: string;
  amount?: string;
  transaction_hash?: string;
}

export const DEFAULT_RULE: AutomationRule = {
  enabled: false,
  senderFilter: 'anchor',
  senderAddress: '',
  minAmount: '1',
  // No rows at all. A pre-filled one reads as an order someone already placed, and even an empty
  // row is a widget asking to be filled in — on a fresh wallet, or right after an order has been
  // carried out, there is nothing to show until the user adds a row.
  allocations: [],
  maxPriceImpact: '3',
  signer: 'bot',
  delegated: true,
  mode: 'portfolio',
  trade: {
    asset: SOROSWAP_ROUTER_CONFIG.USDC,
    buyPercent: 0,
    buyBelowUsdc: '',
    sellAboveUsdc: '',
    sellPercent: 100,
    offramp: false,
  },
  minUsdTry: '',
  telegramBotToken: '',
  telegramChatId: '',
};

export const POLL_INTERVAL_MS = 15000;
const MAX_EVENTS = 200;
const STROOPS = BigInt(10000000);

const ruleKey = (account: string) => `conduit_rule_${account}`;
const cursorKey = (account: string) => `conduit_cursor_${account}`;
const eventsKey = (account: string) => `conduit_events_${account}`;

const readStorage = <T>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch (error) {
    console.log('⚠️ localStorage read failed:', (error as Error).message);
    return fallback;
  }
};

const writeStorage = (key: string, value: unknown): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.log('⚠️ localStorage write failed:', (error as Error).message);
  }
};

export const loadRule = (account: string): AutomationRule => {
  if (typeof window === 'undefined') return DEFAULT_RULE;
  try {
    const raw = window.localStorage.getItem(ruleKey(account));
    if (!raw) return DEFAULT_RULE;
    const stored = JSON.parse(raw) as Partial<AutomationRule> & { targetAsset?: string; swapPercent?: number };
    // Convert an older single-target rule into an allocation row
    const allocations = stored.allocations?.length
      ? stored.allocations
      : stored.targetAsset && typeof stored.swapPercent === 'number'
        ? [{ asset: stored.targetAsset, percent: stored.swapPercent }]
        : DEFAULT_RULE.allocations;
    // Rules saved before delegated mode existed were set up as a funded bot wallet; keep them that way
    const delegated = stored.delegated ?? false;
    // Thresholds used to be written in TRY. Converting them silently would change the user's intent,
    // so an old rule comes back with its exit disabled and the target has to be re-entered in USDC.
    const legacy = stored.trade as (TradeConfig & { buyBelowTry?: string; sellAboveTry?: string }) | undefined;
    const trade: TradeConfig = {
      ...DEFAULT_RULE.trade,
      ...legacy,
      buyBelowUsdc: legacy?.buyBelowUsdc ?? '',
      sellAboveUsdc: legacy?.sellAboveUsdc ?? '',
    };
    return { ...DEFAULT_RULE, ...stored, allocations, delegated, trade };
  } catch (error) {
    console.log('⚠️ Rule read failed:', (error as Error).message);
    return DEFAULT_RULE;
  }
};

export const totalPercent = (rule: AutomationRule): number =>
  rule.allocations
    .filter(allocation => (allocation.type ?? 'percent') === 'percent')
    .reduce((sum, allocation) => sum + (Number(allocation.percent) || 0), 0);

// Sum of the rows that use a fixed USDC amount
export const totalFixed = (rule: AutomationRule): number =>
  rule.allocations
    .filter(allocation => allocation.type === 'amount')
    .reduce((sum, allocation) => sum + (Number(allocation.amount) || 0), 0);
export const saveRule = (account: string, rule: AutomationRule): void => writeStorage(ruleKey(account), rule);

export const loadEvents = (account: string): AutomationEvent[] => {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(eventsKey(account)) || '[]') as AutomationEvent[];
  } catch {
    return [];
  }
};

export const clearEvents = (account: string): void => writeStorage(eventsKey(account), []);

const pushEvent = (account: string, event: AutomationEvent): void => {
  writeStorage(eventsKey(account), [event, ...loadEvents(account)].slice(0, MAX_EVENTS));
};

export const loadCursor = (account: string): string | null => {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(cursorKey(account));
};

const saveCursor = (account: string, cursor: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(cursorKey(account), cursor);
};

const toStroops = (amount: string): bigint => {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole || '0') * STROOPS + BigInt((fraction + '0000000').slice(0, 7));
};

const fromStroops = (amount: bigint): string => {
  const whole = amount / STROOPS;
  const fraction = (amount % STROOPS).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
};

/** `fromStroops` without the trailing zeros, for amounts that appear in prose. */
const pretty = (amount: bigint): string => fromStroops(amount).replace(/\.?0+$/, '');

/** The same, for the fixed 7-decimal strings already stored on a leg. */
export const prettyAmount = (amount: string): string => pretty(toStroops(amount));

/**
 * What a capped row asked for but did not spend. Both arguments are fixed 7-decimal strings, so
 * this subtracts them as integers — at these sizes a float subtraction turns 30.2 − 25 into
 * 5.199999999999999.
 */
export const unspentUsdc = (requested: string, swapped: string): string =>
  pretty(toStroops(requested) - toStroops(swapped));

/** Whole USDC, rounded down. A cap-trimmed order is placed and reported in round numbers. */
const floorToWhole = (amount: bigint): bigint => (amount / STROOPS) * STROOPS;

const horizon = () => new Horizon.Server(ANCHOR_CONFIG.HORIZON_URL);

// Start from the latest payment so enabling the rule does not replay history
export async function initCursor(account: string): Promise<string | null> {
  const existing = loadCursor(account);
  if (existing) return existing;
  const page = await horizon().payments().forAccount(account).order('desc').limit(1).call();
  const latest = (page.records as unknown as HorizonPaymentRecord[])[0];
  const cursor = latest?.paging_token ?? '0';
  saveCursor(account, cursor);
  return cursor;
}

// Two ways to reach Telegram:
//   - no token here → /api/telegram proxies with the server's TELEGRAM_BOT_TOKEN (token never leaves the server)
//   - token typed into the UI → called directly from the browser, so it stays in this browser only
async function telegramProxy(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(15000) });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!response.ok) {
    throw new Error(body.error ?? `Telegram proxy ${response.status}`);
  }
  return body;
}

// Low-level sender: throws, so the UI can show exactly why a test failed
export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  if (!chatId) throw new Error('Telegram chat id is required');

  if (!botToken) {
    await telegramProxy('/api/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, text }),
    });
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API ${response.status}: ${body.slice(0, 200)}`);
  }
}

// Reads the chat id from the bot's pending updates. The user has to message the bot once first.
export async function findTelegramChatId(botToken: string): Promise<string | null> {
  if (!botToken) {
    const body = await telegramProxy('/api/telegram');
    return (body.chatId as string | null) ?? null;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Telegram API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as {
    result?: Array<{ message?: { chat?: { id?: number } }; channel_post?: { chat?: { id?: number } } }>;
  };
  const ids = (body.result ?? [])
    .map(update => update.message?.chat?.id ?? update.channel_post?.chat?.id)
    .filter((id): id is number => typeof id === 'number');
  return ids.length ? String(ids[ids.length - 1]) : null;
}

// Notifications never break a rule run; failures are logged and swallowed.
// The chat id alone is enough: without a token the server route supplies it.
async function sendTelegram(rule: AutomationRule, text: string): Promise<void> {
  if (!rule.telegramChatId) return;
  try {
    await sendTelegramMessage(rule.telegramBotToken, rule.telegramChatId, text);
  } catch (error) {
    console.log('⚠️ Telegram notification failed:', (error as Error).message);
  }
}

// Does the payment match the rule? Returns the reason when it does not.
async function evaluate(
  payment: HorizonPaymentRecord,
  rule: AutomationRule,
  account: string,
  usdcIssuer: string
): Promise<{ ok: boolean; reason?: string }> {
  if (payment.type !== 'payment' || payment.to !== account) {
    return { ok: false, reason: 'not a payment into this account' };
  }
  if (payment.asset_code !== ANCHOR_CONFIG.DEFAULT_ASSET_CODE || payment.asset_issuer !== usdcIssuer) {
    return { ok: false, reason: `different asset (${payment.asset_code ?? 'XLM'})` };
  }
  if (payment.from === account) {
    return { ok: false, reason: 'payment sent by this account' };
  }

  if (rule.senderFilter === 'anchor') {
    const treasury = await anchorTreasury();
    if (treasury && payment.from !== treasury) {
      return { ok: false, reason: 'sender is not the anchor treasury' };
    }
  }
  if (rule.senderFilter === 'address' && payment.from !== rule.senderAddress.trim()) {
    return { ok: false, reason: 'sender does not match the filter' };
  }

  if (toStroops(payment.amount ?? '0') < toStroops(rule.minAmount || '0')) {
    return { ok: false, reason: `amount below the minimum (${payment.amount} < ${rule.minAmount})` };
  }

  if (rule.minUsdTry) {
    // TRY received for selling 1 USDC. total_price is the inverse (USDC per TRY), so buyAmount is used.
    const price = await getIndicativePrice(stellarAssetId('USDC', usdcIssuer), ANCHOR_CONFIG.FIAT_ASSET, '1');
    if (Number(price.buyAmount) < Number(rule.minUsdTry)) {
      return { ok: false, reason: `1 USDC = ${price.buyAmount} TRY, threshold ${rule.minUsdTry}` };
    }
  }

  return { ok: true };
}

// The account the anchor pays USDC from; deposits originate here
let treasuryCache: string | null = null;
async function anchorTreasury(): Promise<string | null> {
  if (treasuryCache) return treasuryCache;
  try {
    const info = await getAnchorInfo();
    const origin = new URL(info.transferServer).origin;
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const health = (await response.json()) as { treasury?: { address?: string } };
    treasuryCache = health.treasury?.address ?? null;
    return treasuryCache;
  } catch (error) {
    console.log('⚠️ Anchor treasury unavailable, skipping the sender filter:', (error as Error).message);
    return null;
  }
}

/**
 * Why delegated mode cannot run, or null when it can.
 *
 * A mandate records the one automation wallet it will accept calls from. If the local wallet has
 * been regenerated since the mandate was signed — a cleared browser, a second device, a rebuilt
 * bot — the two drift apart, and the contract's refusal arrives as an auth trap from inside
 * require_auth, with the failing address buried in diagnostic events. Comparing them here turns
 * that into a sentence the user can act on.
 */
type MandateStatus =
  | { problem: string; mandate: null }
  | { problem: null; mandate: MandateTerms };

async function mandateStatus(account: string, spender: string): Promise<MandateStatus> {
  const mandate = await getMandate(account);
  if (!mandate) {
    return {
      problem: 'no mandate registered on chain — sign one in the automation tab and the rule runs by itself',
      mandate: null,
    };
  }
  if (mandate.delegate !== spender) {
    const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
    return {
      problem:
        `the mandate on chain authorises automation wallet ${short(mandate.delegate)}, but this ` +
        `browser's automation wallet is ${short(spender)} — re-sign the mandate so it names the ` +
        `current wallet, or restore the one it already names`,
      mandate: null,
    };
  }
  return { problem: null, mandate };
}

async function execute(
  payment: HorizonPaymentRecord,
  rule: AutomationRule,
  account: string,
  usdcContract: string,
  signTransaction: SignTransactionFn,
  // Delegated mode: `account` holds the funds and signed the allowance, `spender` is the bot that
  // signs the swaps. Without it the signer and the holder are the same account.
  spender?: string
): Promise<AutomationEvent> {
  const incoming = toStroops(payment.amount ?? '0');

  const base: AutomationEvent = {
    id: payment.paging_token,
    at: new Date().toISOString(),
    from: payment.from ?? '',
    amount: payment.amount ?? '0',
    status: 'skipped',
  };

  // Delegated mode runs entirely through the mandate contract, so a missing mandate is a setup
  // problem, not a per-row failure. Say it once rather than once per allocation.
  //
  // The same read gives the window budget. The contract refuses a call that would cross the cap
  // rather than shaving it (lib.rs, Error::CapExceeded), so a rule that asks for more than the
  // window allows would otherwise buy nothing at all. Knowing what is left turns that refusal
  // into a partial fill.
  let capLeft: bigint | undefined;
  if (spender) {
    const status = await mandateStatus(account, spender);
    if (status.problem !== null) return { ...base, reason: status.problem };
    capLeft = status.mandate.capPerWindow - (await getSpent(account));
  }

  let active: AutomationAllocation[];
  if (rule.mode === 'trade') {
    const { asset, buyPercent, buyBelowUsdc } = rule.trade;
    if (!asset || buyPercent <= 0 || asset === SOROSWAP_ROUTER_CONFIG.USDC) {
      return { ...base, reason: 'buy & sell mode: buying is off, funds stay in USDC' };
    }
    if (buyBelowUsdc) {
      const price = (await getAssetPrices([asset]))[asset];
      // One-shot: the payment's cursor has already advanced, so a vetoed buy is not retried later
      if (price && price.usdc > Number(buyBelowUsdc)) {
        return { ...base, reason: `buy condition not met: ${price.usdc.toFixed(7)} USDC > ${buyBelowUsdc} USDC` };
      }
    }
    active = [{ asset, percent: buyPercent }];
  } else {
    active = rule.allocations.filter(allocation =>
      allocation.asset &&
      (allocation.type === 'amount' ? Number(allocation.amount) > 0 : Number(allocation.percent) > 0)
    );
    if (active.length === 0) {
      return { ...base, reason: 'no allocation defined' };
    }
  }

  const legs: AutomationLeg[] = [];
  // Rows are funded from the incoming payment in order; a row that no longer fits is skipped
  let remaining = incoming;

  // Every row is its own swap; if one fails the others still run
  for (const allocation of active) {
    const asset = ASSET_OPTIONS.find(option => option.value === allocation.asset);
    const symbol = asset?.symbol ?? 'token';
    const percent = Number(allocation.percent);
    const isFixed = allocation.type === 'amount';
    const fixedAmount = isFixed ? allocation.amount ?? '0' : undefined;
    let amount = isFixed
      ? toStroops(fixedAmount as string)
      : (incoming * BigInt(Math.round(percent))) / BigInt(100);

    if (amount <= BigInt(0)) {
      legs.push({ symbol, percent, fixedAmount, error: 'amount too small' });
      continue;
    }
    if (amount > remaining) {
      legs.push({
        symbol,
        percent,
        fixedAmount,
        error: `needs ${fromStroops(amount)} USDC, only ${fromStroops(remaining)} left`,
      });
      continue;
    }

    // Trim the row to what the mandate window still allows, rounded down to whole USDC: an order
    // the owner did not choose the size of reads better as 25 than as 25.2831940. What is left
    // over is not spent and not parked anywhere — it simply stays USDC in the owner's wallet,
    // and the next window buys it.
    let requested: bigint | undefined;
    if (capLeft !== undefined && amount > capLeft) {
      const trimmed = floorToWhole(capLeft);
      if (trimmed <= BigInt(0)) {
        legs.push({
          symbol,
          percent,
          fixedAmount,
          error:
            `mandate window cap reached — ${pretty(capLeft)} USDC of room is under the 1 USDC ` +
            `minimum, so nothing was bought; the window resets on its own`,
        });
        continue;
      }
      requested = amount;
      amount = trimmed;
    }

    const config = (ASSET_CONFIGS as Record<string, { maxHops: number; slippageBps: number }>)[symbol] ?? DEFAULT_ASSET_CONFIG;

    try {
      const quote = await soroswapAPI.getQuote({
        assetIn: usdcContract,
        assetOut: allocation.asset,
        amount: amount.toString(),
        tradeType: 'EXACT_IN',
        protocols: ['soroswap'],
        slippageBps: config.slippageBps,
        parts: 1,
        maxHops: config.maxHops,
      });
      // Keep the rule from buying blindly in thin pools; with bot signing nobody sees the numbers
      if (rule.maxPriceImpact && Number(quote.priceImpactPct) > Number(rule.maxPriceImpact)) {
        legs.push({
          symbol,
          percent,
          error: `price impact ${quote.priceImpactPct}% > ${rule.maxPriceImpact}%, skipped`,
          fixedAmount,
        });
        continue;
      }

      // Trustlines are handled after the price check so a skipped row does not lock up reserves
      if (spender) {
        // The bot cannot sign for the owner, so a missing trustline is reported rather than opened
        const status = await checkTokenTrustline(account, allocation.asset);
        if (status.needed && !status.exists) {
          legs.push({
            symbol,
            percent,
            fixedAmount,
            error: `no ${symbol} trustline on your wallet; add it once and this row runs by itself`,
          });
          continue;
        }
        // The automation wallet needs no trustlines of its own: the funds pass through the
        // mandate contract, and a contract address holds its SAC balance in contract storage.
      } else {
        const trustline = await ensureTokenTrustline(account, allocation.asset, signTransaction);
        if (trustline.created) {
          console.log(`🔗 Trustline opened for ${symbol}`);
        }
      }

      // Delegated mode is one call. The mandate contract pulls the input from the owner, swaps
      // it and forwards the proceeds in a single transaction, so there is no in-between state
      // where funds sit in the automation wallet — either the whole leg settles or nothing moved.
      // It also refuses anything outside the mandate: wrong asset, over the window cap, past the
      // price bound, expired.
      let result: { hash?: string };
      let receivedAmount: bigint;

      if (spender) {
        const { hash, amountOut } = await executeMandate({
          owner: account,
          delegate: spender,
          assetIn: usdcContract,
          assetOut: allocation.asset,
          amountIn: amount,
          // The quote's slippage floor still applies; the mandate raises it when its own price
          // bound demands more, never lowers it.
          amountOutMin: BigInt(quote.otherAmountThreshold ?? '0'),
          signTransaction,
        });
        result = { hash };
        receivedAmount = amountOut;
      } else {
        const built = await soroswapAPI.buildTransaction({ quote, sponsor: account, from: account });
        const signed = await signTransaction(built.xdr);
        result = await soroswapAPI.sendTransaction({ xdr: signed });
        receivedAmount = BigInt(quote.amountOut);
      }

      // Buy & sell mode remembers what it bought, so the exit sells the position rather than the wallet
      if (rule.mode === 'trade') {
        addPosition(account, allocation.asset, receivedAmount);
      }

      remaining -= amount;
      // Only the buy leg draws on the window, and only what actually settled.
      if (capLeft !== undefined) capLeft -= amount;
      legs.push({
        symbol,
        percent,
        fixedAmount,
        swapped: fromStroops(amount),
        received: fromStroops(receivedAmount),
        txHash: result.hash,
        requested: requested === undefined ? undefined : fromStroops(requested),
      });
    } catch (error) {
      const message = (error as Error).message;
      console.error(`❌ ${symbol} row failed:`, error);
      legs.push({ symbol, percent, fixedAmount, error: message });
    }
  }

  const succeeded = legs.filter(leg => leg.txHash);
  const event: AutomationEvent = {
    ...base,
    status: succeeded.length > 0 ? 'executed' : 'failed',
    legs,
    reason: succeeded.length === 0 ? legs.map(leg => `${leg.symbol}: ${leg.error}`).join(' · ') : undefined,
  };

  // A trimmed row is the one case where the message has to say more than what was bought: the
  // owner asked for an amount they did not get, and the difference is sitting in their wallet
  // rather than lost or pending. Naming both numbers is what makes that obvious without opening
  // the app.
  let heldBack = BigInt(0);
  const lines = legs
    .map(leg => {
      if (!leg.txHash) return `%${leg.percent} ${leg.symbol}: ${leg.error}`;
      const line = `%${leg.percent} → ${leg.received} ${leg.symbol}`;
      if (!leg.requested) return line;
      const leftover = toStroops(leg.requested) - toStroops(leg.swapped as string);
      heldBack += leftover;
      return (
        `${line}\n` +
        `   ↳ mandate window cap: bought ${pretty(toStroops(leg.swapped as string))} USDC ` +
        `of the ${pretty(toStroops(leg.requested))} USDC this row asked for`
      );
    })
    .join('\n');

  const capNote =
    heldBack > BigInt(0)
      ? `\n\n💤 ${pretty(heldBack)} USDC was not spent and stays in your wallet as USDC. ` +
        `It is untouched — the next window can buy with it.`
      : '';

  await sendTelegram(
    rule,
    `⚡ Conduit automation\n\nReceived: ${base.amount} USDC\n${lines}${capNote}\n${new Date().toLocaleString('en-US')}`
  );

  return event;
}

// ---------------------------------------------------------------------------
// Exit side of buy & sell mode: sell at the price target, optionally cash out to TRY
// ---------------------------------------------------------------------------

const exitKey = (account: string) => `conduit_exit_done_${account}`;

export const isExitDone = (account: string): boolean =>
  typeof window !== 'undefined' && window.localStorage.getItem(exitKey(account)) === '1';

export const resetExit = (account: string): void => {
  if (typeof window !== 'undefined') window.localStorage.removeItem(exitKey(account));
};

const markExitDone = (account: string): void => {
  if (typeof window !== 'undefined') window.localStorage.setItem(exitKey(account), '1');
};

// The position this rule actually opened, per account and asset.
// Without it "sell 100% of holdings" would dump everything in the wallet — including coins the user
// holds for other reasons and, on testnet, the whole friendbot balance.
const positionKey = (account: string, asset: string) => `conduit_position_${account}_${asset}`;

export const loadPosition = (account: string, asset: string): bigint => {
  if (typeof window === 'undefined') return BigInt(0);
  try {
    return BigInt(window.localStorage.getItem(positionKey(account, asset)) ?? '0');
  } catch {
    return BigInt(0);
  }
};

const savePosition = (account: string, asset: string, amount: bigint): void => {
  if (typeof window === 'undefined') return;
  const value = amount > BigInt(0) ? amount : BigInt(0);
  window.localStorage.setItem(positionKey(account, asset), value.toString());
};

const addPosition = (account: string, asset: string, amount: bigint): void => {
  savePosition(account, asset, loadPosition(account, asset) + amount);
};

/**
 * A direct swap never touches the mandate contract, so nothing was translating the codes it can
 * still raise — the user saw a bare `Error(Contract, #10)`. These are the token contract's own
 * codes (verified against testnet: an overdraw returns #10, a negative amount #8), plus the
 * router's slippage refusal. The mandate's own codes start at 100 and are handled in mandate.ts.
 */
const SWAP_ERRORS: Record<number, string> = {
  8: 'the amount is not valid',
  10: 'the account no longer holds that much of this asset — reload the balances and try again',
  13: 'the account has no trustline for the asset being bought; open one and try again',
  507: 'the pool could not return the minimum this swap demands: the price moved while it was being signed',
};

const describeSwapError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/Error\(Contract, #(\d+)\)/);
  return (code ? SWAP_ERRORS[Number(code[1])] : undefined) ?? message;
};

// How much of an asset the exit could actually sell. Shared with the UI so the payout estimate and
// the real sale never disagree: XLM keeps its minimum reserve plus a fee buffer, and every other
// asset is read from its token contract (pure Soroban tokens have no classic balance at all).
export async function sellableBalance(account: string, asset: string): Promise<bigint> {
  if (asset !== SOROSWAP_ROUTER_CONFIG.XLM) {
    return getTokenBalance(asset, account);
  }

  const horizonAccount = await horizon().loadAccount(account);
  const native = horizonAccount.balances.find(balance => balance.asset_type === 'native');
  const reserved = (2 + (horizonAccount.subentry_count ?? 0)) * 0.5 + 1;
  const available = toStroops(native?.balance ?? '0') - toStroops(reserved.toFixed(7));
  return available > BigInt(0) ? available : BigInt(0);
}

export async function checkExit(params: {
  account: string;
  rule: AutomationRule;
  /** The owner's signer. Still required for the off-ramp leg, which the mandate cannot cover. */
  signTransaction: SignTransactionFn;
  spender?: string; // delegated mode: the automation wallet named in the mandate
  delegateSignTransaction?: SignTransactionFn;
  authenticate?: () => Promise<string>; // SEP-10 token provider for the off-ramp step
  onEvent?: (event: AutomationEvent) => void;
  /**
   * A target to check against for this run only, in place of the rule's own.
   *
   * Testnet pools have no other traders, so a rule's real target is reached when someone moves
   * the pool and not before — which leaves no way to rehearse the exit at a moment of one's
   * choosing. Everything else stays: the price is still read from the pool and still has to
   * clear the number, so this lowers the bar rather than removing it, and a sale can still be
   * refused. The event says the target was supplied by hand, because a sale answering a typed
   * threshold should not read like one answering the rule.
   */
  sellAboveOverride?: string;
}): Promise<AutomationEvent | null> {
  const { account, rule, signTransaction, spender, delegateSignTransaction, authenticate, onEvent, sellAboveOverride } = params;

  if (rule.mode !== 'trade') return null;
  const manual = !!sellAboveOverride;
  const target = sellAboveOverride ?? rule.trade.sellAboveUsdc;
  if (!target || !(Number(target) > 0)) return null;
  // The exit runs once so a price hovering around the threshold cannot sell repeatedly. A
  // rehearsal is asked for each time it happens, so it is not held to that.
  if (!manual && isExitDone(account)) return null;

  const { asset, sellPercent, offramp } = rule.trade;
  const price = (await getAssetPrices([asset]))[asset];
  if (!price || !price.usdc) return null;

  const symbol = ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token';
  const base: AutomationEvent = {
    id: `exit-${Date.now()}`,
    at: new Date().toISOString(),
    from: manual ? 'manual exit' : 'exit rule',
    amount: `${price.usdc.toFixed(7)} USDC ≥ ${target} USDC${manual ? ' (target entered by hand)' : ''}`,
    status: 'skipped',
  };

  if (price.usdc < Number(target)) {
    // Silence is right for the watcher, which asks every 15 seconds. Someone who just pressed a
    // button is owed an answer.
    if (!manual) return null;
    const event = {
      ...base,
      amount: `${price.usdc.toFixed(7)} USDC < ${target} USDC (target entered by hand)`,
      reason: `1 ${symbol} is ${price.usdc.toFixed(7)} USDC, below the ${target} USDC you entered — nothing was sold`,
    };
    pushEvent(account, event);
    onEvent?.(event);
    return event;
  }

  // The sell leg goes through the mandate too, so the same drift breaks it in the same way.
  if (spender) {
    const { problem } = await mandateStatus(account, spender);
    if (problem) {
      const event = { ...base, reason: problem };
      pushEvent(account, event);
      onEvent?.(event);
      return event;
    }
  }

  // Only what this rule bought is for sale, capped by what the wallet can actually part with
  const position = loadPosition(account, asset);
  const spendable = await sellableBalance(account, asset);
  const available = position < spendable ? position : spendable;

  const sellAmount = (available * BigInt(Math.round(sellPercent))) / BigInt(100);
  if (sellAmount <= BigInt(0)) {
    const event = {
      ...base,
      reason: position <= BigInt(0)
        ? `this rule has not bought any ${symbol} yet, so there is no position to sell`
        : `no ${symbol} balance to sell`,
    };
    pushEvent(account, event);
    onEvent?.(event);
    return event;
  }

  console.log(`🎯 Exit condition met: 1 ${symbol} = ${price.try.toFixed(2)} TRY`);
  const legs: AutomationLeg[] = [];
  let usdcAmount = sellAmount;

  // 1) Convert the asset back to USDC (skipped when the asset already is USDC)
  if (asset !== SOROSWAP_ROUTER_CONFIG.USDC) {
    const config = (ASSET_CONFIGS as Record<string, { maxHops: number; slippageBps: number }>)[symbol] ?? DEFAULT_ASSET_CONFIG;
    try {
      const quote = await soroswapAPI.getQuote({
        assetIn: asset,
        assetOut: SOROSWAP_ROUTER_CONFIG.USDC,
        amount: sellAmount.toString(),
        tradeType: 'EXACT_IN',
        protocols: ['soroswap'],
        slippageBps: config.slippageBps,
        parts: 1,
        maxHops: config.maxHops,
      });
      if (rule.maxPriceImpact && Number(quote.priceImpactPct) > Number(rule.maxPriceImpact)) {
        const event = {
          ...base,
          reason: `sale skipped: price impact ${quote.priceImpactPct}% > ${rule.maxPriceImpact}%`,
        };
        pushEvent(account, event);
        onEvent?.(event);
        return event; // retried on the next tick if the impact drops
      }
      let txHash: string | undefined;
      if (spender && delegateSignTransaction) {
        // The exit runs under the same mandate as the buy — its `sell_above` bound is what the
        // contract enforces — so the owner does not have to be at the keyboard for it to fire.
        const { hash, amountOut } = await executeMandate({
          owner: account,
          delegate: spender,
          assetIn: asset,
          assetOut: SOROSWAP_ROUTER_CONFIG.USDC,
          amountIn: sellAmount,
          amountOutMin: BigInt(quote.otherAmountThreshold ?? '0'),
          signTransaction: delegateSignTransaction,
        });
        txHash = hash;
        usdcAmount = amountOut;
      } else {
        const built = await soroswapAPI.buildTransaction({ quote, sponsor: account, from: account });
        const result = await soroswapAPI.sendTransaction({ xdr: await signTransaction(built.xdr) });
        txHash = result.hash;
        usdcAmount = BigInt(quote.amountOut);
      }
      savePosition(account, asset, position - sellAmount); // the sold part is no longer held
      legs.push({
        symbol: `${symbol} → USDC`,
        percent: sellPercent,
        swapped: fromStroops(sellAmount),
        received: fromStroops(usdcAmount),
        txHash,
      });
    } catch (error) {
      const message = (error as Error).message;
      console.error('❌ Exit sale failed:', error);
      const event = { ...base, status: 'failed' as const, reason: message };
      pushEvent(account, event);
      onEvent?.(event);
      return event;
    }
  }

  // 2) Cash out to TRY when requested
  if (offramp) {
    const amount = fromStroops(usdcAmount);
    try {
      if (!authenticate) throw new Error('no anchor session provided');
      if (Number(amount) < 1) throw new Error(`off-ramp requires at least 1 USDC (${amount})`);

      const jwt = await authenticate();
      const withdraw = await startWithdraw(jwt, { amount });
      await payWithdraw({ sourceAccount: account, withdraw, amount }, signTransaction);
      const settled = await pollTransaction(jwt, withdraw.id, undefined, { timeoutMs: 180000 });
      legs.push({
        symbol: 'USDC → TRY',
        percent: 100,
        swapped: amount,
        received: `${settled.amount_out} TRY → ${settled.to}`,
        txHash: settled.stellar_transaction_id ?? undefined,
      });
    } catch (error) {
      const message = (error as Error).message;
      console.error('❌ Off-ramp failed:', error);
      legs.push({ symbol: 'USDC → TRY', percent: 100, error: message });
    }
  }

  const event: AutomationEvent = {
    ...base,
    status: legs.some(leg => leg.txHash || leg.received) ? 'executed' : 'failed',
    legs,
  };
  pushEvent(account, event);
  onEvent?.(event);
  // A sale against a typed target is not the rule having fired, so it does not use the rule up.
  // The rule's own condition stays armed against whatever the position still holds.
  if (!manual) markExitDone(account);

  await sendTelegram(
    rule,
    `${manual ? '🔧 Conduit exit — demo run' : '🎯 Conduit exit rule'}\n\n` +
      `1 ${symbol} = ${price.usdc.toFixed(7)} USDC (target ${target}${manual ? ', entered by hand' : ''})\n` +
      legs.map(leg => (leg.error ? `${leg.symbol}: ${leg.error}` : `${leg.symbol}: ${leg.swapped} → ${leg.received}`)).join('\n')
  );

  return event;
}

export interface SellablePosition {
  asset: string;
  symbol: string;
  amount: bigint; // what can actually be sold, in stroops
  usdc?: bigint; // quoted proceeds
  priceImpactPct?: string;
  error?: string;
  /** Set when the price-impact ceiling means the cash-out will skip this row. */
  blocked?: string;
  /**
   * What the pool's depth would cost on top of its own spot price, in USDC, if the whole holding
   * were sold at once. This is the number the ceiling is actually protecting — a percentage alone
   * reads as a technicality, while "you would lose 0.25 USDC" is the thing being decided.
   */
  impactCostUsdc?: bigint;
  /**
   * The largest slice that still lands under the ceiling, so a blocked row offers a way forward
   * instead of only a refusal. Absent when there is no direct pool to solve it from.
   */
  withinCeiling?: bigint;
}

/**
 * What this wallet holds of the given assets, priced in USDC but not sold.
 *
 * XLM reports what is spendable rather than the raw balance: its minimum reserve and a fee
 * buffer are held back (see sellableBalance), so selling can never leave the account unable to
 * pay for its own transactions.
 */
export async function sellableHoldings(
  account: string,
  assets: string[],
  options: { maxPriceImpact?: string } = {}
): Promise<SellablePosition[]> {
  const unique = assets.filter((asset, index) => asset && assets.indexOf(asset) === index);
  const rows = await Promise.all(
    unique.map(async (asset): Promise<SellablePosition | null> => {
      const symbol = ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token';
      if (asset === SOROSWAP_ROUTER_CONFIG.USDC) return null; // already the target
      let amount: bigint;
      try {
        amount = await sellableBalance(account, asset);
      } catch (error) {
        const message = (error as Error).message;
        // balance() failing at the contract level means the account has no entry for this token,
        // which is "holds none" rather than something worth reporting. A network failure is.
        if (!message.startsWith('Network Error')) return null;
        return { asset, symbol, amount: BigInt(0), error: message };
      }
      if (amount <= BigInt(0)) return null; // nothing held, nothing to show

      const config = (ASSET_CONFIGS as Record<string, { maxHops: number; slippageBps: number }>)[symbol] ?? DEFAULT_ASSET_CONFIG;
      try {
        const quote = await soroswapAPI.getQuote({
          assetIn: asset,
          assetOut: SOROSWAP_ROUTER_CONFIG.USDC,
          amount: amount.toString(),
          tradeType: 'EXACT_IN',
          protocols: ['soroswap'],
          slippageBps: config.slippageBps,
          parts: 1,
          maxHops: config.maxHops,
        });
        const usdc = BigInt(quote.amountOut);
        const impact = Number(quote.priceImpactPct);
        const ceiling = Number(options.maxPriceImpact);
        if (!options.maxPriceImpact || !(impact > ceiling)) {
          return { asset, symbol, amount, usdc, priceImpactPct: quote.priceImpactPct };
        }

        // Over the ceiling. Work out both what it would cost and what would still fit, so the row
        // can offer a decision rather than a refusal.
        // spotOut = out / (1 - impact), so the shortfall is out · impact / (1 - impact).
        const fraction = impact / 100;
        const impactCostUsdc = BigInt(Math.round(Number(usdc) * (fraction / (1 - fraction))));
        const solved = await soroswapAPI.maxAmountInForImpact(asset, SOROSWAP_ROUTER_CONFIG.USDC, ceiling);
        // Never suggest more than is actually held.
        const withinCeiling = solved && solved > BigInt(0)
          ? (solved > amount ? amount : solved)
          : undefined;

        return {
          asset,
          symbol,
          amount,
          usdc,
          priceImpactPct: quote.priceImpactPct,
          blocked: `selling all of it would move the pool price ${quote.priceImpactPct}%, past your ${options.maxPriceImpact}% limit`,
          impactCostUsdc,
          withinCeiling,
        };
      } catch (error) {
        return { asset, symbol, amount, error: (error as Error).message };
      }
    })
  );
  return rows.filter((row): row is SellablePosition => row !== null);
}

/**
 * Sell one asset for USDC. The proceeds stay in the owner's wallet — turning them into lira is
 * the anchor's job and needs the owner's signature, so it is a separate, deliberate step.
 */
export async function sellForUsdc(params: {
  account: string;
  asset: string;
  amount: bigint;
  maxPriceImpact?: string;
  signTransaction: SignTransactionFn;
  /** Delegated mode: the automation wallet named in the mandate signs the swap. */
  spender?: string;
  delegateSignTransaction?: SignTransactionFn;
  onEvent?: (event: AutomationEvent) => void;
}): Promise<AutomationEvent> {
  const { account, asset, amount, maxPriceImpact, signTransaction, spender, delegateSignTransaction, onEvent } = params;

  const symbol = ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token';
  const label = `${symbol} \u2192 USDC`;
  const base: AutomationEvent = {
    id: `sell-${Date.now()}`,
    source: 'local',
    at: new Date().toISOString(),
    from: 'manual sale',
    amount: fromStroops(amount),
    status: 'skipped',
  };

  const emit = (event: AutomationEvent): AutomationEvent => {
    pushEvent(account, event);
    onEvent?.(event);
    return event;
  };

  if (amount <= BigInt(0)) {
    return emit({ ...base, reason: `no ${symbol} available to sell` });
  }

  // The token contract reports an overdraw from inside the simulation, as Error(Contract, #10),
  // which names neither the asset nor the shortfall. Read the spendable balance first so the
  // refusal can say both — and so a figure that went stale while the page was open (a balance
  // that moved, or an XLM reserve that grew with a new trustline) is caught before signing.
  const spendable = await sellableBalance(account, asset);
  if (amount > spendable) {
    return emit({
      ...base,
      reason: `not enough ${symbol}: ${fromStroops(amount)} requested, ${fromStroops(spendable)} spendable`
        + (asset === SOROSWAP_ROUTER_CONFIG.XLM
          ? ' — XLM holds back its minimum reserve and a 1 XLM fee buffer'
          : ''),
    });
  }

  const config = (ASSET_CONFIGS as Record<string, { maxHops: number; slippageBps: number }>)[symbol] ?? DEFAULT_ASSET_CONFIG;
  try {
    // Re-quoted here rather than trusting the estimate on screen: pool reserves move with every
    // swap, and the figure the user looked at may be seconds old.
    const quote = await soroswapAPI.getQuote({
      assetIn: asset,
      assetOut: SOROSWAP_ROUTER_CONFIG.USDC,
      amount: amount.toString(),
      tradeType: 'EXACT_IN',
      protocols: ['soroswap'],
      slippageBps: config.slippageBps,
      parts: 1,
      maxHops: config.maxHops,
    });

    if (maxPriceImpact && Number(quote.priceImpactPct) > Number(maxPriceImpact)) {
      return emit({
        ...base,
        reason: `price impact ${quote.priceImpactPct}% is above your ${maxPriceImpact}% ceiling`,
      });
    }

    let txHash: string | undefined;
    let received: bigint;
    if (spender && delegateSignTransaction) {
      const result = await executeMandate({
        owner: account,
        delegate: spender,
        assetIn: asset,
        assetOut: SOROSWAP_ROUTER_CONFIG.USDC,
        amountIn: amount,
        amountOutMin: BigInt(quote.otherAmountThreshold ?? '0'),
        signTransaction: delegateSignTransaction,
      });
      txHash = result.hash;
      received = result.amountOut;
    } else {
      const built = await soroswapAPI.buildTransaction({ quote, sponsor: account, from: account });
      const sent = await soroswapAPI.sendTransaction({ xdr: await signTransaction(built.xdr) });
      txHash = sent.hash;
      received = BigInt(quote.amountOut);
    }

    savePosition(account, asset, BigInt(0)); // whatever a rule was tracking for this asset is gone
    return emit({
      ...base,
      status: 'executed',
      amount: fromStroops(received),
      legs: [{
        symbol: label,
        percent: 100,
        swapped: fromStroops(amount),
        received: fromStroops(received),
        txHash,
      }],
    });
  } catch (error) {
    console.error(`\u274c Sale failed for ${symbol}:`, error);
    return emit({ ...base, status: 'failed', reason: describeSwapError(error) });
  }
}

export interface PollResult {
  checked: number;
  events: AutomationEvent[];
}

// Processes payments after the cursor, including ones that arrived while the page was closed.
export async function pollOnce(params: {
  account: string;
  rule: AutomationRule;
  signTransaction: SignTransactionFn;
  spender?: string; // delegated mode: the bot that signs, while `account` keeps the funds
  onEvent?: (event: AutomationEvent) => void;
}): Promise<PollResult> {
  const { account, rule, signTransaction, spender, onEvent } = params;
  const info = await getAnchorInfo();
  const currency = info.currencies.find(c => c.code === ANCHOR_CONFIG.DEFAULT_ASSET_CODE);
  if (!currency?.issuer) {
    throw new Error('Anchor USDC issuer not found');
  }
  const usdcContract = SOROSWAP_ROUTER_CONFIG.USDC;

  const cursor = (await initCursor(account)) ?? '0';
  const page = await horizon().payments().forAccount(account).cursor(cursor).order('asc').limit(50).call();
  const records = page.records as unknown as HorizonPaymentRecord[];

  const events: AutomationEvent[] = [];
  for (const payment of records) {
    saveCursor(account, payment.paging_token);

    const verdict = await evaluate(payment, rule, account, currency.issuer);
    if (!verdict.ok) {
      // Only USDC payments are logged when they miss the rule, to keep the history quiet
      if (payment.asset_code === ANCHOR_CONFIG.DEFAULT_ASSET_CODE && payment.to === account) {
        const skipped: AutomationEvent = {
          id: payment.paging_token,
          at: new Date().toISOString(),
          from: payment.from ?? '',
          amount: payment.amount ?? '0',
          status: 'skipped',
          reason: verdict.reason,
        };
        pushEvent(account, skipped);
        events.push(skipped);
        onEvent?.(skipped);
      }
      continue;
    }

    const event = await execute(payment, rule, account, usdcContract, signTransaction, spender);
    pushEvent(account, event);
    events.push(event);
    onEvent?.(event);
  }

  return { checked: records.length, events };
}

// Periodic watcher; call the returned function to stop it
export function startWatcher(params: {
  account: string;
  getRule: () => AutomationRule;
  signTransaction: SignTransactionFn;
  spender?: string; // delegated mode: the bot that signs, while `account` keeps the funds
  // Delegated mode sells and cashes out from the owner's own wallet, which the bot cannot sign for.
  ownerSignTransaction?: SignTransactionFn;
  authenticate?: () => Promise<string>;
  onEvent?: (event: AutomationEvent) => void;
  onError?: (message: string) => void;
  intervalMs?: number;
}): () => void {
  const {
    account,
    getRule,
    signTransaction,
    spender,
    ownerSignTransaction,
    authenticate,
    onEvent,
    onError,
    intervalMs = POLL_INTERVAL_MS,
  } = params;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    const rule = getRule();
    if (!rule.enabled) return;
    running = true;
    try {
      await pollOnce({ account, rule, signTransaction, spender, onEvent });
      // Buy & sell mode also checks the price target
      if (rule.mode === 'trade') {
        await checkExit({
          account,
          rule,
          // The sale goes through the mandate; only the off-ramp still needs the owner, because a
          // SEP-6 withdrawal is a memo-carrying payment from their own account.
          signTransaction: spender ? ownerSignTransaction ?? signTransaction : signTransaction,
          spender,
          delegateSignTransaction: spender ? signTransaction : undefined,
          authenticate,
          onEvent,
        });
      }
    } catch (error) {
      console.error('❌ Automation loop error:', error);
      onError?.((error as Error).message);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
