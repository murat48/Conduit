import { StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { SOROSWAP_ROUTER_CONFIG } from './constants';
import { SignTransactionFn } from '@/types/anchor';

// Automation keys that cannot be read back.
//
// The key is generated with `extractable: false`, so the browser will sign with it but never hand
// over its bytes — `exportKey` on the private half throws. It lives in IndexedDB as a CryptoKey
// object rather than as text, which means there is no seed sitting in storage for a stray script
// to lift. Stolen-forever becomes usable-only-while-this-page-is-open, and the mandate's on-chain
// limits bound even that.
//
// The trade is that it cannot be backed up either. That is deliberate for a delegate key: losing
// it costs one `set_mandate` to name the replacement, and automation.ts checks for exactly that
// drift before it spends a fee finding out.

const DB_NAME = 'conduit_keys';
const DB_VERSION = 1;
const STORE = 'bot_keys';

export interface SecureKey {
  publicKey: string; // G… address derived from the public half
  privateKey: CryptoKey; // non-extractable; usable, never readable
}

/**
 * Whether this browser can generate non-extractable Ed25519 keys.
 *
 * Ed25519 came to WebCrypto later than the NIST curves and is not everywhere yet, so this is a
 * live probe rather than a version check — callers fall back to the legacy keypair when it fails.
 */
export async function isSecureKeySupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.crypto?.subtle || !window.indexedDB) return false;
  try {
    await window.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        transaction.oncomplete = () => db.close();
      })
  );
}

interface StoredKey {
  publicKey: string;
  privateKey: CryptoKey;
}

/** Generates a fresh non-extractable key for this owner, replacing any previous one. */
export async function createSecureKey(owner: string): Promise<SecureKey> {
  const pair = (await window.crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  // Only the public half is exportable, which is all that is needed to name the delegate on chain.
  const raw = new Uint8Array(await window.crypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = StrKey.encodeEd25519PublicKey(Buffer.from(raw));

  // CryptoKey survives structured cloning, so the key object itself is what gets stored — the
  // bytes behind it are never materialised in JavaScript.
  await withStore<IDBValidKey>('readwrite', store =>
    store.put({ publicKey, privateKey: pair.privateKey } satisfies StoredKey, owner)
  );

  console.log('🔐 Non-extractable automation key created:', publicKey);
  return { publicKey, privateKey: pair.privateKey };
}

export async function loadSecureKey(owner: string): Promise<SecureKey | null> {
  if (typeof window === 'undefined' || !window.indexedDB) return null;
  try {
    const stored = await withStore<StoredKey | undefined>('readonly', store => store.get(owner));
    if (!stored?.publicKey || !stored.privateKey) return null;
    return { publicKey: stored.publicKey, privateKey: stored.privateKey };
  } catch (error) {
    console.log('⚠️ Could not read the stored automation key:', (error as Error).message);
    return null;
  }
}

export async function clearSecureKey(owner: string): Promise<void> {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    await withStore<undefined>('readwrite', store => store.delete(owner));
  } catch (error) {
    console.log('⚠️ Could not clear the stored automation key:', (error as Error).message);
  }
}

/**
 * Signs in the key's name without the Keypair class, which would need the seed.
 *
 * A Stellar signature covers the transaction hash, so the hash is handed to WebCrypto and the
 * result attached as a decorated signature. `addSignature` takes the public key purely to derive
 * the hint, so nothing secret passes through here.
 */
export const secureSigner = (key: SecureKey): SignTransactionFn => async (xdr: string) => {
  const transaction = TransactionBuilder.fromXDR(
    xdr,
    SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE
  ) as Transaction;

  const signature = await window.crypto.subtle.sign(
    { name: 'Ed25519' },
    key.privateKey,
    transaction.hash()
  );

  transaction.addSignature(key.publicKey, Buffer.from(signature).toString('base64'));
  return transaction.toXDR();
};
