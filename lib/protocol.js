/**
 * Tunnel frame codec.
 *
 *   +--------+------------+----------+------------------+
 *   | type   | streamId   | length   | payload          |
 *   | 1 byte | 4 byte BE  | 2 byte BE| length byte(s)   |
 *   +--------+------------+----------+------------------+
 *
 * The same module is mirrored by support-agent/tunnel.py; keep both in sync.
 */

export const FRAME = Object.freeze({
  NEW: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  PING: 0x04,
})

export const FRAME_NAMES = Object.freeze({
  0x01: 'NEW',
  0x02: 'DATA',
  0x03: 'CLOSE',
  0x04: 'PING',
})

export const HEADER_SIZE = 7
export const MAX_PAYLOAD = 0xffff
/**
 * Payload per DATA frame. Sized just below the 65535 cap so one socket read
 * becomes one or two frames: every frame costs a chunked-encoding header plus a
 * writev, and at 16 KiB those dominated the server profile.
 */
export const CHUNK_SIZE = 60 * 1024

const EMPTY = Buffer.alloc(0)

/**
 * Encode one frame. Payload is capped at 65535 bytes by the 2-byte length field;
 * callers split larger reads into CHUNK_SIZE pieces.
 */
export function encodeFrame(type, streamId, payload) {
  const body = payload === undefined || payload === null
    ? EMPTY
    : Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (body.length > MAX_PAYLOAD) {
    throw new RangeError(`frame payload ${body.length} exceeds ${MAX_PAYLOAD}`)
  }
  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length)
  frame[0] = type
  frame.writeUInt32BE(streamId >>> 0, 1)
  frame.writeUInt16BE(body.length, 5)
  if (body.length > 0) body.copy(frame, HEADER_SIZE)
  return frame
}

/** Read the header of a buffered frame without consuming it. */
export function peekHeader(buffer) {
  if (buffer.length < HEADER_SIZE) return undefined
  return {
    type: buffer[0],
    streamId: buffer.readUInt32BE(1),
    length: buffer.readUInt16BE(5),
  }
}

/**
 * Frame one socket read into a single buffer, so the caller needs one write
 * instead of one per frame. Returns an empty buffer for an empty chunk.
 */
export function encodeDataChunk(streamId, chunk, maxPayload = CHUNK_SIZE) {
  if (chunk.length === 0) return EMPTY
  const frameCount = Math.ceil(chunk.length / maxPayload)
  const output = Buffer.allocUnsafe(chunk.length + frameCount * HEADER_SIZE)
  let source = 0
  let target = 0
  while (source < chunk.length) {
    const length = Math.min(maxPayload, chunk.length - source)
    output[target] = FRAME.DATA
    output.writeUInt32BE(streamId >>> 0, target + 1)
    output.writeUInt16BE(length, target + 5)
    chunk.copy(output, target + HEADER_SIZE, source, source + length)
    target += HEADER_SIZE + length
    source += length
  }
  return output
}

/**
 * Incremental decoder; push() returns every frame completed by the chunk.
 *
 * It keeps a list of the buffers it was handed and slices frames out of them.
 * Concatenating the leftover with each new chunk copied the whole stream twice
 * when frame boundaries did not line up with chunk boundaries; now the only
 * copy left is the rare frame that straddles two chunks.
 */
export class FrameDecoder {
  #chunks = []
  #size = 0

  push(chunk) {
    if (chunk && chunk.length > 0) {
      this.#chunks.push(chunk)
      this.#size += chunk.length
    }
    const frames = []
    while (this.#size >= HEADER_SIZE) {
      const header = this.#peekHeader()
      const length = header.readUInt16BE(5)
      const total = HEADER_SIZE + length
      if (this.#size < total) break
      frames.push({
        type: header[0],
        streamId: header.readUInt32BE(1),
        payload: this.#takePayload(total),
      })
    }
    return frames
  }

  /** Header bytes without consuming them; copies at most 7 bytes when split. */
  #peekHeader() {
    const first = this.#chunks[0]
    if (first.length >= HEADER_SIZE) return first
    const header = Buffer.allocUnsafe(HEADER_SIZE)
    let filled = 0
    for (const part of this.#chunks) {
      const take = Math.min(HEADER_SIZE - filled, part.length)
      part.copy(header, filled, 0, take)
      filled += take
      if (filled === HEADER_SIZE) break
    }
    return header
  }

  /**
   * Consume `total` bytes (frame header included) and return only the payload.
   * Copying happens only for a frame that straddles two buffered chunks.
   */
  #takePayload(total) {
    const first = this.#chunks[0]
    if (first.length === total) {
      this.#chunks.shift()
      this.#size -= total
      return first.subarray(HEADER_SIZE)
    }
    if (first.length > total) {
      this.#chunks[0] = first.subarray(total)
      this.#size -= total
      return first.subarray(HEADER_SIZE, total)
    }
    const payloadSize = total - HEADER_SIZE
    const output = Buffer.allocUnsafe(payloadSize)
    let skip = HEADER_SIZE
    let filled = 0
    while (filled < payloadSize) {
      const head = this.#chunks[0]
      if (skip > 0) {
        if (head.length <= skip) {
          skip -= head.length
          this.#chunks.shift()
          continue
        }
        this.#chunks[0] = head.subarray(skip)
        skip = 0
        continue
      }
      const take = Math.min(payloadSize - filled, head.length)
      head.copy(output, filled, 0, take)
      filled += take
      if (take === head.length) this.#chunks.shift()
      else this.#chunks[0] = head.subarray(take)
    }
    this.#size -= total
    return output
  }

  /** Bytes of partially received frames, for diagnostics. */
  get pending() {
    return this.#size
  }
}
