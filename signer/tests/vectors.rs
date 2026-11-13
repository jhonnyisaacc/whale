use serde_json::Value;
use std::path::PathBuf;
use whale_signer::{keystore, policy::Policy, run_job};

const DAY: &str = "2026-11-03";

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("vector file")).expect("vector json")
}

fn keys() -> keystore::Keys {
    let evm = load("evm.json");
    let solana = load("solana.json");
    let mut seed = [0u8; 64];
    seed[..32].copy_from_slice(
        &hex::decode(evm["evmKey"].as_str().unwrap().trim_start_matches("0x")).unwrap(),
    );
    seed[32..].copy_from_slice(&hex::decode(solana["seed"].as_str().unwrap()).unwrap());
    keystore::from_test_seed(seed).expect("test keys")
}

fn fresh_ledger(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "whale-signer-{}-{}.json",
        std::process::id(),
        name.replace(' ', "-")
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn run(file: &str) {
    let policy = Policy::parse(&load("policy.json")).expect("policy");
    let keys = keys();
    let vectors = load(file);
    for case in vectors["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let ledger = fresh_ledger(name);
        let outcome = run_job(&case["job"], &policy, &keys, &ledger, DAY);
        assert_eq!(outcome["decision"], case["expect"], "{name}: {outcome}");
        if let Some(reason) = case.get("reason").and_then(Value::as_str) {
            assert!(
                outcome["reasons"].to_string().contains(reason),
                "{name}: expected a reason with '{reason}', got {outcome}"
            );
        }
        if let Some(expected) = case.get("signedTransaction") {
            assert_eq!(
                &outcome["result"]["signedTransaction"], expected,
                "{name}: viem signed different bytes"
            );
        }
        if let Some(expected) = case.get("signature") {
            assert_eq!(
                &outcome["result"]["signature"], expected,
                "{name}: node signed different bytes"
            );
        }
        let _ = std::fs::remove_file(ledger);
    }
}

#[test]
fn keys_derive_the_addresses_the_vectors_name() {
    let keys = keys();
    assert_eq!(
        keystore::evm_address(&keys.evm),
        load("evm.json")["own"].as_str().unwrap()
    );
    assert_eq!(
        keystore::solana_address(&keys.solana),
        load("solana.json")["own"].as_str().unwrap()
    );
}

#[test]
fn evm_vectors_match_viem() {
    run("evm.json");
}

#[test]
fn solana_vectors_match_node() {
    run("solana.json");
}

#[test]
fn the_daily_ledger_refuses_the_spend_that_crosses_the_limit() {
    let policy = Policy::parse(&load("policy.json")).expect("policy");
    let keys = keys();
    let evm = load("evm.json");
    let swap = evm["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "0x exec into settler for this wallet")
        .unwrap();
    let ledger = fresh_ledger("ledger-limit");
    let outcomes: Vec<Value> = (0..4)
        .map(|_| run_job(&swap["job"], &policy, &keys, &ledger, DAY))
        .collect();
    let decisions: Vec<&str> = outcomes
        .iter()
        .map(|outcome| outcome["decision"].as_str().unwrap())
        .collect();
    assert_eq!(
        decisions,
        ["signed", "signed", "signed", "refused"],
        "3 USDC a time against a 10 USDC day"
    );
    assert_eq!(
        run_job(&swap["job"], &policy, &keys, &ledger, "2026-11-04")["decision"],
        "signed",
        "a new day starts at zero"
    );
    let _ = std::fs::remove_file(ledger);
}

#[test]
fn a_sealed_keystore_opens_only_with_its_passphrase() {
    let keys = keys();
    let sealed = keystore::seal(&keys, "correct horse battery").expect("seal");
    assert!(
        !sealed
            .to_string()
            .contains(&hex::encode(keys.evm.to_bytes()))
    );
    let opened = keystore::open(&sealed, "correct horse battery").expect("open");
    assert_eq!(
        keystore::evm_address(&opened.evm),
        keystore::evm_address(&keys.evm)
    );
    assert!(keystore::open(&sealed, "wrong horse battery").is_err());
    assert!(keystore::seal(&keys, "short").is_err());
}

#[test]
fn concurrent_jobs_never_sign_past_the_daily_limit() {
    let policy = Policy::parse(&load("policy.json")).expect("policy");
    let keys = keys();
    let evm = load("evm.json");
    let swap = evm["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "0x exec into settler for this wallet")
        .unwrap()["job"]
        .clone();
    for round in 0..25 {
        let ledger = fresh_ledger(&format!("ledger-concurrent-{round}"));
        let start = std::sync::Barrier::new(8);
        let signed = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        run_job(&swap, &policy, &keys, &ledger, DAY)["decision"] == "signed"
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|signed| *signed)
                .count()
        });
        let _ = std::fs::remove_file(&ledger);
        assert_eq!(
            signed, 3,
            "round {round}: 3 USDC a time against a 10 USDC day"
        );
    }
}

fn approve_job(nonce: u64, spender: &str, amount: u128) -> Value {
    serde_json::json!({
        "id": format!("approve-{nonce}"),
        "kind": "evm",
        "chainId": 8453,
        "tx": {
            "nonce": nonce.to_string(),
            "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "value": "0",
            "data": format!("0x095ea7b3{:0>64}{amount:064x}", spender.trim_start_matches("0x")),
            "gas": "100000",
            "maxFeePerGas": "1000000000",
            "maxPriorityFeePerGas": "1000000"
        }
    })
}

#[test]
fn approvals_never_name_a_settler_and_count_against_the_day() {
    let settler = "0x5555555555555555555555555555555555555555";
    let holder = "0x0000000000001fF3684f28c67538d4D072C22734";
    let mut file = load("policy.json");
    file["evm"]["routers"]["8453"]
        .as_array_mut()
        .unwrap()
        .push(settler.into());
    let policy = Policy::parse(&file).expect("policy");
    let keys = keys();
    let ledger = fresh_ledger("ledger-approvals");
    let to_settler = run_job(
        &approve_job(0, settler, 1_000_000),
        &policy,
        &keys,
        &ledger,
        DAY,
    );
    assert_eq!(to_settler["decision"], "refused", "{to_settler}");
    assert!(
        to_settler["reasons"].to_string().contains("pinned Settler"),
        "{to_settler}"
    );
    let decisions: Vec<Value> = (1..=2)
        .map(|nonce| {
            run_job(
                &approve_job(nonce, holder, 6_000_000),
                &policy,
                &keys,
                &ledger,
                DAY,
            )["decision"]
                .clone()
        })
        .collect();
    assert_eq!(
        decisions,
        ["signed", "refused"],
        "two 6 USDC approvals against a 10 USDC day"
    );
    let _ = std::fs::remove_file(ledger);
}

#[test]
fn solana_fees_count_against_the_native_day() {
    let mut file = load("policy.json");
    file["solana"]["dailyLimits"]["solana:native"] = "2000000".into();
    let policy = Policy::parse(&file).expect("policy");
    let keys = keys();
    let solana = load("solana.json");
    let transfer = solana["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "sol transfer to a listed destination")
        .unwrap()["job"]
        .clone();
    let ledger = fresh_ledger("ledger-solana-fees");
    let decisions: Vec<Value> = (0..3)
        .map(|_| run_job(&transfer, &policy, &keys, &ledger, DAY)["decision"].clone())
        .collect();
    assert_eq!(
        decisions,
        ["signed", "refused", "refused"],
        "a 1000000 lamport transfer plus a 5200 lamport fee against a 2000000 lamport day"
    );
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&ledger).unwrap()).unwrap();
    assert_eq!(written["spent"]["solana:native"], "1005200");
    let _ = std::fs::remove_file(ledger);
}
