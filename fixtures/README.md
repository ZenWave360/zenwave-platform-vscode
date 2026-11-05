# Fixtures

Smoke-test models, copied from `dsl-kotlin/src/commonTest/resources`. They exist
so `npm run run-in-browser` opens a folder with something real in it, and so
grammar changes can be eyeballed against a model that uses most of the language.

They are a snapshot, not a synced copy. If the language grows, refresh them.

The folder is also a configured ZenWave workspace, so the language client has a
manifest to resolve: `.zenwave/config.yml` names `zenwave-architecture.yml`.
`lsp/` holds the models the smoke test asks the real language server about,
taken from the `@zenwave360/lsp-js` wire tests (zenwave-lsp `lsp-js/npm/test`
and the lsp-hierarchy samples): a ZDL with an unknown entity (`broken.zdl`), a
valid one to hover (`orders.zdl`), and a flow with its `@zdl` model
(`checkout.zfl`, `orders/model.zdl`). `orders-checkout-api/domain-model.zdl` declares the
`OrdersCheckout` system of `place-order-flow.zfl`, so the model tree has a
system to relocate there; the other ZDL files that flow annotates do not exist.
The manifest has a domain with a subdomain for the architecture tree. The `modules/…/openapi.yml` stands in for
the unrelated YAML the client must not send to the server.
