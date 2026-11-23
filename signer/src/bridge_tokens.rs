pub struct BridgeToken {
    pub symbol: &'static str,
    pub chain: u64,
    pub address: &'static str,
    pub decimals: u32,
}

const fn token(
    symbol: &'static str,
    chain: u64,
    address: &'static str,
    decimals: u32,
) -> BridgeToken {
    BridgeToken {
        symbol,
        chain,
        address,
        decimals,
    }
}

pub const BRIDGE_TOKENS: &[BridgeToken] = &[
    token("USDC", 1, "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6),
    token("USDC", 10, "0b2c639c533813f4aa9d7837caf62653d097ff85", 6),
    token("USDC", 137, "3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6),
    token("USDC", 8453, "833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6),
    token("USDC", 42161, "af88d065e77c8cc2239327c5edb3a432268e5831", 6),
    token("USDT", 1, "dac17f958d2ee523a2206206994597c13d831ec7", 6),
    token("USDT", 10, "94b008aa00579c1307b0ef2c499ad98a8ce58e58", 6),
    token("USDT", 137, "c2132d05d31c914a87c6611c10748aeb04b58e8f", 6),
    token("USDT", 8453, "fde4c96c8593536e31f229ea8f37b2ada2699bb2", 6),
    token("USDT", 42161, "fd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6),
    token("WETH", 1, "c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18),
    token("WETH", 10, "4200000000000000000000000000000000000006", 18),
    token("WETH", 137, "7ceb23fd6bc0add59e62ac25578270cff1b9f619", 18),
    token("WETH", 8453, "4200000000000000000000000000000000000006", 18),
    token(
        "WETH",
        42161,
        "82af49447d8a07e3bd95bd0d56f35241523fbab1",
        18,
    ),
];

fn find(chain: u64, address: [u8; 20]) -> Option<&'static BridgeToken> {
    let text = hex::encode(address);
    BRIDGE_TOKENS
        .iter()
        .find(|item| item.chain == chain && item.address == text)
}

pub fn pair(
    source: u64,
    input: [u8; 20],
    destination: u64,
    output: [u8; 20],
) -> Option<(&'static BridgeToken, &'static BridgeToken)> {
    let sent = find(source, input)?;
    let delivered = find(destination, output)?;
    (sent.symbol == delivered.symbol).then_some((sent, delivered))
}

pub fn meets_floor(
    sent: &BridgeToken,
    delivered: &BridgeToken,
    charged: u128,
    min_output: u128,
    max_fee_bps: u128,
) -> Option<bool> {
    let common = sent.decimals.max(delivered.decimals);
    let received = min_output
        .checked_mul(10u128.checked_pow(common - delivered.decimals)?)?
        .checked_mul(10_000)?;
    let floor = charged
        .checked_mul(10u128.checked_pow(common - sent.decimals)?)?
        .checked_mul(10_000u128.checked_sub(max_fee_bps)?)?;
    Some(received >= floor)
}

const PAR: u128 = 1_000_000_000_000_000_000;

pub fn within_par(sent: &BridgeToken, delivered: &BridgeToken, multiplier: u128) -> Option<bool> {
    let scaled = multiplier.checked_mul(10u128.checked_pow(sent.decimals)?)?;
    let par = PAR.checked_mul(10u128.checked_pow(delivered.decimals)?)?;
    Some(scaled <= par)
}
