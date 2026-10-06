// 临时验证脚本：用 esbuild 把 TS 域逻辑打包成 CJS，在 Node 里跑端到端事务用例。
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const out = join(mkdtempSync(join(tmpdir(), 'rain-')), 'harness.cjs')

await build({
  entryPoints: ['src/harness/rain-harness.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out,
  logLevel: 'silent',
})

const require = createRequire(import.meta.url)
require(out)
