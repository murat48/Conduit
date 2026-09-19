#!/usr/bin/env node
/**
 * Testnet pool tool, for rehearsing and running the demo.
 *
 * Nobody else trades these pools. A price-triggered rule therefore sits at whatever price the
 * last swap left behind and will not reach its target on its own — so a demo either waits for
 * something that never happens, or moves the price itself. This moves it, by doing the same
 * thing a trader would: buying the asset through the router until the pool's own price is where
 * the rule is waiting.
 *
 *   node scripts/pool.cjs status
 *   node scripts/pool.cjs push AQUA 0.0235384
 *   node scripts/pool.cjs push AQUA 0.0235384 --dry
 *
 * `push` funds a throwaway account from Friendbot and spends its XLM, so it costs nothing and
 * touches none of your own keys. It only raises a price: buying is what a swap can do with XLM
 * alone, while pushing one down means holding the asset first.
 */

const {
  Account, Address, Asset, Contract, Keypair, Operation, TransactionBuilder,
  nativeToScVal, rpc, scValToNative, xdr, Horizon,
} = require('@stellar/stellar-sdk');

// Mirrors src/lib/constants.ts. Kept here rather than imported so the script runs under plain
// node with no build step; if a deployment moves, both change.
const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const ROUTER = process.env.NEXT_PUBLIC_SOROSWAP_ROUTER || 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD';
const FACTORY = process.env.NEXT_PUBLIC_SOROSWAP_FACTORY || 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY';

const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ASSETS = {
  XLM,
  USDC,
  AQUA: 'CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE',
  EURC: 'CDDCKBVUKM4ADZHCTLFT263CYRTKG2YIWLIA6XWM5IVF3GWKRNRGS5JD',
};

/** Friendbot's grant, less a margin for fees and the minimum balance. */
const MAX_XLM_SPEND = 9000;
/** Soroswap's fee, as the share of an input that reaches the pool. */
const POOL_FEE_KEPT = 0.997;

const server = () => new rpc.Server(RPC_URL);
const stroops = value => BigInt(Math.round(value * 1e7));
const units = value => Number(value) / 1e7;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function simulate(contract, method, ...args) {
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server().simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) return null;
  return scValToNative(simulation.result.retval);
}

/** Pool reserves for an asset against USDC, as whole units. */
async function reserves(asset) {
  const raw = await simulate(
    ROUTER,
    'get_reserves',
    new Address(FACTORY).toScVal(),
    new Address(asset).toScVal(),
    new Address(USDC).toScVal()
  );
  return raw ? { asset: units(raw[0]), usdc: units(raw[1]) } : null;
}

/**
 * A SAC of a classic asset answers `name()` with `CODE:ISSUER`, which is also the only way to
 * learn whether a trustline is needed at all — a pure Soroban token needs none.
 */
async function classicAsset(contract) {
  const name = await simulate(contract, 'name');
  const match = /^([A-Za-z0-9]+):(G[A-Z0-9]{55})$/.exec(String(name ?? ''));
  return match ? new Asset(match[1], match[2]) : null;
}

async function status() {
  const rows = [];
  for (const [symbol, contract] of Object.entries(ASSETS)) {
    if (contract === USDC) continue;
    const pool = await reserves(contract);
    if (!pool) {
      rows.push(`${symbol.padEnd(6)} no readable pool`);
      continue;
    }
    rows.push(
      `${symbol.padEnd(6)} ${pool.asset.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)} ` +
        `/ ${pool.usdc.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(9)} USDC` +
        `   spot ${(pool.usdc / pool.asset).toFixed(7)}`
    );
  }
  console.log('Pools against USDC\n' + rows.map(row => '  ' + row).join('\n'));

  const accounts = process.argv.slice(3).filter(argument => argument.startsWith('G'));
  if (accounts.length === 0) return;
  console.log('\nBalances');
  for (const account of accounts) {
    const held = [];
    for (const [symbol, contract] of Object.entries(ASSETS)) {
      const balance = await simulate(contract, 'balance', new Address(account).toScVal());
      if (balance) held.push(`${symbol} ${units(balance).toFixed(4)}`);
    }
    console.log(`  ${account.slice(0, 8)}…${account.slice(-4)}  ${held.join('   ') || '—'}`);
  }
}

/** USDC that, spent on the asset, leaves the pool priced at `target`. */
function usdcToReach(pool, target) {
  const k = pool.asset * pool.usdc;
  let low = 0;
  let high = pool.usdc; // buying this much would roughly double the price; far past any target
  for (let i = 0; i < 200; i++) {
    const guess = (low + high) / 2;
    const assetLeft = k / (pool.usdc + guess * POOL_FEE_KEPT);
    if ((pool.usdc + guess) / assetLeft < target) low = guess;
    else high = guess;
  }
  return high;
}

/** XLM that sells for `usdc` in the XLM pool. */
function xlmToRaise(xlmPool, usdc) {
  const k = xlmPool.asset * xlmPool.usdc;
  let low = 0;
  let high = xlmPool.asset;
  for (let i = 0; i < 200; i++) {
    const guess = (low + high) / 2;
    const out = xlmPool.usdc - k / (xlmPool.asset + guess * POOL_FEE_KEPT);
    if (out < usdc) low = guess;
    else high = guess;
  }
  return high;
}

async function push(symbol, target, dryRun) {
  const asset = ASSETS[symbol];
  if (!asset) throw new Error(`Unknown asset ${symbol}. Known: ${Object.keys(ASSETS).join(', ')}`);
  if (!(target > 0)) throw new Error('The target price must be a positive number');
  // The XLM that pays for a push is the same asset, and spending it into the pool moves its
  // price the other way. Raising XLM would mean starting from USDC, which Friendbot does not
  // hand out — so this says so rather than quietly pushing it down.
  if (symbol === 'XLM') {
    throw new Error(
      "XLM cannot be pushed: the swap is funded with XLM, so spending it lowers XLM's own price " +
        'instead of raising it. Point a rule at another asset for a price-triggered demo.'
    );
  }

  const pool = await reserves(asset);
  if (!pool) throw new Error(`No readable ${symbol}/USDC pool`);
  const spot = pool.usdc / pool.asset;
  console.log(`${symbol}/USDC spot ${spot.toFixed(7)}  →  target ${target.toFixed(7)}`);

  if (spot >= target) {
    console.log('Already at or above the target; nothing to do.');
    return;
  }

  // `status` prints one line per asset, and taking the price off the wrong line asks for a pump
  // of several hundred percent. The refusal further down would catch it, but only by the size of
  // the swap — which reads as "the target is expensive" rather than "this is the wrong number".
  if (target > spot * 1.5) {
    const nearest = [];
    for (const [otherSymbol, otherAsset] of Object.entries(ASSETS)) {
      if (otherAsset === USDC || otherSymbol === symbol) continue;
      const otherPool = await reserves(otherAsset);
      if (!otherPool) continue;
      const otherSpot = otherPool.usdc / otherPool.asset;
      if (Math.abs(otherSpot - target) / target < 0.05) nearest.push(`${otherSymbol} (${otherSpot.toFixed(7)})`);
    }
    console.log(
      `\n  Note: that is ${(target / spot).toFixed(1)}× the current ${symbol} price.` +
        (nearest.length ? ` It is about what ${nearest.join(' and ')} trades at — wrong line of \`status\`?` : '')
    );
  }

  const usdcNeeded = usdcToReach(pool, target);
  const xlmPool = await reserves(XLM);
  if (!xlmPool) throw new Error('No readable XLM/USDC pool');
  // A little over, because the pools move between this reading and the swap landing.
  const xlmNeeded = Math.ceil(xlmToRaise(xlmPool, usdcNeeded) * 1.01);

  console.log(`  needs ${usdcNeeded.toFixed(4)} USDC of buying → ${xlmNeeded} XLM through XLM/USDC`);
  console.log(`  XLM pool impact: ${((xlmNeeded / xlmPool.asset) * 100).toFixed(4)}% of its reserve`);

  if (xlmNeeded > MAX_XLM_SPEND) {
    throw new Error(
      `That target needs ${xlmNeeded} XLM, more than one Friendbot account holds (${MAX_XLM_SPEND} spendable). ` +
        'Lower the target, or run this more than once — each run funds a fresh account.'
    );
  }
  if (dryRun) {
    console.log('\n--dry: nothing was sent.');
    return;
  }

  const keypair = Keypair.random();
  console.log(`\nthrowaway account ${keypair.publicKey()}`);
  const funded = await fetch(`${FRIENDBOT}?addr=${keypair.publicKey()}`);
  if (!funded.ok) throw new Error(`Friendbot refused: HTTP ${funded.status}`);
  console.log('  funded');
  await sleep(5000);

  // The router delivers the bought asset to this account, and routes through USDC on the way.
  // Both are classic assets here, and a classic asset cannot land anywhere without a trustline.
  const horizon = new Horizon.Server(HORIZON_URL);
  const trustlines = (await Promise.all([classicAsset(USDC), classicAsset(asset)])).filter(Boolean);
  if (trustlines.length > 0) {
    const builder = new TransactionBuilder(await horizon.loadAccount(keypair.publicKey()), {
      fee: '100000',
      networkPassphrase: PASSPHRASE,
    });
    for (const trustline of trustlines) builder.addOperation(Operation.changeTrust({ asset: trustline }));
    const transaction = builder.setTimeout(120).build();
    transaction.sign(keypair);
    await horizon.submitTransaction(transaction);
    console.log(`  trustlines opened: ${trustlines.map(line => line.getCode()).join(', ')}`);
  }

  const path = symbol === 'XLM' ? [XLM, USDC] : [XLM, USDC, asset];
  const transaction = new TransactionBuilder(await server().getAccount(keypair.publicKey()), {
    fee: '2000000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      new Contract(ROUTER).call(
        'swap_exact_tokens_for_tokens',
        nativeToScVal(stroops(xlmNeeded), { type: 'i128' }),
        // No floor: this swap exists to move a price, and a partial fill still moves it.
        nativeToScVal(BigInt(0), { type: 'i128' }),
        xdr.ScVal.scvVec(path.map(hop => new Address(hop).toScVal())),
        new Address(keypair.publicKey()).toScVal(),
        nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 300), { type: 'u64' })
      )
    )
    .setTimeout(120)
    .build();

  const simulation = await server().simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Swap simulation failed: ${simulation.error.split('\n')[0]}`);
  }
  const assembled = rpc.assembleTransaction(transaction, simulation).build();
  assembled.sign(keypair);
  const sent = await server().sendTransaction(assembled);

  let result;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    result = await server().getTransaction(sent.hash);
    if (result.status !== 'NOT_FOUND') break;
  }
  console.log(`  swap ${result.status}  ${sent.hash}`);
  if (result.status !== 'SUCCESS') return;

  const after = await reserves(asset);
  console.log(`\n${symbol}/USDC spot ${(after.usdc / after.asset).toFixed(7)}`);
  console.log(`https://stellar.expert/explorer/testnet/tx/${sent.hash}`);
  console.log('\nThe rule fires on its next tick — about 15 seconds with the tab open.');
}

const [command, ...rest] = process.argv.slice(2);
const run = async () => {
  if (command === 'status') return status();
  if (command === 'push') {
    const [symbol, target] = rest;
    if (!symbol || !target) throw new Error('Usage: node scripts/pool.cjs push <SYMBOL> <price> [--dry]');
    return push(symbol.toUpperCase(), Number(target), rest.includes('--dry'));
  }
  console.log(
    'Usage:\n' +
      '  node scripts/pool.cjs status [G... addresses to show balances for]\n' +
      '  node scripts/pool.cjs push <SYMBOL> <price> [--dry]'
  );
};

run().catch(error => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
