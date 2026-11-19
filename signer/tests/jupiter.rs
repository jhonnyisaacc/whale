mod support;

use serde_json::{Value, json};
use support::*;
use whale_signer::{policy::Policy, run_job, solana};

#[test]
fn real_shared_routes_sign_and_charge_their_in_amount_to_the_sold_token() {
    let policy = policy();
    for name in [
        "SOL to USDC",
        "USDC to SOL",
        "USDC to BONK",
        "BONK to WIF",
        "SOL to BONK with a Jito tip",
        "SOL to JitoSOL with a Jito tip",
    ] {
        let case = case(name);
        let outcome = sign(
            &policy,
            &job(name, &bytes(&case), case["outputMint"].as_str()),
        );
        assert_eq!(outcome["decision"], "signed", "{name}: {outcome}");
        let decision = policy.check_solana(
            &solana::parse(&bytes(&case)).unwrap(),
            key(case["owner"].as_str().unwrap()),
            Some(key(case["outputMint"].as_str().unwrap())),
        );
        let sold = (
            sold_key(case["inputMint"].as_str().unwrap()),
            case["inAmount"].as_str().unwrap().parse::<u128>().unwrap(),
        );
        assert!(
            decision.spend.contains(&sold),
            "{name}: {:?} lacks {sold:?}",
            decision.spend
        );
        assert!(
            decision
                .spend
                .iter()
                .all(|(key, _)| key == "solana:native" || *key == sold.0),
            "{name}: {:?}",
            decision.spend
        );
    }
}

#[test]
fn the_funded_routes_that_were_simulated_pass_the_policy_for_their_owner() {
    let policy = policy();
    for name in ["funded SOL to USDC", "funded USDC to BONK"] {
        let case = case(name);
        let decision = policy.check_solana(
            &solana::parse(&bytes(&case)).unwrap(),
            key(case["owner"].as_str().unwrap()),
            Some(key(case["outputMint"].as_str().unwrap())),
        );
        assert!(decision.allowed(), "{name}: {:?}", decision.reasons);
    }
}

#[test]
fn real_routes_the_signer_refuses() {
    let policy = policy();
    for (name, reason) in [
        (
            "SOL to USDC as route",
            "only Jupiter shared_accounts_route is signed, not route",
        ),
        (
            "USDC to BONK as route",
            "only Jupiter shared_accounts_route is signed, not route",
        ),
        (
            "USDC to PYUSD, a Token-2022 mint",
            "jupiter account 14 is this wallet, which only the transfer authority may name",
        ),
    ] {
        let case = case(name);
        let outcome = sign(
            &policy,
            &job(name, &bytes(&case), case["outputMint"].as_str()),
        );
        assert_eq!(outcome["decision"], "refused", "{name}: {outcome}");
        assert!(
            outcome["reasons"].to_string().contains(reason),
            "{name}: expected '{reason}', got {outcome}"
        );
    }
}

#[test]
fn the_unedited_base_fixture_signs() {
    assert_eq!(
        sign(&policy(), &job("base", &edited(|_| {}), Some(BONK)))["decision"],
        "signed"
    );
}

#[test]
fn a_shared_route_rewritten_in_one_field_is_refused() {
    let policy = policy();
    let wallet_static = edited(|message| {
        let index = message.jupiter().0[4] as usize;
        message.keys[index] = key(fixtures()["own"].as_str().unwrap());
    });
    let token_2022_destination = edited(|message| {
        let index = message.jupiter().0[6] as usize;
        message.keys[index] = owned_token_account(BONK, TOKEN_2022);
    });
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "the wallet in a remaining account",
            edited(|message| message.jupiter().0[20] = 0),
            "jupiter account 20 is this wallet, which only the transfer authority may name",
        ),
        (
            "the wallet's key at a second static index",
            wallet_static,
            "jupiter account 4 is this wallet",
        ),
        (
            "the destination from a lookup table",
            edited(|message| {
                let loaded = message.first_loaded();
                message.jupiter().0[6] = loaded;
            }),
            "jupiter account 6 comes from a lookup table, so it cannot be checked",
        ),
        (
            "the source from a lookup table",
            edited(|message| {
                let loaded = message.first_loaded();
                message.jupiter().0[3] = loaded;
            }),
            "jupiter account 3 comes from a lookup table",
        ),
        (
            "the authority from a lookup table",
            edited(|message| {
                let loaded = message.first_loaded();
                message.jupiter().0[2] = loaded;
            }),
            "jupiter account 2 comes from a lookup table",
        ),
        (
            "another authority",
            edited(|message| {
                let accounts = message.jupiter().0;
                accounts[2] = accounts[6];
            }),
            "the Jupiter transfer authority is not this wallet",
        ),
        (
            "the platform fee set",
            edited(|message| {
                let accounts = message.jupiter().0;
                accounts[9] = accounts[6];
            }),
            "the Jupiter platform fee account is set",
        ),
        (
            "too few accounts",
            edited(|message| message.jupiter().0.truncate(9)),
            "the Jupiter instruction has no account 9",
        ),
        (
            "a Token-2022 destination for buyMint",
            token_2022_destination,
            "buys DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 under Token-2022",
        ),
        (
            "a token ledger route",
            edited(|message| {
                message.jupiter().1[..8]
                    .copy_from_slice(&discriminator("shared_accounts_route_with_token_ledger"))
            }),
            "not shared_accounts_route_with_token_ledger",
        ),
        (
            "an exact-out route",
            edited(|message| {
                message.jupiter().1[..8]
                    .copy_from_slice(&discriminator("shared_accounts_exact_out_route"))
            }),
            "not shared_accounts_exact_out_route",
        ),
        (
            "a v2 route",
            edited(|message| {
                message.jupiter().1[..8].copy_from_slice(&discriminator("shared_accounts_route_v2"))
            }),
            "not shared_accounts_route_v2",
        ),
        (
            "an unknown Jupiter instruction",
            edited(|message| message.jupiter().1[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8])),
            "not instruction 0102030405060708",
        ),
        (
            "a Jupiter instruction shorter than a discriminator",
            edited(|message| message.jupiter().1.truncate(7)),
            "jupiter instruction is too short",
        ),
        (
            "bytes after the route arguments",
            edited(|message| message.jupiter().1.push(0)),
            "the Jupiter route has bytes after its arguments",
        ),
        (
            "truncated route arguments",
            edited(|message| {
                message.jupiter().1.pop();
            }),
            "the Jupiter route arguments are truncated",
        ),
        (
            "a swap variant past the pinned IDL",
            edited(|message| message.jupiter().1[13] = 255),
            "Jupiter swap variant 255 is not in the pinned IDL",
        ),
        (
            "a swap variant the signer cannot size",
            edited(|message| message.jupiter().1[13] = 111),
            "the signer cannot size the Jupiter swap DynamicV1",
        ),
        (
            "a swap option tag that is not 0 or 1",
            edited(|message| {
                let data = message.jupiter().1;
                data[13] = 47;
                data[15] = 2;
            }),
            "a Jupiter swap option tag is not 0 or 1",
        ),
    ];
    for (name, message, reason) in cases {
        refused_with(&policy, name, &message, Some(BONK), reason);
    }
}

#[test]
fn a_shared_route_is_refused_when_buy_mint_does_not_bind_its_destination() {
    let policy = policy();
    let message = edited(|_| {});
    refused_with(
        &policy,
        "another buyMint",
        &message,
        Some(USDC),
        "which is not this wallet's token account for buyMint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    refused_with(
        &policy,
        "no buyMint",
        &message,
        None,
        "the job names no buyMint, so the Jupiter destination cannot be checked",
    );
    for (name, buy_mint) in [
        ("a buyMint that is not base58", json!("0OIl")),
        ("a buyMint that is not a string", json!(7)),
    ] {
        let mut job = job(name, &message, None);
        job["buyMint"] = buy_mint;
        let outcome = sign(&policy, &job);
        assert_eq!(
            outcome["reasons"],
            json!(["buyMint must be a base58 Solana address"]),
            "{name}"
        );
    }
}

#[test]
fn a_shared_route_selling_a_token_without_a_daily_limit_is_refused() {
    let mut file = policy_file();
    file["solana"]["dailyLimits"]
        .as_object_mut()
        .unwrap()
        .remove(&format!("solana:{USDC}"));
    refused_with(
        &Policy::parse(&file).unwrap(),
        "an unlimited source",
        &edited(|_| {}),
        Some(BONK),
        "sells from a token account that is not this wallet's account for a mint with a daily limit",
    );
}

#[test]
fn shared_route_sales_stop_at_the_sold_token_daily_limit() {
    let mut file = policy_file();
    file["solana"]["dailyLimits"][format!("solana:{USDC}")] = "1500000".into();
    let policy = Policy::parse(&file).unwrap();
    let path = ledger("usdc-day");
    let decisions: Vec<Value> = (0..2)
        .map(|n| {
            let job = job(&format!("usdc day {n}"), &edited(|_| {}), Some(BONK));
            run_job(&job, &policy, &keys(), &path, DAY)["decision"].clone()
        })
        .collect();
    assert_eq!(
        decisions,
        ["signed", "refused"],
        "two 1 USDC sales against a 1.5 USDC day"
    );
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(written["spent"][format!("solana:{USDC}")], "1000000");
    let _ = std::fs::remove_file(path);
}

#[test]
fn the_app_path_manifest_route_that_passes_the_wallet_to_a_step_is_refused() {
    let case = load("jupiter-manifest.json");
    let decision = policy().check_solana(
        &solana::parse(&bytes(&case)).unwrap(),
        key(case["owner"].as_str().unwrap()),
        Some(key(case["outputMint"].as_str().unwrap())),
    );
    assert_eq!(case["amms"], json!(["Manifest"]));
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason
                .contains("is this wallet, which only the transfer authority may name")),
        "{:?}",
        decision.reasons
    );
}
