use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityStatus {
    pub online: bool,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AuthUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_refresh_token: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AimyGroup {
    pub group_id: i64,
    pub group_name: String,
    pub client_id: Option<i64>,
    pub client_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_create_shared: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AimyAgent {
    pub agent_id: i64,
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AimyDocumentType {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_label: Option<String>,
    #[serde(default)]
    pub ingestion_methods: Vec<String>,
    #[serde(default)]
    pub file_rules: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingItem {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub duration_seconds: i64,
    pub meeting_app: Option<String>,
    pub meeting_window_title: Option<String>,
    pub audio_path: Option<String>,
    pub audio_file_name: Option<String>,
    pub audio_mime_type: Option<String>,
    pub file_size_bytes: Option<u64>,
    pub notes: String,
    pub sync_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_progress: Option<i64>,
    pub upload_mode: String,
    pub group_id: Option<i64>,
    pub group_name: Option<String>,
    pub agent_ids: Vec<i64>,
    pub is_personal: bool,
    pub lifecycle: String,
    pub aimy_doc_id: Option<i64>,
    pub aimy_document_url: Option<String>,
    pub aimy_processing_status: Option<String>,
    pub aimy_summary: Option<String>,
    pub aimy_transcript: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_enhanced: Option<bool>,
    pub enhancement_engine: Option<String>,
    pub last_synced_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedMeeting {
    pub id: String,
    pub app: String,
    pub title: String,
    pub detected_at: String,
    pub mic_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_api_base_url")]
    pub api_base_url: String,
    #[serde(default = "default_console_base_url")]
    pub console_base_url: String,
    #[serde(default)]
    pub default_group_id: Option<i64>,
    #[serde(default)]
    pub default_agent_ids: Vec<i64>,
    #[serde(default = "default_true")]
    pub default_is_personal: bool,
    #[serde(default = "default_lifecycle")]
    pub default_lifecycle: String,
    #[serde(default = "default_upload_mode")]
    pub default_upload_mode: String,
    #[serde(default = "default_true")]
    pub auto_sync_after_recording: bool,
    #[serde(default)]
    pub auto_index_after_transcription: bool,
    #[serde(default = "default_true")]
    pub detect_meetings: bool,
    #[serde(default)]
    pub auto_record_on_meeting: bool,
    #[serde(default = "default_true")]
    pub auto_stop_on_meeting_end: bool,
    #[serde(default = "default_true")]
    pub enhance_audio: bool,
    #[serde(default = "default_true")]
    pub capture_system_audio: bool,
    #[serde(default = "default_true")]
    pub capture_microphone: bool,
    #[serde(default)]
    pub preferred_mic_device_id: Option<String>,
}

fn default_api_base_url() -> String {
    "https://staging-api-documents-knowledge.aimy.flairstech.com".to_string()
}

fn default_console_base_url() -> String {
    "https://staging-knowledge.aimy.flairstech.com".to_string()
}

fn default_true() -> bool {
    true
}

fn default_lifecycle() -> String {
    "draft".to_string()
}

fn default_upload_mode() -> String {
    "audio-recording".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            api_base_url: default_api_base_url(),
            console_base_url: default_console_base_url(),
            default_group_id: None,
            default_agent_ids: Vec::new(),
            default_is_personal: true,
            default_lifecycle: default_lifecycle(),
            default_upload_mode: default_upload_mode(),
            auto_sync_after_recording: true,
            auto_index_after_transcription: false,
            detect_meetings: true,
            auto_record_on_meeting: false,
            auto_stop_on_meeting_end: true,
            enhance_audio: true,
            capture_system_audio: true,
            capture_microphone: true,
            preferred_mic_device_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRecordingInput {
    pub title: String,
    #[serde(default)]
    pub meeting_app: Option<String>,
    #[serde(default)]
    pub meeting_window_title: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub group_id: Option<i64>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub agent_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub is_personal: Option<bool>,
    #[serde(default)]
    pub lifecycle: Option<String>,
    #[serde(default)]
    pub upload_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecordingPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub group_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub group_name: Option<Option<String>>,
    pub agent_ids: Option<Vec<i64>>,
    pub is_personal: Option<bool>,
    pub lifecycle: Option<String>,
    pub upload_mode: Option<String>,
}

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncAllPendingResult {
    pub started: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteResult {
    pub ok: bool,
}
