#[test]
fn real_bridge_integration() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let status = std::process::Command::new("node")
        .args([
            "--test",
            "tests/harness.test.mjs",
            "tests/recovery.test.mjs",
        ])
        .current_dir(root)
        .env("ARGON_HARNESS_BIN", env!("CARGO_BIN_EXE_argon-harness"))
        .status()
        .expect("Node.js is required for bridge integration tests");
    assert!(status.success(), "Rust/bridge integration failed");
}
