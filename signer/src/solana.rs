// Solana messages, legacy and v0. The signer signs the exact message bytes it parsed, as the only required signer.
pub struct Instruction {
    pub program: usize,
    pub accounts: Vec<usize>,
    pub data: Vec<u8>,
}

pub struct Message {
    pub required_signatures: u8,
    pub keys: Vec<[u8; 32]>,
    pub instructions: Vec<Instruction>,
    pub has_lookups: bool,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(count)
            .ok_or("message length overflow")?;
        let slice = self.bytes.get(self.at..end).ok_or("message is truncated")?;
        self.at = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    // compact-u16: up to three bytes, seven bits each.
    fn short(&mut self) -> Result<usize, String> {
        let mut value = 0usize;
        for shift in [0, 7, 14] {
            let byte = self.byte()?;
            value |= usize::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("compact length is too long".into())
    }
}

pub fn parse(bytes: &[u8]) -> Result<Message, String> {
    let mut reader = Reader { bytes, at: 0 };
    let first = *bytes.first().ok_or("empty message")?;
    let versioned = first & 0x80 != 0;
    if versioned {
        if first & 0x7f != 0 {
            return Err("only legacy and v0 messages are signed".into());
        }
        reader.byte()?;
    }
    let required_signatures = reader.byte()?;
    reader.take(2)?;
    let key_count = reader.short()?;
    let keys = (0..key_count)
        .map(|_| {
            reader
                .take(32)
                .map(|slice| slice.try_into().expect("32 bytes"))
        })
        .collect::<Result<Vec<[u8; 32]>, String>>()?;
    reader.take(32)?;
    let instruction_count = reader.short()?;
    let mut instructions = Vec::with_capacity(instruction_count);
    for _ in 0..instruction_count {
        let program = usize::from(reader.byte()?);
        let account_count = reader.short()?;
        let accounts = (0..account_count)
            .map(|_| reader.byte().map(usize::from))
            .collect::<Result<Vec<_>, _>>()?;
        let data_length = reader.short()?;
        instructions.push(Instruction {
            program,
            accounts,
            data: reader.take(data_length)?.to_vec(),
        });
    }
    let mut has_lookups = false;
    if versioned {
        let lookups = reader.short()?;
        has_lookups = lookups > 0;
        for _ in 0..lookups {
            reader.take(32)?;
            let writable = reader.short()?;
            reader.take(writable)?;
            let readonly = reader.short()?;
            reader.take(readonly)?;
        }
    }
    if reader.at != bytes.len() {
        return Err("message has trailing bytes".into());
    }
    Ok(Message {
        required_signatures,
        keys,
        instructions,
        has_lookups,
    })
}

pub fn key(text: &str) -> Result<[u8; 32], String> {
    let bytes = bs58::decode(text)
        .into_vec()
        .map_err(|_| format!("{text} is not base58"))?;
    bytes
        .try_into()
        .map_err(|_| format!("{text} is not a 32-byte key"))
}

pub fn sign(message: &[u8], key: &ed25519_dalek::SigningKey) -> [u8; 64] {
    use ed25519_dalek::Signer;
    key.sign(message).to_bytes()
}
