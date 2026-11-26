use crate::abi::{self, LifiStep};

pub const MAX_LIFI_FEE_BPS: u128 = 50;

pub struct StepTable {
    pub chain: u64,
    pub fee_forwarder: &'static str,
    pub targets: &'static [&'static str],
    pub spenders: &'static [&'static str],
}

pub use crate::lifi_targets::STEP_TARGETS;

const FORWARD_ERC20: &str = "forwardERC20Fees(address,(address,uint256)[])";
const FORWARD_NATIVE: &str = "forwardNativeFees((address,uint256)[])";

fn distributed(args: &[u8], slot: usize) -> Option<u128> {
    let at = abi::offset(args, slot * 32, 0)?;
    let count = usize::try_from(abi::uint(args, at)?).ok()?;
    if count > (args.len() - at) / 64 {
        return None;
    }
    (0..count).try_fold(0u128, |sum, index| {
        let item = at + 32 + index * 64;
        abi::address(args, item)?;
        sum.checked_add(abi::uint(args, item + 32)?)
    })
}

fn forwarded_fee(step: &LifiStep, token: [u8; 20]) -> Option<u128> {
    if step.sending != token {
        return None;
    }
    let head = step.call_data.get(..4)?;
    let args = &step.call_data[4..];
    let native = token == [0u8; 20];
    if head == abi::selector(FORWARD_NATIVE) && native {
        return distributed(args, 0);
    }
    if head == abi::selector(FORWARD_ERC20) && !native && abi::address(args, 0)? == token {
        return distributed(args, 1);
    }
    None
}

fn unlisted(what: &str, address: &[u8; 20]) -> String {
    format!(
        "the LI.FI swap step {what} 0x{}, which is not a listed LI.FI step target",
        hex::encode(address)
    )
}

pub fn step_refusal(chain: u64, steps: &[LifiStep], charge: ([u8; 20], u128)) -> Option<String> {
    let Some(table) = STEP_TARGETS.iter().find(|table| table.chain == chain) else {
        return Some(format!("chain {chain} lists no LI.FI swap step targets"));
    };
    let is = |address: &[u8; 20], listed: &str| hex::encode(address) == listed;
    let listed = |address: &[u8; 20]| table.targets.iter().any(|target| is(address, target));
    let spender = |address: &[u8; 20]| table.spenders.iter().any(|item| is(address, item));
    let (token, amount) = charge;
    let mut fees = 0u128;
    for step in steps {
        if is(&step.call_to, table.fee_forwarder) {
            if !is(&step.approve_to, table.fee_forwarder) {
                return Some(unlisted("approves", &step.approve_to));
            }
            let Some(fee) = forwarded_fee(step, token).and_then(|fee| fees.checked_add(fee)) else {
                return Some("the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token the swap deposits".into());
            };
            fees = fee;
            continue;
        }
        if !listed(&step.call_to) {
            return Some(unlisted("calls", &step.call_to));
        }
        if !listed(&step.approve_to) && !spender(&step.approve_to) {
            return Some(unlisted("approves", &step.approve_to));
        }
    }
    if fees
        .checked_mul(10_000 / MAX_LIFI_FEE_BPS)
        .is_none_or(|scaled| scaled > amount)
    {
        return Some(format!(
            "the LI.FI fee steps forward {fees}, above {MAX_LIFI_FEE_BPS} bps of the {amount} the swap deposits"
        ));
    }
    None
}
