use crate::types::{AimyAgent, AimyDocumentType, AimyGroup};
use bytes::Bytes;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio_util::io::ReaderStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAimyDocument {
    pub doc_id: i64,
    pub doc_name: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub processing_status: Option<String>,
    pub lifecycle_status: Option<String>,
    pub lifecycle: Option<String>,
    pub is_personal: Option<bool>,
    pub last_error: Option<String>,
    pub group_id: Option<i64>,
    pub group_name: Option<String>,
    pub updated_at: Option<String>,
    pub ingested_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UploadAudioOptions {
    pub file_path: String,
    pub file_name: Option<String>,
    pub group_id: i64,
    pub name: String,
    pub agent_ids: Vec<i64>,
    pub is_personal: bool,
    pub lifecycle: String,
    pub force_replace: bool,
    pub allow_duplicate: bool,
}

#[derive(Debug, Clone)]
pub struct CreateJsonDocOptions {
    pub group_id: i64,
    pub title: String,
    pub body: String,
    pub doc_type: String,
    pub agent_ids: Vec<i64>,
    pub is_personal: bool,
    pub lifecycle: String,
    pub force_replace: bool,
    pub allow_duplicate: bool,
}

#[derive(Debug, Clone)]
pub struct AimyApiError {
    pub status: u16,
    pub detail: String,
    pub is_network: bool,
}

impl std::fmt::Display for AimyApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)
    }
}

fn guess_audio_mime(file_path: &str) -> &'static str {
    let ext = Path::new(file_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

pub fn sanitize_doc_name(raw: &str) -> String {
    let re_ext = Regex::new(r"(?i)\.(mp3|wav|m4a|mp4|mov|webm|pdf|txt|md)$").unwrap();
    let stripped = re_ext.replace(raw, "");
    let re_non_alnum = Regex::new(r"[^a-zA-Z0-9_]").unwrap();
    let cleaned = re_non_alnum.replace_all(&stripped, "_");
    let re_multi = Regex::new(r"_+").unwrap();
    let collapsed = re_multi.replace_all(&cleaned, "_");
    let trimmed = collapsed.trim_matches('_').to_string();
    if trimmed.is_empty() {
        format!("meeting_{}", chrono::Utc::now().timestamp_millis())
    } else {
        trimmed
    }
}

pub fn build_aimy_document_url(console_base_url: &str, doc_id: i64) -> String {
    let base = console_base_url.trim_end_matches('/');
    format!("{}/console?doc={}", base, doc_id)
}

type TokenGetter = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>
        + Send
        + Sync,
>;
type UnauthorizedHandler = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct AimyApiClient {
    get_base_url: Arc<dyn Fn() -> String + Send + Sync>,
    get_token: TokenGetter,
    on_unauthorized: UnauthorizedHandler,
    on_network_error: Arc<dyn Fn() + Send + Sync>,
    client: reqwest::Client,
}

impl AimyApiClient {
    pub fn new(
        get_base_url: Arc<dyn Fn() -> String + Send + Sync>,
        get_token: TokenGetter,
        on_unauthorized: UnauthorizedHandler,
        on_network_error: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            get_base_url,
            get_token,
            on_unauthorized,
            on_network_error,
            client: reqwest::Client::new(),
        }
    }

    async fn require_token(&self) -> Result<String, AimyApiError> {
        match (self.get_token)().await {
            Some(t) if !t.is_empty() => Ok(t),
            _ => Err(AimyApiError {
                status: 401,
                detail: "Not signed in to AiMY Knowledge. Please sign in first.".to_string(),
                is_network: false,
            }),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", (self.get_base_url)().trim_end_matches('/'), path)
    }

    async fn json_request<T: for<'de> Deserialize<'de>>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, AimyApiError> {
        let mut retried = false;
        loop {
            let token = self.require_token().await?;
            let mut req = self
                .client
                .request(method.clone(), self.url(path))
                .header("Authorization", format!("Bearer {}", token));
            if let Some(ref b) = body {
                req = req.json(b);
            }

            let res = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    (self.on_network_error)();
                    return Err(AimyApiError {
                        status: 0,
                        detail: format!("Network error: {}", e),
                        is_network: true,
                    });
                }
            };

            let status = res.status().as_u16();
            let text = res.text().await.unwrap_or_default();

            if status == 401 && !retried {
                retried = true;
                if ((self.on_unauthorized)().await).is_some() {
                    continue;
                }
            }

            if !(200..300).contains(&status) {
                let detail = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("detail")
                            .and_then(|d| d.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| {
                        if text.is_empty() {
                            format!("HTTP {}", status)
                        } else {
                            text
                        }
                    });
                return Err(AimyApiError {
                    status,
                    detail,
                    is_network: false,
                });
            }

            return serde_json::from_str::<T>(&text).map_err(|e| AimyApiError {
                status,
                detail: format!("Invalid JSON response: {}", e),
                is_network: false,
            });
        }
    }

    pub async fn list_groups(&self) -> Result<Vec<AimyGroup>, AimyApiError> {
        self.json_request(reqwest::Method::GET, "/list_groups", None)
            .await
    }

    pub async fn list_agents(&self, group_id: i64) -> Result<Vec<AimyAgent>, AimyApiError> {
        self.json_request(
            reqwest::Method::GET,
            &format!("/agents?group_id={}", group_id),
            None,
        )
        .await
    }

    pub async fn list_document_types(&self) -> Result<Vec<AimyDocumentType>, AimyApiError> {
        self.json_request(reqwest::Method::GET, "/v2/document-types", None)
            .await
    }

    pub async fn create_json_document(
        &self,
        opts: CreateJsonDocOptions,
    ) -> Result<i64, AimyApiError> {
        let payload = serde_json::json!({
            "group_id": opts.group_id,
            "type": opts.doc_type,
            "title": opts.title,
            "body": opts.body,
            "type_fields": {},
            "agent_ids": opts.agent_ids,
            "is_personal": opts.is_personal,
            "force_replace": opts.force_replace,
            "allow_duplicate": opts.allow_duplicate,
            "lifecycle": opts.lifecycle,
        });
        let data: serde_json::Value = self
            .json_request(reqwest::Method::POST, "/processing/json", Some(payload))
            .await?;
        let doc_id = data
            .get("document_id")
            .or_else(|| data.get("doc_id"))
            .or_else(|| data.get("id"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if doc_id <= 0 {
            return Err(AimyApiError {
                status: 200,
                detail: "AiMY API succeeded but did not return a document_id.".to_string(),
                is_network: false,
            });
        }
        Ok(doc_id)
    }

    pub async fn index_document(&self, doc_id: i64) -> Result<serde_json::Value, AimyApiError> {
        self.json_request(
            reqwest::Method::POST,
            &format!("/v2/documents/{}/index", doc_id),
            None,
        )
        .await
    }

    pub async fn get_documents_by_ids(
        &self,
        doc_ids: &[i64],
        include_body: bool,
    ) -> Result<HashMap<i64, RemoteAimyDocument>, AimyApiError> {
        let mut map = HashMap::new();
        if doc_ids.is_empty() {
            return Ok(map);
        }

        let mut query = Vec::new();
        for id in doc_ids {
            query.push(format!("ids={}", id));
        }
        if include_body {
            query.push("include_body=true".to_string());
        }
        query.push("page=1".to_string());
        let page_size = doc_ids.len().clamp(20, 100);
        query.push(format!("page_size={}", page_size));

        #[derive(Deserialize)]
        struct RetrieveResp {
            #[serde(default)]
            items: Vec<RemoteAimyDocument>,
        }

        let path = format!("/retrieve_docs_by_group_id/all?{}", query.join("&"));
        let res: RetrieveResp = self
            .json_request(reqwest::Method::GET, &path, None)
            .await?;
        for item in res.items {
            map.insert(item.doc_id, item);
        }

        let missing: Vec<i64> = doc_ids
            .iter()
            .copied()
            .filter(|id| !map.contains_key(id))
            .collect();
        if !missing.is_empty() {
            if let Ok(personal) = self
                .json_request::<RetrieveResp>(
                    reqwest::Method::GET,
                    "/retrieve_docs/personal?page=1&page_size=100",
                    None,
                )
                .await
            {
                for item in personal.items {
                    if missing.contains(&item.doc_id) {
                        map.insert(item.doc_id, item);
                    }
                }
            }
        }

        Ok(map)
    }

    pub async fn upload_audio_recording<F>(
        &self,
        opts: UploadAudioOptions,
        on_progress: F,
    ) -> Result<(i64, u16), AimyApiError>
    where
        F: Fn(i64) + Send + Sync + Clone + 'static,
    {
        let file_name = opts.file_name.clone().unwrap_or_else(|| {
            Path::new(&opts.file_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "recording.mp3".to_string())
        });
        let doc_name = sanitize_doc_name(if opts.name.is_empty() {
            &file_name
        } else {
            &opts.name
        });

        let inputs_payload = serde_json::json!({
            "group_id": opts.group_id,
            "name": doc_name,
            "type": "audio-recording",
            "agent_ids": opts.agent_ids,
            "is_personal": opts.is_personal,
            "force_replace": opts.force_replace,
            "allow_duplicate": opts.allow_duplicate,
            "body_edited": false,
            "lifecycle": opts.lifecycle,
            "type_fields": {}
        });

        let mut fields = HashMap::new();
        fields.insert("inputs".to_string(), inputs_payload.to_string());

        match self
            .stream_multipart_upload(
                "/processing/audio",
                &opts.file_path,
                &file_name,
                &fields,
                Some(on_progress.clone()),
            )
            .await
        {
            Ok((status, data)) => extract_doc_id(status, &data),
            Err(err) if err.status == 404 || err.status == 405 => {
                let (status, data) = self
                    .stream_multipart_upload(
                        "/processing",
                        &opts.file_path,
                        &file_name,
                        &fields,
                        Some(on_progress),
                    )
                    .await?;
                extract_doc_id(status, &data)
            }
            Err(err) => Err(err),
        }
    }

    pub async fn transcribe_voice_clip(&self, file_path: &str) -> Result<String, AimyApiError> {
        let file_name = Path::new(file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "recording.mp3".to_string());
        let fields = HashMap::new();
        let (_status, data) = self
            .stream_multipart_upload::<fn(i64)>(
                "/v2/voice/transcriptions",
                file_path,
                &file_name,
                &fields,
                None,
            )
            .await?;
        let text = data
            .get("text")
            .and_then(|t| t.as_str())
            .ok_or_else(|| AimyApiError {
                status: 200,
                detail: "Transcription response did not contain text.".to_string(),
                is_network: false,
            })?;
        Ok(text.to_string())
    }

    async fn stream_multipart_upload<F>(
        &self,
        path: &str,
        file_path: &str,
        file_name: &str,
        fields: &HashMap<String, String>,
        on_progress: Option<F>,
    ) -> Result<(u16, serde_json::Value), AimyApiError>
    where
        F: Fn(i64) + Send + Sync + Clone + 'static,
    {
        let mut retried = false;
        loop {
            let token = self.require_token().await?;
            match self
                .stream_multipart_upload_once(
                    path,
                    &token,
                    file_path,
                    file_name,
                    fields,
                    on_progress.clone(),
                )
                .await
            {
                Ok(res) => return Ok(res),
                Err(err) if err.status == 401 && !retried => {
                    retried = true;
                    if ((self.on_unauthorized)().await).is_some() {
                        continue;
                    }
                    return Err(err);
                }
                Err(err) => return Err(err),
            }
        }
    }

    async fn stream_multipart_upload_once<F>(
        &self,
        path: &str,
        token: &str,
        file_path: &str,
        file_name: &str,
        fields: &HashMap<String, String>,
        on_progress: Option<F>,
    ) -> Result<(u16, serde_json::Value), AimyApiError>
    where
        F: Fn(i64) + Send + Sync + Clone + 'static,
    {
        let boundary = format!(
            "----AimyMeetingsBoundary{:x}",
            uuid::Uuid::new_v4().as_u128()
        );
        let mime_type = guess_audio_mime(file_path);
        let safe_file_name = file_name.replace('"', "_");
        let file_meta = tokio::fs::metadata(file_path).await.map_err(|e| AimyApiError {
            status: 0,
            detail: format!("Failed to read audio file: {}", e),
            is_network: false,
        })?;
        let file_size = file_meta.len();

        let mut prefix = Vec::new();
        for (k, v) in fields {
            prefix.extend_from_slice(
                format!(
                    "--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n",
                    boundary, k, v
                )
                .as_bytes(),
            );
        }
        prefix.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                boundary, safe_file_name, mime_type
            )
            .as_bytes(),
        );
        let suffix = format!("\r\n--{}--", boundary).into_bytes();
        let total_length = (prefix.len() as u64) + file_size + (suffix.len() as u64);

        let file = tokio::fs::File::open(file_path).await.map_err(|e| AimyApiError {
            status: 0,
            detail: format!("Failed to open audio file: {}", e),
            is_network: false,
        })?;

        let prefix_bytes = Bytes::from(prefix);
        let suffix_bytes = Bytes::from(suffix);

        let prefix_stream = futures_util::stream::once(async move {
            Ok::<Bytes, std::io::Error>(prefix_bytes)
        });
        let file_stream = ReaderStream::new(file);
        let suffix_stream = futures_util::stream::once(async move {
            Ok::<Bytes, std::io::Error>(suffix_bytes)
        });

        let combined = prefix_stream.chain(file_stream).chain(suffix_stream);

        let mut uploaded: u64 = 0;
        let mut last_pct: i64 = -1;
        let tracked = combined.map(move |chunk_res| {
            if let Ok(ref chunk) = chunk_res {
                uploaded += chunk.len() as u64;
                if total_length > 0 {
                    let pct = (((uploaded as f64) / (total_length as f64)) * 100.0)
                        .round()
                        .min(99.0) as i64;
                    if pct != last_pct {
                        last_pct = pct;
                        if let Some(ref cb) = on_progress {
                            cb(pct);
                        }
                    }
                }
            }
            chunk_res
        });

        let body = reqwest::Body::wrap_stream(tracked);
        let res = match self
            .client
            .post(self.url(path))
            .header("Authorization", format!("Bearer {}", token))
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={}", boundary),
            )
            .header("Content-Length", total_length.to_string())
            .body(body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                (self.on_network_error)();
                return Err(AimyApiError {
                    status: 0,
                    detail: format!("Upload network error: {}", e),
                    is_network: true,
                });
            }
        };

        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let parsed = serde_json::from_str::<serde_json::Value>(&text)
            .unwrap_or_else(|_| serde_json::Value::String(text.clone()));

        if (200..300).contains(&status) {
            Ok((status, parsed))
        } else {
            let detail = parsed
                .get("detail")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    if text.is_empty() {
                        format!("Upload failed with HTTP {}", status)
                    } else {
                        text
                    }
                });
            Err(AimyApiError {
                status,
                detail,
                is_network: false,
            })
        }
    }
}

fn extract_doc_id(
    status: u16,
    data: &serde_json::Value,
) -> Result<(i64, u16), AimyApiError> {
    let doc_id = data
        .get("document_id")
        .or_else(|| data.get("doc_id"))
        .or_else(|| data.get("id"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if doc_id <= 0 {
        return Err(AimyApiError {
            status,
            detail: format!(
                "Upload succeeded (HTTP {}) but response had no document_id.",
                status
            ),
            is_network: false,
        });
    }
    Ok((doc_id, status))
}
