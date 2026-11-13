use sha3::{Digest, Keccak256};

pub fn selector(signature: &str) -> [u8; 4] {
    let hash = Keccak256::digest(signature.as_bytes());
    [hash[0], hash[1], hash[2], hash[3]]
}

pub fn word(data: &[u8], offset: usize) -> Option<&[u8]> {
    data.get(offset..offset.checked_add(32)?)
}

pub fn address(data: &[u8], offset: usize) -> Option<[u8; 20]> {
    let word = word(data, offset)?;
    if word[..12].iter().any(|byte| *byte != 0) {
        return None;
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&word[12..]);
    Some(out)
}

pub fn uint(data: &[u8], offset: usize) -> Option<u128> {
    let word = word(data, offset)?;
    if word[..16].iter().any(|byte| *byte != 0) {
        return None;
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&word[16..]);
    Some(u128::from_be_bytes(out))
}

pub fn offset(data: &[u8], at: usize, base: usize) -> Option<usize> {
    let relative = usize::try_from(uint(data, at)?).ok()?;
    let absolute = base.checked_add(relative)?;
    (absolute <= data.len()).then_some(absolute)
}

pub fn bytes_at(data: &[u8], start: usize) -> Option<&[u8]> {
    let length = usize::try_from(uint(data, start)?).ok()?;
    data.get(start + 32..start.checked_add(32)?.checked_add(length)?)
}

pub struct SwapTerms {
    pub provider: &'static str,
    pub recipient: [u8; 20],
    pub sell: Option<([u8; 20], u128)>,
}

fn settler(args: &[u8]) -> Option<[u8; 20]> {
    address(args, 0)
}

const ZERO_EX_EXEC: &str = "exec(address,address,uint256,address,bytes)";
const ZERO_EX_EXECUTE: &str = "execute((address,address,uint256),bytes[],bytes32)";
const KYBER_DESC: &str = "(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes)";

fn kyber_desc(data: &[u8], start: usize) -> Option<SwapTerms> {
    Some(SwapTerms {
        provider: "kyberswap",
        recipient: address(data, start + 6 * 32)?,
        sell: Some((address(data, start)?, uint(data, start + 7 * 32)?)),
    })
}

pub fn swap_terms(calldata: &[u8]) -> Option<SwapTerms> {
    let head = calldata.get(..4)?;
    let args = &calldata[4..];
    if head == selector(ZERO_EX_EXECUTE) {
        return Some(SwapTerms {
            provider: "zeroex",
            recipient: settler(args)?,
            sell: None,
        });
    }
    if head == selector(ZERO_EX_EXEC) {
        let token = address(args, 32)?;
        let amount = uint(args, 64)?;
        let inner = bytes_at(args, offset(args, 128, 0)?)?;
        if inner.get(..4)? != selector(ZERO_EX_EXECUTE) {
            return None;
        }
        return Some(SwapTerms {
            provider: "zeroex",
            recipient: settler(&inner[4..])?,
            sell: Some((token, amount)),
        });
    }
    if head == selector(&format!("swapSimpleMode(address,{KYBER_DESC},bytes,bytes)")) {
        return kyber_desc(args, offset(args, 32, 0)?);
    }
    if head == selector(&format!("swap((address,address,bytes,{KYBER_DESC},bytes))")) {
        let execution = offset(args, 0, 0)?;
        return kyber_desc(args, offset(args, execution + 3 * 32, execution)?);
    }
    None
}
