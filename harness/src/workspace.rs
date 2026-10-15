use anyhow::{ensure, Context, Result};
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::LazyLock,
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
fn safe_name(path: &Path) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
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
