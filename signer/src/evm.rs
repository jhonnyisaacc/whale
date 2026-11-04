use crate::abi;
use crate::rlp::{self, Item};
use serde_json::Value;
use sha3::{Digest, Keccak256};

pub struct Tx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee: u128,
    pub max_fee: u128,
    pub gas: u64,
    pub to: [u8; 20],
    pub value: u128,
    pub data: Vec<u8>,
}

fn number(raw: &Value, name: &str) -> Result<u128, String> {
    let text = raw
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("tx.{name} must be a decimal or 0x string"))?;
    let parsed = match text.strip_prefix("0x") {
        Some(hex) => u128::from_str_radix(hex, 16),
        None => text.parse::<u128>(),
    };
    parsed.map_err(|_| format!("tx.{name} is not a number that fits"))
}

pub fn parse_address(text: &str) -> Result<[u8; 20], String> {
    let raw = text
        .strip_prefix("0x")
        .ok_or("an address must start with 0x")?;
    let bytes = hex::decode(raw).map_err(|_| "an address must be hex")?;
    bytes
        .try_into()
        .map_err(|_| "an address must be 20 bytes".to_string())
}

pub fn parse(job: &Value) -> Result<Tx, String> {
    let chain_id = job
        .get("chainId")
        .and_then(Value::as_u64)
        .ok_or("chainId must be a number")?;
    let tx = job.get("tx").ok_or("the job has no tx")?;
    let data_text = tx.get("data").and_then(Value::as_str).unwrap_or("0x");
    let data = hex::decode(
        data_text
            .strip_prefix("0x")
            .ok_or("tx.data must start with 0x")?,
    )
    .map_err(|_| "tx.data must be hex")?;
    let small = |name: &str| -> Result<u64, String> {
        u64::try_from(number(tx, name)?).map_err(|_| format!("tx.{name} is too large"))
    };
    Ok(Tx {
        chain_id,
        nonce: small("nonce")?,
        max_priority_fee: number(tx, "maxPriorityFeePerGas")?,
        max_fee: number(tx, "maxFeePerGas")?,
        gas: small("gas")?,
        to: parse_address(
            tx.get("to")
                .and_then(Value::as_str)
                .ok_or("tx.to is required; contract creation is never signed")?,
        )?,
        value: number(tx, "value")?,
        data,
    })
}

fn fields(tx: &Tx) -> Vec<Item> {
    vec![
        rlp::uint(u128::from(tx.chain_id)),
        rlp::uint(u128::from(tx.nonce)),
        rlp::uint(tx.max_priority_fee),
        rlp::uint(tx.max_fee),
        rlp::uint(u128::from(tx.gas)),
        Item::Bytes(tx.to.to_vec()),
        rlp::uint(tx.value),
        Item::Bytes(tx.data.clone()),
        Item::List(vec![]),
    ]
}

pub fn signing_hash(tx: &Tx) -> [u8; 32] {
    let mut payload = vec![0x02];
    payload.extend(rlp::encode(&Item::List(fields(tx))));
    Keccak256::digest(&payload).into()
}

pub fn sign(tx: &Tx, key: &k256::ecdsa::SigningKey) -> Result<Vec<u8>, String> {
    let (signature, recovery) = key.sign_prehash_recoverable(&signing_hash(tx));
    let bytes = signature.to_bytes();
    let mut all = fields(tx);
    all.push(rlp::uint(u128::from(recovery.to_byte())));
    all.push(Item::Bytes(trim(&bytes[..32])));
    all.push(Item::Bytes(trim(&bytes[32..])));
    let mut raw = vec![0x02];
    raw.extend(rlp::encode(&Item::List(all)));
    Ok(raw)
}

fn trim(bytes: &[u8]) -> Vec<u8> {
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len());
    bytes[first..].to_vec()
}

pub enum Call {
    Native,
    Erc20Transfer {
        token: [u8; 20],
        to: [u8; 20],
        amount: u128,
    },
    Erc20Approve {
        token: [u8; 20],
        spender: [u8; 20],
        amount: u128,
    },
    Swap {
        router: [u8; 20],
        terms: abi::SwapTerms,
    },
    Unknown {
        to: [u8; 20],
        selector: [u8; 4],
    },
}

pub fn classify(tx: &Tx) -> Call {
    if tx.data.is_empty() {
        return Call::Native;
    }
    let Some(head) = tx.data.get(..4) else {
        return Call::Unknown {
            to: tx.to,
            selector: [0; 4],
        };
    };
    let args = &tx.data[4..];
    let selector: [u8; 4] = [head[0], head[1], head[2], head[3]];
    let pair =
        |first: usize, second: usize| Some((abi::address(args, first)?, abi::uint(args, second)?));
    if selector == abi::selector("transfer(address,uint256)")
        && args.len() == 64
        && let Some((to, amount)) = pair(0, 32)
    {
        return Call::Erc20Transfer {
            token: tx.to,
            to,
            amount,
        };
    }
    if selector == abi::selector("approve(address,uint256)")
        && args.len() == 64
        && let Some((spender, amount)) = pair(0, 32)
    {
        return Call::Erc20Approve {
            token: tx.to,
            spender,
            amount,
        };
    }
    match abi::swap_terms(&tx.data) {
        Some(terms) => Call::Swap {
            router: tx.to,
            terms,
        },
        None => Call::Unknown {
            to: tx.to,
            selector,
        },
    }
}

// EIP-191 personal_sign: what a wallet signs for a text message. The 65-byte signature ends with v = 27 or 28.
pub fn personal_sign(message: &str, key: &k256::ecdsa::SigningKey) -> String {
    let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", message.len(), message);
    let hash: [u8; 32] = Keccak256::digest(prefixed.as_bytes()).into();
    let (signature, recovery) = key.sign_prehash_recoverable(&hash);
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(27 + recovery.to_byte());
    format!("0x{}", hex::encode(bytes))
}
