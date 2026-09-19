import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { SOROSWAP_ROUTER_CONFIG } from './constants';
import { SignTransactionFn } from '@/types/anchor';

/**
 * Sign in with a passkey, without a browser extension.
 *
 * The passkey does not hold the Stellar key — it derives it. WebAuthn's PRF extension returns the
 * same 32 bytes every time for a given credential and salt, and never returns them to anyone who
 * cannot satisfy the authenticator, so those bytes are used as an Ed25519 seed. What the user
 * keeps is a passkey their platform already syncs and backs up; what the app gets, for as long as
 * the tab is open, is an ordinary `G…` account.
 *
 * ## Why not a smart account
 *
 * The obvious design is the one everyone reaches for: a contract account that verifies secp256r1
 * signatures, so the passkey signs for the chain directly. It cannot be used here. This app's
 * whole point is the fiat loop, and the anchor authenticates with SEP-10 — a challenge
 * transaction signed by a classic keypair. A contract account has no such key; it needs SEP-45,
 * which this anchor does not serve (its stellar.toml offers WEB_AUTH_ENDPOINT and nothing else).
 * A smart account would therefore be unable to deposit or withdraw, which is most of the product.
 *
 * Deriving a classic key keeps SEP-10, SEP-6, the mandate and every signature path working
 * unchanged, and still removes the extension. The trade is that this is passkey authentication
 * rather than on-chain passkey authorisation: the chain sees an ordinary account.
 *
 * ## What this is not
 *
 * Not a way to recover an existing wallet — the seed comes from the credential, so a passkey made
 * here names a new account. And not available everywhere: PRF is an extension, and an
 * authenticator may decline it, which `isPasskeySupported` finds out by asking rather than by
 * guessing from a version string.
 */

const STORAGE_KEY = 'conduit_passkey_credential';
const RP_NAME = 'Conduit';
/** Fixed, so the same credential always derives the same account. */
const PRF_SALT = new TextEncoder().encode('conduit:stellar:ed25519:v1');

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
};

const storedCredentialId = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Only the credential id, which is not secret — it names the passkey, it does not open it. */
const rememberCredential = (id: string): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A blocked store costs the "sign in" shortcut, not the ability to sign in.
  }
};

export const forgetPasskey = (): void => {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to undo */
  }
};

/** Whether this browser can do WebAuthn at all. PRF support is only known once one is used. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials &&
    // Passkeys need a secure context; localhost counts.
    window.isSecureContext &&
    // An rp id has to be a domain. Reaching a dev server by IP — which is the ordinary way to
    // open it from a phone, or from Windows against a server in WSL — cannot work, and fails as
    // a flat "not allowed" rather than as anything that names the address.
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname)
  );
}

/**
 * Whether the device has a built-in authenticator ready to use — Windows Hello, Touch ID, a
 * phone's screen lock.
 *
 * Asked before the ceremony rather than after it fails. Without one, the browser still shows a
 * prompt, the prompt has nothing to offer, and it closes as `NotAllowedError`: the same error a
 * user gets for pressing Escape. Telling those two apart afterwards is impossible, so the
 * question is asked first.
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** True when a passkey for this app has been made in this browser before. */
export const hasPasskey = (): boolean => isPasskeySupported() && !!storedCredentialId();

const randomChallenge = (): Uint8Array => window.crypto.getRandomValues(new Uint8Array(32));

const prfResult = (credential: PublicKeyCredential): ArrayBuffer | null => {
  const extensions = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  return extensions.prf?.results?.first ?? null;
};

/**
 * The Stellar keypair behind a PRF output.
 *
 * Hashed rather than used raw: PRF output is already uniform, but hashing domain-separates this
 * app's key from anything else the same credential might derive later, and it costs nothing.
 */
async function keypairFromPrf(prf: ArrayBuffer): Promise<Keypair> {
  const digest = await window.crypto.subtle.digest('SHA-256', prf);
  return Keypair.fromRawEd25519Seed(Buffer.from(new Uint8Array(digest)));
}

/**
 * What a sign-in yields. An address and nothing else.
 *
 * Deliberately not a keypair. Handing one out would put the private key wherever the caller
 * chose to keep it, for as long as it chose to — and a key kept for the life of the tab is
 * readable by anything running on this origin, which is the property a wallet extension exists
 * to avoid.
 *
 * Instead the key stays in this module, behind a window that closes (see SESSION_MS). Callers get
 * an address and a signer; the signer asks the passkey again once the window has lapsed.
 */
export interface PasskeyIdentity {
  publicKey: string;
}

const PRF_UNAVAILABLE =
  'This passkey cannot derive a key: its authenticator does not support the PRF extension. ' +
  'Use a wallet extension instead, or try a device whose passkeys are stored by the platform.';

const assertPlatform = async (): Promise<void> => {
  if (!isPasskeySupported()) {
    throw new Error(
      /^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname)
        ? `Passkeys cannot be used on an IP address (${window.location.hostname}). Open the app on localhost or a domain name.`
        : 'This browser cannot use passkeys — it needs WebAuthn over a secure origin.'
    );
  }
  if (!(await hasPlatformAuthenticator())) {
    throw new Error(
      'This device has no passkey authenticator set up. Enable Windows Hello, Touch ID or a screen ' +
        'lock — or connect a security key — and try again. Until then, use a wallet extension.'
    );
  }
};

/** Create a passkey and report the address it derives. */
export async function createPasskey(label: string): Promise<PasskeyIdentity> {
  await assertPlatform();

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge(),
      rp: { name: RP_NAME, id: window.location.hostname },
      user: {
        // Not an identity, just a handle: this app has no accounts of its own.
        id: window.crypto.getRandomValues(new Uint8Array(16)),
        name: label,
        displayName: label,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256, for authenticators that only do RSA
      ],
      authenticatorSelection: {
        // Preferred, not required. A discoverable credential is what makes "sign in" work with no
        // username, which is nice — but demanding it turns an authenticator that cannot store one
        // into a flat refusal, and an authenticator that refuses is worse than a shortcut lost.
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      timeout: 120000,
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error('No passkey was created.');
  rememberCredential(toBase64Url(credential.rawId));

  const extensions = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  if (extensions.prf?.enabled === false) {
    forgetPasskey();
    throw new Error(PRF_UNAVAILABLE);
  }

  // Newer authenticators answer PRF during creation, which is the whole ceremony done in one
  // prompt. Older ones only answer on an assertion, so a second prompt follows — asking for two
  // in a row where one will do is the difference between a sign-in and an interrogation.
  const atCreation = extensions.prf?.results?.first;
  if (atCreation) {
    const keypair = await keypairFromPrf(atCreation);
    unlocked = { keypair, expiresAt: Date.now() + SESSION_MS };
    return { publicKey: keypair.publicKey() };
  }

  try {
    return await unlockPasskey();
  } catch (error) {
    forgetPasskey();
    throw error;
  }
}

/**
 * How long one passkey ceremony keeps the derived key usable.
 *
 * The honest position is that a key is only as safe as the time it spends in reach: while this
 * window is open the key is in page memory, and anything running on this origin could use it.
 * Deriving per signature avoids that entirely but asks for a touch on every transaction, which
 * during a working session is enough friction that people look for a way around it — and the way
 * around it is worse than a bounded window.
 *
 * So: bounded, and measured from the sign-in rather than from the last use. A sliding window
 * would stay open as long as someone keeps working, which is the opposite of a limit.
 */
const SESSION_MS = 6 * 60 * 60 * 1000;

let unlocked: { keypair: Keypair; expiresAt: number } | null = null;

/** When the current unlock lapses, or null when there is none. For the UI to say so. */
export const passkeyUnlockedUntil = (): number | null =>
  unlocked && unlocked.expiresAt > Date.now() ? unlocked.expiresAt : null;

/** Drop the derived key now, without touching the credential it came from. */
export const lockPasskey = (): void => {
  unlocked = null;
};

/**
 * One ceremony: prove the passkey, derive the key, hold it for the session window.
 *
 * Reuses the unlock while it lasts, and asks again once it does not. The credential itself is
 * never held — only the key it derives, and only for as long as the window allows.
 */
async function deriveKeypair(): Promise<Keypair> {
  if (unlocked && unlocked.expiresAt > Date.now()) return unlocked.keypair;
  unlocked = null;

  await assertPlatform();

  const known = storedCredentialId();
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      rpId: window.location.hostname,
      // With no remembered credential the platform offers whatever it holds for this site.
      allowCredentials: known ? [{ type: 'public-key', id: fromBase64Url(known) }] : [],
      userVerification: 'preferred',
      timeout: 120000,
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error('No passkey was used.');

  const prf = prfResult(assertion);
  if (!prf) throw new Error(PRF_UNAVAILABLE);

  rememberCredential(toBase64Url(assertion.rawId));
  const keypair = await keypairFromPrf(prf);
  unlocked = { keypair, expiresAt: Date.now() + SESSION_MS };
  return keypair;
}

/** Sign in with the passkey this browser already knows, or any the user picks. */
export async function unlockPasskey(): Promise<PasskeyIdentity> {
  // The keypair is local to this call and unreferenced once it returns, so nothing but the
  // address survives the sign-in.
  return { publicKey: (await deriveKeypair()).publicKey() };
}

/**
 * A signer that asks the passkey each time.
 *
 * `expected` is the address the session believes it is. A passkey picker can offer more than one
 * credential, and a different credential derives a different account — signing with it would
 * produce a transaction the network rejects for a source that does not match, or worse, one it
 * accepts against an account the user was not looking at. Checked rather than assumed.
 */
export function passkeySigner(expected: string): SignTransactionFn {
  return async (xdr: string) => {
    const keypair = await deriveKeypair();
    if (keypair.publicKey() !== expected) {
      throw new Error(
        'That passkey belongs to a different account than the one signed in. Pick the passkey for ' +
          `${expected.slice(0, 6)}…${expected.slice(-4)}, or sign in again with the one you used.`
      );
    }
    const transaction = TransactionBuilder.fromXDR(
      xdr,
      SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE
    ) as Transaction;
    transaction.sign(keypair);
    return transaction.toXDR();
  };
}
