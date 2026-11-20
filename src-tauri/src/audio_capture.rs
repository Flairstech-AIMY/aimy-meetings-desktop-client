use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

const TARGET_SAMPLE_RATE: u32 = 48_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureStartOptions {
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    pub mic_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureStartResult {
    pub has_system_audio: bool,
    pub has_mic_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureStopResult {
    pub temp_wav_path: String,
    pub ext: String,
    pub duration_seconds: i64,
}

struct ActiveControl {
    paused: Arc<AtomicBool>,
    stop_tx: Option<oneshot::Sender<bool>>,
    done_rx: Option<oneshot::Receiver<Result<NativeCaptureStopResult, String>>>,
}

#[derive(Clone, Default)]
pub struct AudioCaptureManager {
    active: Arc<Mutex<Option<ActiveControl>>>,
}

impl AudioCaptureManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(
        &self,
        app_handle: AppHandle,
        opts: NativeCaptureStartOptions,
    ) -> Result<NativeCaptureStartResult, String> {
        {
            let guard = self.active.lock().unwrap();
            if guard.is_some() {
                return Err("A recording is already in progress.".to_string());
            }
        }

        let paused = Arc::new(AtomicBool::new(false));
        let (init_tx, init_rx) = oneshot::channel::<Result<NativeCaptureStartResult, String>>();
        let (stop_tx, stop_rx) = oneshot::channel::<bool>();
        let (done_tx, done_rx) = oneshot::channel::<Result<NativeCaptureStopResult, String>>();

        let paused_for_thread = paused.clone();
        std::thread::spawn(move || {
            run_capture_thread(
                app_handle,
                opts,
                paused_for_thread,
                init_tx,
                stop_rx,
                done_tx,
            );
        });

        match init_rx.await {
            Ok(Ok(info)) => {
                let mut guard = self.active.lock().unwrap();
                *guard = Some(ActiveControl {
                    paused,
                    stop_tx: Some(stop_tx),
                    done_rx: Some(done_rx),
                });
                Ok(info)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Audio capture thread failed to initialize.".to_string()),
        }
    }

    pub fn pause(&self) {
        if let Some(ref ctrl) = *self.active.lock().unwrap() {
            ctrl.paused.store(true, Ordering::SeqCst);
        }
    }

    pub fn resume(&self) {
        if let Some(ref ctrl) = *self.active.lock().unwrap() {
            ctrl.paused.store(false, Ordering::SeqCst);
        }
    }

    pub fn abort(&self) {
        let mut ctrl = self.active.lock().unwrap().take();
        if let Some(ref mut c) = ctrl {
            if let Some(tx) = c.stop_tx.take() {
                let _ = tx.send(true);
            }
        }
    }

    pub async fn stop(&self) -> Result<NativeCaptureStopResult, String> {
        let mut ctrl = self
            .active
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "No active recording session.".to_string())?;
        if let Some(tx) = ctrl.stop_tx.take() {
            let _ = tx.send(false);
        }
        if let Some(rx) = ctrl.done_rx.take() {
            rx.await
                .map_err(|_| "Audio capture thread terminated unexpectedly.".to_string())?
        } else {
            Err("Capture session already stopped.".to_string())
        }
    }
}

fn push_downmixed_resampled(
    input: &[f32],
    channels: usize,
    in_rate: u32,
    gain: f32,
    queue: &Mutex<VecDeque<f32>>,
) {
    if channels == 0 || input.is_empty() {
        return;
    }
    let frames = input.len() / channels;
    if frames == 0 {
        return;
    }
    let mut mono = Vec::with_capacity(frames);
    for frame in input.chunks_exact(channels) {
        let sum: f32 = frame.iter().copied().sum();
        mono.push((sum / (channels as f32)) * gain);
    }

    let mut guard = queue.lock().unwrap();
    if in_rate == TARGET_SAMPLE_RATE {
        guard.extend(mono);
    } else {
        let ratio = (in_rate as f64) / (TARGET_SAMPLE_RATE as f64);
        let out_len = ((frames as f64) / ratio).round().max(1.0) as usize;
        for i in 0..out_len {
            let src_pos = (i as f64) * ratio;
            let idx = (src_pos.floor() as usize).min(frames - 1);
            let frac = (src_pos - (idx as f64)) as f32;
            let next_idx = (idx + 1).min(frames - 1);
            let sample = mono[idx] * (1.0 - frac) + mono[next_idx] * frac;
            guard.push_back(sample);
        }
    }
    // Cap queue to 10 seconds to prevent unbounded growth if the mixer stalls
    let max_cap = (TARGET_SAMPLE_RATE as usize) * 10;
    if guard.len() > max_cap {
        let excess = guard.len() - max_cap;
        guard.drain(0..excess);
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    gain: f32,
    paused: Arc<AtomicBool>,
    queue: Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels() as usize;
    let sample_rate = config.sample_rate().0;
    let stream_config: cpal::StreamConfig = config.clone().into();
    let err_fn = |err| eprintln!("[AudioCapture] Stream error: {}", err);

    let stream = match config.sample_format() {
        SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    if !paused.load(Ordering::Relaxed) {
                        push_downmixed_resampled(data, channels, sample_rate, gain, &queue);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string())?,
        SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    if !paused.load(Ordering::Relaxed) {
                        let floats: Vec<f32> =
                            data.iter().map(|&s| (s as f32) / 32768.0).collect();
                        push_downmixed_resampled(&floats, channels, sample_rate, gain, &queue);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string())?,
        SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    if !paused.load(Ordering::Relaxed) {
                        let floats: Vec<f32> = data
                            .iter()
                            .map(|&s| ((s as f32) - 32768.0) / 32768.0)
                            .collect();
                        push_downmixed_resampled(&floats, channels, sample_rate, gain, &queue);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| e.to_string())?,
        _ => return Err("Unsupported audio sample format.".to_string()),
    };

    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn soft_limit(sample: f32) -> i16 {
    // Soft knee broadcast limiter matching the WebAudio compressor curve
    let limited = sample.tanh();
    (limited * 32767.0).clamp(-32768.0, 32767.0) as i16
}

fn run_capture_thread(
    app_handle: AppHandle,
    opts: NativeCaptureStartOptions,
    paused: Arc<AtomicBool>,
    init_tx: oneshot::Sender<Result<NativeCaptureStartResult, String>>,
    mut stop_rx: oneshot::Receiver<bool>,
    done_tx: oneshot::Sender<Result<NativeCaptureStopResult, String>>,
) {
    let host = cpal::default_host();
    let sys_queue: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let mic_queue: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));

    let mut streams: Vec<cpal::Stream> = Vec::new();
    let mut has_system_audio = false;
    let mut has_mic_audio = false;

    // 1. WASAPI system audio loopback via default output device
    if opts.capture_system_audio {
        if let Some(out_dev) = host.default_output_device() {
            if let Ok(cfg) = out_dev.default_output_config() {
                match build_input_stream(
                    &out_dev,
                    &cfg,
                    0.85,
                    paused.clone(),
                    sys_queue.clone(),
                ) {
                    Ok(s) => {
                        streams.push(s);
                        has_system_audio = true;
                    }
                    Err(e) => {
                        eprintln!("[AudioCapture] System loopback unavailable: {}", e);
                    }
                }
            }
        }
    }

    // 2. Microphone capture
    if opts.capture_microphone {
        let mut chosen_mic: Option<cpal::Device> = None;
        if let Some(ref pref) = opts.mic_device_id {
            if !pref.is_empty() && pref != "default" {
                if let Ok(devs) = host.input_devices() {
                    for d in devs {
                        if d.name().ok().as_deref() == Some(pref.as_str()) {
                            chosen_mic = Some(d);
                            break;
                        }
                    }
                }
            }
        }
        if chosen_mic.is_none() {
            chosen_mic = host.default_input_device();
        }
        if let Some(mic_dev) = chosen_mic {
            if let Ok(cfg) = mic_dev.default_input_config() {
                match build_input_stream(
                    &mic_dev,
                    &cfg,
                    0.95,
                    paused.clone(),
                    mic_queue.clone(),
                ) {
                    Ok(s) => {
                        streams.push(s);
                        has_mic_audio = true;
                    }
                    Err(e) => {
                        eprintln!("[AudioCapture] Microphone unavailable: {}", e);
                    }
                }
            }
        }
    }

    if !has_system_audio && !has_mic_audio {
        let _ = init_tx.send(Err(
            "Could not access microphone or system audio. Check Windows microphone permissions and try again."
                .to_string(),
        ));
        return;
    }

    let temp_wav_path: PathBuf =
        std::env::temp_dir().join(format!("aimy-capture-{}.wav", Uuid::new_v4()));
    let wav_spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = match hound::WavWriter::create(&temp_wav_path, wav_spec) {
        Ok(w) => w,
        Err(e) => {
            let _ = init_tx.send(Err(format!("Failed to create temporary WAV file: {}", e)));
            return;
        }
    };

    let _ = init_tx.send(Ok(NativeCaptureStartResult {
        has_system_audio,
        has_mic_audio,
    }));

    let mut total_samples_written: u64 = 0;
    let mut last_tick = Instant::now();
    let mut last_level_emit = Instant::now();
    let mut aborted = false;

    loop {
        match stop_rx.try_recv() {
            Ok(is_abort) => {
                aborted = is_abort;
                break;
            }
            Err(oneshot::error::TryRecvError::Closed) => break,
            Err(oneshot::error::TryRecvError::Empty) => {}
        }

        std::thread::sleep(Duration::from_millis(30));
        let now = Instant::now();
        let elapsed = now.duration_since(last_tick);
        last_tick = now;

        if paused.load(Ordering::Relaxed) {
            sys_queue.lock().unwrap().clear();
            mic_queue.lock().unwrap().clear();
            if now.duration_since(last_level_emit) >= Duration::from_millis(90) {
                last_level_emit = now;
                let _ = app_handle.emit("recording:audio-level", 0.0f32);
            }
            continue;
        }

        let expected = ((elapsed.as_secs_f64() * (TARGET_SAMPLE_RATE as f64)).round() as usize)
            .clamp(1, (TARGET_SAMPLE_RATE as usize) / 2);

        let mut sys_guard = sys_queue.lock().unwrap();
        let mut mic_guard = mic_queue.lock().unwrap();

        let count = if has_system_audio && has_mic_audio {
            sys_guard
                .len()
                .max(mic_guard.len())
                .min(expected.max(sys_guard.len().min(mic_guard.len())))
        } else if has_system_audio {
            sys_guard.len().max(expected)
        } else {
            mic_guard.len().max(expected)
        };

        let mut sum_sq: f32 = 0.0;
        for _ in 0..count {
            let s_val = sys_guard.pop_front().unwrap_or(0.0);
            let m_val = mic_guard.pop_front().unwrap_or(0.0);
            let mixed = s_val + m_val;
            sum_sq += mixed * mixed;
            let pcm = soft_limit(mixed);
            let _ = writer.write_sample(pcm);
            total_samples_written += 1;
        }
        drop(sys_guard);
        drop(mic_guard);

        if now.duration_since(last_level_emit) >= Duration::from_millis(90) {
            last_level_emit = now;
            let rms = if count > 0 {
                (sum_sq / (count as f32)).sqrt()
            } else {
                0.0
            };
            let level = (rms * 5.0).min(1.0);
            let _ = app_handle.emit("recording:audio-level", level);
        }
    }

    drop(streams);
    let _ = app_handle.emit("recording:audio-level", 0.0f32);
    let _ = writer.finalize();

    if aborted {
        let _ = std::fs::remove_file(&temp_wav_path);
        let _ = done_tx.send(Err("Recording aborted.".to_string()));
        return;
    }

    let duration_seconds = ((total_samples_written as f64) / (TARGET_SAMPLE_RATE as f64))
        .round()
        .max(1.0) as i64;

    let _ = done_tx.send(Ok(NativeCaptureStopResult {
        temp_wav_path: temp_wav_path.to_string_lossy().to_string(),
        ext: ".wav".to_string(),
        duration_seconds,
    }));
}
