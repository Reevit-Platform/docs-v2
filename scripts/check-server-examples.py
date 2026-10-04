"""Run the documented server SDK calls against an owned HTTP fixture.

Dependencies are public releases, installed outside the documentation tree.
No real gateway or merchant endpoint is contacted.
"""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.environ.get("DOCS_ROOT", Path(__file__).resolve().parents[1] / "content/docs/reevit"))
PROOF = Path(os.environ.get("DOCS_PROOF_DIR", tempfile.mkdtemp(prefix="reevit-docs-server-proof-")))
PROOF.mkdir(parents=True, exist_ok=True)
requests = []


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append({"method": "GET", "path": self.path, "key": None, "payload": None})
        if self.path.startswith("/v1/connections"):
            payload = {"connections": [{"id": "conn_docs_fixture", "provider": "paystack", "mode": "sandbox", "status": "active"}], "pagination": {"total": 1, "limit": 50, "offset": 0}}
        elif self.path.startswith("/v1/payments?"):
            payload = {"payments": [{"id": "pay_docs_list", "status": "succeeded"}]}
        else:
            payload = {"id": "pay_docs_fixture", "status": "succeeded"}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        key = self.headers.get("Idempotency-Key")
        requests.append({"method": "POST", "path": self.path, "key": key, "payload": payload})
        if self.path.startswith("/forced-error/"):
            self.send_response(422)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"code": "fixture_invalid", "message": "Documentation fixture validation"}).encode())
            return
        self.send_response(200 if key and isinstance(payload, dict) else 400)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"id": "pay_docs_fixture", "status": "requires_action", **(payload if isinstance(payload, dict) else {"error": "request_body_must_be_object"})}).encode())

    def log_message(self, *_):
        pass


def calls_in(text, pattern):
    """Extract complete calls, accounting for nested arguments and literals."""
    result = []
    for match in re.finditer(pattern, text):
        start = match.start()
        opening = text.index("(", start)
        depth, quote, escape = 0, None, False
        for index in range(opening, len(text)):
            char = text[index]
            if quote:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == quote:
                    quote = None
            elif char in "'\"`":
                quote = char
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    result.append(text[start:index + 1])
                    break
        else:
            raise AssertionError("unterminated documented call")
    return result


def run(command, **options):
    subprocess.run(command, check=True, timeout=180, **options)


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
base_url = f"http://127.0.0.1:{server.server_address[1]}"
env = dict(os.environ, REEVIT_API_KEY="pfk_test_docs_fixture.secret", REEVIT_ORG_ID="org_docs_fixture", REEVIT_BASE_URL=base_url)
counts = {}
try:
    php = (ROOT / "sdks/php.mdx").read_text()
    php_calls = calls_in(php, r"\$client->(?:payments->(?:createIntent|refund)|connections->create)\(")
    php_source = "<?php\nrequire getenv('DOCS_PUBLIC_PHP_AUTOLOAD');\nuse Reevit\\Reevit;\n"
    php_source += "if (Reevit::VERSION !== '0.3.0') throw new Exception('Test public PHP 0.3.0');\n"
    # Run the documented constructor too, with an isolated test origin.
    constructor = re.search(r"\$client = new Reevit\(\n[\s\S]*?\n\);", php).group()
    php_source += constructor + "\n"
    for expression in php_calls:
        php_source += expression + ";\n" + expression + ";\n"
    php_file = PROOF / "documented-php.php"
    php_file.write_text(php_source)
    run(["php", "-l", str(php_file)], env=env)
    run(["php", str(php_file)], env=env)
    counts["phpCalls"] = len(php_calls)

    # Execute the full list/get examples, including their array access and the
    # typed exception branch, rather than merely extracting a mutation call.
    php_fences = re.findall(r"```php\n([\s\S]*?)```", php)
    list_fences = [code for code in php_fences if re.search(r"\$client->(?:payments|connections)->(?:list|get)\(", code)]
    error_fence = next(code for code in php_fences if "catch (\\Reevit\\ReevitApiException" in code)
    flow = "<?php\nrequire getenv('DOCS_PUBLIC_PHP_AUTOLOAD');\nuse Reevit\\Reevit;\n"
    flow += "set_error_handler(function ($severity, $message, $file, $line) { throw new \\ErrorException($message, 0, $severity, $file, $line); });\n"
    flow += constructor + "\n" + "\n".join(list_fences)
    flow += "\n$client = new Reevit(getenv('REEVIT_API_KEY'), getenv('REEVIT_ORG_ID'), getenv('REEVIT_BASE_URL') . '/forced-error');\n"
    flow += error_fence
    flow_file = PROOF / "documented-php-list-errors.php"
    flow_file.write_text(flow)
    output = subprocess.run(["php", str(flow_file)], env=env, text=True, capture_output=True, check=True, timeout=30)
    assert output.stderr == "", output.stderr
    assert "pay_docs_list: succeeded" in output.stdout, output.stdout
    assert "paystack (sandbox): active" in output.stdout, output.stdout
    assert "API Error: Documentation fixture validation" in output.stdout, output.stdout
    assert "Code: fixture_invalid" in output.stdout and "HTTP Status: 422" in output.stdout, output.stdout
    counts["phpListExamples"] = len(list_fences)
    counts["phpErrorExamples"] = 1

    python = (ROOT / "sdks/python.mdx").read_text()
    python_calls = []
    for code in re.findall(r"```python\n([\s\S]*?)```", python):
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                expression = ast.get_source_segment(code, node)
                if expression.startswith(("client.payments.create_intent(", "client.payments.refund(")):
                    python_calls.append(expression)
    source = "import os\nfrom importlib.metadata import version\nfrom reevit import Reevit\nassert version('reevit') == '0.11.0'\n"
    source += "client = Reevit(api_key=os.environ['REEVIT_API_KEY'], org_id=os.environ['REEVIT_ORG_ID'], base_url=os.environ['REEVIT_BASE_URL'])\n"
    source += "\n".join(expression + "\n" + expression for expression in python_calls)
    python_file = PROOF / "documented-python.py"
    python_file.write_text(source)
    run([os.environ["DOCS_PUBLIC_PYTHON"], str(python_file)], env=env)
    counts["pythonCalls"] = len(python_calls)

    go = (ROOT / "sdks/go.mdx").read_text()
    go_calls = calls_in(go, r"client\.(?:Payments\.CreateIntent|Connections\.Create)\(")
    go_dir = PROOF / "go"
    go_dir.mkdir(exist_ok=True)
    (go_dir / "go.mod").write_text("module example.com/reevit-docs-fixture\n\ngo 1.23\n\nrequire github.com/Reevit-Platform/go-sdk v0.11.0\n")
    source = 'package main\nimport ("context"; "os"; reevit "github.com/Reevit-Platform/go-sdk")\nfunc main() {\n'
    source += 'ctx := context.Background()\nclient := reevit.NewClient(os.Getenv("REEVIT_API_KEY"), os.Getenv("REEVIT_ORG_ID"), reevit.WithBaseURL(os.Getenv("REEVIT_BASE_URL")))\n'
    for expression in go_calls:
        expression = expression.replace("context.Background()", "ctx")
        source += "for attempt := 0; attempt < 2; attempt++ {\n_, err := " + expression + "\nif err != nil { panic(err) }\n}\n"
    source += "}\n"
    (go_dir / "main.go").write_text(source)
    run(["go", "run", "-mod=mod", "."], env=env, cwd=go_dir)
    counts["goCalls"] = len(go_calls)

    expected = sum(counts[key] for key in ("phpCalls", "pythonCalls", "goCalls")) * 2
    writes = [request for request in requests if request["method"] == "POST" and not request["path"].startswith("/forced-error/")]
    assert len(writes) == expected, (len(writes), expected)
    for first, retry in zip(writes[::2], writes[1::2]):
        assert first["key"] and first == retry, "documented retries must preserve key and body"
        if first["path"] == "/v1/payments/intents":
            assert isinstance(first["payload"]["amount"], int)
            assert first["payload"]["country"] and first["payload"]["currency"]
        if first["path"].endswith("/refund") and "amount" in first["payload"]:
            assert first["payload"]["amount"] in (None, 2500), "refund amount must be scalar minor units"
    evidence = {"publicVersions": {"php": "0.3.0", "python": "0.11.0", "go": "v0.11.0"}, **counts, "httpRequests": len(requests), "proofDirectory": str(PROOF)}
    (PROOF / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
finally:
    server.shutdown()
    server.server_close()
