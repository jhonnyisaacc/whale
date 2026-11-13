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
const QUOTE_MINTS: [&str; 3] = [
    WSOL_MINT,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
];

struct Route {
    discriminator: [u8; 8],
    shared: bool,
    authority: usize,
    source: usize,
    destinations: &'static [usize],
    mint: usize,
    fee: usize,
}

const ROUTES: [Route; 2] = [
    Route {
        discriminator: [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a],
        shared: false,
        authority: 1,
        source: 2,
        destinations: &[3, 4],
        mint: 5,
        fee: 6,
    },
    Route {
        discriminator: [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81],
        shared: true,
        authority: 2,
        source: 3,
        destinations: &[6],
        mint: 8,
        fee: 9,
    },
];

fn known(text: &str) -> [u8; 32] {
    solana::key(text).expect("a built-in key is valid base58")
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

fn sold_amount(data: &[u8], shared: bool) -> Result<u64, String> {
    let mut cursor = Cursor { data, at: 8 };
    if shared {
        cursor.take(1)?;
    }
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

pub fn route(
    data: &[u8],
    accounts: usize,
    account: &dyn Fn(usize) -> Option<[u8; 32]>,
    own: [u8; 32],
    limited_mints: &[[u8; 32]],
) -> Result<(String, u128), String> {
    let jupiter = known(PROGRAM);
    let discriminator = data.get(..8).ok_or("jupiter instruction is too short")?;
    let route = ROUTES
        .iter()
        .find(|route| route.discriminator.as_slice() == discriminator)
        .ok_or("this Jupiter instruction is not an exact-in route that names its sold amount")?;
    let read = |slot: usize| {
        account(slot).ok_or_else(|| {
            if slot >= accounts {
                format!("the Jupiter instruction has no account {slot}")
            } else {
                format!("jupiter account {slot} comes from a lookup table, so it cannot be checked")
            }
        })
    };
    if read(route.authority)? != own {
        return Err("the Jupiter transfer authority is not this wallet".into());
    }
    if read(route.fee)? != jupiter {
        return Err("the Jupiter platform fee account is set".into());
    }
    let ata = known(ASSOCIATED_TOKEN);
    let owned = |mint: &[u8; 32], programs: &[&str]| {
        programs
            .iter()
            .filter_map(|program| associated_token_address(&own, mint, &known(program), &ata))
            .collect::<Vec<_>>()
    };
    let wrapped_sol = owned(&known(WSOL_MINT), &[TOKEN]);
    let mints = match account(route.mint) {
        Some(mint) => vec![mint],
        None => QUOTE_MINTS.map(known).to_vec(),
    };
    let mut destinations = wrapped_sol.clone();
    for mint in &mints {
        destinations.extend(owned(mint, &[TOKEN, TOKEN_2022]));
    }
    for (position, slot) in route.destinations.iter().enumerate() {
        let destination = read(*slot)?;
        if position > 0 && destination == jupiter {
            continue;
        }
        if !destinations.contains(&destination) {
            return Err("the Jupiter swap pays a token account that is not this wallet's".into());
        }
    }
    let source = read(route.source)?;
    let key = if wrapped_sol.contains(&source) {
        "solana:native".to_string()
    } else {
        limited_mints
            .iter()
            .find(|mint| owned(mint, &[TOKEN, TOKEN_2022]).contains(&source))
            .map(|mint| format!("solana:{}", bs58::encode(mint).into_string()))
            .ok_or("the Jupiter swap sells from a token account that is not this wallet's account for a mint with a daily limit")?
    };
    Ok((key, u128::from(sold_amount(data, route.shared)?)))
}
