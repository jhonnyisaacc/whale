use std::path::PathBuf;
use std::process::{Command, Output};

fn init(keystore: &PathBuf) -> Output {
    Command::new(env!("CARGO_BIN_EXE_whale-signer"))
        .args(["init", "--keystore"])
        .arg(keystore)
        .env("WHALE_SIGNER_PASSPHRASE", "correct horse battery")
        .output()
        .expect("run whale-signer")
}

#[cfg(unix)]
#[test]
fn init_creates_a_keystore_only_its_owner_can_read_and_never_overwrites_one() {
    use std::os::unix::fs::PermissionsExt;
    let keystore = std::env::temp_dir().join(format!(
        "whale-signer-{}-init.keystore.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&keystore);
    let first = init(&keystore);
    assert!(first.status.success(), "{first:?}");
    assert!(first.stderr.is_empty(), "{first:?}");
    let mode = std::fs::metadata(&keystore).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "the keystore mode is {mode:o}");
    let written = std::fs::read(&keystore).unwrap();
    let second = init(&keystore);
    assert_eq!(second.status.code(), Some(2), "{second:?}");
    assert!(String::from_utf8_lossy(&second.stderr).contains("already exists"));
    assert_eq!(std::fs::read(&keystore).unwrap(), written);
    let _ = std::fs::remove_file(&keystore);
}

#[cfg(not(unix))]
#[test]
fn init_warns_that_the_keystore_inherits_its_directory_permissions() {
    let keystore = std::env::temp_dir().join(format!(
        "whale-signer-{}-init-warning.keystore.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&keystore);
    let output = init(&keystore);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim_end(),
        "warning: this platform has no Unix file modes, so the keystore inherits the permissions of its directory"
    );
    let _ = std::fs::remove_file(&keystore);
}
