import { app, BrowserWindow, safeStorage, session } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AuthSession, AuthUser } from '@shared/types'
import { getWindowIcon } from './appIcons'

interface StoredAuthPayload {
  idToken: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number | null
  user?: AuthUser
}

const AUTH_PARTITION = 'persist:aimy-auth'
const COGNITO_TOKEN_URL =
  'https://us-east-1mk2fvpvwg.auth.us-east-1.amazoncognito.com/oauth2/token'
const COGNITO_CLIENT_ID = '15ekjkcakreuqhhog5vh4flhvm'

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return null
  }
}

function userFromToken(token: string, fallback?: AuthUser): AuthUser {
  const claims = decodeJwtPayload(token)
  const email =
    (typeof claims?.email === 'string' && claims.email) ||
    fallback?.email ||
    undefined
  const name =
    (typeof claims?.name === 'string' && claims.name) ||
    (typeof claims?.['cognito:username'] === 'string' && claims['cognito:username']) ||
    fallback?.name ||
    email
  const id =
    (typeof claims?.sub === 'string' && claims.sub) ||
    fallback?.id ||
    undefined
  return { id, name, email }
}

function expiresAtFromToken(token: string, fallback?: number | null): number | null {
  const claims = decodeJwtPayload(token)
  if (typeof claims?.exp === 'number') {
    return claims.exp * 1000
  }
  if (typeof fallback === 'number') {
    return fallback > 1e12 ? fallback : fallback * 1000
  }
  return null
}

export class AuthManager {
  private payload: StoredAuthPayload | null = null
  private loginWindow: BrowserWindow | null = null
  private listeners = new Set<(session: AuthSession) => void>()

  constructor() {
    this.loadFromDisk()
  }

  private get storePath(): string {
    return join(app.getPath('userData'), 'auth-session.dat')
  }

  onChange(listener: (session: AuthSession) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const state = this.getSession()
    for (const listener of this.listeners) {
      listener(state)
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.storePath)) return
      const raw = readFileSync(this.storePath)
      let jsonStr: string
      if (safeStorage.isEncryptionAvailable()) {
        try {
          jsonStr = safeStorage.decryptString(raw)
        } catch {
          jsonStr = raw.toString('utf8')
        }
      } else {
        jsonStr = raw.toString('utf8')
      }
      const parsed = JSON.parse(jsonStr) as StoredAuthPayload
      if (parsed?.idToken) {
        this.payload = parsed
      }
    } catch (err) {
      console.error('[Auth] Failed to load saved session:', err)
      this.payload = null
    }
  }

  private saveToDisk(): void {
    try {
      if (!this.payload) {
        if (existsSync(this.storePath)) unlinkSync(this.storePath)
        return
      }
      const serialized = JSON.stringify(this.payload)
      if (safeStorage.isEncryptionAvailable()) {
        writeFileSync(this.storePath, safeStorage.encryptString(serialized))
      } else {
        writeFileSync(this.storePath, serialized, 'utf8')
      }
    } catch (err) {
      console.error('[Auth] Failed to persist session:', err)
    }
  }

  getSession(): AuthSession {
    if (!this.payload?.idToken) {
      return { authenticated: false }
    }
    const now = Date.now()
    const expired = this.payload.expiresAt != null && this.payload.expiresAt <= now
    if (expired && !this.payload.refreshToken) {
      return {
        authenticated: false,
        user: this.payload.user,
        expiresAt: this.payload.expiresAt
      }
    }
    return {
      authenticated: true,
      user: this.payload.user,
      expiresAt: this.payload.expiresAt ?? null,
      hasRefreshToken: Boolean(this.payload.refreshToken)
    }
  }

  async getValidToken(): Promise<string | null> {
    if (!this.payload?.idToken) return null
    const now = Date.now()
    const bufferMs = 60_000
    if (this.payload.expiresAt && this.payload.expiresAt - bufferMs <= now) {
      if (this.payload.refreshToken) {
        const refreshed = await this.tryRefreshToken(this.payload.refreshToken)
        if (refreshed) return this.payload.idToken
      }
      return null
    }
    return this.payload.idToken
  }

  private async tryRefreshToken(refreshToken: string): Promise<boolean> {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: COGNITO_CLIENT_ID,
        refresh_token: refreshToken
      })
      const res = await fetch(COGNITO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
      if (!res.ok) return false
      const data = (await res.json()) as {
        id_token?: string
        access_token?: string
        expires_in?: number
      }
      if (!data.id_token) return false
      this.payload = {
        idToken: data.id_token,
        accessToken: data.access_token ?? this.payload?.accessToken,
        refreshToken,
        expiresAt: expiresAtFromToken(
          data.id_token,
          data.expires_in ? Date.now() + data.expires_in * 1000 : null
        ),
        user: userFromToken(data.id_token, this.payload?.user)
      }
      this.saveToDisk()
      this.emit()
      return true
    } catch (err) {
      console.error('[Auth] Token refresh failed:', err)
      return false
    }
  }

  setManualToken(rawToken: string): AuthSession {
    const token = rawToken.trim().replace(/^Bearer\s+/i, '')
    if (!token || token.split('.').length < 2) {
      throw new Error('Please paste a valid Cognito JWT token.')
    }
    const exp = expiresAtFromToken(token)
    if (exp && exp <= Date.now()) {
      throw new Error('This token is already expired. Please sign in to get a fresh token.')
    }
    this.payload = {
      idToken: token,
      expiresAt: exp,
      user: userFromToken(token)
    }
    this.saveToDisk()
    this.emit()
    return this.getSession()
  }

  async signOut(): Promise<AuthSession> {
    this.payload = null
    this.saveToDisk()
    try {
      const authSession = session.fromPartition(AUTH_PARTITION)
      await authSession.clearStorageData()
    } catch (err) {
      console.warn('[Auth] Failed to clear auth partition storage:', err)
    }
    this.emit()
    return this.getSession()
  }

  async signIn(consoleBaseUrl: string, parent?: BrowserWindow | null): Promise<AuthSession> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return this.getSession()
    }

    const baseUrl = consoleBaseUrl.replace(/\/$/, '')
    const loginUrl = `${baseUrl}/console`
    const targetHost = new URL(baseUrl).hostname
    const authSession = session.fromPartition(AUTH_PARTITION)

    return new Promise<AuthSession>((resolve, reject) => {
      let settled = false
      let pollTimer: NodeJS.Timeout | null = null

      const cleanup = (): void => {
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        try {
          authSession.webRequest.onBeforeSendHeaders(null)
        } catch {
          // ignore
        }
      }

      const finishWithPayload = (next: StoredAuthPayload): void => {
        if (settled) return
        const exp = expiresAtFromToken(next.idToken, next.expiresAt)
        if (exp && exp <= Date.now() + 5000) {
          return // ignore stale expired token still in storage before redirect
        }
        settled = true
        cleanup()
        this.payload = {
          idToken: next.idToken,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: exp,
          user: userFromToken(next.idToken, next.user)
        }
        this.saveToDisk()
        this.emit()
        if (this.loginWindow && !this.loginWindow.isDestroyed()) {
          this.loginWindow.close()
        }
        resolve(this.getSession())
      }

      const win = new BrowserWindow({
        width: 520,
        height: 740,
        title: 'Sign in to AiMY Knowledge',
        icon: getWindowIcon(),
        parent: parent ?? undefined,
        modal: false,
        autoHideMenuBar: true,
        backgroundColor: '#0b0e14',
        webPreferences: {
          session: authSession,
          nodeIntegration: false,
          contextIsolation: true
        }
      })
      this.loginWindow = win

      // 1. Intercept live Authorization: Bearer header sent to AiMY APIs
      authSession.webRequest.onBeforeSendHeaders(
        { urls: ['https://*.aimy.flairstech.com/*'] },
        (details, callback) => {
          const authHeader =
            details.requestHeaders.Authorization || details.requestHeaders.authorization
          if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
            const token = authHeader.slice(7).trim()
            if (token.split('.').length === 3) {
              // Also try to read full OIDC entry for refresh token & profile
              void inspectStorage().then((oidc) => {
                if (oidc?.idToken) {
                  finishWithPayload(oidc)
                } else {
                  finishWithPayload({ idToken: token })
                }
              })
            }
          }
          callback({ requestHeaders: details.requestHeaders })
        }
      )

      // 2. Poll OIDC storage in the AiMY Console window after Cognito redirect completes
      const inspectStorage = async (): Promise<StoredAuthPayload | null> => {
        if (win.isDestroyed()) return null
        try {
          const currentUrl = win.webContents.getURL()
          if (!currentUrl || new URL(currentUrl).hostname !== targetHost) return null
          const found = await win.webContents.executeJavaScript(`
            (() => {
              const stores = [window.sessionStorage, window.localStorage];
              for (const store of stores) {
                try {
                  for (let i = 0; i < store.length; i++) {
                    const key = store.key(i);
                    if (!key) continue;
                    if (
                      key.startsWith('oidc.user:') ||
                      key.startsWith('CognitoIdentityServiceProvider.')
                    ) {
                      const raw = store.getItem(key);
                      if (!raw) continue;
                      if (raw.startsWith('{')) {
                        const obj = JSON.parse(raw);
                        const idToken = obj.id_token || obj.idToken;
                        if (typeof idToken === 'string' && idToken.split('.').length === 3) {
                          return {
                            idToken,
                            accessToken: obj.access_token || obj.accessToken,
                            refreshToken: obj.refresh_token || obj.refreshToken,
                            expiresAt: obj.expires_at || null,
                            user: obj.profile ? {
                              id: obj.profile.sub,
                              name: obj.profile.name || obj.profile.email,
                              email: obj.profile.email
                            } : undefined
                          };
                        }
                      }
                    }
                  }
                  const direct = store.getItem('oidc.id_token') || store.getItem('id_token');
                  if (direct && direct.split('.').length === 3) {
                    return { idToken: direct };
                  }
                } catch {}
              }
              return null;
            })()
          `)
          return (found as StoredAuthPayload | null) ?? null
        } catch {
          return null
        }
      }

      pollTimer = setInterval(() => {
        void inspectStorage().then((found) => {
          if (found?.idToken) {
            finishWithPayload(found)
          }
        })
      }, 900)

      win.on('closed', () => {
        this.loginWindow = null
        cleanup()
        if (!settled) {
          settled = true
          reject(new Error('Sign-in window was closed before completing authentication.'))
        }
      })

      void win.loadURL(loginUrl)
    })
  }
}
