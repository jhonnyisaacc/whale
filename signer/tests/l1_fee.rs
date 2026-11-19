use serde_json::{Value, json};
use std::path::PathBuf;
use whale_signer::{evm, policy::Policy};

const DESTINATION: &str = "0x2222222222222222222222222222222222222222";
const GAS: u128 = 21_000;
const MAX_FEE: u128 = 1_000;

fn chains() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vectors/chains.json");
    serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn policy() -> Policy {
    let ids: Vec<u64> = chains()
        .iter()
        .map(|chain| chain["chainId"].as_u64().unwrap())
        .collect();
    let limits: serde_json::Map<String, Value> = ids
        .iter()
        .map(|id| (format!("{id}:native"), json!("1000000000000000000000")))
        .collect();
    Policy::parse(&json!({
        "version": 1,
        "evm": {
            "chains": ids,
            "destinations": [DESTINATION],
            "maxFeeWei": "1000000000000000000000",
            "dailyLimits": limits,
        }
    }))
    .unwrap()
}

fn transfer(chain_id: u64, data_bytes: usize) -> evm::Tx {
    evm::parse(&json!({
        "id": "l1",
        "kind": "evm",
        "chainId": chain_id,
        "tx": {
            "nonce": "7",
            "to": DESTINATION,
            "value": "1",
            "data": format!("0x{}", "ab".repeat(data_bytes)),
            "gas": GAS.to_string(),
            "maxFeePerGas": MAX_FEE.to_string(),
            "maxPriorityFeePerGas": "1"
        }
    }))
    .unwrap()
}

fn cap_refusal(reasons: &[String]) -> bool {
    reasons
        .iter()
        .any(|reason| reason.contains("cap the L1 fee budget covers"))
}

#[test]
fn every_chain_charges_the_l1_fee_budget_the_app_table_gives_it() {
    let policy = policy();
    for chain in chains() {
        let id = chain["chainId"].as_u64().unwrap();
        let decision = policy.check_evm(&transfer(id, 0), [0; 20]);
        match chain.get("l1DataFee") {
            None => {
                assert!(decision.allowed(), "{id}: {:?}", decision.reasons);
                assert_eq!(
                    decision.spend,
                    [
                        (format!("{id}:native"), GAS * MAX_FEE),
                        (format!("{id}:native"), 1)
                    ]
                );
            }
            Some(Value::Null) => assert!(
                decision
                    .reasons
                    .iter()
                    .any(|reason| reason.contains("separate L1 data fee")),
                "{id} has no budget and must be refused: {:?}",
                decision.reasons
            ),
            Some(budget) => {
                let wei: u128 = budget["maxFeeWei"].as_str().unwrap().parse().unwrap();
                assert!(decision.allowed(), "{id}: {:?}", decision.reasons);
                assert_eq!(
                    decision.spend,
                    [
                        (format!("{id}:native"), GAS * MAX_FEE + wei),
                        (format!("{id}:native"), 1)
                    ]
                );
                let cap = budget["maxDataBytes"].as_u64().unwrap() as usize;
                assert!(
                    !cap_refusal(&policy.check_evm(&transfer(id, cap), [0; 20]).reasons),
                    "{id} refused calldata at its cap"
                );
                assert!(
                    cap_refusal(&policy.check_evm(&transfer(id, cap + 1), [0; 20]).reasons),
                    "{id} signed calldata above its cap"
                );
            }
        }
    }
}
