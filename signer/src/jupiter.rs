use crate::jupiter_swaps::SWAPS;
use crate::pda::associated_token_address;
use crate::solana;

pub enum Part {
    Fixed(usize),
    Optional(&'static [Part]),
    List(&'static [Part]),
}

pub const PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";

const SHARED_ACCOUNTS_ROUTE: &str = "c1209b3341d69c81";
const INSTRUCTIONS: [(&str, &str); 21] = [
    ("3ec6d6c1d59f6cd2", "claim"),
    ("74ce1bbfa6130049", "claim_token"),
    ("1a4aec976840b7f9", "close_token"),
    ("927c0e00b5717293", "withdraw_token_account_excess_lamports"),
    (
        "5368c096b4479cc6",
        "create_idempotent_associated_token_account",
    ),
    ("e8f2c5fdf08f8134", "create_token_ledger"),
    ("93f17b64f484ae76", "create_token_account"),
    ("cb816785c57d6b56", "close_wsol_token_account"),
    ("d033ef977b2bed5c", "exact_out_route"),
    ("e517cb977ae3ad2a", "route"),
    ("96564774a75d0e68", "route_with_token_ledger"),
    ("e455b9704e4f4d02", "set_token_ledger"),
    ("b0d169a89a7d453e", "shared_accounts_exact_out_route"),
    (SHARED_ACCOUNTS_ROUTE, "shared_accounts_route"),
    (
        "e6798f50779f6aaa",
        "shared_accounts_route_with_token_ledger",
    ),
    ("9d8ab85215f4f324", "exact_out_route_v2"),
    ("bb64facc31c4af14", "route_v2"),
    ("3560e5cad8bbfa18", "shared_accounts_exact_out_route_v2"),
    ("d19853937cfed8e9", "shared_accounts_route_v2"),
    ("a0752c34dc4d5140", "route_with_attestation"),
    ("252ef97ec9a238ca", "shared_accounts_route_with_attestation"),
];

const AUTHORITY: usize = 2;
const SOURCE: usize = 3;
const DESTINATION: usize = 6;
const PLATFORM_FEE: usize = 9;

fn known(text: &str) -> [u8; 32] {
    solana::key(text).expect("a built-in key is valid base58")
}

fn text(key: &[u8; 32]) -> String {
    bs58::encode(key).into_string()
}

struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let slice = self
            .at
            .checked_add(count)
            .and_then(|end| self.data.get(self.at..end))
            .ok_or("the Jupiter route arguments are truncated")?;
        self.at += count;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn length(&mut self) -> Result<usize, String> {
        let count = u32::from_le_bytes(self.take(4)?.try_into().expect("4 bytes")) as usize;
        if count > self.data.len() - self.at {
            return Err("the Jupiter route arguments are truncated".into());
        }
        Ok(count)
    }

    fn skip(&mut self, parts: &[Part]) -> Result<(), String> {
        for part in parts {
            match part {
                Part::Fixed(size) => {
                    self.take(*size)?;
                }
                Part::Optional(inner) => match self.byte()? {
                    0 => {}
                    1 => self.skip(inner)?,
                    _ => return Err("a Jupiter swap option tag is not 0 or 1".into()),
                },
                Part::List(inner) => {
                    for _ in 0..self.length()? {
                        self.skip(inner)?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn sold_amount(data: &[u8]) -> Result<u64, String> {
    let mut cursor = Cursor { data, at: 9 };
    for _ in 0..cursor.length()? {
        let tag = cursor.byte()?;
        let (name, parts) = SWAPS
            .get(usize::from(tag))
            .ok_or_else(|| format!("Jupiter swap variant {tag} is not in the pinned IDL"))?;
        let parts =
            parts.ok_or_else(|| format!("the signer cannot size the Jupiter swap {name}"))?;
        cursor.skip(parts)?;
        cursor.take(3)?;
    }
    let in_amount = u64::from_le_bytes(cursor.take(8)?.try_into().expect("8 bytes"));
    cursor.take(8 + 2 + 1)?;
    if cursor.at != data.len() {
        return Err("the Jupiter route has bytes after its arguments".into());
    }
    Ok(in_amount)
}

pub struct Swap<'a> {
    pub data: &'a [u8],
    pub accounts: &'a [usize],
    pub keys: &'a [[u8; 32]],
    pub own: [u8; 32],
    pub buy_mint: Option<[u8; 32]>,
    pub limited_mints: &'a [[u8; 32]],
}

pub fn shared_accounts_route(swap: &Swap) -> Result<(String, u128), String> {
    let discriminator = hex::encode(
        swap.data
            .get(..8)
            .ok_or("jupiter instruction is too short")?,
    );
    if discriminator != SHARED_ACCOUNTS_ROUTE {
        let name = INSTRUCTIONS
            .iter()
            .find(|(known, _)| *known == discriminator)
            .map_or(format!("instruction {discriminator}"), |(_, name)| {
                name.to_string()
            });
        return Err(format!(
            "only Jupiter shared_accounts_route is signed, not {name}"
        ));
    }
    let own = swap.own;
    for (slot, index) in swap.accounts.iter().enumerate() {
        if slot != AUTHORITY && (*index == 0 || swap.keys.get(*index) == Some(&own)) {
            return Err(format!(
                "jupiter account {slot} is this wallet, which only the transfer authority may name"
            ));
        }
    }
    let read = |slot: usize| {
        let index = swap
            .accounts
            .get(slot)
            .ok_or_else(|| format!("the Jupiter instruction has no account {slot}"))?;
        swap.keys.get(*index).copied().ok_or_else(|| {
            format!("jupiter account {slot} comes from a lookup table, so it cannot be checked")
        })
    };
    if read(AUTHORITY)? != own {
        return Err("the Jupiter transfer authority is not this wallet".into());
    }
    if read(PLATFORM_FEE)? != known(PROGRAM) {
        return Err("the Jupiter platform fee account is set".into());
    }
    let owned = |mint: &[u8; 32], program: &str| {
        associated_token_address(&own, mint, &known(program), &known(ASSOCIATED_TOKEN))
    };
    let buy_mint = swap
        .buy_mint
        .ok_or("the job names no buyMint, so the Jupiter destination cannot be checked")?;
    let destination = read(DESTINATION)?;
    if Some(destination) == owned(&buy_mint, TOKEN_2022) {
        return Err(format!(
            "the Jupiter swap buys {} under Token-2022, which the signer refuses for now",
            text(&buy_mint)
        ));
    }
    if Some(destination) != owned(&buy_mint, TOKEN) {
        return Err(format!(
            "the Jupiter swap pays {}, which is not this wallet's token account for buyMint {}",
            text(&destination),
            text(&buy_mint)
        ));
    }
    let source = read(SOURCE)?;
    let key = if Some(source) == owned(&known(WSOL_MINT), TOKEN) {
        "solana:native".to_string()
    } else {
        swap.limited_mints
            .iter()
            .find(|mint| owned(mint, TOKEN) == Some(source))
            .map(|mint| format!("solana:{}", text(mint)))
            .ok_or("the Jupiter swap sells from a token account that is not this wallet's account for a mint with a daily limit")?
    };
    Ok((key, u128::from(sold_amount(swap.data)?)))
}

#[cfg(test)]
mod tests {
    const LANDED_SHARED_ROUTES: [(&str, &str, u64); 2] = [
        (
            "4uaENdpeZfkm47QLu9dsDrQGfATLCf8GHLn6Mr9bEgMeQ3ZYicUUZRY33nr7g3FpHyEin3DargWLS6Etv3gQkZEB",
            "c1209b3341d69c8101010000002f0000640001ff07cc54000000007043b017000000000a0000",
            1_422_657_535,
        ),
        (
            "3pvXdwgLmRzZxWVx3ijAUzS3if1gv1okR64GBuuxWVadZZWb8o1181gicLAwQrRjuovbaaEZo1tYdn84HTjrdiu9",
            "c1209b3341d69c810102000000c36400011a6401022ebf340300000000ecd61d0000000000320000",
            53_788_462,
        ),
    ];

    #[test]
    fn landed_shared_routes_decode_to_what_their_source_account_lost() {
        for (signature, data, lost) in LANDED_SHARED_ROUTES {
            let data = hex::decode(data).expect("hex");
            assert_eq!(super::sold_amount(&data), Ok(lost), "{signature}");
        }
    }
}
