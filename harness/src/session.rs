use anyhow::{bail, ensure, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub version: u8,
    pub id: String,
    pub root: PathBuf,
    pub task: String,
    pub status: String,
    pub turns: usize,
    pub editable: bool,
    pub commands: bool,
    #[serde(default = "sandbox_default")]
    pub command_sandbox: bool,
    pub transcript: Vec<Value>,
    pub calls: BTreeMap<String, Value>,
    pub reads: BTreeMap<String, String>,
    pub pending: Option<Value>,
    #[serde(default)]
    pub bridge_lease: Option<Value>,
    pub parent: Option<String>,
}

pub struct Session {
    pub state: State,
    pub dir: PathBuf,
    _lock: File,
}

fn sandbox_default() -> bool {
    true
}

pub fn private_file(path: &Path, create_new: bool) -> Result<File> {
    ensure!(!path.is_symlink(), "Refusing session symlink");
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(options.open(path)?)
}

pub fn ensure_dir(path: &Path) -> Result<()> {
    ensure!(!path.is_symlink(), "Refusing state directory symlink");
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn valid_id(id: &str) -> Result<()> {
    ensure!(Uuid::parse_str(id).is_ok(), "Invalid session id");
    Ok(())
}

impl Session {
    pub fn create(
        base: &Path,
        root: PathBuf,
        task: String,
        editable: bool,
        commands: bool,
    ) -> Result<Self> {
        ensure_dir(base)?;
        let id = Uuid::new_v4().to_string();
        let dir = base.join(&id);
        ensure_dir(&dir)?;
        let lock = private_file(&dir.join("lock"), false)?;
        lock.try_lock_exclusive()
            .context("Session already running")?;
        let state = State {
            version: 1,
            id,
            root,
            task,
            status: "ready".into(),
            turns: 0,
            editable,
            commands,
            command_sandbox: commands,
            transcript: vec![],
            calls: BTreeMap::new(),
            reads: BTreeMap::new(),
            pending: None,
            bridge_lease: None,
            parent: None,
        };
        let session = Self {
            state,
            dir,
            _lock: lock,
        };
        session.save()?;
        Ok(session)
    }
    pub fn load(base: &Path, id: &str) -> Result<Self> {
        valid_id(id)?;
        let dir = base.join(id);
        ensure!(
            !dir.is_symlink() && dir.is_dir(),
            "Unknown session or symlink"
        );
        let lock = private_file(&dir.join("lock"), false)?;
        lock.try_lock_exclusive()
            .context("Session already running")?;
        let mut file = private_file(&dir.join("state.json"), false)?;
        ensure!(
            file.metadata()?.len() <= 4_000_000,
            "Session exceeds size limit"
        );
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        let state: State = serde_json::from_str(&text)?;
        ensure!(
            state.version == 1 && state.id == id,
            "Session identity/version mismatch"
        );
        Ok(Self {
            state,
            dir,
            _lock: lock,
        })
    }
    pub fn save(&self) -> Result<()> {
        let tmp = self.dir.join("state.tmp");
        let mut file = private_file(&tmp, false)?;
        file.set_len(0)?;
        file.write_all(&serde_json::to_vec_pretty(&self.state)?)?;
        file.sync_all()?;
        fs::rename(tmp, self.dir.join("state.json"))?;
        #[cfg(unix)]
        File::open(&self.dir)?.sync_all()?;
        Ok(())
    }
    pub fn record(&self, kind: &str, data: Value) -> Result<Value> {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis();
        let event = json!({"session":self.state.id,"at_ms":at_ms,"event":kind,"data":data});
        let path = self.dir.join("events.jsonl");
        let mut file = private_file(&path, false)?;
        use std::io::{Seek, SeekFrom};
        ensure!(
            file.metadata()?.len() < 8_000_000,
            "Event journal exceeds 8MB"
        );
        file.seek(SeekFrom::End(0))?;
        writeln!(file, "{}", serde_json::to_string(&event)?)?;
        file.sync_data()?;
        Ok(event)
    }
    pub fn resumable(&self) -> Result<()> {
        if let Some(pending) = &self.state.pending {
            if pending["kind"] == "model_answer" {
                ensure!(
                    pending["nonce"].as_str().is_some() && pending["answer"].as_str().is_some(),
                    "Malformed saved model response"
                );
                return Ok(());
            }
            bail!(
                "Session has uncertain unfinished intent ({}). Inspect it with recover before continuing; automatic replay is disabled.",
                pending["kind"].as_str().unwrap_or("unknown")
            );
        }
        ensure!(
            self.state.status != "final",
            "Session already completed; fork it for new work"
        );
        Ok(())
    }
}

pub fn list(base: &Path) -> Result<Vec<Value>> {
    if !base.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in fs::read_dir(base)?.take(500) {
        let path = entry?.path();
        if path.is_symlink() || !path.is_dir() {
            continue;
        }
        let state = path.join("state.json");
        if state.is_symlink()
            || fs::metadata(&state)
                .map(|m| m.len() > 4_000_000)
                .unwrap_or(true)
        {
            continue;
        }
        if let Ok(s) = serde_json::from_slice::<State>(&fs::read(&state)?) {
            out.push(json!({"id":s.id,"root":s.root,"task":s.task,"status":s.status,"turns":s.turns,"parent":s.parent}));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_intent_survives_and_prevents_replay() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Session::create(
            dir.path(),
            dir.path().to_path_buf(),
            "task".into(),
            false,
            false,
        )
        .unwrap();
        let id = s.state.id.clone();
        assert!(Session::load(dir.path(), &id).is_err());
        s.state.pending = Some(json!({"tool":"edit_file"}));
        s.save().unwrap();
        drop(s);
        let loaded = Session::load(dir.path(), &id).unwrap();
        assert!(loaded.resumable().is_err());
        assert!(Session::load(dir.path(), "../escape").is_err());
    }
    #[test]
    fn legacy_command_session_defaults_to_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let session =
            Session::create(dir.path(), dir.path().into(), "task".into(), true, true).unwrap();
        let mut value = serde_json::to_value(&session.state).unwrap();
        value.as_object_mut().unwrap().remove("command_sandbox");
        let state: State = serde_json::from_value(value.clone()).unwrap();
        assert!(state.command_sandbox);
        value["command_sandbox"] = false.into();
        let explicit_optout: State = serde_json::from_value(value).unwrap();
        assert!(!explicit_optout.command_sandbox);
    }
}
