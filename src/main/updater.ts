import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/contracts'

export class Updates {
  private state: UpdateState
  private readonly configured: boolean

  constructor(url: string | null, private readonly changed: () => void) {
    this.configured = !!url && app.isPackaged
    this.state = { version: app.getVersion(), status: this.configured ? 'idle' : 'unconfigured' }
    if (!url || !this.configured) return
    const updater = electronUpdater.autoUpdater
    updater.setFeedURL({ provider: 'generic', url })
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = false
    updater.allowDowngrade = false
    updater.on('checking-for-update', () => this.set('checking'))
    updater.on('update-available', () => this.set('downloading'))
    updater.on('update-not-available', () => this.set('current'))
    updater.on('download-progress', ({ percent }) => this.set('downloading', undefined, Math.floor(percent)))
    updater.on('update-downloaded', () => this.set('ready'))
    updater.on('error', () => this.set('error', '更新检查或下载失败。请稍后重试。'))
    setTimeout(() => void this.check(), 10_000).unref()
    setInterval(() => void this.check(), 6 * 60 * 60_000).unref()
  }

  snapshot() { return this.state }

  async check() {
    if (!this.configured || ['checking', 'downloading', 'ready'].includes(this.state.status)) return
    await electronUpdater.autoUpdater.checkForUpdates().catch(() => this.set('error', '无法检查更新。请稍后重试。'))
  }

  install() {
    if (this.configured && this.state.status === 'ready') electronUpdater.autoUpdater.quitAndInstall()
  }

  private set(status: UpdateState['status'], message?: string, percent?: number) {
    this.state = { ...this.state, status, message, percent }
    this.changed()
  }
}
