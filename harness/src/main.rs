mod agent;
mod command;
mod protocol;
mod provider;
mod recovery;
mod sandbox;
mod session;
mod workspace;

use anyhow::{ensure, Context, Result};
use clap::{Parser, Subcommand};
use serde_json::json;
use std::{
    env, fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

#[derive(Parser)]
#[command(
    version,
    about = "Argon local agent harness (experimental Gemini Web provider)"
)]
struct Cli {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    Agent {
        #[arg(required=true,num_args=1..)]
        task: Vec<String>,
        #[arg(long, conflicts_with = "allow_edit")]
        read_only: bool,
        #[arg(long)]
        allow_edit: bool,
        #[arg(long, requires = "allow_edit")]
        allow_commands: bool,
        #[arg(long, requires = "allow_commands")]
        no_sandbox: bool,
        #[arg(long)]
        tab: Option<u64>,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u16).range(1..=100))]
        max_turns: u16,
        #[arg(long,default_value_t=900,value_parser=clap::value_parser!(u64).range(1..=3600))]
        max_seconds: u64,
    },
    Sessions,
    Recover {
        id: String,
        #[arg(long, conflicts_with = "abandon")]
        reconcile: bool,
        #[arg(long)]
        abandon: Option<String>,
    },
    Resume {
        id: String,
        #[arg(long)]
        tab: Option<u64>,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u16).range(1..=100))]
        max_turns: u16,
        #[arg(long)]
        no_sandbox: bool,
    },
    Fork {
        id: String,
        #[arg(long)]
        task: Option<String>,
    },
}

fn installation() -> Result<PathBuf> {
    if let Some(path) = env::var_os("ARGON_ROOT") {
        return Ok(PathBuf::from(path));
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .context("Cannot find home")?;
    Ok(PathBuf::from(home).join(".gemini/config/skills/argon"))
}
fn state_dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path);
    }
    if let Some(path) = env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("argon/sessions"));
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .context("Cannot find home")?;
    Ok(PathBuf::from(home).join(".local/state/argon/sessions"))
}
fn connection() -> Result<provider::Bridge> {
    let root = installation()?;
    let token = fs::read_to_string(root.join("bridge/token"))
        .context("Missing bridge pairing token; run installer")?;
    provider::Bridge::new(
        &env::var("ARGON_BRIDGE_URL").unwrap_or_else(|_| "http://127.0.0.1:8989".into()),
        token.trim().into(),
    )
}

fn execute(
    mut s: session::Session,
    tab: Option<u64>,
    turns: u16,
    seconds: u64,
    json_mode: bool,
    cancelled: &AtomicBool,
) -> Result<()> {
    s.resumable()?;
    if s.state.commands && s.state.command_sandbox {
        sandbox::probe(&s.state.root)?;
    }
    let mut bridge = connection()?;
    if let Some(saved) = &s.state.bridge_lease {
        let health = bridge.api("/health", None)?;
        if health["agentLeased"] == true {
            bridge.restore(saved, tab)?;
        } else {
            bridge.acquire(&s.state.id, tab)?;
        }
    } else {
        bridge.acquire(&s.state.id, tab)?;
    }
    s.state.bridge_lease = Some(json!({"token":bridge.lease,"tab":bridge.tab}));
    s.save()?;
    let result = agent::run(
        &mut s,
        &bridge,
        &agent::Limits {
            turns: turns as usize,
            seconds,
            json: json_mode,
        },
        cancelled,
    );
    if let Err(error) = &result {
        if s.state.status != "budget" && s.state.status != "final" {
            s.state.status = if s.state.pending.is_some() {
                "uncertain"
            } else {
                "failed"
            }
            .into();
        }
        s.save()?;
        agent::emit(&s, "error", json!({"message":error.to_string()}), json_mode)?;
    }
    result
}
fn main() -> Result<()> {
    let cli = Cli::parse();
    let base = state_dir(cli.state_dir)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    ctrlc::set_handler(move || flag.store(true, std::sync::atomic::Ordering::SeqCst))?;
    match cli.command {
        Commands::Agent {
            task,
            read_only: _,
            allow_edit,
            allow_commands,
            no_sandbox,
            tab,
            max_turns,
            max_seconds,
        } => {
            let workspace = workspace::Workspace::new(&env::current_dir()?)?;
            let task = task.join(" ");
            ensure!(
                !task.trim().is_empty() && task.len() <= 16000,
                "Task must be 1..16000 bytes"
            );
            let mut s =
                session::Session::create(&base, workspace.root, task, allow_edit, allow_commands)?;
            s.state.command_sandbox = allow_commands && !no_sandbox;
            s.save()?;
            execute(s, tab, max_turns, max_seconds, cli.json, &cancelled)
        }
        Commands::Sessions => {
            let sessions = session::list(&base)?;
            if cli.json {
                println!("{}", serde_json::to_string(&sessions)?);
            } else {
                for s in sessions {
                    println!(
                        "{}  {}  {}  {}",
                        s["id"].as_str().unwrap_or(""),
                        s["status"].as_str().unwrap_or(""),
                        agent::terminal_text(s["root"].as_str().unwrap_or("")),
                        agent::terminal_text(s["task"].as_str().unwrap_or(""))
                    );
                }
            }
            Ok(())
        }
        Commands::Recover {
            id,
            reconcile,
            abandon,
        } => {
            let mut session = session::Session::load(&base, &id)?;
            let report = if let Some(acknowledgement) = abandon {
                recovery::abandon(&mut session, &acknowledgement)?
            } else {
                let requires_bridge = session
                    .state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending["kind"] == "model_job");
                let bridge = if requires_bridge {
                    Some(connection()?)
                } else {
                    None
                };
                if reconcile {
                    recovery::reconcile(&mut session, bridge.as_ref())?
                } else {
                    recovery::inspect(&session, bridge.as_ref())?
                }
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Commands::Resume {
            id,
            tab,
            max_turns,
            no_sandbox,
        } => {
            let mut session = session::Session::load(&base, &id)?;
            if no_sandbox {
                ensure!(
                    session.state.commands,
                    "This session has command execution disabled"
                );
                session.state.command_sandbox = false;
                session.save()?;
            }
            execute(session, tab, max_turns, 900, cli.json, &cancelled)
        }
        Commands::Fork { id, task } => {
            let parent = session::Session::load(&base, &id)?;
            ensure!(
                parent.state.pending.is_none(),
                "Uncertain session cannot be forked automatically; inspect/reconcile it first"
            );
            let mut fork = session::Session::create(
                &base,
                parent.state.root.clone(),
                task.unwrap_or(parent.state.task.clone()),
                false,
                false,
            )?;
            fork.state.parent = Some(id);
            fork.state.transcript = parent.state.transcript.clone();
            fork.state.reads = parent.state.reads.clone();
            fork.save()?;
            println!("{}", fork.state.id);
            Ok(())
        }
    }
}
