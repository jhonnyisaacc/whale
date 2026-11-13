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
