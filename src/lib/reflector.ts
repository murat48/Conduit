// SEP-40 (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md)
// Reflector's testnet "external CEX/DEX" oracle feed: base() = USD, prices scaled by decimals().
// Verified live against testnet: decimals()=14, assets() includes XLM/BTC/ETH/... (all Other(symbol)).
// Contract addresses: https://developers.stellar.org/docs/data/oracles/oracle-providers
// Same manual-simulate approach as api.ts's router calls — no REST API, no API key, read-only.
import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { SOROSWAP_ROUTER_CONFIG } from './constants';

const REFLECTOR_CEX_DEX_CONTRACT = 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63';

interface ReflectorPriceData {
  price: bigint;
  timestamp: bigint;
}

// Rust `enum Asset { Stellar(Address), Other(Symbol) }` (#[contracttype]) serializes as
// ScVal::Vec([variant symbol, ...payload]) — stellar-sdk has no schema-aware encoder for it,
// so it's built manually here, the same way api.ts builds the router's swap path by hand.
const otherAsset = (symbol: string): xdr.ScVal =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(symbol)]);

let cachedDecimals: number | null = null;

async function callOracle(server: rpc.Server, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const contract = new Contract(REFLECTOR_CEX_DEX_CONTRACT);
  const source = new Account(Keypair.random().publicKey(), '0');
  const transaction = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: SOROSWAP_ROUTER_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Reflector ${method} failed: ${simulation.error.split('\n')[0]}`);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new Error(`Reflector ${method} failed: contract state archived, needs restore`);
  }
  if (!simulation.result) {
    throw new Error(`Reflector ${method} returned no result`);
  }
  return scValToNative(simulation.result.retval);
}

// XLM/USD from Reflector's testnet oracle. Throws on any failure so callers can fall back
// (stale/missing record, RPC error, archived contract state).
export async function getReflectorXlmPrice(): Promise<number> {
  const server = new rpc.Server(SOROSWAP_ROUTER_CONFIG.RPC_URL);

  if (cachedDecimals === null) {
    cachedDecimals = Number(await callOracle(server, 'decimals'));
  }

  const priceData = (await callOracle(server, 'lastprice', otherAsset('XLM'))) as ReflectorPriceData | null;
  if (!priceData) {
    throw new Error('Reflector: no XLM price record');
  }

  return Number(priceData.price) / Math.pow(10, cachedDecimals);
}
