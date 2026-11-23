use serde_json::{Value, json};
use std::path::PathBuf;
use whale_signer::bridge_tokens::BRIDGE_TOKENS;

#[test]
fn the_bridge_token_table_matches_the_typescript_signing_policy() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vectors/bridge-tokens.json");
    let typescript: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let rust: Vec<Value> = BRIDGE_TOKENS
        .iter()
        .map(|token| {
            json!({
                "symbol": token.symbol,
                "chainId": token.chain,
                "address": format!("0x{}", token.address),
                "decimals": token.decimals,
            })
        })
        .collect();
    assert_eq!(typescript, Value::Array(rust));
}
