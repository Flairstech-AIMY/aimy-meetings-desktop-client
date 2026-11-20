use crate::audio_enhancer::{
    check_ffmpeg_available, enhance_and_encode_to_mp3, probe_duration_seconds,
};
use crate::types::{AppSettings, CreateRecordingInput, RecordingItem, UpdateRecordingPatch};
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const SUPPORTED_DIRECT_EXTS: &[&str] = &[".mp3", ".wav", ".m4a", ".mp4", ".mov"];

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".mp3" => "audio/mpeg",
        ".wav" => "audio/wav",
        ".m4a" => "audio/mp4",
        ".mp4" => "video/mp4",
        ".mov" => "video/quicktime",
        ".webm" => "audio/webm",
        ".ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

type RecordingsCallback = Arc<dyn Fn(Vec<RecordingItem>) + Send + Sync>;
type SettingsCallback = Arc<dyn Fn(AppSettings) + Send + Sync>;

struct StoreInner {
    settings: AppSettings,
    recordings: Vec<RecordingItem>,
    recording_listeners: Vec<RecordingsCallback>,
    settings_listeners: Vec<SettingsCallback>,
}

#[derive(Clone)]
pub struct RecorderStore {
    data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    inner: Arc<Mutex<StoreInner>>,
}

impl RecorderStore {
    pub fn new(data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Self {
        let store = Self {
            data_dir,
            resource_dir,
            inner: Arc::new(Mutex::new(StoreInner {
                settings: AppSettings::default(),
                recordings: Vec::new(),
                recording_listeners: Vec::new(),
                settings_listeners: Vec::new(),
            })),
        };
        store.ensure_dirs();
        store.load();
        store
    }

    pub fn resource_dir(&self) -> Option<&Path> {
        self.resource_dir.as_deref()
    }

    pub fn recordings_dir(&self) -> PathBuf {
        self.data_dir.join("recordings")
    }

    fn recordings_db_path(&self) -> PathBuf {
        self.data_dir.join("recordings.json")
    }

    fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    fn ensure_dirs(&self) {
        let _ = std::fs::create_dir_all(self.recordings_dir());
    }

    fn load(&self) {
        let settings_path = self.settings_path();
        let mut migrated = false;
        let mut loaded_settings = AppSettings::default();
        if settings_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&settings_path) {
                if let Ok(parsed) = serde_json::from_str::<AppSettings>(&raw) {
                    loaded_settings = parsed;
                    if !loaded_settings.default_is_personal {
                        loaded_settings.default_is_personal = true;
                        migrated = true;
                    }
                    if loaded_settings.default_lifecycle != "draft" {
                        loaded_settings.default_lifecycle = "draft".to_string();
                        migrated = true;
                    }
                }
            }
        }

        let mut loaded_recordings: Vec<RecordingItem> = Vec::new();
        let rec_path = self.recordings_db_path();
        if rec_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&rec_path) {
                if let Ok(parsed) = serde_json::from_str::<Vec<RecordingItem>>(&raw) {
                    loaded_recordings = parsed
                        .into_iter()
                        .map(|mut item| {
                            if item.aimy_doc_id.is_none() {
                                item.is_personal = true;
                                item.lifecycle = "draft".to_string();
                            }
                            if item.sync_status == "UPLOADING" || item.sync_status == "ENCODING" {
                                item.sync_status = "LOCAL_PENDING".to_string();
                                item.upload_progress = Some(0);
                            } else if item.sync_status == "RECORDING" {
                                let has_file = item
                                    .audio_path
                                    .as_ref()
                                    .map(|p| Path::new(p).exists())
                                    .unwrap_or(false);
                                if has_file {
                                    item.sync_status = "LOCAL_PENDING".to_string();
                                } else {
                                    item.sync_status = "FAILED".to_string();
                                    item.error = Some(
                                        "Recording was interrupted before saving audio.".to_string(),
                                    );
                                }
                            }
                            item
                        })
                        .collect();
                }
            }
        }

        {
            let mut guard = self.inner.lock().unwrap();
            guard.settings = loaded_settings;
            guard.recordings = loaded_recordings;
        }

        if migrated {
            self.save_settings_disk_and_emit();
        }
    }

    pub fn on_recordings_change<F>(&self, cb: F)
    where
        F: Fn(Vec<RecordingItem>) + Send + Sync + 'static,
    {
        let mut guard = self.inner.lock().unwrap();
        guard.recording_listeners.push(Arc::new(cb));
    }

    pub fn on_settings_change<F>(&self, cb: F)
    where
        F: Fn(AppSettings) + Send + Sync + 'static,
    {
        let mut guard = self.inner.lock().unwrap();
        guard.settings_listeners.push(Arc::new(cb));
    }

    fn save_recordings_disk_and_emit(&self) {
        self.ensure_dirs();
        let (serialized, snapshot, listeners) = {
            let guard = self.inner.lock().unwrap();
            let serialized = serde_json::to_string_pretty(&guard.recordings).unwrap_or_default();
            let mut sorted = guard.recordings.clone();
            sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            (serialized, sorted, guard.recording_listeners.clone())
        };
        let _ = std::fs::write(self.recordings_db_path(), serialized);
        for listener in listeners {
            listener(snapshot.clone());
        }
    }

    fn save_settings_disk_and_emit(&self) {
        self.ensure_dirs();
        let (serialized, snapshot, listeners) = {
            let guard = self.inner.lock().unwrap();
            let mut s = guard.settings.clone();
            s.default_is_personal = true;
            s.default_lifecycle = "draft".to_string();
            let serialized = serde_json::to_string_pretty(&s).unwrap_or_default();
            (serialized, s, guard.settings_listeners.clone())
        };
        let _ = std::fs::write(self.settings_path(), serialized);
        for listener in listeners {
            listener(snapshot.clone());
        }
    }

    pub fn get_settings(&self) -> AppSettings {
        let guard = self.inner.lock().unwrap();
        let mut s = guard.settings.clone();
        s.default_is_personal = true;
        s.default_lifecycle = "draft".to_string();
        s
    }

    pub fn update_settings(&self, patch: serde_json::Value) -> AppSettings {
        {
            let mut guard = self.inner.lock().unwrap();
            if let Ok(mut current_val) = serde_json::to_value(&guard.settings) {
                if let (Some(curr_obj), Some(patch_obj)) =
                    (current_val.as_object_mut(), patch.as_object())
                {
                    for (k, v) in patch_obj {
                        curr_obj.insert(k.clone(), v.clone());
                    }
                }
                if let Ok(mut merged) = serde_json::from_value::<AppSettings>(current_val) {
                    merged.default_is_personal = true;
                    merged.default_lifecycle = "draft".to_string();
                    guard.settings = merged;
                }
            }
        }
        self.save_settings_disk_and_emit();
        self.get_settings()
    }

    pub fn list_recordings(&self) -> Vec<RecordingItem> {
        let guard = self.inner.lock().unwrap();
        let mut sorted = guard.recordings.clone();
        sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        sorted
    }

    pub fn get_recording(&self, id: &str) -> Option<RecordingItem> {
        let guard = self.inner.lock().unwrap();
        guard.recordings.iter().find(|r| r.id == id).cloned()
    }

    pub fn create_recording_entry(&self, input: CreateRecordingInput) -> RecordingItem {
        let now = Utc::now().to_rfc3339();
        let item = {
            let mut guard = self.inner.lock().unwrap();
            let title = if input.title.trim().is_empty() {
                format!("Meeting {}", Utc::now().format("%Y-%m-%d %H:%M"))
            } else {
                input.title.trim().to_string()
            };
            let item = RecordingItem {
                id: Uuid::new_v4().to_string(),
                title,
                created_at: now.clone(),
                updated_at: now,
                duration_seconds: 0,
                meeting_app: Some(
                    input
                        .meeting_app
                        .unwrap_or_else(|| "Manual".to_string()),
                ),
                meeting_window_title: input.meeting_window_title,
                audio_path: None,
                audio_file_name: None,
                audio_mime_type: None,
                file_size_bytes: None,
                notes: input.notes.unwrap_or_default(),
                sync_status: "RECORDING".to_string(),
                upload_progress: Some(0),
                upload_mode: input
                    .upload_mode
                    .unwrap_or_else(|| guard.settings.default_upload_mode.clone()),
                group_id: input.group_id.or(guard.settings.default_group_id),
                group_name: input.group_name,
                agent_ids: input
                    .agent_ids
                    .unwrap_or_else(|| guard.settings.default_agent_ids.clone()),
                is_personal: true,
                lifecycle: "draft".to_string(),
                aimy_doc_id: None,
                aimy_document_url: None,
                aimy_processing_status: None,
                aimy_summary: None,
                aimy_transcript: None,
                audio_enhanced: None,
                enhancement_engine: None,
                last_synced_at: None,
                error: None,
            };
            guard.recordings.insert(0, item.clone());
            item
        };
        self.save_recordings_disk_and_emit();
        item
    }

    pub fn mutate_recording<F>(&self, id: &str, f: F) -> Result<RecordingItem, String>
    where
        F: FnOnce(&mut RecordingItem),
    {
        let updated = {
            let mut guard = self.inner.lock().unwrap();
            let item = guard
                .recordings
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| format!("Recording not found: {}", id))?;
            f(item);
            item.updated_at = Utc::now().to_rfc3339();
            item.clone()
        };
        self.save_recordings_disk_and_emit();
        Ok(updated)
    }

    pub fn update_recording_metadata(
        &self,
        id: &str,
        patch: UpdateRecordingPatch,
    ) -> Result<RecordingItem, String> {
        self.mutate_recording(id, |item| {
            if let Some(title) = patch.title {
                item.title = title;
            }
            if let Some(notes) = patch.notes {
                item.notes = notes;
            }
            if let Some(group_id) = patch.group_id {
                item.group_id = group_id;
            }
            if let Some(group_name) = patch.group_name {
                item.group_name = group_name;
            }
            if let Some(agent_ids) = patch.agent_ids {
                item.agent_ids = agent_ids;
            }
            if let Some(upload_mode) = patch.upload_mode {
                item.upload_mode = upload_mode;
            }
        })
    }

    pub fn delete_recording(&self, id: &str) {
        if let Some(existing) = self.get_recording(id) {
            if let Some(path) = existing.audio_path {
                let p = Path::new(&path);
                if p.exists() {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        {
            let mut guard = self.inner.lock().unwrap();
            guard.recordings.retain(|r| r.id != id);
        }
        self.save_recordings_disk_and_emit();
    }

    pub async fn save_captured_audio(
        &self,
        id: &str,
        audio_bytes: &[u8],
        input_ext: &str,
        duration_seconds: i64,
        notes: Option<String>,
    ) -> Result<RecordingItem, String> {
        self.ensure_dirs();
        let normalized_ext = if input_ext.starts_with('.') {
            input_ext.to_lowercase()
        } else {
            format!(".{}", input_ext.to_lowercase())
        };
        let raw_path = self.recordings_dir().join(format!("{}{}", id, normalized_ext));
        std::fs::write(&raw_path, audio_bytes)
            .map_err(|e| format!("Failed to write captured audio: {}", e))?;

        self.save_captured_audio_from_path(id, &raw_path, &normalized_ext, duration_seconds, notes)
            .await
    }

    pub async fn save_captured_audio_from_path(
        &self,
        id: &str,
        raw_path: &Path,
        normalized_ext: &str,
        duration_seconds: i64,
        notes: Option<String>,
    ) -> Result<RecordingItem, String> {
        self.ensure_dirs();

        self.mutate_recording(id, |item| {
            item.sync_status = "ENCODING".to_string();
            item.duration_seconds = duration_seconds.max(1);
            if let Some(n) = notes {
                item.notes = n;
            }
        })?;

        let mut final_path = raw_path.to_path_buf();
        let mut final_ext = normalized_ext.to_string();
        let mut audio_enhanced = false;
        let mut enhancement_engine: Option<String> = None;

        let should_enhance = self.get_settings().enhance_audio;
        let has_ffmpeg = check_ffmpeg_available().await;

        if has_ffmpeg
            && (!SUPPORTED_DIRECT_EXTS.contains(&normalized_ext) || should_enhance)
        {
            let mp3_path = self.recordings_dir().join(format!("{}.mp3", id));
            let temp_out_path = if mp3_path == raw_path {
                self.recordings_dir().join(format!("{}.enhanced.mp3", id))
            } else {
                mp3_path.clone()
            };

            match enhance_and_encode_to_mp3(
                raw_path,
                &temp_out_path,
                should_enhance,
                self.resource_dir(),
            )
            .await
            {
                Ok(res) => {
                    if let Ok(meta) = std::fs::metadata(&temp_out_path) {
                        if meta.len() > 0 {
                            if temp_out_path != raw_path {
                                let _ = std::fs::remove_file(raw_path);
                            }
                            if temp_out_path != mp3_path {
                                let _ = std::fs::copy(&temp_out_path, &mp3_path);
                                let _ = std::fs::remove_file(&temp_out_path);
                            }
                            final_path = mp3_path;
                            final_ext = ".mp3".to_string();
                            audio_enhanced = res.enhanced;
                            enhancement_engine = res.engine;
                        }
                    }
                }
                Err(err) => {
                    eprintln!(
                        "[Store] Audio enhancement/transcode failed, keeping raw file: {}",
                        err
                    );
                }
            }
        }

        let file_size_bytes = std::fs::metadata(&final_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let probed = if duration_seconds > 0 {
            duration_seconds
        } else {
            probe_duration_seconds(&final_path).await
        };

        let file_name = final_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        let final_path_str = final_path.to_string_lossy().to_string();

        self.mutate_recording(id, |item| {
            item.audio_path = Some(final_path_str);
            item.audio_file_name = file_name;
            item.audio_mime_type = Some(mime_for_ext(&final_ext).to_string());
            item.file_size_bytes = Some(file_size_bytes);
            item.duration_seconds = probed;
            item.audio_enhanced = Some(audio_enhanced);
            item.enhancement_engine = enhancement_engine;
            item.sync_status = "LOCAL_PENDING".to_string();
            item.error = None;
        })
    }

    pub async fn enhance_existing_recording(&self, id: &str) -> Result<RecordingItem, String> {
        let existing = self
            .get_recording(id)
            .ok_or_else(|| format!("Recording not found: {}", id))?;
        let audio_path_str = existing
            .audio_path
            .clone()
            .ok_or_else(|| "Local audio file is missing on disk.".to_string())?;
        let audio_path = PathBuf::from(&audio_path_str);
        if !audio_path.exists() {
            return Err("Local audio file is missing on disk.".to_string());
        }
        if !check_ffmpeg_available().await {
            return Err("FFmpeg is required to enhance audio.".to_string());
        }

        let prev_status = existing.sync_status.clone();
        self.mutate_recording(id, |item| {
            item.sync_status = "ENCODING".to_string();
            item.error = None;
        })?;

        let out_path = self.recordings_dir().join(format!("{}.enhanced.mp3", id));
        let final_path = self.recordings_dir().join(format!("{}.mp3", id));

        let res = match enhance_and_encode_to_mp3(
            &audio_path,
            &out_path,
            true,
            self.resource_dir(),
        )
        .await
        {
            Ok(r) => r,
            Err(err) => {
                let _ = self.mutate_recording(id, |item| {
                    item.sync_status = if prev_status == "ENCODING" {
                        "LOCAL_PENDING".to_string()
                    } else {
                        prev_status.clone()
                    };
                    item.error = Some(err.clone());
                });
                return Err(err);
            }
        };

        let out_size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        if out_size == 0 {
            let err = "Audio enhancement produced an empty file.".to_string();
            let _ = self.mutate_recording(id, |item| {
                item.sync_status = if prev_status == "ENCODING" {
                    "LOCAL_PENDING".to_string()
                } else {
                    prev_status.clone()
                };
                item.error = Some(err.clone());
            });
            return Err(err);
        }

        if audio_path != final_path && audio_path.exists() {
            let _ = std::fs::remove_file(&audio_path);
        }
        let _ = std::fs::copy(&out_path, &final_path);
        let _ = std::fs::remove_file(&out_path);

        let file_size_bytes = std::fs::metadata(&final_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let probed = if existing.duration_seconds > 0 {
            existing.duration_seconds
        } else {
            probe_duration_seconds(&final_path).await
        };

        let file_name = final_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        let final_path_str = final_path.to_string_lossy().to_string();

        self.mutate_recording(id, |item| {
            item.audio_path = Some(final_path_str);
            item.audio_file_name = file_name;
            item.audio_mime_type = Some("audio/mpeg".to_string());
            item.file_size_bytes = Some(file_size_bytes);
            item.duration_seconds = probed;
            item.audio_enhanced = Some(res.enhanced);
            item.enhancement_engine = res.engine;
            item.sync_status = if prev_status == "SYNCED" {
                "SYNCED".to_string()
            } else {
                "LOCAL_PENDING".to_string()
            };
            item.error = None;
        })
    }

    pub async fn import_local_file(&self, source_path: &Path) -> Result<RecordingItem, String> {
        self.ensure_dirs();
        let src_ext = source_path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_else(|| ".mp3".to_string());
        let base_name = source_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Imported Recording".to_string());
        let cleaned_title = base_name
            .replace(['_', '-'], " ")
            .trim()
            .to_string();
        let title = if cleaned_title.is_empty() {
            "Imported Recording".to_string()
        } else {
            cleaned_title
        };

        let entry = self.create_recording_entry(CreateRecordingInput {
            title,
            meeting_app: Some("Imported Audio".to_string()),
            meeting_window_title: None,
            notes: None,
            group_id: None,
            group_name: None,
            agent_ids: None,
            is_personal: Some(true),
            lifecycle: Some("draft".to_string()),
            upload_mode: None,
        });

        let mut dest_path = self
            .recordings_dir()
            .join(format!("{}{}", entry.id, src_ext));
        std::fs::copy(source_path, &dest_path)
            .map_err(|e| format!("Failed to copy imported audio file: {}", e))?;

        let mut final_ext = src_ext.clone();
        let mut audio_enhanced = false;
        let mut enhancement_engine: Option<String> = None;

        let should_enhance = self.get_settings().enhance_audio;
        if (!SUPPORTED_DIRECT_EXTS.contains(&src_ext.as_str()) || should_enhance)
            && check_ffmpeg_available().await
        {
            let _ = self.mutate_recording(&entry.id, |item| {
                item.sync_status = "ENCODING".to_string();
            });
            let mp3_path = self.recordings_dir().join(format!("{}.mp3", entry.id));
            let temp_out = if mp3_path == dest_path {
                self.recordings_dir()
                    .join(format!("{}.enhanced.mp3", entry.id))
            } else {
                mp3_path.clone()
            };

            if let Ok(res) = enhance_and_encode_to_mp3(
                &dest_path,
                &temp_out,
                should_enhance,
                self.resource_dir(),
            )
            .await
            {
                if std::fs::metadata(&temp_out)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
                {
                    if temp_out != dest_path {
                        let _ = std::fs::remove_file(&dest_path);
                    }
                    if temp_out != mp3_path {
                        let _ = std::fs::copy(&temp_out, &mp3_path);
                        let _ = std::fs::remove_file(&temp_out);
                    }
                    dest_path = mp3_path;
                    final_ext = ".mp3".to_string();
                    audio_enhanced = res.enhanced;
                    enhancement_engine = res.engine;
                }
            }
        }

        let file_size_bytes = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
        let duration_seconds = probe_duration_seconds(&dest_path).await;
        let file_name = dest_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        let dest_path_str = dest_path.to_string_lossy().to_string();

        self.mutate_recording(&entry.id, |item| {
            item.audio_path = Some(dest_path_str);
            item.audio_file_name = file_name;
            item.audio_mime_type = Some(mime_for_ext(&final_ext).to_string());
            item.file_size_bytes = Some(file_size_bytes);
            item.duration_seconds = duration_seconds;
            item.audio_enhanced = Some(audio_enhanced);
            item.enhancement_engine = enhancement_engine;
            item.sync_status = "LOCAL_PENDING".to_string();
            item.error = None;
        })
    }
}
