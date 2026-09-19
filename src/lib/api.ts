import {
  Account,
  Address,
  Contract,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { QuoteRequest, Quote, BuildRequest, BuildResponse, SendRequest, SendResponse } from '@/types';
import { SOROSWAP_ROUTER_CONFIG } from './constants';

// The Soroswap API indexer does not see testnet pools ("No path found"), yet the pools exist on chain.
// This class keeps the same interface (getQuote → buildTransaction → sendTransaction) but calls the router contract directly.
// No API key needed; works both in the browser and on the server (MultisigSwapTrader).

const DEFAULT_SLIPPAGE_BPS = 500;

type SwapPath = string[];

interface RawRouterTrade {
  amountIn: string;
  amountOutMin: string;
  path: SwapPath;
}

const shortId = (id: string): string => `${id.slice(0, 6)}…${id.slice(-4)}`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The SDK throws some errors as { code, message } objects rather than Error instances (e.g. getAccount 404)
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

class SoroswapAPI {
  private server: rpc.Server;
  private horizon: Horizon.Server;
  private router: Contract;

  constructor() {
    this.server = new rpc.Server(SOROSWAP_ROUTER_CONFIG.RPC_URL);
    this.horizon = new Horizon.Server(SOROSWAP_ROUTER_CONFIG.HORIZON_URL);
    this.router = new Contract(SOROSWAP_ROUTER_CONFIG.ROUTER);
  }

  private async simulate(
    operation: xdr.Operation,
    source: Account
  ): Promise<{ transaction: Transaction; simulation: rpc.Api.SimulateTransactionSuccessResponse }> {
    const transaction = new TransactionBuilder(source, {
      fee: '100',
      networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(SOROSWAP_ROUTER_CONFIG.TX_DEADLINE_SECONDS)
      .build();

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.server.simulateTransaction(transaction);
    } catch (error) {
      console.error('❌ Soroban RPC simulate error:', error);
      throw new Error(`Network Error - Soroban RPC unreachable: ${errorMessage(error)}`);
    }

    if (rpc.Api.isSimulationError(simulation)) {
      const detail = simulation.error.split('\n')[0];
      // Stellar Asset Contract error #13 = TrustlineMissing. It does not say which side is at
      // fault: an account needs a trustline both to receive the output and to spend the input,
      // and the same code comes back either way. Naming only the output sent debugging down the
      // wrong path once already.
      if (detail.includes('Error(Contract, #13)')) {
        throw new Error(
          `Simulation failed: the account is missing a trustline for one of the swap's assets — ` +
            `it needs one for the asset it spends as well as the asset it receives (${detail})`
        );
      }
      throw new Error(`Simulation failed: ${detail}`);
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new Error('Simulation failed: contract state is archived and must be restored first');
    }

    return { transaction, simulation };
  }

  // Read-only calls only need a throwaway source account that does not have to exist on chain
  private readOnlySource(): Account {
    return new Account(Keypair.random().publicKey(), '0');
  }

  private async readRouter(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const { simulation } = await this.simulate(this.router.call(method, ...args), this.readOnlySource());
    if (!simulation.result) {
      throw new Error(`Router ${method} returned no result`);
    }
    return scValToNative(simulation.result.retval);
  }

  private pathToScVal(path: SwapPath): xdr.ScVal {
    return xdr.ScVal.scvVec(path.map(id => new Address(id).toScVal()));
  }

  private async getAmountsOut(amountIn: bigint, path: SwapPath): Promise<bigint[]> {
    const amounts = await this.readRouter(
      'router_get_amounts_out',
      nativeToScVal(amountIn, { type: 'i128' }),
      this.pathToScVal(path)
    );
    return amounts as bigint[];
  }

  /**
   * The largest input that still lands under `maxImpactPct` on a direct pool.
   *
   * Solved rather than searched, so it costs one read instead of a dozen quotes. With the 0.3%
   * pool fee, impact = 1 - 997·Rin / (1000·Rin + 997·x), which inverts to
   * x = Rin · (1/(1-p) - 1000/997).
   *
   * Aimed at 95% of the ceiling rather than at it. Solving for the ceiling exactly lands on the
   * boundary, and measured against the router it came out a hair *over* every time — the router
   * truncates on integer division, which costs a little output and so reads as a little more
   * impact (checked on testnet: EURC/XLM 3.0000%, XAU 3.0077%, all rejected). The margin also
   * absorbs the reserves moving between this read and the sale, since the amount suggested here
   * is re-quoted before anything is signed.
   *
   * Direct pairs only: a multi-hop route compounds two curves and has no single closed form, so
   * this returns null rather than a number that would look authoritative and be wrong.
   */
  async maxAmountInForImpact(assetIn: string, assetOut: string, maxImpactPct: number): Promise<bigint | null> {
    if (!(maxImpactPct > 0) || maxImpactPct >= 100) return null;
    try {
      const [reserveIn] = (await this.readRouter(
        'get_reserves',
        new Address(SOROSWAP_ROUTER_CONFIG.FACTORY).toScVal(),
        new Address(assetIn).toScVal(),
        new Address(assetOut).toScVal()
      )) as bigint[];
      const target = (maxImpactPct * 0.95) / 100;
      const factor = 1 / (1 - target) - 1000 / 997;
      if (!(factor > 0)) return null;
      const max = BigInt(Math.floor(Number(reserveIn) * factor));
      return max > BigInt(0) ? max : null;
    } catch {
      return null; // no direct pool, or the read failed — the caller just omits the suggestion
    }
  }

  // Price impact against the pool spot price (includes the 0.3% pool fee)
  private async getPriceImpactPct(amountIn: bigint, amountOut: bigint, path: SwapPath): Promise<string> {
    let spotRate = 1;
    for (let i = 0; i < path.length - 1; i++) {
      const [reserveIn, reserveOut] = (await this.readRouter(
        'get_reserves',
        new Address(SOROSWAP_ROUTER_CONFIG.FACTORY).toScVal(),
        new Address(path[i]).toScVal(),
        new Address(path[i + 1]).toScVal()
      )) as bigint[];
      spotRate *= Number(reserveOut) / Number(reserveIn);
    }
    const spotOut = Number(amountIn) * spotRate;
    const impact = spotOut > 0 ? Math.max(0, (1 - Number(amountOut) / spotOut) * 100) : 0;
    return impact.toFixed(4);
  }

  private candidatePaths(assetIn: string, assetOut: string, maxHops: number): SwapPath[] {
    const paths: SwapPath[] = [[assetIn, assetOut]];
    const hub = SOROSWAP_ROUTER_CONFIG.XLM;
    if (maxHops >= 2 && assetIn !== hub && assetOut !== hub) {
      paths.push([assetIn, hub, assetOut]);
    }
    return paths;
  }

  async getQuote(request: QuoteRequest): Promise<Quote> {
    console.log('🌐 Router Quote Called');
    console.log('📤 Quote request:', JSON.stringify(request, null, 2));

    if (request.assetIn === request.assetOut) {
      throw new Error('assetIn and assetOut must be different');
    }

    let amountIn: bigint;
    try {
      amountIn = BigInt(request.amount);
    } catch {
      throw new Error(`Invalid amount: ${request.amount}`);
    }
    if (amountIn <= BigInt(0)) {
      throw new Error(`Invalid amount: ${request.amount}`);
    }

    // MultisigSwapTrader still sends the legacy field name (slippageTolerance)
    const legacySlippage = (request as QuoteRequest & { slippageTolerance?: number }).slippageTolerance;
    const slippageBps = request.slippageBps ?? legacySlippage ?? DEFAULT_SLIPPAGE_BPS;
    if (slippageBps < 0 || slippageBps >= 10000) {
      throw new Error(`Invalid slippageBps: ${slippageBps}`);
    }

    let path: SwapPath | null = null;
    let amounts: bigint[] = [];
    for (const candidate of this.candidatePaths(request.assetIn, request.assetOut, request.maxHops ?? 1)) {
      try {
        amounts = await this.getAmountsOut(amountIn, candidate);
        path = candidate;
        break;
      } catch (error) {
        // With no pool the router returns Storage/MissingValue; try the next route
        if (errorMessage(error).includes('MissingValue')) {
          console.log(`⚠️ No pool for path ${candidate.map(shortId).join(' → ')}`);
          continue;
        }
        console.error('🔥 Router quote error:', error);
        throw error;
      }
    }

    if (!path) {
      throw new Error(
        `No Soroswap testnet pool for ${shortId(request.assetIn)} → ${shortId(request.assetOut)}`
      );
    }

    const amountOut = amounts[amounts.length - 1];
    if (amountOut <= BigInt(0)) {
      throw new Error('Amount too small: router returned zero output');
    }
    const amountOutMin = (amountOut * BigInt(10000 - slippageBps)) / BigInt(10000);
    const priceImpactPct = await this.getPriceImpactPct(amountIn, amountOut, path);

    const rawTrade: RawRouterTrade = {
      amountIn: amountIn.toString(),
      amountOutMin: amountOutMin.toString(),
      path,
    };

    const quote: Quote = {
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      otherAmountThreshold: amountOutMin.toString(),
      priceImpactPct,
      tradeType: 'EXACT_IN',
      platform: 'soroswap-router',
      rawTrade,
      routePlan: [{ swapInfo: { protocol: 'soroswap', path }, percent: '100' }],
    };

    console.log('📥 Router quote:', JSON.stringify(quote, null, 2));
    return quote;
  }

  async createSwapTransaction(request: {
    fromAsset: string;
    toAsset: string;
    amount: string;
    address: string;
  }): Promise<{ success: boolean; transactionXDR?: string; error?: string }> {
    try {
      const quote = await this.getQuote({
        assetIn: request.fromAsset,
        assetOut: request.toAsset,
        amount: request.amount,
        tradeType: 'EXACT_IN',
        protocols: ['soroswap'],
        slippageBps: 1000,
        parts: 1,
        maxHops: 1
      });

      const buildResponse = await this.buildTransaction({
        quote,
        sponsor: request.address,
        from: request.address
      });

      return {
        success: true,
        transactionXDR: buildResponse.xdr
      };
    } catch (error) {
      console.error('❌ Create swap transaction error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async buildTransaction(request: BuildRequest): Promise<BuildResponse> {
    const { quote, from } = request;
    const rawTrade = quote.rawTrade as RawRouterTrade | undefined;
    const path = rawTrade?.path ?? quote.routePlan?.[0]?.swapInfo.path;
    const amountOutMin = rawTrade?.amountOutMin ?? quote.otherAmountThreshold;

    if (!path || path.length < 2) {
      throw new Error('Quote has no swap path; request a new quote');
    }
    if (!from) {
      throw new Error('from (source account) is required');
    }

    console.log('🔨 Building router swap for:', from);

    let source: Account;
    try {
      source = await this.server.getAccount(from);
    } catch (error) {
      if (errorMessage(error).includes('Account not found')) {
        throw new Error(`Account ${shortId(from)} is not funded on testnet`);
      }
      console.error('❌ Soroban RPC getAccount error:', error);
      throw new Error(`Network Error - could not load account: ${errorMessage(error)}`);
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + SOROSWAP_ROUTER_CONFIG.TX_DEADLINE_SECONDS);
    const operation = this.router.call(
      'swap_exact_tokens_for_tokens',
      nativeToScVal(BigInt(quote.amountIn), { type: 'i128' }),
      nativeToScVal(BigInt(amountOutMin), { type: 'i128' }),
      this.pathToScVal(path),
      // The router calls require_auth() on this argument, so it is both the payer and the
      // recipient: it can never be an account other than the one signing the transaction.
      new Address(from).toScVal(),
      nativeToScVal(deadline, { type: 'u64' })
    );

    // Simulation computes auth entries and the resource fee; insufficient balance/trustline errors surface here
    const { transaction, simulation } = await this.simulate(operation, source);
    const assembled = rpc.assembleTransaction(transaction, simulation).build();

    console.log('✅ Router swap transaction built, fee:', assembled.fee);
    return { xdr: assembled.toXDR() };
  }

  // SDK 13.3 cannot parse Protocol 23's TransactionMeta v4 ("Bad union switch: 4") and
  // server.getTransaction throws even for successful transactions, so status is read via raw JSON-RPC without XDR parsing.
  private async getTransactionStatus(hash: string): Promise<{ status: string; ledger?: number }> {
    const response = await fetch(SOROSWAP_ROUTER_CONFIG.RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`RPC getTransaction HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: { status: string; ledger?: number };
      error?: { message: string };
    };
    if (body.error) {
      throw new Error(`RPC getTransaction error: ${body.error.message}`);
    }
    if (!body.result) {
      throw new Error('RPC getTransaction returned no result');
    }
    return body.result;
  }

  private async waitForTransaction(hash: string): Promise<SendResponse> {
    const startedAt = Date.now();
    let delay = 1000;

    while (Date.now() - startedAt < SOROSWAP_ROUTER_CONFIG.TX_POLL_TIMEOUT_MS) {
      let result: { status: string; ledger?: number };
      try {
        result = await this.getTransactionStatus(hash);
      } catch (error) {
        // Do not give up on a transient RPC error; retry until the timeout
        console.log('⚠️ getTransaction failed, retrying:', errorMessage(error));
        await sleep(delay);
        delay = Math.min(delay * 1.5, 5000);
        continue;
      }

      if (result.status === 'SUCCESS') {
        return { hash, status: 'success', message: `Transaction confirmed in ledger ${result.ledger}` };
      }
      if (result.status === 'FAILED') {
        throw new Error(`Transaction failed on-chain: ${hash}`);
      }

      await sleep(delay);
      delay = Math.min(delay * 1.5, 5000);
    }

    throw new Error(`Transaction ${hash} not confirmed within ${SOROSWAP_ROUTER_CONFIG.TX_POLL_TIMEOUT_MS / 1000}s`);
  }

  async sendTransaction(request: SendRequest): Promise<SendResponse> {
    let transaction: Transaction | FeeBumpTransaction;
    try {
      transaction = TransactionBuilder.fromXDR(request.xdr, SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE);
    } catch (error) {
      throw new Error(`Invalid transaction XDR: ${errorMessage(error)}`);
    }

    const operations = transaction instanceof FeeBumpTransaction
      ? transaction.innerTransaction.operations
      : transaction.operations;
    const isSoroban = operations.some(op => op.type === 'invokeHostFunction');

    if (!isSoroban) {
      // Classic transactions (trustline, payment…) go to Horizon
      try {
        const result = await this.horizon.submitTransaction(transaction);
        return { hash: result.hash, status: 'success', message: 'Transaction submitted via Horizon' };
      } catch (error) {
        const resultCodes = (error as { response?: { data?: { extras?: { result_codes?: unknown } } } })
          .response?.data?.extras?.result_codes;
        console.error('❌ Horizon submission failed:', resultCodes ?? error);
        throw new Error(`Transaction submission failed: ${resultCodes ? JSON.stringify(resultCodes) : errorMessage(error)}`);
      }
    }

    console.log('📤 Sending Soroban transaction to RPC...');
    let sendResult: rpc.Api.SendTransactionResponse;
    try {
      sendResult = await this.server.sendTransaction(transaction);
    } catch (error) {
      console.error('❌ Soroban RPC send error:', error);
      throw new Error(`Network Error - Soroban RPC unreachable: ${errorMessage(error)}`);
    }

    switch (sendResult.status) {
      case 'ERROR': {
        // In SDK 17 XDR unions are properties, not methods: result.type → e.g. "txBadSeq"
        const code = sendResult.errorResult?.result.type ?? 'unknown';
        // Retry loops in the pages resend the same signed transaction; if the first one was confirmed
        // the sequence is spent (txBadSeq), so return the earlier success instead of an error.
        if (code === 'txBadSeq') {
          const existing = await this.getTransactionStatus(sendResult.hash).catch(() => null);
          if (existing?.status === 'SUCCESS') {
            return { hash: sendResult.hash, status: 'success', message: `Transaction already confirmed in ledger ${existing.ledger}` };
          }
        }
        throw new Error(`Transaction rejected by network: ${code}`);
      }
      case 'TRY_AGAIN_LATER': {
        // Resending a confirmed transaction can also return this status, so check its result first
        const existing = await this.getTransactionStatus(sendResult.hash).catch(() => null);
        if (existing?.status === 'SUCCESS') {
          return { hash: sendResult.hash, status: 'success', message: `Transaction already confirmed in ledger ${existing.ledger}` };
        }
        throw new Error('Soroban RPC is busy (TRY_AGAIN_LATER), please retry');
      }
      case 'PENDING':
      case 'DUPLICATE':
        // DUPLICATE: the same signed transaction was sent again (retry loops); wait for its result
        return this.waitForTransaction(sendResult.hash);
      default:
        throw new Error(`Unexpected send status: ${sendResult.status}`);
    }
  }
}

export const soroswapAPI = new SoroswapAPI();
