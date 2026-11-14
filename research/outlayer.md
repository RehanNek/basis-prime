# OutLayer facts (subagent report, checked 2026-11-03 against repo commit aaf60a2; saved by the main session)

Code wins where docs disagree.

1. request_execution(source, resource_limits, input_data, secrets_ref, response_format, payer_account_id, params) on outlayer.near / outlayer.testnet.
- source: {"Project":{"project_id":"pb.near/risk","version_key":null|"<wasm sha256>"}} or {"WasmUrl":{"url","hash":"<64 hex>","build_target":"wasm32-wasip2"}}. Avoid GitHub source.
- resource_limits {max_instructions,max_memory_mb,max_execution_seconds}; defaults 1B instr, 128 MB, 60 s; caps 500B, 4096 MB, 180 s. Omitting the field = compile-only; pass {} at least.
- input_data string to stdin; first 32 KB free; above that 0.00001 NEAR/byte deposit + 25 MGas/byte.
- secrets_ref {"profile","account_id"}; response_format Text|Json|Bytes; payer_account_id gets refunds.
- Deposit >= estimate_execution_cost = base 0.001 NEAR + max_instr/1e6*1e-10 + max_s*1000*1e-7 (0.0070001 NEAR at defaults; 0.0030002 for 20 s / 2B). Charged actual usage; remainder refunded; yield timeout charges base fee only.
- OutLayer reserves 50 TGas for its callback; example attaches 200 TGas.
- Flow: promise_yield_create("on_execution_response"); worker.outlayer.near calls resolve_execution; our .then() callback receives value_return.
- Json format returns the guest's JSON as-is (no wrapper). Result is null on failure, trap, invalid JSON, or timeout; no error text on-chain. Guest should exit 0 with {"ok":false,"reason"} for business errors. Keep verdicts < 1 KB.
- Yield window 200 blocks; then null. cancel_stale_execution(request_id) after 10 min, only by original predecessor.
- Pin by WasmUrl hash or version_key; worker refuses mismatching bytes. Callback does not carry the hash (see event code_source or GET /attestations/by-tx/{tx}). Optional hardening: guest signs verdict with a bind:"wasm" signing key whose pubkey the contract stores.
2. Example: out-layer/vrf-example/vrf-contract (ext_contract trait, .then(on_x) with #[callback_result] Result<Option<T>, PromiseError>; fail closed on None).
3. HTTPS: POST https://api.outlayer.ai/call/{owner}/{project} (testnet https://testnet-api.outlayer.ai). Headers X-Payment-Key owner:nonce:secret, X-Compute-Limit (USD micro, default $0.01). Body {input, resource_limits, secrets_ref, async, version_key}. Sync response {call_id,status,output|error,compute_cost,instructions,time_ms,attestation_url}. Async poll GET /calls/{id}. 408 = too long for sync; 500 may still run and charge (no idempotency key); 503 safe to retry. Payment keys: dashboard /payment-keys (store_secrets System PaymentKey + USDC ft_transfer_call top_up_payment_key, min $1) or CLI outlayer keys create/topup; restrict with project_ids, max_per_call; runs execute as the key owner; keep server-side. Latency: avg 8.9 s mainnet, 2.2 s testnet (/public/stats); cold compile ~11 s for big wasm, cached 100-200 ms; HL connector writes 3-8 s. Price ~$0.001 per call + $0.001 per 1B instructions.
4. Program: wasm32-wasip2 (needed for HTTP, storage, signing keys, RPC). [[bin]] main: stdin JSON -> stdout JSON, exit 0. Secrets as env vars. Context env: NEAR_SENDER_ID, NEAR_PREDECESSOR_ID, NEAR_BLOCK_HEIGHT, NEAR_BLOCK_TIMESTAMP (on-chain), OUTLAYER_EXECUTION_TYPE, OUTLAYER_CALL_ID, OUTLAYER_PROJECT_ID. HTTP: wasi-http-client 0.2; TLS in worker; HTTP/1; 30 s per request; private IPs blocked; no domain allowlist for ordinary projects. Crates: outlayer 0.2 (env, storage, vrf, signing_keys); k256 0.13 + tiny-keccak 2.0 in eas-attestor. Clock not attested: prefer NEAR_BLOCK_TIMESTAMP or source timestamps. Limits: WASM <= 10 MB, 100 RPC host calls per run, no filesystem. Build: cargo build --target wasm32-wasip2 --release; outlayer upload x.wasm (FastFS); outlayer deploy <name> <url> (create_project/add_version); reproducible via scripts/build_github_wasm.sh. Upgrades: add_version + set_active_version; pinned callers keep old build. Storage: outlayer::storage encrypted KV per project per caller (or predecessor via manifest), set_worker shared, atomic increment/set_if_equals; rollback protection UNVERIFIED.
5. Secrets: dashboard (ECIES to keystore), CLI outlayer secrets set '{"K":"v"}' --project p, or on-chain store_secrets (0.00001 NEAR/byte). Accessors Project / WasmHash / System(PaymentKey). Conditions AllowAll, Whitelist, AccountPattern, NearBalance, FtBalance, NftOwned, DaoMember, ValidUntil, WasmHash, Predecessor{...}, Logic/Not; e.g. And[Predecessor{AccountPattern ".*\.pb\.near"}, WasmHash(h)]. author_secrets in manifest injects owner's secrets into every run (1Click key, email key). Keys no human sees: (a) generated secret outlayer secrets set --generate PROTECTED_X:hex32 (program receives it as env var; lock to WasmHash); (b) Signing Keys in manifest {"path":"hl","type":"secp256k1","bind":"project","caller":"predecessor"}, outlayer::signing_keys::sign("hl", None, &digest32) -> 65 bytes r||s||v (v 0/1; +27 for EVM); address = last 20 bytes of keccak(pubkey64). Derived from (project uuid or wasm hash, caller): different callers get different keys; over HTTPS caller = payment-key owner. Max 3 keys per program; bind:"project" lets future versions sign; lost if OutLayer disappears unless MPC-vault derived.
6. Custody wallets: POST /register -> wallet_id, api_key wk_...; sign-typed-data endpoint (v 27/28, low-s); our own WASI program CANNOT sign with the wallet's EVM key (only curated connectors under connectors.outlayer.near with X-Wallet-Id). No policy = unrestricted; evm_sign all-or-nothing; no exit for default master-key wallets. connectors.outlayer.near/hyperliquid is closed source and trades from the wallet's own sub-key account (not an API wallet of an existing account); $0.01/order; testnet trading only.
7. Attestation: TDX quote verified on-chain only at worker registration (worker.outlayer.near register-contract, dcap-qvl, MRTD/RTMR allowlist); worker key is an access key limited to resolve methods. Per run: TDX quote with REPORTDATA = sha256(task fields incl. wasm_hash, input_hash, output_hash, block_height). Public: GET /attestations/{task_id}, /attestations/by-tx/{tx}, /attestations/by-call/{id}. Verify: cargo install --git https://github.com/out-layer/outlayer-verify outlayer-verify; outlayer-verify tx <hash>; or dashboard /executions "Verify". Trust: Intel, admin allowlist, coordinator (can censor, not forge).
8. Testnet live 2026-11-03 (api health ok; 2 executors with short uptimes; smoke-test early). Payment keys funded with usdc.fakes.testnet. Trial keys and sponsor codes exist; no hackathon credits found.
9. Examples: oracle-example; price-oracle.near (used by ref-labs.near); eas-attestor (TEE-generated key, k256 in guest); wasi-examples/signing-key-probe; vrf-example; private-dao-example; intents-example (ft_on_transfer -> TEE swap -> resume); botfather-example (send NEAR txs from WASI via host call()); weather/ai examples; near-email; self-hosted-scheduler.
10. Cost per on-chain run ~0.0012-0.0013 NEAR average (live), plus caller gas (100-200 TGas prepaid). Executor fleet small (3 mainnet, 1-2 testnet); queueing past 200 blocks -> null. HTTPS: 10 concurrent jobs per key, 1000 req/min per key, 100/min per IP. No determinism: results are attested observations; include block heights/source timestamps and enforce freshness. No cron: self-hosted-scheduler daemon (interval, storage_diff, webhook) or our keeper. OutLayer can pause (set_paused): on null, block withdrawals but allow deleveraging.
Doc errors: README request_execution signature; PROXY_CONTRACTS_TUTORIAL sources and secrets_ref; nonexistent OutLayerResponse wrapper; "<=900 B output"; failed runs ARE refunded; stale 100B/60 s limits; crate is 0.2 not 0.1; use POST /secrets/pubkey.

## Measured on testnet, 7 Nov (Phase 0; raw data in `research/data/day1_outlayer_*.json`)

Probe program `pb-ol-probe` (`risk/probe`), project `pbf-keeper.testnet/pb-probe`, version `3f89e644…e466` (wasm on FastFS, 531 KB). These corrections win over the notes above:
- **Web calls are not RPC host calls.** The cap of 100 applies to OutLayer's NEAR RPC helpers only. A run made 1,000 outbound HTTP calls without a failure (28 s, $0.0011). The bounds are the run's time limit (60 s default) and an abort after 2 timed-out requests.
- **Large outputs.** The worker sends a response of 1,024 B or more (wrapper included, so guest output from about 850 B) through `submit_execution_output_and_resolve`, which keeps the output in contract state; the callback still gets it whole. So the 1,024 B yield-resume cap doesn't limit verdicts.
- **HTTPS `resource_limits`** in the body is honoured, though the OpenAPI spec omits it. Without it, the instruction budget is (X-Compute-Limit − 1,000 − 60) million; $0.01 gives 8.94B.
- **Concurrency.** "10 concurrent jobs per key" is 2 at a time on testnet, which has 2 executors; the last of a 5-call burst finished about 8 s after sending.
- **Latency.** Warm HTTPS hello: 1.7–2.2 s wall, about 0.75 s inside the enclave, $0.001. The first call to a new version took 4.9 s, and the compile wasn't charged.
- **Storage** is per project and per caller: HTTPS runs (the payment-key owner) and on-chain runs (the calling account) don't share keys. `set_if_absent` creates a key; `set_if_equals` refuses a missing key. The worker provides storage only to Project-source runs, not WasmUrl ones (from the worker code; untested).
- **Attestation**: `attestation_url` comes back as a relative path, and the record names no worker.

## The gateway's seed (8 Nov, `pbf-keeper.testnet/pb-gateway`)

Sources: OutLayer repo at commit `8d27679` ([CONNECTOR_MANIFEST.md](https://github.com/out-layer/outlayer/blob/8d2767919f316e7c02357d8bfe1e81a8be493ac6/wasi-examples/CONNECTOR_MANIFEST.md), [WASI_TUTORIAL.md §3c](https://github.com/out-layer/outlayer/blob/8d2767919f316e7c02357d8bfe1e81a8be493ac6/wasi-examples/WASI_TUTORIAL.md), [WASM_ENV_VARS.md](https://github.com/out-layer/outlayer/blob/8d2767919f316e7c02357d8bfe1e81a8be493ac6/wasi-examples/WASM_ENV_VARS.md), [keystore-worker/src/types.rs](https://github.com/out-layer/outlayer/blob/8d2767919f316e7c02357d8bfe1e81a8be493ac6/keystore-worker/src/types.rs), [secret_generation.rs](https://github.com/out-layer/outlayer/blob/8d2767919f316e7c02357d8bfe1e81a8be493ac6/keystore-worker/src/secret_generation.rs), [contract/src/secrets.rs](https://github.com/out-layer/outlayer/blob/8d2767919f316e7c02357d8bfe1e81a8be493ac6/contract/src/secrets.rs)) and the CLI v0.2.1 source (`src/commands/secrets.rs`, commit `25d4e544`).

- **Generating it.** `outlayer secrets set --project pbf-keeper.testnet/pb-gateway --profile gateway --generate PROTECTED_PB_AGENT_SEED:hex32 --access whitelist:pbf-keeper.testnet --build <wasm sha256>`. The keystore makes 32 random bytes inside the TEE and returns only ciphertext; `hex32` is 64 hex characters. **A generated name must start with `PROTECTED_`**, so the seed is `PROTECTED_PB_AGENT_SEED`, not `PB_AGENT_SEED`. The CLI attaches 0.1 NEAR and the contract refunds the excess.
- **How the wasm reads it.** As an environment variable, through `author_secrets` in the project manifest, a wasm custom section named `outlayer.manifest` that the wasm's hash covers: `{"author_secrets":{"owner":"pbf-keeper.testnet","profile":"gateway"}}`. The worker decrypts that row into every run, and the call carries nothing. So the account's `request_agent` keeps `secrets_ref: null`. A run whose condition refuses it executes nothing. A Rust `#[used] #[link_section = "outlayer.manifest"]` static survives the wasip2 component wrap: the worker's parser descends into the embedded core module.
- **Who may read it.** Every leaf of a condition is judged against the signer, except `Predecessor{X}`, which judges X against the account that called the contract. Over HTTPS there is no contract: the worker reports the payer, so `Predecessor{X}` is X. `AccountPattern` is a full-match regex. The CLI can only write `allow-all`, whitelists with dates, `--build` (a `WasmHash` leaf) and `--direct/--via` (Predecessor whitelists). So the pattern goes in with the contract's `update_access(accessor, profile, new_access)`, signed by the keeper. The row now reads:
  `And[Predecessor{Or[AccountPattern "[a-z0-9_-]+\.pbf\.testnet", Whitelist[pbf-keeper.testnet]]}, WasmHash(<build>)]`.
  That admits a client account calling on chain (its `request_agent`) and our backend over HTTPS with the keeper's payment key, and only this exact build. The manifest also has `"callers":{"direct":"deny"}`, so nobody can call OutLayer for it directly from a plain account.
- **No `secrets_ref` for it.** A call may also name rows of its own (`secrets_ref`), but a variable defined on both the author's and the caller's side refuses the run. The account contract's `request_agent` must therefore pass `null`.
- **Upgrading.** Do it in this order, so the active version can always read the seed:
  1. `outlayer deploy pb-gateway <url> --hash <new> --no-activate`;
  2. `outlayer secrets access --project pbf-keeper.testnet/pb-gateway --profile gateway --build <new>`. This moves the `WasmHash` leaf and keeps the readers; the ciphertext stays, so every client keeps their agent;
  3. `outlayer versions activate`.
  Old versions stay callable by `version_key`, but can't open the seed.
- **Context the gateway checks.** `OUTLAYER_EXECUTION_TYPE` is `NEAR` or `HTTPS`. Over HTTPS, `NEAR_SENDER_ID` is the payment-key owner and `NEAR_PREDECESSOR_ID` is `""`. Storage goes to the signer's cell (the default `storage_account`), so every HTTPS run of ours shares the keeper's.
- **Measured, 8 Nov.**
  - The project is uuid `p0000000000000122`. Its first version was `85f68aaa…634c` (1,285,187 B, in 2 FastFS chunks). The FastFS copy was downloaded back and its hash matches.
  - The upgrade steps above were run once, to version `fcae6052…23d5`. After them the new build gave the same agents. The old build, called by `version_key`, failed before running, at no charge: "the author's secrets could not be decrypted: … this secret is locked to build fcae6052… and the running build is 85f68aaa…". `outlayer versions activate` needs an `outlayer.toml` naming the project in the current directory.
  - Storage: 0.0027 NEAR for the project, 0.00741 NEAR for the secret row.
  - `agent_address` over HTTPS: 5.75M instructions, 1.5 s in the enclave, $0.001006. It answered the same agent three times for `demo1.pbf.testnet` (`0x68643293a2b557f696b7d485b4e1ddaac4a2d46a`), before and after the condition change.
  - Not yet run: the on-chain path. It needs a client account with `request_agent`.

## NEP-413, the owner's signature (8 Nov)

[NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md):
- **What is hashed.** sha256 of the 4-byte borsh u32 `2^31 + 413` (= 2147484061, little-endian), followed by borsh `Payload{message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string>}`.
- **What is signed.** That hash, by a **full-access** ed25519 key.
- **What the wallet returns.** The signature in base64, and the public key as `ed25519:<base58>`.

near-api-js 7.4.0 does the same (`lib/nep413`, `serializeMessage`), and its `verifyMessage` checks the key is FullAccess with `view_access_key`.

**Test vectors.** From near-api-js's [key_pair_signer.test.ts](https://github.com/near/near-api-js/blob/08d29f447abcb8b8c9bec35645638fbf3d979257/test/unit/signers/key_pair_signer.test.ts): key `ed25519:3FyRtUUM…aKXH7`, nonce `KNV0cOpvJ50D5vfF9pqWom8wo2sliQ4W+Wa7uZ3Uk6Y=`, message `Hello NEAR!`.
- Recipient `example.near`: signature `NnJgPU1Q…AAw==`.
- The same, with callbackUrl `http://localhost:3000`: `zzZQ/GwA…cBQ==`.
- Recipient `round-toad.testnet`: hash bytes `[1, 152, 236, …, 23, 250]`.

pb-gateway's Rust reproduces all three (`pb-gateway/src/nep413.rs`).

## Phase 4 builds (8 Nov): `pb-risk` and `pb-gateway`, not deployed

Both are built in `risk/` with the README step-7 command, one package at a time:

```
RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-risk --target wasm32-wasip2 --release
RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build -p pb-gateway --target wasm32-wasip2 --release
```

| Program | sha256 | Size |
|---|---|---|
| `pb-risk` | `5a2a2a2062207f0959ed63cf3b8b2663b70a450a73be839c6c4240d3923c48f4` | 1,132,038 B |
| `pb-gateway` | `6746393a828da9e9f3cb302f1e1a57d1c50d1042d66c3b7a659f58652a747efb` | 1,407,597 B |

A rebuild from a clean `target/wasm32-wasip2` gave the same two hashes. The hashes depend on the checkout's path, since panic messages carry file paths under `~` (README step 7).

**Deploying `pb-risk`** (project `pbf-keeper.testnet/pb-risk`, no secrets):
1. `outlayer upload risk/target/wasm32-wasip2/release/pb-risk.wasm`, for the FastFS URL;
2. `outlayer deploy pb-risk <url> --hash <the pb-risk hash>`;
3. pin it for new accounts: the factory's `set_config` with `risk.version_key` set to the hash. Accounts made before keep the version they pinned.

**Deploying `pb-gateway`** (project `pbf-keeper.testnet/pb-gateway`, with the seed). Use the order of "The gateway's seed" above, so the active version can always open the seed:
1. `outlayer upload risk/target/wasm32-wasip2/release/pb-gateway.wasm`;
2. `outlayer deploy pb-gateway <url> --hash <the pb-gateway hash> --no-activate`;
3. `outlayer secrets access --project pbf-keeper.testnet/pb-gateway --profile gateway --build <the pb-gateway hash>`;
4. `outlayer versions activate`, from a directory whose `outlayer.toml` names the project;
5. pin it for new accounts: `set_config` with `gateway.version_key` set to the hash, and `secrets_ref` still null.

**The old gateway build stops working.** Step 3 moves the seed's `WasmHash` leaf to the new build, so `fcae6052…` can no longer open the seed (measured on the first upgrade). Accounts made before Phase 4 pin `fcae6052…` in their config, and the backend runs the pinned version. So `hedge1` and `quiethare-hedge` couldn't trade through the gateway after the upgrade. A new account for the drill pins the new build, so the drill isn't affected. To keep the old accounts working too, the row's condition would need both builds, `Or[WasmHash(old), WasmHash(new)]`, written with the contract's `update_access`: the CLI writes only one `--build`. That is untested.

## Phase 4 deploy (8 Nov): what happened live

- **Both gateway builds can open the seed.** The seed row's condition is now `And[Predecessor{Or[AccountPattern "[a-z0-9_-]+\.pbf\.testnet", Whitelist[pbf-keeper.testnet]]}, Or[WasmHash(fcae6052…), WasmHash(6746393a…)]]`. It was written with `update_access`, signed by the keeper (tx `CWTn7jpxPDP3PSugDofVdL1P3xTNLncfSTj5MxMPuwJK`). Both builds then answered `agent_address` for `demo1.pbf.testnet` with the same agent, `0x68643293…d46a`. So Phase 3 accounts, which pin the old build, keep trading. To retire a build, rewrite the condition without its leaf.
- **FastFS can lose an upload without saying so.** The gateway's two upload chunks were sent just after a failed `outlayer deploy` from the same key (`InvalidNonce`). Both chunk transactions are unknown on chain, yet `outlayer upload` printed their hashes and "Upload complete". `outlayer deploy` then added the version anyway, and runs failed with "wasm_url could not be fetched". A second upload fixed it, because the version already pointed at the right URL. **Before pinning a version, fetch its FastFS URL and check that it answers 200 with the right sha256.**
- **Don't send the next transaction right after the previous one from the same key.** Sending `outlayer deploy` straight after `outlayer upload` failed once with `InvalidNonce`, and a retry worked.

## Phase 5 deploy (9 Nov)

- `pb-risk` `4e44327e…` went in as upload, then a check of the FastFS URL (200, right size and sha256), then `outlayer deploy pb-risk <url> --hash <sha> --no-activate`, then the factory's `set_config` pin. No nonce errors this time, with 20 s between the upload and the deploy.
- **Overlapped requests:** `pb-read`'s WASI transport sends up to 8 requests before waiting for the first. On OutLayer they ran in parallel: a three-coin mainnet credit check, about 50 reads, took 4.7 s (`time_ms`), and the worked example (19 reads) 4.6 s. Each run cost about $0.0012.
