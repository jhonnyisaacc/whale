use super::{Decision, Policy, amount, text_list};
use crate::btc::{self, Job};
use bitcoin::absolute::LockTime;
use bitcoin::transaction::Version;
use bitcoin::{Address, Network, Script, ScriptBuf, Sequence};
use serde_json::Value;
use std::collections::HashSet;
use std::str::FromStr;

pub struct BitcoinPolicy {
    network: Network,
    destinations: HashSet<ScriptBuf>,
    max_fee_sats: u128,
    max_inputs: usize,
}

const SPEND_KEY: &str = "bitcoin:native";
const CANONICAL: &str =
    "the transaction must be version 2, lock time 0, and sequence 0xfffffffd on every input";

fn standard(script: &Script) -> bool {
    script.is_p2pkh()
        || script.is_p2sh()
        || script.is_p2wpkh()
        || script.is_p2wsh()
        || script.is_p2tr()
}

impl BitcoinPolicy {
    pub fn parse(section: &Value) -> Result<Option<BitcoinPolicy>, String> {
        if section.is_null() {
            return Ok(None);
        }
        let network = btc::network(section["network"].as_str().unwrap_or_default())
            .map_err(|error| format!("bitcoin.network: {error}"))?;
        let destinations = text_list(section.get("destinations"))
            .iter()
            .map(|text| {
                Address::from_str(text)
                    .ok()
                    .and_then(|address| address.require_network(network).ok())
                    .map(|address| address.script_pubkey())
                    .filter(|script| standard(script))
                    .ok_or_else(|| {
                        format!("bitcoin.destinations: {text} is not a {network} address")
                    })
            })
            .collect::<Result<_, _>>()?;
        let max_inputs = section.get("maxInputs").map_or(Ok(20), |value| {
            value
                .as_u64()
                .filter(|count| *count >= 1)
                .and_then(|count| usize::try_from(count).ok())
                .ok_or("bitcoin.maxInputs must be a whole number of at least 1")
        })?;
        Ok(Some(BitcoinPolicy {
            network,
            destinations,
            max_fee_sats: amount(section.get("maxFeeSats"), "bitcoin.maxFeeSats")?,
            max_inputs,
        }))
    }

    fn spent(&self, job: &Job, own: &Script) -> Result<u128, String> {
        let tx = &job.tx;
        if tx.version != Version::TWO
            || tx.lock_time != LockTime::ZERO
            || tx
                .input
                .iter()
                .any(|input| input.sequence != Sequence::ENABLE_RBF_NO_LOCKTIME)
        {
            return Err(CANONICAL.into());
        }
        if let Some(index) = tx
            .input
            .iter()
            .position(|input| !input.script_sig.is_empty() || !input.witness.is_empty())
        {
            return Err(format!("input {index} carries a signature already"));
        }
        if tx.input.is_empty() {
            return Err("the transaction has no inputs".into());
        }
        if tx.input.len() > self.max_inputs {
            return Err(format!(
                "{} inputs is above the {} input limit",
                tx.input.len(),
                self.max_inputs
            ));
        }
        let mut seen = HashSet::new();
        if let Some(index) = tx
            .input
            .iter()
            .position(|input| !seen.insert(input.previous_output))
        {
            return Err(format!(
                "input {index} spends the same coin as an earlier input"
            ));
        }
        if let Some(index) = job
            .prevouts
            .iter()
            .position(|prevout| prevout.script_pubkey.as_script() != own)
        {
            return Err(format!(
                "input {index} does not spend this wallet's address"
            ));
        }
        if tx.output.is_empty() {
            return Err("the transaction has no outputs".into());
        }
        let mut change = 0u128;
        for (index, output) in tx.output.iter().enumerate() {
            let script = output.script_pubkey.as_script();
            if script == own {
                change += u128::from(output.value.to_sat());
                continue;
            }
            if self.destinations.contains(script) {
                continue;
            }
            return Err(if script.is_op_return() {
                format!("output {index} is OP_RETURN")
            } else if !standard(script) {
                format!("output {index} has an unknown script")
            } else {
                let address = Address::from_script(script, self.network).map_or_else(
                    |_| format!("script {}", script.to_hex_string()),
                    |address| address.to_string(),
                );
                format!("output {index} pays {address}, which is not an allowed destination")
            });
        }
        let inputs: u128 = job
            .prevouts
            .iter()
            .map(|prevout| u128::from(prevout.value.to_sat()))
            .sum();
        let outputs: u128 = tx
            .output
            .iter()
            .map(|output| u128::from(output.value.to_sat()))
            .sum();
        if outputs > inputs {
            return Err("outputs spend more than the inputs hold".into());
        }
        let fee = inputs - outputs;
        if fee > self.max_fee_sats {
            return Err(format!(
                "the fee {fee} sats is above the {} sats cap",
                self.max_fee_sats
            ));
        }
        Ok(inputs - change)
    }
}

impl Policy {
    pub fn check_bitcoin(&self, job: &Job, own: &Script) -> Decision {
        let mut decision = Decision {
            reasons: vec![],
            spend: vec![],
        };
        match self.bitcoin.as_ref().map(|rule| rule.spent(job, own)) {
            None => decision.reasons.push("bitcoin is not in the policy".into()),
            Some(Err(reason)) => decision.reasons.push(reason),
            Some(Ok(spent)) => self.spend(&mut decision, SPEND_KEY.into(), spent),
        }
        decision
    }
}
