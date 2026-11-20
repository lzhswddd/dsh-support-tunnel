/**
 * Bundle the operating knowledge with the tools it describes.
 *
 * The tunnel's tools are useless without knowing how to drive them: which argument
 * resolves which machine, why `sshUp` can be true while `tunnel_exec` still fails,
 * and the twenty-odd traps listed in the reference. That knowledge lives next to the
 * tools instead of in the model's permanent context, and is loaded only when the
 * model decides it needs it.
 *
 * Two ways to register a skill exist on `ctx.skills`:
 *
 *   register()          inline content; the body becomes a JavaScript string
 *   registerProvider()  lazy; list() and get() run on demand
 *
 * This uses the provider form because the body is a real file on disk. Inlining it
 * would turn a 250-line Markdown document into an escaped string that nobody can
 * edit or diff.
 *
 * Front matter is parsed here rather than pulled from a YAML dependency: the shape
 * is three scalar keys, and a bundle that adds a dependency for that is a bundle
 * that cannot be installed offline.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_ROOT = path.join(HERE, '..', 'skills')

/**
 * Split a SKILL.md into its front matter and body.
 *
 * Deliberately minimal: `key: value` lines only, which is all a skill preamble uses.
 * A value keeps everything after the first colon, so a description containing colons
 * survives; surrounding quotes are stripped because YAML would strip them too.
 */
function splitFrontMatter(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!source.startsWith('---')) return { meta: {}, body: source }

  const close = source.indexOf('\n---', 3)
  if (close < 0) return { meta: {}, body: source }

  const head = source.slice(3, close)
  const bodyStart = source.indexOf('\n', close + 1)
  const body = bodyStart < 0 ? '' : source.slice(bodyStart + 1)

  const meta = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    const quoted = value.length > 1
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    meta[match[1]] = value
  }
  return { meta, body }
}

/**
 * Build the provider object `ctx.skills.registerProvider()` expects.
 *
 * `list()` returns summaries; `get()` returns the full body. Both are wrapped so a
 * broken skill file degrades to "this one skill is missing" rather than a failure
 * that reaches the caller and blanks the whole catalog.
 */
export function createSkillProvider({ log = () => {} } = {}) {
  let cache = null
  let stamp = ''

  /**
   * 每个 SKILL.md 的 mtime + 大小拼成的指纹。任何一处变了都算新。
   *
   * 只看 mtime 不够稳：同一秒内连改两次会拿到相同时间戳（有些文件系统精度是秒），
   * 带上 size 能挡住大部分。真正改了但两者都没变的情况极罕见，代价只是显示旧内容
   * 直到下次改动——比每轮对话都重读整个目录划算得多。
   */
  async function fingerprint() {
    let entries
    try {
      entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
    } catch {
      return ''
    }
    const parts = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const info = await stat(path.join(SKILLS_ROOT, entry.name, 'SKILL.md'))
        parts.push(`${entry.name}:${info.mtimeMs}:${info.size}`)
      } catch {
        parts.push(`${entry.name}:?`)
      }
    }
    return parts.sort().join('|')
  }

  async function scan() {
    let entries
    try {
      entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
    } catch (err) {
      // No skills directory is a legitimate build, not an error worth shouting about.
      if (err?.code !== 'ENOENT') log(`skills: cannot read ${SKILLS_ROOT}: ${err?.message || err}`)
      return { summaries: [], bodies: new Map() }
    }

    const summaries = []
    const bodies = new Map()

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(SKILLS_ROOT, entry.name)
      const file = path.join(dir, 'SKILL.md')

      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (err) {
        log(`skills: cannot read ${file}: ${err?.message || err}`)
        continue
      }

      const { meta, body } = splitFrontMatter(text)
      const name = String(meta.name || entry.name).trim()
      const description = String(meta.description || '').trim()

      // A skill without a description can never be selected: the summary is the only
      // thing the model sees when deciding whether to load it.
      if (!name || !description) {
        log(`skills: ${entry.name}/SKILL.md has no name or description, skipped`)
        continue
      }

      const summary = {
        name,
        description,
        source: 'bundled',
        provider: 'support-tunnel',
        invocation: { modelInvocable: true, userInvocable: true },
        resourceBase: { kind: 'directory', path: dir },
        rank: 0,
        locator: entry.name,
      }
      if (meta.whenToUse) summary.whenToUse = String(meta.whenToUse).trim()

      summaries.push(summary)
      bodies.set(entry.name, body.trim())
    }

    return { summaries, bodies }
  }

  async function current() {
    const now = await fingerprint()
    // 缓存必须能被文件改动打破。skill 是边用边改的文档，DSH 进程往往活好几天，
    // 一个填满就不再刷新的 cache 会把期间所有编辑都吃掉——表现是「文件明明改了，
    // 模型加载到的还是旧内容」，而且重启才能恢复，很难联想到是缓存。
    if (!cache || now !== stamp) {
      cache = await scan()
      stamp = now
    }
    return cache
  }

  return {
    name: 'support-tunnel',

    async list() {
      const { summaries } = await current()
      return summaries
    },

    async get(candidate) {
      const key = candidate?.locator
      if (typeof key !== 'string') return undefined

      let bodies = (await current()).bodies
      if (!bodies.has(key)) {
        // The service normally lists before it loads, but a cold call must still
        // work: rescan once rather than answering "no such skill".
        cache = null
        bodies = (await current()).bodies
      }

      const content = bodies.get(key)
      if (content === undefined) return undefined
      return { ...candidate, content }
    },
  }
}
