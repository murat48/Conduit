import { Account, Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { soroswapAPI } from './api';
import { SOROSWAP_ROUTER_CONFIG } from './constants';
import { SignTransactionFn } from '@/types/anchor';

// Delegated execution without handing an account over.
// The owner signs one approve(spender, amount, expiration_ledger); the bot may then pull at most
// that amount with transfer_from, until the entry expires. Revoking is approve(…, 0, 0).
//
// Classic multisig cannot express this: Stellar thresholds are per operation category
// (low/med/high), not per amount or per asset, so a medium-weight signer can move everything.
// Here the cap lives on chain, in the token contract.

const STROOPS = BigInt(10000000);

// Testnet closes a ledger roughly every 5 seconds.
export const LEDGERS_PER_DAY = 17280;
export const DEFAULT_TTL_LEDGERS = LEDGERS_PER_DAY;

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
};

const server = (): rpc.Server => new rpc.Server(SOROSWAP_ROUTER_CONFIG.RPC_URL);

// Read-only simulation only needs a source account that exists in memory
const readOnlySource = (): Account => new Account(Keypair.random().publicKey(), '0');

export const toStroops = (amount: string): bigint => {
  const [whole, fraction = ''] = amount.trim().split('.');
  return BigInt(whole || '0') * STROOPS + BigInt((fraction + '0000000').slice(0, 7));
};

export const fromStroops = (amount: bigint): string => {
  const whole = amount / STROOPS;
  const fraction = (amount % STROOPS).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
};

// For display only. fromStroops always pads to seven decimals, which turns 25 USDC into
// "25.0000000" — noisy, and actively misleading to anyone whose locale reads '.' as a
// thousands separator. This trims the padding and groups the integer part instead.
// Grouping is done on the BigInt so no amount is ever routed through a float.
export const formatStroops = (amount: bigint, maxDecimals = 7): string => {
  const negative = amount < BigInt(0);
  const [whole, fraction = ''] = fromStroops(negative ? -amount : amount).split('.');
  const decimals = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${BigInt(whole).toLocaleString('en-US')}${decimals ? `.${decimals}` : ''}`;
};

async function loadAccount(address: string): Promise<Account> {
  try {
    return await server().getAccount(address);
  } catch (error) {
    if (errorMessage(error).includes('Account not found')) {
      throw new Error(`Account ${address.slice(0, 6)}…${address.slice(-4)} is not funded on testnet`);
    }
    console.error('❌ Soroban RPC getAccount error:', error);
    throw new Error(`Network Error - could not load account: ${errorMessage(error)}`);
  }
}

// Builds, simulates, signs and submits a single contract call.
// Shared by the mandate client, which needs the return value as well as the hash.
export async function invoke(params: {
  source: string;
  contract: string;
  method: string;
  args: xdr.ScVal[];
  signTransaction: SignTransactionFn;
}): Promise<{ hash: string; returnValue?: xdr.ScVal }> {
  const { source, contract, method, args, signTransaction } = params;
  const account = await loadAccount(source);

  const transaction = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(SOROSWAP_ROUTER_CONFIG.TX_DEADLINE_SECONDS)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server().simulateTransaction(transaction);
  } catch (error) {
    console.error(`❌ Soroban RPC simulate error (${method}):`, error);
    throw new Error(`Network Error - Soroban RPC unreachable: ${errorMessage(error)}`);
  }

  if (rpc.Api.isSimulationError(simulation)) {
    const detail = simulation.error.split('\n')[0];
    // Stellar Asset Contract error #9: the spender is pulling more than is left, or the allowance
    // expired / was revoked. Verified on testnet against both cases.
    if (detail.includes('Error(Contract, #9)')) {
      throw new Error('the allowance does not cover this amount, or it expired or was revoked');
    }
    throw new Error(`${method} simulation failed: ${detail}`);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new Error(`${method} failed: contract state is archived and must be restored first`);
  }

  const assembled = rpc.assembleTransaction(transaction, simulation).build();
  const signed = await signTransaction(assembled.toXDR());
  const result = await soroswapAPI.sendTransaction({ xdr: signed });

  if (!result.hash) {
    throw new Error(`${method} was submitted but no transaction hash came back`);
  }
  // The simulated return value is what the submitted call produces, barring a state change
  // between the two — the same assumption every quote in this app already makes.
  return { hash: result.hash, returnValue: simulation.result?.retval };
}

export async function getLatestLedger(): Promise<number> {
  try {
    const { sequence } = await server().getLatestLedger();
    return sequence;
  } catch (error) {
    console.error('❌ Soroban RPC getLatestLedger error:', error);
    throw new Error(`Network Error - could not read the current ledger: ${errorMessage(error)}`);
  }
}

// Remaining allowance in stroops. An expired entry reads back as 0, so no separate expiry check is needed.
export async function getAllowance(owner: string, spender: string, contract: string): Promise<bigint> {
  const transaction = new TransactionBuilder(readOnlySource(), {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(contract).call(
        'allowance',
        new Address(owner).toScVal(),
        new Address(spender).toScVal()
      )
    )
    .setTimeout(30)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server().simulateTransaction(transaction);
  } catch (error) {
    console.error('❌ Soroban RPC simulate error (allowance):', error);
    throw new Error(`Network Error - could not read the allowance: ${errorMessage(error)}`);
  }

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Could not read the allowance: ${simulation.error.split('\n')[0]}`);
  }
  if (!simulation.result) {
    throw new Error('allowance() returned no result');
  }
  return BigInt(scValToNative(simulation.result.retval) as string | number | bigint);
}

// Signed by the owner with their own wallet. The bot never sees this signature.
export async function approveSpender(params: {
  owner: string;
  spender: string;
  contract: string;
  amount: string; // human readable, e.g. "25.5"
  ttlLedgers?: number;
  signTransaction: SignTransactionFn;
}): Promise<{ hash: string; expirationLedger: number }> {
  const { owner, spender, contract, amount, ttlLedgers = DEFAULT_TTL_LEDGERS, signTransaction } = params;

  const stroops = toStroops(amount);
  if (stroops <= BigInt(0)) {
    throw new Error('The approved amount must be greater than zero');
  }

  const expirationLedger = (await getLatestLedger()) + ttlLedgers;

  const { hash } = await invoke({
    source: owner,
    contract,
    method: 'approve',
    args: [
      new Address(owner).toScVal(),
      new Address(spender).toScVal(),
      nativeToScVal(stroops, { type: 'i128' }),
      nativeToScVal(expirationLedger, { type: 'u32' }),
    ],
    signTransaction,
  });

  console.log(`✅ Allowance set: ${amount} for ${spender.slice(0, 6)}… until ledger ${expirationLedger}`);
  return { hash, expirationLedger };
}

// approve(…, 0, 0): the contract requires the expiration ledger to be 0 when the amount is 0.
export async function revokeSpender(params: {
  owner: string;
  spender: string;
  contract: string;
  signTransaction: SignTransactionFn;
}): Promise<string> {
  const { owner, spender, contract, signTransaction } = params;

  const { hash } = await invoke({
    source: owner,
    contract,
    method: 'approve',
    args: [
      new Address(owner).toScVal(),
      new Address(spender).toScVal(),
      nativeToScVal(BigInt(0), { type: 'i128' }),
      nativeToScVal(0, { type: 'u32' }),
    ],
    signTransaction,
  });

  console.log(`🛑 Allowance revoked for ${spender.slice(0, 6)}…`);
  return hash;
}

export async function getTokenBalance(contract: string, address: string): Promise<bigint> {
  const transaction = new TransactionBuilder(readOnlySource(), {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contract).call('balance', new Address(address).toScVal()))
    .setTimeout(30)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server().simulateTransaction(transaction);
  } catch (error) {
    console.error('❌ Soroban RPC simulate error (balance):', error);
    throw new Error(`Network Error - could not read the token balance: ${errorMessage(error)}`);
  }

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Could not read the token balance: ${simulation.error.split('\n')[0]}`);
  }
  if (!simulation.result) {
    throw new Error('balance() returned no result');
  }
  return BigInt(scValToNative(simulation.result.retval) as string | number | bigint);
}

// Plain token transfer, signed by `from`. Used to hand the swap output back to the owner:
// the Soroswap router calls require_auth() on its `to` argument, so the bot has to be the
// recipient of the swap itself and forward the proceeds afterwards.
export async function sendToken(params: {
  from: string;
  to: string;
  contract: string;
  amount: bigint;
  signTransaction: SignTransactionFn;
}): Promise<string> {
  const { from, to, contract, amount, signTransaction } = params;

  if (amount <= BigInt(0)) {
    throw new Error('The amount to transfer must be greater than zero');
  }

  const { hash } = await invoke({
    source: from,
    contract,
    method: 'transfer',
    args: [
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    ],
    signTransaction,
  });
  return hash;
}

// Signed by the bot. Fails on chain if it asks for more than the owner approved.
export async function pullFunds(params: {
  owner: string;
  spender: string;
  contract: string;
  amount: bigint;
  signTransaction: SignTransactionFn;
}): Promise<string> {
  const { owner, spender, contract, amount, signTransaction } = params;

  if (amount <= BigInt(0)) {
    throw new Error('The amount to pull must be greater than zero');
  }

  const { hash } = await invoke({
    source: spender,
    contract,
    method: 'transfer_from',
    args: [
      new Address(spender).toScVal(), // spender: who is authorising
      new Address(owner).toScVal(), // from: where the funds come from
      new Address(spender).toScVal(), // to: the bot holds them for the length of one swap
      nativeToScVal(amount, { type: 'i128' }),
    ],
    signTransaction,
  });
  return hash;
}
