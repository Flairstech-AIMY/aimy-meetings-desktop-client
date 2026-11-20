use std::path::{Path, PathBuf};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct EnhanceResult {
    pub enhanced: bool,
    pub engine: Option<String>,
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
    resource_dir: Option<&Path>,
) -> Result<EnhanceResult, String> {
    let input_str = input_path.to_string_lossy().to_string();
    let output_str = output_mp3_path.to_string_lossy().to_string();

    if !enable_enhancement {
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
            if run_command_hidden(
                &df_program,
                &[
                    "--pf",
                    "--compensate-delay",
                    "--output-dir",
                    &out_dir_str,
                    &wav_in_str,
                ],
            )
            .await
            .is_ok()
            {
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
            });
        }
    }

    // Fallback: FFmpeg spectral denoise + high-pass + dynamic speech normalization
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
            "highpass=f=80,afftdn=nf=-25,dynaudnorm=f=150:g=15:p=0.9:m=10",
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
    })
}
