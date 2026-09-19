import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { soroswapAPI } from './api';
import { ANCHOR_CONFIG, SOROSWAP_ROUTER_CONFIG } from './constants';
import { SignTransactionFn } from '@/types/anchor';
import { clearSecureKey, createSecureKey, isSecureKeySupported, loadSecureKey, secureSigner } from './secure-key';

// Automation wallet: the account named as the mandate's delegate, which signs the rule's swaps
// without an approval popup.
//
// New wallets hold a non-extractable key (see secure-key.ts): the browser signs with it but cannot
// read it back, so there is no seed in storage to steal. Wallets created before that still carry a
// plaintext seed in localStorage and keep working, because the mandate on chain names them by
// address — discarding one silently would orphan its mandate. `isLegacy` marks those so the UI can
// offer to replace them.

export interface BotWallet {
  publicKey: string;
  /** Legacy wallets only: the raw seed, readable by anything running on this origin. */
  secret?: string;
  /** Current wallets: a signing key the browser will use but never disclose. */
  key?: CryptoKey;
}

export const isLegacy = (wallet: BotWallet): boolean => Boolean(wallet.secret);

export interface SweepResult {
  hash?: string;
  moved: string[];
  skipped: string[];
}

const FRIENDBOT = 'https://friendbot.stellar.org';
const XLM_RESERVE = 1; // buffer kept above the minimum balance for fees

const key = (owner: string) => `conduit_bot_${owner}`;
const horizon = () => new Horizon.Server(ANCHOR_CONFIG.HORIZON_URL);

/**
 * The automation wallet for this owner, preferring the non-extractable key and falling back to a
 * legacy plaintext one so an existing mandate keeps its delegate.
 */
export async function loadBotWallet(owner: string): Promise<BotWallet | null> {
  if (typeof window === 'undefined') return null;

  const secure = await loadSecureKey(owner);
  if (secure) return { publicKey: secure.publicKey, key: secure.privateKey };

  try {
    const raw = window.localStorage.getItem(key(owner));
    if (!raw) return null;
    const wallet = JSON.parse(raw) as { publicKey?: string; secret?: string };
    return wallet.publicKey && wallet.secret
      ? { publicKey: wallet.publicKey, secret: wallet.secret }
      : null;
  } catch {
    return null;
  }
}

/**
 * Creates a wallet whose key cannot be read back. Browsers without Ed25519 in WebCrypto fall back
 * to a plaintext seed, because a bot that cannot sign at all is worse than one that signs with a
 * key at risk — the mandate bounds what either can do.
 */
export async function createBotWallet(owner: string): Promise<BotWallet> {
  if (await isSecureKeySupported()) {
    const secure = await createSecureKey(owner);
    // A legacy seed for the same owner would otherwise linger in storage unused.
    window.localStorage.removeItem(key(owner));
    return { publicKey: secure.publicKey, key: secure.privateKey };
  }

  console.log('⚠️ This browser has no Ed25519 WebCrypto; falling back to a stored seed');
  const keypair = Keypair.random();
  const wallet = { publicKey: keypair.publicKey(), secret: keypair.secret() };
  window.localStorage.setItem(key(owner), JSON.stringify(wallet));
  console.log('🤖 Automation wallet created:', wallet.publicKey);
  return wallet;
}

export async function clearBotWallet(owner: string): Promise<void> {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(key(owner));
  await clearSecureKey(owner);
}

// Signer handed to the rule engine: signs without opening a wallet popup
export const botSigner = (wallet: BotWallet): SignTransactionFn => {
  if (wallet.key) {
    return secureSigner({ publicKey: wallet.publicKey, privateKey: wallet.key });
  }
  return async (xdr: string) => {
    const transaction = TransactionBuilder.fromXDR(xdr, SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE);
    transaction.sign(Keypair.fromSecret(wallet.secret as string));
    return transaction.toXDR();
  };
};

/** Friendbot, for any testnet account — the automation wallet, or an owner's brand-new one. */
export async function fundTestnetAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT}?addr=${publicKey}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok && response.status !== 400) {
    throw new Error(`Friendbot error: HTTP ${response.status}`);
  }
}

export async function getBotBalances(publicKey: string): Promise<{ asset: string; balance: string }[]> {
  try {
    const account = await horizon().loadAccount(publicKey);
    return account.balances.map(balance => ({
      asset: 'asset_code' in balance ? balance.asset_code : 'XLM',
      balance: balance.balance,
    }));
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 404) return [];
    throw error;
  }
}

// Sends the assets in the bot wallet back to the main wallet.
// Assets the main wallet does not trust are skipped (such a payment would fail the whole transaction).
export async function sweepToOwner(wallet: BotWallet, owner: string): Promise<SweepResult> {
  const server = horizon();
  const [botAccount, ownerAccount] = await Promise.all([
    server.loadAccount(wallet.publicKey),
    server.loadAccount(owner),
  ]);

  const ownerTrusts = new Set(
    ownerAccount.balances
      .filter(balance => 'asset_code' in balance)
      .map(balance => `${(balance as { asset_code: string }).asset_code}:${(balance as { asset_issuer: string }).asset_issuer}`)
  );

  let fee = '1000';
  try {
    fee = String(await server.fetchBaseFee());
  } catch {
    // continue with the default fee
  }

  const builder = new TransactionBuilder(botAccount, {
    fee,
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  });

  const moved: string[] = [];
  const skipped: string[] = [];

  for (const balance of botAccount.balances) {
    if (!('asset_code' in balance)) continue;
    const code = balance.asset_code as string;
    const issuer = balance.asset_issuer as string;
    if (Number(balance.balance) <= 0) continue;
    if (!ownerTrusts.has(`${code}:${issuer}`)) {
      skipped.push(`${code} (no trustline in the main wallet)`);
      continue;
    }
    builder.addOperation(Operation.payment({
      destination: owner,
      asset: new Asset(code, issuer),
      amount: balance.balance,
    }));
    moved.push(`${balance.balance} ${code}`);
  }

  // Stellar minimum balance: (2 + subentries) × 0.5 XLM. Trustlines count as subentries.
  const native = botAccount.balances.find(balance => balance.asset_type === 'native');
  const minBalance = (2 + (botAccount.subentry_count ?? 0)) * 0.5;
  const spare = native ? Number(native.balance) - minBalance - XLM_RESERVE : 0;
  if (spare > 0.5) {
    builder.addOperation(Operation.payment({ destination: owner, asset: Asset.native(), amount: spare.toFixed(7) }));
    moved.push(`${spare.toFixed(4)} XLM`);
  }

  if (moved.length === 0) {
    return { moved, skipped };
  }

  // Signed through botSigner so a non-extractable key works here too; the sweep is the one path
  // that must keep working for a wallet being retired.
  const transaction = builder.setTimeout(180).build();
  const signed = await botSigner(wallet)(transaction.toXDR());
  const result = await soroswapAPI.sendTransaction({ xdr: signed });
  console.log('🤖 Automation wallet swept:', result.hash);
  return { hash: result.hash, moved, skipped };
}
