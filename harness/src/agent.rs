use crate::{
    command,
    protocol::{self, Action, Envelope},
    provider::Bridge,
    recovery,
    session::Session,
    workspace::{digest, Workspace},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, IsTerminal, Write},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub struct Limits {
    pub turns: usize,
    pub seconds: u64,
    pub json: bool,
}

pub fn terminal_text(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            if c.is_control() && c != '\n' && c != '\t' {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}

pub fn emit(session: &Session, kind: &str, data: Value, json_mode: bool) -> Result<()> {
    let event = session.record(kind, data.clone())?;
    if json_mode {
        println!("{}", serde_json::to_string(&event)?);
    } else {
        match kind {
            "assistant_delta" => {
                print!("{}", terminal_text(data["text"].as_str().unwrap_or("")));
                io::stdout().flush()?;
            }
            "assistant_reset" => {
                println!(
                    "\n[Gemini ปรับข้อความ]\n{}",
                    terminal_text(data["text"].as_str().unwrap_or(""))
                );
            }
            "final" => {
                if data["already_displayed"] == true {
                    println!();
                } else {
                    println!("\n{}", terminal_text(data["text"].as_str().unwrap_or("")));
                }
            }
            "tool_started" => {
                eprintln!("\n[tool] {}", data["name"].as_str().unwrap_or(""));
            }
            "tool_result" => {
                eprintln!(
                    "[{}] {}",
                    data["status"].as_str().unwrap_or(""),
                    terminal_text(data["summary"].as_str().unwrap_or(""))
                );
            }
            "command_output" => {
                eprint!("{}", terminal_text(data["text"].as_str().unwrap_or("")));
            }
            "session_started" => {
                eprintln!(
                    "Argon session: {}\nWorkspace: {}",
                    session.state.id,
                    session.state.root.display()
                );
            }
            "error" | "limit" => {
                eprintln!(
                    "\nargon: {}",
                    terminal_text(data["message"].as_str().unwrap_or(""))
                );
            }
            _ => {}
        }
    }
    io::stdout().flush()?;
    Ok(())
}

fn approve(
    session: &Session,
    action: &Action,
    json_mode: bool,
    cancelled: &AtomicBool,
) -> Result<bool> {
    let value = serde_json::to_value(action)?;
    let hash = digest(serde_json::to_string(&value)?.as_bytes());
    emit(
        session,
        "approval_required",
        json!({"action":value,"sha256":hash}),
        json_mode,
    )?;
    let workspace = Workspace::new(&session.state.root)?;
    let preview = match action {
        Action::EditFile {
            path,
            sha256,
            old_text,
            new_text,
        } => Some(workspace.preview_edit(path, sha256, old_text, new_text)?),
        Action::CreateFile { path, content } => Some(workspace.preview_create(path, content)?),
        _ => None,
    };
    if let Some(diff) = preview {
        emit(session, "edit_preview", json!({"diff":diff}), json_mode)?;
        if !json_mode {
            eprintln!("{}", terminal_text(&diff));
        }
    }
    // Noninteractive use must never turn a model request into implicit approval.
    if json_mode || !io::stdin().is_terminal() {
        return Ok(false);
    }
    eprintln!(
        "\nอนุมัติการทำงานนี้เฉพาะครั้ง? workspace={}\n{}\nFingerprint: {}\nพิมพ์ yes เพื่ออนุมัติ: ",
        session.state.root.display(),
        serde_json::to_string_pretty(&value)?,
        hash
    );
    let mut line = String::new();
    let mut input = io::stdin().lock();
    #[cfg(unix)]
    {
        loop {
            ensure!(
                !cancelled.load(Ordering::SeqCst),
                "Cancelled while awaiting approval"
            );
            let mut poll = libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            };
            let n = unsafe { libc::poll(&mut poll, 1, 100) };
            if n > 0 {
                break;
            }
            if n < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error().into());
            }
        }
    }
    input.read_line(&mut line)?;
    ensure!(
        !cancelled.load(Ordering::SeqCst),
        "Cancelled while awaiting approval"
    );
    Ok(line.trim() == "yes")
}

fn tool_result(action: &Action, data: Result<Value>) -> Value {
    match data {
        Ok(value) => {
            let failed = matches!(action, Action::RunCommand { .. }) && value["success"] != true;
            json!({"status":if failed {"error"}else{"success"},"summary":if failed {format!("{} failed; inspect exit code/output",action.name())}else{format!("{} completed",action.name())},
                "data":value,"artifacts":[],"next_actions":if failed {"Read failure output before deciding next action"}else{"Continue from this evidence"}})
        }
        Err(e) => json!({"status":"error","summary":e.to_string(),"data":null,"artifacts":[],
            "next_actions":"Correct the request within policy, read current file state, or report blocked; do not repeat blindly"}),
    }
}

pub fn run(
    session: &mut Session,
    bridge: &Bridge,
    limits: &Limits,
    cancelled: &AtomicBool,
) -> Result<()> {
    session.resumable()?;
    let workspace = Workspace::new(&session.state.root)?;
    let started = Instant::now();
    emit(
        session,
        "session_started",
        json!({"turns":session.state.turns}),
        limits.json,
    )?;
    for _ in 0..limits.turns {
        ensure!(!cancelled.load(Ordering::SeqCst), "Cancelled");
        ensure!(
            started.elapsed() < Duration::from_secs(limits.seconds),
            "Session time budget reached"
        );
        let mut visible = String::new();
        let (nonce, answer) = if let Some(saved) = recovery::saved_response(session)? {
            saved
        } else {
            let nonce = Uuid::new_v4().to_string();
            let prompt = format!(
                "{}\nTASK:\n{}\nPROJECT FILES (partial):\n{}\nEVIDENCE AND PRIOR ACTIONS:\n{}",
                protocol::instructions(&nonce, session.state.editable, session.state.commands),
                session.state.task,
                workspace
                    .files()
                    .into_iter()
                    .take(160)
                    .collect::<Vec<_>>()
                    .join("\n"),
                serde_json::to_string(&session.state.transcript)?
            );
            if prompt.len() > 85_000 {
                session.state.status = "budget".into();
                session.save()?;
                emit(
                    session,
                    "limit",
                    json!({"message":"Context budget reached; session saved without silently dropping evidence"}),
                    limits.json,
                )?;
                anyhow::bail!("Context budget reached; resume requires reducing the task or starting a focused fork");
            }
            // Persist before POST: even an HTTP failure can mean the remote accepted the request.
            session.state.pending = Some(json!({"kind":"model_submit","nonce":nonce}));
            session.state.status = "waiting_model".into();
            session.save()?;
            let job = bridge.submit(&prompt)?;
            session.state.pending = Some(json!({"kind":"model_job","job":job,"nonce":nonce}));
            session.save()?;
            let remaining = Duration::from_secs(limits.seconds).saturating_sub(started.elapsed());
            let answer = bridge.wait(&job, remaining, cancelled, &mut |snapshot, status, phase| {
                let prefix = protocol::visible_prefix(snapshot);
                if prefix.starts_with(&visible) {
                    let delta = &prefix[visible.len()..];
                    if !delta.is_empty() {
                        emit(
                            session,
                            "assistant_delta",
                            json!({"text":delta,"job_id":job,"job_status":status,"job_phase":phase}),
                            limits.json,
                        )?;
                    }
                } else if prefix != visible {
                    emit(
                        session,
                        "assistant_reset",
                        json!({"text":prefix,"job_id":job,"job_status":status,"job_phase":phase}),
                        limits.json,
                    )?;
                }
                visible = prefix.into();
                Ok(())
            })?;
            session.state.pending =
                Some(json!({"kind":"model_answer","job":job,"nonce":nonce,"answer":answer}));
            session.state.status = "response_saved".into();
            session.save()?;
            (nonce, answer)
        };
        let envelope = match protocol::parse(&answer, &nonce) {
            Ok(a) => a,
            Err(error) => {
                let diagnostic = format!("{error:#}");
                let repairs = session
                    .state
                    .transcript
                    .iter()
                    .rev()
                    .take_while(|e| e["kind"] == "protocol_error")
                    .count();
                ensure!(
                    repairs < 2,
                    "Protocol failed after two repair attempts: {diagnostic}"
                );
                session.state.transcript.push(json!({"kind":"protocol_error","error":diagnostic,
                    "instruction":"Return exactly one valid envelope using the nonce in the next request; no tool was executed"}));
                session.state.pending = None;
                session.state.turns += 1;
                session.save()?;
                emit(
                    session,
                    "protocol_error",
                    json!({"message":diagnostic}),
                    limits.json,
                )?;
                continue;
            }
        };
        let Envelope { mut id, action, .. } = envelope;
        if let Action::Final { text } = &action {
            session.state.pending = None;
            session.state.turns += 1;
            session.state.status = "final".into();
            session
                .state
                .transcript
                .push(json!({"kind":"final","text":text}));
            session.save()?;
            emit(
                session,
                "final",
                json!({"text":text,"already_displayed":visible.trim()==text.trim()}),
                limits.json,
            )?;
            return Ok(());
        }
        let serialized = serde_json::to_value(&action)?;
        // Models often copy the example id literally; give a different action a fresh id.
        if session
            .state
            .calls
            .get(&id)
            .is_some_and(|saved| saved["action"] != serialized)
        {
            let base = id.clone();
            let mut n = 2;
            while session.state.calls.contains_key(&id) {
                id = format!("{base}-{n}");
                n += 1;
            }
        }
        if let Some(saved) = session.state.calls.get(&id).cloned() {
            session
                .state
                .transcript
                .push(json!({"kind":"cached_tool_result","id":id,"result":saved["result"]}));
            session.state.pending = None;
            session.state.turns += 1;
            session.save()?;
            continue;
        }
        ensure!(!cancelled.load(Ordering::SeqCst), "Cancelled before tool");
        bridge.renew()?;
        emit(
            session,
            "tool_started",
            json!({"id":id,"name":action.name()}),
            limits.json,
        )?;
        let policy_error = if action.mutates() && !session.state.editable {
            Some("Read-only mode: mutation denied")
        } else if matches!(&action, Action::RunCommand { .. }) && !session.state.commands {
            Some("Command execution is disabled")
        } else {
            None
        };
        let mut result = if let Some(error) = policy_error {
            Err(anyhow::anyhow!(error))
        } else {
            Ok(Value::Null)
        };
        if result.is_ok() {
            if let Action::CreateFile { path, content } = &action {
                result = workspace.check_new(path, content).map(|_| Value::Null);
            }
            if let Action::EditFile {
                path,
                sha256,
                old_text,
                new_text,
            } = &action
            {
                result = (|| {
                    ensure!(
                        session.state.reads.get(path) == Some(sha256),
                        "Read this exact file before editing"
                    );
                    workspace.edited(path, sha256, old_text, new_text)?;
                    Ok(Value::Null)
                })();
            }
        }
        if result.is_ok() && action.mutates() && !approve(session, &action, limits.json, cancelled)?
        {
            result = Err(anyhow::anyhow!(
                "Approval denied or no interactive terminal; no mutation executed"
            ));
        }
        if result.is_ok() {
            bridge.renew()?; // Approval may have taken long enough to lose the lease.
            ensure!(
                !cancelled.load(Ordering::SeqCst),
                "Cancelled before execution"
            );
            ensure!(
                started.elapsed() < Duration::from_secs(limits.seconds),
                "Session time budget reached"
            );
            session.state.pending = Some(recovery::tool_intent(&id, &action, &workspace)?);
            session.state.status = "running_tool".into();
            session.save()?;
            result = match &action {
                Action::CreateFile { path, content } => workspace.create(path, content),
                Action::ListFiles { path } => workspace.list(path),
                Action::ReadFile {
                    path,
                    start_line,
                    end_line,
                } => workspace.read_lines(path, *start_line, *end_line),
                Action::SearchText { query } => workspace.search(query),
                Action::GitDiff { path } => workspace.git_diff(path),
                Action::EditFile {
                    path,
                    sha256,
                    old_text,
                    new_text,
                } => workspace.edit(path, sha256, old_text, new_text),
                Action::RunCommand { argv, timeout_s } => (if session.state.command_sandbox {
                    command::run_sandboxed
                } else {
                    command::run
                })(
                    &workspace.root,
                    argv,
                    (*timeout_s)
                        .min(limits.seconds.saturating_sub(started.elapsed().as_secs()))
                        .max(1),
                    cancelled,
                    &mut |channel, text| {
                        emit(
                            session,
                            "command_output",
                            json!({"channel":channel,"text":text}),
                            limits.json,
                        )
                    },
                ),
                Action::Final { .. } => unreachable!(),
            };
        }
        if let (Action::ReadFile { path, .. }, Ok(data)) = (&action, &result) {
            session.state.reads.insert(
                path.clone(),
                data["sha256"].as_str().context("Read missing hash")?.into(),
            );
        }
        let observation = tool_result(&action, result);
        session.state.calls.insert(
            id.clone(),
            json!({"action":serialized,"result":observation}),
        );
        session
            .state
            .transcript
            .push(json!({"kind":"tool_result","id":id,"action":serialized,"result":observation}));
        session.state.pending = None;
        session.state.turns += 1;
        session.state.status = "ready".into();
        session.save()?;
        emit(session, "tool_result", observation, limits.json)?;
    }
    session.state.status = "budget".into();
    session.save()?;
    emit(
        session,
        "limit",
        json!({"message":"Model turn budget reached; session saved for resume"}),
        limits.json,
    )?;
    anyhow::bail!("Model turn budget reached; resume the saved session to continue")
}
