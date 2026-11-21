use crate::types::DetectedMeeting;
use chrono::Utc;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
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
const CONFIRM_POLLS: u32 = 2;

fn re_unread_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\(\d+\+?\)\s*").unwrap())
}

fn re_teams_idle_segment() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(activity|chat|teams|calendar|calls|meet|files|onedrive|apps|store|settings|workflows|notifications|people|contacts|planner|tasks|approvals|shifts|copilot|search|feed|home|updates|community|communities|assignments|grades|whiteboard|microsoft teams(\s*\(.*\)|\s+classic|\s+notification)?)$",
        )
        .unwrap()
    })
}

fn re_teams_prejoin() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(meeting join|join a meeting|join meeting|choose your (audio|video)|pre-join|device settings)\b",
        )
        .unwrap()
    })
}

fn re_teams_segment_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^microsoft teams(\s*\(.*\)|\s+classic|\s*[-–—].*)?$").unwrap()
    })
}

fn re_teams_join_segment() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^meeting join$").unwrap())
}

fn re_teams_meeting_prefix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^meeting\s*[-–—|]\s*").unwrap())
}

fn re_browser_exe() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(chrome|msedge|brave|firefox|opera|arc|vivaldi)\.exe").unwrap()
    })
}

fn re_browser_proc() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(chrome|msedge|brave|firefox|opera|arc|vivaldi)$").unwrap())
}

fn re_browser_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(\s+and\s+\d+\s+more\s+pages?)?(\s*[-–—]\s*(Work|Personal|InPrivate|Guest|Profile\s*\d+))?\s*[-–—]\s*(Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Firefox|Opera|Arc|Vivaldi)\s*$",
        )
        .unwrap()
    })
}

fn re_gmeet_strict() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bmeet\s*[-–—]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b").unwrap())
}

fn re_gmeet_named() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^meet\s*[-–—]\s*\S+").unwrap())
}

fn re_slack_huddle_title() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(\bhuddle\s*:|\bhuddle\s+[-–—]\s+|^slack huddle\b|\bhuddle\s*\()").unwrap()
    })
}

fn re_zoom_web_title() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bzoom\s+(meeting|webinar|workplace)\b|\bzoom\.us\b").unwrap())
}

fn is_own_app(app_key: &str) -> bool {
    let lower = app_key.to_lowercase();
    lower.contains("aimy meetings")
        || lower.contains("aimy-meetings")
        || lower.contains("aimy_meetings")
        || lower.ends_with("electron.exe")
}

fn strip_browser_suffix(title: &str) -> String {
    re_browser_suffix().replace(title.trim(), "").trim().to_string()
}

fn strip_unread_prefix(title: &str) -> String {
    re_unread_prefix().replace(title.trim(), "").trim().to_string()
}

/// Returns true when a Teams window title represents an idle navigation tab,
/// chat/channel view, store/apps page, settings page, or base Teams shell
/// rather than an active meeting/call window.
fn is_teams_idle_tab(title: &str) -> bool {
    let without_browser = strip_browser_suffix(title);
    let normalized = strip_unread_prefix(&without_browser);
    if normalized.is_empty() {
        return true;
    }
    if re_teams_idle_segment().is_match(&normalized) {
        return true;
    }

    let parts: Vec<&str> = normalized
        .split('|')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return true;
    }

    // New Microsoft Teams formats main-window titles as:
    //   "Chat | <Person/Group> | <Org> | <email> | Microsoft Teams"
    //   "Calendar | <Org> | <email> | Microsoft Teams"
    //   "Store | Microsoft Teams", "Settings | ...", "Activity | ...", etc.
    if re_teams_idle_segment().is_match(parts[0]) {
        return true;
    }

    // If every segment is just "Microsoft Teams" or a shell label, it is idle.
    parts
        .iter()
        .all(|p| re_teams_segment_suffix().is_match(p) || re_teams_idle_segment().is_match(p))
}

fn is_teams_prejoin(title: &str) -> bool {
    let without_browser = strip_browser_suffix(title);
    let normalized = strip_unread_prefix(&without_browser);
    if re_teams_prejoin().is_match(&normalized) {
        return true;
    }
    if let Some(first) = normalized.split('|').next() {
        if re_teams_prejoin().is_match(first.trim()) {
            return true;
        }
    }
    false
}

fn clean_teams_title(raw_title: &str) -> String {
    let without_browser = strip_browser_suffix(raw_title);
    let normalized = strip_unread_prefix(&without_browser);
    let parts: Vec<&str> = normalized
        .split('|')
        .map(|p| p.trim())
        .filter(|p| {
            !p.is_empty()
                && !re_teams_segment_suffix().is_match(p)
                && !re_teams_join_segment().is_match(p)
        })
        .collect();
    let candidate = parts.first().copied().unwrap_or("");
    re_teams_meeting_prefix()
        .replace(candidate, "")
        .trim()
        .to_string()
}

fn is_teams_compact_view(title: &str) -> bool {
    clean_teams_title(title)
        .to_lowercase()
        .starts_with("meeting compact view")
}

/// Returns true only when a Teams window title unmistakably represents an
/// active call/meeting UI (safe to use even when mic & webcam are inactive).
fn is_teams_explicit_meeting_window(title: &str) -> bool {
    if is_teams_idle_tab(title) || is_teams_prejoin(title) {
        return false;
    }
    let cleaned = clean_teams_title(title).to_lowercase();
    if cleaned.is_empty() {
        return false;
    }
    cleaned.starts_with("meeting compact view")
        || cleaned.starts_with("call with ")
        || cleaned.starts_with("meeting with ")
        || cleaned.starts_with("meeting in ")
        || cleaned == "meeting now"
        || cleaned.starts_with("meeting now ")
        || cleaned == "microsoft teams call in progress"
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
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        // Skip DWM-cloaked windows (suspended UWP/MSIX ghost windows & other virtual desktops)
        let mut cloaked: u32 = 0;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        );
        if hr == 0 && cloaked != 0 {
            return 1;
        }
        // Skip tiny/zero-area helper or overlay windows unless the window is minimized
        if IsIconic(hwnd) == 0 {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(hwnd, &mut rect) != 0 {
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width < 100 || height < 50 {
                    return 1;
                }
            }
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

#[derive(Debug, Clone, PartialEq, Eq)]
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
    pending_meeting_key: Option<String>,
    pending_polls: u32,
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
                pending_meeting_key: None,
                pending_polls: 0,
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
            guard.pending_meeting_key = None;
            guard.pending_polls = 0;
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
            guard.pending_meeting_key = None;
            guard.pending_polls = 0;
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
        guard.pending_meeting_key = None;
        guard.pending_polls = 0;
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
                    guard.pending_meeting_key = None;
                    guard.pending_polls = 0;
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
                        guard.pending_meeting_key = None;
                        guard.pending_polls = 0;
                        return;
                    }
                    if let Some(&until) = guard.dismissed_until.get(&key) {
                        if until > now {
                            guard.pending_meeting_key = None;
                            guard.pending_polls = 0;
                            return;
                        }
                    }
                    if guard.active_meeting_key.as_deref() == Some(key.as_str()) {
                        guard.pending_meeting_key = None;
                        guard.pending_polls = 0;
                        return;
                    }

                    // Require consecutive matching polls to ignore brief mic blips / transient popups
                    if guard.pending_meeting_key.as_deref() == Some(key.as_str()) {
                        guard.pending_polls += 1;
                    } else {
                        guard.pending_meeting_key = Some(key.clone());
                        guard.pending_polls = 1;
                    }
                    if guard.pending_polls < CONFIRM_POLLS {
                        return;
                    }

                    guard.pending_meeting_key = None;
                    guard.pending_polls = 0;
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
                let desktop_teams_windows: Vec<WindowCandidate> = snapshot
                    .windows
                    .iter()
                    .filter(|w| w.process_name.to_lowercase().contains("teams"))
                    .cloned()
                    .collect();

                // Require an actual non-idle, non-prejoin Teams window so we never fire on
                // pre-join device previews, Settings -> Devices tests, chat voice messages,
                // or stale Windows ConsentStore entries when only Chat/Calendar/Store is open.
                let Some(title) = Self::find_best_teams_window_title(&desktop_teams_windows) else {
                    continue;
                };
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
                        || re_slack_huddle_title().is_match(&w.title)
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

        // 2. Browser actively using microphone or webcam (matched strictly to that browser process)
        for active_browser in &active_devices {
            let Some(caps) = re_browser_exe().captures(active_browser) else {
                continue;
            };
            let browser_proc = caps[1].to_lowercase();
            let browser_mic = mic_set.contains(&active_browser.to_lowercase());

            for w in snapshot
                .windows
                .iter()
                .filter(|w| w.process_name.to_lowercase() == browser_proc)
            {
                let tab_title = strip_unread_prefix(&strip_browser_suffix(&w.title));
                let tab_lower = tab_title.to_lowercase();

                if re_gmeet_strict().is_match(&w.title) || re_gmeet_named().is_match(&tab_title) {
                    let key_suffix: String = tab_lower.chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Google Meet".to_string(),
                        title: tab_title,
                        session_key: format!("gmeet::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }

                if w.title.to_lowercase().contains("microsoft teams")
                    && !is_teams_idle_tab(&w.title)
                    && !is_teams_prejoin(&w.title)
                {
                    let cleaned = clean_teams_title(&w.title);
                    if !cleaned.is_empty() && !is_teams_idle_tab(&cleaned) {
                        let key_suffix: String = cleaned.to_lowercase().chars().take(64).collect();
                        return Some(MatchedMeeting {
                            app: "Microsoft Teams".to_string(),
                            title: cleaned,
                            session_key: format!("teams-web::{}", key_suffix),
                            mic_active: browser_mic,
                        });
                    }
                }

                if re_zoom_web_title().is_match(&tab_title) {
                    let key_suffix: String = tab_lower.chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Zoom".to_string(),
                        title: tab_title,
                        session_key: format!("zoom-web::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }

                if tab_lower.contains("slack") && re_slack_huddle_title().is_match(&tab_title) {
                    let key_suffix: String = tab_lower.chars().take(64).collect();
                    return Some(MatchedMeeting {
                        app: "Slack Huddle".to_string(),
                        title: tab_title,
                        session_key: format!("slack-web::{}", key_suffix),
                        mic_active: browser_mic,
                    });
                }
            }
        }

        // 3. Fallback: Unmistakable active-call window titles when mic/cam are not active
        //    (Never treat idle chats, popped-out chats, Store, or multiple Teams windows as a meeting)
        let explicit_teams: Vec<&WindowCandidate> = snapshot
            .windows
            .iter()
            .filter(|w| {
                w.process_name.to_lowercase().contains("teams")
                    && is_teams_explicit_meeting_window(&w.title)
            })
            .collect();
        if let Some(preferred) = explicit_teams
            .iter()
            .find(|w| !is_teams_compact_view(&w.title))
            .or_else(|| explicit_teams.first())
        {
            let title = clean_teams_title(&preferred.title);
            if !title.is_empty() && !is_teams_idle_tab(&title) {
                let key_suffix: String = title.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Microsoft Teams".to_string(),
                    title,
                    session_key: format!("teams-win::{}", key_suffix),
                    mic_active: false,
                });
            }
        }

        for w in &snapshot.windows {
            let proc_lower = w.process_name.to_lowercase();
            let title_lower = w.title.to_lowercase();

            if proc_lower.contains("zoom") && title_lower.contains("zoom meeting") {
                let key_suffix: String = title_lower.chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Zoom".to_string(),
                    title: w.title.clone(),
                    session_key: format!("zoom-win::{}", key_suffix),
                    mic_active: false,
                });
            }
            if re_browser_proc().is_match(&proc_lower) && re_gmeet_strict().is_match(&w.title) {
                let cleaned = strip_unread_prefix(&strip_browser_suffix(&w.title));
                let key_suffix: String = cleaned.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Google Meet".to_string(),
                    title: cleaned,
                    session_key: format!("gmeet-win::{}", key_suffix),
                    mic_active: false,
                });
            }
            if (proc_lower.contains("slack")
                || (re_browser_proc().is_match(&proc_lower) && title_lower.contains("slack")))
                && re_slack_huddle_title().is_match(&w.title)
            {
                let cleaned = strip_browser_suffix(&w.title);
                let key_suffix: String = cleaned.to_lowercase().chars().take(64).collect();
                return Some(MatchedMeeting {
                    app: "Slack Huddle".to_string(),
                    title: cleaned,
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
            .find(|w| is_teams_explicit_meeting_window(&w.title) && !is_teams_compact_view(&w.title))
            .or_else(|| {
                candidates.iter().find(|w| {
                    !is_teams_compact_view(&w.title) && {
                        let t = clean_teams_title(&w.title).to_lowercase();
                        t.contains("meeting") || t.contains("call")
                    }
                })
            })
            .or_else(|| {
                candidates.iter().find(|w| {
                    !is_teams_compact_view(&w.title)
                        && w.title.to_lowercase().contains("| microsoft teams")
                })
            })
            .or_else(|| candidates.iter().find(|w| !is_teams_compact_view(&w.title)))
            .unwrap_or(&candidates[0]);

        let cleaned = clean_teams_title(&preferred.title);
        if cleaned.is_empty() || is_teams_idle_tab(&cleaned) || is_teams_prejoin(&cleaned) {
            None
        } else {
            Some(cleaned)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn win(process_name: &str, title: &str) -> WindowCandidate {
        WindowCandidate {
            process_name: process_name.to_string(),
            title: title.to_string(),
        }
    }

    fn snap(mic: &[&str], cam: &[&str], windows: Vec<WindowCandidate>) -> ProbeSnapshot {
        ProbeSnapshot {
            mic_apps: mic.iter().map(|s| (*s).to_string()).collect(),
            cam_apps: cam.iter().map(|s| (*s).to_string()).collect(),
            windows,
        }
    }

    #[test]
    fn ignores_teams_chats_store_and_popouts_without_mic_or_cam() {
        // Exact scenarios from user screenshots: multiple Teams windows open while NOT in a meeting
        let cases = vec![
            vec![
                win(
                    "ms-teams",
                    "Chat | عرسان الجنة PRs | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
                ),
                win("ms-teams", "Microsoft Teams"),
            ],
            vec![
                win(
                    "ms-teams",
                    "Chat | Abduallah Samir Hamad Allah Abdelrahman | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
                ),
                win("ms-teams", "Microsoft Teams Notification"),
            ],
            vec![
                win(
                    "ms-teams",
                    "(4) Chat | Abduallah Samir | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
                ),
                win("ms-teams", "AiMY | Microsoft Teams"),
            ],
            vec![
                win("ms-teams", "Store | Microsoft Teams"),
                win("ms-teams", "Chat | General | Flairs Tech | mohamed@flairstech.com | Microsoft Teams"),
            ],
            vec![
                win("ms-teams", "Calendar | Flairs Tech | mohamed@flairstech.com | Microsoft Teams"),
                win("ms-teams", "Activity | Flairs Tech | mohamed@flairstech.com | Microsoft Teams"),
                win("ms-teams", "Teams | Engineering | Flairs Tech | mohamed@flairstech.com | Microsoft Teams"),
            ],
        ];

        for windows in cases {
            let s = snap(&[], &[], windows.clone());
            assert_eq!(
                MeetingDetector::find_meeting(&s),
                None,
                "should not detect meeting for idle Teams windows: {:?}",
                windows
            );
        }
    }

    #[test]
    fn ignores_teams_mic_when_only_idle_settings_or_prejoin_windows_exist() {
        // Testing mic in Settings -> Devices or recording a chat voice message or on pre-join
        let s_settings = snap(
            &["MSTeams_8wekyb3d8bbwe"],
            &[],
            vec![win(
                "ms-teams",
                "Settings | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
            )],
        );
        assert_eq!(MeetingDetector::find_meeting(&s_settings), None);

        let s_chat_voice = snap(
            &["MSTeams_8wekyb3d8bbwe"],
            &[],
            vec![win(
                "ms-teams",
                "Chat | Abduallah Samir | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
            )],
        );
        assert_eq!(MeetingDetector::find_meeting(&s_chat_voice), None);

        let s_prejoin = snap(
            &["MSTeams_8wekyb3d8bbwe"],
            &["MSTeams_8wekyb3d8bbwe"],
            vec![
                win(
                    "ms-teams",
                    "Chat | Abduallah Samir | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
                ),
                win(
                    "ms-teams",
                    "Choose your video and audio options for Weekly Sync | Microsoft Teams",
                ),
            ],
        );
        assert_eq!(MeetingDetector::find_meeting(&s_prejoin), None);
    }

    #[test]
    fn detects_real_teams_meeting_with_mic_and_ignores_chat_window() {
        let s = snap(
            &["MSTeams_8wekyb3d8bbwe"],
            &[],
            vec![
                win(
                    "ms-teams",
                    "Chat | عرسان الجنة PRs | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
                ),
                win("ms-teams", "Weekly Product Sync | Microsoft Teams"),
            ],
        );
        let matched = MeetingDetector::find_meeting(&s).expect("should detect active meeting");
        assert_eq!(matched.app, "Microsoft Teams");
        assert_eq!(matched.title, "Weekly Product Sync");
        assert!(matched.mic_active);
    }

    #[test]
    fn detects_explicit_teams_call_window_even_when_muted() {
        let s_call = snap(
            &[],
            &[],
            vec![
                win(
                    "ms-teams",
                    "Chat | Abduallah Samir | Flairs Tech | mohamed@flairstech.com | Microsoft Teams",
                ),
                win("ms-teams", "Call with Abduallah Samir | Microsoft Teams"),
            ],
        );
        let m1 = MeetingDetector::find_meeting(&s_call).expect("should detect explicit call");
        assert_eq!(m1.app, "Microsoft Teams");
        assert_eq!(m1.title, "Call with Abduallah Samir");
        assert!(!m1.mic_active);

        let s_compact = snap(
            &[],
            &[],
            vec![win("ms-teams", "Meeting compact view | Microsoft Teams")],
        );
        let m2 = MeetingDetector::find_meeting(&s_compact).expect("should detect compact view");
        assert_eq!(m2.app, "Microsoft Teams");
        assert_eq!(m2.title, "Meeting compact view");
    }

    #[test]
    fn browser_detection_does_not_cross_browsers_or_match_idle_tabs() {
        // Chrome using mic must NOT trigger on an Edge Teams tab
        let s_cross = snap(
            &["C:#Program Files#Google#Chrome#Application#chrome.exe"],
            &[],
            vec![win(
                "msedge",
                "Weekly Sync | Microsoft Teams - Work - Microsoft Edge",
            )],
        );
        assert_eq!(MeetingDetector::find_meeting(&s_cross), None);

        // Edge using mic must NOT trigger on idle Teams Chat tab, Slack chat, Zoom docs, or Meet home
        let s_idle_web = snap(
            &["C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe"],
            &[],
            vec![
                win(
                    "msedge",
                    "Chat | Abduallah Samir | Microsoft Teams - Work - Microsoft Edge",
                ),
                win("msedge", "#general - Acme - Slack - Work - Microsoft Edge"),
                win("msedge", "Zoom Pricing & Plans - Work - Microsoft Edge"),
                win("msedge", "Google Meet: Online Video Meetings - Microsoft Edge"),
            ],
        );
        assert_eq!(MeetingDetector::find_meeting(&s_idle_web), None);

        // Edge using mic WITH an active Teams web meeting tab SHOULD detect
        let s_real_web = snap(
            &["C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe"],
            &[],
            vec![win(
                "msedge",
                "Sprint Planning | Microsoft Teams - Work - Microsoft Edge",
            )],
        );
        let matched = MeetingDetector::find_meeting(&s_real_web).expect("should detect Teams web");
        assert_eq!(matched.app, "Microsoft Teams");
        assert_eq!(matched.title, "Sprint Planning");
        assert!(matched.mic_active);
    }

    #[test]
    fn detects_gmeet_zoom_and_slack_huddle_accurately() {
        let s_gmeet = snap(
            &[],
            &[],
            vec![win("chrome", "Meet - abc-defg-hij - Google Chrome")],
        );
        let m = MeetingDetector::find_meeting(&s_gmeet).expect("should detect Google Meet");
        assert_eq!(m.app, "Google Meet");
        assert_eq!(m.title, "Meet - abc-defg-hij");

        // Non-browser editor with meet code in title should not trigger
        let s_editor = snap(&[], &[], vec![win("Code", "meet - abc-defg-hij - notes.md")]);
        assert_eq!(MeetingDetector::find_meeting(&s_editor), None);

        let s_zoom = snap(&[], &[], vec![win("Zoom", "Zoom Meeting")]);
        assert_eq!(
            MeetingDetector::find_meeting(&s_zoom).map(|x| x.app),
            Some("Zoom".to_string())
        );

        let s_slack_channel = snap(&[], &[], vec![win("slack", "huddle-notes - Acme - Slack")]);
        assert_eq!(MeetingDetector::find_meeting(&s_slack_channel), None);

        let s_slack_huddle = snap(&[], &[], vec![win("slack", "Huddle: #engineering - Slack")]);
        assert_eq!(
            MeetingDetector::find_meeting(&s_slack_huddle).map(|x| x.app),
            Some("Slack Huddle".to_string())
        );
    }

    #[test]
    fn confirmation_debounce_requires_two_consecutive_polls() {
        let detected_count = Arc::new(AtomicUsize::new(0));
        let counter = detected_count.clone();
        let detector = MeetingDetector::new(
            move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            },
            |_, _| {},
        );

        let meeting_snap = snap(
            &["MSTeams_8wekyb3d8bbwe"],
            &[],
            vec![win("ms-teams", "Daily Standup | Microsoft Teams")],
        );
        let idle_snap = snap(&[], &[], vec![win("ms-teams", "Chat | John | Microsoft Teams")]);

        // Single transient poll followed by idle should NOT fire
        detector.process_snapshot(meeting_snap.clone());
        assert_eq!(detected_count.load(Ordering::SeqCst), 0);
        detector.process_snapshot(idle_snap);
        assert_eq!(detected_count.load(Ordering::SeqCst), 0);

        // Two consecutive polls SHOULD fire exactly once
        detector.process_snapshot(meeting_snap.clone());
        assert_eq!(detected_count.load(Ordering::SeqCst), 0);
        detector.process_snapshot(meeting_snap.clone());
        assert_eq!(detected_count.load(Ordering::SeqCst), 1);
        detector.process_snapshot(meeting_snap);
        assert_eq!(detected_count.load(Ordering::SeqCst), 1);
    }
}
