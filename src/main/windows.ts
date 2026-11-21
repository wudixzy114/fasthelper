import { execFile } from 'node:child_process'
import { join } from 'node:path'

export async function launchApplication(appId: string): Promise<void> {
  if (!/^[^\u0000-\u001f"<>|]{1,1024}$/u.test(appId)) throw new Error('应用标识无效。')
  await new Promise<void>((resolve, reject) => {
    const child = execFile(join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [`shell:AppsFolder\\${appId}`], {
      windowsHide: true,
    })
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}
