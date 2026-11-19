#![allow(dead_code)]

use serde_json::{Value, json};
use std::path::PathBuf;
use whale_signer::{keystore, pda, policy::Policy, run_job, solana};

pub const DAY: &str = "2026-11-19";
pub const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const BONK: &str = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
pub const WSOL: &str = "So11111111111111111111111111111111111111112";
pub const JUPITER: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
pub const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const ASSOCIATED_TOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

pub fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("vector file")).expect("vector json")
}

pub fn fixtures() -> Value {
    load("jupiter.json")
}

pub fn policy_file() -> Value {
    let mut file = load("policy.json");
    file["solana"]["maxPriorityLamports"] = "1000000".into();
    file["solana"]["dailyLimits"][format!("solana:{USDC}")] = "10000000".into();
    file["solana"]["dailyLimits"][format!("solana:{BONK}")] = "1000000000000000".into();
    file
}

pub fn policy() -> Policy {
    Policy::parse(&policy_file()).expect("policy")
}

pub fn keys() -> keystore::Keys {
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

pub fn case(name: &str) -> Value {
    fixtures()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("no fixture named {name}"))
        .clone()
}

pub fn bytes(case: &Value) -> Vec<u8> {
    hex::decode(case["messageHex"].as_str().unwrap()).unwrap()
}

pub fn key(text: &str) -> [u8; 32] {
    solana::key(text).unwrap()
}

pub fn job(name: &str, message: &[u8], buy_mint: Option<&str>) -> Value {
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

pub fn ledger(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "whale-signer-{}-jupiter-{}.json",
        std::process::id(),
        name.replace(' ', "-")
    ));
    let _ = std::fs::remove_file(&path);
    path
}

pub fn sign(policy: &Policy, job: &Value) -> Value {
    let path = ledger(job["id"].as_str().unwrap());
    let outcome = run_job(job, policy, &keys(), &path, DAY);
    let _ = std::fs::remove_file(path);
    outcome
}

pub fn sold_key(mint: &str) -> String {
    if mint == WSOL {
        "solana:native".into()
    } else {
        format!("solana:{mint}")
    }
}

pub struct Editable {
    pub header: [u8; 3],
    pub keys: Vec<[u8; 32]>,
    pub blockhash: [u8; 32],
    pub instructions: Vec<(u8, Vec<u8>, Vec<u8>)>,
    pub lookups: Vec<([u8; 32], Vec<u8>, Vec<u8>)>,
}

pub fn compact(out: &mut Vec<u8>, mut value: usize) {
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
    pub fn decode(bytes: &[u8]) -> Editable {
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

    pub fn encode(&self) -> Vec<u8> {
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

    pub fn jupiter(&mut self) -> (&mut Vec<u8>, &mut Vec<u8>) {
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

    pub fn first_loaded(&self) -> u8 {
        self.keys.len() as u8
    }
}

pub fn refused_with(
    policy: &Policy,
    name: &str,
    message: &[u8],
    buy_mint: Option<&str>,
    reason: &str,
) {
    let outcome = sign(policy, &job(name, message, buy_mint));
    assert_eq!(outcome["decision"], "refused", "{name}: {outcome}");
    assert!(
        outcome["reasons"].to_string().contains(reason),
        "{name}: expected '{reason}', got {outcome}"
    );
}

pub fn edited(edit: impl FnOnce(&mut Editable)) -> Vec<u8> {
    let mut message = Editable::decode(&bytes(&case("USDC to BONK")));
    edit(&mut message);
    message.encode()
}

pub fn owned_token_account(mint: &str, program: &str) -> [u8; 32] {
    pda::associated_token_address(
        &key(fixtures()["own"].as_str().unwrap()),
        &key(mint),
        &key(program),
        &key(ASSOCIATED_TOKEN),
    )
    .unwrap()
}

pub fn discriminator(name: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!("global:{name}"))[..8].to_vec()
}
