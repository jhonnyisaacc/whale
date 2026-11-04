// The keys never leave this process in clear. On disk they sit under scrypt and ChaCha20-Poly1305; in memory the
// seed buffers are zeroized as soon as the signing keys exist.
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use zeroize::Zeroize;

pub struct Keys {
    pub evm: k256::ecdsa::SigningKey,
    pub solana: ed25519_dalek::SigningKey,
}

const SCRYPT_LOG_N: u8 = 17;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).map_err(|error| format!("no randomness: {error}"))?;
    Ok(out)
}

fn derive(passphrase: &str, salt: &[u8], log_n: u8, r: u32, p: u32) -> Result<[u8; 32], String> {
    if passphrase.chars().count() < 12 {
        return Err("the passphrase must be at least 12 characters".into());
    }
    let params =
        scrypt::Params::new(log_n, r, p).map_err(|error| format!("scrypt params: {error}"))?;
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut key)
        .map_err(|error| format!("scrypt: {error}"))?;
    Ok(key)
}

fn from_seed(mut seed: [u8; 64]) -> Result<Keys, String> {
    let evm = k256::ecdsa::SigningKey::from_slice(&seed[..32])
        .map_err(|_| "the EVM key is out of range".to_string());
    let mut solana_seed = [0u8; 32];
    solana_seed.copy_from_slice(&seed[32..]);
    let solana = ed25519_dalek::SigningKey::from_bytes(&solana_seed);
    seed.zeroize();
    solana_seed.zeroize();
    Ok(Keys { evm: evm?, solana })
}

pub fn generate() -> Result<Keys, String> {
    from_seed(random::<64>()?)
}

pub fn seal(keys: &Keys, passphrase: &str) -> Result<Value, String> {
    let salt = random::<16>()?;
    let nonce = random::<12>()?;
    let mut key = derive(passphrase, &salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| "cipher key")?;
    key.zeroize();
    let mut plain = [0u8; 64];
    plain[..32].copy_from_slice(&keys.evm.to_bytes());
    plain[32..].copy_from_slice(&keys.solana.to_bytes());
    let sealed = cipher
        .encrypt(&Nonce::from(nonce), plain.as_slice())
        .map_err(|_| "encryption failed".to_string());
    plain.zeroize();
    Ok(json!({
        "version": 1,
        "kdf": { "name": "scrypt", "logN": SCRYPT_LOG_N, "r": SCRYPT_R, "p": SCRYPT_P, "salt": hex::encode(salt) },
        "cipher": { "name": "chacha20poly1305", "nonce": hex::encode(nonce), "ciphertext": hex::encode(sealed?) },
        "evmAddress": evm_address(&keys.evm),
        "solanaAddress": solana_address(&keys.solana),
    }))
}

pub fn open(file: &Value, passphrase: &str) -> Result<Keys, String> {
    let field = |path: &[&str]| -> Result<String, String> {
        let mut current = file;
        for key in path {
            current = current
                .get(*key)
                .ok_or_else(|| format!("keystore is missing {}", path.join(".")))?;
        }
        current
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("keystore field {} is not text", path.join(".")))
    };
    let number = |key: &str| {
        file.get("kdf")
            .and_then(|kdf| kdf.get(key))
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("keystore is missing kdf.{key}"))
    };
    let salt = hex::decode(field(&["kdf", "salt"])?).map_err(|_| "bad salt")?;
    let nonce: [u8; 12] = hex::decode(field(&["cipher", "nonce"])?)
        .map_err(|_| "bad nonce")?
        .try_into()
        .map_err(|_| "bad nonce length")?;
    let sealed = hex::decode(field(&["cipher", "ciphertext"])?).map_err(|_| "bad ciphertext")?;
    let log_n = u8::try_from(number("logN")?).map_err(|_| "bad logN")?;
    let mut key = derive(
        passphrase,
        &salt,
        log_n,
        u32::try_from(number("r")?).map_err(|_| "bad r")?,
        u32::try_from(number("p")?).map_err(|_| "bad p")?,
    )?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| "cipher key")?;
    key.zeroize();
    let mut plain = cipher
        .decrypt(&Nonce::from(nonce), sealed.as_slice())
        .map_err(|_| "wrong passphrase or a damaged keystore".to_string())?;
    let seed: Result<[u8; 64], _> = plain.as_slice().try_into();
    plain.zeroize();
    from_seed(seed.map_err(|_| "keystore holds the wrong number of bytes")?)
}

pub fn evm_address_bytes(key: &k256::ecdsa::SigningKey) -> [u8; 20] {
    let point = key.verifying_key().to_sec1_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

// EIP-55 mixed-case checksum.
pub fn checksum(address: &[u8; 20]) -> String {
    let lower = hex::encode(address);
    let hash = Keccak256::digest(lower.as_bytes());
    let mixed: String = lower
        .chars()
        .enumerate()
        .map(|(index, character)| {
            let nibble = (hash[index / 2] >> if index % 2 == 0 { 4 } else { 0 }) & 0x0f;
            if character.is_ascii_alphabetic() && nibble >= 8 {
                character.to_ascii_uppercase()
            } else {
                character
            }
        })
        .collect();
    format!("0x{mixed}")
}

pub fn evm_address(key: &k256::ecdsa::SigningKey) -> String {
    checksum(&evm_address_bytes(key))
}

pub fn solana_address(key: &ed25519_dalek::SigningKey) -> String {
    bs58::encode(key.verifying_key().to_bytes()).into_string()
}

pub fn from_test_seed(seed: [u8; 64]) -> Result<Keys, String> {
    from_seed(seed)
}
