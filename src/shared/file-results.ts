import { open, opendir } from 'node:fs/promises'
import { extname, win32 } from 'node:path'
import type { SearchKind } from './contracts'

const documents = new Set([
  '.txt', '.md', '.pdf', '.rtf', '.csv', '.tsv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.m4a', '.mp4', '.mov', '.mkv', '.zip', '.7z',
])

export function localPath(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value) && win32.isAbsolute(value) && !/[\u0000-\u001f"]/u.test(value)
}

export function canOpenFile(filename: string): boolean {
  return documents.has(extname(filename).toLowerCase())
}

export function classifyFile(filename: string): SearchKind {
  const name = win32.basename(filename).toLowerCase()
  const ext = extname(name)
  if (['.msi', '.msix', '.appx', '.msp', '.appxbundle', '.msixbundle'].includes(ext)) return 'installer'
  if (!['.exe', '.lnk'].includes(ext)) return 'file'
  if (/(unins\d*|uninstall|卸载)/iu.test(name)) return 'uninstaller'
  if (/(setup|installer|安装包)/iu.test(name)) return 'installer'
  if (/(helper|updater|update|repair|crashpad|crashreport|redist|agent|service|trainer|辅助|修改器)/iu.test(name)) return 'helper'
  return 'portable'
}

export async function accessibleEntry(path: string, folder = false): Promise<boolean> {
  if (!localPath(path)) return false
  try {
    const parent = await opendir(win32.dirname(path))
    await parent.close()
    if (folder) {
      const entry = await opendir(path)
      await entry.close()
      return true
    }
    const file = await open(path, 'r')
    try { return (await file.stat()).isFile() } finally { await file.close() }
  } catch { return false }
}
