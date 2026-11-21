use crate::types::AudioPreviewResult;
use base64::Engine as _;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use uuid::Uuid;

const BUILTIN_TEST_SAMPLE_MP3: &[u8] = include_bytes!("../../resources/deepfilter-test-sample.mp3");

#[derive(Debug, Clone)]
pub struct EnhanceResult {
    pub enhanced: bool,
    pub engine: Option<String>,
    pub strength_percent: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeepFilterOptions {
    /// Filtering strength from 0 (off / bypass) to 100 (full / unlimited attenuation).
    pub strength_percent: u8,
    /// Enable DeepFilterNet3's post-filter (`--pf`) for extra attenuation on residual noise.
    pub post_filter: bool,
}

impl Default for DeepFilterOptions {
    fn default() -> Self {
        Self {
            strength_percent: 50,
            post_filter: true,
        }
    }
}

/// Maps a user-facing 0–100% filtering strength to DeepFilterNet3's `--atten-lim-db` value.
///
/// Uses a psychoacoustic dB scale where every +25% adds +10 dB of noise attenuation
/// (approximately halving perceived residual noise per step), up to 100 dB (unlimited) at 100%:
/// - `0%`   -> `0.0 dB`   (bypass / no noise reduction)
/// - `25%`  -> `10.0 dB`  (light)
/// - `50%`  -> `20.0 dB`  (balanced)
/// - `75%`  -> `30.0 dB`  (strong)
/// - `100%` -> `100.0 dB` (maximum / no attenuation limit)
pub fn strength_percent_to_atten_lim_db(strength_percent: u8) -> f32 {
    let clamped = strength_percent.min(100);
    if clamped == 0 {
        0.0
    } else if clamped >= 100 {
        100.0
    } else {
        (clamped as f32) * 0.4
    }
}

fn build_deep_filter_args(
    options: DeepFilterOptions,
    out_dir_str: &str,
    wav_in_str: &str,
) -> Vec<String> {
    let atten_db = strength_percent_to_atten_lim_db(options.strength_percent);
    let mut args = Vec::with_capacity(7);
    if options.post_filter {
        args.push("--pf".to_string());
    }
    args.push("--compensate-delay".to_string());
    args.push("--atten-lim-db".to_string());
    args.push(format!("{:.1}", atten_db));
    args.push("--output-dir".to_string());
    args.push(out_dir_str.to_string());
    args.push(wav_in_str.to_string());
    args
}

fn configure_hidden_command(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub async fn run_command_hidden(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    configure_hidden_command(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} exited with {}: {}", program, out.status, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn resolve_deep_filter_binary(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) {
        "deep-filter.exe"
    } else {
        "deep-filter"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("bin").join(bin_name));
        candidates.push(res.join("resources").join("bin").join(bin_name));
        candidates.push(res.join(bin_name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bin").join(bin_name));
            candidates.push(dir.join("resources").join("bin").join(bin_name));
            candidates.push(dir.join(bin_name));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources").join("bin").join(bin_name));
        candidates.push(
            cwd.parent()
                .unwrap_or(&cwd)
                .join("resources")
                .join("bin")
                .join(bin_name),
        );
    }

    candidates.into_iter().find(|p| p.exists())
}

pub async fn check_deep_filter_available(resource_dir: Option<&Path>) -> bool {
    if resolve_deep_filter_binary(resource_dir).is_some() {
        return true;
    }
    run_command_hidden("deep-filter", &["--version"]).await.is_ok()
}

pub async fn check_ffmpeg_available() -> bool {
    run_command_hidden("ffmpeg", &["-version"]).await.is_ok()
}

pub async fn probe_duration_seconds(file_path: &Path) -> i64 {
    let path_str = file_path.to_string_lossy();
    let res = run_command_hidden(
        "ffprobe",
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path_str,
        ],
    )
    .await;
    match res {
        Ok(stdout) => stdout
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| v.round() as i64)
            .unwrap_or(0),
        Err(_) => 0,
    }
}

pub async fn enhance_and_encode_to_mp3(
    input_path: &Path,
    output_mp3_path: &Path,
    enable_enhancement: bool,
    options: DeepFilterOptions,
    resource_dir: Option<&Path>,
) -> Result<EnhanceResult, String> {
    let input_str = input_path.to_string_lossy().to_string();
    let output_str = output_mp3_path.to_string_lossy().to_string();
    let clamped_strength = options.strength_percent.min(100);
    let effective_options = DeepFilterOptions {
        strength_percent: clamped_strength,
        post_filter: options.post_filter,
    };

    if !enable_enhancement || clamped_strength == 0 {
        run_command_hidden(
            "ffmpeg",
            &[
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                &input_str,
                "-vn",
                "-ar",
                "44100",
                "-ac",
                "1",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
                &output_str,
            ],
        )
        .await?;
        return Ok(EnhanceResult {
            enhanced: false,
            engine: None,
            strength_percent: None,
        });
    }

    let df_bin = resolve_deep_filter_binary(resource_dir)
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| {
            // Will check PATH below if needed
            None
        });

    let df_cmd = if let Some(b) = df_bin {
        Some(b)
    } else if check_deep_filter_available(resource_dir).await {
        Some("deep-filter".to_string())
    } else {
        None
    };

    if let Some(df_program) = df_cmd {
        let work_dir = std::env::temp_dir().join(format!("aimy-df-{}", Uuid::new_v4()));
        let out_dir = work_dir.join("out");
        let _ = std::fs::create_dir_all(&out_dir);
        let wav_in = work_dir.join("input_48k.wav");
        let wav_enhanced = out_dir.join("input_48k.wav");

        let wav_in_str = wav_in.to_string_lossy().to_string();
        let out_dir_str = out_dir.to_string_lossy().to_string();
        let wav_enhanced_str = wav_enhanced.to_string_lossy().to_string();

        let step1 = run_command_hidden(
            "ffmpeg",
            &[
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                &input_str,
                "-vn",
                "-ar",
                "48000",
                "-ac",
                "1",
                "-af",
                "highpass=f=80,volume=-2dB",
                "-c:a",
                "pcm_s16le",
                &wav_in_str,
            ],
        )
        .await;

        let mut df_succeeded = false;
        if step1.is_ok() {
            let df_args_owned = build_deep_filter_args(effective_options, &out_dir_str, &wav_in_str);
            let df_args_refs: Vec<&str> = df_args_owned.iter().map(|s| s.as_str()).collect();
            if run_command_hidden(&df_program, &df_args_refs).await.is_ok() {
                if let Ok(meta) = std::fs::metadata(&wav_enhanced) {
                    if meta.len() > 0
                        && run_command_hidden(
                            "ffmpeg",
                            &[
                                "-y",
                                "-hide_banner",
                                "-loglevel",
                                "error",
                                "-i",
                                &wav_enhanced_str,
                                "-vn",
                                "-ar",
                                "44100",
                                "-ac",
                                "1",
                                "-af",
                                "dynaudnorm=f=150:g=15:p=0.9:m=10",
                                "-c:a",
                                "libmp3lame",
                                "-b:a",
                                "128k",
                                &output_str,
                            ],
                        )
                        .await
                        .is_ok()
                    {
                        df_succeeded = true;
                    }
                }
            }
        }

        let _ = std::fs::remove_dir_all(&work_dir);

        if df_succeeded {
            return Ok(EnhanceResult {
                enhanced: true,
                engine: Some("deepfilternet3".to_string()),
                strength_percent: Some(clamped_strength),
            });
        }
    }

    // Fallback: FFmpeg spectral denoise + high-pass + dynamic speech normalization
    let fallback_nr = strength_percent_to_atten_lim_db(clamped_strength).clamp(0.01, 40.0);
    let fallback_filter = format!(
        "highpass=f=80,afftdn=nr={:.1}:nf=-25,dynaudnorm=f=150:g=15:p=0.9:m=10",
        fallback_nr
    );
    run_command_hidden(
        "ffmpeg",
        &[
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &input_str,
            "-vn",
            "-ar",
            "44100",
            "-ac",
            "1",
            "-af",
            &fallback_filter,
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            &output_str,
        ],
    )
    .await?;

    Ok(EnhanceResult {
        enhanced: true,
        engine: Some("ffmpeg-denoise".to_string()),
        strength_percent: Some(clamped_strength),
    })
}

pub async fn generate_deep_filter_preview(
    options: DeepFilterOptions,
    custom_audio_base64: Option<String>,
    custom_ext: Option<String>,
    resource_dir: Option<&Path>,
) -> Result<AudioPreviewResult, String> {
    let clamped_strength = options.strength_percent.min(100);
    let effective_options = DeepFilterOptions {
        strength_percent: clamped_strength,
        post_filter: options.post_filter,
    };

    let work_dir = std::env::temp_dir().join(format!("aimy-df-preview-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create preview temp directory: {}", e))?;

    let result: Result<AudioPreviewResult, String> = async {
        let (input_path, original_mp3_bytes) = if let Some(b64) = custom_audio_base64 {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("Invalid custom audio payload: {}", e))?;
            if decoded.is_empty() {
                return Err("Recorded test clip was empty.".to_string());
            }
            let raw_ext = custom_ext
                .unwrap_or_else(|| ".webm".to_string())
                .trim()
                .to_lowercase();
            let normalized_ext = if raw_ext.starts_with('.') {
                raw_ext
            } else {
                format!(".{}", raw_ext)
            };
            let ext_safe = match normalized_ext.as_str() {
                ".mp3" | ".wav" | ".webm" | ".ogg" | ".m4a" => normalized_ext,
                _ => ".webm".to_string(),
            };
            let raw_in = work_dir.join(format!("custom_input{}", ext_safe));
            std::fs::write(&raw_in, &decoded)
                .map_err(|e| format!("Failed to stage custom test clip: {}", e))?;

            if ext_safe == ".mp3" {
                (raw_in, decoded)
            } else {
                if !check_ffmpeg_available().await {
                    return Err("FFmpeg is required to preview custom microphone recordings.".to_string());
                }
                let orig_mp3 = work_dir.join("original.mp3");
                enhance_and_encode_to_mp3(
                    &raw_in,
                    &orig_mp3,
                    false,
                    DeepFilterOptions {
                        strength_percent: 0,
                        post_filter: false,
                    },
                    resource_dir,
                )
                .await?;
                let bytes = std::fs::read(&orig_mp3)
                    .map_err(|e| format!("Failed to read original preview MP3: {}", e))?;
                (orig_mp3, bytes)
            }
        } else {
            let sample_path = work_dir.join("builtin_sample.mp3");
            std::fs::write(&sample_path, BUILTIN_TEST_SAMPLE_MP3)
                .map_err(|e| format!("Failed to stage built-in test sample: {}", e))?;
            (sample_path, BUILTIN_TEST_SAMPLE_MP3.to_vec())
        };

        let original_base64 =
            base64::engine::general_purpose::STANDARD.encode(&original_mp3_bytes);

        if clamped_strength == 0 {
            return Ok(AudioPreviewResult {
                filtered_base64: original_base64.clone(),
                original_base64,
                engine: None,
                strength_percent: 0,
                post_filter: effective_options.post_filter,
            });
        }

        if !check_ffmpeg_available().await {
            return Err("FFmpeg is required to process the DeepFilterNet3 audio preview.".to_string());
        }

        let filtered_path = work_dir.join("filtered.mp3");
        let res = enhance_and_encode_to_mp3(
            &input_path,
            &filtered_path,
            true,
            effective_options,
            resource_dir,
        )
        .await?;

        let filtered_bytes = std::fs::read(&filtered_path)
            .map_err(|e| format!("Failed to read filtered preview audio: {}", e))?;
        let filtered_base64 = base64::engine::general_purpose::STANDARD.encode(&filtered_bytes);

        Ok(AudioPreviewResult {
            original_base64,
            filtered_base64,
            engine: res.engine,
            strength_percent: clamped_strength,
            post_filter: effective_options.post_filter,
        })
    }
    .await;

    let _ = std::fs::remove_dir_all(&work_dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_strength_percent_to_expected_db() {
        assert_eq!(strength_percent_to_atten_lim_db(0), 0.0);
        assert!((strength_percent_to_atten_lim_db(25) - 10.0).abs() < 1e-4);
        assert!((strength_percent_to_atten_lim_db(50) - 20.0).abs() < 1e-4);
        assert!((strength_percent_to_atten_lim_db(75) - 30.0).abs() < 1e-4);
        assert_eq!(strength_percent_to_atten_lim_db(100), 100.0);
        assert_eq!(strength_percent_to_atten_lim_db(150), 100.0);
    }

    #[test]
    fn builds_cli_args_with_and_without_post_filter() {
        let with_pf = build_deep_filter_args(
            DeepFilterOptions {
                strength_percent: 50,
                post_filter: true,
            },
            "out",
            "in.wav",
        );
        assert_eq!(
            with_pf,
            vec![
                "--pf",
                "--compensate-delay",
                "--atten-lim-db",
                "20.0",
                "--output-dir",
                "out",
                "in.wav"
            ]
        );

        let without_pf = build_deep_filter_args(
            DeepFilterOptions {
                strength_percent: 100,
                post_filter: false,
            },
            "out",
            "in.wav",
        );
        assert_eq!(
            without_pf,
            vec![
                "--compensate-delay",
                "--atten-lim-db",
                "100.0",
                "--output-dir",
                "out",
                "in.wav"
            ]
        );
    }
}
