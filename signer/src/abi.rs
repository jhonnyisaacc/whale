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

fn words<T>(
    data: &[u8],
    start: usize,
    slot: usize,
    read: fn(&[u8], usize) -> Option<T>,
) -> Option<Vec<T>> {
    let at = offset(data, start.checked_add(slot * 32)?, start)?;
    let count = usize::try_from(uint(data, at)?).ok()?;
    if count > (data.len() - at) / 32 {
        return None;
    }
    (1..=count)
        .map(|index| read(data, at + index * 32))
        .collect()
}

pub struct Exec {
    pub operator: [u8; 20],
    pub target: [u8; 20],
}

pub enum Route {
    ZeroEx { exec: Option<Exec> },
    Kyber { parties: Vec<[u8; 20]> },
    Lifi,
}

impl Route {
    pub fn provider(&self) -> &'static str {
        match self {
            Route::ZeroEx { .. } => "zeroex",
            Route::Kyber { .. } => "kyberswap",
            Route::Lifi => "lifi",
        }
    }
}

pub struct SwapTerms {
    pub route: Route,
    pub recipient: [u8; 20],
    pub sell: Option<([u8; 20], u128)>,
}

fn settler(args: &[u8]) -> Option<[u8; 20]> {
    address(args, 0)
}

const ZERO_EX_EXEC: &str = "exec(address,address,uint256,address,bytes)";
const ZERO_EX_EXECUTE: &str = "execute((address,address,uint256),bytes[],bytes32)";
const KYBER_DESC: &str = "(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes)";

fn kyber_desc(data: &[u8], start: usize, mut parties: Vec<[u8; 20]>) -> Option<SwapTerms> {
    let amount = uint(data, start + 7 * 32)?;
    let routed = words(data, start, 3, uint)?
        .into_iter()
        .try_fold(0u128, u128::checked_add)?;
    if routed > amount {
        return None;
    }
    parties.extend(words(data, start, 2, address)?);
    parties.extend(words(data, start, 4, address)?);
    Some(SwapTerms {
        route: Route::Kyber { parties },
        recipient: address(data, start + 6 * 32)?,
        sell: Some((address(data, start)?, amount)),
    })
}

const LIFI_HEAD: &str = "bytes32,string,string,address,uint256";
const LIFI_SWAP: &str = "(address,address,address,address,uint256,bytes,bool)";

fn boolean(data: &[u8], at: usize) -> Option<bool> {
    match uint(data, at)? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

struct LifiSwap {
    sending: [u8; 20],
    amount: u128,
    deposit: bool,
}

fn lifi_swap(args: &[u8], start: usize) -> Option<LifiSwap> {
    Some(LifiSwap {
        sending: address(args, start + 2 * 32)?,
        amount: uint(args, start + 4 * 32)?,
        deposit: boolean(args, start + 6 * 32)?,
    })
}

fn lifi_swaps(args: &[u8], single: bool) -> Option<Vec<LifiSwap>> {
    let at = offset(args, 5 * 32, 0)?;
    if single {
        return Some(vec![lifi_swap(args, at)?]);
    }
    let count = usize::try_from(uint(args, at)?).ok()?;
    if count == 0 || count > (args.len() - at) / 32 {
        return None;
    }
    (1..=count)
        .map(|index| lifi_swap(args, offset(args, at + index * 32, at + 32)?))
        .collect()
}

// The ERC20 entry points pull every swap marked requiresDeposit from the caller (a single swap always),
// so the sell is that sum, and a route that pulls a second token is not read.
fn lifi_terms(head: &[u8], args: &[u8]) -> Option<SwapTerms> {
    let (kind, single) = ["ERC20ToERC20", "ERC20ToNative", "NativeToERC20"]
        .into_iter()
        .flat_map(|kind| [(kind, true), (kind, false)])
        .find(|(kind, single)| {
            let (name, swap) = if *single {
                ("Single", LIFI_SWAP.to_string())
            } else {
                ("Multiple", format!("{LIFI_SWAP}[]"))
            };
            head == selector(&format!("swapTokens{name}V3{kind}({LIFI_HEAD},{swap})"))
        })?;
    let swaps = lifi_swaps(args, single)?;
    let recipient = address(args, 3 * 32)?;
    if kind == "NativeToERC20" {
        return Some(SwapTerms {
            route: Route::Lifi,
            recipient,
            sell: Some(([0u8; 20], 0)),
        });
    }
    let pulled: Vec<&LifiSwap> = swaps.iter().filter(|swap| single || swap.deposit).collect();
    let token = pulled.first()?.sending;
    if token == [0u8; 20] || pulled.iter().any(|swap| swap.sending != token) {
        return None;
    }
    let amount = pulled
        .iter()
        .try_fold(0u128, |sum, swap| sum.checked_add(swap.amount))?;
    Some(SwapTerms {
        route: Route::Lifi,
        recipient,
        sell: Some((token, amount)),
    })
}

pub fn swap_terms(calldata: &[u8]) -> Option<SwapTerms> {
    let head = calldata.get(..4)?;
    let args = &calldata[4..];
    if head == selector(ZERO_EX_EXECUTE) {
        return Some(SwapTerms {
            route: Route::ZeroEx { exec: None },
            recipient: settler(args)?,
            sell: None,
        });
    }
    if head == selector(ZERO_EX_EXEC) {
        let operator = address(args, 0)?;
        let token = address(args, 32)?;
        let amount = uint(args, 64)?;
        let inner = bytes_at(args, offset(args, 128, 0)?)?;
        if inner.get(..4)? != selector(ZERO_EX_EXECUTE) {
            return None;
        }
        return Some(SwapTerms {
            route: Route::ZeroEx {
                exec: Some(Exec {
                    operator,
                    target: address(args, 96)?,
                }),
            },
            recipient: settler(&inner[4..])?,
            sell: Some((token, amount)),
        });
    }
    if head == selector(&format!("swapSimpleMode(address,{KYBER_DESC},bytes,bytes)")) {
        return kyber_desc(args, offset(args, 32, 0)?, vec![address(args, 0)?]);
    }
    if head == selector(&format!("swap((address,address,bytes,{KYBER_DESC},bytes))")) {
        let execution = offset(args, 0, 0)?;
        let mut parties = vec![address(args, execution)?];
        let approve = address(args, execution + 32)?;
        if approve != [0u8; 20] {
            parties.push(approve);
        }
        return kyber_desc(args, offset(args, execution + 3 * 32, execution)?, parties);
    }
    lifi_terms(head, args)
}
