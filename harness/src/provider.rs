use anyhow::{bail, ensure, Context, Result};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub struct Bridge {
    client: Client,
    pub base: String,
    token: String,
    pub lease: String,
    pub tab: u64,
}
impl Bridge {
    pub fn new(base: &str, token: String) -> Result<Self> {
        let url = reqwest::Url::parse(base)?;
        ensure!(
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "Bridge URL must be HTTP on 127.0.0.1"
        );
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
            base: base.trim_end_matches('/').into(),
            token,
            lease: String::new(),
            tab: 0,
        })
    }
    pub fn api(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}{path}", self.base);
        let request = match body {
            Some(body) => self.client.post(url).json(&body),
            None => self.client.get(url),
        };
        let response = request
            .bearer_auth(&self.token)
            .header("X-Argon-Lease", &self.lease)
            .send()?;
        let status = response.status();
        let bytes = response.bytes()?;
        ensure!(bytes.len() <= 1_000_000, "Bridge response too large");
        let result: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            status.is_success(),
            "Bridge HTTP {status}: {}",
            result.get("error").unwrap_or(&Value::Null)
        );
        Ok(result)
    }
    pub fn acquire(&mut self, session: &str, wanted: Option<u64>) -> Result<()> {
        let health = self.api("/health", None)?;
        ensure!(
            health["agentProtocol"] == 1,
            "Bridge needs update/restart for agent protocol v1"
        );
        let mut tabs = vec![];
        if let Some(clients) = health["clients"].as_array() {
            for c in clients {
                if let Some(list) = c["tabs"].as_array() {
                    for t in list {
                        if t["ready"] == true {
                            if let Some(id) = t["id"].as_u64() {
                                if !tabs.contains(&id) {
                                    tabs.push(id);
                                }
                            }
                        }
                    }
                }
            }
        }
        self.tab = match wanted {
            Some(id) => {
                ensure!(tabs.contains(&id), "Requested tab is not ready");
                id
            }
            None => {
                ensure!(
                    tabs.len() == 1,
                    "Expected one ready Gemini tab; use --tab ID to select explicitly"
                );
                tabs[0]
            }
        };
        let lease = self.api(
            "/agent/lease",
            Some(json!({"action":"acquire","session":session,"tab":self.tab})),
        )?;
        self.lease = lease["token"]
            .as_str()
            .context("Missing lease token")?
            .into();
        Ok(())
    }
    pub fn renew(&self) -> Result<()> {
        let r = self.api("/agent/lease", Some(json!({"action":"renew"})))?;
        ensure!(r["tab"] == self.tab, "Lease tab mismatch");
        Ok(())
    }
    pub fn restore(&mut self, saved: &Value, wanted: Option<u64>) -> Result<()> {
        let token = saved["token"]
            .as_str()
            .context("Saved lease missing token")?;
        ensure!(
            uuid::Uuid::parse_str(token).is_ok(),
            "Invalid saved lease token"
        );
        let tab = saved["tab"].as_u64().context("Saved lease missing tab")?;
        ensure!(
            wanted.is_none_or(|id| id == tab),
            "Cannot move an existing lease to another tab"
        );
        self.lease = token.into();
        self.tab = tab;
        if let Err(error) = self.renew() {
            self.lease.clear(); // A failed restoration must never release another owner's lease.
            return Err(error.context(
                "Cannot restore original lease; inspect bridge ownership before continuing",
            ));
        }
        Ok(())
    }
    pub fn submit(&self, prompt: &str) -> Result<String> {
        self.renew()?;
        let result = self.api(
            "/ask",
            Some(json!({"prompt":prompt,"options":{"tab":self.tab.to_string(),"newChat":true}})),
        )?;
        Ok(result["id"].as_str().context("Missing job id")?.to_owned())
    }
    pub fn wait(
        &self,
        id: &str,
        budget: Duration,
        cancelled: &AtomicBool,
        on_partial: &mut dyn FnMut(&str, &str, &str) -> Result<()>,
    ) -> Result<String> {
        let start = Instant::now();
        let mut renewal = Instant::now();
        let mut previous = String::new();
        loop {
            if cancelled.load(Ordering::SeqCst) {
                let _ = self.api(&format!("/jobs/{id}/cancel"), Some(json!({})));
                bail!("Cancelled; submitted Gemini job may still finish. Inspect it before continuing.");
            }
            ensure!(
                start.elapsed() < budget.min(Duration::from_secs(190)),
                "Gemini timeout; job {id} may still complete; do not replay"
            );
            if renewal.elapsed() > Duration::from_secs(15) {
                self.renew()?;
                renewal = Instant::now();
            }
            let job = self.api(&format!("/jobs/{id}"), None)?;
            let status = job["status"].as_str().unwrap_or("unknown");
            let phase = job["phase"].as_str().unwrap_or("unknown");
            let snapshot = job["partial"].as_str().unwrap_or("");
            if !snapshot.is_empty() && previous != snapshot {
                on_partial(snapshot, status, phase)?;
                previous = snapshot.into();
            }
            match job["status"].as_str() {
                Some("done") => {
                    let text = job["text"].as_str().context("Missing model text")?;
                    on_partial(text, status, phase)?;
                    return Ok(text.to_string());
                }
                Some("error") => bail!("Gemini job failed: {}", job["error"]),
                Some("queued" | "running") => {}
                _ => bail!("Unknown Gemini job status; do not replay"),
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        if !self.lease.is_empty() {
            let _ = self.api("/agent/lease", Some(json!({"action":"release"})));
        }
    }
}
