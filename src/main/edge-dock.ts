import { screen, type BrowserWindow, type Rectangle } from 'electron'

const handleWidth = 9
const handleHeight = 84
const inside = (bounds: Rectangle, x: number, y: number) =>
  x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height

export class EdgeDock {
  expanded = false
  held = false
  private since = 0
  private blocked = false
  private height = 288
  private displayId = screen.getPrimaryDisplay().id
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly window: BrowserWindow,
    private readonly visibility: (open: boolean) => void,
  ) {
    this.timer = setInterval(() => this.check(), 90).unref()
    screen.on('display-metrics-changed', this.position)
    screen.on('display-removed', this.position)
    window.on('closed', () => this.dispose())
  }

  show(focus: boolean, followCursor = false) {
    if (followCursor) this.displayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    this.expanded = true
    this.since = 0
    this.position()
    if (focus) { this.window.show(); this.window.focus() }
    else this.window.showInactive()
    this.visibility(true)
  }

  collapse(blocked = false) {
    this.expanded = false
    this.held = false
    this.blocked = blocked
    this.since = 0
    this.position()
    if (this.window.isFocused()) this.window.blur()
    this.window.showInactive()
    this.visibility(false)
  }

  resize(height: number) {
    this.height = height
    if (this.expanded) this.position()
  }

  dispose() {
    clearInterval(this.timer)
    screen.off('display-metrics-changed', this.position)
    screen.off('display-removed', this.position)
  }

  private readonly position = () => {
    if (this.window.isDestroyed()) return
    const display = screen.getAllDisplays().find((entry) => entry.id === this.displayId) ?? screen.getPrimaryDisplay()
    this.displayId = display.id
    const area = display.workArea
    const width = Math.min(area.width, 560)
    const height = Math.min(area.height, this.expanded ? Math.max(215, Math.min(540, this.height)) : handleHeight)
    const center = area.y + area.height * 0.42
    const y = Math.max(area.y, Math.min(Math.round(center - height / 2), area.y + area.height - height))
    this.window.setBounds({ width, height, x: area.x + area.width - width, y })
    const bounds = this.window.getBounds()
    // Windows enforces a native minimum window size even when the visible handle is narrower.
    this.window.setShape(this.expanded ? [] : [{ x: bounds.width - handleWidth, y: 0, width: handleWidth, height: Math.min(bounds.height, handleHeight) }])
  }

  private check() {
    if (this.window.isDestroyed() || !this.window.isVisible()) return
    const { x, y } = screen.getCursorScreenPoint()
    const bounds = this.window.getBounds()
    const target = this.expanded ? bounds : {
      x: bounds.x + bounds.width - handleWidth, y: bounds.y,
      width: handleWidth, height: Math.min(bounds.height, handleHeight),
    }
    const hovered = inside(target, x, y)
    if (!hovered) this.blocked = false
    const trigger = this.expanded ? !hovered && !this.held && !this.window.isFocused() : hovered && !this.blocked
    if (!trigger) { this.since = 0; return }
    const now = Date.now()
    if (!this.since) this.since = now
    if (now - this.since < (this.expanded ? 420 : 130)) return
    if (this.expanded) this.collapse()
    else this.show(false)
  }
}
