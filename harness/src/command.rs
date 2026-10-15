use crate::workspace::{sensitive_text, short};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let _ = Command::new(Path::new(&root).join("System32/taskkill.exe"))
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .status();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
struct Guard(Child, bool);
impl Guard {
    fn stop(&mut self) {
        if self.1 {
            kill_tree(&mut self.0);
            self.1 = false;
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn run(
    root: &Path,
    argv: &[String],
    timeout_s: u64,
    cancelled: &AtomicBool,
    on_output: &mut dyn FnMut(&str, &str) -> Result<()>,
) -> Result<Value> {
    ensure!(
        !argv.is_empty()
            && argv.len() <= 64
            && !argv[0].is_empty()
            && argv.iter().all(|s| s.len() <= 8000 && !s.contains('\0')),
        "Invalid argv"
    );
    ensure!(
        (1..=120).contains(&timeout_s),
        "Command timeout must be 1..120 seconds"
    );
    ensure!(!cancelled.load(Ordering::SeqCst), "Cancelled");
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "SystemRoot",
        "COMSPEC",
    ] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = Guard(cmd.spawn().context("Cannot start approved command")?, true);
    let (tx, rx) = mpsc::sync_channel(64);
    let stdout = child.0.stdout.take().context("Missing stdout")?;
    let stderr = child.0.stderr.take().context("Missing stderr")?;
    fn reader(
        mut pipe: impl Read + Send + 'static,
        name: &'static str,
        tx: mpsc::SyncSender<(&'static str, Vec<u8>)>,
    ) {
        thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(n) = pipe.read(&mut bytes) {
                if n == 0 || tx.send((name, bytes[..n].to_vec())).is_err() {
                    break;
                }
            }
        });
    }
    reader(stdout, "stdout", tx.clone());
    reader(stderr, "stderr", tx.clone());
    drop(tx);
    let started = Instant::now();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut truncated = false;
    let mut timed_out = false;
    let mut stopped = false;
    let status = loop {
        while let Ok((name, bytes)) = rx.try_recv() {
            let target = if name == "stdout" { &mut out } else { &mut err };
            let count = bytes.len().min(32000usize.saturating_sub(target.len()));
            target.extend_from_slice(&bytes[..count]);
            truncated |= count < bytes.len();
        }
        if let Some(status) = child.0.try_wait()? {
            break Some(status);
        }
        if cancelled.load(Ordering::SeqCst) || started.elapsed() >= Duration::from_secs(timeout_s) {
            stopped = cancelled.load(Ordering::SeqCst);
            timed_out = !stopped;
            child.stop();
            break None;
        }
        thread::sleep(Duration::from_millis(30));
    };
    // Terminate background descendants of an approved command, too.
    child.stop();
    let drain = Instant::now();
    while drain.elapsed() < Duration::from_millis(200) {
        let (name, bytes) = match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(data) => data,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
        };
        let target = if name == "stdout" { &mut out } else { &mut err };
        let count = bytes.len().min(32000usize.saturating_sub(target.len()));
        target.extend_from_slice(&bytes[..count]);
        truncated |= count < bytes.len();
    }
    let text = |bytes: &[u8]| {
        let value = String::from_utf8_lossy(bytes);
        if sensitive_text(&value) {
            "[potential credential redacted]".into()
        } else {
            short(&value, 16000)
        }
    };
    // Inspect whole bounded channels before emitting: credentials can span read chunks.
    let stdout = text(&out);
    let stderr = text(&err);
    for (channel, value) in [("stdout", &stdout), ("stderr", &stderr)] {
        if !value.is_empty() {
            on_output(channel, value)?;
        }
    }
    Ok(
        json!({"exit_code":status.and_then(|s|s.code()),"success":status.is_some_and(|s|s.success()),
        "timed_out":timed_out,"cancelled":stopped,"stdout":stdout,"stderr":stderr,
        "truncated":truncated,"elapsed_ms":started.elapsed().as_millis()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn redacts_credentials_split_between_process_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut emitted = String::new();
        let result = run(
            dir.path(),
            &[
                "/bin/sh".into(),
                "-c".into(),
                "printf 'api_key = \"'; sleep 0.1; printf 'examplecredentialvalue\"'".into(),
            ],
            2,
            &AtomicBool::new(false),
            &mut |_, text| {
                emitted.push_str(text);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result["stdout"], "[potential credential redacted]");
        assert!(!emitted.contains("examplecredentialvalue"));
    }
    #[test]
    #[cfg(unix)]
    fn captures_failure_and_timeout_without_shell_expansion() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut sink = |_: &str, _: &str| Ok(());
        let r = run(
            dir.path(),
            &["/usr/bin/printf".into(), "%s".into(), "$(touch BAD)".into()],
            2,
            &cancel,
            &mut sink,
        )
        .unwrap();
        assert_eq!(r["stdout"], "$(touch BAD)");
        assert!(!dir.path().join("BAD").exists());
        let r = run(
            dir.path(),
            &["/bin/sh".into(), "-c".into(), "exit 7".into()],
            2,
            &cancel,
            &mut sink,
        )
        .unwrap();
        assert_eq!(r["exit_code"], 7);
        assert_eq!(r["success"], false);
        let r = run(
            dir.path(),
            &["/bin/sleep".into(), "5".into()],
            1,
            &cancel,
            &mut sink,
        )
        .unwrap();
        assert_eq!(r["timed_out"], true);
    }
}
