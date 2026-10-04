import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { checkDocs, checkSnippet } from './check-sdk-snippets.mjs';

test('references and payload keys cannot substitute for request options', () => {
  const failures = checkSnippet('typescript', `await reevit.payments.createIntent({
    amount: 5000, currency: 'GHS', reference: 'order_123', idempotencyKey: 'order_123'
  });`);
  assert.equal(failures.length, 1);
  assert.equal(checkSnippet('typescript', `await reevit.payments.createIntent(payload,
    { idempotencyKey: 'order:123' });`).length, 0);
});

test('rejects regenerated keys and a currency-blind success display', () => {
  assert.equal(checkSnippet('tsx', `await reevit.payments.createIntent(payload,
    { idempotencyKey: 'order_' + Date.now() });`).length, 1);
  assert.equal(checkSnippet('tsx', `alert(result.amount / 100);`).length, 1);
  assert.equal(checkSnippet('tsx', `alert(formatAmount(result.amount, result.currency));`).length, 0);
});

test('checks each published backend argument convention', () => {
  for (const [language, broken, corrected] of [
    ['go', 'client.Payments.CreateIntent(ctx, req)',
      'client.Payments.CreateIntent(ctx, req, reevit.WithIdempotencyKey("order:123"))'],
    ['python', 'client.payments.refund("pay_123")',
      'client.payments.refund("pay_123", idempotency_key="refund:123:full")'],
    ['php', "$client->payments->refund('pay_123', ['amount' => 2500]);",
      "$client->payments->refund('pay_123', 2500, 'requested', 'refund:123:partial_1');"],
  ]) {
    assert.ok(checkSnippet(language, broken).length > 0, language);
    assert.equal(checkSnippet(language, corrected).length, 0, language);
  }
});

test('catches a base URL accidentally used as the PHP organization ID', () => {
  assert.equal(checkSnippet('php', "new Reevit(getenv('REEVIT_API_KEY'), getenv('REEVIT_BASE_URL'));").length, 1);
  assert.equal(checkSnippet('php', "new Reevit(getenv('REEVIT_API_KEY'), getenv('REEVIT_ORG_ID'), getenv('REEVIT_BASE_URL'));").length, 0);
});

test('full refunds through PHP 0.3.0 must send an object body', () => {
  assert.equal(checkSnippet('php', "$client->payments->refund('pay_123', null, null, 'refund:123:full');").length, 1);
  assert.equal(checkSnippet('php', "$client->payments->refund('pay_123', null, 'Customer requested', 'refund:123:full');").length, 0);
});

test('checks the maintained documentation against these regressions', () => {
  const result = checkDocs(path.resolve('content/docs/reevit'));
  assert.ok(result.checked > 100);
  assert.deepEqual(result.failures, []);
});
