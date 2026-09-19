/* eslint-disable @typescript-eslint/no-explicit-any */
export interface QuoteRequest {
  assetIn: string;
  assetOut: string;
  amount: string;
  tradeType: 'EXACT_IN';
  protocols: string[];
  // slippageTolerance?: number;
  slippageBps?:number;
  parts?: number;
  maxHops?: number;
  feeBps?: number;
}
  // tradeType: 'EXACT_IN' | 'EXACT_OUT';
export interface Quote {
  assetIn: string;
  assetOut: string;
  amountIn: string;
  amountOut: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  tradeType: 'EXACT_IN';
  platform: string;

  rawTrade?: any;
  routePlan: RouteStep[];
  trustlineInfo?: TrustlineInfo;
  // gaslessTrustline?: boolean;
  platformFee?: PlatformFee;
}

export interface RouteStep {
  swapInfo: {
    protocol: string;
    path: string[];
  };
  percent: string;
}

export interface TrustlineInfo {
  trustlineCostAssetIn: string;
  trustlineCostAssetOut: string;
}

export interface PlatformFee {
  feeBps: number;
  feeAmount: string;
}

export interface BuildRequest {
  // slippageTolerancePercent: boolean;
  quote: Quote;
  referralId?: string;
  sponsor: string;
  from: string;
}

export interface BuildResponse {
  xdr: string;
}

export interface SendRequest {
  xdr: string;
}

export interface SendResponse {
  hash?: string;
  status?: string;
  message?: string;
}

export interface AssetOption {
  value: string;
  label: string;
  symbol: string;
  type?: string;
  contract?: string;
  code?: string;
  issuer?: string;
  // Depth of the Soroswap pool against the anchor USDC; 'thin' means high price impact
  liquidity?: 'deep' | 'medium' | 'thin';
}

declare global {
  interface Window {
    freighterApi: {
      isConnected(): Promise<boolean>;
      requestAccess(): Promise<{ publicKey: string }>;
      signTransaction(xdr: string, network: string): Promise<string>;
    };
  }
}