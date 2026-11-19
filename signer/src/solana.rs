pub struct Instruction {
    pub program: usize,
    pub accounts: Vec<usize>,
    pub data: Vec<u8>,
}

pub struct Message {
    pub required_signatures: u8,
    pub keys: Vec<[u8; 32]>,
    pub instructions: Vec<Instruction>,
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

    fn short(&mut self) -> Result<usize, String> {
        let mut value = 0usize;
        for shift in [0, 7, 14] {
            let byte = self.byte()?;
            if shift > 0 && byte == 0 {
                return Err("compact length is not canonical".into());
            }
            value |= usize::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return u16::try_from(value)
                    .map(usize::from)
                    .map_err(|_| "compact length is above u16".into());
            }
        }
        Err("compact length is above u16".into())
    }

    fn count(&mut self, item_size: usize) -> Result<usize, String> {
        let count = self.short()?;
        if count.saturating_mul(item_size) > self.bytes.len() - self.at {
            return Err("message is truncated".into());
        }
        Ok(count)
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
    let key_count = reader.count(32)?;
    let keys = (0..key_count)
        .map(|_| {
            reader
                .take(32)
                .map(|slice| slice.try_into().expect("32 bytes"))
        })
        .collect::<Result<Vec<[u8; 32]>, String>>()?;
    reader.take(32)?;
    let instruction_count = reader.count(3)?;
    let mut instructions = Vec::with_capacity(instruction_count);
    for _ in 0..instruction_count {
        let program = usize::from(reader.byte()?);
        let account_count = reader.count(1)?;
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
    let mut loaded = keys.len();
    if versioned {
        for _ in 0..reader.short()? {
            reader.take(32)?;
            for _ in 0..2 {
                let count = reader.short()?;
                reader.take(count)?;
                loaded += count;
            }
        }
    }
    if reader.at != bytes.len() {
        return Err("message has trailing bytes".into());
    }
    for (position, instruction) in instructions.iter().enumerate() {
        if let Some(index) = std::iter::once(&instruction.program)
            .chain(&instruction.accounts)
            .find(|index| **index >= loaded)
        {
            return Err(format!(
                "instruction {position} names account {index}, but the message loads only {loaded}"
            ));
        }
    }
    Ok(Message {
        required_signatures,
        keys,
        instructions,
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

pub fn verify(message: &[u8], public: &[u8; 32], signature: &[u8; 64]) -> Result<(), String> {
    let refused = |_| "solana signature failed verify_strict against the signing key".to_string();
    ed25519_dalek::VerifyingKey::from_bytes(public)
        .map_err(refused)?
        .verify_strict(message, &ed25519_dalek::Signature::from_bytes(signature))
        .map_err(refused)
}

pub fn sign(message: &[u8], key: &ed25519_dalek::SigningKey) -> Result<[u8; 64], String> {
    use ed25519_dalek::Signer;
    let signature = key.sign(message).to_bytes();
    verify(message, &key.verifying_key().to_bytes(), &signature)?;
    Ok(signature)
}
