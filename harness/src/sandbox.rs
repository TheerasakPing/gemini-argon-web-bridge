#[cfg(not(target_os = "macos"))]
use anyhow::bail;
use anyhow::{ensure, Context, Result};
use std::{path::Path, process::Command};

#[cfg(target_os = "macos")]
fn profile(root: &Path) -> Result<String> {
    let root = root.canonicalize()?;
    let root = root
        .to_str()
        .context("Sandbox requires UTF-8 workspace path")?;
    ensure!(
        !root.chars().any(|c| c.is_control()),
        "Sandbox path contains control characters"
    );
    let escaped = root.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!(
        r#"(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin")
 (subpath "/sbin") (subpath "/Library/Apple") (subpath "/private/var/db/dyld"))
(allow file-read* file-write* (subpath "{escaped}"))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom")
 (literal "/dev/random") (literal "/dev/fd") (subpath "/dev/fd"))
(allow file-write* (literal "/dev/null"))
"#
    ))
}

/// Failure never falls back to unrestricted execution.
pub fn command(root: &Path, argv: &[String]) -> Result<Command> {
    ensure!(!argv.is_empty(), "Empty sandbox command");
    #[cfg(target_os = "macos")]
    {
        ensure!(
            Path::new("/usr/bin/sandbox-exec").is_file(),
            "macOS sandbox-exec is unavailable"
        );
        let mut cmd = Command::new("/usr/bin/sandbox-exec");
        cmd.arg("-p").arg(profile(root)?).arg("--").args(argv);
        Ok(cmd)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        bail!("Command sandbox is currently supported only on macOS")
    }
}

pub fn probe(root: &Path) -> Result<()> {
    let status = command(root, &["/usr/bin/true".into()])?
        .current_dir(root)
        .env_clear()
        .status()
        .context("Cannot start sandbox availability probe")?;
    ensure!(
        status.success(),
        "OS rejected command sandbox; refusing unrestricted fallback"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn sandbox_cannot_signal_unsandboxed_sibling() {
        let root = tempfile::tempdir().unwrap();
        let mut sibling = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let result = command(
            root.path(),
            &["/bin/kill".into(), "-TERM".into(), sibling.id().to_string()],
        )
        .unwrap()
        .output()
        .unwrap();
        let still_running = sibling.try_wait().unwrap().is_none();
        let _ = sibling.kill();
        let _ = sibling.wait();
        assert!(!result.status.success(), "{result:?}");
        assert!(
            still_running,
            "sandbox signalled an external sibling process"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sandbox_denies_external_files_and_network() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("outside.txt");
        std::fs::write(&secret, "outside").unwrap();
        probe(root.path()).expect("macOS sandbox must be available for isolation test");
        let status = command(
            root.path(),
            &[
                "/bin/sh".into(),
                "-c".into(),
                "printf allowed > inside.txt".into(),
            ],
        )
        .unwrap()
        .current_dir(root.path())
        .status()
        .unwrap();
        assert!(status.success());
        assert!(root.path().join("inside.txt").exists());
        let denied = command(
            root.path(),
            &["/bin/cat".into(), secret.to_string_lossy().into_owned()],
        )
        .unwrap()
        .output()
        .unwrap();
        assert!(!denied.status.success());
        assert!(!String::from_utf8_lossy(&denied.stdout).contains("outside"));
        std::os::unix::fs::symlink(&secret, root.path().join("escape.txt")).unwrap();
        let denied = command(
            root.path(),
            &["/bin/sh".into(), "-c".into(), "/bin/cat escape.txt".into()],
        )
        .unwrap()
        .current_dir(root.path())
        .output()
        .unwrap();
        assert!(!denied.status.success());
        assert!(!String::from_utf8_lossy(&denied.stdout).contains("outside"));
        let denied = command(
            root.path(),
            &[
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "printf denied > '{}'",
                    outside.path().join("new.txt").display()
                ),
            ],
        )
        .unwrap()
        .output()
        .unwrap();
        assert!(!denied.status.success());
        assert!(!outside.path().join("new.txt").exists());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let denied = command(
            root.path(),
            &[
                "/usr/bin/curl".into(),
                "--max-time".into(),
                "2".into(),
                format!("http://{}", listener.local_addr().unwrap()),
            ],
        )
        .unwrap()
        .output()
        .unwrap();
        assert!(!denied.status.success());
        assert!(
            String::from_utf8_lossy(&denied.stderr).contains("Operation not permitted"),
            "{:?}",
            denied
        );
    }
}
