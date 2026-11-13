pub enum Item {
    Bytes(Vec<u8>),
    List(Vec<Item>),
}

pub fn uint(value: u128) -> Item {
    let bytes = value.to_be_bytes();
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len());
    Item::Bytes(bytes[first..].to_vec())
}

fn length_prefix(offset: u8, length: usize) -> Vec<u8> {
    if length < 56 {
        return vec![offset + length as u8];
    }
    let bytes = length.to_be_bytes();
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len() - 1);
    let mut out = vec![offset + 55 + (bytes.len() - first) as u8];
    out.extend_from_slice(&bytes[first..]);
    out
}

pub fn encode(item: &Item) -> Vec<u8> {
    match item {
        Item::Bytes(bytes) if bytes.len() == 1 && bytes[0] < 0x80 => bytes.clone(),
        Item::Bytes(bytes) => {
            let mut out = length_prefix(0x80, bytes.len());
            out.extend_from_slice(bytes);
            out
        }
        Item::List(items) => {
            let body: Vec<u8> = items.iter().flat_map(encode).collect();
            let mut out = length_prefix(0xc0, body.len());
            out.extend_from_slice(&body);
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_yellow_paper_examples() {
        assert_eq!(
            encode(&Item::Bytes(b"dog".to_vec())),
            vec![0x83, b'd', b'o', b'g']
        );
        assert_eq!(
            encode(&Item::List(vec![
                Item::Bytes(b"cat".to_vec()),
                Item::Bytes(b"dog".to_vec())
            ])),
            hex::decode("c88363617483646f67").unwrap()
        );
        assert_eq!(encode(&uint(0)), vec![0x80]);
        assert_eq!(encode(&uint(15)), vec![0x0f]);
        assert_eq!(encode(&uint(1024)), vec![0x82, 0x04, 0x00]);
        assert_eq!(encode(&Item::List(vec![])), vec![0xc0]);
        let long = vec![b'a'; 60];
        assert_eq!(&encode(&Item::Bytes(long))[..2], &[0xb8, 60]);
    }
}
