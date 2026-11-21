import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const plugin = JSON.parse(await readFile('plugins/quick-search/manifest.json', 'utf8'))
const keyFile = process.env.FASTHELPER_PLUGIN_SIGNING_KEY_FILE
const keyDir = join(process.env.LOCALAPPDATA || 'release', 'fasthelper-build')
let key
if (keyFile) {
  key = createPrivateKey(await readFile(keyFile, 'utf8'))
} else {
  if (process.env.FASTHELPER_PLUGIN_URL || process.env.FASTHELPER_UPDATE_URL) {
    throw new Error('正式发布需要 FASTHELPER_PLUGIN_SIGNING_KEY_FILE。')
  }
  await mkdir(keyDir, { recursive: true })
  const fallback = join(keyDir, 'plugin-ed25519.pem')
  const pem = await readFile(fallback, 'utf8').catch(async (error) => {
    if (error.code !== 'ENOENT') throw error
    const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })
    await writeFile(fallback, generated, { flag: 'wx', mode: 0o600 })
    return generated
  })
  key = createPrivateKey(pem)
}
if (key.asymmetricKeyType !== 'ed25519') throw new Error('插件签名密钥必须是 Ed25519。')
const worker = await build({
  entryPoints: ['plugins/quick-search/index.ts'], bundle: true, platform: 'node',
  target: 'node22', format: 'cjs', write: false,
})
const payload = Buffer.from(JSON.stringify({
  ...plugin, version: manifest.version, worker: worker.outputFiles[0].text,
}))
await mkdir('release/plugins', { recursive: true })
await writeFile('release/plugins/quick-search.fhplugin', JSON.stringify({
  payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64'),
}))
function https(name) {
  const value = process.env[name]
  if (!value) return null
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} 必须是 HTTPS 地址。`)
  return url.href
}
await writeFile('build/distribution.json', JSON.stringify({
  pluginKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }),
  pluginUrl: https('FASTHELPER_PLUGIN_URL'), updateUrl: https('FASTHELPER_UPDATE_URL'),
}))
