'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@/hooks/use-freighter';
import * as anchor from '@/lib/anchor';
import { getTryIbanError, normalizeIban } from '@/lib/iban';
import * as automation from '@/lib/automation';
import * as botWalletLib from '@/lib/bot-wallet';
import * as allowanceLib from '@/lib/allowance';
import * as mandateLib from '@/lib/mandate';
import { ensureTokenTrustline, missingTrustlines } from '@/lib/trustline';
import { formatPrice, getAssetPrices, PriceTable } from '@/lib/prices';
import { soroswapAPI } from '@/lib/api';
import { ANCHOR_CONFIG, ASSET_CONFIGS, ASSET_OPTIONS, DEFAULT_ASSET_CONFIG, MANDATE_CONFIG, SOROSWAP_ROUTER_CONFIG } from '@/lib/constants';
import { AnchorInfo, AnchorQuote, DepositStart, Sep6Transaction, WithdrawStart } from '@/types/anchor';
import type { StrategyDraft } from '@/lib/ai/strategy';
import {
  ArrowDownToLine, ArrowUpFromLine, KeyRound, Lock, PieChart,
  Fingerprint, ScrollText, ShieldCheck, Sparkles, TrendingUp, Wallet, Zap,
} from 'lucide-react';
import { Logo } from '@/components/ui/logo';

const TERMINAL_OK = 'completed';

// Pool reserves move with every swap, so the reference table is re-read on this cadence
const PRICE_REFRESH_MS = 20000;

const statusColor = (status?: string): string => {
  if (!status) return 'bg-white/10 text-white/70';
  if (status === TERMINAL_OK) return 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/40';
  if (['error', 'expired', 'no_market', 'too_small', 'too_large'].includes(status)) {
    return 'bg-red-500/20 text-red-200 border border-red-400/40';
  }
  return 'bg-amber-500/20 text-amber-100 border border-amber-400/40';
};

// One automation event row — shared by the Automation tab's "Rule history" and the History tab.
// Everything the rule engine can route against USDC. A mandate may name all of them at once, so
// one signature covers every asset the user might switch to later.
const TRADABLE_ASSETS = ASSET_OPTIONS
  .map(option => option.value)
  .filter(asset => asset !== SOROSWAP_ROUTER_CONFIG.USDC);

const symbolList = (assets: string[]): string =>
  assets.length === 0
    ? '—'
    : assets.map(asset => ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token').join(', ');

const EventItem = ({ event, verified }: { event: automation.AutomationEvent; verified?: boolean }) => (
  <li className="bg-black/20 rounded-lg p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5">
        <span className={`px-2 py-0.5 rounded text-xs ${
          event.status === 'executed'
            ? 'bg-emerald-500/20 text-emerald-200'
            : event.status === 'failed'
              ? 'bg-red-500/20 text-red-200'
              : 'bg-white/10 text-white/60'
        }`}>
          {event.status}
        </span>
        {verified && (
          <span
            className="px-2 py-0.5 rounded text-xs bg-sky-500/15 text-sky-200 border border-sky-400/20"
            title="The mandate contract emitted an event for this transaction — it can be checked without trusting this page"
          >
            on-chain
          </span>
        )}
      </span>
      <span className="text-xs text-white/40">{new Date(event.at).toLocaleString('en-US')}</span>
    </div>
    <p className="mt-1 text-white/80">
      {/* `amount` is a figure for a payment and a sentence for an exit — the exit rule writes
          its own trigger there. Appending "USDC arrived" to the second kind produced lines like
          "0.0235 USDC ≥ 0.0235 USDC USDC arrived", which reads as a payment that never happened.
          `from` already tells them apart. */}
      {event.source === 'chain'
        ? <>{event.amount} USDC spent under your mandate</>
        : event.from === 'exit rule'
          ? <>Sell target reached — {event.amount}</>
          : event.from === 'manual exit'
            // A refused exit is still a manual one, so `from` alone had it announcing a sale
            // above the sentence explaining that nothing was sold.
            ? event.status === 'executed'
              ? <>Sold by hand — {event.amount}</>
              : <>Demo exit checked — {event.amount}</>
            : event.from === 'manual sale'
              ? <>Sold {event.amount} by hand</>
              : <>{event.amount} USDC arrived</>}
      {!event.legs && event.status === 'executed' && <> → swapped {event.swapped} USDC for {event.received} {event.targetSymbol ?? 'XLM'}</>}
      {event.reason && <span className="text-white/50"> · {event.reason}</span>}
    </p>
    {event.legs && (
      <ul className="mt-1 space-y-0.5">
        {event.legs.map((leg, index) => (
          <li key={index} className="text-xs text-white/70 flex flex-wrap items-center gap-2">
            <span>
              {leg.fixedAmount ? `${leg.fixedAmount} USDC` : `${leg.percent}%`} → {leg.txHash ? `${leg.received} ${leg.symbol}` : `${leg.symbol}: ${leg.error}`}
            </span>
            {leg.requested && leg.swapped && (
              <span className="text-amber-300/80">
                capped at {automation.prettyAmount(leg.swapped)} of{' '}
                {automation.prettyAmount(leg.requested)} USDC by the mandate window ·{' '}
                {automation.unspentUsdc(leg.requested, leg.swapped)} USDC stayed in your wallet
              </span>
            )}
            {leg.txHash && (
              <a
                className="text-blue-300 hover:text-blue-200 underline"
                href={`https://stellar.expert/explorer/testnet/tx/${leg.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                tx ↗
              </a>
            )}
          </li>
        ))}
      </ul>
    )}
    {!event.legs && event.txHash && (
      <a
        className="text-xs text-blue-300 hover:text-blue-200 underline"
        href={`https://stellar.expert/explorer/testnet/tx/${event.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        view transaction ↗
      </a>
    )}
  </li>
);

// Groups events by day, ISO week (Monday start), or month — newest group first, since `events`
// itself is always newest-first.
const groupEvents = (events: automation.AutomationEvent[], by: 'day' | 'week' | 'month'): [string, automation.AutomationEvent[]][] => {
  const groups = new Map<string, automation.AutomationEvent[]>();
  for (const event of events) {
    const date = new Date(event.at);
    let key: string;
    if (by === 'month') {
      key = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    } else if (by === 'week') {
      const monday = new Date(date);
      const shift = (monday.getDay() === 0 ? -6 : 1) - monday.getDay();
      monday.setDate(monday.getDate() + shift);
      key = `Week of ${monday.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;
    } else {
      key = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(event);
  }
  return [...groups.entries()];
};

// SEP-38 names assets as "iso4217:TRY" or "stellar:USDC:G…". Only the code belongs on screen.
const assetLabel = (asset?: string | null): string => {
  if (!asset) return '';
  if (asset.startsWith('iso4217:')) return asset.slice('iso4217:'.length);
  return asset.split(':')[1] ?? asset;
};

// Stellar and the anchor pad amounts to 7 decimals, so a round 5 comes back as "5.0000000" and
// reads like a measurement rather than the number that was typed. Trimming is string work, so the
// value stays exact — no float ever touches it.
const trimAmount = (amount?: string | null): string => {
  if (!amount) return '';
  if (!amount.includes('.')) return amount;
  return amount.replace(/\.?0+$/, '') || '0';
};

// SEP-38 quotes price the SELL asset per unit of the BUY asset. On a withdrawal the sell side is
// USDC, so total_price reads "0.0206 USDC per lira" — inverting it is what makes it a lira rate.
const tryPerUsdc = (totalPrice: string): number | null => {
  const price = Number(totalPrice);
  return price > 0 ? 1 / price : null;
};

// Money someone is deciding about, not a ledger entry. Seven decimals on a quarter of a dollar
// reads as machine output; the floor stops a real cost from rendering as a reassuring 0.00.
const usdcCost = (stroops: bigint): string => {
  const value = Number(stroops) / 1e7;
  return value > 0 && value < 0.01 ? '<0.01' : value.toFixed(2);
};

const Field = ({ label, value, copyable = false }: { label: string; value: string; copyable?: boolean }) => (
  <div className="flex items-start justify-between gap-3 py-2 border-b border-white/10 last:border-0">
    <span className="text-xs uppercase tracking-wide text-white/50 mt-1">{label}</span>
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-mono text-sm text-white break-all text-right">{value}</span>
      {copyable && (
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(value)}
          className="shrink-0 text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/80"
        >
          copy
        </button>
      )}
    </div>
  </div>
);

export default function AnchorPage() {
  const {
    isConnected, publicKey, connect, disconnect, signTransaction,
    passkeyAvailable, passkeyKnown, usingPasskey, passkeyUntil, connectPasskey,
  } = useWallet();

  const [info, setInfo] = useState<AnchorInfo | null>(null);
  const [jwt, setJwt] = useState<string>('');
  const [balances, setBalances] = useState<{ hasTrustline: boolean; balance: string; xlmBalance: string } | null>(null);

  const [tryAmount, setTryAmount] = useState('');
  const [quote, setQuote] = useState<AnchorQuote | null>(null);
  const [deposit, setDeposit] = useState<DepositStart | null>(null);
  const [depositTx, setDepositTx] = useState<Sep6Transaction | null>(null);

  const [iban, setIban] = useState('');
  const ibanError = getTryIbanError(iban);
  // The bank checks the payout name against the IBAN, so a real TRY transfer needs both. This
  // sandbox marks the name optional; collecting it anyway is what a production anchor will want.
  const [holderFirstName, setHolderFirstName] = useState('');
  const [holderLastName, setHolderLastName] = useState('');
  const [customerStatus, setCustomerStatus] = useState<string>('');
  const [customerMissing, setCustomerMissing] = useState<string[]>([]);
  // Off by default: payout details are re-entered each time unless the user opts in.
  const [rememberPayout, setRememberPayout] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdraw, setWithdraw] = useState<WithdrawStart | null>(null);
  const [withdrawTx, setWithdrawTx] = useState<Sep6Transaction | null>(null);
  // The rate this withdrawal is settled against, locked before any USDC leaves the wallet.
  // Without it the anchor prices the payout when it settles and the lira figure on screen is a
  // guess; with it, what the receipt shows is what the bank pays.
  const [withdrawQuote, setWithdrawQuote] = useState<AnchorQuote | null>(null);
  // Drives the countdown on that lock. A quote is single-use and expires within the hour.
  const [quoteClock, setQuoteClock] = useState(() => Date.now());
  // The rate is fetched as the amount is typed, so it has its own progress and failure state:
  // an amount the anchor will not price is a normal answer here, not an error worth a red banner.
  const [withdrawQuoting, setWithdrawQuoting] = useState(false);
  const [withdrawQuoteError, setWithdrawQuoteError] = useState<string | null>(null);
  // Same, for the deposit side. The rate runs the other way there: TRY is sold, USDC bought.
  const [depositQuoting, setDepositQuoting] = useState(false);
  const [depositQuoteError, setDepositQuoteError] = useState<string | null>(null);

  const [tab, setTab] = useState<'onramp' | 'offramp' | 'automation' | 'ai' | 'history'>('onramp');
  const [historyGroupBy, setHistoryGroupBy] = useState<'day' | 'week' | 'month'>('day');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiDraft, setAiDraft] = useState<StrategyDraft | null>(null);
  const [rule, setRule] = useState<automation.AutomationRule>(automation.DEFAULT_RULE);
  const [events, setEvents] = useState<automation.AutomationEvent[]>([]);
  const [usdTry, setUsdTry] = useState<string>('');
  const [bot, setBot] = useState<botWalletLib.BotWallet | null>(null);
  const [botBalances, setBotBalances] = useState<{ asset: string; balance: string }[]>([]);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [mandate, setMandate] = useState<mandateLib.MandateTerms | null>(null);
  const [mandateSpent, setMandateSpent] = useState<bigint | null>(null);
  // The ledger the mandate's expiry is compared against, read when the mandate is.
  const [ledgerSequence, setLedgerSequence] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<automation.SellablePosition[] | null>(null);
  const [sellAsset, setSellAsset] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  const [sellTry, setSellTry] = useState<string | null>(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  // Where the USDC for this withdrawal comes from. Both routes end in the same SEP-6 payout.
  const [withdrawSource, setWithdrawSource] = useState<'balance' | 'sell'>('balance');
  // Gates step 2 on the sell route. Selling first is the whole point of that route, so the
  // payout form stays out of the way until there is USDC to send.
  const [saleCompleted, setSaleCompleted] = useState(false);
  // Set only by "sell all anyway": the user has seen what the extra cost is and chosen it. Without
  // this the ceiling would refuse the sale, so offering the choice at all would have been a lie.
  const [acceptImpact, setAcceptImpact] = useState(false);
  // The anchor only prices withdrawals inside a band; read once so the sell tab can explain a
  // missing lira quote instead of showing a bare dash.
  const [withdrawBand, setWithdrawBand] = useState<{ min?: number; max?: number } | null>(null);
  const [chainHistory, setChainHistory] = useState<mandateLib.MandateHistory | null>(null);
  const [chainHistoryError, setChainHistoryError] = useState<string | null>(null);
  const [needTrustline, setNeedTrustline] = useState<string[]>([]);
  const [payout, setPayout] = useState<{
    usdc: string;
    try: string;
    fee?: string;
    held: string;
    symbol: string;
    unitPrice: number;
    atTarget: boolean;
    projected: boolean; // no position yet: figures come from a hypothetical minimum deposit
    seedUsdc: number;
    limit?: { min?: number; max?: number };
  } | null>(null);
  // Collapsed by default, and never remembered: a rehearsal should be asked for each time.
  const [showForceExit, setShowForceExit] = useState(false);
  const [demoSellAbove, setDemoSellAbove] = useState('');
  const [showAdvancedTelegram, setShowAdvancedTelegram] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmDeleteBot, setConfirmDeleteBot] = useState(false);
  const [approveAmount, setApproveAmount] = useState('25');
  const [approveDays, setApproveDays] = useState('1');
  const [showAdvancedSigner, setShowAdvancedSigner] = useState(false);
  const [depositJwt, setDepositJwt] = useState<string>('');
  const [prices, setPrices] = useState<PriceTable>({});
  const [pricesAt, setPricesAt] = useState<number | null>(null);
  const [exitDone, setExitDone] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: confirmations and "nothing to do" status messages are not failures and
  // should not render in the same alarming red banner.
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (caught) {
      if (caught instanceof anchor.AnchorError && caught.status && caught.status < 500) {
        console.warn(`${label}: ${caught.message}`);
      } else {
        console.error(`❌ ${label}:`, caught);
      }
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // A brand-new account is a real state, not a failed read. A passkey derives an address that
  // has never existed on chain, so the first thing it needs is a lumen for fees — and until it
  // has one, every button in the app fails on a 404 that names nothing the user can act on.
  const [unfunded, setUnfunded] = useState(false);

  const refreshBalances = useCallback(async (account: string) => {
    try {
      setBalances(await anchor.getAssetBalance(account));
      setUnfunded(false);
    } catch (caught) {
      if (caught instanceof anchor.AnchorError && caught.status === 404) {
        setBalances(null);
        setUnfunded(true);
        return;
      }
      throw caught;
    }
  }, []);

  useEffect(() => {
    anchor.getAnchorInfo().then(setInfo).catch(caught => setError((caught as Error).message));
  }, []);

  useEffect(() => {
    if (publicKey) {
      refreshBalances(publicKey).catch(caught => console.log('balance read failed:', (caught as Error).message));
    }
  }, [publicKey, refreshBalances]);

  // Rule and history are stored per wallet.
  useEffect(() => {
    if (!publicKey) return;
    setRule(automation.loadRule(publicKey));
    setEvents(automation.loadEvents(publicKey));

    // Payout details, but only if this wallet asked to be remembered.
    try {
      const saved = window.localStorage.getItem(`conduit_payout_${publicKey}`);
      if (!saved) {
        setRememberPayout(false);
        setIban('');
        setHolderFirstName('');
        setHolderLastName('');
        return;
      }
      const parsed = JSON.parse(saved) as { iban?: string; first?: string; last?: string };
      setRememberPayout(true);
      setIban(parsed.iban ?? '');
      setHolderFirstName(parsed.first ?? '');
      setHolderLastName(parsed.last ?? '');
    } catch {
      setRememberPayout(false); // unreadable storage is the same as nothing stored
    }
  }, [publicKey]);

  // A SEP-10 token belongs to the account that signed the challenge, and switching wallets left
  // it in place: the anchor would go on acting for the previous account while the header showed
  // the new one, so a deposit started that way pays out to a wallet that is no longer connected.
  // The token's own subject is the authority on who it is for.
  useEffect(() => {
    if (jwt && anchor.getJwtAccount(jwt) !== publicKey) {
      setJwt('');
      setQuote(null);
      setDeposit(null);
      setDepositTx(null);
      setWithdraw(null);
      setWithdrawTx(null);
      setWithdrawQuote(null); // the quote is bound to the account that authenticated for it
      setCustomerStatus('');
    }
  }, [publicKey, jwt]);

  // Everything read on chain for the previous account. Blanking it is better than showing the
  // old wallet's mandate and balances until the refreshes land.
  useEffect(() => {
    setBalances(null);
    setAllowance(null);
    setMandate(null);
    setMandateSpent(null);
    setChainHistory(null);
    setChainHistoryError(null);
    setPayout(null);
  }, [publicKey]);

  // Passed via a ref so the watcher reads the latest rule on every tick
  const ruleRef = useRef(rule);
  useEffect(() => {
    ruleRef.current = rule;
  }, [rule]);

  // Accepts a plain patch, or an updater function for callers (like the long-lived watcher's
  // onEvent) that must not merge against a stale closed-over `rule`.
  const updateRule = useCallback((
    patch: Partial<automation.AutomationRule> | ((current: automation.AutomationRule) => Partial<automation.AutomationRule>)
  ) => {
    setRule(current => {
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
      if (publicKey) automation.saveRule(publicKey, next);
      return next;
    });
  }, [publicKey]);

  // The anchor holds the payment in pending_trust until the destination has a USDC trustline
  const ensureDepositTrustline = async () => {
    if (useBot && bot) {
      await anchor.ensureTrustline(bot.publicKey, botWalletLib.botSigner(bot));
      await refreshBotBalances(bot.publicKey);
    } else {
      await anchor.ensureTrustline(publicKey, signTransaction);
      await refreshBalances(publicKey);
    }
  };

  const updateAllocation = (index: number, patch: Partial<automation.AutomationAllocation>) => {
    updateRule({
      allocations: rule.allocations.map((allocation, current) => (current === index ? { ...allocation, ...patch } : allocation)),
    });
    // Choosing an asset is the one moment the user is definitely at the screen, so its trustline is
    // opened right there rather than failing on a deposit that arrives days later.
    if (patch.asset) void autoOpenTrustline(patch.asset);
  };

  const allocationTotal = automation.totalPercent(rule);
  const fixedTotal = automation.totalFixed(rule);
  // Raised when "add row" is pressed with the payment already fully allocated. It is not stored
  // as a condition, only as "they asked" — the rendering pairs it with the live total, so it
  // clears itself the moment a share is lowered.
  const [rowLimitAsked, setRowLimitAsked] = useState(false);

  // Reference prices: USDC from pool reserves, TRY from the anchor rate, EURC via USDC.
  // Re-read on a timer so the table tracks the pools the rule is actually trading against; the whole
  // sweep costs well under a second because every reserve read runs in parallel.
  useEffect(() => {
    if (tab !== 'automation' || !info) return;
    const issuer = info.currencies.find(currency => currency.code === 'USDC')?.issuer;
    let stopped = false;

    const read = async () => {
      // A backgrounded tab has nobody reading the numbers
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const table = await getAssetPrices(ASSET_OPTIONS.map(asset => asset.value));
        if (stopped) return;
        setPrices(table);
        setPricesAt(Date.now());
      } catch (caught) {
        console.log('price fetch failed:', (caught as Error).message);
      }
      if (!issuer || stopped) return;
      try {
        const price = await anchor.getIndicativePrice(
          anchor.stellarAssetId('USDC', issuer),
          ANCHOR_CONFIG.FIAT_ASSET,
          '1'
        );
        if (!stopped) setUsdTry(price.buyAmount);
      } catch (caught) {
        console.log('rate fetch failed:', (caught as Error).message);
      }
    };

    void read();
    const timer = setInterval(read, PRICE_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [tab, info]);

  useEffect(() => {
    if (!publicKey) return;
    // Reading the key is async now: a non-extractable key lives in IndexedDB rather than in a
    // string that can be pulled out of localStorage synchronously.
    let cancelled = false;
    botWalletLib
      .loadBotWallet(publicKey)
      .then(wallet => {
        if (!cancelled) setBot(wallet);
      })
      .catch(caught => console.log('automation wallet:', (caught as Error).message));
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const refreshBotBalances = useCallback(async (botKey: string) => {
    setBotBalances(await botWalletLib.getBotBalances(botKey));
  }, []);

  useEffect(() => {
    if (bot) refreshBotBalances(bot.publicKey).catch(caught => console.log('bot balance:', (caught as Error).message));
  }, [bot, refreshBotBalances]);

  // Bot mode signs without a popup. Two shapes:
  //   delegated  — the funds stay in the user's wallet and the bot pulls each swap's input
  //                within the allowance the user signed; the watched account stays the user's.
  //   funded     — the money is moved into the bot wallet, which is then both holder and signer.
  const useBot = rule.signer === 'bot' && !!bot;
  // The mandate covers portfolio mode only.
  //
  // Buy & sell needs two legs, and the second one pulls the asset rather than USDC — a second
  // allowance, a price bound that has to be re-signed every time the target moves, and a band
  // between the pool's spot price and the fill where the rule fires and the contract refuses.
  // Portfolio mode has none of that: one leg, one asset, no price condition. So the guarantee is
  // kept where it holds cleanly, and buy & sell runs the funded shape instead — the automation
  // wallet holds its own budget and signs for itself, with no on-chain limit behind it.
  const mandateApplies = rule.mode !== 'trade';
  /** The shape that holds its own balance and signs its own swaps. Trading only. */
  const fundedBot = rule.signer === 'bot' && !rule.delegated;
  const delegated = useBot && rule.delegated && mandateApplies;
  const automationAccount = useBot && bot && !delegated ? bot.publicKey : publicKey;
  const automationSigner = useBot && bot ? botWalletLib.botSigner(bot) : signTransaction;
  const spender = delegated && bot ? bot.publicKey : undefined;
  // A mandate that exists but has run out. The contract enforces this at execution time (#101),
  // which is too late to be useful: by then the user has approved a wallet prompt and believes
  // the trade is running. Checked here so it can be said before anything is signed.
  const mandateExpired = !!mandate && ledgerSequence !== null && mandate.expirationLedger <= ledgerSequence;


  // SEP-10 token for the off-ramp step. Delegated mode cashes out of the user's own wallet,
  // so only the funded shape authenticates as the bot.
  const authenticateForAutomation = useCallback(async () => {
    if (useBot && bot && !delegated) return anchor.authenticate(bot.publicKey, botWalletLib.botSigner(bot));
    return anchor.authenticate(publicKey, signTransaction);
  }, [useBot, bot, delegated, publicKey, signTransaction]);

  // Delegated mode grants the allowance to the mandate contract, never to the automation wallet,
  // so this is what the contract may still pull on the owner's behalf. Reads back 0 once it expires.
  const refreshAllowance = useCallback(async () => {
    if (!publicKey || !bot) {
      setAllowance(null);
      setMandate(null);
      setMandateSpent(null);
      return;
    }
    const remaining = await allowanceLib.getAllowance(publicKey, MANDATE_CONFIG.CONTRACT, SOROSWAP_ROUTER_CONFIG.USDC);
    setAllowance(remaining);

    // The mandate is the rule itself, on chain. Without one the contract refuses every call,
    // so the UI reads it back rather than assuming the last write stuck.
    const terms = await mandateLib.getMandate(publicKey);
    setMandate(terms);
    setMandateSpent(terms ? await mandateLib.getSpent(publicKey) : null);
    // Read alongside the terms: an expiry means nothing without the ledger it is measured against.
    setLedgerSequence(terms ? await mandateLib.getLedgerSequence().catch(() => null) : null);
  }, [publicKey, bot]);

  useEffect(() => {
    if (delegated) refreshAllowance().catch(caught => console.log('allowance:', (caught as Error).message));
  }, [delegated, refreshAllowance]);

  // The contract's own account of what it did. Read on demand rather than on a timer: it is a
  // handful of RPC round trips, and the history tab is the only place it is shown.
  const refreshChainHistory = useCallback(async () => {
    if (!publicKey) return;
    try {
      setChainHistory(await mandateLib.fetchMandateHistory(publicKey));
      setChainHistoryError(null);
    } catch (caught) {
      setChainHistoryError((caught as Error).message);
    }
  }, [publicKey]);

  // The mandate mirrors the rule the user already filled in: the assets it names, the price
  // bounds it sets, and the limit typed below. Nothing is asked for twice.
  const mandateAssets = (rule.mode === 'trade' ? [rule.trade.asset] : rule.allocations.map(row => row.asset))
    .filter((asset, index, all) => asset && all.indexOf(asset) === index && asset !== SOROSWAP_ROUTER_CONFIG.USDC);

  // Puts the rule that is currently in the form on chain. Two signatures: the allowance to the
  // contract, then the mandate that tells it what may be done with that allowance.
  // Registers the TRY payout details, then reads the status back scoped to the withdrawal flow —
  // the bare status can say ACCEPTED while the withdrawal itself still wants more.
  // Writes the payout details to this browser, or clears them. Opt-in only: the IBAN and the
  // account holder's name are personal, so they are never stored without being asked for.
  const persistPayout = useCallback((remember: boolean) => {
    if (!publicKey) return;
    const key = `conduit_payout_${publicKey}`;
    try {
      if (remember) {
        window.localStorage.setItem(key, JSON.stringify({ iban, first: holderFirstName, last: holderLastName }));
      } else {
        window.localStorage.removeItem(key);
      }
    } catch (caught) {
      console.log('payout details storage:', (caught as Error).message);
    }
  }, [publicKey, iban, holderFirstName, holderLastName]);

  const savePayoutDetails = useCallback(async (token: string) => {
    const validationError = getTryIbanError(iban);
    if (validationError) throw new anchor.AnchorError(validationError, 400, 'invalid_iban');
    setCustomerStatus('');
    setCustomerMissing([]);
    await anchor.putCustomer(
      token,
      {
        bank_account_number: iban,
        ...(holderFirstName.trim() ? { first_name: holderFirstName.trim() } : {}),
        ...(holderLastName.trim() ? { last_name: holderLastName.trim() } : {}),
      },
      { type: anchor.WITHDRAW_CUSTOMER_TYPE }
    );
    const status = await anchor.getCustomer(token, { type: anchor.WITHDRAW_CUSTOMER_TYPE });
    setCustomerStatus(status.status);
    setCustomerMissing(anchor.missingCustomerFields(status));
    persistPayout(rememberPayout);
  }, [iban, holderFirstName, holderLastName, persistPayout, rememberPayout]);

  // The connected wallet's own holdings. Deliberately not the automation account: this step is the
  // owner selling by hand, so it reads from, and sells out of, the wallet whose key is about to
  // sign. Following the rule's signer here would show one account's balances and sign with
  // another's key, and would tie a hand-pressed button to an unattended-automation grant.
  const loadHoldings = useCallback(async () => {
    if (!publicKey) return;
    setHoldingsLoading(true);
    let rows: automation.SellablePosition[];
    try {
      rows = await automation.sellableHoldings(publicKey, TRADABLE_ASSETS, {
        maxPriceImpact: rule.maxPriceImpact,
      });
    } finally {
      setHoldingsLoading(false);
    }
    setHoldings(rows);
    // Pre-select the largest sellable holding so the common case is one click.
    const best = rows
      .filter(row => row.usdc && !row.blocked)
      .sort((a, b) => Number((b.usdc ?? BigInt(0)) - (a.usdc ?? BigInt(0))))[0];
    if (best && !sellAsset) {
      setSellAsset(best.asset);
      setSellAmount(allowanceLib.fromStroops(best.amount));
    }
  }, [publicKey, rule.maxPriceImpact, sellAsset]);

  const selectedHolding = holdings?.find(row => row.asset === sellAsset) ?? null;

  // Which steps are open. Holding USDC already means there is nothing to sell, so that route
  // starts at the payout details.
  const sellStepDone = withdrawSource === 'balance' || saleCompleted;
  const payoutStepDone = sellStepDone && customerStatus === 'ACCEPTED';

  // A quote binds one exact amount: the anchor rejects a withdraw-exchange whose amount differs
  // from the quote's sell_amount, so once a rate is held its own figure is what gets sent.
  const withdrawSendAmount = withdrawQuote?.sellAmount ?? withdrawAmount;
  const withdrawQuoteExpired = withdrawQuote ? withdrawQuote.expiresAt.getTime() <= quoteClock : false;

  const depositSendAmount = quote?.sellAmount ?? tryAmount;
  const depositQuoteExpired = quote ? quote.expiresAt.getTime() <= quoteClock : false;
  // A quote is bound to the account that authenticated for it. The bot-funded deposit pays the
  // automation wallet, which does its own SEP-10 login, so this user's quote cannot ride along —
  // that shape converts at the live rate and the figures here are an estimate, not a promise.
  const depositQuoteBinds = !(useBot && !delegated);

  // Only the rows that would actually sell. Counting the ones the price-impact ceiling blocks
  // would put a number on screen that no button can deliver.
  const sellableRows = holdings?.filter(row => row.usdc && !row.blocked) ?? [];
  const sellableTotal = sellableRows.reduce((sum, row) => sum + (row.usdc ?? BigInt(0)), BigInt(0));

  // Read as soon as the withdraw tab opens, so the summary is on the header before anyone asks.
  useEffect(() => {
    if (tab !== 'offramp' || withdrawSource !== 'sell' || !jwt || !publicKey || holdings !== null || holdingsLoading) return;
    loadHoldings().catch(caught => console.log('holdings:', (caught as Error).message));
  }, [tab, withdrawSource, jwt, publicKey, holdings, holdingsLoading, loadHoldings]);

  // Proceeds of the sale as the pool would price it right now, scaled to the amount being sold.
  const sellProceeds = (() => {
    if (!selectedHolding?.usdc || selectedHolding.amount <= BigInt(0)) return null;
    const amount = allowanceLib.toStroops(sellAmount || '0');
    if (amount <= BigInt(0)) return null;
    return (selectedHolding.usdc * amount) / selectedHolding.amount;
  })();

  // The lira side comes from the anchor's own SEP-38 rate, not from a price feed — it is the
  // number the withdrawal will actually be settled against.
  useEffect(() => {
    if (!jwt || !info || sellProceeds === null || sellProceeds <= BigInt(0)) {
      setSellTry(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const issuer = info.currencies.find(currency => currency.code === 'USDC')?.issuer ?? '';
        const price = await anchor.getIndicativePrice(
          anchor.stellarAssetId('USDC', issuer),
          ANCHOR_CONFIG.FIAT_ASSET,
          Number(allowanceLib.fromStroops(sellProceeds)).toFixed(7)
        );
        if (!cancelled) setSellTry(price.buyAmount);
      } catch {
        if (!cancelled) setSellTry(null); // outside the anchor's band, or it declined to quote
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jwt, info, sellProceeds]);

  useEffect(() => {
    if (!jwt || withdrawBand) return;
    anchor
      .getInfo(jwt)
      .then(sep6 => setWithdrawBand({
        min: sep6.withdraw?.USDC?.min_amount,
        max: sep6.withdraw?.USDC?.max_amount,
      }))
      .catch(() => undefined); // only used to phrase a message; not worth surfacing
  }, [jwt, withdrawBand]);

  // Ticks only while a rate is held, so the countdown is live without polling the rest of the time.
  useEffect(() => {
    if (!withdrawQuote && !quote) return;
    const timer = setInterval(() => setQuoteClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [withdrawQuote, quote]);

  // The rate is what the amount is being decided against, so it arrives with the amount rather
  // than behind a button. Debounced: typing "50" passes through "5" on the way, and a quote is
  // single-use — one per keystroke would burn a row of them at the anchor for nothing.
  useEffect(() => {
    // already opened against a locked rate; re-pricing now would contradict it
    const issuer = info?.currencies.find(currency => currency.code === 'USDC')?.issuer;
    const idle = tab !== 'offramp' || !payoutStepDone || !jwt || !issuer || !!withdraw;
    const amount = withdrawAmount.trim();
    if (idle || !amount || !(Number(amount) > 0)) {
      setWithdrawQuoting(false);
      if (!idle) {
        setWithdrawQuote(null);
        setWithdrawQuoteError(null);
      }
      return;
    }
    let cancelled = false;
    setWithdrawQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const fresh = await anchor.getQuote(
          jwt, anchor.stellarAssetId('USDC', issuer!), ANCHOR_CONFIG.FIAT_ASSET, amount
        );
        if (cancelled) return;
        setWithdrawQuote(fresh);
        setWithdrawQuoteError(null);
      } catch (caught) {
        if (cancelled) return;
        // Outside the anchor's band is the usual reason, and it says so better than /info does.
        setWithdrawQuote(null);
        setWithdrawQuoteError((caught as Error).message);
      } finally {
        if (!cancelled) setWithdrawQuoting(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tab, payoutStepDone, jwt, info, withdrawAmount, withdraw]);

  // The deposit side, priced the other way round: lira are sold, USDC bought. Same debounce, same
  // reason — a quote is single-use, and an amount is typed one digit at a time.
  useEffect(() => {
    const issuer = info?.currencies.find(currency => currency.code === 'USDC')?.issuer;
    // Once the bank details are on screen the order is placed; re-pricing it would show a rate
    // that the transfer already on its way will not get.
    const idle = tab !== 'onramp' || !jwt || !issuer || !!deposit;
    const amount = tryAmount.trim();
    if (idle || !amount || !(Number(amount) > 0)) {
      setDepositQuoting(false);
      if (!idle) {
        setQuote(null);
        setDepositQuoteError(null);
      }
      return;
    }
    let cancelled = false;
    setDepositQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const fresh = await anchor.getQuote(
          jwt, ANCHOR_CONFIG.FIAT_ASSET, anchor.stellarAssetId('USDC', issuer!), amount
        );
        if (cancelled) return;
        setQuote(fresh);
        setDepositQuoteError(null);
      } catch (caught) {
        if (cancelled) return;
        setQuote(null);
        setDepositQuoteError((caught as Error).message);
      } finally {
        if (!cancelled) setDepositQuoting(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tab, jwt, info, tryAmount, deposit]);

  // Only when the user asked to be remembered. Reading the anchor's status unprompted made the
  // form show "ACCEPTED" for details this session never entered, which is worse than an extra
  // click: it hides which account the lira is actually going to.
  useEffect(() => {
    if (tab !== 'offramp' || !jwt || customerStatus || !rememberPayout) return;
    anchor
      .getCustomer(jwt, { type: anchor.WITHDRAW_CUSTOMER_TYPE })
      .then(status => {
        setCustomerStatus(status.status);
        setCustomerMissing(anchor.missingCustomerFields(status));
      })
      .catch(() => undefined); // not being registered yet is the normal case, not an error
  }, [tab, jwt, customerStatus, rememberPayout]);

  // Switching routes starts the wizard over: the sell step is only "done" on the balance route.
  useEffect(() => {
    setSaleCompleted(false);
  }, [withdrawSource]);

  // Back to a clean slate so the next withdrawal does not inherit half of the last one.
  const startAnotherWithdrawal = useCallback(() => {
    setWithdraw(null);
    setWithdrawTx(null);
    setWithdrawAmount('');
    setWithdrawQuote(null); // a quote is single-use; the next withdrawal locks its own rate
    setSellAmount('');
    setSaleCompleted(false);
    setHoldings(null); // re-read: the balances just changed
    setNotice('');
    // Unless the user asked to be remembered, the next withdrawal confirms the payout account
    // again rather than inheriting a tick from the last one.
    if (!rememberPayout) {
      setCustomerStatus('');
      setCustomerMissing([]);
    }
  }, [rememberPayout]);

  // A one-off sale the owner triggers, kept separate from the automation rule on purpose: the
  // owner's own wallet signs it, out of the owner's own account, whatever signer mode the rule is
  // set to. No spender and no mandate — those exist so the automation wallet can trade unattended,
  // and making a hand-pressed button depend on that grant meant it failed on the grant (expired
  // mandate, spent allowance) rather than on anything about the sale.
  const runSell = useCallback(async () => {
    if (!publicKey || !sellAsset) return;
    const event = await automation.sellForUsdc({
      account: publicKey,
      asset: sellAsset,
      amount: allowanceLib.toStroops(sellAmount || '0'),
      maxPriceImpact: acceptImpact ? undefined : rule.maxPriceImpact,
      // No spender: see above. Routing this through the mandate was right while buy & sell ran
      // on it — the exit needed an allowance on the asset, and the setup granted one. The mandate
      // now backs portfolio mode only, which never sells, so that allowance is no longer granted
      // and a sale sent to the contract fails on a permission nobody has any reason to hold.
      signTransaction,
      onEvent: event => setEvents(previous => [event, ...previous].slice(0, 200)),
    });
    if (event.status === 'executed') {
      // Hand the proceeds straight to the off-ramp step instead of making the user retype them.
      setWithdrawAmount(event.amount);
      setSaleCompleted(true);
      setNotice(`Sold for ${event.amount} USDC — it is in your wallet. Fill in your payout details next.`);
    } else {
      setNotice(event.reason ?? 'Nothing was sold.');
    }
    await loadHoldings();
    await refreshBalances(publicKey);
  }, [publicKey, sellAsset, sellAmount, rule.maxPriceImpact, acceptImpact, signTransaction, loadHoldings, refreshBalances]);

  const signMandate = useCallback(async () => {
    if (!publicKey || !bot) throw new Error('Connect a wallet and create an automation wallet first.');
    const days = Math.max(1, Number(approveDays) || 1);

    // Every supported asset, always. Naming only the rule's current asset was stricter, but it
    // meant a fresh pair of signatures each time the rule changed — which trains people to sign
    // without reading, and that costs more safety than the narrower scope bought. What actually
    // bounds the risk stays: the daily cap, the price bounds, the expiry and the allowance.
    const assets = TRADABLE_ASSETS;

    const ttlLedgers = days * allowanceLib.LEDGERS_PER_DAY;

    const { expirationLedger } = await allowanceLib.approveSpender({
      owner: publicKey,
      spender: MANDATE_CONFIG.CONTRACT,
      contract: SOROSWAP_ROUTER_CONFIG.USDC,
      amount: approveAmount,
      ttlLedgers,
      signTransaction,
    });

    // No second approval here: the mandate covers portfolio mode, whose rules only ever spend
    // USDC. The sell leg that needed an allowance on the asset itself belongs to buy & sell,
    // which no longer runs through the contract.

    try {
      await mandateLib.setMandate(
        publicKey,
        {
          delegate: bot.publicKey,
          assets,
          capPerWindow: allowanceLib.toStroops(approveAmount),
          windowLedgers: MANDATE_CONFIG.DEFAULT_WINDOW_LEDGERS,
          // Zero is "no bound", which is what a portfolio rule wants: it converts an arriving
          // payment at whatever the pool offers and has no price condition to enforce. The
          // contract's fields stay for the price-conditional mode they were built for.
          buyBelow: BigInt(0),
          sellAbove: BigInt(0),
          expirationLedger,
        },
        signTransaction
      );
    } catch (error) {
      // The first signature landed and the second did not, so the allowance now points at a
      // mandate that was never updated. Say exactly that — otherwise the panel just keeps
      // showing the old rule and looks like it ignored the change.
      throw new Error(
        `The allowances were set, but the mandate was not updated: ${(error as Error).message}. ` +
          'Press Approve again — the old mandate is still what the contract enforces.'
      );
    } finally {
      // Always re-read: after a half-finished setup the panel must show what is really on chain.
      await refreshAllowance().catch(() => undefined);
    }

    setNotice(`Mandate signed: up to ${approveAmount} USDC per day, expires at ledger ${expirationLedger}`);
  }, [publicKey, bot, approveAmount, approveDays, signTransaction, refreshAllowance]);

  // Where the form and the chain disagree. Editing the rule is free; changing the mandate costs
  // a signature, so the two drift apart the moment the user picks a different asset or threshold.
  const uncoveredAssets = mandate ? mandateAssets.filter(asset => !mandate.assets.includes(asset)) : [];
  // Price drift is not checked here any more: the mandate only backs portfolio mode, which has
  // no price condition to disagree about. What can still drift is the asset list — a rule can
  // name an asset the signed mandate does not cover, and the contract refuses that outright.
  // A stable key, so editing a percentage does not re-trigger the on-chain check
  const targetKey = (rule.mode === 'trade' ? [rule.trade.asset] : rule.allocations.map(allocation => allocation.asset))
    .filter(Boolean)
    .join(',');

  // Which of the rule's target assets the receiving account cannot hold yet
  const refreshTrustlineStatus = useCallback(async () => {
    if (!automationAccount || !targetKey) {
      setNeedTrustline([]);
      return;
    }
    setNeedTrustline(await missingTrustlines(automationAccount, targetKey.split(',')));
  }, [automationAccount, targetKey]);

  useEffect(() => {
    refreshTrustlineStatus().catch(caught => console.log('trustline check:', (caught as Error).message));
  }, [refreshTrustlineStatus]);

  // Opens one trustline as soon as the asset is picked. Only for the user's own wallet: in funded
  // bot mode the automation wallet opens its own at run time.
  const autoOpenTrustline = useCallback(async (asset: string) => {
    if (!publicKey || automationAccount !== publicKey) return;
    const symbol = ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token';
    try {
      if ((await missingTrustlines(publicKey, [asset])).length === 0) return;
      setNotice(`${symbol} needs a trustline — approve it in your wallet.`);
      await ensureTokenTrustline(publicKey, asset, signTransaction);
      await refreshBalances(publicKey);
      await refreshTrustlineStatus();
      setNotice(`${symbol} trustline opened.`);
    } catch (caught) {
      setError(`${symbol} trustline could not be opened: ${(caught as Error).message}`);
    }
  }, [publicKey, automationAccount, signTransaction, refreshBalances, refreshTrustlineStatus]);

  // Delegated mode cannot open trustlines on the owner's behalf, so the owner opens them here in
  // one go rather than discovering one missing asset per deposit.
  const addMissingTrustlines = useCallback(async () => {
    const targets = rule.mode === 'trade' ? [rule.trade.asset] : rule.allocations.map(allocation => allocation.asset);
    const opened: string[] = [];
    for (const asset of targets.filter(Boolean)) {
      const result = await ensureTokenTrustline(publicKey, asset, signTransaction);
      if (result.created) opened.push(ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token');
    }
    await refreshBalances(publicKey);
    await refreshTrustlineStatus();
    setNotice(opened.length ? `Trustlines opened: ${opened.join(', ')}` : 'Every target asset is already trusted.');
  }, [rule, publicKey, signTransaction, refreshBalances, refreshTrustlineStatus]);

  // Same as above, but for whichever account is actually running the rule (owner's wallet or the
  // bot's own wallet in funded mode) — used to open trustlines automatically before starting, so a
  // swap never fails on a missing trustline the user forgot to open.
  const ensureAutomationTrustlines = useCallback(async () => {
    if (!automationAccount) return;
    const targets = rule.mode === 'trade' ? [rule.trade.asset] : rule.allocations.map(allocation => allocation.asset);
    for (const asset of targets.filter(Boolean)) {
      await ensureTokenTrustline(automationAccount, asset, automationSigner);
    }
    if (useBot && bot) await refreshBotBalances(bot.publicKey);
    else await refreshBalances(publicKey);
    await refreshTrustlineStatus();
  }, [rule, automationAccount, automationSigner, useBot, bot, refreshBotBalances, refreshBalances, publicKey, refreshTrustlineStatus]);

  // Read through a ref: the payout estimate should recompute when the rule changes, not every time
  // the 20-second price sweep hands back a new object.
  const pricesRef = useRef(prices);
  useEffect(() => {
    pricesRef.current = prices;
  }, [prices]);

  // Only the inputs that change the answer, so typing a percentage does not re-quote the anchor
  const payoutKey = rule.mode === 'trade' && rule.trade.offramp && rule.trade.asset
    ? `${rule.trade.asset}|${rule.trade.sellPercent}|${rule.trade.sellAboveUsdc}|${rule.minAmount}|${rule.trade.buyPercent}`
    : '';

  // What the off-ramp would actually pay into the IBAN. The projected sale proceeds are run through
  // the anchor's live SEP-38 price, so its spread and fee are already inside the number.
  const refreshPayout = useCallback(async () => {
    const issuer = info?.currencies.find(currency => currency.code === 'USDC')?.issuer;
    if (!payoutKey || !automationAccount || !issuer) {
      setPayout(null);
      return;
    }
    const [asset, percent, target, minAmount, buyPercent] = payoutKey.split('|');
    const atTarget = Number(target) > 0;
    const unitPrice = atTarget ? Number(target) : pricesRef.current[asset]?.usdc || 0;

    // The same figure the exit itself would sell: the position this rule opened, capped by what the
    // wallet can actually part with. Not the whole balance — that would include coins it never bought.
    const position = automation.loadPosition(automationAccount, asset);
    const spendable = await automation.sellableBalance(automationAccount, asset);
    let held = Number(position < spendable ? position : spendable) / 1e7;

    // Nothing bought yet: project from the smallest deposit the rule would act on, so the estimate is
    // useful while the rule is still being set up instead of staying blank until the first buy.
    const seedUsdc = Number(minAmount || '0') * (Number(buyPercent) / 100);
    const projected = !(held > 0) && seedUsdc > 0;
    if (projected) {
      const config = (ASSET_CONFIGS as Record<string, { maxHops: number; slippageBps: number }>)[
        ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? ''
      ] ?? DEFAULT_ASSET_CONFIG;
      const quote = await soroswapAPI.getQuote({
        assetIn: SOROSWAP_ROUTER_CONFIG.USDC,
        assetOut: asset,
        amount: Math.round(seedUsdc * 1e7).toString(),
        tradeType: 'EXACT_IN',
        protocols: ['soroswap'],
        slippageBps: config.slippageBps,
        parts: 1,
        maxHops: config.maxHops,
      });
      held = Number(quote.amountOut) / 1e7;
    }

    const proceeds = held * (Number(percent) / 100) * unitPrice;
    if (!(proceeds > 0)) {
      setPayout(null);
      return;
    }

    const amount = proceeds.toFixed(7);
    const symbol = ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token';
    const limit = (await anchor.getInfo().catch(() => null))?.withdraw?.USDC;

    // Asking the anchor to price an amount it would refuse only returns an error, so quote inside the band
    const withinBand = Math.min(Math.max(proceeds, limit?.min_amount ?? 0), limit?.max_amount ?? proceeds);
    const price = await anchor.getIndicativePrice(
      anchor.stellarAssetId('USDC', issuer),
      ANCHOR_CONFIG.FIAT_ASSET,
      withinBand.toFixed(7)
    );

    setPayout({
      usdc: amount,
      try: price.buyAmount,
      fee: price.fee?.total,
      held: held.toFixed(4),
      symbol,
      unitPrice,
      atTarget,
      projected,
      seedUsdc,
      limit: { min: limit?.min_amount, max: limit?.max_amount },
    });
  }, [payoutKey, automationAccount, info]);

  useEffect(() => {
    const timer = setTimeout(
      () => refreshPayout().catch(caught => console.log('payout estimate:', (caught as Error).message)),
      400
    );
    return () => clearTimeout(timer);
  }, [refreshPayout]);

  // Pausing only stops this watcher — there's no exchange order to cancel (Soroswap is an AMM, not
  // an order book). If a sell target is still being watched for a held position, ask first instead of
  // silently leaving it unmonitored.
  const requestPause = () => {
    const asset = rule.mode === 'trade' ? rule.trade.asset : '';
    const hasOpenSellTarget = rule.mode === 'trade' && !!rule.trade.sellAboveUsdc && asset !== SOROSWAP_ROUTER_CONFIG.USDC;
    const position = hasOpenSellTarget && automationAccount ? automation.loadPosition(automationAccount, asset) : BigInt(0);
    if (position > BigInt(0)) {
      setConfirmPause(true);
      return;
    }
    updateRule({ enabled: false });
  };

  // A rule with nothing to buy is not merely misconfigured, it is inert: every payment that
  // arrives is recorded as "no allocation defined" and nothing else happens. It is also the state
  // a fresh account starts in — the rule is stored per address, so signing in a different way
  // means a blank one — which is how a rule gets armed without ever having been filled in.
  const targetMissing = rule.mode === 'portfolio'
    ? rule.allocations.filter(row => row.asset).length === 0
    : !rule.trade.asset || rule.trade.asset === SOROSWAP_ROUTER_CONFIG.USDC;

  // Why the rule would sit on its hands, said out loud. A swap that fails in simulation never reaches
  // the chain, so without this the bot looks like it simply did nothing.
  const blockedReason = (() => {
    if (rule.signer === 'bot' && !bot) return 'Bot mode is on but there is no automation wallet yet — create one below.';
    // Both of these are the state a finished order leaves behind, so they are easy to run into
    // without noticing. Without this the rule looks alive and simply never does anything.
    if (rule.mode === 'portfolio' && targetMissing) {
      return 'No split defined yet — add a row below, otherwise arriving USDC just stays as USDC.';
    }
    if (rule.mode === 'trade' && targetMissing) {
      return 'No asset chosen to buy — pick one below, otherwise arriving USDC just stays as USDC.';
    }
    if (delegated && !mandate) {
      return 'No mandate is registered on chain. Press Approve below — until then the contract refuses every request from the automation wallet.';
    }
    if (delegated && mandateExpired) {
      return 'Your mandate has expired, so the contract refuses every request from the automation wallet. Press Approve below to sign a new one.';
    }
    if (delegated && allowance !== null && allowance <= BigInt(0)) {
      return 'The allowance to the mandate contract is 0 USDC. Press Approve below, otherwise nothing can move when a deposit lands.';
    }
    // Editing the rule does not touch the chain — that needs a signature. So the two can drift,
    // and the contract refuses anything its mandate does not name. Say so before the rule runs
    // rather than letting every row fail with "this asset is not covered".
    if (delegated && mandate && uncoveredAssets.length > 0) {
      const names = uncoveredAssets
        .map(asset => ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token')
        .join(', ');
      return `Your rule now trades ${names}, but the mandate you signed does not cover ${uncoveredAssets.length === 1 ? 'it' : 'them'}. Press Approve to put the current rule on chain.`;
    }
    if (delegated && botBalances.length === 0) {
      return 'The automation wallet holds no XLM for transaction fees — fund it with Friendbot.';
    }
    if (needTrustline.length > 0 && automationAccount === publicKey) {
      const names = needTrustline
        .map(asset => ASSET_OPTIONS.find(option => option.value === asset)?.symbol ?? 'token')
        .join(', ');
      const them = needTrustline.length === 1 ? 'it' : 'them';
      // Only the delegated shape is genuinely stuck. The automation wallet cannot sign a trustline
      // on the owner's behalf, so those rows are skipped until the owner opens one. In wallet mode
      // the rule opens the trustline itself, as one extra signature before the first trade.
      return delegated
        ? `No trustline for ${names} on your wallet — open ${them} below, otherwise those rows are skipped. The automation wallet cannot open ${them} for you.`
        : `No trustline for ${names} yet — the rule will ask you to sign one before it first trades ${them}. Opening ${them} below gets that prompt out of the way.`;
    }
    return null;
  })();

  // Two records of the same automation, and neither subsumes the other. The chain holds what
  // actually settled and survives a cleared browser or a different device; the local journal
  // also holds what the rule decided *not* to do, which never produces a transaction.
  const chainEvents = chainHistory?.events ?? [];
  const verifiedHashes = new Set(chainEvents.map(event => event.txHash));

  const mergedEvents = (() => {
    const knownHashes = new Set(
      events
        .flatMap(event => [event.txHash, ...(event.legs ?? []).map(leg => leg.txHash)])
        .filter((hash): hash is string => !!hash)
    );
    const symbolOf = (contract?: string) =>
      ASSET_OPTIONS.find(option => option.value === contract)?.symbol ?? 'token';

    // Only executions this browser never saw are added; the rest are matched and badged.
    const unseen: automation.AutomationEvent[] = chainEvents
      .filter(event => event.kind === 'executed' && !knownHashes.has(event.txHash))
      .map(event => ({
        id: event.id,
        source: 'chain' as const,
        at: event.at,
        from: 'mandate contract',
        amount: allowanceLib.formatStroops(event.amountIn ?? BigInt(0)),
        status: 'executed' as const,
        legs: [{
          symbol: `${symbolOf(event.assetIn)} → ${symbolOf(event.assetOut)}`,
          percent: 100,
          swapped: allowanceLib.formatStroops(event.amountIn ?? BigInt(0)),
          received: allowanceLib.formatStroops(event.amountOut ?? BigInt(0)),
          txHash: event.txHash,
        }],
      }));

    return [...events, ...unseen].sort((a, b) => (a.at < b.at ? 1 : -1));
  })();

  const isVerified = (event: automation.AutomationEvent): boolean =>
    [event.txHash, ...(event.legs ?? []).map(leg => leg.txHash)].some(
      hash => !!hash && verifiedHashes.has(hash)
    );

  // Deleting the wallet permanently discards its private key — refuse while it's still the
  // signer for a running rule, or while it still holds funds that would become unreachable.
  const botWalletBlockedReason = (() => {
    if (rule.enabled && rule.signer === 'bot') return 'Automation is running with this wallet as signer — pause it first.';
    if (botBalances.some(balance => Number(balance.balance).toFixed(4) !== '0.0000')) {
      return 'This wallet still holds funds — send them to your main wallet first.';
    }
    return null;
  })();

  useEffect(() => {
    if (automationAccount) setExitDone(automation.isExitDone(automationAccount));
  }, [automationAccount, events]);

  // Shared by both the background watcher and the manual "Check now" button, so a completed order
  // resets the rule the same way no matter which path triggered it.
  const handleAutomationEvent = useCallback((event: automation.AutomationEvent) => {
    setEvents(previous => [event, ...previous].slice(0, 200));
    if (useBot && bot) refreshBotBalances(bot.publicKey).catch(() => {});
    if (delegated) refreshAllowance().catch(() => {});
    refreshBalances(publicKey).catch(() => {});

    if (event.status !== 'executed' || !automationAccount) return;

    // A completed exit closes the trade-mode cycle: the buy/sell condition it was watching is now
    // stale (already acted on), so clear it and stop. A bare buy leg does NOT reset here — the sell
    // target still needs watching (see the confirmPause warning built for exactly this case).
    if (event.from === 'exit rule') {
      automation.resetExit(automationAccount);
      // Buy and sell have both run, so the cycle is closed and the form resets with it. The
      // default leaves the asset as USDC, which means "buying is off" — an empty order rather
      // than a new one, so nothing is left looking armed.
      updateRule({ enabled: false, trade: { ...automation.DEFAULT_RULE.trade } });
      return;
    }

    // Portfolio mode has no buy/sell pair to wait on — a successful split is the whole order, done
    // the moment it executes. Read the live rule (ruleRef), not a closure, since this handler is
    // long-lived inside the background watcher.
    if (ruleRef.current.mode === 'portfolio') {
      // The split has happened, so the order is finished and the form goes back to blank. Blank,
      // not the old default row: that one named XLM, which looked like a fresh order nobody
      // placed and put the rule out of step with the mandate just signed for it.
      updateRule({ enabled: false, allocations: [...automation.DEFAULT_RULE.allocations] });
    }
  }, [useBot, bot, delegated, refreshBotBalances, refreshAllowance, refreshBalances, publicKey, automationAccount, updateRule]);

  useEffect(() => {
    if (!automationAccount || !rule.enabled) return;
    console.log('⚡ Automation watcher started:', automationAccount);
    return automation.startWatcher({
      account: automationAccount,
      getRule: () => ruleRef.current,
      signTransaction: automationSigner,
      spender,
      ownerSignTransaction: signTransaction,
      authenticate: authenticateForAutomation,
      onEvent: handleAutomationEvent,
      onError: setError,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationAccount, rule.enabled, rule.signer, rule.delegated, rule.mode]);

  const usdcAsset = info ? anchor.stellarAssetId('USDC', info.currencies.find(c => c.code === 'USDC')?.issuer ?? '') : '';
  const jwtSource = publicKey ? anchor.createJwtSource(publicKey, signTransaction) : undefined;

  return (
    <div className="min-h-screen text-white">
      <div className="bg-white/10 backdrop-blur-md border-b border-white/20 sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
          {/* The mark and the name are one target, and it goes home — the convention every
              other site has already taught people to expect. */}
          <Link href="/" className="flex items-center space-x-3 group" aria-label="Conduit home">
            <Logo className="w-9 h-9 text-accent transition-transform group-hover:scale-105" />
            <h1 className="text-xl font-bold tracking-tight">Conduit</h1>
          </Link>
          <div className="flex items-center gap-3">
            {isConnected && publicKey ? (
              <div className="flex items-center gap-2">
                <span
                  title={usingPasskey
                    ? `Signed in with a passkey. Signing stays quiet until ${passkeyUntil ? new Date(passkeyUntil).toLocaleTimeString() : 'the unlock lapses'}, then your device is asked again.`
                    : undefined}
                  className="flex items-center gap-1.5 font-mono text-xs bg-accent/15 border border-accent/30 px-3 py-1.5 rounded-full"
                >
                  {usingPasskey && <Fingerprint className="w-3.5 h-3.5" />}
                  {publicKey.slice(0, 6)}…{publicKey.slice(-4)}
                </span>
                <button
                  onClick={() => run('connect', connect)}
                  title="Switch wallet or account"
                  className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full"
                >
                  switch
                </button>
                <button
                  onClick={() => run('disconnect', async () => {
                    await disconnect();
                    setJwt('');
                    setBalances(null);
                  })}
                  title="Disconnect"
                  className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full"
                >
                  disconnect
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {/* Two ways in, side by side rather than one behind the other: a passkey needs no
                    extension, which is the whole reason it is offered, and hiding it under the
                    wallet button would only be found by people who already have a wallet. */}
                {passkeyAvailable && (
                  <button
                    onClick={() => run('passkey', connectPasskey)}
                    title={passkeyKnown
                      ? 'Sign in with the passkey on this device'
                      : 'Create a passkey — no browser extension needed'}
                    className="flex items-center gap-2 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-full text-sm"
                  >
                    <Fingerprint className="w-4 h-4" />
                    {busy === 'passkey' ? 'Waiting…' : passkeyKnown ? 'Sign in with passkey' : 'Create passkey'}
                  </button>
                )}
                <button onClick={() => run('connect', connect)} className="bg-accent hover:bg-accent-strong text-canvas px-4 py-2 rounded-full text-sm font-medium">
                  Connect Wallet
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {error && (
          <div className="bg-red-500/20 border border-red-400/40 rounded-xl p-4 text-sm text-red-100">
            {error}
          </div>
        )}

        {notice && (
          <div className="bg-blue-500/10 border border-blue-400/30 rounded-xl p-4 text-sm text-blue-100">
            {notice}
          </div>
        )}

        {/* Above everything else it blocks, and with the one action that unblocks it. A new
            account cannot pay a fee, so nothing else on this page can work until it holds XLM —
            and reading that as a failure somewhere further down costs far more than it should. */}
        {isConnected && unfunded && (
          <div className="bg-caution/10 border border-caution/30 rounded-xl p-4 space-y-3">
            <p className="text-sm text-caution">
              <b>This account does not exist on chain yet.</b>{' '}
              {usingPasskey
                ? 'Your passkey derives a new Stellar account, and a new account has to be created by a first payment into it.'
                : 'It has never been funded.'}{' '}
              Until it holds XLM it cannot pay a transaction fee, so nothing here will work.
            </p>
            <button
              onClick={() => run('fund', async () => {
                await botWalletLib.fundTestnetAccount(publicKey);
                // Horizon needs the ledger to close before the account is readable.
                await new Promise(resolve => setTimeout(resolve, 4000));
                await refreshBalances(publicKey);
                setNotice('Funded from Friendbot — the account is live on testnet.');
              })}
              disabled={busy !== null}
              className="bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
            >
              {busy === 'fund' ? 'Funding…' : 'Fund from Friendbot (testnet)'}
            </button>
            <p className="text-[11px] text-white/40">
              Testnet only. On a real network this is where the account would be funded by whoever
              is opening it — the same first payment, from a different source.
            </p>
          </div>
        )}

        {!isConnected && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 text-center">
            <p className="text-white/70 mb-5">Connect your wallet to start. USDC will arrive in this account.</p>
            {/* Both ways in, given equal weight. The header carries them too, but this is the
                card someone actually reads on a first visit — and the passkey route is the one
                that works for a visitor who has no wallet extension to connect. */}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button onClick={() => run('connect', connect)} className="bg-accent hover:bg-accent-strong text-canvas px-6 py-3 rounded-xl font-medium">
                Connect Wallet
              </button>
              {passkeyAvailable && (
                <>
                  <span className="text-xs text-white/30">or</span>
                  <button
                    onClick={() => run('passkey', connectPasskey)}
                    className="flex items-center gap-2 bg-white/10 hover:bg-white/20 px-6 py-3 rounded-xl font-medium text-sm"
                  >
                    <Fingerprint className="w-4 h-4" />
                    {busy === 'passkey' ? 'Waiting…' : passkeyKnown ? 'Sign in with passkey' : 'Create a passkey'}
                  </button>
                </>
              )}
            </div>
            {passkeyAvailable && !passkeyKnown && (
              <p className="text-[11px] text-white/35 mt-3">
                A passkey makes an account on this device with no extension to install — your fingerprint
                or PIN is the key.
              </p>
            )}
          </div>
        )}

        {isConnected && publicKey && (
          <>
            {/* 1. Account status */}
            <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <h2 className="font-semibold mb-3">1 · Account</h2>
              <Field label="Address" value={publicKey} copyable />
              <Field label="XLM" value={balances?.xlmBalance ?? '…'} />
              <Field label="USDC" value={balances ? `${balances.balance}${balances.hasTrustline ? '' : ' (no trustline)'}` : '…'} />
              {balances && !balances.hasTrustline && (
                <div className="mt-4 bg-amber-500/10 border border-amber-400/30 rounded-xl p-4">
                  <p className="text-sm text-amber-100 mb-3">
                    A trustline is required for USDC to land <b>directly</b> in your wallet. Without one the anchor sends a claimable balance you have to claim separately.
                  </p>
                  <button
                    onClick={() => run('trustline', async () => {
                      await anchor.ensureTrustline(publicKey, signTransaction);
                      await refreshBalances(publicKey);
                    })}
                    disabled={busy !== null}
                    className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium text-slate-900"
                  >
                    {busy === 'trustline' ? 'Opening…' : 'Add USDC trustline'}
                  </button>
                </div>
              )}
            </section>

            {/* 2. SEP-10 login */}
            <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <h2 className="font-semibold mb-3">2 · Anchor login (SEP-10)</h2>
              {jwt ? (
                <p className="text-sm text-emerald-200">✅ Signed in. The challenge was verified before signing.</p>
              ) : (
                <>
                  <p className="text-sm text-white/60 mb-3">Your wallet signs the challenge issued by the anchor. No password, no API key.</p>
                  <button
                    onClick={() => run('auth', async () => setJwt(await anchor.authenticate(publicKey, signTransaction)))}
                    disabled={busy !== null}
                    className="bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
                  >
                    {busy === 'auth' ? 'Signing…' : 'Sign in to anchor'}
                  </button>
                </>
              )}
            </section>

            {/* Tabs: the two directions are separate flows */}
            <div className="flex gap-2 bg-white/5 border border-white/10 rounded-2xl p-2">
              {([
                ['onramp', 'On-ramp · TRY', ArrowDownToLine],
                ['offramp', 'Off-ramp · TRY', ArrowUpFromLine],
                ['automation', 'Automation', Zap],
                ['ai', 'AI Strategy', Sparkles],
                ['history', 'History', ScrollText],
              ] as const).map(([key, label, Icon]) => {
                const locked = !jwt && (key === 'automation' || key === 'ai' || key === 'history');
                return (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    title={locked ? 'Sign in to the anchor above first' : undefined}
                    className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition flex items-center justify-center gap-2 ${
                      tab === key
                        ? 'bg-accent text-canvas shadow-lg'
                        : locked ? 'text-white/30' : 'text-white/60 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {locked ? <Lock className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>

            {confirmPause && (
              <div className="bg-amber-500/10 border border-amber-400/30 rounded-2xl p-4 text-sm text-amber-100 space-y-3">
                <p>
                  ⚠️ You&apos;re holding an unsold position this rule was watching for its sell target. Pausing
                  stops monitoring it — it stays exposed to price moves, unsold, until you resume this rule
                  (nothing is cancelled on-chain; there is no exchange order to cancel, only this watcher).
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => { updateRule({ enabled: false }); setConfirmPause(false); }}
                    className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-4 py-2 rounded-lg text-sm font-medium"
                  >
                    Pause anyway
                  </button>
                  <button
                    onClick={() => setConfirmPause(false)}
                    className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm"
                  >
                    Keep running
                  </button>
                </div>
              </div>
            )}

            {!jwt && (
              <p className="text-sm text-white/50 text-center py-4">
                {tab === 'onramp'
                  ? 'Sign in to the anchor above before depositing TRY.'
                  : tab === 'offramp'
                  ? 'Sign in to the anchor above before withdrawing USDC.'
                  : tab === 'automation'
                  ? 'Sign in to the anchor above to set up automation.'
                  : tab === 'ai'
                  ? 'Sign in to the anchor above to use the AI strategy assistant.'
                  : 'Sign in to the anchor above to view your history.'}
              </p>
            )}

            {jwt && tab === 'automation' && (
              <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                <h2 className="font-semibold mb-1">Act automatically when funds arrive</h2>
                <p className="text-xs text-white/50 mb-4">
                  The rule runs the moment USDC lands in the wallet. Payments that arrive while the page is closed are processed when it reopens.
                  {usdTry && <> · Current rate: <b className="text-white/80">1 USDC = {usdTry} TRY</b></>}
                  {pricesAt && <> · prices read {new Date(pricesAt).toLocaleTimeString()}, refreshing every {PRICE_REFRESH_MS / 1000}s</>}
                </p>

                {blockedReason && (
                  <div className="bg-amber-500/10 border border-amber-400/30 text-amber-100 text-xs rounded-xl px-4 py-3 mb-4">
                    ⚠️ {blockedReason}
                  </div>
                )}

                {/* Signer mode */}
                <div className="bg-black/20 rounded-xl p-4 mb-4">
                  {/* One row, one decision: who signs and where the money sits while it happens */}
                  <div className="flex flex-wrap gap-2 mb-3">
                    {([
                      ['wallet', false, 'Sign with wallet', KeyRound],
                      ['bot', true, 'Bot, funds stay with you', ShieldCheck],
                    ] as const).map(([mode, isDelegated, label, Icon]) => {
                      // The mandate only backs portfolio mode, so in buy & sell this option is
                      // chosen but not in force. Showing it lit anyway was the whole problem: it
                      // promised funds stay in the wallet while they were going to the automation
                      // wallet, and every top-up then asked for a signature that should not exist.
                      const unavailable = mode === 'bot' && isDelegated && !mandateApplies;
                      const active = !unavailable && rule.signer === mode && (mode === 'wallet' || rule.delegated === isDelegated);
                      return (
                        <button
                          key={label}
                          onClick={() => updateRule({ signer: mode, delegated: isDelegated })}
                          title={unavailable ? 'Not available in Buy & sell — the mandate covers portfolio mode' : undefined}
                          className={`px-4 py-2 rounded-lg text-sm flex items-center gap-2 ${
                            active ? 'bg-white/20 text-white'
                              : unavailable ? 'bg-white/5 text-white/25 line-through decoration-white/30'
                                : 'bg-white/5 text-white/50 hover:text-white'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  {/* The funded shape signs unattended from a browser-held key, so it stays folded
                      away rather than sitting in the main row. Not in buy & sell, though: there it
                      is not an option to opt into but the shape actually running, and hiding the
                      thing in force behind a disclosure is how this panel came to contradict
                      itself once already. */}
                  {mandateApplies && (
                    <button
                      type="button"
                      onClick={() => setShowAdvancedSigner(previous => !previous)}
                      className="text-xs text-white/40 hover:text-white/70 mb-3"
                    >
                      {showAdvancedSigner ? '▾' : '▸'} Trading bot
                    </button>
                  )}

                  {(showAdvancedSigner || !mandateApplies) && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {(() => {
                        const [mode, isDelegated, label] = ['bot', false, 'Bot with its own funds'] as const;
                        // This shape exists for trading: it holds its own balance and signs its
                        // own swaps. A portfolio split under it would mean depositing into the
                        // automation wallet only to have it hand everything back, so choosing it
                        // chooses the mode too rather than leaving a combination that has no use.
                        // In buy & sell this is what runs whatever the buttons above say, so it is
                        // drawn as in force rather than as merely selected.
                        const active = rule.signer === mode && (rule.delegated === isDelegated || !mandateApplies);
                        return (
                          <button
                            onClick={() => updateRule({ signer: mode, delegated: isDelegated, mode: 'trade' })}
                            className={`px-4 py-2 rounded-lg text-sm flex items-center gap-2 ${
                              active ? 'bg-white/20 text-white' : 'bg-white/5 text-white/50 hover:text-white'
                            }`}
                          >
                            <Wallet className="w-4 h-4" />
                            {label}
                            {active && !mandateApplies && <span className="text-[10px] text-white/40">in force</span>}
                          </button>
                        );
                      })()}
                    </div>
                  )}

                  {rule.signer === 'wallet' ? (
                    <p className="text-xs text-white/50">
                      Every transaction asks for wallet approval. Your key stays with you, but you must be at the screen when the rule fires.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {delegated ? (
                        <p className="text-xs text-emerald-200/80">
                          Your USDC stays in your own wallet. You sign one mandate — which assets, how much per day, at
                          which prices — and a contract enforces it. The automation wallet can ask, never exceed: it holds
                          no allowance of its own, so revoking the mandate stops it outright.
                        </p>
                      ) : (
                        <div className="text-xs text-amber-200/80 space-y-2">
                          <p>
                            In this mode the automation wallet holds the funds itself and signs without approval. Use it
                            on testnet only, with a budget you set aside.
                          </p>
                          {/* Running in a different shape than the one selected above is worse than
                              the limitation itself, so it is stated where the shape is chosen —
                              together with the consequence, which is the part people hit first. */}
                          {rule.delegated && !mandateApplies && (
                            <p>
                              <b>Buy &amp; sell runs this way whatever is selected above.</b> The mandate covers portfolio
                              mode, where a rule is one leg into one asset. Two things follow: deposits have to reach the{' '}
                              <b>automation wallet</b>, not yours — an on-ramp here pays it directly, and moving USDC across
                              from your own wallet is a transfer you sign. After that the rule runs untouched. Switch to
                              Portfolio split to put your funds back behind the contract.
                            </p>
                          )}
                        </div>
                      )}
                      {bot && (
                        botWalletLib.isLegacy(bot) ? (
                          <p className="text-xs text-amber-200/80">
                            ⚠️ This automation wallet predates non-extractable keys, so its seed is still
                            stored as text in this browser. Replace it to move to a key that cannot be
                            read back — you will re-sign the mandate so it names the new wallet.
                          </p>
                        ) : (
                          <p className="text-xs text-emerald-200/80">
                            🔐 This automation wallet&apos;s key is non-extractable: the browser signs with it
                            but cannot read it back, and it is never written to storage as text.
                          </p>
                        )
                      )}
                      {bot ? (
                        <>
                          <Field label="Automation wallet" value={bot.publicKey} copyable />
                          <p className="text-sm text-white/70">
                            Balance: {(() => {
                              if (botBalances.length === 0) return 'account not created yet (fund it)';
                              // Filter on the rounded (displayed) value, not the raw one — a dust
                              // amount like 0.00000003 is > 0 but still reads as "0.0000".
                              const held = botBalances
                                .map(balance => ({ asset: balance.asset, formatted: Number(balance.balance).toFixed(4) }))
                                .filter(balance => balance.formatted !== '0.0000');
                              return held.length > 0
                                ? held.map(balance => `${balance.formatted} ${balance.asset}`).join(' · ')
                                : 'no assets held yet';
                            })()}
                          </p>

                          {delegated && (
                            <div className="bg-black/30 rounded-lg p-3 space-y-3">
                              {/* 1. Status — what the chain says the rule is, not what the form says */}
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs text-white/50">Mandate on chain</span>
                                  <span className="font-mono text-sm text-white/90">
                                    {mandate
                                      ? `${allowanceLib.formatStroops(mandate.capPerWindow)} USDC / day`
                                      : 'none — press Approve'}
                                  </span>
                                </div>
                                {mandate && (
                                  <>
                                    <div className="flex items-start justify-between gap-3">
                                      <span className="text-xs text-white/50 shrink-0">Assets covered</span>
                                      <span className="font-mono text-xs text-white/90 text-right">
                                        {symbolList(mandate.assets)}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-xs text-white/50">Used this window</span>
                                      <span className="font-mono text-sm text-white/90">
                                        {mandateSpent === null ? '—' : `${allowanceLib.formatStroops(mandateSpent)} USDC`}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-xs text-white/50">Contract may still pull</span>
                                      <span className="font-mono text-sm text-white/90">
                                        {allowance === null ? '—' : `${allowanceLib.formatStroops(allowance)} USDC`}
                                      </span>
                                    </div>
                                    <p className="text-[11px] text-white/40 pt-1">
                                      Enforced by{' '}
                                      <a
                                        href={`https://stellar.expert/explorer/testnet/contract/${MANDATE_CONFIG.CONTRACT}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline decoration-dotted hover:text-white/70"
                                      >
                                        the mandate contract
                                      </a>
                                      {mandate.buyBelow > BigInt(0) && ` · buys only below ${allowanceLib.formatStroops(mandate.buyBelow)} USDC`}
                                      {mandate.sellAbove > BigInt(0) && ` · sells only above ${allowanceLib.formatStroops(mandate.sellAbove)} USDC`}
                                    </p>
                                    {/* The drift warning itself lives next to the rule editor, where
                                        the change is made; here it would only repeat it. */}
                                  </>
                                )}
                              </div>

                              {/* 2. Set a new limit — input and its action stay together */}
                              <div>
                                <div className="flex flex-wrap items-end gap-2">
                                  <label className="text-xs">
                                    <span className="block text-white/50 mb-1">New limit (USDC)</span>
                                    <input
                                      value={approveAmount}
                                      onChange={event => setApproveAmount(event.target.value)}
                                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-28 font-mono text-xs"
                                    />
                                  </label>
                                  <label className="text-xs">
                                    <span className="block text-white/50 mb-1">Valid for (days)</span>
                                    <input
                                      value={approveDays}
                                      onChange={event => setApproveDays(event.target.value)}
                                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-24 font-mono text-xs"
                                    />
                                  </label>
                                  <button
                                    onClick={() => run('approve', signMandate)}
                                    disabled={busy !== null}
                                    className="text-xs bg-accent/90 hover:bg-accent text-canvas text-slate-900 disabled:opacity-50 px-3 py-2 rounded-lg font-medium"
                                  >
                                    {busy === 'approve' ? 'Signing…' : 'Approve'}
                                  </button>
                                </div>

                                <p className="text-[11px] text-white/40 mt-1.5">
                                  Your balance: <b className="text-white/60">{balances ? `${balances.balance} USDC` : '…'}</b> — the
                                  limit can be set higher to cover deposits you expect while this approval is valid.
                                </p>

                                <p className="text-[11px] text-white/40 mt-2">
                                  The mandate covers every supported asset, so changing the rule later never asks for
                                  another signature. The daily limit, the price bounds and the expiry apply to all of
                                  them, and Revoke cancels the lot at once.
                                </p>
                              </div>

                              {/* 3. Secondary actions */}
                              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/10">
                                <button
                                  onClick={() => run('revoke', async () => {
                                    // Removing the mandate is already enough — the automation wallet
                                    // never held an allowance of its own — but the allowance to the
                                    // contract is cleared too, so nothing is left pointing anywhere.
                                    if (mandate) await mandateLib.revokeMandate(publicKey, signTransaction);
                                    await allowanceLib.revokeSpender({
                                      owner: publicKey,
                                      spender: MANDATE_CONFIG.CONTRACT,
                                      contract: SOROSWAP_ROUTER_CONFIG.USDC,
                                      signTransaction,
                                    });
                                    await refreshAllowance();
                                    setNotice('Mandate revoked — the automation wallet can no longer act for you.');
                                  })}
                                  disabled={busy !== null}
                                  className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-100 disabled:opacity-50 px-3 py-2 rounded-lg"
                                >
                                  {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
                                </button>
                                <button
                                  onClick={() => run('allowance-refresh', refreshAllowance)}
                                  disabled={busy !== null}
                                  className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-2 rounded-lg"
                                >
                                  Refresh
                                </button>
                                {needTrustline.length > 0 && (
                                  <button
                                    onClick={() => run('trustlines', addMissingTrustlines)}
                                    disabled={busy !== null}
                                    className="text-xs bg-amber-500/15 border border-amber-400/30 text-amber-100 hover:bg-amber-500/25 disabled:opacity-50 px-3 py-2 rounded-lg"
                                  >
                                    {busy === 'trustlines'
                                      ? 'Opening…'
                                      : `⚠️ Add trustlines for target assets (${needTrustline.length} missing)`}
                                  </button>
                                )}
                                <span className="text-[11px] text-white/30 basis-full sm:basis-auto sm:ml-auto">
                                  Enforced by the USDC contract, not this app · bot needs a little XLM for fees
                                </span>
                              </div>
                            </div>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {!botBalances.some(balance => balance.asset === 'USDC') && (
                              <button
                                onClick={() => run('bot-trust', ensureDepositTrustline)}
                                disabled={busy !== null}
                                className="text-xs bg-amber-500/80 hover:bg-amber-500 text-slate-900 disabled:opacity-50 px-3 py-2 rounded-lg font-medium"
                              >
                                {busy === 'bot-trust' ? 'Opening…' : 'Add USDC trustline'}
                              </button>
                            )}
                            {botBalances.length === 0 && (
                              <button
                                onClick={() => run('bot-fund', async () => {
                                  await botWalletLib.fundTestnetAccount(bot.publicKey);
                                  await refreshBotBalances(bot.publicKey);
                                })}
                                disabled={busy !== null}
                                className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-2 rounded-lg"
                              >
                                {busy === 'bot-fund' ? 'Funding…' : 'Fund with Friendbot'}
                              </button>
                            )}
                            <button
                              onClick={() => run('bot-refresh', async () => refreshBotBalances(bot.publicKey))}
                              disabled={busy !== null}
                              className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-2 rounded-lg"
                            >
                              Refresh balance
                            </button>
                            {!delegated && (
                              <button
                                onClick={() => run('bot-sweep', async () => {
                                  const result = await botWalletLib.sweepToOwner(bot, publicKey);
                                  await refreshBotBalances(bot.publicKey);
                                  await refreshBalances(publicKey);
                                  setNotice(
                                    (result.moved.length ? `Sent to main wallet: ${result.moved.join(', ')}` : 'Nothing to send') +
                                      (result.skipped.length ? ` · skipped: ${result.skipped.join(', ')}` : '')
                                  );
                                })}
                                disabled={busy !== null}
                                className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-2 rounded-lg"
                              >
                                {busy === 'bot-sweep' ? 'Sending…' : 'Send balance to main wallet'}
                              </button>
                            )}
                            <button
                              onClick={() => setConfirmDeleteBot(true)}
                              disabled={!!botWalletBlockedReason}
                              title={botWalletBlockedReason ?? undefined}
                              className="text-xs text-white/40 hover:text-red-300 disabled:opacity-40 disabled:hover:text-white/40 px-3 py-2"
                            >
                              delete wallet
                            </button>
                          </div>

                          {botWalletBlockedReason && (
                            <p className="text-[11px] text-amber-200/70 mt-1">⚠️ {botWalletBlockedReason}</p>
                          )}

                          {confirmDeleteBot && (
                            <div className="mt-2 bg-red-500/10 border border-red-400/30 rounded-xl p-3 text-sm text-red-100 space-y-2">
                              <p>⚠️ This permanently deletes the wallet&apos;s key from this browser — it cannot be undone or recovered.</p>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  onClick={async () => {
                                    await botWalletLib.clearBotWallet(publicKey);
                                    setBot(null);
                                    setBotBalances([]);
                                    setConfirmDeleteBot(false);
                                  }}
                                  className="bg-red-500 hover:bg-red-600 px-4 py-2 rounded-lg text-sm font-medium"
                                >
                                  Yes, delete permanently
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteBot(false)}
                                  className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <button
                          onClick={async () => setBot(await botWalletLib.createBotWallet(publicKey))}
                          className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm"
                        >
                          Create automation wallet
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2 mb-4">
                  <label className="text-sm">
                    <span className="block text-white/60 mb-1">Sender</span>
                    <select
                      value={rule.senderFilter}
                      onChange={event => updateRule({ senderFilter: event.target.value as automation.AutomationRule['senderFilter'] })}
                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full"
                    >
                      <option className="bg-slate-800" value="anchor">Anchor treasury only</option>
                      <option className="bg-slate-800" value="any">Anyone</option>
                      <option className="bg-slate-800" value="address">A specific address</option>
                    </select>
                  </label>

                  {rule.senderFilter === 'address' && (
                    <label className="text-sm">
                      <span className="block text-white/60 mb-1">Sender address</span>
                      <input
                        value={rule.senderAddress}
                        onChange={event => updateRule({ senderAddress: event.target.value.trim() })}
                        placeholder="G…"
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono text-xs"
                      />
                    </label>
                  )}

                  <label className="text-sm">
                    <span className="block text-white/60 mb-1">Minimum amount (USDC)</span>
                    <input
                      value={rule.minAmount}
                      onChange={event => updateRule({ minAmount: event.target.value })}
                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                    />
                  </label>

                  <div className="sm:col-span-2 flex flex-wrap gap-2">
                    {([['portfolio', 'Portfolio split', PieChart], ['trade', 'Buy & sell', TrendingUp]] as const).map(([mode, label, Icon]) => {
                      // The trading bot trades; splitting a payment under it would send the money
                      // to the automation wallet and immediately give it back. Refused rather
                      // than offered, so the combination cannot be reached by accident.
                      const unavailable = mode === 'portfolio' && fundedBot;
                      return (
                        <button
                          key={mode}
                          onClick={() => !unavailable && updateRule({ mode })}
                          title={unavailable ? 'The trading bot only does Buy & sell — switch signer to use a portfolio split' : undefined}
                          className={`px-4 py-2 rounded-lg text-sm flex items-center gap-2 ${
                            rule.mode === mode && !unavailable ? 'bg-accent/90 text-canvas'
                              : unavailable ? 'bg-white/5 text-white/25 line-through decoration-white/30 cursor-not-allowed'
                                : 'bg-white/5 text-white/50 hover:text-white'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  {rule.mode === 'trade' && (
                    <div className="sm:col-span-2 space-y-3 bg-black/20 rounded-xl p-4">
                      <label className="block text-sm">
                        <span className="block text-white/60 mb-1">Asset</span>
                        <select
                          value={rule.trade.asset}
                          onChange={event => updateRule({ trade: { ...rule.trade, asset: event.target.value } })}
                          className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full"
                        >
                          {ASSET_OPTIONS.map(asset => (
                            <option className="bg-slate-800" key={asset.value} value={asset.value}>
                              {asset.label}{asset.liquidity === 'thin' ? ' — thin pool' : ''}
                            </option>
                          ))}
                        </select>
                        <span className="block text-[11px] text-white/40 mt-1 font-mono">
                          {prices[rule.trade.asset]
                            ? `now 1 unit = ${formatPrice(prices[rule.trade.asset].usdc)} USDC · ${formatPrice(prices[rule.trade.asset].try)} TRY`
                            : 'loading price…'}
                        </span>
                      </label>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="text-sm">
                          <span className="block text-white/60 mb-1">Buy: % of incoming USDC</span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={rule.trade.buyPercent}
                            onChange={event => updateRule({ trade: { ...rule.trade, buyPercent: Number(event.target.value) } })}
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                          />
                          <span className="block text-[11px] text-white/40 mt-1">If USDC is selected nothing is bought; the funds simply wait.</span>
                        </label>

                        <label className="text-sm">
                          <span className="block text-white/60 mb-1">Only when price ≤ (USDC), empty = no condition</span>
                          <input
                            value={rule.trade.buyBelowUsdc}
                            onChange={event => updateRule({ trade: { ...rule.trade, buyBelowUsdc: event.target.value } })}
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                          />
                          <span className="block text-[11px] text-white/40 mt-1">
                            A vetoed buy is not retried later — the payment has already been consumed.
                          </span>
                        </label>

                        <label className="text-sm">
                          <span className="block text-white/60 mb-1">Sell: when price ≥ (USDC)</span>
                          <input
                            value={rule.trade.sellAboveUsdc}
                            onChange={event => updateRule({ trade: { ...rule.trade, sellAboveUsdc: event.target.value } })}
                            placeholder={prices[rule.trade.asset] ? `now ${formatPrice(prices[rule.trade.asset].usdc)}` : 'e.g. 1.45'}
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                          />
                        </label>

                        <label className="text-sm">
                          <span className="block text-white/60 mb-1">% of holdings to sell</span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={rule.trade.sellPercent}
                            onChange={event => updateRule({ trade: { ...rule.trade, sellPercent: Number(event.target.value) } })}
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                          />
                        </label>
                      </div>

                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={rule.trade.offramp}
                          onChange={event => updateRule({ trade: { ...rule.trade, offramp: event.target.checked } })}
                        />
                        <span>After selling, send TRY to the IBAN (SEP-6 off-ramp)</span>
                      </label>

                      {rule.trade.offramp && (
                        <div className="bg-amber-500/10 border border-amber-400/30 rounded-lg p-3 space-y-2">
                          {payout ? (() => {
                            const amount = Number(payout.usdc);
                            const tooSmall = payout.limit?.min !== undefined && amount < payout.limit.min;
                            const tooBig = payout.limit?.max !== undefined && amount > payout.limit.max;
                            const ok = !tooSmall && !tooBig;
                            return (
                              <div className={`text-xs rounded-lg px-3 py-2 border ${
                                ok ? 'text-emerald-100 bg-emerald-500/10 border-emerald-400/30'
                                   : 'text-amber-100 bg-amber-500/10 border-amber-400/30'
                              }`}>
                                <div>
                                  {payout.projected ? (
                                    <>
                                      Projection — nothing bought yet. A{' '}
                                      <b className="font-mono">{payout.seedUsdc.toFixed(4)} USDC</b> deposit buys about{' '}
                                      <b className="font-mono">{payout.held} {payout.symbol}</b>;
                                    </>
                                  ) : (
                                    <>
                                      Selling {rule.trade.sellPercent}% of the{' '}
                                      <b className="font-mono">{payout.held} {payout.symbol}</b> this rule bought,
                                    </>
                                  )}{' '}
                                  {payout.atTarget ? 'at your target' : 'at today’s price'}{' '}
                                  <b className="font-mono">{formatPrice(payout.unitPrice)} USDC</b>
                                </div>
                                <div className="mt-1">
                                  → <b className="font-mono">{amount.toFixed(4)} USDC</b>
                                  {ok && <> → <b className="font-mono">{payout.try} TRY</b></>}
                                  {payout.fee && ok && <> · anchor fee {payout.fee}</>}
                                </div>
                                {tooSmall && (
                                  <div className="mt-1">
                                    Below the anchor&apos;s {payout.limit?.min} USDC minimum — the withdrawal would be rejected.
                                  </div>
                                )}
                                {tooBig && (
                                  <div className="mt-1">
                                    Over the anchor&apos;s {payout.limit?.max} USDC per-withdrawal cap — it would have to be split.
                                  </div>
                                )}
                                {!payout.atTarget && (
                                  <div className="mt-1 text-white/50">Set a sell target to price the actual exit.</div>
                                )}
                              </div>
                            );
                          })() : (
                            <p className="text-xs text-white/40">
                              The payout estimate appears once this rule has bought some of the asset and a sell
                              target is set. It only ever sells what the rule itself bought, never the rest of your wallet.
                            </p>
                          )}
                          <p className="text-xs text-amber-100">
                            TRY goes to the IBAN registered under the account that opens the withdrawal. {useBot ? 'In bot mode you must register the IBAN under the automation account.' : ''} Without one the anchor uses a sandbox IBAN.
                            {payout?.limit?.min !== undefined && payout?.limit?.max !== undefined
                              ? ` The anchor withdraws ${payout.limit.min}–${payout.limit.max} USDC per transaction.`
                              : ''}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <input
                              value={iban}
                              onChange={event => { setIban(normalizeIban(event.target.value)); setCustomerStatus(''); }}
                              aria-label="Recipient IBAN"
                              aria-invalid={!!iban && !!ibanError}
                              aria-describedby="automation-iban-error"
                              placeholder="TR.. (26 chars)"
                              className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 font-mono text-xs flex-1 min-w-[16rem]"
                            />
                            <input
                              value={holderFirstName}
                              onChange={event => setHolderFirstName(event.target.value)}
                              placeholder="First name (optional)"
                              title="Optional against this testnet anchor; a production anchor requires it, because the bank checks the name against the IBAN."
                              className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-xs w-40"
                            />
                            <input
                              value={holderLastName}
                              onChange={event => setHolderLastName(event.target.value)}
                              placeholder="Last name (optional)"
                              title="Optional against this testnet anchor; a production anchor requires it, because the bank checks the name against the IBAN."
                              className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-xs w-40"
                            />
                            <button
                              onClick={() => run('trade-kyc', async () => {
                                await savePayoutDetails(await authenticateForAutomation());
                              })}
                              disabled={busy !== null || !!ibanError}
                              className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-2 rounded-lg"
                            >
                              {busy === 'trade-kyc' ? 'Saving…' : 'Register IBAN for automation account'}
                            </button>
                            {customerStatus && <span className="text-xs text-emerald-200 self-center">✅ {customerStatus}</span>}
                          </div>
                          <p id="automation-iban-error" aria-live="polite" className="text-xs text-amber-200">
                            {iban ? ibanError : null}
                          </p>
                        </div>
                      )}

                      {exitDone && (
                        <div className="flex items-center gap-3 text-sm">
                          <span className="text-emerald-200">✅ Exit rule executed</span>
                          <button
                            onClick={() => { automation.resetExit(automationAccount); setExitDone(false); }}
                            className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg"
                          >
                            reset exit
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {rule.mode === 'portfolio' && (
                  <div className="sm:col-span-2">
                    <span className="block text-white/60 text-sm mb-2">Split — how incoming USDC is divided</span>
                    <div className="space-y-2">
                      {rule.allocations.map((allocation, index) => (
                        <div key={index} className="flex flex-wrap items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={allocation.type === 'amount' ? undefined : 100}
                            value={allocation.type === 'amount' ? allocation.amount ?? '' : allocation.percent}
                            onChange={event => updateAllocation(index, allocation.type === 'amount'
                              ? { amount: event.target.value }
                              : { percent: Number(event.target.value) })}
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-24 font-mono"
                          />
                          <button
                            onClick={() => updateAllocation(index, allocation.type === 'amount'
                              ? { type: 'percent' }
                              : { type: 'amount', amount: allocation.amount ?? '' })}
                            title="Switch between a share of the payment and a fixed amount"
                            className="text-xs bg-white/10 hover:bg-white/20 px-2 py-2 rounded-lg w-16"
                          >
                            {allocation.type === 'amount' ? 'USDC' : '% share'}
                          </button>
                          <span className="text-white/40 text-sm">→</span>
                          <select
                            value={allocation.asset}
                            onChange={event => updateAllocation(index, { asset: event.target.value })}
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 flex-1 min-w-[14rem]"
                          >
                            {/* Without this an unset row renders as though the first asset were
                                chosen, while its value is still empty. */}
                            <option className="bg-slate-800" value="">Pick an asset…</option>
                            {ASSET_OPTIONS.filter(asset => asset.symbol !== 'USDC').map(asset => (
                              <option className="bg-slate-800" key={asset.value} value={asset.value}>
                                {asset.label}{asset.liquidity === 'thin' ? ' — thin pool' : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => updateRule({ allocations: rule.allocations.filter((_, i) => i !== index) })}
                            className="text-xs text-white/40 hover:text-red-300 px-2 py-2"
                            title="Remove row"
                          >
                            remove
                          </button>
                          {needTrustline.includes(allocation.asset) && (
                            <button
                              onClick={() => run(`trust-${index}`, () => autoOpenTrustline(allocation.asset))}
                              disabled={busy !== null || automationAccount !== publicKey}
                              title={automationAccount === publicKey
                                ? 'Open the trustline this asset needs'
                                : 'The automation wallet opens this one itself when the rule runs'}
                              className="text-[11px] bg-amber-500/15 border border-amber-400/30 text-amber-100 disabled:opacity-60 rounded px-2 py-1"
                            >
                              {busy === `trust-${index}`
                                ? 'opening…'
                                : automationAccount === publicKey
                                  ? 'trustline needed — open'
                                  : 'trustline opens automatically'}
                            </button>
                          )}
                          <span className="w-full text-[11px] text-white/40 font-mono pl-1">
                            {prices[allocation.asset]
                              ? `1 ${ASSET_OPTIONS.find(asset => asset.value === allocation.asset)?.symbol ?? ''} = ` +
                                `${formatPrice(prices[allocation.asset].usdc)} USDC · ` +
                                `${formatPrice(prices[allocation.asset].try)} TL · ` +
                                `${formatPrice(prices[allocation.asset].eurc)} EURC`
                              : 'loading price…'}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-2">
                      <button
                        onClick={() => {
                          // A new row can only be filled by taking the total past 100%, so adding
                          // one here would hand over a control that cannot be used. Say why instead.
                          if (allocationTotal >= 100) {
                            setRowLimitAsked(true);
                            return;
                          }
                          setRowLimitAsked(false);
                          const used = new Set(rule.allocations.map(allocation => allocation.asset));
                          const next = ASSET_OPTIONS.find(asset => asset.symbol !== 'USDC' && !used.has(asset.value));
                          if (next) updateRule({ allocations: [...rule.allocations, { asset: next.value, percent: 0 }] });
                        }}
                        className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg"
                      >
                        + add row
                      </button>
                      {/* Nothing to total up until there is a row; with none, the button is the
                          whole story. */}
                      {rule.allocations.length > 0 && (
                        <span className={`text-xs ${allocationTotal > 100 ? 'text-red-300' : 'text-white/50'}`}>
                          total {allocationTotal}%{fixedTotal > 0 && ` + ${fixedTotal} USDC fixed`}
                          {allocationTotal < 100 && ` · remaining ${100 - allocationTotal}% stays in USDC`}
                          {allocationTotal > 100 && ' · cannot exceed 100%'}
                        </span>
                      )}
                    </div>
                    {/* Paired with the live total rather than dismissed by hand: lowering a share
                        makes room, and the warning goes away on its own when it does. */}
                    {rowLimitAsked && allocationTotal >= 100 && (
                      <div
                        role="alert"
                        className="mt-2 flex items-start gap-2 bg-amber-500/10 border border-amber-400/30 rounded-lg px-3 py-2 text-xs text-amber-100"
                      >
                        <span aria-hidden>⚠️</span>
                        <span>
                          The payment is already fully allocated ({allocationTotal}%). A new row
                          could only be funded by going over 100%, so nothing was added — lower a
                          row&apos;s share first to make room.
                        </span>
                      </div>
                    )}
                  </div>
                  )}

                  {/* Editing the rule above costs nothing; naming a new asset in it costs a
                      signature, because the mandate lists the assets the contract will act on.
                      Show both sides — the chain is what runs. */}
                  {delegated && mandate && uncoveredAssets.length > 0 && (
                    <div className="bg-amber-500/10 border border-amber-400/30 rounded-lg p-3 space-y-2.5">
                      <p className="text-xs text-amber-100">
                        This rule names an asset your mandate does not cover, so the contract will refuse it.
                        Update the mandate to include it.
                      </p>
                      <div className="grid grid-cols-2 gap-3 text-[11px]">
                        <div>
                          <span className="block text-white/40 mb-1">Mandate on chain</span>
                          <span className="block font-mono text-white/80">{symbolList(mandate.assets)}</span>
                        </div>
                        <div>
                          <span className="block text-white/40 mb-1">This rule</span>
                          <span className="block font-mono text-white/80">{symbolList(mandateAssets)}</span>
                          <span className="block text-amber-200/80">not covered: {symbolList(uncoveredAssets)}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => run('update-mandate', signMandate)}
                        disabled={busy !== null}
                        className="text-xs bg-amber-400/90 hover:bg-amber-400 text-slate-900 disabled:opacity-50 px-3 py-2 rounded-lg font-medium"
                      >
                        {busy === 'update-mandate' ? 'Signing…' : 'Update mandate on chain'}
                      </button>
                      <p className="text-[11px] text-white/40">
                        Two signatures: the USDC allowance to the contract, then the rule itself.
                      </p>
                    </div>
                  )}

                  <label className="text-sm">
                    <span className="block text-white/60 mb-1">Max price impact % (empty = unlimited)</span>
                    <input
                      value={rule.maxPriceImpact}
                      onChange={event => updateRule({ maxPriceImpact: event.target.value })}
                      placeholder="e.g. 3"
                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                    />
                    <span className="block text-[11px] text-white/40 mt-1">In thin pools the rule skips any row above this threshold.</span>
                  </label>

                  <label className="text-sm">
                    <span className="block text-white/60 mb-1">Condition: USD/TRY at least (empty = none)</span>
                    <input
                      value={rule.minUsdTry}
                      onChange={event => updateRule({ minUsdTry: event.target.value })}
                      placeholder={usdTry ? `now ${formatPrice(Number(usdTry))}` : 'e.g. 49'}
                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono"
                    />
                    <span className="block text-[11px] text-white/40 mt-1 font-mono">
                      {usdTry ? `now 1 USDC = ${formatPrice(Number(usdTry))} TRY` : 'loading rate…'}
                    </span>
                  </label>

                  <label className="text-sm">
                    <span className="block text-white/60 mb-1">Telegram chat id (optional)</span>
                    <input
                      value={rule.telegramChatId}
                      onChange={event => updateRule({ telegramChatId: event.target.value.trim() })}
                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono text-xs"
                    />
                    <span className="block text-white/40 text-xs mt-1">
                      Automation alerts arrive here. Uses the server&apos;s bot by default.
                    </span>
                  </label>

                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedTelegram(previous => !previous)}
                      className="text-xs text-white/40 hover:text-white/70"
                    >
                      {showAdvancedTelegram ? '▾' : '▸'} Advanced Telegram setup
                    </button>

                    {showAdvancedTelegram && (
                      <div className="mt-2 space-y-2">
                        <label className="block text-sm">
                          <span className="block text-white/60 mb-1">Telegram bot token (optional)</span>
                          <input
                            value={rule.telegramBotToken}
                            onChange={event => updateRule({ telegramBotToken: event.target.value.trim() })}
                            placeholder="leave empty to use the server token"
                            className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full font-mono text-xs"
                          />
                          <span className="block text-white/40 text-xs mt-1">
                            Empty: the server&apos;s TELEGRAM_BOT_TOKEN is used and never reaches the browser.
                            Filled in: the token stays in this browser only.
                          </span>
                        </label>
                        <span className="flex flex-wrap gap-2">
                          <button
                            onClick={() => run('telegram-id', async () => {
                              const chatId = await automation.findTelegramChatId(rule.telegramBotToken);
                              if (!chatId) {
                                setNotice('No chat found. Send your bot a message first, then press this again.');
                                return;
                              }
                              updateRule({ telegramChatId: chatId });
                              setNotice(`Chat id found: ${chatId}`);
                            })}
                            disabled={busy !== null}
                            className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-1.5 rounded-lg"
                          >
                            {busy === 'telegram-id' ? 'Looking…' : 'Find chat id'}
                          </button>
                          <button
                            onClick={() => run('telegram-test', async () => {
                              await automation.sendTelegramMessage(
                                rule.telegramBotToken,
                                rule.telegramChatId,
                                `✅ Conduit is connected.\nAutomation alerts will arrive here.\n${new Date().toLocaleString('en-US')}`
                              );
                              setNotice('Test message sent ✅');
                            })}
                            disabled={busy !== null || !rule.telegramChatId}
                            className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-1.5 rounded-lg"
                          >
                            {busy === 'telegram-test' ? 'Sending…' : 'Send test message'}
                          </button>
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => {
                      if (rule.enabled) {
                        requestPause();
                        return;
                      }
                      run('start-automation', async () => {
                        if (needTrustline.length > 0) await ensureAutomationTrustlines();
                        updateRule({ enabled: true });
                      });
                    }}
                    title={!rule.enabled && targetMissing ? blockedReason ?? undefined : undefined}
                    // Starting an empty rule can only produce a log line per payment. Letting it
                    // be armed anyway meant the app looked like it was running and the deposits
                    // looked like failures.
                    disabled={busy !== null || (!rule.enabled && (allocationTotal > 100 || targetMissing))}
                    className={`px-5 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 ${
                      rule.enabled ? 'bg-red-500 hover:bg-red-600' : 'bg-accent hover:bg-accent-strong text-canvas'
                    }`}
                  >
                    {busy === 'start-automation'
                      ? (needTrustline.length > 0 ? 'Opening trustlines…' : 'Starting…')
                      : rule.enabled ? '⏸ Pause automation' : '▶ Start automation'}
                  </button>
                  <button
                    onClick={() => run('automation', async () => {
                      const result = await automation.pollOnce({
                        account: automationAccount,
                        rule,
                        signTransaction: automationSigner,
                        onEvent: handleAutomationEvent,
                      });
                      // In buy & sell mode the price target can be checked manually too
                      const exit = rule.mode === 'trade'
                        ? await automation.checkExit({
                            account: automationAccount,
                            rule,
                            signTransaction: automationSigner,
                            authenticate: authenticateForAutomation,
                            onEvent: handleAutomationEvent,
                          })
                        : null;
                      if (result.checked === 0 && !exit) setNotice('Checked — no new payment, and the exit condition was not met (nothing to do right now).');
                      await refreshBalances(publicKey);
                      if (useBot && bot) await refreshBotBalances(bot.publicKey);
                    })}
                    disabled={busy !== null}
                    className="bg-white/10 hover:bg-white/20 disabled:opacity-50 px-4 py-2 rounded-lg text-sm"
                  >
                    {busy === 'automation' ? 'Checking…' : 'Check now'}
                  </button>
                  {rule.enabled && (
                    <span className="text-sm text-emerald-200 flex items-center gap-2">
                      <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                      watching {useBot ? 'automation wallet' : 'main wallet'} · every {automation.POLL_INTERVAL_MS / 1000}s
                    </span>
                  )}
                </div>

                {/* Runs the exit against a target typed for this run instead of the rule's own.
                    Kept behind its own disclosure and named as a demo: nobody trades these pools,
                    so a real target is reached when someone moves the pool and not before, which
                    leaves no way to rehearse the exit on cue. The price is still read from the
                    pool and still has to clear the number, so this lowers the bar rather than
                    removing it. */}
                {rule.mode === 'trade' && rule.trade.asset && rule.trade.asset !== SOROSWAP_ROUTER_CONFIG.USDC && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setShowForceExit(previous => !previous)}
                      className="text-xs text-white/40 hover:text-white/70"
                    >
                      {showForceExit ? '▾' : '▸'} Demo: sell at a price you enter
                    </button>
                    {showForceExit && (
                      <div className="mt-2 bg-black/20 border border-white/10 rounded-lg p-3 space-y-2.5">
                        <p className="text-[11px] text-white/50">
                          For rehearsing, not for the rule. Sells{' '}
                          {rule.trade.sellPercent}% of the position — same signer, same off-ramp if it is on
                          — but against the target below instead of the rule&apos;s{' '}
                          {rule.trade.sellAboveUsdc ? `${rule.trade.sellAboveUsdc} USDC` : 'own'}. The pool price
                          still has to reach it, so it can refuse. It does not use the rule up.
                        </p>
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="text-[11px]">
                            <span className="block text-white/40 mb-1">
                              Sell at or above (USDC)
                              {prices[rule.trade.asset] && (
                                <>
                                  {' · '}
                                  {/* Typing a target a hair above spot is the easy mistake, and it
                                      reads as the demo being broken rather than as the number being
                                      wrong by 0.006%. One click puts a figure in that works. */}
                                  <button
                                    type="button"
                                    onClick={() => setDemoSellAbove(prices[rule.trade.asset].usdc.toFixed(7))}
                                    className="text-blue-300 hover:text-blue-200 underline"
                                  >
                                    use now ({prices[rule.trade.asset].usdc.toFixed(7)})
                                  </button>
                                </>
                              )}
                            </span>
                            <input
                              value={demoSellAbove}
                              onChange={event => setDemoSellAbove(event.target.value)}
                              inputMode="decimal"
                              placeholder={prices[rule.trade.asset] ? prices[rule.trade.asset].usdc.toFixed(7) : 'e.g. 0.0235'}
                              className="bg-white/10 border border-white/20 rounded-lg px-2.5 py-1.5 w-40 font-mono placeholder:text-white/30"
                            />
                          </label>
                          <button
                            onClick={() => run('force-exit', async () => {
                              const event = await automation.checkExit({
                                account: automationAccount,
                                rule,
                                signTransaction: automationSigner,
                                spender,
                                delegateSignTransaction: spender ? automationSigner : undefined,
                                authenticate: authenticateForAutomation,
                                onEvent: handleAutomationEvent,
                                sellAboveOverride: demoSellAbove.trim(),
                              });
                              if (!event) setNotice('Nothing to sell — pick an asset for the rule first.');
                              else if (event.status !== 'executed') setNotice(event.reason ?? 'Nothing was sold.');
                              await refreshBalances(publicKey);
                              if (useBot && bot) await refreshBotBalances(bot.publicKey);
                            })}
                            disabled={busy !== null || !(Number(demoSellAbove) > 0)}
                            className="text-xs bg-amber-400/90 hover:bg-amber-400 text-slate-900 disabled:opacity-50 px-3 py-2 rounded-lg font-medium"
                          >
                            {busy === 'force-exit' ? 'Checking…' : `Sell ${rule.trade.sellPercent}% if reached`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-5">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-white/70">Rule history</h3>
                    {events.length > 0 && (
                      <button
                        onClick={() => { automation.clearEvents(publicKey); setEvents([]); }}
                        className="text-xs text-white/40 hover:text-white/70"
                      >
                        clear
                      </button>
                    )}
                  </div>
                  {events.length === 0 ? (
                    <p className="text-sm text-white/40">No records yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {events.map(event => <EventItem key={event.id + event.at} event={event} />)}
                    </ul>
                  )}
                </div>
              </section>
            )}

            {jwt && tab === 'ai' && (
              <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                <h2 className="font-semibold mb-1 flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> Describe your strategy in plain language</h2>
                <p className="text-xs text-white/50 mb-4">
                  This fills in the Automation form for you — nothing runs until you review it there and press
                  &quot;Start automation&quot; yourself.
                </p>

                {rule.enabled ? (
                  <div className="bg-amber-500/10 border border-amber-400/30 rounded-xl p-4 text-sm text-amber-100 space-y-3">
                    <p>
                      ⚠️ An automation rule is already running. Generating a new strategy would overwrite it while
                      it may still be waiting on a buy/sell condition — stop the current rule first.
                    </p>
                    <button
                      onClick={requestPause}
                      className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      ⏸ Pause current automation
                    </button>
                  </div>
                ) : (
                  <>
                <textarea
                  value={aiPrompt}
                  onChange={event => setAiPrompt(event.target.value)}
                  placeholder='e.g. "Buy XLM with half of any USDC that arrives, but only while it is under 0.15 USDC. Sell it once it is back up 20%."'
                  rows={3}
                  className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-full text-sm"
                />
                <button
                  onClick={() => run('ai-generate', async () => {
                    setAiDraft(null);
                    const response = await fetch('/api/ai/strategy', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ prompt: aiPrompt }),
                    });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || 'Failed to generate strategy');
                    setAiDraft(data as StrategyDraft);
                  })}
                  disabled={busy !== null || !aiPrompt.trim()}
                  className="mt-3 bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
                >
                  {busy === 'ai-generate' ? 'Thinking…' : 'Generate rule'}
                </button>

                {aiDraft?.clarification && (
                  <div className="mt-4 bg-amber-500/10 border border-amber-400/30 rounded-xl p-4 text-sm text-amber-100">
                    🤔 {aiDraft.clarification}
                  </div>
                )}

                {aiDraft && !aiDraft.clarification && (
                  <div className="mt-4 bg-black/20 rounded-xl p-4 space-y-3">
                    <p className="text-sm text-white/80">{aiDraft.explanation}</p>
                    <button
                      onClick={() => {
                        const patch: Partial<automation.AutomationRule> = {};
                        if (aiDraft.mode) patch.mode = aiDraft.mode;
                        if (aiDraft.minAmount) patch.minAmount = aiDraft.minAmount;
                        if (aiDraft.maxPriceImpact) patch.maxPriceImpact = aiDraft.maxPriceImpact;
                        if (aiDraft.trade) {
                          patch.trade = {
                            asset: aiDraft.trade.asset,
                            buyPercent: aiDraft.trade.buyPercent ?? 0,
                            buyBelowUsdc: aiDraft.trade.buyBelowUsdc ?? '',
                            sellAboveUsdc: aiDraft.trade.sellAboveUsdc ?? '',
                            sellPercent: aiDraft.trade.sellPercent ?? 100,
                            offramp: aiDraft.trade.offramp ?? false,
                          };
                        }
                        if (aiDraft.allocations?.length) {
                          // The picker offers every asset except USDC, so a row naming it — or
                          // naming nothing — renders as a blank select the user cannot fix or
                          // explain. Filtered on the way in: a draft is a suggestion, and a
                          // suggestion the form cannot display is not one worth keeping.
                          const usable = aiDraft.allocations.filter(
                            row => row.asset && row.asset !== SOROSWAP_ROUTER_CONFIG.USDC
                          );
                          if (usable.length) {
                            patch.allocations = usable.map(row => ({ asset: row.asset, percent: row.percent ?? 0 }));
                          }
                        }
                        updateRule(patch);
                        setAiDraft(null);
                        setAiPrompt('');
                        setTab('automation');
                      }}
                      className="bg-accent hover:bg-accent-strong text-canvas px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      Fill the Automation form
                    </button>
                    <p className="text-xs text-white/40">
                      You&apos;ll land on the Automation tab with these fields pre-filled — review and adjust anything before starting.
                    </p>
                  </div>
                )}
                  </>
                )}
              </section>
            )}

            {jwt && tab === 'history' && (
              <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold flex items-center gap-2"><ScrollText className="w-4 h-4 text-accent" /> Transaction history</h2>
                  <div className="flex gap-1 bg-black/20 rounded-lg p-1">
                    {(['day', 'week', 'month'] as const).map(option => (
                      <button
                        key={option}
                        onClick={() => setHistoryGroupBy(option)}
                        className={`px-3 py-1.5 rounded-md text-xs capitalize ${
                          historyGroupBy === option ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white'
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
                  <button
                    onClick={() => run('chain-history', refreshChainHistory)}
                    disabled={busy !== null}
                    className="bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-1.5 rounded-lg"
                  >
                    {busy === 'chain-history' ? 'Reading the chain…' : 'Read from the contract'}
                  </button>
                  {chainHistoryError ? (
                    <span className="text-red-200/80">{chainHistoryError}</span>
                  ) : chainHistory ? (
                    <span className="text-white/40">
                      {chainEvents.length} entr{chainEvents.length === 1 ? 'y' : 'ies'} confirmed on chain
                      {chainHistory.truncated && ' · older ones are beyond what the RPC still keeps (about a week)'}
                    </span>
                  ) : (
                    <span className="text-white/40">
                      Records below are this browser&apos;s journal — read the contract to confirm them independently.
                    </span>
                  )}
                </div>

                {mergedEvents.length === 0 ? (
                  <p className="text-sm text-white/40">No records yet — this fills in as your automation rules run.</p>
                ) : (
                  <div className="space-y-5">
                    {groupEvents(mergedEvents, historyGroupBy).map(([label, group]) => (
                      <div key={label}>
                        <h3 className="text-xs font-medium text-white/50 mb-2">{label} · {group.length}</h3>
                        <ul className="space-y-2">
                          {group.map(event => (
                            <EventItem key={event.id + event.at} event={event} verified={isVerified(event)} />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {jwt && (
              <>
                {tab === 'onramp' && (
                <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h2 className="font-semibold mb-1">Deposit TRY → receive USDC</h2>
                  <p className="text-xs text-white/50 mb-4">
                    50 – 300 TRY per order · USDC{' '}
                    {useBot && bot ? (
                      <>arrives in the automation wallet ({bot.publicKey.slice(0, 6)}…{bot.publicKey.slice(-4)}); the rule runs without approval</>
                    ) : (
                      <>arrives in the connected wallet ({publicKey.slice(0, 6)}…{publicKey.slice(-4)})</>
                    )}
                  </p>

                  <div className="flex flex-wrap gap-3 items-end mb-4">
                    <label className="text-sm">
                      <span className="block text-white/60 mb-1">Amount (TRY)</span>
                      <input
                        value={tryAmount}
                        onChange={event => { setTryAmount(event.target.value); setQuote(null); }}
                        inputMode="decimal"
                        placeholder="50 – 300"
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-40 font-mono placeholder:text-white/30"
                      />
                    </label>
                    <button
                      onClick={() => run('deposit', async () => {
                        setDepositTx(null);
                        // Only the funded shape sends USDC to the automation wallet, which does its own SEP-10
                        // login; the SEP-38 quote is bound to the user, so those deposits use the live rate.
                        // Delegated mode must pay the user's own wallet — that is the account the bot pulls from.
                        if (useBot && bot && !delegated) {
                          const botSign = botWalletLib.botSigner(bot);
                          const botJwt = await anchor.authenticate(bot.publicKey, botSign);
                          // Without a trustline the anchor parks the payment in pending_trust, so open it up front
                          await anchor.ensureTrustline(bot.publicKey, botSign);
                          await refreshBotBalances(bot.publicKey);
                          setDepositJwt(botJwt);
                          setDeposit(await anchor.startDeposit(botJwt, { account: bot.publicKey, amount: depositSendAmount }));
                          return;
                        }
                        setDepositJwt(jwt);
                        // Opening the order is what consumes the quote; an expired one is dropped and
                        // the anchor falls back to the live rate, which is what this step prevents.
                        if (quote && quote.expiresAt.getTime() <= Date.now()) {
                          throw new anchor.AnchorError('The rate has expired — refresh it before opening the deposit.');
                        }
                        setDeposit(await anchor.startDeposit(jwt, {
                          account: publicKey,
                          amount: depositSendAmount,
                          quoteId: quote?.id,
                        }));
                      })}
                      disabled={busy !== null || !tryAmount || depositQuoting || (depositQuoteBinds && depositQuoteExpired)}
                      className="bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      {busy === 'deposit'
                        ? 'Opening…'
                        : quote && depositQuoteBinds
                          ? `Deposit for ${trimAmount(quote.buyAmount)} USDC`
                          : 'Start deposit'}
                    </button>
                  </div>

                  {depositQuoting && !quote && (
                    <p className="text-xs text-white/40 mb-4">Pricing {trimAmount(tryAmount)} TRY…</p>
                  )}

                  {depositQuoteError && !depositQuoting && (
                    <p className="text-xs text-amber-200/80 mb-4">
                      The anchor would not price this amount: {depositQuoteError}
                    </p>
                  )}

                  {quote && (() => {
                    // Deposit sells lira and buys USDC, so total_price already reads as lira per
                    // USDC — the inverse the withdrawal needs would be wrong here.
                    const rate = Number(quote.totalRate);
                    const msLeft = quote.expiresAt.getTime() - quoteClock;
                    const stale = depositQuoteBinds && depositQuoteExpired;
                    return (
                      <div className={`rounded-xl p-4 mb-4 text-sm border ${
                        stale ? 'bg-amber-500/10 border-amber-400/30' : 'bg-black/20 border-white/10'
                      }`}>
                        {/* Naming the standard is not decoration here: the id below is what the
                            anchor records against the settled transaction, so the two can be matched. */}
                        <div className="flex items-center justify-between gap-3 pb-2 mb-1 border-b border-white/10">
                          <span className="text-[11px] uppercase tracking-wide text-white/40">
                            {depositQuoteBinds ? 'SEP-38 firm quote' : 'SEP-38 quote · not attached'}
                          </span>
                          <span className="font-mono text-[11px] text-white/40 break-all">{quote.id}</span>
                        </div>
                        <Field label="You send" value={`${trimAmount(quote.sellAmount)} TRY`} />
                        <Field label="You receive" value={`${trimAmount(quote.buyAmount)} USDC`} />
                        <Field label="Rate" value={rate > 0 ? `1 USDC = ${rate.toFixed(4)} TRY` : '—'} />
                        <Field label="Fee" value={`${trimAmount(quote.fee.total)} ${assetLabel(quote.fee.asset)}`} />
                        <Field
                          label={depositQuoteExpired ? 'Expired at' : 'Held until'}
                          value={quote.expiresAt.toLocaleTimeString('en-US')}
                        />
                        <div className="flex items-start justify-between gap-3 mt-2">
                          <p className={`text-xs ${stale ? 'text-amber-200' : 'text-white/50'}`}>
                            {!depositQuoteBinds
                              ? 'Estimate only. This deposit pays the automation wallet, which logs in to the anchor ' +
                                'as itself — your quote cannot be attached to it, so the anchor converts at the live rate.'
                              : depositQuoteExpired
                                ? 'This rate is no longer held. Refresh it — otherwise the anchor converts at the live rate.'
                                : `Held for ${Math.floor(msLeft / 60000)}m ${String(Math.floor((msLeft % 60000) / 1000)).padStart(2, '0')}s. ` +
                                  'It is fixed the moment the order opens, and only for this amount: send a different sum to the bank and the anchor uses the live rate.'}
                          </p>
                          <button
                            onClick={() => run('quote', async () => {
                              setQuote(await anchor.getQuote(jwt, ANCHOR_CONFIG.FIAT_ASSET, usdcAsset, tryAmount.trim()));
                            })}
                            disabled={busy !== null || depositQuoting}
                            className={`shrink-0 text-xs px-3 py-1.5 rounded-lg disabled:opacity-50 ${
                              stale ? 'bg-amber-400/20 hover:bg-amber-400/30' : 'bg-white/10 hover:bg-white/20'
                            }`}
                          >
                            {busy === 'quote' ? 'Refreshing…' : 'Refresh rate'}
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  {deposit && (
                    <div className="bg-black/20 rounded-xl p-4 space-y-1">
                      <p className="text-sm text-white/70 mb-2">Send a bank transfer with these details:</p>
                      <Field label="IBAN" value={deposit.bankInstructions.iban} copyable />
                      <Field label="Description (reference)" value={deposit.bankInstructions.reference} copyable />
                      {deposit.bankInstructions.bankName && <Field label="Bank" value={deposit.bankInstructions.bankName} />}
                      <Field label="Order" value={deposit.id} />
                      <p className="text-xs text-amber-200/80 pt-2">
                        Without the reference in the description the transfer cannot be matched and needs manual support.
                      </p>

                      <div className="flex flex-wrap gap-3 pt-3">
                        <button
                          onClick={() => run('simulate', async () => {
                            await anchor.sandboxSimulateBankTransfer(deposit.id, depositSendAmount);
                            setNotice(`${trimAmount(depositSendAmount)} TRY marked as arrived. Waiting for the anchor to pay out the USDC…`);
                            // Same reason as the withdrawal: firing the transfer and then showing
                            // nothing until someone presses "Track" reads as though it failed.
                            try {
                              const result = await anchor.pollTransaction(depositJwt || jwtSource!, deposit.id, setDepositTx, { timeoutMs: 180000 });
                              setDepositTx(result);
                              await refreshBalances(publicKey);
                              // The deposit can land in the automation wallet rather than this one.
                              if (useBot && bot) await refreshBotBalances(bot.publicKey);
                              // The line above is progress, not an outcome. Polling returns on any
                              // terminal status, so leaving it up says "still waiting" after the
                              // anchor has already finished — which is what it settled on, below.
                              setNotice(
                                result.status === TERMINAL_OK
                                  ? result.amount_out
                                    ? `Paid out: ${trimAmount(result.amount_out)} USDC is in your wallet.`
                                    : 'The anchor paid out the USDC.'
                                  : `The anchor closed this deposit as "${result.status}"${result.message ? ` — ${result.message}` : ''}.`
                              );
                            } catch (caught) {
                              setNotice(
                                `${trimAmount(depositSendAmount)} TRY marked as arrived, but the anchor has not paid out yet ` +
                                  `(${(caught as Error).message}) — press "Track deposit" to check again.`
                              );
                            }
                          })}
                          disabled={busy !== null}
                          className="bg-purple-500 hover:bg-purple-600 disabled:opacity-50 px-4 py-2 rounded-lg text-sm"
                        >
                          {busy === 'simulate' ? 'Sending and tracking…' : `Sandbox: ${trimAmount(depositSendAmount)} TRY arrived`}
                        </button>
                        <button
                          onClick={() => run('track-deposit', async () => {
                            const result = await anchor.pollTransaction(depositJwt || jwtSource!, deposit.id, setDepositTx, { timeoutMs: 180000 });
                            setDepositTx(result);
                            await refreshBalances(publicKey);
                            if (useBot && bot) await refreshBotBalances(bot.publicKey);
                            if (result.amount_out) setWithdrawAmount(result.amount_out);
                          })}
                          disabled={busy !== null}
                          className="bg-white/10 hover:bg-white/20 disabled:opacity-50 px-4 py-2 rounded-lg text-sm"
                        >
                          {busy === 'track-deposit' ? 'Tracking…' : 'Track status'}
                        </button>
                        {/* Opening an order for the wrong amount was a dead end: pricing stops
                            once an order exists, so the form above goes quiet and the only way
                            back was a page reload. This only drops it from the screen — the order
                            stays open at the anchor, which is why the wording does not promise a
                            cancellation. */}
                        {!depositTx && (
                          <button
                            onClick={() => {
                              setDeposit(null);
                              setQuote(null);
                              setDepositQuoteError(null);
                              setNotice(
                                'Order dismissed here. It is still open at the anchor — if you already sent the ' +
                                  'transfer, use its reference or press Track status on the new one.'
                              );
                            }}
                            disabled={busy !== null}
                            className="text-xs text-white/40 hover:text-white/70 underline px-1"
                          >
                            Start over with a different amount
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {depositTx && (
                    <div className="mt-4 bg-black/20 rounded-xl p-4">
                      <span className={`inline-block px-3 py-1 rounded-full text-xs ${statusColor(depositTx.status)}`}>{depositTx.status}</span>
                      {depositTx.message && <p className="text-sm text-white/60 mt-2">{depositTx.message}</p>}
                      {depositTx.status === 'pending_trust' && (
                        <div className="mt-3 bg-amber-500/10 border border-amber-400/30 rounded-lg p-3">
                          <p className="text-sm text-amber-100 mb-2">
                            The anchor is holding the USDC: the destination has no USDC trustline. It settles on its own once you add one.
                          </p>
                          <button
                            onClick={() => run('fix-trust', async () => {
                              await ensureDepositTrustline();
                              const result = await anchor.pollTransaction(depositJwt || jwtSource!, deposit!.id, setDepositTx, { timeoutMs: 180000 });
                              setDepositTx(result);
                              await refreshBalances(publicKey);
                              if (useBot && bot) await refreshBotBalances(bot.publicKey);
                            })}
                            disabled={busy !== null}
                            className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-slate-900 px-4 py-2 rounded-lg text-sm font-medium"
                          >
                            {busy === 'fix-trust' ? 'Opening…' : 'Add USDC trustline and keep waiting'}
                          </button>
                        </div>
                      )}
                      {depositTx.status === TERMINAL_OK && (() => {
                        // The anchor's settled record, not the form: amount_in is the lira it really
                        // received, amount_out the USDC it really paid. The rate between them is the
                        // realised one, which is the only rate worth printing on a receipt.
                        const sent = depositTx.amount_in ?? depositSendAmount;
                        const got = depositTx.amount_out ?? undefined;
                        const realised = got && Number(got) > 0 ? Number(sent) / Number(got) : null;
                        return (
                          <div className="mt-3">
                            <div className="bg-emerald-500/10 border border-emerald-400/30 rounded-xl p-4 mb-3">
                              <p className="font-mono text-lg text-emerald-100 break-all">
                                {trimAmount(sent)} TRY
                                <span className="text-white/40 px-2">→</span>
                                {got ? trimAmount(got) : '—'} USDC
                              </p>
                              <p className="text-xs text-white/60 mt-1">
                                {realised ? `1 USDC = ${realised.toFixed(4)} TRY` : 'rate unavailable'}
                                {depositTx.amount_fee && (
                                  <> · anchor fee {trimAmount(depositTx.amount_fee)} {assetLabel(depositTx.amount_fee_asset)}</>
                                )}
                                {' · '}
                                {depositTx.quote_id
                                  ? 'rate locked before the transfer (SEP-38)'
                                  : 'converted by the anchor at settlement'}
                              </p>
                            </div>
                            <Field label="Received" value={`${trimAmount(depositTx.amount_out)} USDC`} />
                            <Field label="Sent" value={`${trimAmount(depositTx.amount_in)} TRY`} />
                            {depositTx.quote_id && (
                              <Field label="SEP-38 quote" value={String(depositTx.quote_id)} />
                            )}
                            {depositTx.external_transaction_id && (
                              <Field label="Bank reference" value={String(depositTx.external_transaction_id)} />
                            )}
                            {depositTx.stellar_transaction_id && (
                              <div className="pt-2">
                                <a
                                  className="text-xs text-blue-300 hover:text-blue-200 underline break-all"
                                  href={`https://stellar.expert/explorer/testnet/tx/${depositTx.stellar_transaction_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  The USDC leg on chain ↗
                                </a>
                                <p className="text-[11px] text-white/40 mt-1">
                                  Only this leg is on Stellar. The lira moved through the banking system, so the
                                  explorer shows the USDC payment and nothing else.
                                </p>
                              </div>
                            )}
                            {depositTx.claimable_balance_id && (
                              <p className="text-xs text-amber-200 mt-2">
                                No trustline, so a claimable balance was created: {depositTx.claimable_balance_id}
                              </p>
                            )}

                            {/* A settled order is finished, but the form kept showing its bank
                                details and its rate, so the way to start another was to guess
                                that retyping the amount would do it. This says what the state is
                                and offers the only thing left to do with it. */}
                            <div className="mt-4 pt-3 border-t border-white/10 flex flex-wrap items-center gap-3">
                              <button
                                onClick={() => {
                                  setDeposit(null);
                                  setDepositTx(null);
                                  setQuote(null);
                                  setDepositQuoteError(null);
                                  setTryAmount('');
                                  setNotice(null);
                                }}
                                className="bg-accent hover:bg-accent-strong text-canvas px-4 py-2 rounded-lg text-sm font-medium"
                              >
                                New deposit
                              </button>
                              <span className="text-[11px] text-white/40">
                                This order is complete. Starting another asks the anchor for a fresh rate and a
                                new reference — the bank details above belong to the transfer you already made.
                              </span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </section>

                )}


                {tab === 'offramp' && (
                <>
                <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h2 className="font-semibold mb-1">Where does the USDC come from?</h2>
                  <p className="text-xs text-white/50 mb-4">
                    Both routes end in the same payout to your IBAN. Pick whichever matches what you are holding.
                  </p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {([
                      ['balance', 'USDC I already hold', balances ? `${Number(balances.balance).toLocaleString('en-US', { maximumFractionDigits: 7 })} USDC in this wallet` : 'reading balance…'],
                      ['sell', 'Sell an asset first', sellableTotal > BigInt(0) ? `≈ ${allowanceLib.formatStroops(sellableTotal)} USDC from ${sellableRows.map(row => row.symbol).join(', ')}` : holdingsLoading ? 'checking what you hold…' : holdings === null ? 'XLM, BTC, gold and the rest' : 'nothing else worth selling'],
                    ] as const).map(([key, title, detail]) => (
                      <button
                        key={key}
                        onClick={() => setWithdrawSource(key)}
                        className={`text-left rounded-xl px-4 py-3 border transition ${
                          withdrawSource === key
                            ? 'bg-emerald-500/15 border-emerald-400/40'
                            : 'bg-black/20 border-white/10 hover:bg-white/10'
                        }`}
                      >
                        <span className="block text-sm font-medium">{title}</span>
                        <span className="block text-xs text-white/50 mt-0.5 font-mono">{detail}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {withdrawSource === 'sell' && (
                <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <h2 className="font-semibold">
                      1 ·{' '}
                      {sellableTotal > BigInt(0) ? (
                        <>Sell — your assets are worth{' '}
                          <span className="text-emerald-300">≈ {allowanceLib.formatStroops(sellableTotal)} USDC</span>
                        </>
                      ) : (
                        'Sell an asset for USDC'
                      )}
                    </h2>
                    <button
                      onClick={() => run('holdings', loadHoldings)}
                      disabled={busy !== null}
                      className="text-[11px] text-white/40 hover:text-white/70 disabled:opacity-50 underline decoration-dotted"
                    >
                      {busy === 'holdings' ? 'reading…' : 'refresh balances'}
                    </button>
                  </div>
                  <p className="text-xs text-white/50 mb-4">
                    {holdingsLoading
                      ? 'Reading what this wallet holds…'
                      : sellableTotal > BigInt(0)
                        ? `Holding ${sellableRows.map(row => row.symbol).join(', ')}. Selling leaves USDC in your wallet; taking it to lira is the withdraw tab, and the two are independent.`
                        : holdings === null
                          ? 'Swaps go through Soroswap and leave USDC in your wallet.'
                          : 'Nothing worth selling in this wallet right now.'}
                  </p>
                  {holdings === null || holdingsLoading ? (
                    <p className="text-sm text-white/40">Reading your balances…</p>
                  ) : holdings.length === 0 ? (
                    <p className="text-sm text-white/40">Nothing to sell — this wallet holds none of the supported assets.</p>
                  ) : (
                    <div className="space-y-4">
                      <ul className="space-y-1.5">
                        {holdings.map(row => {
                          // A blocked row is still selectable when part of it fits: locking the user
                          // out of their own asset is what makes a protective limit feel like a fault.
                          // Selecting it fills in the slice that fits, not the amount that does not.
                          const offered = row.blocked ? row.withinCeiling : row.amount;
                          const selectable = !!row.usdc && !!offered;
                          return (
                            <li key={row.asset}>
                              <button
                                onClick={() => {
                                  setSellAsset(row.asset);
                                  setSellAmount(allowanceLib.fromStroops(offered ?? row.amount));
                                  setAcceptImpact(false);
                                }}
                                disabled={!selectable}
                                className={`w-full text-left rounded-lg px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2 border ${
                                  sellAsset === row.asset
                                    ? 'bg-emerald-500/15 border-emerald-400/40'
                                    : selectable
                                      ? 'bg-black/20 border-white/10 hover:bg-white/10'
                                      : 'bg-black/20 border-white/5 opacity-60 cursor-not-allowed'
                                }`}
                              >
                                <span className="font-mono text-white/85">
                                  {allowanceLib.formatStroops(row.amount)} {row.symbol}
                                </span>
                                <span className="font-mono text-white/60">
                                  {row.error
                                    ? <span className="text-red-200">{row.error}</span>
                                    : row.blocked
                                      ? (
                                        <span className="text-amber-200">
                                          {row.withinCeiling
                                            ? `sell up to ${allowanceLib.formatStroops(row.withinCeiling)} ${row.symbol} →`
                                            : 'pool too thin →'}
                                        </span>
                                      )
                                      : `≈ ${allowanceLib.formatStroops(row.usdc ?? BigInt(0))} USDC`}
                                </span>
                              </button>

                              {/* One sentence about the decision, not about the mechanism. The pool,
                                  the percentage and the limit are the app's problem; the cost in
                                  money and the two ways forward are the user's. */}
                              {row.blocked && (
                                <p className="text-[11px] text-white/45 px-3 pt-1 pb-1">
                                  Selling all of it at once costs about{' '}
                                  <b className="text-amber-200/90">{usdcCost(row.impactCostUsdc ?? BigInt(0))} USDC</b>{' '}
                                  extra — there is not much {row.symbol} being traded right now.{' '}
                                  {row.withinCeiling && (
                                    <>Selling {allowanceLib.formatStroops(row.withinCeiling)} avoids it. </>
                                  )}
                                  <button
                                    onClick={() => {
                                      setSellAsset(row.asset);
                                      setSellAmount(allowanceLib.fromStroops(row.amount));
                                      setAcceptImpact(true);
                                    }}
                                    className="underline text-white/60 hover:text-white/90"
                                  >
                                    Sell all anyway
                                  </button>
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>

                      {selectedHolding && (
                        <div className="bg-black/20 rounded-xl p-4 space-y-3">
                          <div className="flex flex-wrap gap-3 items-end">
                            <label className="text-sm">
                              <span className="block text-white/60 mb-1">Amount to sell ({selectedHolding.symbol})</span>
                              <input
                                value={sellAmount}
                                onChange={event => { setSellAmount(event.target.value); setAcceptImpact(false); }}
                                className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-48 font-mono"
                              />
                            </label>
                            <button
                              onClick={() => { setSellAmount(allowanceLib.fromStroops(selectedHolding.amount)); setAcceptImpact(false); }}
                              className="text-xs bg-white/10 hover:bg-white/20 px-3 py-2 rounded-lg"
                            >
                              max
                            </button>
                            {selectedHolding.withinCeiling && (
                              <button
                                onClick={() => { setSellAmount(allowanceLib.fromStroops(selectedHolding.withinCeiling!)); setAcceptImpact(false); }}
                                className="text-xs bg-amber-400/15 hover:bg-amber-400/25 text-amber-100 px-3 py-2 rounded-lg"
                              >
                                most it can take ({allowanceLib.formatStroops(selectedHolding.withinCeiling)})
                              </button>
                            )}
                          </div>

                          <div className="text-sm space-y-1">
                            <p className="text-white/80">
                              {sellAmount || '0'} {selectedHolding.symbol} → ≈{' '}
                              <b>{sellProceeds === null ? '—' : allowanceLib.formatStroops(sellProceeds)} USDC</b>
                              {/* The quoted impact belongs to the whole holding. Showing it beside a
                                  smaller amount would overstate what that amount actually costs, so
                                  it only appears while the full amount is the one selected. */}
                              {selectedHolding.priceImpactPct
                                && Number(selectedHolding.priceImpactPct) > 1
                                && allowanceLib.toStroops(sellAmount || '0') === selectedHolding.amount && (
                                <span className="text-amber-200"> · price impact {selectedHolding.priceImpactPct}%</span>
                              )}
                            </p>
                            <p className="text-white/80">
                              {sellTry ? (
                                <>≈ <b>{Number(sellTry).toLocaleString('en-US', { maximumFractionDigits: 2 })} TRY</b>
                                  <span className="text-white/40"> at the anchor&apos;s indicative SEP-38 rate</span></>
                              ) : (
                                <span className="text-white/40">
                                  No lira quote for this size
                                  {withdrawBand
                                    ? ` — the anchor only prices withdrawals between ${withdrawBand.min ?? '?'} and ${withdrawBand.max ?? '?'} USDC`
                                    : ' — it may be outside the anchor’s withdrawal limits'}
                                  . Selling a smaller amount, or withdrawing in parts, stays inside the band.
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] text-white/40">
                              Both figures are estimates: the pool is re-quoted when the sale runs, and the anchor prices
                              the withdrawal when it opens.
                              {selectedHolding.asset === SOROSWAP_ROUTER_CONFIG.XLM && (
                                <> Selling the maximum is safe — your account&apos;s minimum reserve and a 1 XLM buffer
                                  for transaction fees are already held back, so they are not part of the figure above.</>
                              )}
                            </p>
                          </div>

                          <button
                            onClick={() => run('sell', runSell)}
                            disabled={busy !== null || sellProceeds === null}
                            className="bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
                          >
                            {/* Never a silent mode: if the limit is being waived, the button says so. */}
                            {busy === 'sell'
                              ? 'Selling…'
                              : acceptImpact && selectedHolding.impactCostUsdc
                                ? `Sell for USDC — accepting about ${usdcCost(selectedHolding.impactCostUsdc)} USDC less`
                                : 'Sell for USDC'}
                          </button>

                          <p className="text-[11px] text-white/40">
                            Your wallet signs this swap, out of your own balance — this step is separate from the
                            automation rule and is not affected by its signer mode or its mandate. The proceeds land
                            as USDC and fill in the withdrawal below, which needs your signature too.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </section>
                )}


                {!sellStepDone && (
                  <p className="text-xs text-white/35 px-2">
                    Next: your payout details — they open once the sale goes through.
                  </p>
                )}

                {sellStepDone && (
                <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h2 className="font-semibold mb-1">
                    {withdrawSource === 'sell' ? '2 · ' : '1 · '}Your TRY payout details (SEP-12)
                  </h2>
                  <p className="text-xs text-white/50 mb-1">
                    The IBAN decides where the lira lands — leave it empty and the anchor pays a sandbox account instead.
                    Details are written into the transaction when a withdrawal opens, so change them before opening a new one.
                  </p>
                  <p className="text-xs text-amber-200/70 mb-4">
                    The name is <b>optional against this testnet anchor</b> and <b>required by a production one</b>, where the
                    bank checks it against the IBAN before releasing the transfer.
                  </p>
                  <div className="flex flex-wrap gap-3 items-end">
                    <label className="text-sm">
                      <span className="block text-white/60 mb-1">IBAN</span>
                      <input
                        value={iban}
                        onChange={event => { setIban(normalizeIban(event.target.value)); setCustomerStatus(''); }}
                        aria-label="Recipient IBAN"
                        aria-invalid={!!iban && !!ibanError}
                        aria-describedby="payout-iban-error"
                        placeholder="TR.. (26 chars)"
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 font-mono w-80"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="block text-white/60 mb-1">
                        Account holder — first name <span className="text-white/35">· optional here</span>
                      </span>
                      <input
                        value={holderFirstName}
                        onChange={event => setHolderFirstName(event.target.value)}
                        placeholder="Murat"
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-44"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="block text-white/60 mb-1">
                        Last name <span className="text-white/35">· optional here</span>
                      </span>
                      <input
                        value={holderLastName}
                        onChange={event => setHolderLastName(event.target.value)}
                        placeholder="Keskin"
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-44"
                      />
                    </label>
                    <button
                      onClick={() => run('kyc', async () => {
                        await savePayoutDetails(jwt);
                      })}
                      disabled={busy !== null || !!ibanError}
                      className="bg-white/10 hover:bg-white/20 disabled:opacity-50 px-4 py-2 rounded-lg text-sm"
                    >
                      {busy === 'kyc' ? 'Saving…' : 'Save payout details'}
                    </button>
                    {customerStatus && (
                      <span className={`text-sm ${customerStatus === 'ACCEPTED' ? 'text-emerald-200' : 'text-amber-200'}`}>
                        {customerStatus === 'ACCEPTED' ? '✅' : '⚠️'} {customerStatus}
                      </span>
                    )}
                  </div>
                  <p id="payout-iban-error" aria-live="polite" className="text-xs text-amber-200 mt-2">
                    {iban ? ibanError : null}
                  </p>
                  {customerMissing.length > 0 && (
                    <p className="text-xs text-amber-200/80 mt-3">
                      The anchor still requires: {customerMissing.join(', ')}. The withdrawal will not settle until it has them.
                    </p>
                  )}

                  <label className="flex items-start gap-2 text-xs text-white/50 mt-4">
                    <input
                      type="checkbox"
                      checked={rememberPayout}
                      onChange={event => { setRememberPayout(event.target.checked); persistPayout(event.target.checked); }}
                      className="mt-0.5"
                    />
                    <span>
                      Remember these details for next time. Off by default: otherwise you would confirm each payout
                      against an account you had not looked at. Ticking it keeps the IBAN and name in this browser only
                      — clearing it removes them.
                    </span>
                  </label>
                </section>
                )}

                {/* 5. USDC → TRY */}
                {sellStepDone && !payoutStepDone && (
                  <p className="text-xs text-white/35 px-2">
                    Next: sending the USDC — this opens once the anchor has accepted your payout details.
                  </p>
                )}

                {payoutStepDone && (
                <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h2 className="font-semibold mb-1">
                    {withdrawSource === 'sell' ? '3 · ' : '2 · '}Send USDC → receive TRY
                  </h2>
                  <p className="text-xs text-white/50 mb-4">
                    {withdrawSource === 'sell'
                      ? 'Your wallet now holds '
                      : 'Your wallet holds '}
                    <b className="text-white/70">
                      {balances ? `${Number(balances.balance).toLocaleString('en-US', { maximumFractionDigits: 7 })} USDC` : '…'}
                    </b>
                    . Minimum 1 USDC, and the payment carries a memo — without it the anchor cannot match it.
                  </p>

                  <div className="flex flex-wrap gap-3 items-end mb-4">
                    <label className="text-sm">
                      <span className="block text-white/60 mb-1">Amount (USDC)</span>
                      <input
                        value={withdrawAmount}
                        onChange={event => { setWithdrawAmount(event.target.value); setWithdrawQuote(null); }}
                        placeholder={balances?.balance ?? '0'}
                        className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 w-40 font-mono"
                      />
                    </label>
                    {balances && Number(balances.balance) > 0 && (
                      <button
                        onClick={() => { setWithdrawAmount(balances.balance); setWithdrawQuote(null); }}
                        className="text-xs bg-white/10 hover:bg-white/20 px-3 py-2 rounded-lg"
                      >
                        all
                      </button>
                    )}
                    <button
                      onClick={() => run('withdraw', async () => {
                        setWithdrawTx(null);
                        // Opening the withdrawal is what consumes the quote. Sending it expired means
                        // the anchor drops the locked rate and prices the payout at settlement, which
                        // is the one thing this step exists to prevent.
                        if (withdrawQuote && withdrawQuote.expiresAt.getTime() <= Date.now()) {
                          throw new anchor.AnchorError('The rate has expired — refresh it before opening the withdrawal.');
                        }
                        setWithdraw(await anchor.startWithdraw(jwt, {
                          amount: withdrawSendAmount,
                          quoteId: withdrawQuote?.id,
                        }));
                      })}
                      disabled={busy !== null || !withdrawAmount || withdrawQuoting || withdrawQuoteExpired}
                      className="bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      {busy === 'withdraw'
                        ? 'Opening…'
                        : withdrawQuote
                          ? `Withdraw at ${trimAmount(withdrawQuote.buyAmount)} TRY`
                          : 'Start withdrawal'}
                    </button>
                  </div>

                  {withdrawQuoting && !withdrawQuote && (
                    <p className="text-xs text-white/40 mb-4">Pricing {trimAmount(withdrawAmount)} USDC…</p>
                  )}

                  {withdrawQuoteError && !withdrawQuoting && (
                    <p className="text-xs text-amber-200/80 mb-4">
                      The anchor would not price this amount: {withdrawQuoteError}
                    </p>
                  )}

                  {withdrawQuote && (() => {
                    const rate = tryPerUsdc(withdrawQuote.totalRate);
                    const msLeft = withdrawQuote.expiresAt.getTime() - quoteClock;
                    return (
                      <div className={`rounded-xl p-4 mb-4 text-sm border ${
                        withdrawQuoteExpired ? 'bg-amber-500/10 border-amber-400/30' : 'bg-black/20 border-white/10'
                      }`}>
                        {/* The id is what the anchor records against the settled transaction, so the
                            rate shown here can be matched to the one it actually paid out at. */}
                        <div className="flex items-center justify-between gap-3 pb-2 mb-1 border-b border-white/10">
                          <span className="text-[11px] uppercase tracking-wide text-white/40">SEP-38 firm quote</span>
                          <span className="font-mono text-[11px] text-white/40 break-all">{withdrawQuote.id}</span>
                        </div>
                        <Field label="You send" value={`${trimAmount(withdrawQuote.sellAmount)} USDC`} />
                        <Field label="You receive" value={`${trimAmount(withdrawQuote.buyAmount)} TRY`} />
                        <Field label="Rate" value={rate ? `1 USDC = ${rate.toFixed(4)} TRY` : '—'} />
                        <Field
                          label="Fee"
                          value={`${trimAmount(withdrawQuote.fee.total)} ${assetLabel(withdrawQuote.fee.asset)}`}
                        />
                        <Field
                          label={withdrawQuoteExpired ? 'Expired at' : 'Held until'}
                          value={withdrawQuote.expiresAt.toLocaleTimeString('en-US')}
                        />
                        <div className="flex items-start justify-between gap-3 mt-2">
                          <p className={`text-xs ${withdrawQuoteExpired ? 'text-amber-200' : 'text-white/50'}`}>
                            {withdrawQuoteExpired
                              ? 'This rate is no longer held. Refresh it — otherwise the anchor prices the payout when it settles.'
                              : `Held for ${Math.floor(msLeft / 60000)}m ${String(Math.floor((msLeft % 60000) / 1000)).padStart(2, '0')}s. ` +
                                'It is fixed the moment the withdrawal opens, and covers this amount only.'}
                          </p>
                          <button
                            onClick={() => run('withdraw-quote', async () => {
                              setWithdrawQuote(
                                await anchor.getQuote(jwt, usdcAsset, ANCHOR_CONFIG.FIAT_ASSET, withdrawAmount.trim())
                              );
                            })}
                            disabled={busy !== null || withdrawQuoting}
                            className={`shrink-0 text-xs px-3 py-1.5 rounded-lg disabled:opacity-50 ${
                              withdrawQuoteExpired ? 'bg-amber-400/20 hover:bg-amber-400/30' : 'bg-white/10 hover:bg-white/20'
                            }`}
                          >
                            {busy === 'withdraw-quote' ? 'Refreshing…' : 'Refresh rate'}
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  {withdraw && (
                    <div className="bg-black/20 rounded-xl p-4">
                      <Field label="Anchor address" value={withdraw.destinationAccount} copyable />
                      <Field label={`Memo (${withdraw.memoType})`} value={withdraw.memo} copyable />
                      {withdrawQuote && (
                        <Field label="Settles at" value={`${trimAmount(withdrawQuote.buyAmount)} TRY (rate locked)`} />
                      )}
                      <div className="flex flex-wrap gap-3 pt-3">
                        <button
                          onClick={() => run('pay', async () => {
                            await anchor.payWithdraw({ sourceAccount: publicKey, withdraw, amount: withdrawSendAmount }, signTransaction);
                            await refreshBalances(publicKey);
                            setNotice(`Sent ${trimAmount(withdrawSendAmount)} USDC with the memo. Waiting for the anchor to settle it…`);

                            // Track it straight away. Without this the payment landed on chain and
                            // the page showed nothing until someone thought to press "Track status".
                            try {
                              const result = await anchor.pollTransaction(jwtSource!, withdraw.id, setWithdrawTx, { timeoutMs: 240000 });
                              setWithdrawTx(result);
                              await refreshBalances(publicKey);
                              // Replaces the "waiting" line above once the anchor is actually done.
                              setNotice(
                                result.status === TERMINAL_OK
                                  ? result.amount_out
                                    ? `Settled: ${trimAmount(result.amount_out)} TRY is on its way to your bank account.`
                                    : 'The anchor settled the withdrawal.'
                                  : `The anchor closed this withdrawal as "${result.status}"${result.message ? ` — ${result.message}` : ''}.`
                              );
                            } catch (caught) {
                              // The payment is already made; a slow or unreachable anchor must not be
                              // reported as a failed transfer.
                              setNotice(
                                `Sent ${trimAmount(withdrawSendAmount)} USDC with the memo. The anchor has not settled it yet ` +
                                  `(${(caught as Error).message}) — press "Track status" to check again.`
                              );
                            }
                          })}
                          disabled={busy !== null}
                          className="bg-accent hover:bg-accent-strong text-canvas disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
                        >
                          {busy === 'pay' ? 'Sending and tracking…' : `Send ${trimAmount(withdrawSendAmount)} USDC (memo attached)`}
                        </button>
                        <button
                          onClick={() => run('track-withdraw', async () => {
                            setWithdrawTx(await anchor.pollTransaction(jwtSource!, withdraw.id, setWithdrawTx, { timeoutMs: 240000 }));
                          })}
                          disabled={busy !== null}
                          className="bg-white/10 hover:bg-white/20 disabled:opacity-50 px-4 py-2 rounded-lg text-sm"
                        >
                          {busy === 'track-withdraw' ? 'Tracking…' : 'Track status'}
                        </button>
                      </div>
                    </div>
                  )}

                  {withdrawTx && (
                    <div className="mt-4 bg-black/20 rounded-xl p-4">
                      <span className={`inline-block px-3 py-1 rounded-full text-xs ${statusColor(withdrawTx.status)}`}>{withdrawTx.status}</span>
                      {withdrawTx.message && <p className="text-sm text-white/60 mt-2">{withdrawTx.message}</p>}
                      {withdrawTx.status === TERMINAL_OK && (() => {
                        // The anchor's own figures, not the ones typed into the form: this is the
                        // settled record, so amount_in is what it actually received and amount_out
                        // what it actually paid. The rate is derived from those two, which makes it
                        // the realised rate rather than the quoted one.
                        const sent = withdrawTx.amount_in ?? withdrawSendAmount;
                        const paid = withdrawTx.amount_out ?? undefined;
                        const realised = paid && Number(sent) > 0 ? Number(paid) / Number(sent) : null;
                        return (
                          <div className="mt-3">
                            <div className="bg-emerald-500/10 border border-emerald-400/30 rounded-xl p-4 mb-3">
                              <p className="font-mono text-lg text-emerald-100 break-all">
                                {trimAmount(sent)} USDC
                                <span className="text-white/40 px-2">→</span>
                                {paid ? trimAmount(paid) : '—'} TRY
                              </p>
                              <p className="text-xs text-white/60 mt-1">
                                {realised ? `1 USDC = ${realised.toFixed(4)} TRY` : 'rate unavailable'}
                                {withdrawTx.amount_fee && (
                                  <> · anchor fee {trimAmount(withdrawTx.amount_fee)} {assetLabel(withdrawTx.amount_fee_asset)}</>
                                )}
                                {' · '}
                                {withdrawTx.quote_id
                                  ? 'rate locked before sending (SEP-38)'
                                  : 'priced by the anchor at settlement'}
                              </p>
                            </div>
                            <Field label="Paid out" value={`${trimAmount(withdrawTx.amount_out)} TRY`} />
                            {withdrawTx.quote_id && (
                              <Field label="SEP-38 quote" value={String(withdrawTx.quote_id)} />
                            )}
                            <Field label="IBAN" value={String(withdrawTx.to)} />
                            <Field label="Bank reference" value={String(withdrawTx.external_transaction_id)} />
                            {withdrawTx.stellar_transaction_id && (
                              <div className="pt-2">
                                <a
                                  href={`https://stellar.expert/explorer/testnet/tx/${withdrawTx.stellar_transaction_id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-blue-300 hover:text-blue-200 underline break-all"
                                >
                                  The USDC leg on chain ↗
                                </a>
                                <p className="text-[11px] text-white/40 mt-1">
                                  Only this leg is on Stellar. The lira moved through the banking system, so the
                                  explorer shows the USDC payment and nothing else.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {anchor.TERMINAL_STATUSES.has(withdrawTx.status) && (
                        <button
                          onClick={startAnotherWithdrawal}
                          className="mt-4 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm"
                        >
                          Start another withdrawal
                        </button>
                      )}
                    </div>
                  )}
                </section>
                )}
                </>
                )}
              </>
            )}
          </>
        )}

        {/* What this is built on, at the bottom where a colophon belongs. In the header it sat
            under the product name as though it were the tagline, so the first thing anyone read
            about Conduit was a list of protocol numbers. */}
        <footer className="pt-2 pb-8 text-center space-y-1">
          <p className="text-xs text-white/40">
            Testnet sandbox. No real money moves; the bank leg is simulated.
          </p>
          <p className="text-[11px] text-white/25 font-mono">
            TRY ⇄ USDC · {ANCHOR_CONFIG.HOME_DOMAIN} · SEP-6 / 10 / 12 / 38
          </p>
        </footer>
      </div>
    </div>
  );
}
