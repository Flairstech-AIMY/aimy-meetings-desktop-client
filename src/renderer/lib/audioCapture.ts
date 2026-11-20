export interface CaptureOptions {
  captureSystemAudio: boolean
  captureMicrophone: boolean
  micDeviceId?: string | null
  onLevel?: (level: number) => void
}

export interface CaptureResult {
  bytes: Uint8Array
  ext: string
  durationSeconds: number
  nativeTempPath?: string
}

export interface ActiveCaptureSession {
  hasSystemAudio: boolean
  hasMicAudio: boolean
  pause: () => void
  resume: () => void
  stop: () => Promise<CaptureResult>
  abort: () => void
}

function pickSupportedMime(): { mimeType: string; ext: string } {
  const candidates = [
    { mimeType: 'audio/webm;codecs=opus', ext: '.webm' },
    { mimeType: 'audio/webm', ext: '.webm' },
    { mimeType: 'audio/ogg;codecs=opus', ext: '.ogg' }
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mimeType)) {
      return c
    }
  }
  return { mimeType: '', ext: '.webm' }
}

export async function startAudioCapture(options: CaptureOptions): Promise<ActiveCaptureSession> {
  // Prefer native Rust WASAPI capture when running inside Tauri
  const desktop = typeof window !== 'undefined' ? window.aimyDesktop : undefined
  if (
    desktop?.startNativeAudioCapture &&
    desktop.stopNativeAudioCapture &&
    desktop.pauseNativeAudioCapture &&
    desktop.resumeNativeAudioCapture &&
    desktop.abortNativeAudioCapture
  ) {
    const started = await desktop.startNativeAudioCapture({
      captureSystemAudio: options.captureSystemAudio,
      captureMicrophone: options.captureMicrophone,
      micDeviceId: options.micDeviceId
    })
    const unsubLevel =
      options.onLevel && desktop.onRecordingAudioLevel
        ? desktop.onRecordingAudioLevel((lvl) => options.onLevel?.(lvl))
        : null

    return {
      hasSystemAudio: started.hasSystemAudio,
      hasMicAudio: started.hasMicAudio,
      pause: () => {
        void desktop.pauseNativeAudioCapture?.()
      },
      resume: () => {
        void desktop.resumeNativeAudioCapture?.()
      },
      abort: () => {
        unsubLevel?.()
        options.onLevel?.(0)
        void desktop.abortNativeAudioCapture?.()
      },
      stop: async () => {
        unsubLevel?.()
        options.onLevel?.(0)
        const stopped = await desktop.stopNativeAudioCapture!()
        return {
          bytes: new Uint8Array(),
          ext: stopped.ext,
          durationSeconds: stopped.durationSeconds,
          nativeTempPath: stopped.tempWavPath
        }
      }
    }
  }

  const streamsToClose: MediaStream[] = []
  let sysStream: MediaStream | null = null
  let micStream: MediaStream | null = null

  if (options.captureSystemAudio) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true
      })
      // Stop video tracks immediately — we only want the loopback system audio track
      for (const track of display.getVideoTracks()) {
        track.stop()
      }
      if (display.getAudioTracks().length > 0) {
        sysStream = new MediaStream(display.getAudioTracks())
        streamsToClose.push(display)
        streamsToClose.push(sysStream)
      } else {
        display.getTracks().forEach((t) => t.stop())
      }
    } catch (err) {
      console.warn('[AudioCapture] System loopback audio unavailable:', err)
    }
  }

  if (options.captureMicrophone) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(options.micDeviceId ? { deviceId: { ideal: options.micDeviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
      streamsToClose.push(micStream)
    } catch (err) {
      console.warn('[AudioCapture] Microphone unavailable:', err)
    }
  }

  if (!sysStream && !micStream) {
    throw new Error(
      'Could not access microphone or system audio. Check Windows microphone permissions and try again.'
    )
  }

  const audioCtx = new AudioContext()
  const destination = audioCtx.createMediaStreamDestination()
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 256

  // Broadcast-style compressor/limiter prevents digital clipping when mic + meeting audio overlap
  const limiter = audioCtx.createDynamicsCompressor()
  limiter.threshold.value = -14
  limiter.knee.value = 12
  limiter.ratio.value = 4
  limiter.attack.value = 0.003
  limiter.release.value = 0.2
  limiter.connect(destination)
  limiter.connect(analyser)

  if (sysStream) {
    const sysNode = audioCtx.createMediaStreamSource(sysStream)
    const sysGain = audioCtx.createGain()
    sysGain.gain.value = 0.85
    sysNode.connect(sysGain)
    sysGain.connect(limiter)
  }

  if (micStream) {
    const micNode = audioCtx.createMediaStreamSource(micStream)
    const micGain = audioCtx.createGain()
    micGain.gain.value = 0.95
    micNode.connect(micGain)
    micGain.connect(limiter)
  }

  const { mimeType, ext } = pickSupportedMime()
  const recorder = new MediaRecorder(
    destination.stream,
    mimeType ? { mimeType, audioBitsPerSecond: 160000 } : undefined
  )

  const chunks: Blob[] = []
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data)
    }
  }

  let startedAt = Date.now()
  let accumulatedMs = 0
  let paused = false

  const levelBuffer = new Float32Array(analyser.fftSize)
  let levelTimer: number | null = null
  if (options.onLevel) {
    levelTimer = window.setInterval(() => {
      if (paused) {
        options.onLevel?.(0)
        return
      }
      analyser.getFloatTimeDomainData(levelBuffer)
      let sum = 0
      for (let i = 0; i < levelBuffer.length; i++) {
        sum += levelBuffer[i] * levelBuffer[i]
      }
      const rms = Math.sqrt(sum / levelBuffer.length)
      options.onLevel?.(Math.min(1, rms * 5))
    }, 90)
  }

  const cleanup = (): void => {
    if (levelTimer !== null) {
      clearInterval(levelTimer)
      levelTimer = null
    }
    options.onLevel?.(0)
    for (const s of streamsToClose) {
      s.getTracks().forEach((t) => t.stop())
    }
    void audioCtx.close().catch(() => undefined)
  }

  recorder.start(1000)

  return {
    hasSystemAudio: Boolean(sysStream),
    hasMicAudio: Boolean(micStream),
    pause: () => {
      if (recorder.state === 'recording') {
        accumulatedMs += Date.now() - startedAt
        paused = true
        recorder.pause()
      }
    },
    resume: () => {
      if (recorder.state === 'paused') {
        startedAt = Date.now()
        paused = false
        recorder.resume()
      }
    },
    abort: () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        // ignore
      }
      cleanup()
    },
    stop: () =>
      new Promise<CaptureResult>((resolve, reject) => {
        if (!paused) {
          accumulatedMs += Date.now() - startedAt
        }
        const durationSeconds = Math.max(1, Math.round(accumulatedMs / 1000))

        recorder.onerror = () => {
          cleanup()
          reject(new Error('Audio recorder encountered an error while finalizing.'))
        }

        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
            const buf = await blob.arrayBuffer()
            cleanup()
            resolve({
              bytes: new Uint8Array(buf),
              ext,
              durationSeconds
            })
          } catch (err) {
            cleanup()
            reject(err)
          }
        }

        if (recorder.state !== 'inactive') {
          recorder.stop()
        } else {
          cleanup()
          resolve({ bytes: new Uint8Array(), ext, durationSeconds })
        }
      })
  }
}
