import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const guardedNodeCalls = new Map([
  ['payments.createIntent', 1], ['payments.refund', 3],
  ['checkoutSessions.create', 1], ['connections.create', 1], ['connections.test', 1],
  ['customers.create', 1], ['subscriptions.create', 1],
  ['paymentLinks.create', 1], ['routingRules.create', 1],
]);
const unstable = /Date\.now|Math\.random|randomUUID|time\.Now|uuid4/;

// Split SDK arguments while preserving objects, arrays, strings and comments.
function argumentsAt(source, start) {
  let quote;
  const stack = ['('];
  const args = [];
  let from = start;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
    } else if ("'\"`".includes(char)) quote = char;
    else if (source.startsWith('//', i) || source.startsWith('#', i)) {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if ('([{'.includes(char)) stack.push(char);
    else if (')]}'.includes(char)) {
      stack.pop();
      if (!stack.length) {
        if (source.slice(from, i).trim()) args.push(source.slice(from, i).trim());
        return args;
      }
    } else if (char === ',' && stack.length === 1) {
      args.push(source.slice(from, i).trim());
      from = i + 1;
    }
  }
  throw new Error('Unclosed SDK call');
}

export function checkSnippet(language, source, label = 'snippet') {
  const failures = [];
  const fail = (message) => failures.push(`${label}: ${message}`);
  if (['typescript', 'ts', 'tsx', 'javascript', 'jsx'].includes(language)) {
    const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(file).replace(/\s/g, '');
        const match = /^(?:reevit|client)\.([\w]+\.[\w]+)$/.exec(expression);
        if (match && guardedNodeCalls.has(match[1])) {
          const options = node.arguments[guardedNodeCalls.get(match[1])];
          const key = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((property) => ts.isPropertyAssignment(property)
              && property.name.getText(file).replace(/['"]/g, '') === 'idempotencyKey')?.initializer
            : undefined;
          if (!key || !key.getText(file).trim() || /^['"]\s*['"]$/.test(key.getText(file))) {
            fail(`${match[1]} must pass its operation key in request options`);
          } else if (unstable.test(key.getText(file))) {
            fail(`${match[1]} regenerates its operation key during retries`);
          }
        }
        if (/^(?:reevit|client)\.(?:workflows\.|abTests\.|routing\.|connections\.update$|fraud\.update$)/.test(expression)) {
          fail(`${expression} is unavailable or cannot send the guarded write's key in the published SDK`);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.SlashToken
          && node.right.getText(file) === '100' && /\.amount$/.test(node.left.getText(file))) {
        fail('Format payment amounts with formatAmount(amount, currency)');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (language === 'go') {
    for (const match of source.matchAll(/client\.(?:Payments\.CreateIntent|CheckoutSessions\.Create|Connections\.Create)\(/g)) {
      const args = argumentsAt(source, match.index + match[0].length);
      if (!args.slice(2).some((arg) => /WithIdempotencyKey\(.+\)/s.test(arg) && !unstable.test(arg))) {
        fail('Guarded Go writes must pass a stable WithIdempotencyKey option');
      }
    }
    if (/reevit\.CreateConnectionRequest/.test(source)) fail('The published Go SDK exports ConnectionRequest');
  }
  if (language === 'python') {
    for (const match of source.matchAll(/client\.(?:payments\.(?:create_intent|refund)|checkout_sessions\.create|connections\.create)\(/g)) {
      const args = argumentsAt(source, match.index + match[0].length);
      if (!args.some((arg) => /^idempotency_key\s*=\s*\S/.test(arg) && !unstable.test(arg))) {
        fail('Guarded Python writes must pass a stable idempotency_key');
      }
    }
  }
  if (language === 'php') {
    for (const match of source.matchAll(/\$client->(?:payments->(createIntent|refund)|checkoutSessions->create|connections->create)\(/g)) {
      const args = argumentsAt(source, match.index + match[0].length);
      const key = args[match[1] === 'refund' ? 3 : 1];
      if (!key || !/^['"][^'"]+['"]$/.test(key) || unstable.test(key)) {
        fail('Guarded PHP writes must pass their stable key in the published positional signature');
      }
      if (match[1] === 'refund' && /^\[/.test(args[1])) fail('PHP refund takes amount, reason, key; not an options array');
      if (match[1] === 'refund' && args[1] === 'null' && args[2] === 'null') {
        fail('Published PHP 0.3.0 needs a full-refund reason to serialize an object body');
      }
    }
    for (const match of source.matchAll(/new Reevit\(/g)) {
      const args = argumentsAt(source, match.index + match[0].length);
      if (args.length < 2 || /BASE_URL|https?:/.test(args[1])) fail('PHP constructor takes API key, organization ID, then base URL');
    }
  }
  return failures;
}

export function checkDocs(directory) {
  const failures = [];
  let checked = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (filename.endsWith('.mdx')) {
        const source = fs.readFileSync(filename, 'utf8');
        for (const match of source.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
          const line = source.slice(0, match.index).split('\n').length;
          failures.push(...checkSnippet(match[1].trim(), match[2], `${filename}:${line}`));
          checked++;
        }
      }
    }
  };
  walk(directory);
  return { checked, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocs(process.env.DOCS_ROOT ?? path.resolve('content/docs/reevit'));
  if (result.failures.length) {
    console.error(result.failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`Checked ${result.checked} documentation fences`);
}
