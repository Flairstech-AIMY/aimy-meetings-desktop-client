import { app, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

function resolveResourcePath(fileName: string): string {
  const candidates = [
    join(app.getAppPath(), 'resources', fileName),
    join(__dirname, '../../resources', fileName),
    join(process.resourcesPath, fileName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return candidates[0]
}

let cachedWindowIcon: Electron.NativeImage | null = null
let cachedAppPng: Electron.NativeImage | null = null
let cachedTrayIdle: Electron.NativeImage | null = null
let cachedTrayRecording: Electron.NativeImage | null = null

export function getWindowIcon(): Electron.NativeImage {
  if (!cachedWindowIcon) {
    const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    cachedWindowIcon = nativeImage.createFromPath(resolveResourcePath(file))
  }
  return cachedWindowIcon
}

export function getAppIconPng(): Electron.NativeImage {
  if (!cachedAppPng) {
    cachedAppPng = nativeImage.createFromPath(resolveResourcePath('icon.png'))
  }
  return cachedAppPng
}

export function getTrayIcon(recording: boolean): Electron.NativeImage {
  if (recording) {
    if (!cachedTrayRecording) {
      cachedTrayRecording = nativeImage.createFromPath(resolveResourcePath('tray-recording.png'))
    }
    return cachedTrayRecording
  }
  if (!cachedTrayIdle) {
    cachedTrayIdle = nativeImage.createFromPath(resolveResourcePath('tray-idle.png'))
  }
  return cachedTrayIdle
}
