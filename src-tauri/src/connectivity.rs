use crate::types::ConnectivityStatus;
use chrono::Utc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use url::Url;

const OFFLINE_POLL_MS: u64 = 10_000;
const ONLINE_POLL_MS: u64 = 45_000;
const PROBE_TIMEOUT_MS: u64 = 4_000;

type StatusCallback = Arc<dyn Fn(ConnectivityStatus) + Send + Sync>;

struct Inner {
    online: bool,
    checked_at: i64,
    listeners: Vec<StatusCallback>,
    started: bool,
}

#[derive(Clone)]
pub struct ConnectivityMonitor {
    get_probe_url: Arc<dyn Fn() -> String + Send + Sync>,
    inner: Arc<Mutex<Inner>>,
    check_lock: Arc<tokio::sync::Mutex<()>>,
    client: reqwest::Client,
}

impl ConnectivityMonitor {
    pub fn new<F>(get_probe_url: F) -> Self
    where
        F: Fn() -> String + Send + Sync + 'static,
    {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(PROBE_TIMEOUT_MS))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();

        Self {
            get_probe_url: Arc::new(get_probe_url),
            inner: Arc::new(Mutex::new(Inner {
                online: true,
                checked_at: Utc::now().timestamp_millis(),
                listeners: Vec::new(),
                started: false,
            })),
            check_lock: Arc::new(tokio::sync::Mutex::new(())),
            client,
        }
    }

    pub fn is_online(&self) -> bool {
        self.inner.lock().unwrap().online
    }

    pub fn get_status(&self) -> ConnectivityStatus {
        let guard = self.inner.lock().unwrap();
        ConnectivityStatus {
            online: guard.online,
            checked_at: guard.checked_at,
        }
    }

    pub fn on_change<F>(&self, cb: F)
    where
        F: Fn(ConnectivityStatus) + Send + Sync + 'static,
    {
        let mut guard = self.inner.lock().unwrap();
        guard.listeners.push(Arc::new(cb));
    }

    pub fn start(&self) {
        {
            let mut guard = self.inner.lock().unwrap();
            if guard.started {
                return;
            }
            guard.started = true;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let is_online = this.is_online();
                let wait_ms = if is_online {
                    ONLINE_POLL_MS
                } else {
                    OFFLINE_POLL_MS
                };
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                if !this.inner.lock().unwrap().started {
                    break;
                }
                let _ = this.check_now(None).await;
            }
        });
    }

    pub fn report_network_error(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = this.check_now(None).await;
        });
    }

    pub async fn check_now(&self, browser_hint: Option<bool>) -> ConnectivityStatus {
        let _guard = self.check_lock.lock().await;
        let reachable = if browser_hint == Some(false) {
            false
        } else {
            self.probe_reachability().await
        };

        let (changed, next, listeners) = {
            let mut inner = self.inner.lock().unwrap();
            let prev = inner.online;
            inner.online = reachable;
            inner.checked_at = Utc::now().timestamp_millis();
            let next = ConnectivityStatus {
                online: inner.online,
                checked_at: inner.checked_at,
            };
            (prev != inner.online, next, inner.listeners.clone())
        };

        if changed {
            for listener in listeners {
                listener(next.clone());
            }
        }

        next
    }

    async fn probe_reachability(&self) -> bool {
        let raw_url = (self.get_probe_url)().trim().to_string();
        let mut probe_url = "https://us-east-1mk2fvpvwg.auth.us-east-1.amazoncognito.com/".to_string();
        if !raw_url.is_empty() {
            if let Ok(parsed) = Url::parse(&raw_url) {
                if let Some(host) = parsed.host_str() {
                    let scheme = parsed.scheme();
                    if let Some(port) = parsed.port() {
                        probe_url = format!("{}://{}:{}/", scheme, host, port);
                    } else {
                        probe_url = format!("{}://{}/", scheme, host);
                    }
                }
            }
        }
        self.client.head(&probe_url).send().await.is_ok()
    }
}
