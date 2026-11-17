/**
 * Loopback port allocation for connected kits.
 *
 * Every client gets its own 127.0.0.1:<port> so the operator can point ssh/scp
 * at a stable port. Ports only exist on the loopback interface, so no router
 * mapping is involved.
 */

import net from 'node:net'

const PROBE_TIMEOUT_MS = 400

/** True when 127.0.0.1:port can be bound right now. */
function isFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer()
    let settled = false
    const settle = (free) => {
      if (settled) return
      settled = true
      try { probe.close() } catch { /* already closed */ }
      resolve(free)
    }
    probe.once('error', () => settle(false))
    probe.once('listening', () => settle(true))
    try {
      probe.listen(port, host)
    } catch {
      settle(false)
    }
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
}

export class PortPool {
  constructor({ base = 40001, max = 20 } = {}) {
    this.base = Number.isFinite(base) && base > 0 ? Math.floor(base) : 40001
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 20
    this.used = new Set()
  }

  /** Lowest free port at or above base that is neither booked nor bound. */
  async allocate() {
    const span = Math.max(this.max * 4, 64)
    for (let offset = 0; offset < span; offset += 1) {
      const port = this.base + offset
      if (port > 65535) break
      if (this.used.has(port)) continue
      if (await isFree(port)) {
        this.used.add(port)
        return port
      }
    }
    return 0
  }

  release(port) {
    if (Number.isInteger(port) && port > 0) this.used.delete(port)
  }

  get size() {
    return this.used.size
  }
}
