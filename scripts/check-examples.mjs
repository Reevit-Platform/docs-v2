import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.DOCS_ROOT || path.join(repository, 'content/docs/reevit'));
const dependencyRoot = process.env.DOCS_NODE_MODULES
  ? path.resolve(process.env.DOCS_NODE_MODULES, '..')
  : path.join(repository, 'verification');
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const ts = require('typescript');
const { Reevit } = require('@reevit/node');
const { formatAmount, currencyExponent, toMinorUnits } = require('@reevit/core');
const { formatAmount: reactFormatAmount } = require('@reevit/react');
const { compile } = await import(require.resolve('@mdx-js/mdx'));

const versions = { '@reevit/core': '0.9.1', '@reevit/react': '0.11.0', '@reevit/node': '0.10.2' };
for (const [name, version] of Object.entries(versions)) {
  const manifest = JSON.parse(await readFile(path.join(dependencyRoot, 'node_modules', name, 'package.json')));
  assert.equal(manifest.version, version, `test the recorded public release of ${name}`);
}

const money = [
  ['GHS', '100.00', 10000, 2, '100.00'],
  ['USD', '20.00', 2000, 2, '20.00'],
  ['XOF', '5000', 5000, 0, '5,000'],
  ['KWD', '12.345', 12345, 3, '12.345'],
];
for (const [currency, input, minor, exponent, display] of money) {
  assert.equal(toMinorUnits(input, currency), minor);
  assert.equal(currencyExponent(currency), exponent);
  assert.ok(formatAmount(minor, currency).includes(display));
  assert.equal(reactFormatAmount(minor, currency), formatAmount(minor, currency));
}

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'verification', 'scripts'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(file));
    else if (entry.name.endsWith('.mdx')) result.push(file);
  }
  return result;
}

function typecheck(code, label) {
  const virtualFile = path.join(dependencyRoot, 'documentation-expression.mts');
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...args) => name === virtualFile
    ? ts.createSourceFile(name, code, languageVersion, true)
    : originalGetSourceFile(name, languageVersion, ...args);
  const program = ts.createProgram([virtualFile], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, `${label}: public SDK type check\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, {getCanonicalFileName: name => name, getCurrentDirectory: () => dependencyRoot, getNewLine: () => '\n'})}`);
}

const requests = [];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = body ? JSON.parse(body) : {};
  const key = request.headers['idempotency-key'];
  requests.push({ method: request.method, path: request.url, key, payload });
  if (request.method !== 'GET' && !key) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'missing_idempotency_key' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'pay_docs_fixture', status: 'requires_action', ...payload }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const client = new Reevit('pfk_test_documentation_only.secret', 'org_docs_fixture', `http://127.0.0.1:${server.address().port}`);

let compiledPages = 0;
let executedCalls = 0;
const testedMethods = new Set(['payments.createIntent', 'payments.refund', 'connections.create', 'connections.test', 'subscriptions.create', 'customers.create', 'paymentLinks.create', 'routingRules.create']);
try {
  for (const file of await filesIn(root)) {
    const text = await readFile(file, 'utf8');
    // Frontmatter is metadata rather than MDX JavaScript.
    await compile(text.replace(/^---\n[\s\S]*?\n---\n/, ''), { development: false });
    compiledPages++;
    assert.doesNotMatch(text, /result\.amount\s*\/\s*100/, `${file}: format using the stated currency`);
    for (const match of text.matchAll(/```(?:typescript|ts)\s*\n([\s\S]*?)```/g)) {
      const source = ts.createSourceFile(file, match[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const calls = [];
      function visit(node) {
        if (ts.isCallExpression(node)) {
          const expression = node.expression.getText(source);
          const method = expression.replace(/^(reevit|client)\./, '');
          if (testedMethods.has(method)) calls.push(node);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const call of calls) {
        const expression = call.getText(source);
        assert.match(expression, /idempotencyKey\s*:/, `${file}: guarded operation needs a stable key`);
        assert.doesNotMatch(expression, /Date\.now|Math\.random/, `${file}: persist the logical order identity`);
        const js = ts.transpileModule(`return ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        typecheck(`import { Reevit } from '@reevit/node';
const reevit = new Reevit('test', 'org_docs_fixture');
const client = reevit;
const customer = {id: 'cust_docs_fixture'};
async function documentedOperation() { return ${expression}; }`, file);
        const execute = new Function('reevit', 'client', 'customer', js);
        const before = requests.length;
        await execute(client, client, { id: 'cust_docs_fixture' });
        await execute(client, client, { id: 'cust_docs_fixture' });
        const attempts = requests.slice(before);
        assert.equal(attempts.length, 2);
        assert.ok(attempts[0].key);
        assert.equal(attempts[0].key, attempts[1].key, 'retry preserves logical operation identity');
        assert.deepEqual(attempts[0].payload, attempts[1].payload);
        if (attempts[0].path === '/v1/payments/intents') {
          assert.ok(Number.isSafeInteger(attempts[0].payload.amount));
          assert.ok(attempts[0].payload.currency);
          assert.ok(attempts[0].payload.country);
        }
        if (attempts[0].path === '/v1/connections') {
          assert.ok(attempts[0].payload.provider);
          assert.ok(attempts[0].payload.mode);
          assert.ok(attempts[0].payload.credentials);
        }
        executedCalls++;
      }
    }
  }
  let restExamples = 0;
  for (const relative of ['workflows.mdx', 'ab-testing.mdx', 'sdks/nodejs.mdx']) {
    const file = path.join(root, relative);
    const content = await readFile(file, 'utf8');
    const fences = [...content.matchAll(/```(?:typescript|ts)\s*\n([\s\S]*?)```/g)];
    const code = fences.map(match => match[1]).find(code => code.includes("fetch(new URL("));
    assert.ok(code, `${file}: REST example for APIs absent from published SDK`);
    typecheck(`import { Reevit } from '@reevit/node';
const reevit = new Reevit('test', 'org_docs_fixture');
declare const process: {env: Record<string, string | undefined>};
${code}
export {};`, file);
    const execute = new Function('process', 'reevit', 'fetch', `return (async () => { ${ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText} })()`);
    const before = requests.length;
    const fixtureProcess = {env: {REEVIT_BASE_URL: `http://127.0.0.1:${server.address().port}`, REEVIT_API_KEY: 'pfk_test_documentation_only.secret', REEVIT_ORG_ID: 'org_docs_fixture'}};
    await execute(fixtureProcess, client, fetch);
    await execute(fixtureProcess, client, fetch);
    const writes = requests.slice(before).filter(request => request.method !== 'GET');
    assert.equal(writes.length, 2);
    assert.ok(writes[0].key);
    assert.equal(writes[0].key, writes[1].key);
    assert.deepEqual(writes[0].payload, writes[1].payload);
    if (relative === 'workflows.mdx') {
      assert.equal(writes[0].path, '/v1/workflows/rules');
      assert.equal(writes[0].payload.conditions.currency, 'GHS');
      assert.ok(writes[0].payload.actions.every(action => action.config));
      assert.ok(writes[0].payload.actions.filter(action => action.type === 'slack')
        .every(action => action.config.message_template));
    } else if (relative === 'ab-testing.mdx') {
      assert.equal(writes[0].path, '/v1/routing-ab-tests');
      assert.ok(writes[0].payload.variants.every(variant => variant.name && variant.routing_rule_id && variant.weight));
    } else assert.equal(writes[0].path, '/v1/policies/fraud');
    restExamples++;
  }

  console.log(JSON.stringify({ publicVersions: versions, currencyCases: money.length, compiledPages, executedCalls, restExamples, httpRequests: requests.length }, null, 2));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
