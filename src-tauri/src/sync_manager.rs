use crate::aimy_api::{
    build_aimy_document_url, AimyApiClient, CreateJsonDocOptions, RemoteAimyDocument,
    UploadAudioOptions,
};
use crate::recorder_store::RecorderStore;
use crate::types::{RecordingItem, SyncAllPendingResult};
use chrono::Utc;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

const POLL_INTERVAL_MS: u64 = 6000;

struct Inner {
    active_uploads: HashSet<String>,
    polling: bool,
    started: bool,
}

#[derive(Clone)]
pub struct SyncManager {
    store: RecorderStore,
    api: AimyApiClient,
    is_online: Arc<dyn Fn() -> bool + Send + Sync>,
    is_authenticated: Arc<dyn Fn() -> bool + Send + Sync>,
    app_handle: AppHandle,
    inner: Arc<Mutex<Inner>>,
}

impl SyncManager {
    pub fn new(
        store: RecorderStore,
        api: AimyApiClient,
        is_online: Arc<dyn Fn() -> bool + Send + Sync>,
        is_authenticated: Arc<dyn Fn() -> bool + Send + Sync>,
        app_handle: AppHandle,
    ) -> Self {
        Self {
            store,
            api,
            is_online,
            is_authenticated,
            app_handle,
            inner: Arc::new(Mutex::new(Inner {
                active_uploads: HashSet::new(),
                polling: false,
                started: false,
            })),
        }
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
                if !this.inner.lock().unwrap().started {
                    break;
                }
                this.poll_in_flight_statuses(false).await;
            }
        });
    }

    pub async fn sync_recording(&self, id: &str) -> Result<RecordingItem, String> {
        {
            let mut guard = self.inner.lock().unwrap();
            if guard.active_uploads.contains(id) {
                return self
                    .store
                    .get_recording(id)
                    .ok_or_else(|| "Recording not found".to_string());
            }
            guard.active_uploads.insert(id.to_string());
        }

        let res = self.sync_recording_inner(id).await;
        self.inner.lock().unwrap().active_uploads.remove(id);
        res
    }

    async fn sync_recording_inner(&self, id: &str) -> Result<RecordingItem, String> {
        let item = self
            .store
            .get_recording(id)
            .ok_or_else(|| format!("Recording not found: {}", id))?;

        if !(self.is_online)() {
            return self.store.mutate_recording(id, |r| {
                r.sync_status = "LOCAL_PENDING".to_string();
                r.upload_progress = Some(0);
                r.error = Some(
                    "Offline — saved locally and will sync automatically once connected."
                        .to_string(),
                );
            });
        }

        if !(self.is_authenticated)() {
            return self.store.mutate_recording(id, |r| {
                r.sync_status = "LOCAL_PENDING".to_string();
                r.upload_progress = Some(0);
                r.error = Some("Sign in to AiMY Knowledge to sync this recording.".to_string());
            });
        }

        let settings = self.store.get_settings();
        let group_id = match item.group_id.or(settings.default_group_id) {
            Some(g) => g,
            None => {
                return self.store.mutate_recording(id, |r| {
                    r.sync_status = "FAILED".to_string();
                    r.error =
                        Some("Select a target AiMY Group first before syncing.".to_string());
                });
            }
        };

        let _ = self.store.mutate_recording(id, |r| {
            r.group_id = Some(group_id);
            r.sync_status = "UPLOADING".to_string();
            r.upload_progress = Some(2);
            r.error = None;
        });

        if item.upload_mode == "transcript-json" {
            let notes_text = item.notes.trim().to_string();
            let mut body_sections: Vec<String> = Vec::new();
            if !notes_text.is_empty() {
                body_sections.push(format!("## Meeting Notes\n\n{}", notes_text));
            }
            if body_sections.is_empty() {
                if let Some(ref audio_path) = item.audio_path {
                    if Path::new(audio_path).exists() {
                        match self.api.transcribe_voice_clip(audio_path).await {
                            Ok(clip_text) if !clip_text.trim().is_empty() => {
                                body_sections
                                    .push(format!("## Transcript\n\n{}", clip_text.trim()));
                            }
                            Ok(_) => {}
                            Err(e) => return Ok(self.handle_sync_error(id, e)),
                        }
                    }
                }
            }
            if body_sections.is_empty() {
                return self.store.mutate_recording(id, |r| {
                    r.sync_status = "FAILED".to_string();
                    r.upload_progress = Some(0);
                    r.error = Some(
                        "Add meeting notes or record audio before syncing as a notes document."
                            .to_string(),
                    );
                });
            }

            let formatted_body = format!(
                "# {}\n\n- **Recorded**: {}\n- **Source**: {}\n- **Duration**: {}m {}s\n\n{}",
                item.title,
                item.created_at,
                item.meeting_app
                    .clone()
                    .unwrap_or_else(|| "AiMY Meetings Desktop Client".to_string()),
                item.duration_seconds / 60,
                item.duration_seconds % 60,
                body_sections.join("\n\n")
            );

            let doc_id = match self
                .api
                .create_json_document(CreateJsonDocOptions {
                    group_id,
                    title: item.title.clone(),
                    body: formatted_body.clone(),
                    doc_type: "article".to_string(),
                    agent_ids: item.agent_ids.clone(),
                    is_personal: item.is_personal,
                    lifecycle: item.lifecycle.clone(),
                    force_replace: item.aimy_doc_id.is_some(),
                    allow_duplicate: true,
                })
                .await
            {
                Ok(id_val) => id_val,
                Err(e) => return Ok(self.handle_sync_error(id, e)),
            };

            let doc_url = build_aimy_document_url(&settings.console_base_url, doc_id);
            let updated = self.store.mutate_recording(id, |r| {
                r.aimy_doc_id = Some(doc_id);
                r.aimy_document_url = Some(doc_url);
                r.aimy_processing_status = Some("INGESTED".to_string());
                r.aimy_transcript = Some(formatted_body);
                r.sync_status = "SYNCED".to_string();
                r.upload_progress = Some(100);
                r.last_synced_at = Some(Utc::now().to_rfc3339());
                r.error = None;
            })?;
            self.notify_synced(&updated);
            return Ok(updated);
        }

        // Primary mode: Upload audio recording directly to AiMY
        let audio_path = match item.audio_path.clone() {
            Some(p) if Path::new(&p).exists() => p,
            _ => {
                return self.store.mutate_recording(id, |r| {
                    r.sync_status = "FAILED".to_string();
                    r.upload_progress = Some(0);
                    r.error = Some("Local audio file is missing on disk.".to_string());
                });
            }
        };

        let store_for_prog = self.store.clone();
        let id_for_prog = id.to_string();
        let (doc_id, status) = match self
            .api
            .upload_audio_recording(
                UploadAudioOptions {
                    file_path: audio_path,
                    file_name: item.audio_file_name.clone(),
                    group_id,
                    name: item.title.clone(),
                    agent_ids: item.agent_ids.clone(),
                    is_personal: item.is_personal,
                    lifecycle: item.lifecycle.clone(),
                    force_replace: item.aimy_doc_id.is_some(),
                    allow_duplicate: item.is_personal,
                },
                move |pct| {
                    let _ = store_for_prog.mutate_recording(&id_for_prog, |r| {
                        r.upload_progress = Some(pct);
                    });
                },
            )
            .await
        {
            Ok(res) => res,
            Err(e) => return Ok(self.handle_sync_error(id, e)),
        };

        let doc_url = build_aimy_document_url(&settings.console_base_url, doc_id);
        let is_async = status == 202;

        let updated = self.store.mutate_recording(id, |r| {
            r.aimy_doc_id = Some(doc_id);
            r.aimy_document_url = Some(doc_url);
            r.aimy_processing_status = Some(
                if is_async {
                    "PROCESSING"
                } else {
                    "INGESTED"
                }
                .to_string(),
            );
            r.sync_status = if is_async { "TRANSCRIBING" } else { "SYNCED" }.to_string();
            r.upload_progress = Some(100);
            r.last_synced_at = Some(Utc::now().to_rfc3339());
            r.error = None;
        })?;

        if !is_async {
            self.notify_synced(&updated);
        }
        Ok(updated)
    }

    fn handle_sync_error(&self, id: &str, err: crate::aimy_api::AimyApiError) -> RecordingItem {
        if err.is_network || !(self.is_online)() {
            return self
                .store
                .mutate_recording(id, |r| {
                    r.sync_status = "LOCAL_PENDING".to_string();
                    r.upload_progress = Some(0);
                    r.error = Some(
                        "Connection interrupted — saved locally and will sync automatically when online."
                            .to_string(),
                    );
                })
                .unwrap();
        }
        if err.status == 401 {
            return self
                .store
                .mutate_recording(id, |r| {
                    r.sync_status = "LOCAL_PENDING".to_string();
                    r.upload_progress = Some(0);
                    r.error = Some(
                        "Your AiMY session expired — sign in to sync this recording.".to_string(),
                    );
                })
                .unwrap();
        }
        self.store
            .mutate_recording(id, |r| {
                r.sync_status = "FAILED".to_string();
                r.upload_progress = Some(0);
                r.error = Some(err.detail);
            })
            .unwrap()
    }

    pub async fn sync_all_pending(&self, auto: bool) -> SyncAllPendingResult {
        if !(self.is_online)() || !(self.is_authenticated)() {
            return SyncAllPendingResult { started: 0 };
        }
        let settings = self.store.get_settings();
        let pending: Vec<RecordingItem> = self
            .store
            .list_recordings()
            .into_iter()
            .filter(|r| {
                if auto {
                    r.sync_status == "LOCAL_PENDING"
                        && r.group_id.or(settings.default_group_id).is_some()
                } else {
                    r.sync_status == "LOCAL_PENDING" || r.sync_status == "FAILED"
                }
            })
            .collect();

        let mut started = 0;
        for item in pending {
            if self
                .inner
                .lock()
                .unwrap()
                .active_uploads
                .contains(&item.id)
            {
                continue;
            }
            started += 1;
            let this = self.clone();
            let id = item.id.clone();
            tauri::async_runtime::spawn(async move {
                let _ = this.sync_recording(&id).await;
            });
        }
        SyncAllPendingResult { started }
    }

    pub async fn index_recording(&self, id: &str) -> Result<RecordingItem, String> {
        let item = self
            .store
            .get_recording(id)
            .ok_or_else(|| format!("Recording not found: {}", id))?;
        let doc_id = item
            .aimy_doc_id
            .ok_or_else(|| "This recording has not been uploaded to AiMY yet.".to_string())?;

        let _ = self.store.mutate_recording(id, |r| {
            r.sync_status = "INDEXING".to_string();
            r.error = None;
        });

        match self.api.index_document(doc_id).await {
            Ok(_) => {
                let updated = self.store.mutate_recording(id, |r| {
                    r.sync_status = "SYNCED".to_string();
                    r.aimy_processing_status = Some("INGESTED".to_string());
                    r.last_synced_at = Some(Utc::now().to_rfc3339());
                    r.error = None;
                })?;
                self.notify_synced(&updated);
                Ok(updated)
            }
            Err(e) => self.store.mutate_recording(id, |r| {
                r.sync_status = "READY_FOR_REVIEW".to_string();
                r.error = Some(e.detail);
            }),
        }
    }

    pub async fn refresh_recording_status(&self, id: &str) -> Result<RecordingItem, String> {
        let item = self
            .store
            .get_recording(id)
            .ok_or_else(|| format!("Recording not found: {}", id))?;
        let doc_id = match item.aimy_doc_id {
            Some(d) => d,
            None => return Ok(item),
        };
        let docs = self
            .api
            .get_documents_by_ids(&[doc_id], true)
            .await
            .map_err(|e| e.detail)?;
        if let Some(remote) = docs.get(&doc_id) {
            return self.apply_remote_status(&item, remote).await;
        }
        Ok(item)
    }

    pub async fn refresh_all_statuses(&self) -> Vec<RecordingItem> {
        self.poll_in_flight_statuses(true).await;
        self.store.list_recordings()
    }

    async fn poll_in_flight_statuses(&self, include_synced_without_body: bool) {
        {
            let mut guard = self.inner.lock().unwrap();
            if guard.polling {
                return;
            }
            guard.polling = true;
        }

        if (self.is_online)() && (self.is_authenticated)() {
            let candidates: Vec<RecordingItem> = self
                .store
                .list_recordings()
                .into_iter()
                .filter(|r| {
                    if r.aimy_doc_id.is_none() {
                        return false;
                    }
                    if r.sync_status == "TRANSCRIBING" || r.sync_status == "READY_FOR_REVIEW" {
                        return true;
                    }
                    if include_synced_without_body
                        && r.sync_status == "SYNCED"
                        && r.aimy_summary.is_none()
                    {
                        return true;
                    }
                    false
                })
                .collect();

            if !candidates.is_empty() {
                let doc_ids: Vec<i64> = candidates
                    .iter()
                    .filter_map(|c| c.aimy_doc_id)
                    .filter(|id| *id > 0)
                    .collect();
                if let Ok(remote_map) = self.api.get_documents_by_ids(&doc_ids, true).await {
                    for item in candidates {
                        if let Some(doc_id) = item.aimy_doc_id {
                            if let Some(remote) = remote_map.get(&doc_id) {
                                let _ = self.apply_remote_status(&item, remote).await;
                            }
                        }
                    }
                }
            }
        }

        self.inner.lock().unwrap().polling = false;
    }

    async fn apply_remote_status(
        &self,
        item: &RecordingItem,
        remote: &RemoteAimyDocument,
    ) -> Result<RecordingItem, String> {
        let settings = self.store.get_settings();
        let ps = remote
            .processing_status
            .as_deref()
            .unwrap_or("")
            .to_uppercase();
        let raw_lifecycle = remote
            .lifecycle_status
            .as_deref()
            .or(remote.lifecycle.as_deref())
            .unwrap_or("")
            .to_lowercase();
        let synced_lifecycle = match raw_lifecycle.as_str() {
            "published" => "published".to_string(),
            "draft" => "draft".to_string(),
            _ => item.lifecycle.clone(),
        };
        let synced_personal = remote.is_personal.unwrap_or(item.is_personal);
        let doc_url = item
            .aimy_doc_id
            .map(|id| build_aimy_document_url(&settings.console_base_url, id))
            .or_else(|| item.aimy_document_url.clone());

        if ps == "INGESTED" {
            let was_synced = item.sync_status == "SYNCED";
            let updated = self.store.mutate_recording(&item.id, |r| {
                r.aimy_document_url = doc_url;
                r.aimy_processing_status = Some(ps);
                if remote.summary.is_some() {
                    r.aimy_summary = remote.summary.clone();
                }
                if remote.body.is_some() {
                    r.aimy_transcript = remote.body.clone();
                }
                r.lifecycle = synced_lifecycle;
                r.is_personal = synced_personal;
                r.sync_status = "SYNCED".to_string();
                r.last_synced_at = Some(Utc::now().to_rfc3339());
                r.error = None;
            })?;
            if !was_synced {
                self.notify_synced(&updated);
            }
            return Ok(updated);
        }

        if ps == "READY_FOR_REVIEW" {
            let updated = self.store.mutate_recording(&item.id, |r| {
                r.aimy_document_url = doc_url;
                r.aimy_processing_status = Some(ps);
                if remote.summary.is_some() {
                    r.aimy_summary = remote.summary.clone();
                }
                if remote.body.is_some() {
                    r.aimy_transcript = remote.body.clone();
                }
                r.lifecycle = synced_lifecycle;
                r.is_personal = synced_personal;
                r.sync_status = "READY_FOR_REVIEW".to_string();
                r.error = remote.last_error.clone();
            })?;
            if settings.auto_index_after_transcription {
                return Box::pin(self.index_recording(&item.id)).await;
            }
            return Ok(updated);
        }

        if ps == "FAILED" {
            return self.store.mutate_recording(&item.id, |r| {
                r.aimy_document_url = doc_url;
                r.aimy_processing_status = Some(ps);
                r.lifecycle = synced_lifecycle;
                r.is_personal = synced_personal;
                r.sync_status = "FAILED".to_string();
                r.error = Some(
                    remote
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "AiMY failed to transcribe this recording.".to_string()),
                );
            });
        }

        if ps == "PENDING" || ps == "PULLED" || ps == "PROCESSING" {
            return self.store.mutate_recording(&item.id, |r| {
                r.aimy_document_url = doc_url;
                r.aimy_processing_status = Some(ps);
                r.lifecycle = synced_lifecycle;
                r.is_personal = synced_personal;
                r.sync_status = "TRANSCRIBING".to_string();
            });
        }

        self.store.mutate_recording(&item.id, |r| {
            r.aimy_document_url = doc_url;
            if !ps.is_empty() {
                r.aimy_processing_status = Some(ps);
            }
            if remote.summary.is_some() {
                r.aimy_summary = remote.summary.clone();
            }
            if remote.body.is_some() {
                r.aimy_transcript = remote.body.clone();
            }
            r.lifecycle = synced_lifecycle;
            r.is_personal = synced_personal;
        })
    }

    fn notify_synced(&self, item: &RecordingItem) {
        let _ = self
            .app_handle
            .notification()
            .builder()
            .title("Synced to AiMY Knowledge")
            .body(format!(
                "\"{}\" is ready in AiMY Knowledge.",
                item.title
            ))
            .show();
    }
}
