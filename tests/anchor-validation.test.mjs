import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadTs(file, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    URL, URLSearchParams, AbortSignal, atob,
    console: { log() {}, warn() {}, error() {} },
    ...globals,
  }, { filename: file });
  return exports;
}

const iban = loadTs('src/lib/iban.ts');
const original = 'TR050009900000000000000001';
const mistyped = 'TR050009900000000000000002';
const alternative = 'TR750009900000000000000002';

function client(fetch) {
  let discoveryCalls = 0;
  const anchor = loadTs('src/lib/anchor.ts', {
    '@stellar/stellar-sdk': {
      StellarToml: { Resolver: { resolve: async () => {
        discoveryCalls++;
        return {
          SIGNING_KEY: 'test', WEB_AUTH_ENDPOINT: 'https://anchor.example/auth',
          TRANSFER_SERVER: 'https://anchor.example/sep6', KYC_SERVER: 'https://anchor.example/sep12',
        };
      } } },
    },
    './constants': { ANCHOR_CONFIG: { HOME_DOMAIN: 'anchor.example', REQUEST_TIMEOUT_MS: 1000 } },
    './api': {},
    './iban': iban,
  }, { fetch });
  return { anchor, discoveryCalls: () => discoveryCalls };
}

test('original and a different checksum-valid sandbox IBAN are accepted', () => {
  assert.equal(iban.getTryIbanError(original), null);
  assert.equal(iban.getTryIbanError(alternative), null);
  // Published TCMB validation example, independently specified from our fixture.
  assert.equal(iban.getTryIbanError('TR470000100100000350930001'), null);
});

test('changing only the last digit fails checksum validation', () => {
  assert.match(iban.getTryIbanError(mistyped), /check digits/);
});

test('spaces and lowercase are normalized, malformed input is rejected', () => {
  assert.equal(iban.normalizeIban('tr05 0009 9000 0000 0000 0000 01'), original);
  assert.equal(iban.getTryIbanError('tr05 0009 9000 0000 0000 0000 01'), null);
  for (const value of ['', 'TR123', original + '0', original.replace('TR', 'DE'), original.slice(0, -1) + '!']) {
    assert.equal(typeof iban.getTryIbanError(value), 'string');
  }
});

test('invalid payout IBAN is rejected before discovery or customer submission', async () => {
  const { anchor, discoveryCalls } = client(() => assert.fail('Unexpected network request'));
  await assert.rejects(anchor.putCustomer('', { bank_account_number: mistyped }), error =>
    error.type === 'invalid_iban' && /check digits/.test(error.message));
  assert.equal(discoveryCalls(), 0);
});

test('valid payout is normalized without changing other customer fields', async () => {
  const { anchor } = client(async (url, options) => {
    assert.equal(url, 'https://anchor.example/sep12/customer');
    assert.deepEqual(JSON.parse(options.body), {
      account: 'GTEST', type: 'sep6-withdraw', bank_account_number: alternative, first_name: 'Test',
    });
    return new Response(JSON.stringify({ id: 'customer' }), { status: 200 });
  });
  const jwt = `header.${Buffer.from(JSON.stringify({ sub: 'GTEST' })).toString('base64url')}.signature`;
  const fields = { bank_account_number: 'tr75 0009 9000 0000 0000 0000 02', first_name: 'Test' };
  await anchor.putCustomer(jwt, fields, { type: 'sep6-withdraw' });
  assert.equal(fields.bank_account_number, 'tr75 0009 9000 0000 0000 0000 02');
});

test('anchor errors preserve nested, flat, and empty response explanations', async () => {
  for (const [body, expected] of [
    [{ error: { code: 'invalid_iban', message: 'IBAN checksum failed' } }, 'IBAN checksum failed'],
    [{ error: 'Invalid account' }, 'Invalid account'],
    [{ message: 'Invalid payout' }, 'Invalid payout'],
    [{}, 'without an explanation'],
  ]) {
    const { anchor } = client(async () => new Response(JSON.stringify(body), { status: 400 }));
    await assert.rejects(anchor.getInfo(), error =>
      error.status === 400 && error.message.includes(expected) && !error.message.includes('[object Object]'));
  }
});
