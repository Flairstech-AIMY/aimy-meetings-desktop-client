use crate::types::DetectedMeeting;
use chrono::Utc;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
struct WindowCandidate {
    process_name: String,
    title: String,
}

#[derive(Debug, Clone)]
struct ProbeSnapshot {
    mic_apps: Vec<String>,
    cam_apps: Vec<String>,
    windows: Vec<WindowCandidate>,
}

const DISMISS_COOLDOWN_MS: i64 = 30 * 60 * 1000;
const POLL_INTERVAL_MS: u64 = 2500;

fn is_own_app(app_key: &str) -> bool {
    let lower = app_key.to_lowercase();
    lower.contains("aimy meetings")
        || lower.contains("aimy-meetings")
        || lower.ends_with("electron.exe")
}

fn is_teams_idle_tab(title: &str) -> bool {
    let re = Regex::new(
        r"(?i)^(activity|chat|teams|calendar|calls|files|apps|workflows|notifications|microsoft teams)(\s*\|\s*microsoft teams)?$",
    )
    .unwrap();
    re.is_match(title.trim())
}

fn is_teams_prejoin(title: &str) -> bool {
    let re = Regex::new(r"(?i)^(meeting join|join a meeting|choose your audio|pre-join)\b").unwrap();
    re.is_match(title.trim())
}

fn clean_teams_title(raw_title: &str) -> String {
    let re_ms_teams = Regex::new(r"(?i)^microsoft teams$").unwrap();
    let re_join = Regex::new(r"(?i)^meeting join$").unwrap();
    let parts: Vec<&str> = raw_title
        .split('|')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty() && !re_ms_teams.is_match(p) && !re_join.is_match(p))
        .collect();
    if let Some(first) = parts.first() {
        return (*first).to_string();
    }
    let re_suffix = Regex::new(r"(?i)\s*\|\s*Microsoft Teams.*$").unwrap();
    let s = re_suffix.replace(raw_title, "");
    let re_prefix = Regex::new(r"(?i)^Meeting\s*[-–—|]\s*").unwrap();
    re_prefix.replace(&s, "").trim().to_string()
}

#[cfg(windows)]
fn collect_windows_snapshot() -> ProbeSnapshot {
    let mic_apps = get_active_consent_apps("microphone")
        .into_iter()
        .filter(|a| !is_own_app(a))
        .collect();
    let cam_apps = get_active_consent_apps("webcam")
        .into_iter()
        .filter(|a| !is_own_app(a))
        .collect();
    let windows = enumerate_visible_windows();
    ProbeSnapshot {
        mic_apps,
        cam_apps,
        windows,
    }
}

#[cfg(not(windows))]
fn collect_windows_snapshot() -> ProbeSnapshot {
    ProbeSnapshot {
        mic_apps: Vec::new(),
        cam_apps: Vec::new(),
        windows: Vec::new(),
    }
}

#[cfg(windows)]
fn get_active_consent_apps(capability: &str) -> Vec<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let mut active = Vec::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let paths = [
        format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{}",
            capability
        ),
        format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{}\\NonPackaged",
            capability
        ),
    ];

    for base_path in &paths {
        if let Ok(base_key) = hkcu.open_subkey(base_path) {
            for sub_name in base_key.enum_keys().flatten() {
                if let Ok(sub_key) = base_key.open_subkey(&sub_name) {
                    let stop: u64 = sub_key.get_value("LastUsedTimeStop").unwrap_or(1);
                    let start: u64 = sub_key.get_value("LastUsedTimeStart").unwrap_or(0);
                    if stop == 0 && start > 0 {
                        active.push(sub_name);
                    }
                }
            }
        }
    }
    active
}

#[cfg(windows)]
fn enumerate_visible_windows() -> Vec<WindowCandidate> {
    use std::path::Path;
    use windows_sys::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 {
            return 1;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return 1;
        }
        let process_name = get_process_name(pid).unwrap_or_default();
        if !process_name.is_empty() {
            let list = &mut *(lparam as *mut Vec<WindowCandidate>);
            list.push(WindowCandidate {
                process_name,
                title,
            });
        }
        1
    }

    unsafe fn get_process_name(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        Path::new(&full)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
    }

    let mut result: Vec<WindowCandidate> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_proc),
            (&mut result as *mut Vec<WindowCandidate>) as LPARAM,
        );
    }
    result
}

struct MatchedMeeting {
    app: String,
    title: String,
    session_key: String,
    mic_active: bool,
}

type DetectedCallback = Arc<dyn Fn(DetectedMeeting) + Send + Sync>;
type EndedCallback = Arc<dyn Fn(String, bool) + Send + Sync>;

struct Inner {
    is_recording: bool,
    recording_tracks_meeting: bool,
    recording_started_at: i64,
    recording_app: Option<String>,
    enabled: bool,
    started: bool,
    active_meeting_key: Option<String>,
    active_meeting_app: Option<String>,
    missed_polls: u32,
    dismissed_until: HashMap<String, i64>,
}

#[derive(Clone)]
pub struct MeetingDetector {
    on_detected: DetectedCallback,
    on_ended: EndedCallback,
    inner: Arc<Mutex<Inner>>,
}

impl MeetingDetector {
    pub fn new<D, E>(on_detected: D, on_ended: E) -> Self
    where
        D: Fn(DetectedMeeting) + Send + Sync + 'static,
        E: Fn(String, bool) + Send + Sync + 'static,
    {
        Self {
            on_detected: Arc::new(on_detected),
            on_ended: Arc::new(on_ended),
            inner: Arc::new(Mutex::new(Inner {
                is_recording: false,
                recording_tracks_meeting: false,
                recording_started_at: 0,
                recording_app: None,
                enabled: true,
                started: false,
                active_meeting_key: None,
                active_meeting_app: None,
                missed_polls: 0,
                dismissed_until: HashMap::new(),
            })),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut guard = self.inner.lock().unwrap();
        guard.enabled = enabled;
        if !enabled {
            guard.active_meeting_key = None;
            guard.active_meeting_app = None;
        }
    }

    pub fn set_recording_active(
        &self,
        recording: bool,
        meeting_app: Option<&str>,
        title: Option<&str>,
    ) {
        let mut guard = self.inner.lock().unwrap();
        guard.is_recording = recording;
        if recording {
            guard.recording_started_at = Utc::now().timestamp_millis();
            guard.missed_polls = 0;
            let is_simulated = title.map(|t| t.contains("(Simulated)")).unwrap_or(false);
            let from_meeting_app = !is_simulated
                && meeting_app
                    .map(|a| !a.is_empty() && a != "Manual" && a != "Imported Audio")
                    .unwrap_or(false);
            guard.recording_tracks_meeting =
                from_meeting_app || guard.active_meeting_key.is_some();
            guard.recording_app = if from_meeting_app {
                meeting_app.map(|s| s.to_string())
            } else {
                guard.active_meeting_app.clone()
            };
        } else {
            guard.recording_tracks_meeting = false;
            guard.recording_started_at = 0;
            guard.recording_app = None;
            guard.missed_polls = 0;
        }
    }

    pub fn dismiss(&self, meeting_key_or_id: &str) {
        let mut guard = self.inner.lock().unwrap();
        let until = Utc::now().timestamp_millis() + DISMISS_COOLDOWN_MS;
        guard
            .dismissed_until
            .insert(meeting_key_or_id.to_string(), until);
        if let Some(active) = guard.active_meeting_key.clone() {
            guard.dismissed_until.insert(active, until);
        }
    }

    pub fn simulate_meeting(&self) -> DetectedMeeting {
        let meeting = DetectedMeeting {
            id: Uuid::new_v4().to_string(),
            app: "Microsoft Teams".to_string(),
            title: "Weekly Product Sync (Simulated)".to_string(),
            detected_at: Utc::now().to_rfc3339(),
            mic_active: true,
        };
        (self.on_detected)(meeting.clone());
        meeting
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
                tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                let should_poll = {
                    let guard = this.inner.lock().unwrap();
                    if !guard.started {
                        break;
                    }
                    guard.enabled && (!guard.is_recording || guard.recording_tracks_meeting)
                };
                if !should_poll {
                    continue;
                }
                let snapshot = tokio::task::spawn_blocking(collect_windows_snapshot)
                    .await
                    .unwrap_or(ProbeSnapshot {
                        mic_apps: Vec::new(),
                        cam_apps: Vec::new(),
                        windows: Vec::new(),
                    });
                this.process_snapshot(snapshot);
            }
        });
    }

    fn process_snapshot(&self, snapshot: ProbeSnapshot) {
        let matched = Self::find_meeting(&snapshot);
        let now = Utc::now().timestamp_millis();

        let mut fire_detected: Option<DetectedMeeting> = None;
        let mut fire_ended: Option<(String, bool)> = None;

        {
            let mut guard = self.inner.lock().unwrap();
            match matched {
                None => {
                    if guard.is_recording && guard.recording_tracks_meeting {
                        if now - guard.recording_started_at < 8000 {
                            return;
                        }
                        guard.missed_polls += 1;
                        if guard.missed_polls >= 3 {
                            let ended_app = guard
                                .recording_app
                                .clone()
                                .or_else(|| guard.active_meeting_app.clone())
                                .unwrap_or_else(|| "Meeting".to_string());
                            guard.active_meeting_key = None;
                            guard.active_meeting_app = None;
                            guard.recording_tracks_meeting = false;
                            guard.missed_polls = 0;
                            fire_ended = Some((ended_app, true));
                        }
                    } else if guard.active_meeting_key.is_some() {
                        guard.missed_polls += 1;
                        if guard.missed_polls >= 2 {
                            let ended_app = guard
                                .active_meeting_app
                                .clone()
                                .unwrap_or_else(|| "Meeting".to_string());
                            guard.active_meeting_key = None;
                            guard.active_meeting_app = None;
                            guard.missed_polls = 0;
                            fire_ended = Some((ended_app, false));
                        }
                    }
                }
                Some(m) => {
                    guard.missed_polls = 0;
                    let key = m.session_key.clone();
                    if guard.is_recording {
                        guard.active_meeting_key = Some(key);
                        guard.active_meeting_app = Some(m.app);
                        return;
                    }
                    if let Some(&until) = guard.dismissed_until.get(&key) {
                        if until > now {
                            return;
                        }
                    }
                    if guard.active_meeting_key.as_deref() == Some(key.as_str()) {
                        return;
                    }
                    guard.active_meeting_key = Some(key.clone());
                    guard.active_meeting_app = Some(m.app.clone());
                    fire_detected = Some(DetectedMeeting {
                        id: key,
                        app: m.app,
                        title: m.title,
                        detected_at: Utc::now().to_rfc3339(),
                        mic_active: m.mic_active,
                    });
                }
            }
        }

        if let Some(meeting) = fire_detected {
            (self.on_detected)(meeting);
        }
        if let Some((app, was_rec)) = fire_ended {
            (self.on_ended)(app, was_rec);
        }
    }

    fn find_meeting(snapshot: &ProbeSnapshot) -> Option<MatchedMeeting> {
        let mut active_devices: Vec<String> = Vec::new();
        for a in snapshot.mic_apps.iter().chain(snapshot.cam_apps.iter()) {
            if !active_devices.contains(a) {
                active_devices.push(a.clone());
            }
        }
        let mic_set: HashSet<String> = snapshot
            .mic_apps
            .iter()
            .map(|s| s.to_lowercase())
            .collect();

        // 1. Direct desktop meeting app actively using microphone or webcam
        for raw_app in &active_devices {
            let lower = raw_app.to_lowercase();
            let has_mic = mic_set.contains(&lower);

            if lower.contains("msteams")
                || lower.contains("ms-teams")
                || lower.ends_with("teams.exe")
            {
                let has_pre_join = snapshot.windows.iter().any(|w| {
                    let p_lower = w.process_name.to_lowercase();
                    let t_lower = w.title.to_lowercase();
                    (p_lower.contains("teams") || t_lower.contains("microsoft teams"))
                        && is_teams_prejoin(&w.title)
                });
                let teams_title = Self::find_best_teams_window_title(&snapshot.windows);
                if has_pre_join && teams_title.is_none() {
                    continue;
                }
                let title =
                    teams_title.unwrap_or_else(|| "Microsoft Teams Meeting".to_string());
                let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Microsoft Teams".to_string(),
                    title,
                    session_key: format!("teams::{}", key_suffix),
                    mic_active: has_mic,
                });
            }

            if lower.contains("zoom.exe")
                || lower.contains("cpthost.exe")
                || lower.contains("zoomus")
            {
                let win = snapshot.windows.iter().find(|w| {
                    w.process_name.to_lowercase().contains("zoom")
                        && w.title.to_lowercase().contains("meeting")
                });
                let title = win
                    .map(|w| w.title.clone())
                    .unwrap_or_else(|| "Zoom Meeting".to_string());
                let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Zoom".to_string(),
                    title,
                    session_key: format!("zoom::{}", key_suffix),
                    mic_active: has_mic,
                });
            }

            if lower.contains("slack.exe") {
                let win = snapshot.windows.iter().find(|w| {
                    w.process_name.to_lowercase().contains("slack")
                        || w.title.to_lowercase().contains("huddle")
                });
                let title = win
                    .map(|w| w.title.clone())
                    .unwrap_or_else(|| "Slack Huddle".to_string());
                let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Slack Huddle".to_string(),
                    title,
                    session_key: format!("slack::{}", key_suffix),
                    mic_active: has_mic,
                });
            }

            if lower.contains("webex")
                || lower.contains("ciscocollab")
                || lower.contains("atmgr.exe")
            {
                let win = snapshot.windows.iter().find(|w| {
                    let p = w.process_name.to_lowercase();
                    w.title.to_lowercase().contains("webex")
                        || p.contains("webex")
                        || p.contains("cisco")
                });
                let title = win
                    .map(|w| w.title.clone())
                    .unwrap_or_else(|| "Webex Meeting".to_string());
                let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Webex".to_string(),
                    title,
                    session_key: format!("webex::{}", key_suffix),
                    mic_active: has_mic,
                });
            }

            if lower.contains("discord.exe") {
                let win = snapshot
                    .windows
                    .iter()
                    .find(|w| w.process_name.to_lowercase().contains("discord"));
                let title = win
                    .map(|w| w.title.clone())
                    .unwrap_or_else(|| "Discord Call".to_string());
                let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Discord".to_string(),
                    title,
                    session_key: format!("discord::{}", key_suffix),
                    mic_active: has_mic,
                });
            }
        }

        // 2. Browser actively using microphone or webcam
        let re_browser_exe =
            Regex::new(r"(?i)(chrome|msedge|brave|firefox|opera|arc|vivaldi)\.exe").unwrap();
        let re_browser_proc =
            Regex::new(r"(?i)chrome|msedge|brave|firefox|opera|arc|vivaldi").unwrap();
        let re_gmeet =
            Regex::new(r"(?i)meet\s*[-–—]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}|google meet").unwrap();
        let re_browser_suffix =
            Regex::new(r"(?i)\s*[-–—]\s*(Google Chrome|Microsoft Edge|Brave|Firefox).*$").unwrap();

        if let Some(active_browser) = active_devices.iter().find(|a| re_browser_exe.is_match(a)) {
            let browser_mic = mic_set.contains(&active_browser.to_lowercase());
            for w in snapshot
                .windows
                .iter()
                .filter(|w| re_browser_proc.is_match(&w.process_name))
            {
                if re_gmeet.is_match(&w.title) {
                    let cleaned = re_browser_suffix.replace(&w.title, "").trim().to_string();
                    let key_suffix: String = w.title.to_lowercase().chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Google Meet".to_string(),
                        title: cleaned,
                        session_key: format!("gmeet::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }
                if w.title.to_lowercase().contains("microsoft teams")
                    && !is_teams_prejoin(&w.title)
                {
                    let cleaned = clean_teams_title(&w.title);
                    let title = if cleaned.is_empty() {
                        "Microsoft Teams (Web)".to_string()
                    } else {
                        cleaned
                    };
                    let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Microsoft Teams".to_string(),
                        title,
                        session_key: format!("teams-web::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }
                if w.title.to_lowercase().contains("zoom") {
                    let cleaned = re_browser_suffix.replace(&w.title, "").trim().to_string();
                    let key_suffix: String = w.title.to_lowercase().chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Zoom".to_string(),
                        title: cleaned,
                        session_key: format!("zoom-web::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }
                if w.title.to_lowercase().contains("huddle")
                    || w.title.to_lowercase().contains("slack")
                {
                    let cleaned = re_browser_suffix.replace(&w.title, "").trim().to_string();
                    let key_suffix: String = w.title.to_lowercase().chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Slack Huddle".to_string(),
                        title: cleaned,
                        session_key: format!("slack-web::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }
            }
        }

        // 3. Fallback: Visible window title match even when mic/cam are not active yet
        let teams_windows: Vec<WindowCandidate> = snapshot
            .windows
            .iter()
            .filter(|w| {
                w.process_name.to_lowercase().contains("teams")
                    || w.title.to_lowercase().contains("| microsoft teams")
            })
            .cloned()
            .collect();
        if teams_windows.len() >= 2 {
            if let Some(teams_meeting_title) = Self::find_best_teams_window_title(&teams_windows) {
                let key_suffix: String = teams_meeting_title
                    .to_lowercase()
                    .chars()
                    .take(64)
                    .collect();
                return Some(MatchedMeeting {
                    app: "Microsoft Teams".to_string(),
                    title: teams_meeting_title,
                    session_key: format!("teams-win::{}", key_suffix),
                    mic_active: false,
                });
            }
        }

        let re_gmeet_strict =
            Regex::new(r"(?i)meet\s*[-–—]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}").unwrap();
        for w in &snapshot.windows {
            if w.process_name.to_lowercase().contains("zoom")
                && w.title.to_lowercase().contains("zoom meeting")
            {
                let key_suffix: String = w.title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Zoom".to_string(),
                    title: w.title.clone(),
                    session_key: format!("zoom-win::{}", key_suffix),
                    mic_active: false,
                });
            }
            if re_gmeet_strict.is_match(&w.title) {
                let cleaned = re_browser_suffix.replace(&w.title, "").trim().to_string();
                let key_suffix: String = w.title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Google Meet".to_string(),
                    title: cleaned,
                    session_key: format!("gmeet-win::{}", key_suffix),
                    mic_active: false,
                });
            }
            if w.title.to_lowercase().contains("huddle")
                && (w.process_name.to_lowercase().contains("slack")
                    || w.title.to_lowercase().contains("slack"))
            {
                let key_suffix: String = w.title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Slack Huddle".to_string(),
                    title: w.title.clone(),
                    session_key: format!("slack-win::{}", key_suffix),
                    mic_active: false,
                });
            }
        }

        None
    }

    fn find_best_teams_window_title(windows: &[WindowCandidate]) -> Option<String> {
        let candidates: Vec<&WindowCandidate> = windows
            .iter()
            .filter(|w| {
                let p = w.process_name.to_lowercase();
                let t = w.title.to_lowercase();
                (p.contains("teams") || t.contains("microsoft teams"))
                    && !w.title.trim().is_empty()
                    && !is_teams_idle_tab(&w.title)
                    && !is_teams_prejoin(&w.title)
            })
            .collect();
        if candidates.is_empty() {
            return None;
        }
        let preferred = candidates
            .iter()
            .find(|w| {
                let t = w.title.to_lowercase();
                t.contains("meeting") || t.contains("call")
            })
            .or_else(|| {
                candidates
                    .iter()
                    .find(|w| w.title.to_lowercase().contains("| microsoft teams"))
            })
            .unwrap_or(&candidates[0]);
        let cleaned = clean_teams_title(&preferred.title);
        if !cleaned.is_empty() && !is_teams_idle_tab(&cleaned) {
            Some(cleaned)
        } else {
            Some(preferred.title.clone())
        }
    }
}
