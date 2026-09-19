import {
  Account,
  Asset,
  Contract,
  Horizon,
  Operation,
  TransactionBuilder,
  Keypair,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import { soroswapAPI } from './api';
import { ANCHOR_CONFIG, SOROSWAP_ROUTER_CONFIG } from './constants';
import { SignTransactionFn } from '@/types/anchor';

// Most Soroswap tokens are SAC wrappers around classic Stellar assets.
// Receiving one requires a trustline; without it the swap simulation fails with
// Error(Contract, #13). The SAC name() call returns "CODE:ISSUER",
// "native" for XLM, and a plain name for pure Soroban tokens.

export interface ClassicAsset {
  code: string;
  issuer: string;
}

const CLASSIC_NAME = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/;
const assetCache = new Map<string, ClassicAsset | null>();

export async function getClassicAsset(contractId: string): Promise<ClassicAsset | null> {
  if (assetCache.has(contractId)) return assetCache.get(contractId) ?? null;

  const server = new rpc.Server(SOROSWAP_ROUTER_CONFIG.RPC_URL);
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call('name'))
    .setTimeout(30)
    .build();

  let asset: ClassicAsset | null = null;
  try {
    const simulation = await server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationError(simulation) && simulation.result) {
      const name = String(scValToNative(simulation.result.retval));
      const match = CLASSIC_NAME.exec(name);
      if (match) asset = { code: match[1], issuer: match[2] };
    }
  } catch (error) {
    console.log('⚠️ Could not read the token name:', (error as Error).message);
  }

  assetCache.set(contractId, asset);
  return asset;
}

export interface TrustlineResult {
  needed: boolean;
  created: boolean;
  hash?: string;
  asset?: ClassicAsset;
}

export interface TrustlineStatus {
  needed: boolean; // the token is a SAC wrapping a classic asset, so a trustline is required
  exists: boolean;
  asset?: ClassicAsset;
}

// Read-only check. Delegated mode needs this: the bot cannot open a trustline on the owner's
// account, so a missing one has to be reported rather than fixed.
export async function checkTokenTrustline(account: string, contractId: string): Promise<TrustlineStatus> {
  const asset = await getClassicAsset(contractId);
  if (!asset) return { needed: false, exists: true };

  const horizon = new Horizon.Server(ANCHOR_CONFIG.HORIZON_URL);
  const loaded = await horizon.loadAccount(account);
  const existing = loaded.balances.some(
    balance => 'asset_code' in balance && balance.asset_code === asset.code && balance.asset_issuer === asset.issuer
  );
  return { needed: true, exists: existing, asset };
}

// Checks several tokens against one account with a single Horizon read.
// Returns the contract ids that still need a trustline.
export async function missingTrustlines(account: string, contractIds: string[]): Promise<string[]> {
  const unique = [...new Set(contractIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const assets = await Promise.all(unique.map(id => getClassicAsset(id)));

  const horizon = new Horizon.Server(ANCHOR_CONFIG.HORIZON_URL);
  let held: Set<string>;
  try {
    const loaded = await horizon.loadAccount(account);
    held = new Set(
      loaded.balances
        .filter(balance => 'asset_code' in balance)
        .map(balance => {
          const line = balance as { asset_code: string; asset_issuer: string };
          return `${line.asset_code}:${line.asset_issuer}`;
        })
    );
  } catch (error) {
    // An account that does not exist yet simply trusts nothing
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status !== 404) throw error;
    held = new Set();
  }

  return unique.filter((id, index) => {
    const asset = assets[index];
    return asset !== null && !held.has(`${asset.code}:${asset.issuer}`);
  });
}

// Opens a trustline when needed. Does nothing if it exists, for XLM, or for pure Soroban tokens.
export async function ensureTokenTrustline(
  account: string,
  contractId: string,
  signTransaction: SignTransactionFn
): Promise<TrustlineResult> {
  const status = await checkTokenTrustline(account, contractId);
  if (!status.needed) return { needed: false, created: false };

  const asset = status.asset as ClassicAsset;
  if (status.exists) return { needed: true, created: false, asset };

  const horizon = new Horizon.Server(ANCHOR_CONFIG.HORIZON_URL);
  const loaded = await horizon.loadAccount(account);

  console.log(`🔗 Opening ${asset.code} trustline...`);
  let fee = '1000';
  try {
    fee = String(await horizon.fetchBaseFee());
  } catch {
    // continue with the default fee
  }

  const transaction = new TransactionBuilder(loaded, {
    fee,
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) }))
    .setTimeout(180)
    .build();

  const signed = await signTransaction(transaction.toXDR());
  const result = await soroswapAPI.sendTransaction({ xdr: signed });
  console.log(`✅ ${asset.code} trustline opened: ${result.hash}`);
  return { needed: true, created: true, hash: result.hash, asset };
}
