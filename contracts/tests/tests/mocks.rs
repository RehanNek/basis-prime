//! Smoke tests for the sandbox mocks that Phase 2's account-contract tests will use: the MPC signer and OutLayer.
//! Each call yields until the test answers it, or times out after 200 blocks.
mod common;

use std::time::Duration;

use common::*;
use serde_json::{json, Value};

/// Waits (up to 20 seconds) until `ready` holds, so a test answers a request only once it is waiting.
async fn wait_for(what: &str, mut ready: impl AsyncFnMut() -> bool) {
    for _ in 0..80 {
        if ready().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("timed out waiting for {what}");
}

fn sign_request(byte: &str) -> Value {
    json!({ "path": "hl-1", "payload_v2": { "Ecdsa": byte.repeat(32) }, "domain_id": 0 })
}

#[tokio::test]
async fn the_mpc_mock_signs_when_answered_and_times_out_otherwise() {
    let chain = Chain::start().await;
    let mpc = chain.contract("mpc", 10, wasm("pb_testnet_mpc_mock"), None).await;
    let client = chain.account("client", 10).await;
    let tester = chain.account("tester", 10).await;
    let pending = |request: Value| {
        let (chain, mpc, client) = (&chain, &mpc, &client);
        async move {
            let args = json!({ "signer_id": client, "request": request });
            chain.view::<u32>(mpc, "pending_count", args).await
        }
    };

    // The derived key is a fixed, real one.
    let args = json!({ "path": "hyperliquid-1", "predecessor": client, "domain_id": 0 });
    let key: String = chain.view(&mpc, "derived_public_key", args).await;
    assert_eq!(
        key,
        "secp256k1:5CDPH1jf7MkUQ45W6WDKeK8fUT8XtyeVMDQ1bYX88yWxwpeyT3i4bMdAKg3CQzkRtYejctYykFyrgtnXAm8HCG4r"
    );

    // A signature request waits until the test responds, then returns the response in the real signer's shape,
    // with `scheme` even when the response leaves it out.
    let request = sign_request("ab");
    let call = chain.call_in_background(&client, &mpc, "sign", json!({ "request": request }), one_yocto());
    wait_for("the sign request", async || pending(request.clone()).await == 1).await;
    let listed: Vec<Value> = chain.view(&mpc, "pending_requests", json!({})).await;
    assert_eq!(listed, vec![json!({ "signer_id": client, "request": request, "count": 1 })]);
    let response = json!({
        "big_r": { "affine_point": format!("02{}", "11".repeat(32)) },
        "s": { "scalar": "22".repeat(32) },
        "recovery_id": 1,
    });
    let args = json!({ "signer_id": client, "request": request, "response": response });
    chain.ok(&tester, &mpc, "respond", args).await;
    let signed: Value = call.await.unwrap().json().expect("sign should return the signature");
    let mut expected = response.clone();
    expected["scheme"] = json!("Secp256k1");
    assert_eq!(signed, expected);
    assert_eq!(pending(request).await, 0);

    // Without a response, the request times out after 200 blocks and the call fails like the real signer's.
    let request = sign_request("cd");
    let call = chain.call_in_background(&client, &mpc, "sign", json!({ "request": request }), one_yocto());
    wait_for("the second sign request", async || pending(request.clone()).await == 1).await;
    chain.fast_forward(210).await;
    let result = call.await.unwrap();
    assert_refused(&result, "Request has timed out");
}

#[tokio::test]
async fn the_outlayer_mock_returns_a_canned_verdict_null_or_null_after_a_timeout() {
    let chain = Chain::start().await;
    let outlayer = chain.contract("outlayer", 10, wasm("pb_testnet_outlayer_mock"), None).await;
    let client = chain.account("client", 10).await;
    let tester = chain.account("tester", 10).await;
    let deposit = near_api::NearToken::from_millinear(7);
    let request = |input: &str| {
        json!({
            "source": { "Project": { "project_id": "pbf.testnet/pb-risk", "version_key": "ab".repeat(32) } },
            "resource_limits": {},
            "input_data": input,
            "secrets_ref": null,
            "response_format": "Json",
            "payer_account_id": client,
        })
    };
    let pending_id = |input: &'static str| {
        let (chain, outlayer) = (&chain, &outlayer);
        async move {
            let pending: Vec<Value> = chain.view(outlayer, "pending_requests", json!({})).await;
            pending.iter().find(|r| r["input_data"] == input).map(|r| r["request_id"].as_u64().unwrap())
        }
    };

    // A run waits until the test resolves it, and the caller gets the canned verdict, however large.
    let call = chain.call_in_background(&client, &outlayer, "request_execution", request("check-1"), deposit);
    wait_for("the first run", async || pending_id("check-1").await.is_some()).await;
    let id = pending_id("check-1").await.unwrap();
    let verdict = json!({
        "ok": true, "v": 1, "acct": client, "nonce": 1, "state": "HEALTHY",
        "credit": { "line": "24150000000", "binding": "C4" },
        "top": ["x".repeat(700), "y".repeat(700), "z".repeat(700)], // over 2 KB in all
    });
    chain.ok(&tester, &outlayer, "resolve_execution", json!({ "request_id": id, "output": verdict })).await;
    let output: Value = call.await.unwrap().json().unwrap();
    assert_eq!(output, verdict);

    // A failed run gives the caller null, as OutLayer does.
    let call = chain.call_in_background(&client, &outlayer, "request_execution", request("check-2"), deposit);
    wait_for("the second run", async || pending_id("check-2").await.is_some()).await;
    let id = pending_id("check-2").await.unwrap();
    chain.ok(&tester, &outlayer, "resolve_execution", json!({ "request_id": id, "output": null })).await;
    let output: Value = call.await.unwrap().json().unwrap();
    assert_eq!(output, Value::Null);

    // So does a run nobody resolves within 200 blocks.
    let call = chain.call_in_background(&client, &outlayer, "request_execution", request("check-3"), deposit);
    wait_for("the third run", async || pending_id("check-3").await.is_some()).await;
    chain.fast_forward(210).await;
    let output: Value = call.await.unwrap().json().unwrap();
    assert_eq!(output, Value::Null);
}
