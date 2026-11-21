import { readFile } from 'node:fs/promises'
import builder from 'electron-builder'

const { updateUrl } = JSON.parse(await readFile('build/distribution.json', 'utf8'))
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const { Arch, Platform, build } = builder
await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: {
    directories: { output: `release/windows/${version}` },
    ...(updateUrl ? { forceCodeSigning: true, publish: { provider: 'generic', url: updateUrl } } : {}),
  },
})
