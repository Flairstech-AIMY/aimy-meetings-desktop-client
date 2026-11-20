#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aimy_api;
mod audio_capture;
mod audio_enhancer;
mod auth;
mod connectivity;
mod meeting_detector;
mod prompt_window;
mod recorder_store;
mod sync_manager;
mod types;

use crate::aimy_api::AimyApiClient;
use crate::audio_capture::{
    AudioCaptureManager, NativeCaptureStartOptions, NativeCaptureStartResult,
    NativeCaptureStopResult,
};
use crate::audio_enhancer::{check_deep_filter_available, check_ffmpeg_available};
use crate::auth::{AuthManager, AUTH_CALLBACK_URL, AUTH_PROTOCOL};
use crate::connectivity::ConnectivityMonitor;
use crate::meeting_detector::MeetingDetector;
use crate::prompt_window::PromptWindowManager;
use crate::recorder_store::RecorderStore;
use crate::sync_manager::SyncManager;
use crate::types::{
    AimyAgent, AimyDocumentType, AimyGroup, AppSettings, AuthSession, ConnectivityStatus,
    CreateRecordingInput, DeleteResult, DetectedMeeting, RecordingItem, StartRecordingRequest,
    SyncAllPendingResult, UpdateRecordingPatch,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
    store: RecorderStore,
    connectivity: ConnectivityMonitor,
    auth: AuthManager,
    api: AimyApiClient,
    sync: SyncManager,
    prompt: PromptWindowManager,
    detector: MeetingDetector,
    capture: AudioCaptureManager,
    is_quitting: Arc<AtomicBool>,
    is_recording: Arc<AtomicBool>,
    active_recording_title: Arc<Mutex<String>>,
    current_live_meeting: Arc<Mutex<Option<DetectedMeeting>>>,
}

fn resolve_user_data_dir(app_handle: &AppHandle) -> PathBuf {
    // Keep the exact same "%APPDATA%\AiMY Meetings" directory as the Electron version
    // so existing recordings, settings, and sessions carry over seamlessly.
    if let Ok(roaming) = app_handle.path().data_dir() {
        return roaming.join("AiMY Meetings");
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("AiMY Meetings");
    }
    PathBuf::from("AiMY Meetings")
}

fn extract_deep_link_from_argv(args: &[String]) -> Option<String> {
    let prefix = format!("{}://", AUTH_PROTOCOL);
    args.iter()
        .find(|a| a.to_lowercase().starts_with(&prefix))
        .cloned()
}

fn show_main_window(app_handle: &AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn broadcast_to_main<S: serde::Serialize + Clone>(
    app_handle: &AppHandle,
    event: &str,
    payload: S,
) {
    let _ = app_handle.emit(event, payload);
}

fn load_tray_icon(recording: bool) -> Image<'static> {
    let bytes: &[u8] = if recording {
        include_bytes!("../../resources/tray-recording.png")
    } else {
        include_bytes!("../../resources/tray-idle.png")
    };
    Image::from_bytes(bytes).expect("valid embedded tray PNG")
}

fn update_tray(app_handle: &AppHandle) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let Some(tray) = app_handle.tray_by_id("main-tray") else {
        return;
    };

    let recording = state.is_recording.load(Ordering::Relaxed);
    let title = state.active_recording_title.lock().unwrap().clone();
    let _ = tray.set_icon(Some(load_tray_icon(recording)));
    let tooltip = if recording {
        format!(
            "AiMY Meetings Desktop Client — Recording: {}",
            if title.is_empty() {
                "Active meeting"
            } else {
                &title
            }
        )
    } else {
        "AiMY Meetings Desktop Client — Ready".to_string()
    };
    let _ = tray.set_tooltip(Some(&tooltip));

    let pending_count = state
        .store
        .list_recordings()
        .iter()
        .filter(|r| r.sync_status == "LOCAL_PENDING" || r.sync_status == "FAILED")
        .count();

    let open_item =
        MenuItemBuilder::with_id("open", "Open AiMY Meetings Desktop Client").build(app_handle);
    let rec_item = if recording {
        MenuItemBuilder::with_id("stop_rec", "Stop Recording").build(app_handle)
    } else {
        MenuItemBuilder::with_id("start_rec", "Start New Recording").build(app_handle)
    };
    let sync_label = if pending_count > 0 {
        format!("Sync Pending ({})", pending_count)
    } else {
        "Refresh Sync Status".to_string()
    };
    let sync_item = MenuItemBuilder::with_id("sync", sync_label).build(app_handle);
    let console_item =
        MenuItemBuilder::with_id("console", "Open AiMY Knowledge Console").build(app_handle);
    let quit_item =
        MenuItemBuilder::with_id("quit", "Quit AiMY Meetings Desktop Client").build(app_handle);

    if let (Ok(open_i), Ok(rec_i), Ok(sync_i), Ok(console_i), Ok(quit_i)) =
        (open_item, rec_item, sync_item, console_item, quit_item)
    {
        if let Ok(menu) = MenuBuilder::new(app_handle)
            .item(&open_i)
            .separator()
            .item(&rec_i)
            .item(&sync_i)
            .separator()
            .item(&console_i)
            .separator()
            .item(&quit_i)
            .build()
        {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
async fn auth_get_session(state: State<'_, AppState>) -> Result<AuthSession, String> {
    Ok(state.auth.get_session())
}

#[tauri::command]
async fn auth_sign_in(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    method: Option<String>,
) -> Result<AuthSession, String> {
    let console_base_url = state.store.get_settings().console_base_url;
    state
        .auth
        .sign_in(
            &app_handle,
            &console_base_url,
            method.as_deref().unwrap_or("browser"),
        )
        .await
}

#[tauri::command]
async fn auth_cancel_sign_in(app_handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.auth.cancel_sign_in(&app_handle);
    Ok(())
}

#[tauri::command]
async fn auth_sign_out(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<AuthSession, String> {
    Ok(state.auth.sign_out(&app_handle))
}

#[tauri::command]
async fn auth_set_manual_token(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthSession, String> {
    state.auth.set_manual_token(&token)
}

#[tauri::command]
async fn auth_callback_url() -> Result<String, String> {
    Ok(AUTH_CALLBACK_URL.to_string())
}

#[tauri::command]
async fn connectivity_get(state: State<'_, AppState>) -> Result<ConnectivityStatus, String> {
    Ok(state.connectivity.get_status())
}

#[tauri::command]
async fn connectivity_report_browser_status(
    state: State<'_, AppState>,
    online: bool,
) -> Result<ConnectivityStatus, String> {
    Ok(state.connectivity.check_now(Some(online)).await)
}

#[tauri::command]
async fn aimy_list_groups(state: State<'_, AppState>) -> Result<Vec<AimyGroup>, String> {
    state.api.list_groups().await.map_err(|e| e.detail)
}

#[tauri::command]
async fn aimy_list_agents(
    state: State<'_, AppState>,
    group_id: i64,
) -> Result<Vec<AimyAgent>, String> {
    state.api.list_agents(group_id).await.map_err(|e| e.detail)
}

#[tauri::command]
async fn aimy_list_document_types(
    state: State<'_, AppState>,
) -> Result<Vec<AimyDocumentType>, String> {
    state.api.list_document_types().await.map_err(|e| e.detail)
}

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.store.get_settings())
}

#[tauri::command]
async fn settings_update(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let prev = state.store.get_settings();
    let updated = state.store.update_settings(patch);
    state.detector.set_enabled(updated.detect_meetings);
    if updated.default_group_id.is_some()
        && updated.default_group_id != prev.default_group_id
        && updated.auto_sync_after_recording
        && state.connectivity.is_online()
        && state.auth.get_session().authenticated
    {
        let sync = state.sync.clone();
        tauri::async_runtime::spawn(async move {
            let _ = sync.sync_all_pending(true).await;
        });
    }
    Ok(updated)
}

#[tauri::command]
async fn recordings_list(state: State<'_, AppState>) -> Result<Vec<RecordingItem>, String> {
    Ok(state.store.list_recordings())
}

#[tauri::command]
async fn recordings_create(
    state: State<'_, AppState>,
    input: CreateRecordingInput,
) -> Result<RecordingItem, String> {
    Ok(state.store.create_recording_entry(input))
}

#[tauri::command]
async fn recordings_save_audio(
    state: State<'_, AppState>,
    id: String,
    audio_bytes: Vec<u8>,
    input_ext: String,
    duration_seconds: i64,
    notes: Option<String>,
) -> Result<RecordingItem, String> {
    let saved = state
        .store
        .save_captured_audio(&id, &audio_bytes, &input_ext, duration_seconds, notes)
        .await?;
    trigger_auto_sync_if_enabled(&state, &saved);
    Ok(saved)
}

#[tauri::command]
async fn recordings_save_native_capture(
    state: State<'_, AppState>,
    id: String,
    temp_wav_path: String,
    duration_seconds: i64,
    notes: Option<String>,
) -> Result<RecordingItem, String> {
    let src = PathBuf::from(&temp_wav_path);
    if !src.exists() {
        return Err("Captured audio file not found.".to_string());
    }
    let dest_raw = state.store.recordings_dir().join(format!("{}.wav", id));
    let _ = std::fs::create_dir_all(state.store.recordings_dir());
    if std::fs::rename(&src, &dest_raw).is_err() {
        std::fs::copy(&src, &dest_raw)
            .map_err(|e| format!("Failed to move captured audio file: {}", e))?;
        let _ = std::fs::remove_file(&src);
    }

    let saved = state
        .store
        .save_captured_audio_from_path(&id, &dest_raw, ".wav", duration_seconds, notes)
        .await?;
    trigger_auto_sync_if_enabled(&state, &saved);
    Ok(saved)
}

fn trigger_auto_sync_if_enabled(state: &AppState, saved: &RecordingItem) {
    let settings = state.store.get_settings();
    if settings.auto_sync_after_recording
        && state.connectivity.is_online()
        && state.auth.get_session().authenticated
        && (saved.group_id.is_some() || settings.default_group_id.is_some())
    {
        let sync = state.sync.clone();
        let rec_id = saved.id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = sync.sync_recording(&rec_id).await;
        });
    }
}

#[tauri::command]
async fn recordings_import_audio(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<RecordingItem>, String> {
    let picked = tokio::task::spawn_blocking(move || {
        app_handle
            .dialog()
            .file()
            .set_title("Import Meeting Recording")
            .add_filter(
                "Audio / Video Recordings",
                &["mp3", "wav", "m4a", "mp4", "mov", "webm", "ogg"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path_buf = file_path.into_path().map_err(|e| e.to_string())?;
    let imported = state.store.import_local_file(&path_buf).await?;
    Ok(Some(imported))
}

#[tauri::command]
async fn recordings_update(
    state: State<'_, AppState>,
    id: String,
    patch: UpdateRecordingPatch,
) -> Result<RecordingItem, String> {
    state.store.update_recording_metadata(&id, patch)
}

#[tauri::command]
async fn recordings_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<DeleteResult, String> {
    state.store.delete_recording(&id);
    Ok(DeleteResult { ok: true })
}

#[tauri::command]
async fn recordings_audio_path(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let Some(item) = state.store.get_recording(&id) else {
        return Ok(None);
    };
    let Some(path) = item.audio_path else {
        return Ok(None);
    };
    if !Path::new(&path).exists() {
        return Ok(None);
    }
    Ok(Some(path))
}

#[tauri::command]
async fn recordings_enhance_audio(
    state: State<'_, AppState>,
    id: String,
) -> Result<RecordingItem, String> {
    state.store.enhance_existing_recording(&id).await
}

#[tauri::command]
async fn recordings_reveal(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if let Some(item) = state.store.get_recording(&id) {
        if let Some(path) = item.audio_path {
            if Path::new(&path).exists() {
                let _ = app_handle.opener().reveal_item_in_dir(path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn sync_one(state: State<'_, AppState>, id: String) -> Result<RecordingItem, String> {
    state.sync.sync_recording(&id).await
}

#[tauri::command]
async fn sync_all_pending(state: State<'_, AppState>) -> Result<SyncAllPendingResult, String> {
    Ok(state.sync.sync_all_pending(false).await)
}

#[tauri::command]
async fn sync_index(state: State<'_, AppState>, id: String) -> Result<RecordingItem, String> {
    state.sync.index_recording(&id).await
}

#[tauri::command]
async fn sync_refresh_one(state: State<'_, AppState>, id: String) -> Result<RecordingItem, String> {
    state.sync.refresh_recording_status(&id).await
}

#[tauri::command]
async fn sync_refresh_all(state: State<'_, AppState>) -> Result<Vec<RecordingItem>, String> {
    Ok(state.sync.refresh_all_statuses().await)
}

#[tauri::command]
async fn sync_transcribe_clip(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let item = state
        .store
        .get_recording(&id)
        .ok_or_else(|| "Recording not found.".to_string())?;
    let path = item
        .audio_path
        .filter(|p| Path::new(p).exists())
        .ok_or_else(|| "Local audio file not found.".to_string())?;
    state
        .api
        .transcribe_voice_clip(&path)
        .await
        .map_err(|e| e.detail)
}

#[tauri::command]
async fn meeting_get_active(
    state: State<'_, AppState>,
) -> Result<Option<DetectedMeeting>, String> {
    Ok(state.prompt.get_active_meeting())
}

#[tauri::command]
async fn meeting_get_live(state: State<'_, AppState>) -> Result<Option<DetectedMeeting>, String> {
    Ok(state.current_live_meeting.lock().unwrap().clone())
}

#[tauri::command]
async fn meeting_accept(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    meeting: DetectedMeeting,
) -> Result<(), String> {
    state.prompt.hide(&app_handle);
    state.detector.dismiss(&meeting.id);
    show_main_window(&app_handle);
    let title = if meeting.title.is_empty() {
        format!("{} Meeting", meeting.app)
    } else {
        meeting.title.clone()
    };
    broadcast_to_main(
        &app_handle,
        "recording:start-requested",
        StartRecordingRequest {
            title: Some(title),
            meeting_app: Some(meeting.app),
            meeting_window_title: Some(meeting.title),
            meeting_id: Some(meeting.id),
        },
    );
    Ok(())
}

#[tauri::command]
async fn meeting_dismiss(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    state.detector.dismiss(&meeting_id);
    state.prompt.hide(&app_handle);
    Ok(())
}

#[tauri::command]
async fn meeting_hide_prompt(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.prompt.hide(&app_handle);
    Ok(())
}

#[tauri::command]
async fn meeting_simulate(state: State<'_, AppState>) -> Result<DetectedMeeting, String> {
    Ok(state.detector.simulate_meeting())
}

#[tauri::command]
async fn recording_set_state(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    recording: bool,
    title: Option<String>,
    meeting_app: Option<String>,
) -> Result<(), String> {
    state.is_recording.store(recording, Ordering::SeqCst);
    *state.active_recording_title.lock().unwrap() = title.clone().unwrap_or_default();
    state
        .detector
        .set_recording_active(recording, meeting_app.as_deref(), title.as_deref());
    update_tray(&app_handle);
    Ok(())
}

#[tauri::command]
async fn capture_start(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    options: NativeCaptureStartOptions,
) -> Result<NativeCaptureStartResult, String> {
    state.capture.start(app_handle, options).await
}

#[tauri::command]
async fn capture_pause(state: State<'_, AppState>) -> Result<(), String> {
    state.capture.pause();
    Ok(())
}

#[tauri::command]
async fn capture_resume(state: State<'_, AppState>) -> Result<(), String> {
    state.capture.resume();
    Ok(())
}

#[tauri::command]
async fn capture_abort(state: State<'_, AppState>) -> Result<(), String> {
    state.capture.abort();
    Ok(())
}

#[tauri::command]
async fn capture_stop(state: State<'_, AppState>) -> Result<NativeCaptureStopResult, String> {
    state.capture.stop().await
}

#[tauri::command]
async fn shell_open_external(app_handle: AppHandle, url: String) -> Result<(), String> {
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn system_check_ffmpeg() -> Result<bool, String> {
    Ok(check_ffmpeg_available().await)
}

#[tauri::command]
async fn system_check_deepfilter(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(check_deep_filter_available(state.store.resource_dir()).await)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(deep_link) = extract_deep_link_from_argv(&argv) {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_clone.try_state::<AppState>() {
                        if state.auth.handle_protocol_callback(&deep_link).await {
                            show_main_window(&app_clone);
                        }
                    }
                });
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Register aimy-meetings:// custom URI scheme in HKCU on Windows (works even for portable builds)
            let _ = app.deep_link().register_all();

            let data_dir = resolve_user_data_dir(&app_handle);
            let resource_dir = app_handle.path().resource_dir().ok();

            let store = RecorderStore::new(data_dir.clone(), resource_dir);

            // Grant asset:// protocol read access to the user's recordings folder
            let _ = app_handle
                .asset_protocol_scope()
                .allow_directory(store.recordings_dir(), true);

            let store_for_probe = store.clone();
            let connectivity = ConnectivityMonitor::new(move || {
                store_for_probe.get_settings().console_base_url
            });

            let conn_for_auth = connectivity.clone();
            let auth = AuthManager::new(data_dir, move || conn_for_auth.is_online());

            let store_for_api = store.clone();
            let auth_for_token = auth.clone();
            let auth_for_unauth = auth.clone();
            let conn_for_api = connectivity.clone();
            let api = AimyApiClient::new(
                Arc::new(move || store_for_api.get_settings().api_base_url),
                Arc::new(move || {
                    let a = auth_for_token.clone();
                    Box::pin(async move { a.get_valid_token().await })
                }),
                Arc::new(move || {
                    let a = auth_for_unauth.clone();
                    Box::pin(async move { a.handle_unauthorized().await })
                }),
                Arc::new(move || conn_for_api.report_network_error()),
            );

            let conn_for_sync = connectivity.clone();
            let auth_for_sync = auth.clone();
            let sync = SyncManager::new(
                store.clone(),
                api.clone(),
                Arc::new(move || conn_for_sync.is_online()),
                Arc::new(move || auth_for_sync.get_session().authenticated),
                app_handle.clone(),
            );

            let prompt = PromptWindowManager::new();
            let capture = AudioCaptureManager::new();
            let is_quitting = Arc::new(AtomicBool::new(false));
            let is_recording = Arc::new(AtomicBool::new(false));
            let active_recording_title = Arc::new(Mutex::new(String::new()));
            let current_live_meeting: Arc<Mutex<Option<DetectedMeeting>>> =
                Arc::new(Mutex::new(None));

            let live_for_det = current_live_meeting.clone();
            let app_for_det = app_handle.clone();
            let store_for_det = store.clone();
            let prompt_for_det = prompt.clone();

            let live_for_end = current_live_meeting.clone();
            let app_for_end = app_handle.clone();
            let store_for_end = store.clone();
            let prompt_for_end = prompt.clone();
            let is_rec_for_end = is_recording.clone();

            let detector = MeetingDetector::new(
                move |meeting| {
                    *live_for_det.lock().unwrap() = Some(meeting.clone());
                    broadcast_to_main(&app_for_det, "meeting:live-changed", Some(meeting.clone()));
                    let settings = store_for_det.get_settings();
                    if settings.auto_record_on_meeting {
                        if let Some(st) = app_for_det.try_state::<AppState>() {
                            st.detector.dismiss(&meeting.id);
                        }
                        show_main_window(&app_for_det);
                        let title = if meeting.title.is_empty() {
                            format!("{} Meeting", meeting.app)
                        } else {
                            meeting.title.clone()
                        };
                        broadcast_to_main(
                            &app_for_det,
                            "recording:start-requested",
                            StartRecordingRequest {
                                title: Some(title),
                                meeting_app: Some(meeting.app),
                                meeting_window_title: Some(meeting.title),
                                meeting_id: Some(meeting.id),
                            },
                        );
                    } else {
                        prompt_for_det.show(&app_for_det, meeting);
                    }
                },
                move |_ended_app, was_recording| {
                    *live_for_end.lock().unwrap() = None;
                    broadcast_to_main(
                        &app_for_end,
                        "meeting:live-changed",
                        Option::<DetectedMeeting>::None,
                    );
                    if !was_recording {
                        prompt_for_end.hide(&app_for_end);
                        return;
                    }
                    let settings = store_for_end.get_settings();
                    if is_rec_for_end.load(Ordering::Relaxed) && settings.auto_stop_on_meeting_end {
                        broadcast_to_main(&app_for_end, "recording:stop-requested", "meeting-ended");
                    }
                },
            );

            detector.set_enabled(store.get_settings().detect_meetings);

            // Wire event listeners
            {
                let app_for_auth = app_handle.clone();
                let conn_for_cb = connectivity.clone();
                let store_for_cb = store.clone();
                let sync_for_cb = sync.clone();
                auth.on_change(move |session| {
                    broadcast_to_main(&app_for_auth, "auth:changed", session.clone());
                    if session.authenticated
                        && conn_for_cb.is_online()
                        && store_for_cb.get_settings().auto_sync_after_recording
                    {
                        let s = sync_for_cb.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = s.sync_all_pending(true).await;
                            let _ = s.refresh_all_statuses().await;
                        });
                    }
                });
            }

            {
                let app_for_conn = app_handle.clone();
                let auth_for_cb = auth.clone();
                let store_for_cb = store.clone();
                let sync_for_cb = sync.clone();
                connectivity.on_change(move |status| {
                    broadcast_to_main(&app_for_conn, "connectivity:changed", status.clone());
                    if status.online {
                        let a = auth_for_cb.clone();
                        let st = store_for_cb.clone();
                        let sy = sync_for_cb.clone();
                        tauri::async_runtime::spawn(async move {
                            a.on_connectivity_restored().await;
                            if a.get_session().authenticated
                                && st.get_settings().auto_sync_after_recording
                            {
                                let _ = sy.sync_all_pending(true).await;
                                let _ = sy.refresh_all_statuses().await;
                            }
                        });
                    }
                });
            }

            {
                let app_for_rec = app_handle.clone();
                store.on_recordings_change(move |items| {
                    broadcast_to_main(&app_for_rec, "recordings:updated", items);
                    update_tray(&app_for_rec);
                });
            }

            {
                let app_for_set = app_handle.clone();
                store.on_settings_change(move |settings| {
                    broadcast_to_main(&app_for_set, "settings:updated", settings);
                });
            }

            // Tray setup
            let tray_app = app_handle.clone();
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(load_tray_icon(false))
                .tooltip("AiMY Meetings Desktop Client — Ready")
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "start_rec" => {
                        show_main_window(app);
                        let now_str = chrono::Local::now().format("%H:%M").to_string();
                        broadcast_to_main(
                            app,
                            "recording:start-requested",
                            StartRecordingRequest {
                                title: Some(format!("Meeting — {}", now_str)),
                                meeting_app: Some("Manual".to_string()),
                                meeting_window_title: None,
                                meeting_id: None,
                            },
                        );
                    }
                    "stop_rec" => {
                        show_main_window(app);
                        broadcast_to_main(app, "recording:stop-requested", "manual");
                    }
                    "sync" => {
                        if let Some(st) = app.try_state::<AppState>() {
                            let pending = st
                                .store
                                .list_recordings()
                                .iter()
                                .filter(|r| {
                                    r.sync_status == "LOCAL_PENDING" || r.sync_status == "FAILED"
                                })
                                .count();
                            let sy = st.sync.clone();
                            tauri::async_runtime::spawn(async move {
                                if pending > 0 {
                                    let _ = sy.sync_all_pending(false).await;
                                } else {
                                    let _ = sy.refresh_all_statuses().await;
                                }
                            });
                        }
                    }
                    "console" => {
                        if let Some(st) = app.try_state::<AppState>() {
                            let url = format!(
                                "{}/console",
                                st.store.get_settings().console_base_url.trim_end_matches('/')
                            );
                            let _ = app.opener().open_url(url, None::<&str>);
                        }
                    }
                    "quit" => {
                        if let Some(st) = app.try_state::<AppState>() {
                            st.is_quitting.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(&tray_app);

            // Hide to tray on close unless quitting
            if let Some(main_win) = app_handle.get_webview_window("main") {
                let win_clone = main_win.clone();
                let quitting_flag = is_quitting.clone();
                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if !quitting_flag.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = win_clone.hide();
                        }
                    }
                });
            }

            // Deep link handler
            let app_for_dl = app_handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let raw = url.to_string();
                    let app_clone = app_for_dl.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(st) = app_clone.try_state::<AppState>() {
                            if st.auth.handle_protocol_callback(&raw).await {
                                show_main_window(&app_clone);
                            }
                        }
                    });
                }
            });

            // Background startup initialization
            let conn_init = connectivity.clone();
            let auth_init = auth.clone();
            let store_init = store.clone();
            let sync_init = sync.clone();
            tauri::async_runtime::spawn(async move {
                let _ = conn_init.check_now(None).await;
                auth_init.initialize().await;
                if conn_init.is_online()
                    && auth_init.get_session().authenticated
                    && store_init.get_settings().auto_sync_after_recording
                {
                    let _ = sync_init.sync_all_pending(true).await;
                }
            });

            connectivity.start();
            detector.start();
            sync.start();

            app.manage(AppState {
                store,
                connectivity,
                auth,
                api,
                sync,
                prompt,
                detector,
                capture,
                is_quitting,
                is_recording,
                active_recording_title,
                current_live_meeting,
            });

            update_tray(&app_handle);

            // Handle startup deep link if launched via protocol URI
            let args: Vec<String> = std::env::args().collect();
            if let Some(startup_dl) = extract_deep_link_from_argv(&args) {
                let app_clone = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(st) = app_clone.try_state::<AppState>() {
                        if st.auth.handle_protocol_callback(&startup_dl).await {
                            show_main_window(&app_clone);
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_get_session,
            auth_sign_in,
            auth_cancel_sign_in,
            auth_sign_out,
            auth_set_manual_token,
            auth_callback_url,
            connectivity_get,
            connectivity_report_browser_status,
            aimy_list_groups,
            aimy_list_agents,
            aimy_list_document_types,
            settings_get,
            settings_update,
            recordings_list,
            recordings_create,
            recordings_save_audio,
            recordings_save_native_capture,
            recordings_import_audio,
            recordings_update,
            recordings_delete,
            recordings_audio_path,
            recordings_enhance_audio,
            recordings_reveal,
            sync_one,
            sync_all_pending,
            sync_index,
            sync_refresh_one,
            sync_refresh_all,
            sync_transcribe_clip,
            meeting_get_active,
            meeting_get_live,
            meeting_accept,
            meeting_dismiss,
            meeting_hide_prompt,
            meeting_simulate,
            recording_set_state,
            capture_start,
            capture_pause,
            capture_resume,
            capture_abort,
            capture_stop,
            shell_open_external,
            system_check_ffmpeg,
            system_check_deepfilter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AiMY Meetings Tauri application");
}
