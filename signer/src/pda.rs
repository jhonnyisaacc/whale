use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha256};

pub fn find_program_address(seeds: &[&[u8]], program: &[u8; 32]) -> Option<[u8; 32]> {
    for bump in (0..=255u8).rev() {
        let mut hasher = Sha256::new();
        for seed in seeds {
            hasher.update(seed);
        }
        hasher.update([bump]);
        hasher.update(program);
        hasher.update(b"ProgramDerivedAddress");
        let hash: [u8; 32] = hasher.finalize().into();
        if CompressedEdwardsY(hash).decompress().is_none() {
            return Some(hash);
        }
    }
    None
}

pub fn associated_token_address(
    owner: &[u8; 32],
    mint: &[u8; 32],
    token_program: &[u8; 32],
    ata_program: &[u8; 32],
) -> Option<[u8; 32]> {
    find_program_address(&[owner, token_program, mint], ata_program)
}
