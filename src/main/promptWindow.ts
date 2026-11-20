import { BrowserWindow, screen } from 'electron'
import type { DetectedMeeting } from '@shared/types'
import { getWindowIcon } from './appIcons'

export class PromptWindowManager {
  private win: BrowserWindow | null = null
  private currentMeeting: DetectedMeeting | null = null

  constructor(private preloadPath: string, private rendererUrl?: string, private rendererHtml?: string) {}

  getActiveMeeting(): DetectedMeeting | null {
    return this.currentMeeting
  }

  show(meeting: DetectedMeeting): void {
    this.currentMeeting = meeting

    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('meeting:detected', meeting)
      this.positionBottomRight(this.win)
      this.win.showInactive()
      return
    }

    const win = new BrowserWindow({
      width: 428,
      height: 208,
      title: '',
      icon: getWindowIcon(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      thickFrame: false,
      roundedCorners: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.win = win
    this.positionBottomRight(win)

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('meeting:detected', meeting)
        win.showInactive()
      }
    })

    win.on('closed', () => {
      this.win = null
    })

    if (this.rendererUrl) {
      void win.loadURL(`${this.rendererUrl}#/meeting-prompt`)
    } else if (this.rendererHtml) {
      void win.loadFile(this.rendererHtml, { hash: '/meeting-prompt' })
    }
  }

  hide(): void {
    this.currentMeeting = null
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
    }
    this.win = null
  }

  private positionBottomRight(win: BrowserWindow): void {
    const display = screen.getPrimaryDisplay()
    const { x, y, width, height } = display.workArea
    const [winW, winH] = win.getSize()
    win.setPosition(x + width - winW - 20, y + height - winH - 20)
  }
}
