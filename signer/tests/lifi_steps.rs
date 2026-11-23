use serde_json::Value;
use std::path::PathBuf;
use whale_signer::lifi::STEP_TARGETS;

#[test]
fn the_lifi_step_table_matches_the_apps() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vectors/lifi-steps.json");
    let app: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let app = app.as_object().unwrap();
    assert_eq!(
        app.len(),
        STEP_TARGETS.len(),
        "run node signer/vectors/generate.mjs"
    );
    for table in STEP_TARGETS {
        let entry = &app[&table.chain.to_string()];
        let lower = |text: &Value| {
            text.as_str()
                .unwrap()
                .trim_start_matches("0x")
                .to_lowercase()
        };
        assert_eq!(
            lower(&entry["feeForwarder"]),
            table.fee_forwarder,
            "chain {}",
            table.chain
        );
        let targets: Vec<String> = entry["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(lower)
            .collect();
        assert_eq!(targets, table.targets, "chain {}", table.chain);
    }
}
