import { app, BrowserWindow, safeStorage, session, shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AuthSession, AuthStateReason, AuthUser, SignInMethod } from '@shared/types'
import { getWindowIcon } from './appIcons'

interface StoredAuthPayload {
  idToken: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number | null
  user?: AuthUser
}

interface PendingBrowserAuth {
  state: string
  codeVerifier: string
  resolve: (session: AuthSession) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
}

type RefreshOutcome = 'refreshed' | 'unauthorized' | 'network_error'

export const AUTH_PROTOCOL = 'aimy-meetings'
export const AUTH_CALLBACK_URL = `${AUTH_PROTOCOL}://auth/callback`

const AUTH_PARTITION = 'persist:aimy-auth'
const COGNITO_DOMAIN = 'https://us-east-1mk2fvpvwg.auth.us-east-1.amazoncognito.com'
const COGNITO_AUTHORIZE_URL = `${COGNITO_DOMAIN}/oauth2/authorize`
const COGNITO_TOKEN_URL = `${COGNITO_DOMAIN}/oauth2/token`
const COGNITO_CLIENT_ID = '15ekjkcakreuqhhog5vh4flhvm'
const COGNITO_SCOPES = 'openid email profile'

const REFRESH_BUFFER_MS = 60_000
const MAX_TIMEOUT_MS = 2_147_483_647
const BROWSER_AUTH_TIMEOUT_MS = 5 * 60_000

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = toBase64Url(randomBytes(32))
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

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
  private lastKnownUser: AuthUser | undefined = undefined
  private lastKnownExpiresAt: number | null | undefined = undefined
  private lastReason: AuthStateReason = 'initial'
  private loginWindow: BrowserWindow | null = null
  private loginWindowCancelling = false
  private pendingBrowserAuth: PendingBrowserAuth | null = null
  private expiryTimer: NodeJS.Timeout | null = null
  private refreshInFlight: Promise<RefreshOutcome> | null = null
  private listeners = new Set<(session: AuthSession) => void>()

  constructor(private isOnline: () => boolean = () => true) {
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
        this.lastKnownUser = parsed.user
        this.lastKnownExpiresAt = parsed.expiresAt ?? null
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

  private clearExpiryTimer(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  private scheduleExpiryTimer(): void {
    this.clearExpiryTimer()
    if (!this.payload?.idToken || !this.payload.expiresAt) return

    const targetTime = this.payload.refreshToken
      ? this.payload.expiresAt - REFRESH_BUFFER_MS
      : this.payload.expiresAt + 500

    const remaining = targetTime - Date.now()
    const delay = Math.max(1_000, Math.min(remaining, MAX_TIMEOUT_MS))

    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      void this.onExpiryTimerFired()
    }, delay)
  }

  private async onExpiryTimerFired(): Promise<void> {
    if (!this.payload?.idToken || !this.payload.expiresAt) return
    const now = Date.now()

    if (this.payload.refreshToken) {
      if (this.payload.expiresAt - REFRESH_BUFFER_MS > now + 2_000) {
        this.scheduleExpiryTimer()
        return
      }
      if (!this.isOnline()) {
        // Stay quiet while offline; onConnectivityRestored will refresh when back online.
        return
      }
      const outcome = await this.tryRefreshToken(this.payload.refreshToken)
      if (outcome === 'unauthorized') {
        this.markExpired()
      } else if (outcome === 'refreshed') {
        this.scheduleExpiryTimer()
      }
      return
    }

    if (now < this.payload.expiresAt) {
      this.scheduleExpiryTimer()
      return
    }

    this.markExpired()
  }

  private markExpired(): void {
    const prevUser = this.payload?.user ?? this.lastKnownUser
    const prevExpiresAt = this.payload?.expiresAt ?? this.lastKnownExpiresAt ?? null
    this.clearExpiryTimer()
    this.payload = null
    this.lastKnownUser = prevUser
    this.lastKnownExpiresAt = prevExpiresAt
    this.lastReason = 'expired'
    this.saveToDisk()
    this.emit()
  }

  private setAuthenticatedPayload(next: StoredAuthPayload, reason: AuthStateReason = 'signed-in'): void {
    const exp = expiresAtFromToken(next.idToken, next.expiresAt)
    const user = userFromToken(next.idToken, next.user)
    this.payload = {
      idToken: next.idToken,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: exp,
      user
    }
    this.lastKnownUser = user
    this.lastKnownExpiresAt = exp
    this.lastReason = reason
    this.saveToDisk()
    this.scheduleExpiryTimer()
    this.emit()
  }

  async initialize(): Promise<void> {
    if (!this.payload?.idToken) {
      this.lastReason = 'initial'
      return
    }

    const now = Date.now()
    const expiresAt = this.payload.expiresAt ?? null

    if (expiresAt != null && expiresAt - REFRESH_BUFFER_MS <= now) {
      if (this.payload.refreshToken) {
        if (this.isOnline()) {
          const outcome = await this.tryRefreshToken(this.payload.refreshToken)
          if (outcome === 'unauthorized') {
            this.markExpired()
          } else if (outcome === 'refreshed') {
            this.scheduleExpiryTimer()
          }
        }
        return
      }

      if (expiresAt <= now) {
        this.markExpired()
        return
      }
    }

    this.scheduleExpiryTimer()
  }

  async onConnectivityRestored(): Promise<void> {
    if (!this.payload?.idToken) return

    const now = Date.now()
    const expiresAt = this.payload.expiresAt ?? null
    if (expiresAt != null && expiresAt - REFRESH_BUFFER_MS <= now) {
      if (this.payload.refreshToken) {
        const outcome = await this.tryRefreshToken(this.payload.refreshToken)
        if (outcome === 'unauthorized') {
          this.markExpired()
        } else if (outcome === 'refreshed') {
          this.scheduleExpiryTimer()
        }
        return
      }
      if (expiresAt <= now) {
        this.markExpired()
        return
      }
    }

    // Re-arm timer (important after laptop sleep/resume where timers drift)
    this.scheduleExpiryTimer()
  }

  getSession(): AuthSession {
    if (!this.payload?.idToken) {
      return {
        authenticated: false,
        user: this.lastReason === 'expired' ? this.lastKnownUser : undefined,
        expiresAt: this.lastReason === 'expired' ? this.lastKnownExpiresAt : undefined,
        reason: this.lastReason
      }
    }
    const now = Date.now()
    const expired = this.payload.expiresAt != null && this.payload.expiresAt <= now
    if (expired && !this.payload.refreshToken) {
      return {
        authenticated: false,
        user: this.payload.user,
        expiresAt: this.payload.expiresAt,
        reason: 'expired'
      }
    }
    return {
      authenticated: true,
      user: this.payload.user,
      expiresAt: this.payload.expiresAt ?? null,
      hasRefreshToken: Boolean(this.payload.refreshToken),
      reason: this.lastReason
    }
  }

  async getValidToken(): Promise<string | null> {
    if (!this.payload?.idToken) return null
    const now = Date.now()
    if (this.payload.expiresAt && this.payload.expiresAt - REFRESH_BUFFER_MS <= now) {
      if (this.payload.refreshToken) {
        if (!this.isOnline()) return null
        const outcome = await this.tryRefreshToken(this.payload.refreshToken)
        if (outcome === 'refreshed' && this.payload?.idToken) {
          return this.payload.idToken
        }
        if (outcome === 'unauthorized') {
          this.markExpired()
        }
        return null
      }
      if (this.payload.expiresAt <= now) {
        this.markExpired()
      }
      return null
    }
    return this.payload.idToken
  }

  async handleUnauthorized(): Promise<string | null> {
    if (!this.payload?.idToken) return null

    if (this.payload.refreshToken && this.isOnline()) {
      const outcome = await this.tryRefreshToken(this.payload.refreshToken)
      if (outcome === 'refreshed' && this.payload?.idToken) {
        return this.payload.idToken
      }
      if (outcome === 'network_error') {
        return null
      }
    }

    this.markExpired()
    return null
  }

  private async tryRefreshToken(refreshToken: string): Promise<RefreshOutcome> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    this.refreshInFlight = (async (): Promise<RefreshOutcome> => {
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
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          return 'unauthorized'
        }
        if (!res.ok) {
          return 'network_error'
        }
        const data = (await res.json()) as {
          id_token?: string
          access_token?: string
          refresh_token?: string
          expires_in?: number
        }
        if (!data.id_token) return 'unauthorized'
        this.setAuthenticatedPayload(
          {
            idToken: data.id_token,
            accessToken: data.access_token ?? this.payload?.accessToken,
            refreshToken: data.refresh_token ?? refreshToken,
            expiresAt: expiresAtFromToken(
              data.id_token,
              data.expires_in ? Date.now() + data.expires_in * 1000 : null
            ),
            user: userFromToken(data.id_token, this.payload?.user)
          },
          'signed-in'
        )
        return 'refreshed'
      } catch (err) {
        console.error('[Auth] Token refresh failed:', err)
        return 'network_error'
      }
    })()

    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
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
    this.setAuthenticatedPayload(
      {
        idToken: token,
        expiresAt: exp,
        user: userFromToken(token)
      },
      'signed-in'
    )
    return this.getSession()
  }

  cancelSignIn(): void {
    this.cancelPendingBrowserAuth()
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindowCancelling = true
      this.loginWindow.close()
    }
  }

  private cancelPendingBrowserAuth(): void {
    if (!this.pendingBrowserAuth) return
    const pending = this.pendingBrowserAuth
    this.pendingBrowserAuth = null
    clearTimeout(pending.timeout)
    pending.resolve(this.getSession())
  }

  async signOut(): Promise<AuthSession> {
    this.cancelSignIn()
    this.clearExpiryTimer()
    this.payload = null
    this.lastKnownUser = undefined
    this.lastKnownExpiresAt = undefined
    this.lastReason = 'signed-out'
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

  dispose(): void {
    this.clearExpiryTimer()
    this.cancelSignIn()
  }

  async signIn(
    consoleBaseUrl: string,
    parent?: BrowserWindow | null,
    method: SignInMethod = 'browser'
  ): Promise<AuthSession> {
    if (method === 'embedded') {
      this.cancelPendingBrowserAuth()
      return this.signInViaEmbeddedWindow(consoleBaseUrl, parent)
    }
    return this.signInViaBrowser()
  }

  private async signInViaBrowser(): Promise<AuthSession> {
    // Cancel any existing embedded or browser attempt before launching a fresh one
    this.cancelSignIn()

    const { codeVerifier, codeChallenge } = createPkcePair()
    const state = toBase64Url(randomBytes(24))

    const params = new URLSearchParams({
      client_id: COGNITO_CLIENT_ID,
      response_type: 'code',
      scope: COGNITO_SCOPES,
      redirect_uri: AUTH_CALLBACK_URL,
      state,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge
    })
    const authorizeUrl = `${COGNITO_AUTHORIZE_URL}?${params.toString()}`

    return new Promise<AuthSession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingBrowserAuth?.state === state) {
          this.pendingBrowserAuth = null
          reject(
            new Error(
              'Browser sign-in timed out. Make sure aimy-meetings://auth/callback is allowed in Cognito, or use the built-in sign-in window.'
            )
          )
        }
      }, BROWSER_AUTH_TIMEOUT_MS)

      this.pendingBrowserAuth = {
        state,
        codeVerifier,
        resolve,
        reject,
        timeout
      }

      void shell.openExternal(authorizeUrl).catch((err) => {
        if (this.pendingBrowserAuth?.state === state) {
          clearTimeout(timeout)
          this.pendingBrowserAuth = null
          reject(
            err instanceof Error
              ? err
              : new Error('Could not open your default browser for sign-in.')
          )
        }
      })
    })
  }

  async handleProtocolCallback(rawUrl: string): Promise<boolean> {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return false
    }

    if (parsed.protocol !== `${AUTH_PROTOCOL}:`) {
      return false
    }

    const pending = this.pendingBrowserAuth
    if (!pending) {
      return true
    }

    const oauthError = parsed.searchParams.get('error')
    const oauthErrorDescription = parsed.searchParams.get('error_description')
    if (oauthError) {
      this.pendingBrowserAuth = null
      clearTimeout(pending.timeout)
      const detail = oauthErrorDescription || oauthError
      pending.reject(new Error(`Sign-in was rejected by Cognito: ${detail}`))
      return true
    }

    const state = parsed.searchParams.get('state')
    const code = parsed.searchParams.get('code')
    if (!code || state !== pending.state) {
      this.pendingBrowserAuth = null
      clearTimeout(pending.timeout)
      pending.reject(new Error('Invalid sign-in callback received. Please try signing in again.'))
      return true
    }

    this.pendingBrowserAuth = null
    clearTimeout(pending.timeout)

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: COGNITO_CLIENT_ID,
        code,
        redirect_uri: AUTH_CALLBACK_URL,
        code_verifier: pending.codeVerifier
      })

      const res = await fetch(COGNITO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })

      const text = await res.text()
      type CognitoTokenResponse = {
        id_token?: string
        access_token?: string
        refresh_token?: string
        expires_in?: number
        error?: string
        error_description?: string
      }
      let data: CognitoTokenResponse | null = null
      try {
        data = text ? (JSON.parse(text) as CognitoTokenResponse) : null
      } catch {
        data = null
      }

      if (!res.ok || !data?.id_token) {
        const msg =
          data?.error_description ||
          data?.error ||
          `Token exchange failed with HTTP ${res.status}.`
        pending.reject(new Error(msg))
        return true
      }

      this.setAuthenticatedPayload(
        {
          idToken: data.id_token,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: expiresAtFromToken(
            data.id_token,
            data.expires_in ? Date.now() + data.expires_in * 1000 : null
          ),
          user: userFromToken(data.id_token)
        },
        'signed-in'
      )

      pending.resolve(this.getSession())
      return true
    } catch (err) {
      pending.reject(
        err instanceof Error
          ? err
          : new Error('Failed to exchange sign-in code with Cognito.')
      )
      return true
    }
  }

  private async signInViaEmbeddedWindow(
    consoleBaseUrl: string,
    parent?: BrowserWindow | null
  ): Promise<AuthSession> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return this.getSession()
    }

    const baseUrl = consoleBaseUrl.replace(/\/$/, '')
    const loginUrl = `${baseUrl}/console`
    const targetHost = new URL(baseUrl).hostname
    const authSession = session.fromPartition(AUTH_PARTITION)
    this.loginWindowCancelling = false

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
        this.setAuthenticatedPayload(
          {
            idToken: next.idToken,
            accessToken: next.accessToken,
            refreshToken: next.refreshToken,
            expiresAt: exp,
            user: userFromToken(next.idToken, next.user)
          },
          'signed-in'
        )
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
        const wasCancelled = this.loginWindowCancelling
        this.loginWindowCancelling = false
        cleanup()
        if (!settled) {
          settled = true
          if (wasCancelled) {
            resolve(this.getSession())
          } else {
            reject(new Error('Sign-in window was closed before completing authentication.'))
          }
        }
      })

      void win.loadURL(loginUrl)
    })
  }
}
