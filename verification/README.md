# Documentation example verification

Run `npm ci --ignore-scripts` in this directory, then `npm test`. The pinned
packages are published releases verified on 2026-10-04, rather than unpublished
SDK candidate checkouts. The lock file records their registry archive integrity.

The checker compiles the MDX, executes documented Node mutations against its
own loopback HTTP fixture, and checks request bodies and stable retry keys. It
also exercises the actual core and React amount formatters for GHS, USD, XOF and
KWD. It makes no provider calls. `DOCS_ROOT` can select another MDX source root;
`DOCS_NODE_MODULES` can select an already installed copy of these exact releases.

This check complements the documentation server's render/build validation. It
does not establish a production hosting artifact or a completed docs cutover.

For the backend SDK examples, `python3 ../scripts/check-server-examples.py` runs
the documented calls against another loopback fixture. Set
`DOCS_PUBLIC_PHP_AUTOLOAD` to the Composer autoloader for PHP SDK 0.3.0 and
`DOCS_PUBLIC_PYTHON` to the Python executable with `reevit==0.11.0` installed.
The checker installs Go SDK v0.11.0 into its temporary proof module. Set
`DOCS_PROOF_DIR` to retain its generated snippets and request evidence.
