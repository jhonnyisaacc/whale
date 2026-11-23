use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::{Command, Output};
use whale_signer::{btc, keystore, policy::Policy, run_job};

const DAY: &str = "2026-11-23";

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("vector file")).expect("vector json")
}

fn keys() -> keystore::Keys {
    let mut seed = [0u8; 64];
    seed[..32].copy_from_slice(
        &hex::decode(
            load("evm.json")["evmKey"]
                .as_str()
                .unwrap()
                .trim_start_matches("0x"),
        )
        .unwrap(),
    );
    keystore::from_test_seed(seed).expect("test keys")
}

fn policy() -> Policy {
    Policy::parse(&load("policy.json")).expect("policy")
}

fn temporary(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "whale-signer-bitcoin-{}-{}",
        std::process::id(),
        name.replace(' ', "-")
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn case(name: &str) -> Value {
    load("bitcoin.json")["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("no bitcoin vector named {name}"))
        .clone()
}

fn spent(ledger: &PathBuf) -> Value {
    serde_json::from_str::<Value>(&std::fs::read_to_string(ledger).expect("ledger")).unwrap()
        ["spent"]
        .clone()
}

#[test]
fn the_vector_key_is_the_bitcoin_wallet_the_vectors_pay() {
    let keys = keys();
    let vectors = load("bitcoin.json");
    assert_eq!(
        keystore::bitcoin_public_key(&keys.evm),
        vectors["publicKey"].as_str().unwrap()
    );
    assert_eq!(
        btc::address(&btc::public_key(&keys.evm), bitcoin::Network::Regtest),
        vectors["own"].as_str().unwrap()
    );
}

#[test]
fn bitcoin_vectors_match_scure_decision_reason_and_signed_bytes() {
    let policy = policy();
    let keys = keys();
    let cases = load("bitcoin.json")["cases"].as_array().unwrap().clone();
    assert!(cases.len() >= 20);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let ledger = temporary(name);
        let outcome = run_job(&case["job"], &policy, &keys, &ledger, DAY);
        assert_eq!(outcome["decision"], case["expect"], "{name}: {outcome}");
        if let Some(reason) = case["reason"].as_str() {
            assert_eq!(
                outcome["reasons"],
                json!([format!("bitcoin: {reason}")]),
                "{name}"
            );
        }
        if let Some(expected) = case.get("signedTransaction") {
            assert_eq!(
                &outcome["result"]["signedTransaction"], expected,
                "{name}: k256 signed different bytes than scure"
            );
        }
        if let Some(expected) = case.get("spent") {
            assert_eq!(
                &spent(&ledger),
                expected,
                "{name}: the ledger charged something else"
            );
        }
        let _ = std::fs::remove_file(ledger);
    }
}

#[test]
fn a_replayed_bitcoin_job_signs_the_same_bytes_and_charges_once() {
    let policy = policy();
    let keys = keys();
    let send = case("pays owner with change");
    let ledger = temporary("replay");
    let first = run_job(&send["job"], &policy, &keys, &ledger, DAY);
    let second = run_job(&send["job"], &policy, &keys, &ledger, DAY);
    assert_eq!(first["decision"], "signed", "{first}");
    assert_eq!(first, second);
    assert_eq!(spent(&ledger), json!({ "bitcoin:native": "251410" }));
    let mut other = case("pays the fee cap exactly")["job"].clone();
    other["id"] = send["job"]["id"].clone();
    assert_eq!(
        run_job(&other, &policy, &keys, &ledger, DAY)["reasons"],
        json!(["bitcoin: job pays owner with change was already signed today for different work"])
    );
    let _ = std::fs::remove_file(ledger);
}

#[test]
fn the_daily_sats_limit_refuses_the_send_that_crosses_it() {
    let policy = policy();
    let keys = keys();
    let send = case("pays owner with change")["job"].clone();
    let ledger = temporary("daily-limit");
    let decisions: Vec<Value> = (0..3)
        .map(|n| {
            let mut job = send.clone();
            job["id"] = format!("send-{n}").into();
            run_job(&job, &policy, &keys, &ledger, DAY)
        })
        .collect();
    assert_eq!(decisions[0]["decision"], "signed");
    assert_eq!(decisions[1]["decision"], "signed");
    assert_eq!(
        decisions[2]["decision"], "refused",
        "251410 sats three times against a 600000 day"
    );
    assert!(
        decisions[2]["reasons"]
            .to_string()
            .contains("bitcoin:native"),
        "{}",
        decisions[2]
    );
    assert_eq!(spent(&ledger), json!({ "bitcoin:native": "502820" }));
    let _ = std::fs::remove_file(ledger);
}

#[test]
fn a_policy_without_a_bitcoin_section_refuses_every_bitcoin_job() {
    let mut file = load("policy.json");
    file.as_object_mut().unwrap().remove("bitcoin");
    let policy = Policy::parse(&file).expect("policy");
    let ledger = temporary("no-section");
    let outcome = run_job(
        &case("pays owner with change")["job"],
        &policy,
        &keys(),
        &ledger,
        DAY,
    );
    assert_eq!(
        outcome["reasons"],
        json!(["bitcoin: bitcoin is not in the policy"])
    );
    let _ = std::fs::remove_file(ledger);
}

#[test]
fn the_bitcoin_policy_section_refuses_a_destination_from_another_network_and_a_missing_fee_cap() {
    let mut file = load("policy.json");
    file["bitcoin"]["destinations"] = json!(["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"]);
    assert_eq!(
        Policy::parse(&file).err().unwrap(),
        "bitcoin.destinations: bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 is not a regtest address"
    );
    let mut file = load("policy.json");
    file["bitcoin"]
        .as_object_mut()
        .unwrap()
        .remove("maxFeeSats");
    assert_eq!(
        Policy::parse(&file).err().unwrap(),
        "bitcoin.maxFeeSats must be a decimal string"
    );
}

fn signer(args: &[&str], keystore: &PathBuf) -> Output {
    Command::new(env!("CARGO_BIN_EXE_whale-signer"))
        .args(args)
        .arg("--keystore")
        .arg(keystore)
        .env("WHALE_SIGNER_PASSPHRASE", "correct horse battery")
        .output()
        .expect("run whale-signer")
}

fn printed(output: &Output) -> Value {
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).expect("json output")
}

#[test]
fn upgrade_adds_the_bitcoin_public_key_once_and_refuses_a_forged_one() {
    let keystore = temporary("upgrade.keystore.json");
    let made = printed(&signer(&["init"], &keystore));
    let mut file: Value = serde_json::from_slice(&std::fs::read(&keystore).unwrap()).unwrap();
    let public = file["bitcoinPublicKey"]
        .as_str()
        .expect("init writes the key")
        .to_owned();
    file.as_object_mut().unwrap().remove("bitcoinPublicKey");
    std::fs::write(&keystore, file.to_string()).unwrap();
    let address = printed(&signer(&["address"], &keystore));
    assert_eq!(
        address,
        json!({ "evmAddress": made["evmAddress"], "solanaAddress": made["solanaAddress"] })
    );
    let upgraded = printed(&signer(&["upgrade"], &keystore));
    assert_eq!(upgraded["bitcoinPublicKey"], public);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&keystore).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the upgraded keystore mode is {mode:o}");
    }
    let written = std::fs::read(&keystore).unwrap();
    assert_eq!(printed(&signer(&["upgrade"], &keystore)), upgraded);
    assert_eq!(
        std::fs::read(&keystore).unwrap(),
        written,
        "a second upgrade changes nothing"
    );
    let address = printed(&signer(&["address", "--network", "regtest"], &keystore));
    assert_eq!(address["bitcoinPublicKey"], public);
    assert!(
        address["bitcoinAddress"]
            .as_str()
            .unwrap()
            .starts_with("bcrt1q"),
        "{address}"
    );
    let mut forged: Value = serde_json::from_slice(&written).unwrap();
    forged["bitcoinPublicKey"] = load("bitcoin.json")["publicKey"].clone();
    std::fs::write(&keystore, forged.to_string()).unwrap();
    let refused = signer(&["upgrade"], &keystore);
    assert_eq!(refused.status.code(), Some(2), "{refused:?}");
    assert!(String::from_utf8_lossy(&refused.stderr).contains("does not match the sealed key"));
    let refused = signer(&["address", "--network", "regtest"], &keystore);
    assert_eq!(refused.status.code(), Some(2), "{refused:?}");
    assert!(
        String::from_utf8_lossy(&refused.stderr)
            .contains("does not belong to the keystore's evmAddress")
    );
    let _ = std::fs::remove_file(&keystore);
}
