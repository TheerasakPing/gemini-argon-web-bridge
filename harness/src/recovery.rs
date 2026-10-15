use crate::{
    protocol::Action,
    provider::Bridge,
    session::Session,
    workspace::{digest, Workspace},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};

/// Capture the intended postimage before execution, while the edit is still validated.
pub fn tool_intent(id: &str, action: &Action, workspace: &Workspace) -> Result<Value> {
    let mut intent = json!({"kind":"tool","id":id,"action":action});
    let expected = match action {
        Action::EditFile {
            path,
            sha256,
            old_text,
            new_text,
        } => Some(digest(
            workspace
                .edited(path, sha256, old_text, new_text)?
                .as_bytes(),
        )),
        Action::CreateFile { content, .. } => Some(digest(content.as_bytes())),
        _ => None,
    };
    if let Some(hash) = expected {
        intent["expected_sha256"] = hash.into();
    }
    Ok(intent)
}

/// Inspect without writing state, cancelling jobs, acquiring a lease or executing tools.
pub fn inspect(session: &Session, bridge: Option<&Bridge>) -> Result<Value> {
    let Some(pending) = &session.state.pending else {
        return Ok(json!({"kind":"none","resolution":"nothing_pending"}));
    };
    match pending["kind"].as_str() {
        Some("model_answer") => Ok(json!({
            "kind":"model_answer","resolution":"response_saved","resume_available":true
        })),
        Some("model_job") => {
            let id = pending["job"].as_str().context("Pending job missing id")?;
            ensure!(
                uuid::Uuid::parse_str(id).is_ok(),
                "Invalid pending bridge job id"
            );
            let job = bridge
                .context("Bridge connection required to inspect pending job")?
                .api(&format!("/jobs/{id}"), None)?;
            ensure!(job["id"] == id, "Bridge job identity mismatch");
            Ok(json!({"kind":"model_job","job":id,"status":job["status"],
            "resolution":match job["status"].as_str() {
                Some("done") => "completed_response_available",
                Some("error") => "terminal_model_error",
                _ => "wait_or_abandon"
            }}))
        }
        Some("model_submit") => Ok(json!({
            "kind":"model_submit","resolution":"unknown_submission",
            "detail":"No durable job id exists; inspect Gemini and bridge jobs before acknowledging abandonment"
        })),
        Some("tool") => inspect_tool(session, pending),
        _ => anyhow::bail!("Unknown pending intent; manual inspection required"),
    }
}

fn inspect_tool(session: &Session, pending: &Value) -> Result<Value> {
    let action: Action = serde_json::from_value(pending["action"].clone())?;
    let workspace = Workspace::new(&session.state.root)?;
    let (path, before) = match &action {
        Action::EditFile { path, sha256, .. } => (path, Some(sha256.as_str())),
        Action::CreateFile { path, .. } => (path, None),
        Action::RunCommand { .. } => {
            return Ok(json!({"kind":"tool","tool":"run_command",
                "resolution":"unknown_command_result",
                "detail":"Never replay a command automatically; inspect processes and side effects first"}))
        }
        _ => {
            return Ok(json!({"kind":"tool","tool":action.name(),
                "resolution":"read_result_lost"}))
        }
    };
    match workspace.read(path) {
        Ok(text) => {
            let current = digest(text.as_bytes());
            let expected = pending["expected_sha256"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| match &action {
                    Action::CreateFile { content, .. } => Some(digest(content.as_bytes())),
                    _ => None,
                });
            let resolution = if expected.as_deref() == Some(&current) {
                "postimage_verified"
            } else if before == Some(current.as_str()) {
                "preimage_verified"
            } else {
                "file_conflict"
            };
            Ok(json!({"kind":"tool","tool":action.name(),"path":path,
                "resolution":resolution,"current_sha256":current,"expected_sha256":expected}))
        }
        Err(error) => {
            // check_new applies the same path and ignore policy before treating a file as absent.
            if let Action::CreateFile { content, .. } = &action {
                if workspace.check_new(path, content).is_ok() {
                    return Ok(json!({"kind":"tool","tool":action.name(),"path":path,
                        "resolution":"creation_absent"}));
                }
            }
            Ok(json!({"kind":"tool","tool":action.name(),"path":path,
                "resolution":"uninspectable","detail":format!("{error:#}")}))
        }
    }
}

/// Save proven evidence only. A recovered model response remains pending until agent consumes it.
pub fn reconcile(session: &mut Session, bridge: Option<&Bridge>) -> Result<Value> {
    let report = inspect(session, bridge)?;
    let pending = session.state.pending.clone();
    match report["resolution"].as_str() {
        Some("nothing_pending" | "response_saved") => return Ok(report),
        Some("completed_response_available") => {
            let pending = pending.context("Missing pending intent")?;
            let id = pending["job"].as_str().context("Missing job")?;
            let job = bridge
                .context("Missing bridge")?
                .api(&format!("/jobs/{id}"), None)?;
            ensure!(
                job["id"] == id && job["status"] == "done",
                "Job changed during recovery; no state changed"
            );
            let text = job["text"].as_str().context("Completed job lacks text")?;
            ensure!(text.len() <= 800_000, "Recovered response too large");
            let nonce = pending["nonce"]
                .as_str()
                .context("Missing response nonce")?;
            session.state.pending =
                Some(json!({"kind":"model_answer","job":id,"nonce":nonce,"answer":text}));
            session.state.status = "response_saved".into();
        }
        Some("terminal_model_error") => {
            session.state.transcript.push(json!({"kind":"recovery_model_error",
                "job":report["job"],"detail":"Bridge reports terminal failure; no local tool result was produced"}));
            session.state.pending = None;
            session.state.status = "ready".into();
        }
        Some(
            "postimage_verified" | "preimage_verified" | "creation_absent" | "read_result_lost",
        ) => {
            let pending = pending.context("Missing tool intent")?;
            let success = report["resolution"] == "postimage_verified";
            let result = json!({"status":if success {"success"} else {"error"},
                "summary":if success {"Recovery verified current file equals intended postimage"}
                    else {"Recovery has no completed tool result; use current-state evidence"},
                "data":report,"artifacts":[],
                "next_actions":"Continue from verified current state; do not infer command/test results"});
            save_tool_result(session, &pending, result)?;
        }
        _ => anyhow::bail!(
            "Intent remains uncertain ({}); inspect side effects or explicitly abandon",
            report["resolution"].as_str().unwrap_or("unknown")
        ),
    }
    session.save()?;
    session.record("recovery", report.clone())?;
    Ok(report)
}

fn save_tool_result(session: &mut Session, pending: &Value, result: Value) -> Result<()> {
    let id = pending["id"].as_str().context("Missing tool id")?;
    ensure!(!id.is_empty(), "Empty pending tool id");
    let action = &pending["action"];
    ensure!(
        !session.state.calls.contains_key(id),
        "Tool already has a result; inspect inconsistent state manually"
    );
    session
        .state
        .calls
        .insert(id.into(), json!({"action":action,"result":result}));
    session.state.transcript.push(
        json!({"kind":"tool_result","id":id,"action":action,"result":result,"recovered":true}),
    );
    session.state.pending = None;
    session.state.status = "ready".into();
    Ok(())
}

/// Acknowledgement only discards local uncertainty; it never cancels a running external job.
pub fn abandon(session: &mut Session, acknowledgement: &str) -> Result<Value> {
    ensure!(
        acknowledgement == format!("abandon {}", session.state.id),
        "Acknowledgement must be exactly: abandon {}",
        session.state.id
    );
    let pending = session.state.pending.clone().context("Nothing pending")?;
    let result = json!({"status":"error","summary":"User acknowledged abandoning an uncertain result",
        "data":{"outcome":"unknown"},"artifacts":[],
        "next_actions":"Inspect current files/processes; never claim this action succeeded or rerun its call id"});
    if pending["kind"] == "tool" {
        save_tool_result(session, &pending, result)?;
    } else {
        session.state.pending = None;
        session.state.status = "ready".into();
    }
    session
        .state
        .transcript
        .push(json!({"kind":"abandoned_intent",
        "intent":pending,"outcome":"unknown","external_job_cancelled":false}));
    session.save()?;
    let report = json!({"resolution":"abandoned","external_job_cancelled":false});
    session.record("recovery", report.clone())?;
    Ok(report)
}

/// Read the response without consuming it: agent clears pending only after durable processing.
pub fn saved_response(session: &Session) -> Result<Option<(String, String)>> {
    let Some(pending) = &session.state.pending else {
        return Ok(None);
    };
    if pending["kind"] != "model_answer" {
        return Ok(None);
    }
    Ok(Some((
        pending["nonce"].as_str().context("Missing nonce")?.into(),
        pending["answer"].as_str().context("Missing answer")?.into(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Session, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("app.txt"), "before\n").unwrap();
        let workspace = Workspace::new(&root).unwrap();
        let session =
            Session::create(&dir.path().join("state"), root, "task".into(), true, true).unwrap();
        (dir, session, workspace)
    }
    #[test]
    fn edit_recovery_verifies_postimage_without_writing_again() {
        let (_dir, mut session, workspace) = fixture();
        let action = Action::EditFile {
            path: "app.txt".into(),
            sha256: digest(b"before\n"),
            old_text: "before".into(),
            new_text: "".into(),
        };
        session.state.pending = Some(tool_intent("edit", &action, &workspace).unwrap());
        std::fs::write(workspace.root.join("app.txt"), "\n").unwrap();
        let report = reconcile(&mut session, None).unwrap();
        assert_eq!(report["resolution"], "postimage_verified");
        assert_eq!(session.state.calls["edit"]["result"]["status"], "success");
        assert_eq!(workspace.read("app.txt").unwrap(), "\n");
        assert!(session.state.pending.is_none());
    }
    #[test]
    fn conflicts_and_commands_stay_pending_until_exact_acknowledgement() {
        let (_dir, mut session, workspace) = fixture();
        let action = Action::EditFile {
            path: "app.txt".into(),
            sha256: digest(b"before\n"),
            old_text: "before".into(),
            new_text: "after".into(),
        };
        session.state.pending = Some(tool_intent("edit", &action, &workspace).unwrap());
        std::fs::write(workspace.root.join("app.txt"), "third-party edit").unwrap();
        assert!(reconcile(&mut session, None).is_err());
        assert!(session.state.pending.is_some());
        session.state.pending = Some(json!({"kind":"tool","id":"cmd","action":
            {"type":"run_command","argv":["touch","never"],"timeout_s":1}}));
        assert!(reconcile(&mut session, None).is_err());
        assert!(!workspace.root.join("never").exists());
        assert!(abandon(&mut session, "yes").is_err());
        let acknowledgement = format!("abandon {}", session.state.id);
        abandon(&mut session, &acknowledgement).unwrap();
        assert_eq!(
            session.state.calls["cmd"]["result"]["data"]["outcome"],
            "unknown"
        );
        assert!(session.state.pending.is_none());
    }
    #[test]
    fn absent_creation_and_unchanged_edit_are_current_state_evidence() {
        let (_dir, mut session, workspace) = fixture();
        let create = Action::CreateFile {
            path: "new.txt".into(),
            content: "new".into(),
        };
        session.state.pending = Some(tool_intent("create", &create, &workspace).unwrap());
        assert_eq!(
            reconcile(&mut session, None).unwrap()["resolution"],
            "creation_absent"
        );
        assert!(!workspace.root.join("new.txt").exists());
        let edit = Action::EditFile {
            path: "app.txt".into(),
            sha256: digest(b"before\n"),
            old_text: "before".into(),
            new_text: "after".into(),
        };
        session.state.pending = Some(tool_intent("edit", &edit, &workspace).unwrap());
        assert_eq!(
            reconcile(&mut session, None).unwrap()["resolution"],
            "preimage_verified"
        );
        assert_eq!(session.state.calls["edit"]["result"]["status"], "error");
    }
    #[test]
    fn completed_model_job_is_saved_for_consumption_without_submission() {
        use std::io::{Read, Write};
        let (_dir, mut session, _workspace) = fixture();
        let job_id = uuid::Uuid::new_v4().to_string();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected_path = format!("GET /jobs/{job_id} ");
        let response = json!({"id":job_id,"status":"done","text":"already generated"});
        let thread = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = vec![0; 4096];
                let len = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..len]).starts_with(&expected_path));
                let body = response.to_string();
                write!(stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body).unwrap();
            }
        });
        let bridge = Bridge::new(&format!("http://{address}"), "test".into()).unwrap();
        session.state.pending = Some(json!({"kind":"model_job","job":job_id,"nonce":"original"}));
        reconcile(&mut session, Some(&bridge)).unwrap();
        thread.join().unwrap();
        assert_eq!(
            session.state.pending.as_ref().unwrap()["kind"],
            "model_answer"
        );
        assert_eq!(
            saved_response(&session).unwrap(),
            Some(("original".into(), "already generated".into()))
        );
        assert!(session.resumable().is_ok());
        let id = session.state.id.clone();
        let base = session.dir.parent().unwrap().to_path_buf();
        drop(session);
        let loaded = Session::load(&base, &id).unwrap();
        assert_eq!(
            saved_response(&loaded).unwrap(),
            Some(("original".into(), "already generated".into()))
        );
    }
}
