use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    pub fn parse(text: Option<&str>) -> Result<Network, String> {
        match text {
            Some("mainnet") => Ok(Network::Mainnet),
            Some("testnet") => Ok(Network::Testnet),
            _ => Err("network must be mainnet or testnet".into()),
        }
    }

    fn chain_name(self) -> &'static str {
        match self {
            Network::Mainnet => "Mainnet",
            Network::Testnet => "Testnet",
        }
    }

    fn source(self) -> &'static str {
        match self {
            Network::Mainnet => "a",
            Network::Testnet => "b",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tif {
    Ioc,
    Gtc,
    Alo,
}

impl Tif {
    fn name(self) -> &'static str {
        match self {
            Tif::Ioc => "Ioc",
            Tif::Gtc => "Gtc",
            Tif::Alo => "Alo",
        }
    }
}

pub struct Order {
    pub asset: u64,
    pub buy: bool,
    pub price: String,
    pub size: String,
    pub reduce_only: bool,
    pub tif: Tif,
}

pub enum Action {
    Order(Vec<Order>),
    Cancel(Vec<(u64, u64)>),
    UpdateLeverage {
        asset: u64,
        is_cross: bool,
        leverage: u64,
    },
    Withdraw {
        destination: [u8; 20],
        amount: String,
        time: u64,
    },
}

pub struct Job {
    pub network: Network,
    pub nonce: u64,
    pub action: Action,
}

pub const SIGNATURE_CHAIN_ID: u64 = 0x66eee;

fn exactly<'a, const N: usize>(
    value: &'a Value,
    keys: [&str; N],
    what: &str,
) -> Result<[&'a Value; N], String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{what} must be an object"))?;
    if object.len() != N || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(format!(
            "{what} must have exactly the fields {}",
            keys.join(", ")
        ));
    }
    Ok(keys.map(|key| &object[key]))
}

fn whole(value: &Value, what: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("{what} must be a whole number"))
}

fn flag(value: &Value, what: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("{what} must be true or false"))
}

fn decimal(value: &Value, what: &str, max_decimals: usize) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{what} must be a decimal string"))?;
    let (int, frac) = text.split_once('.').unwrap_or((text, ""));
    let canonical = !int.is_empty()
        && int.len() <= 20
        && int.bytes().all(|byte| byte.is_ascii_digit())
        && (int == "0" || !int.starts_with('0'))
        && frac.len() <= max_decimals
        && frac.bytes().all(|byte| byte.is_ascii_digit())
        && (text.contains('.') == !frac.is_empty())
        && !frac.ends_with('0');
    if !canonical {
        return Err(format!(
            "{what} must be a plain decimal with at most {max_decimals} places and no trailing zeros"
        ));
    }
    Ok(text.to_owned())
}

fn parse_order(value: &Value) -> Result<Order, String> {
    let [a, b, p, s, r, t] = exactly(value, ["a", "b", "p", "s", "r", "t"], "an order")?;
    let [limit] = exactly(t, ["limit"], "an order type")?;
    let [tif] = exactly(limit, ["tif"], "a limit order type")?;
    Ok(Order {
        asset: whole(a, "order.a")?,
        buy: flag(b, "order.b")?,
        price: decimal(p, "order.p", 8)?,
        size: decimal(s, "order.s", 8)?,
        reduce_only: flag(r, "order.r")?,
        tif: match tif.as_str() {
            Some("Ioc") => Tif::Ioc,
            Some("Gtc") => Tif::Gtc,
            Some("Alo") => Tif::Alo,
            _ => return Err("order tif must be Ioc, Gtc or Alo".into()),
        },
    })
}

fn parse_action(action: &Value, network: Network, nonce: u64) -> Result<Action, String> {
    let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "order" => {
            let [_, orders, grouping] =
                exactly(action, ["type", "orders", "grouping"], "an order action")?;
            if grouping.as_str() != Some("na") {
                return Err("order grouping must be na".into());
            }
            let orders = orders
                .as_array()
                .ok_or("orders must be a list")?
                .iter()
                .map(parse_order)
                .collect::<Result<Vec<_>, _>>()?;
            if orders.is_empty() {
                return Err("an order action must hold at least one order".into());
            }
            Ok(Action::Order(orders))
        }
        "cancel" => {
            let [_, cancels] = exactly(action, ["type", "cancels"], "a cancel action")?;
            let cancels = cancels
                .as_array()
                .ok_or("cancels must be a list")?
                .iter()
                .map(|cancel| {
                    let [a, o] = exactly(cancel, ["a", "o"], "a cancel")?;
                    Ok((whole(a, "cancel.a")?, whole(o, "cancel.o")?))
                })
                .collect::<Result<Vec<_>, String>>()?;
            if cancels.is_empty() {
                return Err("a cancel action must name at least one order".into());
            }
            Ok(Action::Cancel(cancels))
        }
        "updateLeverage" => {
            let [_, asset, is_cross, leverage] = exactly(
                action,
                ["type", "asset", "isCross", "leverage"],
                "an updateLeverage action",
            )?;
            Ok(Action::UpdateLeverage {
                asset: whole(asset, "asset")?,
                is_cross: flag(is_cross, "isCross")?,
                leverage: whole(leverage, "leverage")?,
            })
        }
        "withdraw3" => {
            let [_, chain, signature_chain, destination, amount, time] = exactly(
                action,
                [
                    "type",
                    "hyperliquidChain",
                    "signatureChainId",
                    "destination",
                    "amount",
                    "time",
                ],
                "a withdraw3 action",
            )?;
            if chain.as_str() != Some(network.chain_name()) {
                return Err(format!(
                    "withdraw3 hyperliquidChain must be {}",
                    network.chain_name()
                ));
            }
            if signature_chain.as_str() != Some("0x66eee") {
                return Err("withdraw3 signatureChainId must be 0x66eee".into());
            }
            let text = destination
                .as_str()
                .ok_or("withdraw3 destination must be a string")?;
            let raw = text
                .strip_prefix("0x")
                .filter(|raw| {
                    raw.len() == 40 && raw.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                })
                .ok_or("withdraw3 destination must be a lowercase 0x address")?;
            let time = whole(time, "withdraw3 time")?;
            if time != nonce {
                return Err("withdraw3 time must equal the nonce".into());
            }
            Ok(Action::Withdraw {
                destination: hex::decode(raw)
                    .expect("checked hex")
                    .try_into()
                    .expect("20 bytes"),
                amount: decimal(amount, "withdraw3 amount", 6)?,
                time,
            })
        }
        "" => Err("the action has no type".into()),
        other => Err(format!("action {other} is not one the signer decodes")),
    }
}

pub fn parse(job: &Value) -> Result<Job, String> {
    let network = Network::parse(job.get("network").and_then(Value::as_str))?;
    let nonce = job
        .get("nonce")
        .and_then(Value::as_u64)
        .ok_or("nonce must be a whole number")?;
    let action = job.get("action").ok_or("the job has no action")?;
    Ok(Job {
        network,
        nonce,
        action: parse_action(action, network, nonce)?,
    })
}

fn pack_uint(out: &mut Vec<u8>, value: u64) {
    match value {
        0..=0x7f => out.push(value as u8),
        0x80..=0xff => out.extend([0xcc, value as u8]),
        0x100..=0xffff => {
            out.push(0xcd);
            out.extend((value as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xce);
            out.extend((value as u32).to_be_bytes());
        }
        _ => {
            out.push(0xcf);
            out.extend(value.to_be_bytes());
        }
    }
}

fn pack_str(out: &mut Vec<u8>, text: &str) {
    let len = text.len();
    match len {
        0..=31 => out.push(0xa0 | len as u8),
        32..=255 => out.extend([0xd9, len as u8]),
        _ => {
            out.push(0xda);
            out.extend((len as u16).to_be_bytes());
        }
    }
    out.extend(text.as_bytes());
}

fn pack_len(out: &mut Vec<u8>, len: usize, fix: u8, wide: u8) {
    if len < 16 {
        out.push(fix | len as u8);
    } else {
        out.push(wide);
        out.extend((len as u16).to_be_bytes());
    }
}

fn pack_bool(out: &mut Vec<u8>, value: bool) {
    out.push(if value { 0xc3 } else { 0xc2 });
}

fn msgpack(action: &Action) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let map = |out: &mut Vec<u8>, len| pack_len(out, len, 0x80, 0xde);
    let array = |out: &mut Vec<u8>, len| pack_len(out, len, 0x90, 0xdc);
    match action {
        Action::Order(orders) => {
            map(&mut out, 3);
            pack_str(&mut out, "type");
            pack_str(&mut out, "order");
            pack_str(&mut out, "orders");
            array(&mut out, orders.len());
            for order in orders {
                map(&mut out, 6);
                pack_str(&mut out, "a");
                pack_uint(&mut out, order.asset);
                pack_str(&mut out, "b");
                pack_bool(&mut out, order.buy);
                pack_str(&mut out, "p");
                pack_str(&mut out, &order.price);
                pack_str(&mut out, "s");
                pack_str(&mut out, &order.size);
                pack_str(&mut out, "r");
                pack_bool(&mut out, order.reduce_only);
                pack_str(&mut out, "t");
                map(&mut out, 1);
                pack_str(&mut out, "limit");
                map(&mut out, 1);
                pack_str(&mut out, "tif");
                pack_str(&mut out, order.tif.name());
            }
            pack_str(&mut out, "grouping");
            pack_str(&mut out, "na");
        }
        Action::Cancel(cancels) => {
            map(&mut out, 2);
            pack_str(&mut out, "type");
            pack_str(&mut out, "cancel");
            pack_str(&mut out, "cancels");
            array(&mut out, cancels.len());
            for (asset, oid) in cancels {
                map(&mut out, 2);
                pack_str(&mut out, "a");
                pack_uint(&mut out, *asset);
                pack_str(&mut out, "o");
                pack_uint(&mut out, *oid);
            }
        }
        Action::UpdateLeverage {
            asset,
            is_cross,
            leverage,
        } => {
            map(&mut out, 4);
            pack_str(&mut out, "type");
            pack_str(&mut out, "updateLeverage");
            pack_str(&mut out, "asset");
            pack_uint(&mut out, *asset);
            pack_str(&mut out, "isCross");
            pack_bool(&mut out, *is_cross);
            pack_str(&mut out, "leverage");
            pack_uint(&mut out, *leverage);
        }
        Action::Withdraw { .. } => return None,
    }
    Some(out)
}

pub fn connection_id(job: &Job) -> Option<[u8; 32]> {
    let mut data = msgpack(&job.action)?;
    data.extend(job.nonce.to_be_bytes());
    data.push(0);
    Some(Keccak256::digest(&data).into())
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

fn word(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

fn typed_hash(
    domain_name: &str,
    chain_id: u64,
    struct_type: &str,
    fields: &[[u8; 32]],
) -> [u8; 32] {
    let mut domain = keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    )
    .to_vec();
    domain.extend(keccak(domain_name.as_bytes()));
    domain.extend(keccak(b"1"));
    domain.extend(word(chain_id));
    domain.extend([0u8; 32]);
    let mut message = keccak(struct_type.as_bytes()).to_vec();
    for field in fields {
        message.extend(field);
    }
    let mut digest = vec![0x19, 0x01];
    digest.extend(keccak(&domain));
    digest.extend(keccak(&message));
    keccak(&digest)
}

pub fn signing_hash(job: &Job) -> [u8; 32] {
    match &job.action {
        Action::Withdraw {
            destination,
            amount,
            time,
        } => typed_hash(
            "HyperliquidSignTransaction",
            SIGNATURE_CHAIN_ID,
            "HyperliquidTransaction:Withdraw(string hyperliquidChain,string destination,string amount,uint64 time)",
            &[
                keccak(job.network.chain_name().as_bytes()),
                keccak(format!("0x{}", hex::encode(destination)).as_bytes()),
                keccak(amount.as_bytes()),
                word(*time),
            ],
        ),
        _ => typed_hash(
            "Exchange",
            1337,
            "Agent(string source,bytes32 connectionId)",
            &[
                keccak(job.network.source().as_bytes()),
                connection_id(job).expect("an L1 action"),
            ],
        ),
    }
}

pub fn sign(job: &Job, key: &k256::ecdsa::SigningKey) -> Value {
    let (signature, recovery) = key.sign_prehash_recoverable(&signing_hash(job));
    let bytes = signature.to_bytes();
    json!({
        "r": format!("0x{}", hex::encode(&bytes[..32])),
        "s": format!("0x{}", hex::encode(&bytes[32..])),
        "v": 27 + u64::from(recovery.to_byte()),
    })
}
