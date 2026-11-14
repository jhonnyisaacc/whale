use serde_json::Value;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use whale_signer::{evm, keystore, ledger, net, policy, run_job, solana};

const USAGE: &str =
    "whale-signer <init|address|sign> --keystore FILE [--policy FILE] [--ledger FILE]
  init     create a new encrypted keystore (passphrase from WHALE_SIGNER_PASSPHRASE)
  address  print the EVM and Solana addresses
  sign     read one job as JSON on stdin, check it against the policy, and sign it or refuse";

#[cfg(not(unix))]
const NON_UNIX_KEYSTORE_WARNING: &str = "warning: this platform has no Unix file modes, so the keystore inherits the permissions of its directory";

fn flag(args: &[String], name: &str) -> Option<PathBuf> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| PathBuf::from(&pair[1]))
}

fn read_json(path: &PathBuf) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|_| format!("{} is not JSON", path.display()))
}

fn text_flag(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn token_file(args: &[String], keystore_path: &std::path::Path) -> PathBuf {
    flag(args, "--token-file").unwrap_or_else(|| keystore_path.with_extension("token"))
}

fn write_private(path: &PathBuf, contents: &str) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    if std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.file_type().is_file())
    {
        return Err(format!("{} is not a regular token file", path.display()));
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(path)
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    #[cfg(unix)]
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("cannot protect {}: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", path.display()))
}

fn passphrase() -> Result<String, String> {
    std::env::var("WHALE_SIGNER_PASSPHRASE").map_err(|_| "set WHALE_SIGNER_PASSPHRASE".to_string())
}

fn create_private(path: &PathBuf) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => format!(
            "{} already exists; refusing to overwrite a keystore",
            path.display()
        ),
        _ => format!("cannot create the keystore: {error}"),
    })
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let command = args.get(1).map(String::as_str).ok_or(USAGE)?;
    let keystore_path = flag(args, "--keystore").ok_or(USAGE)?;
    match command {
        "init" => {
            #[cfg(not(unix))]
            eprintln!("{NON_UNIX_KEYSTORE_WARNING}");
            let keys = keystore::generate()?;
            let sealed = keystore::seal(&keys, &passphrase()?)?;
            create_private(&keystore_path)?
                .write_all(sealed.to_string().as_bytes())
                .map_err(|error| format!("cannot write the keystore: {error}"))?;
            println!(
                "{}",
                serde_json::json!({ "evmAddress": sealed["evmAddress"], "solanaAddress": sealed["solanaAddress"] })
            );
            Ok(ExitCode::SUCCESS)
        }
        "address" => {
            let file = read_json(&keystore_path)?;
            println!(
                "{}",
                serde_json::json!({ "evmAddress": file["evmAddress"], "solanaAddress": file["solanaAddress"] })
            );
            Ok(ExitCode::SUCCESS)
        }
        "sign" => {
            let policy = policy::Policy::parse(&read_json(
                &flag(args, "--policy").ok_or("sign needs --policy")?,
            )?)?;
            let ledger_path = flag(args, "--ledger").ok_or("sign needs --ledger")?;
            let keys = keystore::open(&read_json(&keystore_path)?, &passphrase()?)?;
            let mut input = String::new();
            std::io::stdin()
                .read_to_string(&mut input)
                .map_err(|error| format!("cannot read stdin: {error}"))?;
            let job: Value = serde_json::from_str(&input).map_err(|_| "the job is not JSON")?;
            let outcome = run_job(&job, &policy, &keys, &ledger_path, &ledger::today());
            println!("{outcome}");
            Ok(if outcome["decision"] == "signed" {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(3)
            })
        }
        "connect" => {
            let gateway = net::Gateway::new(&text_flag(args, "--gateway").ok_or(USAGE)?)?;
            let wallet = text_flag(args, "--wallet").ok_or(USAGE)?;
            let code = text_flag(args, "--code").ok_or(USAGE)?;
            let keys = keystore::open(&read_json(&keystore_path)?, &passphrase()?)?;
            let message = net::registration_message(&wallet, &code);
            let body = serde_json::json!({
                "code": code,
                "walletId": wallet,
                "evmAddress": keystore::evm_address(&keys.evm),
                "solanaAddress": keystore::solana_address(&keys.solana),
                "evmSignature": evm::personal_sign(&message, &keys.evm),
                "solanaSignature": bs58::encode(solana::sign(message.as_bytes(), &keys.solana)).into_string(),
            });
            let registered = gateway.register(&body)?;
            let token = registered["token"]
                .as_str()
                .ok_or("the gateway returned no token")?;
            let path = token_file(args, &keystore_path);
            write_private(&path, token)?;
            println!(
                "{}",
                serde_json::json!({ "signerId": registered["signerId"], "tokenFile": path.display().to_string() })
            );
            Ok(ExitCode::SUCCESS)
        }
        "serve" => {
            let gateway = net::Gateway::new(&text_flag(args, "--gateway").ok_or(USAGE)?)?;
            let policy = policy::Policy::parse(&read_json(
                &flag(args, "--policy").ok_or("serve needs --policy")?,
            )?)?;
            let ledger_path = flag(args, "--ledger").ok_or("serve needs --ledger")?;
            let token = std::fs::read_to_string(token_file(args, &keystore_path))
                .map_err(|_| "no token file; run connect first")?;
            let keys = keystore::open(&read_json(&keystore_path)?, &passphrase()?)?;
            let once = args.iter().any(|arg| arg == "--once");
            loop {
                match gateway.next_job(token.trim(), if once { 0 } else { 25 }) {
                    Ok(Some(job)) => {
                        let outcome = run_job(
                            &net::job_for_signer(&job),
                            &policy,
                            &keys,
                            &ledger_path,
                            &ledger::today(),
                        );
                        eprintln!(
                            "{}",
                            serde_json::json!({ "job": job["id"], "decision": outcome["decision"], "reasons": outcome["reasons"] })
                        );
                        if let Err(error) = gateway.answer(
                            token.trim(),
                            job["id"].as_str().unwrap_or_default(),
                            &outcome,
                        ) {
                            eprintln!("{error}");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("{error}");
                        if once {
                            return Err(error);
                        }
                        std::thread::sleep(std::time::Duration::from_secs(5));
                    }
                }
                if once {
                    return Ok(ExitCode::SUCCESS);
                }
            }
        }
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match run(&args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::write_private;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn an_existing_token_file_becomes_owner_only_and_symlinks_are_refused() {
        let directory =
            std::env::temp_dir().join(format!("whale-signer-token-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir(&directory).expect("temporary directory");
        let token = directory.join("signer.token");
        std::fs::write(&token, "old").expect("old token");
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o644))
            .expect("permissions");
        write_private(&token, "new-secret").expect("write token");
        assert_eq!(
            std::fs::read_to_string(&token).expect("token"),
            "new-secret"
        );
        assert_eq!(
            std::fs::metadata(&token)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let target = directory.join("target");
        std::fs::write(&target, "unchanged").expect("target");
        let link = directory.join("link");
        symlink(&target, &link).expect("symlink");
        assert!(write_private(&link, "stolen").is_err());
        assert_eq!(
            std::fs::read_to_string(&target).expect("target"),
            "unchanged"
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
