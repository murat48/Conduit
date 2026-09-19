'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  createPasskey, hasPasskey, hasPlatformAuthenticator, isPasskeySupported,
  lockPasskey, passkeySigner, passkeyUnlockedUntil, unlockPasskey,
} from '@/lib/passkey';

// Stellar Wallets Kit is browser-only, so it is imported dynamically to keep it out of SSR.
type KitModule = typeof import('@creit.tech/stellar-wallets-kit');

interface LoadedKit {
  kit: KitModule['StellarWalletsKit'];
  KitEventType: KitModule['KitEventType'];
}

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

let kitPromise: Promise<LoadedKit> | null = null;

const loadWalletsKit = (): Promise<LoadedKit> => {
  if (!kitPromise) {
    kitPromise = Promise.all([
      import('@creit.tech/stellar-wallets-kit'),
      import('@creit.tech/stellar-wallets-kit/modules/utils'),
    ])
      .then(([kitModule, { defaultModules }]) => {
        // The kit defaults to PUBLIC; this app runs on testnet, so it is set explicitly
        kitModule.StellarWalletsKit.init({
          modules: defaultModules(),
          network: kitModule.Networks.TESTNET,
        });
        console.log('✅ Stellar Wallets Kit initialised (testnet)');
        return { kit: kitModule.StellarWalletsKit, KitEventType: kitModule.KitEventType };
      })
      .catch((error) => {
        kitPromise = null; // reload on the next attempt
        throw error;
      });
  }
  return kitPromise;
};

// Kit errors arrive as { code, message } objects rather than Error instances
const toError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error('Unknown wallet error');
};

interface WalletState {
  isAvailable: boolean;
  isConnected: boolean;
  publicKey: string;
  error: string | null;
}

// Passkey errors are DOMExceptions whose names carry the meaning; the messages are written for
// browser engineers. A dismissed prompt is not a failure worth a red banner.
const describePasskeyError = (error: unknown): Error => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      // The browser gives one error for several situations: the prompt was closed, it timed out,
      // or it had nothing to show because no authenticator answered. The platform check runs
      // before the ceremony precisely so this can name the third case separately — reaching here
      // means the first two are the live possibilities.
      return new Error(
        'The passkey prompt closed without completing — dismissed, timed out, or refused by the ' +
          'authenticator. Try again and complete the device prompt, or use a wallet extension.'
      );
    }
    if (error.name === 'NotSupportedError') {
      return new Error('This device cannot make a passkey of the kind Conduit needs. Use a wallet extension.');
    }
    if (error.name === 'AbortError') {
      return new Error('The passkey request was cancelled.');
    }
    if (error.name === 'InvalidStateError') {
      return new Error('This device already has a passkey for Conduit — use "Sign in" instead.');
    }
    if (error.name === 'SecurityError') {
      return new Error('Passkeys need a secure origin: open the app over HTTPS, or on localhost.');
    }
  }
  return toError(error);
};

interface WalletHook extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signTransaction: (xdr: string) => Promise<string>;
  checkConnection: () => Promise<boolean>;
  /** Whether this browser can do passkeys at all, so the option can be hidden when it cannot. */
  passkeyAvailable: boolean;
  /** Whether a passkey for this app was made here before — "sign in" rather than "create". */
  passkeyKnown: boolean;
  /** True while the session is a passkey one rather than an extension one. */
  usingPasskey: boolean;
  /** Epoch ms at which the passkey unlock lapses and signing asks again; null when locked. */
  passkeyUntil: number | null;
  connectPasskey: (label?: string) => Promise<void>;
}

export const useWallet = (): WalletHook => {
  const [state, setState] = useState<WalletState>({
    isAvailable: false,
    isConnected: false,
    publicKey: '', // starts empty; filled once the kit restores a session
    error: null,
  });
  // The signed-in address, held in a ref because every signature reads it and a stale closure
  // here would sign for the wrong account rather than merely render something out of date. Only
  // the address: the key is derived per signature and never kept (see lib/passkey.ts).
  const passkey = useRef<string | null>(null);
  const [usingPasskey, setUsingPasskey] = useState(false);
  /** When the current unlock lapses, so the header can say how long signing stays quiet. */
  const [passkeyUntil, setPasskeyUntil] = useState<number | null>(null);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyKnown, setPasskeyKnown] = useState(false);

  // WebAuthn is a browser API, so this waits for the client rather than guessing during SSR. The
  // authenticator question is asked here too: offering a button that can only fail is worse than
  // not offering it, and the answer decides which of the two is on screen.
  useEffect(() => {
    setPasskeyKnown(hasPasskey());
    if (!isPasskeySupported()) return;
    hasPlatformAuthenticator().then(setPasskeyAvailable).catch(() => setPasskeyAvailable(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    loadWalletsKit()
      .then(({ kit, KitEventType }) => {
        if (cancelled) return;
        setState(prev => ({ ...prev, isAvailable: true, error: null }));

        // STATE_UPDATED also fires on load, which is how a stored session comes back
        // The kit announces its own restored session on load. That must not displace a passkey
        // session the user is already in, or the address on screen stops matching the signer.
        const offStateUpdated = kit.on(KitEventType.STATE_UPDATED, (event) => {
          if (passkey.current) return;
          const address = event.payload.address || '';
          setState(prev => ({ ...prev, isConnected: !!address, publicKey: address }));
        });
        const offDisconnect = kit.on(KitEventType.DISCONNECT, () => {
          if (passkey.current) return;
          console.log('🔌 Wallet disconnected');
          setState(prev => ({ ...prev, isConnected: false, publicKey: '' }));
        });
        unsubscribe = () => {
          offStateUpdated();
          offDisconnect();
        };
      })
      .catch((error) => {
        console.error('❌ Stellar Wallets Kit failed to load:', error);
        if (cancelled) return;
        setState({
          isAvailable: false,
          isConnected: false,
          publicKey: '',
          error: 'Wallet kit failed to load: ' + toError(error).message,
        });
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    try {
      setState(prev => ({ ...prev, error: null }));
      const { kit } = await loadWalletsKit();

      // The modal lets the user pick a wallet (Freighter, xBull, Lobstr...), activates it and requests the address
      const { address } = await kit.authModal();
      if (!address) {
        throw new Error('Could not read the wallet address');
      }

      setState(prev => ({ ...prev, isConnected: true, publicKey: address, error: null }));
      console.log('✅ Wallet connected! Address:', address);
    } catch (error) {
      const walletError = toError(error);
      console.error('❌ Wallet connection error:', walletError);
      // Closing the modal keeps the existing session; only the error is shown
      setState(prev => ({ ...prev, error: walletError.message }));
      throw walletError;
    }
  }, []);

  /**
   * Sign in with a passkey. Creates one on first use and signs in with it afterwards, which is
   * the same gesture to the user either way — the difference is only whether this browser has
   * seen a credential for the app before.
   */
  const connectPasskey = useCallback(async (label = 'Conduit wallet'): Promise<void> => {
    try {
      setState(prev => ({ ...prev, error: null }));
      const account = hasPasskey() ? await unlockPasskey() : await createPasskey(label);
      passkey.current = account.publicKey;
      setUsingPasskey(true);
      setPasskeyUntil(passkeyUnlockedUntil());
      setPasskeyKnown(true);
      setState(prev => ({ ...prev, isAvailable: true, isConnected: true, publicKey: account.publicKey, error: null }));
      console.log('🔑 Passkey session:', account.publicKey);
    } catch (error) {
      const walletError = describePasskeyError(error);
      console.error('❌ Passkey error:', walletError);
      setState(prev => ({ ...prev, error: walletError.message }));
      throw walletError;
    }
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    // A passkey session is only the address it signed in as — there is no key to drop, because
    // none was kept. The credential is left alone too: forgetting it would strand the account it
    // derives, which may hold funds.
    if (passkey.current) {
      // Signing out closes the window immediately rather than waiting for it to lapse.
      lockPasskey();
      passkey.current = null;
      setUsingPasskey(false);
      setPasskeyUntil(null);
      setState(prev => ({ ...prev, isConnected: false, publicKey: '' }));
      return;
    }
    try {
      const { kit } = await loadWalletsKit();
      await kit.disconnect();
    } finally {
      setState(prev => ({ ...prev, isConnected: false, publicKey: '' }));
    }
  }, []);

  const signTransaction = useCallback(async (xdr: string): Promise<string> => {
    // Signs from the unlock the sign-in opened, and asks for the passkey again once it lapses.
    // The window is what makes this usable during a working session; that it lapses at all is
    // what keeps a spendable key from living as long as the tab does.
    if (passkey.current) return passkeySigner(passkey.current)(xdr);
    try {
      console.log('🔐 Wallet signTransaction called with XDR:', xdr.substring(0, 50) + '...');
      const { kit } = await loadWalletsKit();
      const { address } = await kit.getAddress();

      // Without an address some wallets sign with whatever account is currently selected
      const { signedTxXdr } = await kit.signTransaction(xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address,
      });

      // A dismissed prompt comes back as a resolved call with nothing in it rather than as a
      // rejection, so this is the only place the difference can be seen. Without the check the
      // first use of the value throws a TypeError about `substring`, which names the log line
      // instead of the wallet and sends the reader somewhere the problem is not.
      if (!signedTxXdr) {
        throw new Error('The wallet returned no signed transaction — the request was dismissed or the wallet is locked.');
      }

      console.log('✅ Signed XDR preview:', signedTxXdr.substring(0, 50) + '...');
      return signedTxXdr;
    } catch (error) {
      const walletError = toError(error);
      console.error('❌ Wallet signTransaction error:', walletError);
      setState(prev => ({ ...prev, error: walletError.message }));
      throw walletError;
    }
  }, []);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    if (passkey.current) return true;
    try {
      const { kit } = await loadWalletsKit();
      const { address } = await kit.getAddress();
      return !!address;
    } catch {
      return false;
    }
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    signTransaction,
    checkConnection,
    passkeyAvailable,
    passkeyKnown,
    usingPasskey,
    passkeyUntil,
    connectPasskey,
  };
};

// Existing pages import this name; the wallet is no longer Freighter-specific
export const useFreighter = useWallet;
