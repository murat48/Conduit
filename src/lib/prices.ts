import { Account, Address, Contract, Keypair, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk';
import { getIndicativePrice, stellarAssetId } from './anchor';
import { ANCHOR_CONFIG, ASSET_OPTIONS, SOROSWAP_ROUTER_CONFIG } from './constants';

// Reference prices per asset, quoted in USDC, TRY and EURC.
// The USDC price comes from the Soroswap pool reserves (spot, so no price impact from quoting),
// the TRY price from the anchor's SEP-38 indicative rate, and EURC is converted via USDC.

export interface AssetPrice {
  usdc: number;
  try: number;
  eurc: number;
}

export type PriceTable = Record<string, AssetPrice>;

const EURC_CONTRACT = ASSET_OPTIONS.find(asset => asset.symbol === 'EURC')?.value ?? '';

const readReserves = async (assetContract: string): Promise<{ asset: number; usdc: number } | null> => {
  const server = new rpc.Server(SOROSWAP_ROUTER_CONFIG.RPC_URL);
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(SOROSWAP_ROUTER_CONFIG.ROUTER).call(
        'get_reserves',
        new Address(SOROSWAP_ROUTER_CONFIG.FACTORY).toScVal(),
        new Address(assetContract).toScVal(),
        new Address(SOROSWAP_ROUTER_CONFIG.USDC).toScVal()
      )
    )
    .setTimeout(30)
    .build();

  try {
    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation) || !simulation.result) return null;
    const [assetReserve, usdcReserve] = scValToNative(simulation.result.retval) as bigint[];
    if (!assetReserve || !usdcReserve) return null;
    return { asset: Number(assetReserve), usdc: Number(usdcReserve) };
  } catch (error) {
    console.log('⚠️ Could not read pool reserves:', (error as Error).message);
    return null;
  }
};

// How many USDC one unit of the asset is worth
const usdcPrice = async (assetContract: string): Promise<number | null> => {
  if (assetContract === SOROSWAP_ROUTER_CONFIG.USDC) return 1;
  const reserves = await readReserves(assetContract);
  if (!reserves || reserves.asset === 0) return null;
  return reserves.usdc / reserves.asset;
};

/**
 * One unit of `base` priced in `quote`, read from the pool reserves the swap itself would go
 * through. Both sides are quoted against USDC and divided, because every pool in this deployment
 * pairs against USDC. Returns null when either side has no readable pool.
 *
 * This is deliberately the venue's own price rather than an oracle's. The mandate contract checks
 * its price bounds against the executed swap, and on testnet the pools sit a long way from the
 * real-world rate — so a rule that fired on an outside reference would keep asking the router for
 * a fill the pool cannot produce. Unlike getAssetPrices this touches no anchor endpoint, which
 * makes it cheap enough to poll.
 */
export async function getPoolPrice(base: string, quote: string): Promise<number | null> {
  const [basePrice, quotePrice] = await Promise.all([usdcPrice(base), usdcPrice(quote)]);
  if (!basePrice || !quotePrice) return null;
  return basePrice / quotePrice;
}

export async function getAssetPrices(assetContracts: string[]): Promise<PriceTable> {
  const unique = [...new Set(assetContracts.filter(Boolean))];

  // USD/TRY: the anchor reports how many TRY it pays for selling 1 USDC
  let tryPerUsdc = 0;
  try {
    const price = await getIndicativePrice(
      stellarAssetId('USDC', ASSET_OPTIONS.find(asset => asset.symbol === 'USDC')?.issuer ?? ''),
      ANCHOR_CONFIG.FIAT_ASSET,
      '1'
    );
    tryPerUsdc = Number(price.buyAmount);
  } catch (error) {
    console.log('⚠️ Could not read the USD/TRY rate:', (error as Error).message);
  }

  const usdcPerEurc = EURC_CONTRACT ? await usdcPrice(EURC_CONTRACT) : null;

  const entries = await Promise.all(
    unique.map(async contract => {
      const usdc = await usdcPrice(contract);
      if (usdc === null) return null;
      return [
        contract,
        {
          usdc,
          try: tryPerUsdc ? usdc * tryPerUsdc : 0,
          eurc: usdcPerEurc ? usdc / usdcPerEurc : 0,
        },
      ] as const;
    })
  );

  return Object.fromEntries(entries.filter(Boolean) as [string, AssetPrice][]);
}

// Display helper: trims decimals on large numbers
export const formatPrice = (value: number): string => {
  if (!value || !Number.isFinite(value)) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return value.toLocaleString('en-US', { maximumFractionDigits: 7 });
};
