import { net, powerMonitor } from 'electron'
import type { ConnectivityStatus } from '@shared/types'

const OFFLINE_POLL_MS = 10_000
const ONLINE_POLL_MS = 45_000
const PROBE_TIMEOUT_MS = 4_000

export class ConnectivityMonitor {
  private online: boolean
  private checkedAt: number
  private timer: NodeJS.Timeout | null = null
  private inflightCheck: Promise<ConnectivityStatus> | null = null
  private listeners = new Set<(status: ConnectivityStatus) => void>()
  private wakeListeners = new Set<() => void>()
  private started = false

  private readonly handleSystemWake = (): void => {
    void this.checkNow().finally(() => {
      for (const listener of this.wakeListeners) {
        listener()
      }
    })
  }

  constructor(private getProbeUrl: () => string) {
    this.online = net.isOnline()
    this.checkedAt = Date.now()
  }

  isOnline(): boolean {
    return this.online
  }

  getStatus(): ConnectivityStatus {
    return {
      online: this.online,
      checkedAt: this.checkedAt
    }
  }

  onChange(listener: (status: ConnectivityStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onWake(listener: () => void): () => void {
    this.wakeListeners.add(listener)
    return () => this.wakeListeners.delete(listener)
  }

  start(): void {
    if (this.started) return
    this.started = true
    powerMonitor.on('resume', this.handleSystemWake)
    powerMonitor.on('unlock-screen', this.handleSystemWake)
    this.scheduleNextPoll()
  }

  stop(): void {
    this.started = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    powerMonitor.removeListener('resume', this.handleSystemWake)
    powerMonitor.removeListener('unlock-screen', this.handleSystemWake)
  }

  reportNetworkError(): void {
    void this.checkNow()
  }

  async checkNow(browserHint?: boolean): Promise<ConnectivityStatus> {
    if (this.inflightCheck) {
      return this.inflightCheck
    }

    this.inflightCheck = (async () => {
      const osOnline = net.isOnline()
      let reachable = false

      if (osOnline && browserHint !== false) {
        reachable = await this.probeReachability()
      }

      const prevOnline = this.online
      this.online = reachable
      this.checkedAt = Date.now()

      if (prevOnline !== this.online) {
        const next = this.getStatus()
        for (const listener of this.listeners) {
          listener(next)
        }
      }

      if (this.started) {
        this.scheduleNextPoll()
      }

      return this.getStatus()
    })()

    try {
      return await this.inflightCheck
    } finally {
      this.inflightCheck = null
    }
  }

  private scheduleNextPoll(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.started) return
    const interval = this.online ? ONLINE_POLL_MS : OFFLINE_POLL_MS
    this.timer = setTimeout(() => {
      void this.checkNow()
    }, interval)
  }

  private async probeReachability(): Promise<boolean> {
    const rawUrl = this.getProbeUrl().trim()
    let probeUrl = 'https://us-east-1mk2fvpvwg.auth.us-east-1.amazoncognito.com/'
    if (rawUrl) {
      try {
        probeUrl = new URL(rawUrl).origin
      } catch {
        // fall back to Cognito origin
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      await fetch(probeUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal
      })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }
}
