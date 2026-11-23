use bitcoin::consensus::{deserialize, serialize};
use bitcoin::hashes::Hash;
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::{Address, CompressedPublicKey, Network, ScriptBuf, Transaction, TxOut, Witness};
use k256::ecdsa::SigningKey;
use serde_json::Value;

pub struct Job {
    pub tx: Transaction,
    pub prevouts: Vec<TxOut>,
}

fn decode(value: &Value, name: &str) -> Result<Transaction, String> {
    let bytes = value
        .as_str()
        .and_then(|text| hex::decode(text).ok())
        .ok_or_else(|| format!("{name} must be hex"))?;
    deserialize(&bytes).map_err(|_| format!("{name} is not a bitcoin transaction"))
}

pub fn parse(job: &Value) -> Result<Job, String> {
    let tx = decode(&job["transaction"], "the transaction")?;
    let previous = job
        .get("previous")
        .and_then(Value::as_array)
        .filter(|items| items.len() == tx.input.len())
        .ok_or("previous must list one transaction per input")?;
    let prevouts = tx
        .input
        .iter()
        .zip(previous)
        .enumerate()
        .map(|(index, (input, prior))| {
            let prior = decode(prior, &format!("previous {index}"))?;
            let outpoint = input.previous_output;
            if prior.compute_txid() != outpoint.txid {
                return Err(format!(
                    "input {index}: the previous transaction does not hash to {}",
                    outpoint.txid
                ));
            }
            usize::try_from(outpoint.vout)
                .ok()
                .and_then(|vout| prior.output.get(vout).cloned())
                .ok_or_else(|| {
                    format!(
                        "input {index}: the previous transaction has no output {}",
                        outpoint.vout
                    )
                })
        })
        .collect::<Result<_, _>>()?;
    Ok(Job { tx, prevouts })
}

pub fn network(name: &str) -> Result<Network, String> {
    match name {
        "bitcoin" => Ok(Network::Bitcoin),
        "testnet" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        _ => Err("the bitcoin network must be bitcoin, testnet, signet or regtest".into()),
    }
}

pub fn public_key(key: &SigningKey) -> CompressedPublicKey {
    CompressedPublicKey::from_slice(key.verifying_key().to_sec1_point(true).as_bytes())
        .expect("a k256 key is a valid secp256k1 point")
}

pub fn bound_public_key(text: &str, evm_address: &str) -> Result<CompressedPublicKey, String> {
    let invalid = || "bitcoinPublicKey is not a compressed secp256k1 key".to_string();
    let bytes = hex::decode(text).map_err(|_| invalid())?;
    let public = CompressedPublicKey::from_slice(&bytes).map_err(|_| invalid())?;
    let point = k256::ecdsa::VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| invalid())?;
    if crate::keystore::checksum(&crate::keystore::evm_address_of(&point)) != evm_address {
        return Err("bitcoinPublicKey does not belong to the keystore's evmAddress".into());
    }
    Ok(public)
}

pub fn own_script(key: &SigningKey) -> ScriptBuf {
    ScriptBuf::new_p2wpkh(&public_key(key).wpubkey_hash())
}

pub fn address(public: &CompressedPublicKey, network: Network) -> String {
    Address::p2wpkh(public, network).to_string()
}

pub fn work(job: &Job) -> Vec<u8> {
    serialize(&job.tx)
}

pub fn sign(job: &Job, key: &SigningKey) -> Result<Vec<u8>, String> {
    let public = public_key(key);
    let script = own_script(key);
    let mut cache = SighashCache::new(&job.tx);
    let witnesses = job
        .prevouts
        .iter()
        .enumerate()
        .map(|(index, prevout)| {
            let digest = cache
                .p2wpkh_signature_hash(index, &script, prevout.value, EcdsaSighashType::All)
                .map_err(|error| format!("input {index}: {error}"))?;
            let (signature, _) = key.sign_prehash_recoverable(digest.as_byte_array());
            let mut signature =
                bitcoin::secp256k1::ecdsa::Signature::from_compact(&signature.to_bytes())
                    .map_err(|error| format!("input {index}: {error}"))?;
            signature.normalize_s();
            Ok(Witness::p2wpkh(
                &bitcoin::ecdsa::Signature::sighash_all(signature),
                &public.0,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut tx = job.tx.clone();
    for (input, witness) in tx.input.iter_mut().zip(witnesses) {
        input.witness = witness;
    }
    Ok(serialize(&tx))
}
