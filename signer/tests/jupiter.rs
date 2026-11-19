use serde_json::{Value, json};
use std::path::PathBuf;
use whale_signer::{keystore, pda, policy::Policy, run_job, solana};

const DAY: &str = "2026-11-19";
const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK: &str = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WSOL: &str = "So11111111111111111111111111111111111111112";
const JUPITER: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("vector file")).expect("vector json")
}

fn fixtures() -> Value {
    load("jupiter.json")
}

fn policy_file() -> Value {
    let mut file = load("policy.json");
    file["solana"]["maxPriorityLamports"] = "1000000".into();
    file["solana"]["dailyLimits"][format!("solana:{USDC}")] = "10000000".into();
    file["solana"]["dailyLimits"][format!("solana:{BONK}")] = "1000000000000000".into();
    file
}

fn policy() -> Policy {
    Policy::parse(&policy_file()).expect("policy")
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
    seed[32..].copy_from_slice(fixtures()["seedText"].as_str().unwrap().as_bytes());
    keystore::from_test_seed(seed).expect("test keys")
}

fn case(name: &str) -> Value {
    fixtures()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("no fixture named {name}"))
        .clone()
}

fn bytes(case: &Value) -> Vec<u8> {
    hex::decode(case["messageHex"].as_str().unwrap()).unwrap()
}

fn key(text: &str) -> [u8; 32] {
    solana::key(text).unwrap()
}

fn job(name: &str, message: &[u8], buy_mint: Option<&str>) -> Value {
    use base64::Engine;
    let mut job = json!({
        "id": name,
        "kind": "solana",
        "message": base64::engine::general_purpose::STANDARD.encode(message),
    });
    if let Some(mint) = buy_mint {
        job["buyMint"] = mint.into();
    }
    job
}

fn ledger(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "whale-signer-{}-jupiter-{}.json",
        std::process::id(),
        name.replace(' ', "-")
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn sign(policy: &Policy, job: &Value) -> Value {
    let path = ledger(job["id"].as_str().unwrap());
    let outcome = run_job(job, policy, &keys(), &path, DAY);
    let _ = std::fs::remove_file(path);
    outcome
}

fn sold_key(mint: &str) -> String {
    if mint == WSOL {
        "solana:native".into()
    } else {
        format!("solana:{mint}")
    }
}

struct Editable {
    header: [u8; 3],
    keys: Vec<[u8; 32]>,
    blockhash: [u8; 32],
    instructions: Vec<(u8, Vec<u8>, Vec<u8>)>,
    lookups: Vec<([u8; 32], Vec<u8>, Vec<u8>)>,
}

fn compact(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

impl Editable {
    fn decode(bytes: &[u8]) -> Editable {
        assert_eq!(bytes[0], 0x80, "a v0 fixture");
        let mut at = 1;
        let mut take = |count: usize| {
            let slice = bytes[at..at + count].to_vec();
            at += count;
            slice
        };
        let header: [u8; 3] = take(3).try_into().unwrap();
        let short = |take: &mut dyn FnMut(usize) -> Vec<u8>| {
            let mut value = 0usize;
            for shift in [0, 7, 14] {
                let byte = take(1)[0];
                value |= usize::from(byte & 0x7f) << shift;
                if byte & 0x80 == 0 {
                    break;
                }
            }
            value
        };
        let key_count = short(&mut take);
        let keys = (0..key_count)
            .map(|_| take(32).try_into().unwrap())
            .collect();
        let blockhash = take(32).try_into().unwrap();
        let instruction_count = short(&mut take);
        let instructions = (0..instruction_count)
            .map(|_| {
                let program = take(1)[0];
                let count = short(&mut take);
                let accounts = take(count);
                let length = short(&mut take);
                (program, accounts, take(length))
            })
            .collect();
        let lookup_count = short(&mut take);
        let lookups = (0..lookup_count)
            .map(|_| {
                let table = take(32).try_into().unwrap();
                let writable = short(&mut take);
                let writable = take(writable);
                let readonly = short(&mut take);
                (table, writable, take(readonly))
            })
            .collect();
        Editable {
            header,
            keys,
            blockhash,
            instructions,
            lookups,
        }
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = vec![0x80];
        out.extend(self.header);
        compact(&mut out, self.keys.len());
        self.keys.iter().for_each(|key| out.extend(key));
        out.extend(self.blockhash);
        compact(&mut out, self.instructions.len());
        for (program, accounts, data) in &self.instructions {
            out.push(*program);
            compact(&mut out, accounts.len());
            out.extend(accounts);
            compact(&mut out, data.len());
            out.extend(data);
        }
        compact(&mut out, self.lookups.len());
        for (table, writable, readonly) in &self.lookups {
            out.extend(table);
            compact(&mut out, writable.len());
            out.extend(writable);
            compact(&mut out, readonly.len());
            out.extend(readonly);
        }
        out
    }

    fn jupiter(&mut self) -> (&mut Vec<u8>, &mut Vec<u8>) {
        let program = self
            .keys
            .iter()
            .position(|key| *key == solana::key(JUPITER).unwrap())
            .unwrap() as u8;
        let (_, accounts, data) = self
            .instructions
            .iter_mut()
            .find(|(index, _, _)| *index == program)
            .unwrap();
        (accounts, data)
    }

    fn first_loaded(&self) -> u8 {
        self.keys.len() as u8
    }
}

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

fn refused_with(policy: &Policy, name: &str, message: &[u8], buy_mint: Option<&str>, reason: &str) {
    let outcome = sign(policy, &job(name, message, buy_mint));
    assert_eq!(outcome["decision"], "refused", "{name}: {outcome}");
    assert!(
        outcome["reasons"].to_string().contains(reason),
        "{name}: expected '{reason}', got {outcome}"
    );
}

fn edited(edit: impl FnOnce(&mut Editable)) -> Vec<u8> {
    let mut message = Editable::decode(&bytes(&case("USDC to BONK")));
    edit(&mut message);
    message.encode()
}

fn owned_token_account(mint: &str, program: &str) -> [u8; 32] {
    pda::associated_token_address(
        &key(fixtures()["own"].as_str().unwrap()),
        &key(mint),
        &key(program),
        &key(ASSOCIATED_TOKEN),
    )
    .unwrap()
}

fn discriminator(name: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!("global:{name}"))[..8].to_vec()
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
fn a_message_the_runtime_would_reject_does_not_parse() {
    let base = edited(|_| {});
    let key_count = base[4];
    assert!(key_count < 0x80, "the fixture's key count fits one byte");
    let with_key_count = |encoding: &[u8]| {
        let mut out = base[..4].to_vec();
        out.extend(encoding);
        out.extend(&base[5..]);
        out
    };
    let mut trailing = base.clone();
    trailing.push(0);
    let mut version_one = base.clone();
    version_one[0] = 0x81;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "an account index past the loaded accounts",
            edited(|message| message.jupiter().0[20] = 250),
            "names account 250, but the message loads only",
        ),
        (
            "a program index past the loaded accounts",
            edited(|message| message.instructions[0].0 = 250),
            "instruction 0 names account 250",
        ),
        (
            "a non-canonical compact length",
            with_key_count(&[key_count | 0x80, 0]),
            "compact length is not canonical",
        ),
        (
            "a compact length above u16",
            with_key_count(&[0x80, 0x80, 0x04]),
            "compact length is above u16",
        ),
        (
            "a four-byte compact length",
            with_key_count(&[0x80, 0x80, 0x80, 0x01]),
            "compact length is above u16",
        ),
        (
            "trailing bytes after the lookups",
            trailing,
            "message has trailing bytes",
        ),
        (
            "a version 1 message",
            version_one,
            "only legacy and v0 messages are signed",
        ),
    ];
    for (name, message, reason) in cases {
        let error = solana::parse(&message).err();
        assert!(
            error.as_deref().is_some_and(|error| error.contains(reason)),
            "{name}: expected '{reason}', got {error:?}"
        );
        refused_with(&policy(), name, &message, Some(BONK), reason);
    }
}

#[test]
fn a_listed_program_without_an_instruction_rule_is_refused() {
    let mut file = policy_file();
    file["solana"]["programs"]
        .as_array_mut()
        .unwrap()
        .push("Stake11111111111111111111111111111111111111".into());
    let stake = edited(|message| {
        let jupiter = message
            .keys
            .iter()
            .position(|key| *key == solana::key(JUPITER).unwrap())
            .unwrap();
        message.keys[jupiter] = key("Stake11111111111111111111111111111111111111");
    });
    refused_with(
        &Policy::parse(&file).unwrap(),
        "a stake instruction",
        &stake,
        Some(BONK),
        "the signer has no instruction rule for Stake11111111111111111111111111111111111111",
    );
}
