use serde_json::Value;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use whale_signer::{keystore, ledger, policy, run_job};

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
