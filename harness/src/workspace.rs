use anyhow::{ensure, Context, Result};
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, LazyLock},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_FILE: u64 = 256_000;
const SKIP: &[&str] = &[
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
    "coverage",
    "venv",
    "logs",
];
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r#"-----BEGIN .*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{20,}|(?i:bearer)\s+[A-Za-z0-9._-]{20,}|(?i:(?:api[_-]?key|password|secret|token)\s*["']?\s*[=:]\s*["'])[^\s"']{12,}"#
).expect("constant credential regex")
});

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn sensitive_text(text: &str) -> bool {
    SECRET.is_match(text)
}
pub fn short(text: &str, max: usize) -> String {
    let s: String = text.chars().take(max).collect();
    if s.len() < text.len() {
        s + "\n[truncated]"
    } else {
        s
    }
}
fn unified_diff(name: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let old: Vec<_> = before.split_inclusive('\n').collect();
    let new: Vec<_> = after.split_inclusive('\n').collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let start = prefix.saturating_sub(3);
    let old_end = (old.len() - suffix + 3).min(old.len());
    let new_end = (new.len() - suffix + 3).min(new.len());
    let mut result = format!(
        "--- a/{name}\n+++ b/{name}\n@@ -{},{} +{},{} @@\n",
        if old.is_empty() { 0 } else { start + 1 },
        old_end - start,
        if new.is_empty() { 0 } else { start + 1 },
        new_end - start
    );
    let mut line = |marker: char, text: &str| {
        result.push(marker);
        result.push_str(text);
        if !text.ends_with('\n') {
            result.push_str("\n\\ No newline at end of file\n");
        }
    };
    for text in &old[start..prefix] {
        line(' ', text);
    }
    for text in &old[prefix..old.len() - suffix] {
        line('-', text);
    }
    for text in &new[prefix..new.len() - suffix] {
        line('+', text);
    }
    for text in &old[old.len() - suffix..old_end] {
        line(' ', text);
    }
    result
}
fn trusted_git(root: &Path) -> Result<PathBuf> {
    // Never search PATH: read-only tools must not execute a project-controlled shim.
    let path = Path::new("/usr/bin/git");
    ensure!(
        cfg!(unix) && path.is_file(),
        "Trusted system Git unavailable; git_diff is unsupported on this platform"
    );
    let path = path.canonicalize()?;
    ensure!(
        !path.starts_with(root),
        "Git executable is inside workspace"
    );
    Ok(path)
}

fn bounded_blob(mut command: Command, timeout: Duration) -> Result<(ExitStatus, Vec<u8>)> {
    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = Process(command.spawn().context("Cannot read Git HEAD blob")?);
    let stdout = child.0.stdout.take().context("Missing Git stdout")?;
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = vec![];
        let result = stdout.take(MAX_FILE + 1).read_to_end(&mut bytes);
        let _ = tx.send(result.map(|_| bytes));
    });
    let started = Instant::now();
    let mut bytes = None;
    let mut status = None;
    loop {
        ensure!(
            started.elapsed() < timeout,
            "Git HEAD read deadline reached"
        );
        if bytes.is_none() {
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(result) => {
                    let output = result?;
                    ensure!(
                        output.len() as u64 <= MAX_FILE,
                        "Git HEAD blob exceeds 256KB"
                    );
                    bytes = Some(output);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("Git output reader disconnected")
                }
            }
        } else {
            thread::sleep(Duration::from_millis(10));
        }
        if status.is_none() {
            status = child.0.try_wait()?;
        }
        if let (Some(status), Some(bytes)) = (status, bytes.as_ref()) {
            return Ok((status, bytes.clone()));
        }
    }
}
fn safe_name(path: &Path) -> bool {
    if path.to_string_lossy().chars().any(|c| c.is_control()) {
        return false;
    }
    let lower = path.to_string_lossy().to_lowercase().replace('\\', "/");
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    !path.components().any(|c| match c {
        Component::Normal(s) => {
            let p = s.to_string_lossy().to_lowercase();
            p.starts_with('.') || SKIP.contains(&p.as_str())
        }
        _ => true,
    }) && ![
        "token",
        "secret",
        "credential",
        "password",
        "id_rsa",
        "id_ed25519",
    ]
    .iter()
    .any(|s| name.contains(s))
        && ![
            ".pem", ".key", ".p12", ".pfx", ".lock", ".log", ".min.js", ".min.css",
        ]
        .iter()
        .any(|s| name.ends_with(s))
        && ![
            "extension/config.js",
            "bridge/queue.json",
            "bridge/history.jsonl",
            "bridge/agent-lease.json",
        ]
        .iter()
        .any(|base| lower == *base || lower.starts_with(&format!("{base}.")))
}

#[derive(Clone)]
pub struct Workspace {
    pub root: PathBuf,
}
impl Workspace {
    pub fn new(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;
        ensure!(
            root.is_dir() && root.parent().is_some(),
            "Workspace must be a project directory"
        );
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            ensure!(
                root != PathBuf::from(home).canonicalize().unwrap_or_default(),
                "Refusing to scan entire home directory"
            );
        }
        Ok(Self { root })
    }
    pub fn files(&self) -> Vec<String> {
        let root = self.root.clone();
        let mut files: Vec<String> = WalkBuilder::new(&self.root)
            .add_custom_ignore_filename(".argonignore")
            .require_git(false)
            .hidden(true)
            .follow_links(false)
            .max_depth(Some(10))
            .filter_entry(move |e| {
                e.depth() == 0 || e.path().strip_prefix(&root).map(safe_name).unwrap_or(false)
            })
            .build()
            .take(10_000)
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .filter_map(|e| {
                e.path()
                    .strip_prefix(&self.root)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            })
            .collect();
        files.sort();
        files
    }
    fn checked(&self, name: &str, must_exist: bool) -> Result<PathBuf> {
        let relative = Path::new(name);
        ensure!(
            !name.is_empty() && name.len() <= 1000 && !name.contains('\\') && safe_name(relative),
            "Denied path: hidden, sensitive, generated or non-relative"
        );
        let mut path = self.root.clone();
        for part in relative.components() {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(meta) => ensure!(!meta.file_type().is_symlink(), "Symlink access denied"),
                Err(e)
                    if !must_exist
                        && e.kind() == std::io::ErrorKind::NotFound
                        && path == self.root.join(relative) => {}
                Err(e) => return Err(e.into()),
            }
        }
        ensure!(
            path.parent()
                .context("Missing parent")?
                .canonicalize()?
                .starts_with(&self.root),
            "Outside workspace"
        );
        Ok(path)
    }
    pub fn read(&self, name: &str) -> Result<String> {
        ensure!(
            self.files().iter().any(|f| f == name),
            "File is ignored or outside bounded project index"
        );
        self.read_indexed(name)
    }
    fn read_indexed(&self, name: &str) -> Result<String> {
        let path = self.checked(name, true)?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(path)?;
        ensure!(
            file.metadata()?.is_file() && file.metadata()?.len() <= MAX_FILE,
            "Not a regular file or exceeds 256KB"
        );
        let mut bytes = vec![];
        file.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_FILE && !bytes.contains(&0),
            "Binary or oversized file denied"
        );
        let text = String::from_utf8(bytes).context("UTF-8 text required")?;
        ensure!(
            !sensitive_text(&text),
            "File contains a potential credential; not sent to model"
        );
        Ok(text)
    }
    pub fn list(&self, prefix: &str) -> Result<Value> {
        if !prefix.is_empty() {
            ensure!(safe_name(Path::new(prefix)), "Invalid directory prefix");
        }
        let files: Vec<_> = self
            .files()
            .into_iter()
            .filter(|f| {
                prefix.is_empty() || f.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
            })
            .collect();
        Ok(
            json!({"files":files.iter().take(300).collect::<Vec<_>>(),"truncated":files.len()>300,"index_limit":10000}),
        )
    }
    pub fn read_lines(&self, path: &str, start: usize, end: usize) -> Result<Value> {
        ensure!(
            start > 0 && end >= start && end - start < 200,
            "Line range must contain 1..200 lines"
        );
        let text = self.read(path)?;
        let lines: Vec<_> = text
            .lines()
            .enumerate()
            .skip(start - 1)
            .take(end - start + 1)
            .map(|(i, l)| format!("{}: {}", i + 1, short(l, 1000)))
            .collect();
        Ok(
            json!({"path":path,"sha256":digest(text.as_bytes()),"total_lines":text.lines().count(),
            "content":short(&lines.join("\n"),16000)}),
        )
    }
    pub fn search(&self, query: &str) -> Result<Value> {
        ensure!(
            !query.is_empty() && query.len() <= 300 && !query.contains('\n'),
            "Literal query must be 1..300 bytes, single line"
        );
        let mut matches = vec![];
        let files = self.files();
        let truncated = files.len() > 2000;
        for path in files.into_iter().take(2000) {
            if let Ok(text) = self.read_indexed(&path) {
                for (line, content) in text.lines().enumerate() {
                    if content.contains(query) {
                        matches.push(json!({"path":path,"line":line+1,"text":short(content,180)}));
                        if matches.len() >= 50 {
                            return Ok(json!({"matches":matches,"truncated":true}));
                        }
                    }
                }
            }
        }
        Ok(json!({"matches":matches,"truncated":truncated,"file_limit":2000}))
    }
    pub fn edited(&self, name: &str, hash: &str, old: &str, new: &str) -> Result<String> {
        let text = self.read(name)?;
        ensure!(
            hash == digest(text.as_bytes()),
            "Stale file hash; read file again before editing"
        );
        ensure!(
            !old.is_empty() && text.matches(old).count() == 1,
            "old_text must match exactly once"
        );
        let changed = text.replacen(old, new, 1);
        ensure!(
            changed.len() as u64 <= MAX_FILE && !sensitive_text(&changed),
            "Oversized or sensitive replacement"
        );
        Ok(changed)
    }
    pub fn preview_edit(&self, name: &str, hash: &str, old: &str, new: &str) -> Result<String> {
        let changed = self.edited(name, hash, old, new)?;
        Ok(short(
            &unified_diff(name, &self.read(name)?, &changed),
            20000,
        ))
    }
    pub fn preview_create(&self, name: &str, content: &str) -> Result<String> {
        self.check_new(name, content)?;
        Ok(short(&unified_diff(name, "", content), 20000))
    }
    pub fn git_diff(&self, name: &str) -> Result<Value> {
        let current = self.read(name)?;
        // Read blobs directly: no external diff drivers, textconv, filters or shell.
        let mut command = Command::new(trusted_git(&self.root)?);
        command
            .args(["--no-pager", "show", &format!("HEAD:./{name}")])
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_OPTIONAL_LOCKS", "0");
        let (status, bytes) = bounded_blob(command, Duration::from_secs(5))?;
        ensure!(status.success(), "File must exist in Git HEAD");
        ensure!(!bytes.contains(&0), "Binary Git HEAD blob denied");
        let before = String::from_utf8(bytes).context("Git HEAD blob must be UTF-8")?;
        ensure!(
            !sensitive_text(&before),
            "Git HEAD contains a potential credential; diff denied"
        );
        let diff = unified_diff(name, &before, &current);
        Ok(
            json!({"path":name,"base":"HEAD","diff":short(&diff,20000),"truncated":diff.chars().count()>20000}),
        )
    }
    pub fn edit(&self, name: &str, hash: &str, old: &str, new: &str) -> Result<Value> {
        let changed = self.edited(name, hash, old, new)?;
        let path = self.checked(name, true)?;
        let tmp = path.with_file_name(format!(".argon-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(changed.as_bytes())?;
            file.sync_all()?;
            ensure!(
                digest(self.read(name)?.as_bytes()) == hash,
                "File changed while preparing edit"
            );
            let current = self.checked(name, true)?;
            fs::set_permissions(&tmp, fs::metadata(&current)?.permissions())?;
            fs::rename(&tmp, current)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result?;
        Ok(json!({"path":name,"sha256":digest(changed.as_bytes()),"changed":true}))
    }
    pub fn check_new(&self, name: &str, content: &str) -> Result<PathBuf> {
        let path = self.checked(name, false)?;
        ensure!(
            !path.exists(),
            "create_file never overwrites an existing file"
        );
        ensure!(
            content.len() as u64 <= MAX_FILE && !content.contains('\0') && !sensitive_text(content),
            "Binary, oversized or sensitive content denied"
        );
        let mut builder = ignore::gitignore::GitignoreBuilder::new(&self.root);
        let mut directory = self.root.clone();
        for part in Path::new(name)
            .parent()
            .unwrap_or(Path::new(""))
            .components()
        {
            for file in [".gitignore", ".ignore", ".argonignore"] {
                let config = directory.join(file);
                if config.is_file() && !config.is_symlink() {
                    builder.add(config);
                }
            }
            directory.push(part);
        }
        for file in [".gitignore", ".ignore", ".argonignore"] {
            let config = directory.join(file);
            if config.is_file() && !config.is_symlink() {
                builder.add(config);
            }
        }
        ensure!(
            !builder
                .build()?
                .matched_path_or_any_parents(&path, false)
                .is_ignore(),
            "New path is ignored"
        );
        Ok(path)
    }
    pub fn create(&self, name: &str, content: &str) -> Result<Value> {
        let path = self.check_new(name, content)?;
        let tmp = path.with_file_name(format!(".argon-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            self.check_new(name, content)?;
            fs::hard_link(&tmp, &path)?;
            Ok(())
        })();
        let _ = fs::remove_file(&tmp);
        result?;
        Ok(json!({"path":name,"sha256":digest(content.as_bytes()),"created":true}))
    }
}

/// Detect the project stack and entry documents from the full file list, so large trees
/// still surface their manifests even when the prompt only carries a partial listing.
pub fn overview(files: &[String]) -> String {
    const STACKS: &[(&str, &str)] = &[
        ("Cargo.toml", "Rust"),
        ("package.json", "Node/TypeScript"),
        ("go.mod", "Go"),
        ("pyproject.toml", "Python"),
        ("requirements.txt", "Python"),
        ("pom.xml", "Java/Maven"),
        ("build.gradle", "Java/Gradle"),
        ("Gemfile", "Ruby"),
        ("composer.json", "PHP"),
    ];
    const DOCS: &[&str] = &["AGENTS.md", "README.md", "README", "PLAN.md", "SKILL.md"];
    let base = |f: &str| f.rsplit('/').next().unwrap_or(f).to_string();
    let mut stacks: Vec<&str> = Vec::new();
    let mut manifests: Vec<&String> = Vec::new();
    for f in files {
        let name = base(f);
        if let Some((_, stack)) = STACKS.iter().find(|(m, _)| *m == name) {
            if !stacks.contains(stack) {
                stacks.push(stack);
            }
            if f.matches('/').count() <= 1 && manifests.len() < 8 {
                manifests.push(f);
            }
        }
    }
    let docs: Vec<&String> = files
        .iter()
        .filter(|f| f.matches('/').count() == 0 && DOCS.contains(&f.as_str()))
        .collect();
    let mut dirs: Vec<&str> = files
        .iter()
        .filter_map(|f| f.split_once('/').map(|(d, _)| d))
        .collect();
    dirs.dedup();
    dirs.truncate(20);
    format!(
        "files={} stack={} manifests={:?} docs={:?} top_dirs={:?}",
        files.len(),
        if stacks.is_empty() {
            "unknown".to_string()
        } else {
            stacks.join(",")
        },
        manifests,
        docs,
        dirs
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overview_detects_stack_and_docs() {
        let files: Vec<String> = ["README.md", "src/main.rs", "Cargo.toml", "web/package.json"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let o = overview(&files);
        assert!(
            o.contains("Rust,Node/TypeScript") && o.contains("README.md") && o.contains("files=4"),
            "{o}"
        );
    }

    #[test]
    fn confined_ignored_and_credential_reads() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.py\n").unwrap();
        fs::write(dir.path().join("ignored.py"), "secret ignored").unwrap();
        fs::write(dir.path().join("safe.py"), "print('hello')\n").unwrap();
        fs::write(
            dir.path().join("config.py"),
            format!("api_key = \"{}\"", "x".repeat(40)),
        )
        .unwrap();
        let w = Workspace::new(dir.path()).unwrap();
        assert!(w.read("../escape").is_err());
        assert!(w.read(".env").is_err());
        assert!(w.read("ignored.py").is_err());
        assert!(w.read("config.py").is_err());
        assert!(w.read("safe.py").is_ok());
        fs::create_dir(dir.path().join("bridge")).unwrap();
        for name in [
            "agent-lease.json",
            "agent-lease.json.tmp",
            "queue.json.tmp",
            "history.jsonl.1",
        ] {
            fs::write(dir.path().join("bridge").join(name), "{}").unwrap();
            assert!(w.read(&format!("bridge/{name}")).is_err());
        }
        fs::write(
            dir.path().join("settings.json"),
            r#"{"token":"example-credential-value"}"#,
        )
        .unwrap();
        assert!(w.read("settings.json").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", dir.path().join("link.txt")).unwrap();
            assert!(w.read("link.txt").is_err());
        }
    }
    #[test]
    fn edits_reject_stale_hash_and_duplicate_anchors() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("app.py"), "return 1\n").unwrap();
        let w = Workspace::new(dir.path()).unwrap();
        let hash = digest(b"return 1\n");
        assert!(w.edit("app.py", "bad", "return 1", "return 2").is_err());
        w.edit("app.py", &hash, "return 1", "return 2").unwrap();
        assert_eq!(w.read("app.py").unwrap(), "return 2\n");
        assert!(w.edit("app.py", &hash, "return 1", "return 2").is_err());
        assert!(w.edited("app.py", &digest(b"return 2\n"), "", "x").is_err());
    }
    #[test]
    fn unified_preview_matches_actual_change_and_final_newline() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("app.py"), "a\nreturn 1\nz\n").unwrap();
        let w = Workspace::new(dir.path()).unwrap();
        let preview = w
            .preview_edit(
                "app.py",
                &digest(b"a\nreturn 1\nz\n"),
                "return 1",
                "return 2",
            )
            .unwrap();
        assert_eq!(
            preview,
            "--- a/app.py\n+++ b/app.py\n@@ -1,3 +1,3 @@\n a\n-return 1\n+return 2\n z\n"
        );
        assert!(w
            .preview_create("new.txt", "ไทย")
            .unwrap()
            .contains("@@ -0,0 +1,1 @@\n+ไทย\n\\ No newline at end of file"));
        assert!(w.preview_create(".env", "hidden").is_err());
    }
    #[test]
    fn git_diff_rejects_ignored_and_historical_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-q"]);
        fs::write(dir.path().join("app.py"), "return 1\n").unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.py\n").unwrap();
        fs::write(dir.path().join("ignored.py"), "ignored").unwrap();
        fs::write(
            dir.path().join("config.py"),
            r#"api_key = "examplecredentialvalue""#,
        )
        .unwrap();
        git(&["add", "app.py", "config.py", ".gitignore"]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ]);
        fs::write(dir.path().join("app.py"), "return 2\n").unwrap();
        fs::write(dir.path().join("config.py"), "now safe\n").unwrap();
        let w = Workspace::new(dir.path()).unwrap();
        let diff = w.git_diff("app.py").unwrap();
        assert!(diff["diff"]
            .as_str()
            .unwrap()
            .contains("-return 1\n+return 2"));
        assert!(w.git_diff("config.py").is_err());
        assert!(w.git_diff("ignored.py").is_err());
        assert!(w.git_diff(".git/config").is_err());
    }
    #[test]
    #[cfg(unix)]
    fn git_reader_is_trusted_bounded_and_ignores_project_git_shim() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("git"), "#!/bin/sh\nexit 99\n").unwrap();
        let binary = trusted_git(root.path()).unwrap();
        assert_eq!(binary, Path::new("/usr/bin/git").canonicalize().unwrap());
        assert!(!binary.starts_with(root.path()));
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 10"]);
        let started = Instant::now();
        let error = bounded_blob(cmd, Duration::from_millis(100)).unwrap_err();
        assert!(error.to_string().contains("deadline"));
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut cmd = Command::new("/usr/bin/yes");
        cmd.arg("oversized");
        let error = bounded_blob(cmd, Duration::from_secs(2)).unwrap_err();
        assert!(error.to_string().contains("256KB"));
    }
    #[test]
    fn create_never_overwrites_or_bypasses_project_ignore() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.py\n").unwrap();
        let w = Workspace::new(dir.path()).unwrap();
        assert!(w.create("ignored.py", "text").is_err());
        assert!(w.create("../outside.py", "text").is_err());
        assert!(w.create("new.py", "print('hello')\n").is_ok());
        assert!(w.create("new.py", "overwritten").is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("new.py")).unwrap(),
            "print('hello')\n"
        );
    }
}
