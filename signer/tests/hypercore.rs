use serde_json::{Value, json};
use sha3::Digest;
use whale_signer::hypercore;

fn sdk_key() -> k256::ecdsa::SigningKey {
    let hex_key = format!("{}0123", "0123456789".repeat(6));
    k256::ecdsa::SigningKey::from_slice(&hex::decode(hex_key).unwrap()).unwrap()
}

fn job(network: &str, nonce: u64, action: Value) -> Value {
    json!({ "id": "sdk", "kind": "hypercore", "network": network, "nonce": nonce, "action": action })
}

fn word(text: &str) -> String {
    format!("{:0>64}", text.trim_start_matches("0x"))
}

fn assert_signature(job: &Value, r: &str, s: &str, v: u64) {
    let parsed = hypercore::parse(job).expect("the SDK action decodes");
    let signature = hypercore::sign(&parsed, &sdk_key());
    assert_eq!(signature["r"], format!("0x{}", word(r)), "r for {job}");
    assert_eq!(signature["s"], format!("0x{}", word(s)), "s for {job}");
    assert_eq!(signature["v"], v, "v for {job}");
}

fn sdk_order(tif: &str, price: &str, size: &str, asset: u64) -> Value {
    json!({
        "type": "order",
        "orders": [{ "a": asset, "b": true, "p": price, "s": size, "r": false, "t": { "limit": { "tif": tif } } }],
        "grouping": "na"
    })
}

#[test]
fn the_production_ioc_order_hashes_to_the_sdk_connection_id() {
    let parsed = hypercore::parse(&job(
        "mainnet",
        1677777606040,
        sdk_order("Ioc", "1670.1", "0.0147", 4),
    ))
    .expect("decodes");
    assert_eq!(
        hex::encode(hypercore::connection_id(&parsed).expect("an L1 action")),
        "0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908"
    );
}

#[test]
fn an_order_signs_the_sdk_signature_on_mainnet_and_testnet() {
    let order = sdk_order("Gtc", "100", "100", 1);
    assert_signature(
        &job("mainnet", 0, order.clone()),
        "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
        "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
        28,
    );
    assert_signature(
        &job("testnet", 0, order),
        "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
        "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
        27,
    );
}

#[test]
fn a_withdrawal_signs_the_sdk_signature() {
    assert_signature(
        &job(
            "testnet",
            1687816341423,
            json!({
                "type": "withdraw3",
                "hyperliquidChain": "Testnet",
                "signatureChainId": "0x66eee",
                "destination": "0x5e9ee1089755c3435139848e47e6635505d5a13a",
                "amount": "1",
                "time": 1687816341423u64
            }),
        ),
        "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
        "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
        28,
    );
}

#[test]
fn an_action_the_signer_does_not_decode_is_refused() {
    for action in [
        json!({ "type": "usdSend", "destination": "0x5e9ee1089755c3435139848e47e6635505d5a13a", "amount": "1", "time": 1 }),
        json!({ "type": "approveAgent", "agentAddress": "0x5e9ee1089755c3435139848e47e6635505d5a13a" }),
        json!({ "type": "order", "orders": [], "grouping": "na", "builder": { "b": "0x5e9ee1089755c3435139848e47e6635505d5a13a", "f": 10 } }),
        json!({ "type": "order", "orders": [{ "a": 1, "b": true, "p": "1", "s": "1", "r": false, "t": { "limit": { "tif": "Ioc" } }, "c": "0x00000000000000000000000000000001" }], "grouping": "na" }),
        json!({ "type": "updateLeverage", "asset": 1, "isCross": false, "leverage": 1, "extra": 1 }),
    ] {
        assert!(
            hypercore::parse(&job("testnet", 1, action.clone())).is_err(),
            "{action} decoded"
        );
    }
    let withdraw = json!({
        "type": "withdraw3",
        "hyperliquidChain": "Mainnet",
        "signatureChainId": "0x66eee",
        "destination": "0x5e9ee1089755c3435139848e47e6635505d5a13a",
        "amount": "1",
        "time": 5
    });
    assert!(hypercore::parse(&job("testnet", 5, withdraw.clone())).is_err());
    assert!(hypercore::parse(&job("mainnet", 6, withdraw)).is_err());
}

const DAY: &str = "2026-11-03";
const OWN: &str = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const LISTED: &str = "0x2222222222222222222222222222222222222222";
const ATTACKER: &str = "0x00000000000000000000000000000000000bad00";
const NONCE: u64 = 1_793_664_000_000;

fn load(name: &str) -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn keys() -> whale_signer::keystore::Keys {
    let mut seed = [0u8; 64];
    seed[..32].copy_from_slice(&[0x11; 32]);
    seed[32..].copy_from_slice(&[0x22; 32]);
    whale_signer::keystore::from_test_seed(seed).unwrap()
}

struct Signer {
    policy: whale_signer::policy::Policy,
    ledger: std::path::PathBuf,
}

impl Signer {
    fn new(name: &str, policy: Value) -> Signer {
        let ledger = std::env::temp_dir().join(format!(
            "whale-hypercore-{}-{name}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&ledger);
        Signer {
            policy: whale_signer::policy::Policy::parse(&policy).unwrap(),
            ledger,
        }
    }

    fn fixture(name: &str) -> Signer {
        Signer::new(name, load("policy.json"))
    }

    fn run(&self, id: &str, network: &str, nonce: u64, action: Value) -> Value {
        let mut job = job(network, nonce, action);
        job["id"] = id.into();
        whale_signer::run_job(&job, &self.policy, &keys(), &self.ledger, DAY)
    }

    fn refused(&self, id: &str, action: Value, reason: &str) {
        let outcome = self.run(id, "testnet", NONCE, action);
        assert_eq!(outcome["decision"], "refused", "{id}: {outcome}");
        let reasons = outcome["reasons"].as_array().unwrap();
        assert!(
            reasons
                .iter()
                .all(|item| item.as_str().unwrap().starts_with("hypercore: ")),
            "{id}: every refusal names hypercore, got {outcome}"
        );
        assert!(
            outcome["reasons"].to_string().contains(reason),
            "{id}: expected '{reason}', got {outcome}"
        );
    }

    fn signed(&self, id: &str, nonce: u64, action: Value) -> Value {
        let outcome = self.run(id, "testnet", nonce, action.clone());
        assert_eq!(outcome["decision"], "signed", "{id}: {outcome}");
        let parsed = hypercore::parse(&job("testnet", nonce, action)).unwrap();
        let signature = &outcome["result"]["signature"];
        let bytes = hex::decode(format!(
            "{}{}",
            signature["r"].as_str().unwrap().trim_start_matches("0x"),
            signature["s"].as_str().unwrap().trim_start_matches("0x")
        ))
        .unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
            &hypercore::signing_hash(&parsed),
            &k256::ecdsa::Signature::from_slice(&bytes).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(signature["v"].as_u64().unwrap() as u8 - 27)
                .unwrap(),
        )
        .unwrap();
        let point = recovered.to_sec1_point(false);
        let address = &sha3::Keccak256::digest(&point.as_bytes()[1..])[12..];
        assert_eq!(
            format!("0x{}", hex::encode(address)),
            OWN,
            "{id} recovers to this wallet"
        );
        outcome
    }
}

impl Drop for Signer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.ledger);
    }
}

fn ioc(asset: u64, price: &str, size: &str) -> Value {
    sdk_order("Ioc", price, size, asset)
}

fn withdraw(destination: &str, amount: &str) -> Value {
    json!({
        "type": "withdraw3",
        "hyperliquidChain": "Testnet",
        "signatureChainId": "0x66eee",
        "destination": destination,
        "amount": amount,
        "time": NONCE
    })
}

#[test]
fn the_actions_whale_builds_sign_and_recover_to_this_wallet() {
    let signer = Signer::fixture("builds");
    signer.signed(
        "leverage",
        NONCE,
        json!({ "type": "updateLeverage", "asset": 4, "isCross": false, "leverage": 1 }),
    );
    signer.signed("perp order", NONCE + 1, ioc(4, "1670.1", "0.0147"));
    signer.signed("spot order", NONCE + 2, ioc(10107, "12.5", "1"));
    signer.signed(
        "cancel",
        NONCE + 3,
        json!({ "type": "cancel", "cancels": [{ "a": 4, "o": 91_000_000_000u64 }] }),
    );
    signer.signed("withdraw home", NONCE, withdraw(OWN, "10"));
    signer.signed("withdraw listed", NONCE, withdraw(LISTED, "1.5"));
}

#[test]
fn hypercore_charges_the_daily_usd_limit_and_refuses_past_it() {
    let signer = Signer::fixture("limits");
    signer.signed("thirty", NONCE, ioc(4, "30", "1"));
    signer.refused(
        "twenty one",
        withdraw(OWN, "20.000001"),
        "today's total for hypercore:usdc would be 50000001, above the 50000000 limit",
    );
    signer.signed("twenty", NONCE, withdraw(OWN, "20"));
    signer.refused(
        "one more",
        ioc(4, "0.00000001", "1"),
        "above the 50000000 limit",
    );
    signer.refused(
        "spot",
        ioc(10107, "20.5", "1"),
        "above its whole 20000000 daily limit",
    );
    signer.refused(
        "unlisted spot",
        ioc(10200, "1", "1"),
        "no daily limit is set for hypercore:spot:10200",
    );
}

#[test]
fn hypercore_refuses_what_whale_does_not_build() {
    let signer = Signer::fixture("refusals");
    signer.refused(
        "gtc",
        sdk_order("Gtc", "1", "1", 4),
        "only immediate-or-cancel",
    );
    signer.refused(
        "builder perp",
        ioc(110_000, "1", "1"),
        "builder-deployed perp",
    );
    signer.refused(
        "cross",
        json!({ "type": "updateLeverage", "asset": 4, "isCross": true, "leverage": 1 }),
        "only isolated leverage",
    );
    signer.refused(
        "leverage 4",
        json!({ "type": "updateLeverage", "asset": 4, "isCross": false, "leverage": 4 }),
        "leverage 4 is outside 1 to 3",
    );
    signer.refused(
        "attacker",
        withdraw(ATTACKER, "1"),
        "may only pay this wallet or a listed destination",
    );
    signer.refused(
        "checksummed",
        withdraw("0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", "1"),
        "lowercase 0x address",
    );
    signer.refused(
        "usd send",
        json!({ "type": "usdSend", "hyperliquidChain": "Testnet", "signatureChainId": "0x66eee", "destination": OWN, "amount": "1", "time": NONCE }),
        "action usdSend is not one the signer decodes",
    );
    let outcome = signer.run("mainnet", "mainnet", NONCE, ioc(4, "1", "1"));
    assert!(
        outcome["reasons"][0]
            .as_str()
            .unwrap()
            .starts_with("hypercore: the job is for Mainnet"),
        "{outcome}"
    );
    let mut file = load("policy.json");
    file.as_object_mut().unwrap().remove("hypercore");
    let bare = Signer::new("bare", file);
    bare.refused(
        "no section",
        ioc(4, "1", "1"),
        "hypercore is not in the policy",
    );
}

#[test]
fn a_resent_job_signs_again_without_a_second_charge() {
    let signer = Signer::fixture("resend");
    let first = signer.signed("forty", NONCE, ioc(4, "40", "1"));
    let again = signer.signed("forty", NONCE, ioc(4, "40", "1"));
    assert_eq!(first, again);
    signer.refused(
        "forty",
        ioc(4, "41", "1"),
        "already signed today for different work",
    );
    signer.signed("ten", NONCE + 1, ioc(4, "10", "1"));
}

fn sell(asset: u64, price: &str, size: &str, reduce_only: bool) -> Value {
    json!({
        "type": "order",
        "orders": [{ "a": asset, "b": false, "p": price, "s": size, "r": reduce_only, "t": { "limit": { "tif": "Ioc" } } }],
        "grouping": "na"
    })
}

#[test]
fn a_perp_sell_is_charged_by_size_whether_it_closes_a_long_or_opens_a_short() {
    let signer = Signer::fixture("perp sells");
    signer.refused(
        "dump",
        sell(4, "0.00000001", "99999999999", true),
        "9999999999900000000 of hypercore:perp:4:sold is above its whole 50000000000 daily limit",
    );
    signer.refused(
        "short without a size limit",
        sell(5, "0.2", "250", false),
        "no daily limit is set for hypercore:perp:5:sold",
    );
    signer.signed("short", NONCE, sell(4, "0.2", "250", false));
    signer.signed("close a long", NONCE + 1, sell(4, "0.2", "250", true));
    signer.refused(
        "past the size limit",
        sell(4, "0.2", "1", true),
        "would be 50100000000, above the 50000000000 limit",
    );
    signer.signed("forty nine", NONCE + 2, ioc(4, "49", "1"));
}

#[test]
fn a_spot_sell_is_never_charged_at_its_own_limit_price() {
    let signer = Signer::fixture("spot sells");
    signer.refused(
        "spot sell without a size limit",
        sell(10107, "0.01", "1", false),
        "no daily limit is set for hypercore:spot:10107:sold",
    );
    let mut file = load("policy.json");
    file["hypercore"]["dailyLimits"]["hypercore:spot:10107:sold"] = "300000000".into();
    let sized = Signer::new("sized sells", file);
    sized.signed("sell two", NONCE, sell(10107, "0.01", "2", false));
    sized.refused(
        "sell two more",
        sell(10107, "0.01", "2", false),
        "would be 400000000, above the 300000000 limit",
    );
}

fn leverage(asset: u64, leverage: u64) -> Value {
    json!({ "type": "updateLeverage", "asset": asset, "isCross": false, "leverage": leverage })
}

#[test]
fn the_default_policy_signs_isolated_2x_and_refuses_4x() {
    let mut file = load("policy.json");
    file["hypercore"]
        .as_object_mut()
        .unwrap()
        .remove("maxLeverage");
    let signer = Signer::new("default leverage", file);
    signer.signed("2x", NONCE, leverage(4, 2));
    signer.signed("3x", NONCE + 1, leverage(4, 3));
    signer.refused("4x", leverage(4, 4), "leverage 4 is outside 1 to 3");
}

#[test]
fn a_policy_ceiling_above_50x_is_refused_at_load() {
    let mut file = load("policy.json");
    file["hypercore"]["maxLeverage"] = 50.into();
    assert!(whale_signer::policy::Policy::parse(&file).is_ok());
    file["hypercore"]["maxLeverage"] = 51.into();
    assert_eq!(
        whale_signer::policy::Policy::parse(&file).err().as_deref(),
        Some("hypercore.maxLeverage must be a whole number from 1 to 50")
    );
}

#[test]
fn a_3x_order_is_charged_its_notional_not_its_margin() {
    let signer = Signer::fixture("notional at 3x");
    signer.signed("3x", NONCE, leverage(4, 3));
    signer.refused(
        "60 USD notional on 20 USD of margin",
        ioc(4, "60", "1"),
        "hypercore:usdc is above its whole 50000000 daily limit",
    );
    signer.signed("50 USD notional", NONCE + 1, ioc(4, "50", "1"));
}
