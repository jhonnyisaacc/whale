mod support;

use support::*;
use whale_signer::{policy::Policy, solana};

#[test]
fn a_message_the_runtime_would_reject_does_not_parse() {
    let base = edited(|_| {});
    let key_count = base[4];
    assert!(key_count < 0x80, "the fixture's key count fits one byte");
    let with_key_count = |encoding: &[u8]| {
        let mut out = base[..4].to_vec();
        out.extend(encoding);
        out.extend(&base[5..]);
        out
    };
    let mut trailing = base.clone();
    trailing.push(0);
    let mut version_one = base.clone();
    version_one[0] = 0x81;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "an account index past the loaded accounts",
            edited(|message| message.jupiter().0[20] = 250),
            "names account 250, but the message loads only",
        ),
        (
            "a program index past the loaded accounts",
            edited(|message| message.instructions[0].0 = 250),
            "instruction 0 names account 250",
        ),
        (
            "a non-canonical compact length",
            with_key_count(&[key_count | 0x80, 0]),
            "compact length is not canonical",
        ),
        (
            "a compact length above u16",
            with_key_count(&[0x80, 0x80, 0x04]),
            "compact length is above u16",
        ),
        (
            "a four-byte compact length",
            with_key_count(&[0x80, 0x80, 0x80, 0x01]),
            "compact length is above u16",
        ),
        (
            "trailing bytes after the lookups",
            trailing,
            "message has trailing bytes",
        ),
        (
            "a version 1 message",
            version_one,
            "only legacy and v0 messages are signed",
        ),
    ];
    for (name, message, reason) in cases {
        let error = solana::parse(&message).err();
        assert!(
            error.as_deref().is_some_and(|error| error.contains(reason)),
            "{name}: expected '{reason}', got {error:?}"
        );
        refused_with(&policy(), name, &message, Some(BONK), reason);
    }
}

#[test]
fn a_listed_program_without_an_instruction_rule_is_refused() {
    let mut file = policy_file();
    file["solana"]["programs"]
        .as_array_mut()
        .unwrap()
        .push("Stake11111111111111111111111111111111111111".into());
    let stake = edited(|message| {
        let jupiter = message
            .keys
            .iter()
            .position(|key| *key == solana::key(JUPITER).unwrap())
            .unwrap();
        message.keys[jupiter] = key("Stake11111111111111111111111111111111111111");
    });
    refused_with(
        &Policy::parse(&file).unwrap(),
        "a stake instruction",
        &stake,
        Some(BONK),
        "the signer has no instruction rule for Stake11111111111111111111111111111111111111",
    );
}
