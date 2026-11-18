use serde_json::{Value, json};
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

fn refuse(job: &Value) -> Vec<String> {
    let ledger = std::env::temp_dir().join(format!(
        "whale-refusal-chain-{}-{}.json",
        std::process::id(),
        job["id"].as_str().unwrap().replace(' ', "-")
    ));
    let _ = std::fs::remove_file(&ledger);
    let policy = Policy::parse(&load("policy.json")).expect("policy");
    let outcome = run_job(job, &policy, &keys(), &ledger, DAY);
    let _ = std::fs::remove_file(ledger);
    assert_eq!(outcome["decision"], "refused", "{outcome}");
    outcome["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reason| reason.as_str().unwrap().to_owned())
        .collect()
}

fn evm_label(chain_id: u64) -> String {
    let key = load("chains.json")
        .as_array()
        .unwrap()
        .iter()
        .find(|chain| chain["chainId"] == chain_id)
        .map_or("unknown".to_owned(), |chain| {
            chain["key"].as_str().unwrap().to_owned()
        });
    format!("{key} (chain id {chain_id})")
}

fn native_transfer(chain_id: u64) -> Value {
    json!({
        "id": format!("native on {chain_id}"),
        "kind": "evm",
        "chainId": chain_id,
        "tx": {
            "nonce": "7",
            "to": "0x00000000000000000000000000000000000bad00",
            "value": "1",
            "data": "0x",
            "gas": "21000",
            "maxFeePerGas": "1000",
            "maxPriorityFeePerGas": "1"
        }
    })
}

#[test]
fn every_refused_vector_names_its_chain_and_keeps_its_reason() {
    for (file, kind) in [("evm.json", "evm"), ("solana.json", "solana")] {
        for case in load(file)["cases"].as_array().unwrap() {
            if case["expect"] != "refused" {
                continue;
            }
            let label = match kind {
                "evm" => evm_label(case["job"]["chainId"].as_u64().unwrap()),
                _ => "solana".to_owned(),
            };
            let reasons = refuse(&case["job"]);
            let name = case["name"].as_str().unwrap();
            for reason in &reasons {
                assert!(
                    reason.starts_with(&format!("{label}: ")),
                    "{name}: '{reason}' does not name {label}"
                );
            }
            let reason = case["reason"].as_str().unwrap();
            assert!(
                reasons.iter().any(|text| text.contains(reason)),
                "{name}: lost the reason '{reason}' in {reasons:?}"
            );
        }
    }
}

#[test]
fn every_app_chain_is_named_by_key_and_id() {
    for chain in load("chains.json").as_array().unwrap() {
        let chain_id = chain["chainId"].as_u64().unwrap();
        let label = format!("{} (chain id {chain_id}): ", chain["key"].as_str().unwrap());
        let reasons = refuse(&native_transfer(chain_id));
        assert!(
            reasons.iter().all(|reason| reason.starts_with(&label)),
            "{reasons:?} does not name {label}"
        );
    }
}

#[test]
fn a_chain_outside_the_app_table_is_named_unknown_with_its_id() {
    assert_eq!(
        refuse(&native_transfer(12345)),
        ["unknown (chain id 12345): chain 12345 is not in the policy"]
    );
}
