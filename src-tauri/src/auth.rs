use crate::types::{AuthSession, AuthUser};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use url::Url;

pub const AUTH_PROTOCOL: &str = "aimy-meetings";
pub const AUTH_CALLBACK_URL: &str = "aimy-meetings://auth/callback";

const COGNITO_AUTHORIZE_URL: &str =
    "https://us-east-1mk2fvpvwg.auth.us-east-1.amazoncognito.com/oauth2/authorize";
const COGNITO_TOKEN_URL: &str =
    "https://us-east-1mk2fvpvwg.auth.us-east-1.amazoncognito.com/oauth2/token";
const COGNITO_CLIENT_ID: &str = "15ekjkcakreuqhhog5vh4flhvm";
const COGNITO_SCOPES: &str = "openid email profile";

const REFRESH_BUFFER_MS: i64 = 60_000;
const BROWSER_AUTH_TIMEOUT_SECS: u64 = 5 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAuthPayload {
    pub id_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AuthUser>,
}

struct PendingBrowserAuth {
    state: String,
    code_verifier: String,
    tx: oneshot::Sender<Result<AuthSession, String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshOutcome {
    Refreshed,
    Unauthorized,
    NetworkError,
}

fn create_pkce_pair() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

fn random_state() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(parts[1])
        .or_else(|_| {
            let mut padded = parts[1].replace('-', "+").replace('_', "/");
            while padded.len() % 4 != 0 {
                padded.push('=');
            }
            STANDARD.decode(padded)
        })
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn user_from_token(token: &str, fallback: Option<&AuthUser>) -> AuthUser {
    let claims = decode_jwt_payload(token);
    let email = claims
        .as_ref()
        .and_then(|c| c.get("email"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| fallback.and_then(|f| f.email.clone()));

    let name = claims
        .as_ref()
        .and_then(|c| c.get("name").or_else(|| c.get("cognito:username")))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| fallback.and_then(|f| f.name.clone()))
        .or_else(|| email.clone());

    let id = claims
        .as_ref()
        .and_then(|c| c.get("sub"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| fallback.and_then(|f| f.id.clone()));

    AuthUser { id, name, email }
}

fn expires_at_from_token(token: &str, fallback: Option<i64>) -> Option<i64> {
    if let Some(claims) = decode_jwt_payload(token) {
        if let Some(exp) = claims.get("exp").and_then(|v| v.as_i64()) {
            return Some(exp * 1000);
        }
    }
    fallback.map(|f| if f > 1_000_000_000_000 { f } else { f * 1000 })
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 || out_blob.pbData.is_null() {
            return None;
        }
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as *mut _);
        Some(slice)
    }
}

#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 || out_blob.pbData.is_null() {
            return None;
        }
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as *mut _);
        Some(slice)
    }
}

#[cfg(windows)]
fn try_decrypt_chromium_safe_storage(data_dir: &Path, raw: &[u8]) -> Option<String> {
    // Electron safeStorage on Windows prefixes ciphertexts with "v10" + 12-byte nonce + AES-256-GCM ciphertext
    if raw.len() > 15 && &raw[0..3] == b"v10" {
        let local_state_path = data_dir.join("Local State");
        if let Ok(local_state_str) = std::fs::read_to_string(&local_state_path) {
            if let Ok(ls_json) = serde_json::from_str::<serde_json::Value>(&local_state_str) {
                if let Some(enc_key_b64) = ls_json
                    .get("os_crypt")
                    .and_then(|o| o.get("encrypted_key"))
                    .and_then(|k| k.as_str())
                {
                    if let Ok(enc_key_with_prefix) = STANDARD.decode(enc_key_b64) {
                        if enc_key_with_prefix.len() > 5 && &enc_key_with_prefix[0..5] == b"DPAPI" {
                            if let Some(master_key) = dpapi_unprotect(&enc_key_with_prefix[5..]) {
                                if let Ok(cipher) = Aes256Gcm::new_from_slice(&master_key) {
                                    let nonce = Nonce::from_slice(&raw[3..15]);
                                    if let Ok(plain) = cipher.decrypt(nonce, &raw[15..]) {
                                        if let Ok(s) = String::from_utf8(plain) {
                                            return Some(s);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Also support direct DPAPI-protected bytes written by Tauri
    if let Some(plain) = dpapi_unprotect(raw) {
        if let Ok(s) = String::from_utf8(plain) {
            return Some(s);
        }
    }
    None
}

type SessionCallback = Arc<dyn Fn(AuthSession) + Send + Sync>;

struct AuthInner {
    payload: Option<StoredAuthPayload>,
    last_known_user: Option<AuthUser>,
    last_known_expires_at: Option<i64>,
    last_reason: String,
    pending_browser_auth: Option<PendingBrowserAuth>,
    embedded_tx: Option<oneshot::Sender<Result<AuthSession, String>>>,
    listeners: Vec<SessionCallback>,
}

#[derive(Clone)]
pub struct AuthManager {
    data_dir: PathBuf,
    is_online: Arc<dyn Fn() -> bool + Send + Sync>,
    inner: Arc<Mutex<AuthInner>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    client: reqwest::Client,
}

impl AuthManager {
    pub fn new<F>(data_dir: PathBuf, is_online: F) -> Self
    where
        F: Fn() -> bool + Send + Sync + 'static,
    {
        let mgr = Self {
            data_dir,
            is_online: Arc::new(is_online),
            inner: Arc::new(Mutex::new(AuthInner {
                payload: None,
                last_known_user: None,
                last_known_expires_at: None,
                last_reason: "initial".to_string(),
                pending_browser_auth: None,
                embedded_tx: None,
                listeners: Vec::new(),
            })),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            client: reqwest::Client::new(),
        };
        mgr.load_from_disk();
        mgr.start_expiry_watchdog();
        mgr
    }

    fn store_path(&self) -> PathBuf {
        self.data_dir.join("auth-session.dat")
    }

    pub fn on_change<F>(&self, cb: F)
    where
        F: Fn(AuthSession) + Send + Sync + 'static,
    {
        let mut guard = self.inner.lock().unwrap();
        guard.listeners.push(Arc::new(cb));
    }

    fn emit(&self) {
        let session = self.get_session();
        let listeners = self.inner.lock().unwrap().listeners.clone();
        for l in listeners {
            l(session.clone());
        }
    }

    fn load_from_disk(&self) {
        let path = self.store_path();
        if !path.exists() {
            return;
        }
        let raw = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return,
        };

        #[cfg(windows)]
        let json_str = try_decrypt_chromium_safe_storage(&self.data_dir, &raw)
            .or_else(|| String::from_utf8(raw).ok());

        #[cfg(not(windows))]
        let json_str = String::from_utf8(raw).ok();

        if let Some(s) = json_str {
            if let Ok(parsed) = serde_json::from_str::<StoredAuthPayload>(&s) {
                if !parsed.id_token.is_empty() {
                    let mut guard = self.inner.lock().unwrap();
                    guard.last_known_user = parsed.user.clone();
                    guard.last_known_expires_at = parsed.expires_at;
                    guard.payload = Some(parsed);
                }
            }
        }
    }

    fn save_to_disk(&self) {
        let path = self.store_path();
        let payload = self.inner.lock().unwrap().payload.clone();
        match payload {
            None => {
                if path.exists() {
                    let _ = std::fs::remove_file(path);
                }
            }
            Some(p) => {
                if let Ok(serialized) = serde_json::to_string(&p) {
                    #[cfg(windows)]
                    if let Some(enc) = dpapi_protect(serialized.as_bytes()) {
                        let _ = std::fs::write(&path, enc);
                        return;
                    }
                    let _ = std::fs::write(&path, serialized.as_bytes());
                }
            }
        }
    }

    fn start_expiry_watchdog(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                this.check_expiry_tick().await;
            }
        });
    }

    async fn check_expiry_tick(&self) {
        let (has_token, expires_at, refresh_token) = {
            let guard = self.inner.lock().unwrap();
            match guard.payload.as_ref() {
                Some(p) if !p.id_token.is_empty() => {
                    (true, p.expires_at, p.refresh_token.clone())
                }
                _ => (false, None, None),
            }
        };
        if !has_token {
            return;
        }
        let Some(exp) = expires_at else {
            return;
        };
        let now = Utc::now().timestamp_millis();
        if let Some(rt) = refresh_token {
            if exp - REFRESH_BUFFER_MS <= now {
                if !(self.is_online)() {
                    return;
                }
                if self.try_refresh_token(&rt).await == RefreshOutcome::Unauthorized {
                    self.mark_expired();
                }
            }
        } else if now >= exp {
            self.mark_expired();
        }
    }

    fn mark_expired(&self) {
        {
            let mut guard = self.inner.lock().unwrap();
            let prev_user = guard
                .payload
                .as_ref()
                .and_then(|p| p.user.clone())
                .or_else(|| guard.last_known_user.clone());
            let prev_exp = guard
                .payload
                .as_ref()
                .and_then(|p| p.expires_at)
                .or(guard.last_known_expires_at);
            guard.payload = None;
            guard.last_known_user = prev_user;
            guard.last_known_expires_at = prev_exp;
            guard.last_reason = "expired".to_string();
        }
        self.save_to_disk();
        self.emit();
    }

    pub fn set_authenticated_payload(&self, next: StoredAuthPayload, reason: &str) {
        let exp = expires_at_from_token(&next.id_token, next.expires_at);
        let user = user_from_token(&next.id_token, next.user.as_ref());
        {
            let mut guard = self.inner.lock().unwrap();
            guard.payload = Some(StoredAuthPayload {
                id_token: next.id_token,
                access_token: next.access_token,
                refresh_token: next.refresh_token,
                expires_at: exp,
                user: Some(user.clone()),
            });
            guard.last_known_user = Some(user);
            guard.last_known_expires_at = exp;
            guard.last_reason = reason.to_string();
        }
        self.save_to_disk();
        self.emit();
    }

    pub async fn initialize(&self) {
        let (has_token, exp, rt) = {
            let mut guard = self.inner.lock().unwrap();
            match guard.payload.as_ref() {
                Some(p) if !p.id_token.is_empty() => {
                    (true, p.expires_at, p.refresh_token.clone())
                }
                _ => {
                    guard.last_reason = "initial".to_string();
                    (false, None, None)
                }
            }
        };
        if !has_token {
            return;
        }
        let now = Utc::now().timestamp_millis();
        if let Some(expires_at) = exp {
            if expires_at - REFRESH_BUFFER_MS <= now {
                if let Some(refresh_token) = rt {
                    if (self.is_online)()
                        && self.try_refresh_token(&refresh_token).await
                            == RefreshOutcome::Unauthorized
                    {
                        self.mark_expired();
                    }
                    return;
                }
                if expires_at <= now {
                    self.mark_expired();
                }
            }
        }
    }

    pub async fn on_connectivity_restored(&self) {
        self.check_expiry_tick().await;
    }

    pub fn get_session(&self) -> AuthSession {
        let guard = self.inner.lock().unwrap();
        let Some(ref payload) = guard.payload else {
            let is_expired = guard.last_reason == "expired";
            return AuthSession {
                authenticated: false,
                user: if is_expired {
                    guard.last_known_user.clone()
                } else {
                    None
                },
                expires_at: if is_expired {
                    guard.last_known_expires_at
                } else {
                    None
                },
                has_refresh_token: None,
                reason: Some(guard.last_reason.clone()),
            };
        };

        let now = Utc::now().timestamp_millis();
        let expired = payload.expires_at.map(|e| e <= now).unwrap_or(false);
        if expired && payload.refresh_token.is_none() {
            return AuthSession {
                authenticated: false,
                user: payload.user.clone(),
                expires_at: payload.expires_at,
                has_refresh_token: Some(false),
                reason: Some("expired".to_string()),
            };
        }

        AuthSession {
            authenticated: true,
            user: payload.user.clone(),
            expires_at: payload.expires_at,
            has_refresh_token: Some(payload.refresh_token.is_some()),
            reason: Some(guard.last_reason.clone()),
        }
    }

    pub async fn get_valid_token(&self) -> Option<String> {
        let (id_token, expires_at, refresh_token) = {
            let guard = self.inner.lock().unwrap();
            let p = guard.payload.as_ref()?;
            (
                p.id_token.clone(),
                p.expires_at,
                p.refresh_token.clone(),
            )
        };
        let now = Utc::now().timestamp_millis();
        if let Some(exp) = expires_at {
            if exp - REFRESH_BUFFER_MS <= now {
                if let Some(rt) = refresh_token {
                    if !(self.is_online)() {
                        return None;
                    }
                    let outcome = self.try_refresh_token(&rt).await;
                    if outcome == RefreshOutcome::Refreshed {
                        return self
                            .inner
                            .lock()
                            .unwrap()
                            .payload
                            .as_ref()
                            .map(|p| p.id_token.clone());
                    }
                    if outcome == RefreshOutcome::Unauthorized {
                        self.mark_expired();
                    }
                    return None;
                }
                if exp <= now {
                    self.mark_expired();
                }
                return None;
            }
        }
        Some(id_token)
    }

    pub async fn handle_unauthorized(&self) -> Option<String> {
        let rt = {
            let guard = self.inner.lock().unwrap();
            guard.payload.as_ref()?;
            guard
                .payload
                .as_ref()
                .and_then(|p| p.refresh_token.clone())
        };
        if let Some(refresh_token) = rt {
            if (self.is_online)() {
                let outcome = self.try_refresh_token(&refresh_token).await;
                if outcome == RefreshOutcome::Refreshed {
                    return self
                        .inner
                        .lock()
                        .unwrap()
                        .payload
                        .as_ref()
                        .map(|p| p.id_token.clone());
                }
                if outcome == RefreshOutcome::NetworkError {
                    return None;
                }
            }
        }
        self.mark_expired();
        None
    }

    async fn try_refresh_token(&self, refresh_token: &str) -> RefreshOutcome {
        let _guard = self.refresh_lock.lock().await;
        let params = [
            ("grant_type", "refresh_token"),
            ("client_id", COGNITO_CLIENT_ID),
            ("refresh_token", refresh_token),
        ];

        let res = match self
            .client
            .post(COGNITO_TOKEN_URL)
            .form(&params)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return RefreshOutcome::NetworkError,
        };

        let status = res.status().as_u16();
        if status == 400 || status == 401 || status == 403 {
            return RefreshOutcome::Unauthorized;
        }
        if !res.status().is_success() {
            return RefreshOutcome::NetworkError;
        }

        #[derive(Deserialize)]
        struct TokenResp {
            id_token: Option<String>,
            access_token: Option<String>,
            refresh_token: Option<String>,
            expires_in: Option<i64>,
        }

        let Ok(data) = res.json::<TokenResp>().await else {
            return RefreshOutcome::NetworkError;
        };
        let Some(id_token) = data.id_token else {
            return RefreshOutcome::Unauthorized;
        };

        let (prev_access, prev_user) = {
            let guard = self.inner.lock().unwrap();
            (
                guard
                    .payload
                    .as_ref()
                    .and_then(|p| p.access_token.clone()),
                guard.payload.as_ref().and_then(|p| p.user.clone()),
            )
        };

        let fallback_exp = data
            .expires_in
            .map(|secs| Utc::now().timestamp_millis() + secs * 1000);
        let exp = expires_at_from_token(&id_token, fallback_exp);
        let user = user_from_token(&id_token, prev_user.as_ref());

        self.set_authenticated_payload(
            StoredAuthPayload {
                id_token,
                access_token: data.access_token.or(prev_access),
                refresh_token: Some(
                    data.refresh_token
                        .unwrap_or_else(|| refresh_token.to_string()),
                ),
                expires_at: exp,
                user: Some(user),
            },
            "signed-in",
        );

        RefreshOutcome::Refreshed
    }

    pub fn set_manual_token(&self, raw_token: &str) -> Result<AuthSession, String> {
        let trimmed = raw_token.trim();
        let token = trimmed
            .strip_prefix("Bearer ")
            .or_else(|| trimmed.strip_prefix("bearer "))
            .unwrap_or(trimmed)
            .trim();
        if token.is_empty() || token.split('.').count() < 2 {
            return Err("Please paste a valid Cognito JWT token.".to_string());
        }
        let exp = expires_at_from_token(token, None);
        if let Some(e) = exp {
            if e <= Utc::now().timestamp_millis() {
                return Err(
                    "This token is already expired. Please sign in to get a fresh token."
                        .to_string(),
                );
            }
        }
        let user = user_from_token(token, None);
        self.set_authenticated_payload(
            StoredAuthPayload {
                id_token: token.to_string(),
                access_token: None,
                refresh_token: None,
                expires_at: exp,
                user: Some(user),
            },
            "signed-in",
        );
        Ok(self.get_session())
    }

    pub fn cancel_sign_in(&self, app_handle: &AppHandle) {
        let current_session = self.get_session();
        {
            let mut guard = self.inner.lock().unwrap();
            if let Some(pending) = guard.pending_browser_auth.take() {
                let _ = pending.tx.send(Ok(current_session.clone()));
            }
            if let Some(tx) = guard.embedded_tx.take() {
                let _ = tx.send(Ok(current_session));
            }
        }
        if let Some(win) = app_handle.get_webview_window("auth-login") {
            let _ = win.close();
        }
    }

    pub fn sign_out(&self, app_handle: &AppHandle) -> AuthSession {
        self.cancel_sign_in(app_handle);
        {
            let mut guard = self.inner.lock().unwrap();
            guard.payload = None;
            guard.last_known_user = None;
            guard.last_known_expires_at = None;
            guard.last_reason = "signed-out".to_string();
        }
        self.save_to_disk();
        self.emit();
        self.get_session()
    }

    pub async fn sign_in(
        &self,
        app_handle: &AppHandle,
        console_base_url: &str,
        method: &str,
    ) -> Result<AuthSession, String> {
        if method == "embedded" {
            self.sign_in_via_embedded_window(app_handle, console_base_url)
                .await
        } else {
            self.sign_in_via_browser(app_handle).await
        }
    }

    async fn sign_in_via_browser(&self, app_handle: &AppHandle) -> Result<AuthSession, String> {
        self.cancel_sign_in(app_handle);
        let (code_verifier, code_challenge) = create_pkce_pair();
        let state = random_state();

        let mut auth_url = Url::parse(COGNITO_AUTHORIZE_URL).unwrap();
        auth_url
            .query_pairs_mut()
            .append_pair("client_id", COGNITO_CLIENT_ID)
            .append_pair("response_type", "code")
            .append_pair("scope", COGNITO_SCOPES)
            .append_pair("redirect_uri", AUTH_CALLBACK_URL)
            .append_pair("state", &state)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &code_challenge);

        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.inner.lock().unwrap();
            guard.pending_browser_auth = Some(PendingBrowserAuth {
                state: state.clone(),
                code_verifier,
                tx,
            });
        }

        if let Err(e) = app_handle.opener().open_url(auth_url.as_str(), None::<&str>) {
            let mut guard = self.inner.lock().unwrap();
            guard.pending_browser_auth = None;
            return Err(format!(
                "Could not open your default browser for sign-in: {}",
                e
            ));
        }

        match tokio::time::timeout(Duration::from_secs(BROWSER_AUTH_TIMEOUT_SECS), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Ok(self.get_session()),
            Err(_) => {
                let mut guard = self.inner.lock().unwrap();
                if guard
                    .pending_browser_auth
                    .as_ref()
                    .map(|p| p.state == state)
                    .unwrap_or(false)
                {
                    guard.pending_browser_auth = None;
                }
                Err("Browser sign-in timed out. Make sure aimy-meetings://auth/callback is allowed in Cognito, or use the built-in sign-in window.".to_string())
            }
        }
    }

    pub async fn handle_protocol_callback(&self, raw_url: &str) -> bool {
        let Ok(parsed) = Url::parse(raw_url) else {
            return false;
        };
        if parsed.scheme() != AUTH_PROTOCOL {
            return false;
        }

        let pending = {
            let mut guard = self.inner.lock().unwrap();
            guard.pending_browser_auth.take()
        };
        let Some(pending) = pending else {
            return true;
        };

        let mut error: Option<String> = None;
        let mut error_description: Option<String> = None;
        let mut state: Option<String> = None;
        let mut code: Option<String> = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "error" => error = Some(v.to_string()),
                "error_description" => error_description = Some(v.to_string()),
                "state" => state = Some(v.to_string()),
                "code" => code = Some(v.to_string()),
                _ => {}
            }
        }

        if let Some(err) = error {
            let detail = error_description.unwrap_or(err);
            let _ = pending
                .tx
                .send(Err(format!("Sign-in was rejected by Cognito: {}", detail)));
            return true;
        }

        let Some(code) = code else {
            let _ = pending.tx.send(Err(
                "Invalid sign-in callback received. Please try signing in again.".to_string(),
            ));
            return true;
        };
        if state.as_deref() != Some(pending.state.as_str()) {
            let _ = pending.tx.send(Err(
                "Invalid sign-in callback state. Please try signing in again.".to_string(),
            ));
            return true;
        }

        let params = [
            ("grant_type", "authorization_code"),
            ("client_id", COGNITO_CLIENT_ID),
            ("code", code.as_str()),
            ("redirect_uri", AUTH_CALLBACK_URL),
            ("code_verifier", pending.code_verifier.as_str()),
        ];

        let res = match self
            .client
            .post(COGNITO_TOKEN_URL)
            .form(&params)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let _ = pending.tx.send(Err(format!(
                    "Failed to exchange sign-in code with Cognito: {}",
                    e
                )));
                return true;
            }
        };

        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();

        #[derive(Deserialize)]
        struct CognitoTokenResponse {
            id_token: Option<String>,
            access_token: Option<String>,
            refresh_token: Option<String>,
            expires_in: Option<i64>,
            error: Option<String>,
            error_description: Option<String>,
        }

        let parsed_resp = serde_json::from_str::<CognitoTokenResponse>(&text).ok();
        let Some(data) = parsed_resp else {
            let _ = pending
                .tx
                .send(Err(format!("Token exchange failed with HTTP {}.", status)));
            return true;
        };
        let Some(id_token) = data.id_token else {
            let msg = data
                .error_description
                .or(data.error)
                .unwrap_or_else(|| format!("Token exchange failed with HTTP {}.", status));
            let _ = pending.tx.send(Err(msg));
            return true;
        };

        let fallback_exp = data
            .expires_in
            .map(|secs| Utc::now().timestamp_millis() + secs * 1000);
        let exp = expires_at_from_token(&id_token, fallback_exp);
        let user = user_from_token(&id_token, None);

        self.set_authenticated_payload(
            StoredAuthPayload {
                id_token,
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_at: exp,
                user: Some(user),
            },
            "signed-in",
        );

        let _ = pending.tx.send(Ok(self.get_session()));
        true
    }

    async fn sign_in_via_embedded_window(
        &self,
        app_handle: &AppHandle,
        console_base_url: &str,
    ) -> Result<AuthSession, String> {
        self.cancel_sign_in(app_handle);

        let base_url = console_base_url.trim_end_matches('/');
        let login_url = format!("{}/console", base_url);
        let parsed_url =
            Url::parse(&login_url).map_err(|e| format!("Invalid console URL: {}", e))?;
        let target_host = parsed_url.host_str().unwrap_or("").to_string();

        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.inner.lock().unwrap();
            guard.embedded_tx = Some(tx);
        }

        // Poll storage inside the embedded login window and send any token back via document.title
        // or URL fragment `#aimy_embedded_auth=<base64>` which on_navigation intercepts without needing
        // Tauri IPC capabilities on the remote origin.
        let init_script = format!(
            r#"
            (function() {{
              const TARGET_HOST = {target_host:?};
              function scanStorage() {{
                if (window.location.hostname !== TARGET_HOST) return;
                const stores = [window.sessionStorage, window.localStorage];
                for (const store of stores) {{
                  try {{
                    for (let i = 0; i < store.length; i++) {{
                      const key = store.key(i);
                      if (!key) continue;
                      if (key.startsWith('oidc.user:') || key.startsWith('CognitoIdentityServiceProvider.')) {{
                        const raw = store.getItem(key);
                        if (!raw || !raw.startsWith('{{')) continue;
                        const obj = JSON.parse(raw);
                        const idToken = obj.id_token || obj.idToken;
                        if (typeof idToken === 'string' && idToken.split('.').length === 3) {{
                          const payload = JSON.stringify({{
                            idToken: idToken,
                            accessToken: obj.access_token || obj.accessToken || null,
                            refreshToken: obj.refresh_token || obj.refreshToken || null,
                            expiresAt: obj.expires_at || null
                          }});
                          window.location.replace('aimy-meetings://embedded-token?payload=' + encodeURIComponent(payload));
                          return;
                        }}
                      }}
                    }}
                    const direct = store.getItem('oidc.id_token') || store.getItem('id_token');
                    if (direct && direct.split('.').length === 3) {{
                      const payload = JSON.stringify({{ idToken: direct }});
                      window.location.replace('aimy-meetings://embedded-token?payload=' + encodeURIComponent(payload));
                      return;
                    }}
                  }} catch (e) {{}}
                }}
              }}
              setInterval(scanStorage, 800);
              window.addEventListener('DOMContentLoaded', scanStorage);
            }})();
            "#
        );

        let auth_mgr_for_nav = self.clone();
        let app_for_nav = app_handle.clone();

        let win = WebviewWindowBuilder::new(
            app_handle,
            "auth-login",
            WebviewUrl::External(parsed_url),
        )
        .title("Sign in to AiMY Knowledge")
        .inner_size(520.0, 740.0)
        .center()
        .initialization_script(&init_script)
        .on_navigation(move |nav_url| {
            if nav_url.scheme() == AUTH_PROTOCOL && nav_url.host_str() == Some("embedded-token") {
                for (k, v) in nav_url.query_pairs() {
                    if k == "payload" {
                        if let Ok(parsed_payload) = serde_json::from_str::<StoredAuthPayload>(&v) {
                            let exp = expires_at_from_token(
                                &parsed_payload.id_token,
                                parsed_payload.expires_at,
                            );
                            let now = Utc::now().timestamp_millis();
                            if exp.map(|e| e > now + 5000).unwrap_or(true) {
                                auth_mgr_for_nav
                                    .set_authenticated_payload(parsed_payload, "signed-in");
                                let session = auth_mgr_for_nav.get_session();
                                if let Some(tx) =
                                    auth_mgr_for_nav.inner.lock().unwrap().embedded_tx.take()
                                {
                                    let _ = tx.send(Ok(session));
                                }
                                if let Some(w) = app_for_nav.get_webview_window("auth-login") {
                                    let _ = w.close();
                                }
                            }
                        }
                    }
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| format!("Failed to open sign-in window: {}", e))?;

        let auth_mgr_for_close = self.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(tx) = auth_mgr_for_close.inner.lock().unwrap().embedded_tx.take() {
                    let _ = tx.send(Err(
                        "Sign-in window was closed before completing authentication.".to_string(),
                    ));
                }
            }
        });

        match rx.await {
            Ok(res) => res,
            Err(_) => Ok(self.get_session()),
        }
    }
}
