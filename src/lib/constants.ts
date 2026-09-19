import { AssetOption } from '@/types';

export const API_CONFIG = {
  NETWORK: 'testnet' as const,
};

// The Soroswap API indexer does not see testnet pools, so swaps go straight through the router contract.
// These addresses are public: https://github.com/soroswap/core/blob/main/public/testnet.contracts.json
export const SOROSWAP_ROUTER_CONFIG = {
  RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  ROUTER: process.env.NEXT_PUBLIC_SOROSWAP_ROUTER || 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  FACTORY: process.env.NEXT_PUBLIC_SOROSWAP_FACTORY || 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY',
  XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', // hub token for multi-hop routes
  USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', // SAC address of the anchor's USDC
  TX_DEADLINE_SECONDS: 300,
  TX_POLL_TIMEOUT_MS: 60000,
};

// Mandate contract (contracts/mandate): the owner's automation rule, enforced on chain.
// The owner approves THIS contract as the token spender — never the automation wallet — so the
// automation wallet holds no spending power of its own and cannot step outside the mandate.
export const MANDATE_CONFIG = {
  CONTRACT:
    process.env.NEXT_PUBLIC_MANDATE_CONTRACT ||
    'CAAPS6MYLC2DQ4TPOCRDKBCG4HVSQ35P4PCGQ7LAIISHQSPCP4RJ7DPO',
  // One window per day, matching the allowance TTL the UI offers.
  DEFAULT_WINDOW_LEDGERS: 17280,
};

// Fiat on/off-ramp anchor (SEP-1/6/10/12/38). No API key: identity is the SEP-10 challenge the user signs.
export const ANCHOR_CONFIG = {
  HOME_DOMAIN: process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN || 'tr-mock-anchor.fly.dev',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  FIAT_ASSET: 'iso4217:TRY',
  FUNDING_METHOD: 'bank_account',
  DEFAULT_ASSET_CODE: 'USDC',
  REQUEST_TIMEOUT_MS: 30000,
  JWT_REFRESH_MARGIN_MS: 60000, // refresh the token one minute before it expires
};

// Tokens with a DIRECT Soroswap pool against the anchor's USDC on testnet (verified by scanning the on-chain factory).
// liquidity: depth of the USDC side of the pool. 'thin' pools move a lot even on small amounts.
// Order matters: [0] XLM and [2] USDC are referenced by index in the price page and MultisigSwapTrader.
export const ASSET_OPTIONS: AssetOption[] = [
  {
    value: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    label: 'Stellar Lumens (XLM)',
    symbol: 'XLM',
    type: 'native',
    liquidity: 'deep' // 416.615 USDC / 3.940.551 XLM
  },
  {
    value: 'CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE',
    label: 'Aquarius (AQUA)',
    symbol: 'AQUA',
    type: 'contract',
    contract: 'CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE',
    liquidity: 'deep' // 134.329 USDC
  },
  {
    // The USDC paid out by the anchor (tr-mock-anchor.fly.dev): USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 (SAC)
    value: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    label: 'USD Coin (USDC)',
    symbol: 'USDC',
    type: 'contract',
    contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    liquidity: 'deep'
  },
  {
    value: 'CDDCKBVUKM4ADZHCTLFT263CYRTKG2YIWLIA6XWM5IVF3GWKRNRGS5JD',
    label: 'Euro Coin (EURC)',
    symbol: 'EURC',
    type: 'contract',
    contract: 'CDDCKBVUKM4ADZHCTLFT263CYRTKG2YIWLIA6XWM5IVF3GWKRNRGS5JD',
    liquidity: 'thin' // 100 USDC / 87,71 EURC
  },
  {
    value: 'CAAPMDMWJGCP3D4JTEEWT3E2OEG5HB6A7EKHCNWYBCUOLRGQEGAKZORW',
    label: 'Gold (XAU)',
    symbol: 'XAU',
    type: 'contract',
    contract: 'CAAPMDMWJGCP3D4JTEEWT3E2OEG5HB6A7EKHCNWYBCUOLRGQEGAKZORW',
    liquidity: 'thin' // 100 USDC / 0,025 XAU
  },
  {
    value: 'CBNHH37BJ2G4ZT6PLWDXPOWHKLR75IGNLBRCXZNOS7YPAYS53JPEPSSS',
    label: 'PayPal USD (PYUSD)',
    symbol: 'PYUSD',
    type: 'contract',
    contract: 'CBNHH37BJ2G4ZT6PLWDXPOWHKLR75IGNLBRCXZNOS7YPAYS53JPEPSSS',
    liquidity: 'medium' // 7.072 USDC
  },
  {
    value: 'CDRQV3D3GLWF73MWTEQWFZWMBQ47KZ3KECYPOBKBDRQBWQQ74KDH5ECT',
    label: 'Ondo US Dollar Yield (USDY)',
    symbol: 'USDY',
    type: 'contract',
    contract: 'CDRQV3D3GLWF73MWTEQWFZWMBQ47KZ3KECYPOBKBDRQBWQQ74KDH5ECT',
    liquidity: 'medium' // 7.107 USDC
  },
  {
    value: 'CCACIMR6I2XR35HSQSPYNTIZSK7IRVLPKAMSZPHW57SSUC44IZGN3TCX',
    label: 'Korea Treasury Bond (KTB)',
    symbol: 'KTB',
    type: 'contract',
    contract: 'CCACIMR6I2XR35HSQSPYNTIZSK7IRVLPKAMSZPHW57SSUC44IZGN3TCX',
    liquidity: 'medium' // 4.587 USDC
  },
  {
    value: 'CAPFX3QEAHE7JVT6E7PYZQTFSVS5Z7AV4RE7GRJRVCPKXGQHCWSCOMTW',
    label: 'Brazil Treasury (TESOURO)',
    symbol: 'TESOURO',
    type: 'contract',
    contract: 'CAPFX3QEAHE7JVT6E7PYZQTFSVS5Z7AV4RE7GRJRVCPKXGQHCWSCOMTW',
    liquidity: 'medium' // 1.550 USDC
  },
  {
    value: 'CAJ4B2ZWU2GA7UYQZ7N7QQCTZAUSSXNKKQ326ADYVH3ALN4FFQ6LPO4U',
    label: 'Mexico Treasury (CETES)',
    symbol: 'CETES',
    type: 'contract',
    contract: 'CAJ4B2ZWU2GA7UYQZ7N7QQCTZAUSSXNKKQ326ADYVH3ALN4FFQ6LPO4U',
    liquidity: 'medium' // 1.482 USDC
  },
  {
    value: 'CCAYGJWQI5NJN7XRVNSENF47PICNSNTG4FAQHHFOJWZIRTEAC5JPMLGN',
    label: 'US Treasury (USTRY)',
    symbol: 'USTRY',
    type: 'contract',
    contract: 'CCAYGJWQI5NJN7XRVNSENF47PICNSNTG4FAQHHFOJWZIRTEAC5JPMLGN',
    liquidity: 'medium' // 1.448 USDC
  },
  {
    value: 'CBZ6HCAROY7S3ETZEFPEPPKBVCSK6P3HURCWDGMEUK7XR3HNNYVDS7MH',
    label: 'Ethereum (ETH)',
    symbol: 'ETH',
    type: 'contract',
    contract: 'CBZ6HCAROY7S3ETZEFPEPPKBVCSK6P3HURCWDGMEUK7XR3HNNYVDS7MH',
    liquidity: 'thin' // 100 USDC / 0,064 ETH
  },
  {
    value: 'CAXOVFQWGE3AMNZEKQH7ZURQ7PFZQWDHGWRZWMF3LMVVP7DIXIO7IVX3',
    label: 'Solana (SOL)',
    symbol: 'SOL',
    type: 'contract',
    contract: 'CAXOVFQWGE3AMNZEKQH7ZURQ7PFZQWDHGWRZWMF3LMVVP7DIXIO7IVX3',
    liquidity: 'thin' // 100 USDC / 1,42 SOL
  },
  {
    value: 'CDJ3TQBUY4OO2VRVLPIVWA7JR56IHPHSO5JFWSUOLOSOL5GJDGBE5DLA',
    label: 'Bitcoin (BTC)',
    symbol: 'BTC',
    type: 'contract',
    contract: 'CDJ3TQBUY4OO2VRVLPIVWA7JR56IHPHSO5JFWSUOLOSOL5GJDGBE5DLA',
    liquidity: 'thin' // 107 USDC / 0,0016 BTC
  }
];
export const DEFAULT_PROTOCOLS = ['soroswap'];
export const DEFAULT_SLIPPAGE = 1000; // 1% slippage tolerance
export const DEFAULT_FEE_BPS = 50; // 0.5% platform fee
export const DEFAULT_FEE_PARTS = 50; // Split into 5 parts max

// Asset-specific configurations for maxHops
// Slippage by pool depth. Every asset has a direct USDC pool, so maxHops 1 is enough.
export const ASSET_CONFIGS = {
  // Deep pools
  'USDC': { maxHops: 1, slippageBps: 500 },
  'XLM': { maxHops: 1, slippageBps: 500 },
  'AQUA': { maxHops: 1, slippageBps: 500 },

  // Medium pools
  'PYUSD': { maxHops: 1, slippageBps: 1000 },
  'USDY': { maxHops: 1, slippageBps: 1000 },
  'KTB': { maxHops: 1, slippageBps: 1000 },
  'TESOURO': { maxHops: 1, slippageBps: 1000 },
  'CETES': { maxHops: 1, slippageBps: 1000 },
  'USTRY': { maxHops: 1, slippageBps: 1000 },

  // Thin pools: even small amounts move the price a lot
  'EURC': { maxHops: 1, slippageBps: 2000 },
  'XAU': { maxHops: 1, slippageBps: 2000 },
  'ETH': { maxHops: 1, slippageBps: 2000 },
  'SOL': { maxHops: 1, slippageBps: 2000 },
  'BTC': { maxHops: 1, slippageBps: 2000 },
};

// Default values for unknown assets
export const DEFAULT_ASSET_CONFIG = { maxHops: 2, slippageBps: 1200 };

// export const DEFAULT_FEE_PARTS = 1; // Split into 5 parts max
export const DEFAULT_FEE_MAXHOPS = 1; // Maximum 2 hops for better liquidity
