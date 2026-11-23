use crate::abi::{self, LifiStep};

pub const MAX_LIFI_FEE_BPS: u128 = 50;

pub struct StepTable {
    pub chain: u64,
    pub fee_forwarder: &'static str,
    pub targets: &'static [&'static str],
}

pub const STEP_TARGETS: &[StepTable] = &[
    StepTable {
        chain: 324,
        fee_forwarder: "24a72dd17de0f92da5460c46cc2948e3a5cb755d",
        targets: &[
            "6fd4383cb451173d5f9304f041c7bcbf27d561ff",
            "35e98c2b3894d71d3d4d7edb8b30e4f36e2f9179",
            "46edecea0228f04ab88dc34be98314863ba40be0",
            "c67879f4065d3b9fe1c09ee990b891aa8e3a4c2f",
            "f15485ada1a1826fa46225032b13f6a972ec73c1",
        ],
    },
    StepTable {
        chain: 8453,
        fee_forwarder: "de2b920506ee931a6a2abdf566526220214fbbae",
        targets: &[
            "111111125421ca6dc452d289314280a0f8842a65",
            "ac4c6e212a361c968f1725b4d055b47e63f80b75",
            "c87de04e2ec1f4282dff2933a2d58199f688fc3d",
            "6131b5fae19ea4f9d964eac0408e4408b66337b5",
            "20f6ee51340adeed01a59b0e65cb3703f3dc860c",
            "5215e9fd223bc909083fbdb2860213873046e45d",
        ],
    },
    StepTable {
        chain: 42161,
        fee_forwarder: "de2b920506ee931a6a2abdf566526220214fbbae",
        targets: &[
            "ac4c6e212a361c968f1725b4d055b47e63f80b75",
            "57f96440f1b1cad53b40a8924bd540b1279a491c",
            "09f94b5fc68e227c323a6fbae3bd98c97fd8c849",
            "70cbb871e8f30fc8ce23609e9e0ea87b6b222f58",
            "6a000f20005980200259b80c5102003040001068",
            "111111125421ca6dc452d289314280a0f8842a65",
            "6131b5fae19ea4f9d964eac0408e4408b66337b5",
            "20f6ee51340adeed01a59b0e65cb3703f3dc860c",
            "5215e9fd223bc909083fbdb2860213873046e45d",
        ],
    },
];

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

fn forwarded_fee(step: &LifiStep) -> Option<u128> {
    let head = step.call_data.get(..4)?;
    let args = &step.call_data[4..];
    let native = step.sending == [0u8; 20];
    if head == abi::selector(FORWARD_NATIVE) && native {
        return distributed(args, 0);
    }
    if head == abi::selector(FORWARD_ERC20) && !native && abi::address(args, 0)? == step.sending {
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

fn refusal(table: &StepTable, step: &LifiStep) -> Option<String> {
    let is = |address: &[u8; 20], listed: &str| hex::encode(address) == listed;
    if is(&step.call_to, table.fee_forwarder) {
        if !is(&step.approve_to, table.fee_forwarder) {
            return Some(unlisted("approves", &step.approve_to));
        }
        let Some(fee) = forwarded_fee(step) else {
            return Some(
                "the LI.FI fee step is not a forwardERC20Fees or forwardNativeFees of the token it sells"
                    .into(),
            );
        };
        if fee
            .checked_mul(10_000 / MAX_LIFI_FEE_BPS)
            .is_none_or(|scaled| scaled > step.amount)
        {
            return Some(format!(
                "the LI.FI fee step forwards {fee}, above {MAX_LIFI_FEE_BPS} bps of {}",
                step.amount
            ));
        }
        return None;
    }
    let listed = |address: &[u8; 20]| table.targets.iter().any(|target| is(address, target));
    if !listed(&step.call_to) {
        return Some(unlisted("calls", &step.call_to));
    }
    if !listed(&step.approve_to) {
        return Some(unlisted("approves", &step.approve_to));
    }
    None
}

pub fn step_refusal(chain: u64, steps: &[LifiStep]) -> Option<String> {
    let Some(table) = STEP_TARGETS.iter().find(|table| table.chain == chain) else {
        return Some(format!("chain {chain} lists no LI.FI swap step targets"));
    };
    steps.iter().find_map(|step| refusal(table, step))
}
