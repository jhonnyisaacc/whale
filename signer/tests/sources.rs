use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const CRATES_IO: &str = "registry+https://github.com/rust-lang/crates.io-index";

fn foreign_sources(manifest: &Path, extra: &[&str]) -> Vec<String> {
    let output = Command::new(env!("CARGO"))
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(manifest)
        .args(extra)
        .output()
        .expect("cargo metadata runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).expect("metadata is JSON");
    let root = manifest.parent().unwrap();
    let mut problems = Vec::new();
    if Path::new(metadata["workspace_root"].as_str().unwrap()) != root {
        problems.push(format!(
            "the workspace root is {}",
            metadata["workspace_root"]
        ));
    }
    for package in metadata["packages"].as_array().unwrap() {
        let name = package["name"].as_str().unwrap();
        match package["source"].as_str() {
            Some(CRATES_IO) => {}
            Some(other) => problems.push(format!("{name} comes from {other}")),
            None if Path::new(package["manifest_path"].as_str().unwrap()) == manifest => {}
            None => problems.push(format!("{name} comes from a local path")),
        }
    }
    problems
}

fn scratch(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("whale-sources-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    for (path, body) in files {
        let file = dir.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }
    dir.canonicalize().unwrap()
}

const LIB: (&str, &str) = ("other/src/lib.rs", "");
const OTHER: (&str, &str) = (
    "other/Cargo.toml",
    "[package]\nname = \"other\"\nversion = \"1.0.0\"\nedition = \"2021\"\n",
);

#[test]
fn every_signer_crate_resolves_from_crates_io() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("Cargo.toml")
        .canonicalize()
        .unwrap();
    assert_eq!(
        foreign_sources(&manifest, &["--locked"]),
        Vec::<String>::new()
    );
    let repo = manifest.parent().unwrap().parent().unwrap();
    for dir in [manifest.parent().unwrap(), repo] {
        for config in [".cargo/config.toml", ".cargo/config"] {
            assert!(
                !dir.join(config).exists(),
                "{} replaces sources",
                dir.join(config).display()
            );
        }
    }
}

#[test]
fn a_crate_from_a_local_path_or_a_parent_workspace_is_reported() {
    let path = scratch(
        "path",
        &[
            ("app/src/lib.rs", ""),
            (
                "app/Cargo.toml",
                "[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nother = { version = \"=1.0.0\", \"\\u0070ath\" = \"../other\" }\n",
            ),
            OTHER,
            LIB,
        ],
    );
    assert_eq!(
        foreign_sources(&path.join("app/Cargo.toml"), &["--offline"]),
        ["other comes from a local path"]
    );
    let parent = scratch(
        "workspace",
        &[
            ("Cargo.toml", "[workspace]\nmembers = [\"app\"]\n"),
            ("app/src/lib.rs", ""),
            (
                "app/Cargo.toml",
                "[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
            ),
        ],
    );
    let problems = foreign_sources(&parent.join("app/Cargo.toml"), &["--offline"]);
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(
        problems[0].starts_with("the workspace root is"),
        "{problems:?}"
    );
    let _ = fs::remove_dir_all(path);
    let _ = fs::remove_dir_all(parent);
}
