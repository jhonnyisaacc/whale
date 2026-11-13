pub mod abi;
pub mod evm;
pub mod jupiter;
mod jupiter_swaps;
pub mod keystore;
pub mod ledger;
pub mod pda;
pub mod policy;
pub mod rlp;
pub mod solana;

use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;

pub fn run_job(
    job: &Value,
    policy: &policy::Policy,
    keys: &keystore::Keys,
    ledger_path: &Path,
    day: &str,
) -> Value {
    let id = job.get("id").cloned().unwrap_or(Value::Null);
    let refused =
        |reasons: Vec<String>| json!({ "id": id, "decision": "refused", "reasons": reasons });
    let mut ledger = match ledger::Ledger::load(ledger_path, day) {
        Ok(ledger) => ledger,
        Err(error) => return refused(vec![error]),
    };
    let (decision, sign): (policy::Decision, Box<dyn Fn() -> Result<Value, String>>) = match job
        .get("kind")
        .and_then(Value::as_str)
    {
        Some("evm") => {
            match evm::parse(job) {
                Ok(tx) => {
                    let decision = policy.check_evm(&tx, keystore::evm_address_bytes(&keys.evm));
                    (
                        decision,
                        Box::new(move || {
                            evm::sign(&tx, &keys.evm).map(|raw| json!({ "signedTransaction": format!("0x{}", hex::encode(raw)) }))
                        }),
                    )
                }
                Err(error) => return refused(vec![error]),
            }
        }
        Some("solana") => {
            let bytes = match job
                .get("message")
                .and_then(Value::as_str)
                .map(|text| base64::engine::general_purpose::STANDARD.decode(text))
            {
                Some(Ok(bytes)) => bytes,
                _ => return refused(vec!["message must be base64".into()]),
            };
            match solana::parse(&bytes) {
                Ok(message) => {
                    let decision =
                        policy.check_solana(&message, keys.solana.verifying_key().to_bytes());
                    (
                        decision,
                        Box::new(move || {
                            Ok(
                                json!({ "signature": bs58::encode(solana::sign(&bytes, &keys.solana)).into_string() }),
                            )
                        }),
                    )
                }
                Err(error) => return refused(vec![error]),
            }
        }
        _ => return refused(vec!["kind must be evm or solana".into()]),
    };
    if !decision.allowed() {
        return refused(decision.reasons);
    }
    let over = ledger.over_limit(&decision.spend, &policy.daily_limits);
    if !over.is_empty() {
        return refused(over);
    }
    match sign() {
        Ok(signed) => match ledger.commit(ledger_path, &decision.spend) {
            Ok(()) => json!({ "id": id, "decision": "signed", "result": signed }),
            Err(error) => refused(vec![error]),
        },
        Err(error) => refused(vec![error]),
    }
}
