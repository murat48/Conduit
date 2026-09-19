import {
  Asset,
  Horizon,
  Memo,
  Operation,
  StellarToml,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk';
import {
  AnchorAuthToken,
  AnchorCurrency,
  AnchorInfo,
  AnchorPrice,
  AnchorQuote,
  BankInstructions,
  DepositStart,
  GetQuoteOptions,
  JwtSource,
  PollTransactionOptions,
  SignTransactionFn,
  Sep12CustomerFields,
  Sep12CustomerStatus,
  Sep38Fee,
  Sep38QuoteResponse,
  Sep6DepositResponse,
  Sep6Info,
  Sep6MemoType,
  Sep6Transaction,
  Sep6TransactionStatus,
  Sep6WithdrawResponse,
  StartDepositParams,
  StartWithdrawParams,
  WithdrawPaymentParams,
  WithdrawStart,
} from '@/types/anchor';
import { soroswapAPI } from './api';
import { ANCHOR_CONFIG } from './constants';
import { getTryIbanError, normalizeIban } from './iban';

// Fiat anchor integration: SEP-1 discovery → SEP-10 login → SEP-12 IBAN → SEP-38 quote → SEP-6 deposit/withdraw.
// No UI here; runs in the browser (signing via Wallets Kit) and in Node.

export class AnchorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly type?: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = 'AnchorError';
  }

  // The anchor returns 403 {"type":"authentication_required"} for a missing/invalid token, not 401
  get isAuthError(): boolean {
    return this.status === 401 || this.type === 'authentication_required';
  }

  // No status means the request never reached the anchor (network error / timeout)
  get isNetworkError(): boolean {
    return this.status === undefined && this.body === undefined;
  }
}

export const TERMINAL_STATUSES: ReadonlySet<Sep6TransactionStatus> = new Set<Sep6TransactionStatus>([
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
]);

const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;
const STROOPS_PER_UNIT = BigInt(10000000);

const infoCache = new Map<string, AnchorInfo>();
const tokenCache = new Map<string, AnchorAuthToken>();

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AnchorError('Polling aborted'));
    }, { once: true });
  });

const assertAmount = (amount: string, label = 'amount'): void => {
  if (!AMOUNT_PATTERN.test(amount) || Number(amount) <= 0) {
    throw new AnchorError(`Invalid ${label}: ${amount}`);
  }
};

const toStroops = (amount: string): bigint => {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt((fraction + '0000000').slice(0, 7));
};

export const stellarAssetId = (code: string, issuer: string): string => `stellar:${code}:${issuer}`;

async function anchorRequest<T>(url: string, options: RequestInit & { jwt?: string } = {}): Promise<T> {
  const { jwt, headers, ...init } = options;

  console.log(`🌐 Anchor Request: ${init.method || 'GET'} ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...headers,
      },
      signal: init.signal ?? AbortSignal.timeout(ANCHOR_CONFIG.REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      console.error('❌ Anchor request timeout:', url);
      throw new AnchorError(`Request timeout - anchor did not respond: ${url}`);
    }
    console.error('❌ Anchor network error:', error);
    throw new AnchorError(`Network Error - anchor unreachable: ${errorMessage(error)}`);
  }

  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  console.log(`📥 Anchor Response: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const errorBody = body && typeof body === 'object'
      ? body as { error?: unknown; type?: string; message?: unknown; detail?: unknown }
      : {};
    const nested = errorBody.error && typeof errorBody.error === 'object'
      ? errorBody.error as { message?: unknown; code?: unknown }
      : {};
    const detail = [errorBody.error, nested.message, errorBody.message, errorBody.detail, nested.code]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ?? ((typeof body === 'string' && body.trim() ? body.slice(0, 200) : '')
        || response.statusText || 'The anchor rejected the request without an explanation.');
    const type = errorBody.type ?? (typeof nested.code === 'string' ? nested.code : undefined);
    console.warn(`Anchor request rejected (${response.status}): ${detail}`);
    throw new AnchorError(`Anchor Error: ${response.status} - ${detail}`, response.status, type, body ?? null);
  }

  if (!body || typeof body !== 'object') {
    throw new AnchorError(`Invalid JSON response from anchor: ${text.slice(0, 100)}`, response.status, undefined, body ?? null);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// SEP-1
// ---------------------------------------------------------------------------

export async function getAnchorInfo(homeDomain: string = ANCHOR_CONFIG.HOME_DOMAIN): Promise<AnchorInfo> {
  const cached = infoCache.get(homeDomain);
  if (cached) return cached;

  let toml: StellarToml.Api.StellarToml;
  try {
    toml = await StellarToml.Resolver.resolve(homeDomain, { timeout: ANCHOR_CONFIG.REQUEST_TIMEOUT_MS });
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    console.error('❌ stellar.toml resolve error:', error);
    throw new AnchorError(`Could not load stellar.toml for ${homeDomain}: ${errorMessage(error)}`, status);
  }

  if (!toml.SIGNING_KEY || !toml.WEB_AUTH_ENDPOINT || !toml.TRANSFER_SERVER) {
    throw new AnchorError(`stellar.toml for ${homeDomain} is missing SIGNING_KEY, WEB_AUTH_ENDPOINT or TRANSFER_SERVER`);
  }

  const networkPassphrase = toml.NETWORK_PASSPHRASE ?? ANCHOR_CONFIG.NETWORK_PASSPHRASE;
  if (networkPassphrase !== ANCHOR_CONFIG.NETWORK_PASSPHRASE) {
    throw new AnchorError(`Anchor ${homeDomain} is on a different network: ${networkPassphrase}`);
  }

  const currencies: AnchorCurrency[] = (toml.CURRENCIES ?? [])
    .filter((currency): currency is typeof currency & { code: string } => !!currency.code)
    .map(currency => ({
      code: currency.code,
      issuer: currency.issuer,
      status: currency.status,
      displayDecimals: currency.display_decimals,
      isAssetAnchored: currency.is_asset_anchored,
      anchorAssetType: currency.anchor_asset_type,
      anchorAsset: currency.anchor_asset,
      description: currency.desc,
    }));

  const info: AnchorInfo = {
    homeDomain,
    networkPassphrase,
    signingKey: toml.SIGNING_KEY,
    webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
    transferServer: toml.TRANSFER_SERVER.replace(/\/$/, ''),
    kycServer: toml.KYC_SERVER?.replace(/\/$/, ''),
    quoteServer: toml.ANCHOR_QUOTE_SERVER?.replace(/\/$/, ''),
    currencies,
  };

  infoCache.set(homeDomain, info);
  return info;
}

const getCurrency = (info: AnchorInfo, code: string): AnchorCurrency & { issuer: string } => {
  const currency = info.currencies.find(c => c.code === code && c.issuer);
  if (!currency || !currency.issuer) {
    throw new AnchorError(`Anchor ${info.homeDomain} does not list ${code} in stellar.toml`);
  }
  return currency as AnchorCurrency & { issuer: string };
};

// ---------------------------------------------------------------------------
// SEP-10
// ---------------------------------------------------------------------------

const decodeJwtPayload = (token: string): { exp?: number; sub?: string } => {
  const payload = token.split('.')[1];
  if (!payload) {
    throw new AnchorError('Malformed JWT: missing payload');
  }
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
  try {
    return JSON.parse(atob(base64));
  } catch {
    throw new AnchorError('Malformed JWT: payload is not valid JSON');
  }
};

// Account the JWT belongs to. sub may be "G…", "G…:memo" or "M…"
export const getJwtAccount = (jwt: string): string | undefined => decodeJwtPayload(jwt).sub?.split(':')[0];

const tokenCacheKey = (homeDomain: string, account: string) => `${homeDomain}|${account}`;

export function clearAuthentication(publicKey?: string, homeDomain: string = ANCHOR_CONFIG.HOME_DOMAIN): void {
  if (publicKey) {
    tokenCache.delete(tokenCacheKey(homeDomain, publicKey));
  } else {
    tokenCache.clear();
  }
}

export async function authenticate(
  publicKey: string,
  signTransaction: SignTransactionFn,
  options: { homeDomain?: string; forceRefresh?: boolean } = {}
): Promise<string> {
  const homeDomain = options.homeDomain ?? ANCHOR_CONFIG.HOME_DOMAIN;
  const cacheKey = tokenCacheKey(homeDomain, publicKey);

  const cached = tokenCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt - ANCHOR_CONFIG.JWT_REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const info = await getAnchorInfo(homeDomain);

  const challengeUrl = new URL(info.webAuthEndpoint);
  challengeUrl.searchParams.set('account', publicKey);
  challengeUrl.searchParams.set('home_domain', homeDomain);
  const challenge = await anchorRequest<{ transaction?: string; network_passphrase?: string }>(challengeUrl.toString());

  if (!challenge.transaction) {
    throw new AnchorError('SEP-10 challenge response has no transaction', undefined, undefined, challenge);
  }
  if (challenge.network_passphrase && challenge.network_passphrase !== info.networkPassphrase) {
    throw new AnchorError(`SEP-10 challenge is for a different network (${challenge.network_passphrase}); not signing`);
  }

  // Verify before signing: source = SIGNING_KEY, sequence 0, valid time bounds,
  // the "<home_domain> auth" operation is sourced by this account, web_auth_domain matches and the anchor signature is present
  let clientAccount: string;
  try {
    const details = WebAuth.readChallengeTx(
      challenge.transaction,
      info.signingKey,
      info.networkPassphrase,
      homeDomain,
      new URL(info.webAuthEndpoint).hostname
    );
    clientAccount = details.clientAccountID;
  } catch (error) {
    console.error('❌ SEP-10 challenge verification failed:', error);
    throw new AnchorError(`SEP-10 challenge rejected, not signing: ${errorMessage(error)}`);
  }
  if (clientAccount !== publicKey) {
    throw new AnchorError(`SEP-10 challenge is for ${clientAccount}, expected ${publicKey}; not signing`);
  }

  // Wallet errors (e.g. the user rejected) bubble up unchanged
  const signedTransaction = await signTransaction(challenge.transaction);

  const result = await anchorRequest<{ token?: string }>(info.webAuthEndpoint, {
    method: 'POST',
    body: JSON.stringify({ transaction: signedTransaction }),
  });
  if (!result.token) {
    throw new AnchorError('SEP-10 response has no token', undefined, undefined, result);
  }

  const { exp, sub } = decodeJwtPayload(result.token);
  if (sub && sub.split(':')[0] !== publicKey) {
    throw new AnchorError(`SEP-10 token is for ${sub}, expected ${publicKey}`);
  }
  // Without exp, conservatively treat the token as valid for 5 minutes
  const expiresAt = exp ? exp * 1000 : Date.now() + 5 * 60 * 1000;

  tokenCache.set(cacheKey, { token: result.token, account: publicKey, expiresAt });
  console.log('✅ SEP-10 authenticated, token expires at', new Date(expiresAt).toISOString());
  return result.token;
}

// For long flows such as pollTransaction: refreshes the token when it expires
export const createJwtSource = (
  publicKey: string,
  signTransaction: SignTransactionFn,
  homeDomain: string = ANCHOR_CONFIG.HOME_DOMAIN
): JwtSource => (options = {}) => authenticate(publicKey, signTransaction, { homeDomain, forceRefresh: options.forceRefresh });

const assertJwtAccount = (jwt: string, account: string): void => {
  const jwtAccount = getJwtAccount(jwt);
  // The anchor does not compare the deposit account with the JWT account; block sending USDC elsewhere here
  if (jwtAccount && jwtAccount !== account.split(':')[0]) {
    throw new AnchorError(`account ${account} does not match the authenticated account ${jwtAccount}`);
  }
};

// ---------------------------------------------------------------------------
// SEP-6 /info
// ---------------------------------------------------------------------------

// Note: /info reports min/max against the USDC being delivered (0.5–300), not against the TRY
// being paid in, so its numbers cannot be shown next to a TRY field as they stand. The order
// limits that actually bind are minAmount/maxAmount on the startDeposit/startWithdraw response —
// use those.
export async function getInfo(jwt?: string, homeDomain: string = ANCHOR_CONFIG.HOME_DOMAIN): Promise<Sep6Info> {
  const info = await getAnchorInfo(homeDomain);
  const result = await anchorRequest<Sep6Info>(`${info.transferServer}/info`, { jwt });
  if (!result.deposit || !result.withdraw) {
    throw new AnchorError('SEP-6 /info response is missing deposit or withdraw', undefined, undefined, result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// SEP-38
// ---------------------------------------------------------------------------

export async function getQuote(
  jwt: string,
  sellAsset: string,
  buyAsset: string,
  amount: string,
  options: GetQuoteOptions = {}
): Promise<AnchorQuote> {
  assertAmount(amount, 'sell amount');
  const info = await getAnchorInfo(options.homeDomain);
  if (!info.quoteServer) {
    throw new AnchorError(`Anchor ${info.homeDomain} does not publish ANCHOR_QUOTE_SERVER (SEP-38)`);
  }

  const body: Record<string, string> = {
    sell_asset: sellAsset,
    buy_asset: buyAsset,
    sell_amount: amount,
    context: 'sep6',
  };
  if (sellAsset.startsWith('iso4217:')) body.sell_delivery_method = ANCHOR_CONFIG.FUNDING_METHOD;
  if (buyAsset.startsWith('iso4217:')) body.buy_delivery_method = ANCHOR_CONFIG.FUNDING_METHOD;
  if (options.expireAfter) body.expire_after = options.expireAfter.toISOString();

  const quote = await anchorRequest<Sep38QuoteResponse>(`${info.quoteServer}/quote`, {
    method: 'POST',
    jwt,
    body: JSON.stringify(body),
  });

  const expiresAt = new Date(quote.expires_at);
  if (!quote.id || !quote.price || Number.isNaN(expiresAt.getTime())) {
    throw new AnchorError('SEP-38 quote response is missing id, price or expires_at', undefined, undefined, quote);
  }

  return {
    id: quote.id,
    rate: quote.price,
    totalRate: quote.total_price,
    sellAsset: quote.sell_asset,
    sellAmount: quote.sell_amount,
    buyAsset: quote.buy_asset,
    buyAmount: quote.buy_amount,
    fee: quote.fee,
    expiresAt,
  };
}

export const isQuoteExpired = (quote: AnchorQuote, marginMs = 0): boolean =>
  quote.expiresAt.getTime() - marginMs <= Date.now();

// Indicative price: needs no JWT and reserves nothing. Used for rule conditions (e.g. "when USD/TRY passes 49").
export async function getIndicativePrice(
  sellAsset: string,
  buyAsset: string,
  sellAmount: string,
  options: { homeDomain?: string } = {}
): Promise<AnchorPrice> {
  assertAmount(sellAmount, 'sell amount');
  const info = await getAnchorInfo(options.homeDomain);
  if (!info.quoteServer) {
    throw new AnchorError(`Anchor ${info.homeDomain} does not publish ANCHOR_QUOTE_SERVER (SEP-38)`);
  }

  const query = new URLSearchParams({
    sell_asset: sellAsset,
    buy_asset: buyAsset,
    sell_amount: sellAmount,
    context: 'sep6',
  });
  if (sellAsset.startsWith('iso4217:')) query.set('sell_delivery_method', ANCHOR_CONFIG.FUNDING_METHOD);
  if (buyAsset.startsWith('iso4217:')) query.set('buy_delivery_method', ANCHOR_CONFIG.FUNDING_METHOD);

  const price = await anchorRequest<{
    price?: string;
    total_price?: string;
    sell_amount?: string;
    buy_amount?: string;
    fee?: Sep38Fee;
  }>(`${info.quoteServer}/price?${query}`);

  if (!price.price || !price.total_price || !price.buy_amount) {
    throw new AnchorError('SEP-38 price response is missing price or buy_amount', undefined, undefined, price);
  }

  return {
    rate: price.price,
    totalRate: price.total_price,
    sellAsset,
    sellAmount: price.sell_amount ?? sellAmount,
    buyAsset,
    buyAmount: price.buy_amount,
    fee: price.fee ?? { total: '0', asset: sellAsset },
  };
}

// ---------------------------------------------------------------------------
// SEP-12
// ---------------------------------------------------------------------------

// `type` scopes the answer to one flow. It matters: this anchor reports ACCEPTED for the bare
// request while answering NEEDS_INFO for `sep6-withdraw`, because the withdrawal wants the account
// holder's name on top of the IBAN. Asking without the type reads as "all clear" when it is not.
export async function getCustomer(
  jwt: string,
  options: { type?: string; homeDomain?: string } = {}
): Promise<Sep12CustomerStatus> {
  const homeDomain = options.homeDomain ?? ANCHOR_CONFIG.HOME_DOMAIN;
  const info = await getAnchorInfo(homeDomain);
  if (!info.kycServer) {
    throw new AnchorError(`Anchor ${info.homeDomain} does not publish KYC_SERVER (SEP-12)`);
  }
  const url = new URL(`${info.kycServer}/customer`);
  if (options.type) url.searchParams.set('type', options.type);
  const result = await anchorRequest<Sep12CustomerStatus>(url.toString(), { jwt });
  if (!result.status) {
    throw new AnchorError('SEP-12 customer response has no status', undefined, undefined, result);
  }
  return result;
}

// TRY payouts go to this IBAN (bank_account_number). The IBAN is written into the transaction when the withdrawal opens,
// so call this BEFORE opening a new withdrawal if it needs to change
export async function putCustomer(
  jwt: string,
  fields: Sep12CustomerFields,
  options: { type?: string; homeDomain?: string } = {}
): Promise<{ id: string }> {
  if (fields.bank_account_number !== undefined) {
    const ibanError = getTryIbanError(fields.bank_account_number);
    if (ibanError) throw new AnchorError(ibanError, 400, 'invalid_iban');
    fields = { ...fields, bank_account_number: normalizeIban(fields.bank_account_number) };
  }
  const info = await getAnchorInfo(options.homeDomain ?? ANCHOR_CONFIG.HOME_DOMAIN);
  if (!info.kycServer) {
    throw new AnchorError(`Anchor ${info.homeDomain} does not publish KYC_SERVER (SEP-12)`);
  }
  const account = getJwtAccount(jwt);
  const result = await anchorRequest<{ id?: string }>(`${info.kycServer}/customer`, {
    method: 'PUT',
    jwt,
    body: JSON.stringify({
      ...(account ? { account } : {}),
      ...(options.type ? { type: options.type } : {}),
      ...fields,
    }),
  });
  if (!result.id) {
    throw new AnchorError('SEP-12 PUT /customer response has no id', undefined, undefined, result);
  }
  return { id: result.id };
}

// ---------------------------------------------------------------------------
/**
 * What the anchor still wants before it will accept this flow: fields it marks as required and
 * has not already got. A real TRY payout needs the account holder's name here, because the bank
 * checks it against the IBAN; this sandbox marks those optional, so the gap only shows in prod.
 */
export const missingCustomerFields = (status: Sep12CustomerStatus): string[] =>
  Object.entries(status.fields ?? {})
    .filter(([name, field]) => field.optional !== true && !status.provided_fields?.[name])
    .map(([name]) => name);

/** SEP-12 scope for the TRY payout flow. */
export const WITHDRAW_CUSTOMER_TYPE = 'sep6-withdraw';

// ---------------------------------------------------------------------------
// SEP-6 deposit / withdraw
// ---------------------------------------------------------------------------

export async function startDeposit(jwt: string, params: StartDepositParams): Promise<DepositStart> {
  const info = await getAnchorInfo(params.homeDomain);
  const assetCode = params.assetCode ?? ANCHOR_CONFIG.DEFAULT_ASSET_CODE;
  assertJwtAccount(jwt, params.account);
  if (params.amount !== undefined) assertAmount(params.amount);

  const query = new URLSearchParams();
  let endpoint: string;
  if (params.quoteId) {
    if (!params.amount) {
      throw new AnchorError('amount is required with quoteId and must equal the quote sell_amount');
    }
    endpoint = 'deposit-exchange';
    query.set('destination_asset', assetCode);
    query.set('source_asset', ANCHOR_CONFIG.FIAT_ASSET);
    query.set('quote_id', params.quoteId);
  } else {
    endpoint = 'deposit';
    query.set('asset_code', assetCode);
  }
  if (params.amount) query.set('amount', params.amount);
  query.set('account', params.account);
  query.set('funding_method', ANCHOR_CONFIG.FUNDING_METHOD);
  if (params.claimableBalanceSupported) query.set('claimable_balance_supported', 'true');
  if (params.onChangeCallback) query.set('on_change_callback', params.onChangeCallback);

  const response = await anchorRequest<Sep6DepositResponse>(`${info.transferServer}/${endpoint}?${query}`, { jwt });

  const instructions = response.instructions ?? {};
  const iban = instructions.bank_account_number?.value;
  const reference = instructions.external_transfer_memo?.value;
  if (!response.id || !iban || !reference) {
    throw new AnchorError('SEP-6 deposit response is missing id, IBAN or transfer reference', undefined, undefined, response);
  }

  const bankInstructions: BankInstructions = {
    iban,
    reference,
    bankName: instructions.bank_name?.value,
    raw: instructions,
  };

  console.log(`✅ Deposit ${response.id} started: send TRY to ${iban} with reference ${reference}`);
  return {
    id: response.id,
    bankInstructions,
    how: response.how,
    etaSeconds: response.eta,
    minAmount: response.min_amount,
    maxAmount: response.max_amount,
    feePercent: response.fee_percent,
    message: response.extra_info?.message,
  };
}

export async function startWithdraw(jwt: string, params: StartWithdrawParams = {}): Promise<WithdrawStart> {
  const info = await getAnchorInfo(params.homeDomain);
  const assetCode = params.assetCode ?? ANCHOR_CONFIG.DEFAULT_ASSET_CODE;
  if (params.amount !== undefined) assertAmount(params.amount);

  const query = new URLSearchParams();
  let endpoint: string;
  if (params.quoteId) {
    if (!params.amount) {
      throw new AnchorError('amount is required with quoteId and must equal the quote sell_amount');
    }
    endpoint = 'withdraw-exchange';
    query.set('source_asset', assetCode);
    query.set('destination_asset', ANCHOR_CONFIG.FIAT_ASSET);
    query.set('quote_id', params.quoteId);
  } else {
    endpoint = 'withdraw';
    query.set('asset_code', assetCode);
  }
  if (params.amount) query.set('amount', params.amount);
  query.set('funding_method', ANCHOR_CONFIG.FUNDING_METHOD);
  if (params.onChangeCallback) query.set('on_change_callback', params.onChangeCallback);

  const response = await anchorRequest<Sep6WithdrawResponse>(`${info.transferServer}/${endpoint}?${query}`, { jwt });

  if (!response.id || !response.account_id) {
    throw new AnchorError('SEP-6 withdraw response is missing id or account_id', undefined, undefined, response);
  }
  // A payment without a memo cannot be matched and the funds sit in the treasury, so stop the flow when it is missing
  if (!response.memo || !response.memo_type) {
    throw new AnchorError('SEP-6 withdraw response has no memo; a payment could not be attributed', undefined, undefined, response);
  }

  console.log(`✅ Withdraw ${response.id} started: pay ${response.account_id} with memo (${response.memo_type}) ${response.memo}`);
  return {
    id: response.id,
    destinationAccount: response.account_id,
    memo: response.memo,
    memoType: response.memo_type,
    etaSeconds: response.eta,
    minAmount: response.min_amount,
    maxAmount: response.max_amount,
    feePercent: response.fee_percent,
    message: response.extra_info?.message,
    paymentUri: response.extra_info?.payment_uri,
  };
}

// ---------------------------------------------------------------------------
// Account: trustlines and balances
// ---------------------------------------------------------------------------

const horizonServer = () => new Horizon.Server(ANCHOR_CONFIG.HORIZON_URL);

async function loadHorizonAccount(publicKey: string): Promise<Horizon.AccountResponse> {
  try {
    return await horizonServer().loadAccount(publicKey);
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 404) {
      throw new AnchorError(`Account ${publicKey} is not funded on testnet`, 404);
    }
    console.error('❌ Horizon loadAccount error:', error);
    throw new AnchorError(`Network Error - could not load account: ${errorMessage(error)}`, status);
  }
}

// Without a trustline the anchor sends USDC as a claimable balance; a trustline is needed for it to land in the balance
export async function getAssetBalance(
  publicKey: string,
  assetCode: string = ANCHOR_CONFIG.DEFAULT_ASSET_CODE,
  homeDomain?: string
): Promise<{ hasTrustline: boolean; balance: string; xlmBalance: string }> {
  const info = await getAnchorInfo(homeDomain);
  const currency = getCurrency(info, assetCode);
  const account = await loadHorizonAccount(publicKey);
  const line = account.balances.find(
    balance => 'asset_code' in balance && balance.asset_code === currency.code && balance.asset_issuer === currency.issuer
  );
  const native = account.balances.find(balance => balance.asset_type === 'native');
  return {
    hasTrustline: !!line,
    balance: line?.balance ?? '0',
    xlmBalance: native?.balance ?? '0',
  };
}

export async function buildTrustlineTransaction(
  publicKey: string,
  assetCode: string = ANCHOR_CONFIG.DEFAULT_ASSET_CODE,
  homeDomain?: string
): Promise<string> {
  const info = await getAnchorInfo(homeDomain);
  const currency = getCurrency(info, assetCode);
  const account = await loadHorizonAccount(publicKey);

  let fee = '1000';
  try {
    fee = String(await horizonServer().fetchBaseFee());
  } catch (error) {
    console.log('⚠️ fetchBaseFee failed, using default fee:', errorMessage(error));
  }

  return new TransactionBuilder(account, { fee, networkPassphrase: info.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset(currency.code, currency.issuer) }))
    .setTimeout(180)
    .build()
    .toXDR();
}

// Does nothing when the trustline already exists
export async function ensureTrustline(
  publicKey: string,
  signTransaction: SignTransactionFn,
  assetCode: string = ANCHOR_CONFIG.DEFAULT_ASSET_CODE,
  homeDomain?: string
): Promise<{ created: boolean; hash?: string }> {
  const { hasTrustline } = await getAssetBalance(publicKey, assetCode, homeDomain);
  if (hasTrustline) return { created: false };

  const xdr = await buildTrustlineTransaction(publicKey, assetCode, homeDomain);
  const signedXdr = await signTransaction(xdr);
  const result = await soroswapAPI.sendTransaction({ xdr: signedXdr });
  console.log(`✅ ${assetCode} trustline created: ${result.hash}`);
  return { created: true, hash: result.hash };
}

// ---------------------------------------------------------------------------
// Withdrawal payment (USDC transfer with a memo)
// ---------------------------------------------------------------------------

const buildMemo = (memo: string, memoType: Sep6MemoType): Memo => {
  switch (memoType) {
    case 'id':
      if (!/^\d+$/.test(memo)) {
        throw new AnchorError(`Invalid id memo from anchor: ${memo}`);
      }
      return Memo.id(memo);
    case 'text':
      return Memo.text(memo);
    case 'hash': {
      // SEP-6 hash memo'yu base64 olarak verir; SDK hex bekler
      const hex = Array.from(atob(memo), char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      return Memo.hash(hex);
    }
    default:
      throw new AnchorError(`Unsupported memo type: ${memoType}`);
  }
};

export async function buildWithdrawPayment(params: WithdrawPaymentParams): Promise<string> {
  const { sourceAccount, withdraw, amount } = params;
  assertAmount(amount);

  const info = await getAnchorInfo(params.homeDomain);
  const currency = getCurrency(info, params.assetCode ?? ANCHOR_CONFIG.DEFAULT_ASSET_CODE);
  const account = await loadHorizonAccount(sourceAccount);

  const balance = account.balances.find(
    line => 'asset_code' in line && line.asset_code === currency.code && line.asset_issuer === currency.issuer
  );
  if (!balance) {
    throw new AnchorError(`Account has no ${currency.code} trustline for issuer ${currency.issuer}`);
  }
  if (toStroops(balance.balance) < toStroops(amount)) {
    throw new AnchorError(`Insufficient ${currency.code} balance: ${balance.balance} < ${amount}`);
  }

  let fee = '1000';
  try {
    fee = String(await horizonServer().fetchBaseFee());
  } catch (error) {
    console.log('⚠️ fetchBaseFee failed, using default fee:', errorMessage(error));
  }

  const transaction = new TransactionBuilder(account, { fee, networkPassphrase: info.networkPassphrase })
    .addOperation(Operation.payment({
      destination: withdraw.destinationAccount,
      asset: new Asset(currency.code, currency.issuer),
      amount,
    }))
    .addMemo(buildMemo(withdraw.memo, withdraw.memoType))
    .setTimeout(180)
    .build();

  return transaction.toXDR();
}

// Builds the payment, has the wallet sign it and submits it to Horizon
export async function payWithdraw(
  params: WithdrawPaymentParams,
  signTransaction: SignTransactionFn
): Promise<{ hash: string }> {
  const xdr = await buildWithdrawPayment(params);
  const signedXdr = await signTransaction(xdr);
  const result = await soroswapAPI.sendTransaction({ xdr: signedXdr });
  if (!result.hash) {
    throw new AnchorError('Withdraw payment submission returned no transaction hash');
  }
  console.log(`✅ Withdraw payment sent for ${params.withdraw.id}: ${result.hash}`);
  return { hash: result.hash };
}

// ---------------------------------------------------------------------------
// SEP-6 transaction durumu
// ---------------------------------------------------------------------------

export async function getTransaction(
  jwt: string,
  id: string,
  homeDomain: string = ANCHOR_CONFIG.HOME_DOMAIN
): Promise<Sep6Transaction> {
  const info = await getAnchorInfo(homeDomain);
  const result = await anchorRequest<{ transaction?: Sep6Transaction }>(
    `${info.transferServer}/transaction?id=${encodeURIComponent(id)}`,
    { jwt }
  );
  if (!result.transaction?.id || !result.transaction.status) {
    throw new AnchorError('SEP-6 transaction response is missing id or status', undefined, undefined, result);
  }
  return result.transaction;
}

export async function pollTransaction(
  jwt: JwtSource,
  id: string,
  onUpdate?: (transaction: Sep6Transaction) => void,
  options: PollTransactionOptions = {}
): Promise<Sep6Transaction> {
  const {
    timeoutMs = 10 * 60 * 1000,
    initialDelayMs = 2000,
    maxDelayMs = 15000,
    signal,
    homeDomain = ANCHOR_CONFIG.HOME_DOMAIN,
  } = options;

  const startedAt = Date.now();
  let delay = initialDelayMs;
  let token = typeof jwt === 'string' ? jwt : await jwt();
  let lastSeen: string | undefined;
  let networkFailures = 0;
  let reauthenticated = false;

  for (;;) {
    if (signal?.aborted) {
      throw new AnchorError('Polling aborted');
    }

    let transaction: Sep6Transaction | undefined;
    try {
      transaction = await getTransaction(token, id, homeDomain);
      networkFailures = 0;
      reauthenticated = false;
    } catch (error) {
      if (!(error instanceof AnchorError)) throw error;

      if (error.isAuthError) {
        // Refresh once if the token expired mid-flow; the transaction belongs to the account, so a new token can read it
        if (typeof jwt !== 'function' || reauthenticated) throw error;
        console.log('🔑 JWT rejected during polling, re-authenticating...');
        token = await jwt({ forceRefresh: true });
        reauthenticated = true;
        continue;
      }
      if (error.isNetworkError && networkFailures < 5) {
        networkFailures++;
        console.log(`⚠️ Anchor unreachable while polling (${networkFailures}/5), retrying...`);
      } else {
        throw error;
      }
    }

    if (transaction) {
      const fingerprint = `${transaction.status}|${transaction.updated_at ?? ''}`;
      if (fingerprint !== lastSeen) {
        lastSeen = fingerprint;
        onUpdate?.(transaction);
      }
      if (TERMINAL_STATUSES.has(transaction.status)) {
        return transaction;
      }
    }

    if (Date.now() - startedAt + delay > timeoutMs) {
      throw new AnchorError(
        `Polling timed out after ${Math.round(timeoutMs / 1000)}s; transaction ${id} is still ${transaction?.status ?? 'unknown'}`
      );
    }
    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * 1.5), maxDelayMs);
  }
}

// ---------------------------------------------------------------------------
// Sandbox only: simulates the incoming bank transfer (a real anchor has no such endpoint)
// ---------------------------------------------------------------------------

export async function sandboxSimulateBankTransfer(
  depositId: string,
  amount: string,
  homeDomain: string = ANCHOR_CONFIG.HOME_DOMAIN
): Promise<unknown> {
  assertAmount(amount);
  const info = await getAnchorInfo(homeDomain);
  if (!info.currencies.some(currency => currency.status === 'test')) {
    throw new AnchorError(`Refusing to simulate a bank transfer on non-test anchor ${homeDomain}`);
  }
  const origin = new URL(info.transferServer).origin;
  return anchorRequest<unknown>(`${origin}/sep6/tx/${encodeURIComponent(depositId)}/simulate-bank-transfer`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}
