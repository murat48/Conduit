// SEP-1 / SEP-6 / SEP-10 / SEP-12 / SEP-38 tipleri.
// Field names verified against live responses from tr-mock-anchor.fly.dev.

export type SignTransactionFn = (xdr: string) => Promise<string>;

// A string is used as-is; a function is called to fetch a fresh token when the JWT expires
export type JwtSource = string | ((options?: { forceRefresh?: boolean }) => Promise<string>);

// SEP-1 (stellar.toml)
export interface AnchorCurrency {
  code: string;
  issuer?: string;
  status?: string;
  displayDecimals?: number;
  isAssetAnchored?: boolean;
  anchorAssetType?: string;
  anchorAsset?: string;
  description?: string;
}

export interface AnchorInfo {
  homeDomain: string;
  networkPassphrase: string;
  signingKey: string;
  webAuthEndpoint: string;
  transferServer: string;
  kycServer?: string;
  quoteServer?: string;
  currencies: AnchorCurrency[];
}

// SEP-10
export interface AnchorAuthToken {
  token: string;
  account: string;
  expiresAt: number; // unix ms
}

// SEP-6 /info
export interface Sep6FieldInfo {
  description?: string;
  choices?: string[];
  optional?: boolean;
}

export interface Sep6AssetInfo {
  enabled: boolean;
  authentication_required?: boolean;
  min_amount?: number;
  max_amount?: number;
  fee_percent?: number;
  fee_fixed?: number;
  funding_methods?: string[];
  fields?: Record<string, Sep6FieldInfo>;
  types?: Record<string, { fields?: Record<string, Sep6FieldInfo> }>;
}

export interface Sep6Info {
  deposit: Record<string, Sep6AssetInfo>;
  'deposit-exchange'?: Record<string, Sep6AssetInfo>;
  withdraw: Record<string, Sep6AssetInfo>;
  'withdraw-exchange'?: Record<string, Sep6AssetInfo>;
  fee?: { enabled: boolean; description?: string };
  transactions?: { enabled: boolean; authentication_required?: boolean };
  transaction?: { enabled: boolean; authentication_required?: boolean };
  features?: { account_creation?: boolean; claimable_balances?: boolean };
}

// SEP-38
export interface Sep38Fee {
  total: string;
  asset: string;
  details?: { name: string; description?: string; amount: string }[];
}

export interface Sep38QuoteResponse {
  id: string;
  expires_at: string;
  total_price: string;
  price: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  fee: Sep38Fee;
}

export interface AnchorQuote {
  id: string;
  rate: string; // price: sell_asset paid per unit of buy_asset (excluding fees)
  totalRate: string; // total_price: including fees
  sellAsset: string;
  sellAmount: string;
  buyAsset: string;
  buyAmount: string;
  fee: Sep38Fee;
  expiresAt: Date;
}

// SEP-38 GET /price — non-binding indicative price, no authentication required
export interface AnchorPrice {
  rate: string; // price: excluding fees
  totalRate: string; // total_price: including fees
  sellAsset: string;
  sellAmount: string;
  buyAsset: string;
  buyAmount: string;
  fee: Sep38Fee;
}

export interface GetQuoteOptions {
  expireAfter?: Date; // Anchor en fazla 1 saat kabul ediyor
  homeDomain?: string;
}

// SEP-9 field (deposit instructions)
export interface Sep9Field {
  value: string;
  description?: string;
}

// SEP-6 deposit
export interface Sep6DepositResponse {
  id: string;
  how?: string;
  instructions?: Record<string, Sep9Field>;
  eta?: number;
  min_amount?: number;
  max_amount?: number;
  fee_percent?: number;
  fee_fixed?: number;
  extra_info?: { message?: string };
}

export interface StartDepositParams {
  account: string; // account the USDC is sent to; must match the JWT account
  amount?: string; // TRY. Required with quoteId and must equal the quote's sell_amount
  assetCode?: string; // defaults to USDC
  quoteId?: string; // when set, /deposit-exchange is used
  claimableBalanceSupported?: boolean;
  onChangeCallback?: string;
  homeDomain?: string;
}

export interface BankInstructions {
  iban: string;
  reference: string; // code to write in the transfer description
  bankName?: string;
  raw: Record<string, Sep9Field>;
}

export interface DepositStart {
  id: string;
  bankInstructions: BankInstructions;
  how?: string;
  etaSeconds?: number;
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  message?: string;
}

// SEP-6 withdraw
export type Sep6MemoType = 'id' | 'text' | 'hash';

export interface Sep6WithdrawResponse {
  id: string;
  account_id: string;
  memo_type?: Sep6MemoType;
  memo?: string;
  eta?: number;
  min_amount?: number;
  max_amount?: number;
  fee_percent?: number;
  fee_fixed?: number;
  extra_info?: { message?: string; payment_uri?: string };
}

export interface StartWithdrawParams {
  amount?: string; // USDC. Required with quoteId and must equal the quote's sell_amount
  assetCode?: string; // defaults to USDC
  quoteId?: string; // when set, /withdraw-exchange is used
  onChangeCallback?: string;
  homeDomain?: string;
}

export interface WithdrawStart {
  id: string;
  destinationAccount: string; // Anchor treasury
  memo: string;
  memoType: Sep6MemoType;
  etaSeconds?: number;
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  message?: string;
  paymentUri?: string;
}

export interface WithdrawPaymentParams {
  sourceAccount: string;
  withdraw: WithdrawStart;
  amount: string;
  assetCode?: string; // defaults to USDC; the issuer comes from the anchor's stellar.toml
  homeDomain?: string;
}

// SEP-6 transaction
export type Sep6TransactionStatus =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_external'
  | 'pending_anchor'
  | 'on_hold'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_user'
  | 'pending_customer_info_update'
  | 'pending_transaction_info_update'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'no_market'
  | 'too_small'
  | 'too_large'
  | 'error';

export interface Sep6Transaction {
  id: string;
  kind: 'deposit' | 'withdrawal' | 'deposit-exchange' | 'withdrawal-exchange';
  status: Sep6TransactionStatus;
  status_eta?: number | null;
  more_info_url?: string;
  message?: string | null;
  started_at: string;
  updated_at?: string | null;
  completed_at?: string | null;
  user_action_required_by?: string | null;
  quote_id?: string | null;
  refunded?: boolean;
  refunds?: unknown;
  amount_in?: string | null;
  amount_in_asset?: string | null;
  amount_out?: string | null;
  amount_out_asset?: string | null;
  amount_fee?: string | null;
  amount_fee_asset?: string | null;
  fee_details?: Sep38Fee | null;
  from?: string | null;
  to?: string | null;
  deposit_memo?: string | null;
  deposit_memo_type?: string | null;
  withdraw_anchor_account?: string | null;
  withdraw_memo?: string | null;
  withdraw_memo_type?: string | null;
  stellar_transaction_id?: string | null;
  external_transaction_id?: string | null;
  claimable_balance_id?: string | null;
  pending_reason?: string | null; // e.g. treasury_low
  instructions?: Record<string, Sep9Field>;
}

export interface PollTransactionOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  homeDomain?: string;
}

// SEP-12
export interface Sep12CustomerFields {
  first_name?: string;
  last_name?: string;
  email_address?: string;
  bank_account_number?: string; // IBAN the TRY payout goes to
  bank_name?: string;
  [field: string]: string | undefined;
}

export interface Sep12CustomerStatus {
  id?: string;
  status: 'ACCEPTED' | 'PROCESSING' | 'NEEDS_INFO' | 'REJECTED';
  message?: string;
  fields?: Record<string, { type: string; description?: string; optional?: boolean }>;
  provided_fields?: Record<string, { type: string; description?: string; status?: string }>;
}
