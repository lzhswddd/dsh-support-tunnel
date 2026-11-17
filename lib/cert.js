/**
 * Self-signed TLS certificate for the tunnel listener.
 *
 * Node ships no certificate generator, and the plugin must stay dependency free,
 * so this module writes the X.509 v3 structure in DER by hand and signs it with
 * node:crypto. The certificate is cached on disk: clients pin its SHA-256
 * fingerprint, so regenerating it on every start would break every kit.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --------------------------------------------------------------- DER encoding

function derLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts.filter(Boolean))
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const derSequence = (...parts) => tlv(0x30, ...parts)
const derSet = (...parts) => tlv(0x31, ...parts)
const derUtf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'))
const derExplicit = (index, ...parts) => tlv(0xa0 + index, ...parts)
const derNull = () => Buffer.from([0x05, 0x00])

/** INTEGER from unsigned bytes, stripping redundant zeros and adding a sign byte. */
function derInteger(bytes) {
  let body = Buffer.from(bytes)
  while (body.length > 1 && body[0] === 0x00 && (body[1] & 0x80) === 0) body = body.subarray(1)
  if (body.length > 0 && (body[0] & 0x80) !== 0) body = Buffer.concat([Buffer.from([0x00]), body])
  return tlv(0x02, body)
}

function derOid(dotted) {
  const parts = dotted.split('.').map(Number)
  const bytes = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f]
    let value = Math.floor(part / 128)
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80)
      value = Math.floor(value / 128)
    }
    bytes.push(...stack)
  }
  return tlv(0x06, Buffer.from(bytes))
}

function derBitString(bytes, unusedBits = 0) {
  return tlv(0x03, Buffer.from([unusedBits]), bytes)
}

function derTime(date) {
  const iso = date.toISOString()
  const year = Number(iso.slice(0, 4))
  if (year >= 2050) {
    return tlv(0x18, Buffer.from(iso.replace(/[-:T]/g, '').slice(0, 14) + 'Z', 'ascii'))
  }
  return tlv(0x17, Buffer.from(iso.replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'))
}

/** RDNSequence with a single commonName attribute. */
function derDistinguishedName(commonName) {
  return derSequence(derSet(derSequence(derOid('2.5.4.3'), derUtf8(commonName))))
}

function derExtension(oid, critical, value) {
  return critical
    ? derSequence(derOid(oid), tlv(0x01, Buffer.from([0xff])), tlv(0x04, value))
    : derSequence(derOid(oid), tlv(0x04, value))
}

const SHA256_WITH_RSA = derSequence(derOid('1.2.840.113549.1.1.11'), derNull())

// ------------------------------------------------------------------ certificate

function pemEncode(der, label) {
  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

function pemDecode(pem) {
  const base64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return Buffer.from(base64, 'base64')
}

/** `sha256:<base64 without padding>`, the form kits pin in support.json. */
export function fingerprintOfDer(der) {
  return `sha256:${crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`
}

/** Fingerprint of a PEM certificate, reading the raw DER through X509Certificate when available. */
export function fingerprintOfPem(pem) {
  try {
    return fingerprintOfDer(new crypto.X509Certificate(pem).raw)
  } catch {
    return fingerprintOfDer(pemDecode(pem))
  }
}

/**
 * Build a self-signed certificate and return PEM material plus its fingerprint.
 * RSA-2048 / SHA-256 keeps it loadable by Node's TLS stack and by OpenSSL 1.1
 * clients that still refuse SHA-1 signatures.
 */
export function createSelfSignedCertificate({ commonName = 'support-tunnel', days = 3650, sans = ['localhost'] } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const serial = crypto.randomBytes(8)
  serial[0] &= 0x7f
  const now = Date.now()
  const notBefore = new Date(now - 60 * 60 * 1000)
  const notAfter = new Date(now + days * 24 * 60 * 60 * 1000)

  const dnsNames = []
  const ipAddresses = []
  for (const name of sans) {
    const text = String(name ?? '').trim()
    if (!text) continue
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) ipAddresses.push(text)
    else dnsNames.push(text)
  }

  const sanParts = [
    ...dnsNames.map((name) => tlv(0x82, Buffer.from(name, 'ascii'))),
    ...ipAddresses.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  ]

  const extensions = derSequence(
    derExtension('2.5.29.19', true, derSequence()), // basicConstraints: CA false
    derExtension('2.5.29.15', true, derBitString(Buffer.from([0xa0]))), // keyUsage: digitalSignature + keyEncipherment
    derExtension('2.5.29.37', false, derSequence(derOid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    ...(sanParts.length > 0 ? [derExtension('2.5.29.17', false, derSequence(...sanParts))] : []),
  )

  const tbs = derSequence(
    derExplicit(0, derInteger([0x02])), // version v3
    derInteger(serial),
    SHA256_WITH_RSA,
    derDistinguishedName(commonName),
    derSequence(derTime(notBefore), derTime(notAfter)),
    derDistinguishedName(commonName),
    publicKey,
    derExplicit(3, extensions),
  )

  const signature = crypto.sign('sha256', tbs, { key: privateKey })
  const der = derSequence(tbs, SHA256_WITH_RSA, derBitString(signature))

  return {
    certPem: pemEncode(der, 'CERTIFICATE'),
    keyPem: privateKey,
    fingerprint: fingerprintOfDer(der),
    generatedAt: new Date().toISOString(),
    notAfter: notAfter.toISOString(),
  }
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Load the cached certificate, creating it on first use.
 * Returns { certPem, keyPem, fingerprint, generated }.
 */
export function ensureCertificate({ certPath = '', keyPath = '', commonName = 'support-tunnel', sans = ['localhost'] } = {}) {
  const dir = path.join(dshHome(), 'support-tunnel')
  const certFile = certPath ? path.resolve(certPath) : path.join(dir, 'cert.pem')
  const keyFile = keyPath ? path.resolve(keyPath) : path.join(dir, 'key.pem')

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const certPem = fs.readFileSync(certFile, 'utf8')
    const keyPem = fs.readFileSync(keyFile, 'utf8')
    if (certPem.includes('BEGIN CERTIFICATE') && /BEGIN [A-Z ]*PRIVATE KEY/.test(keyPem)) {
      return { certPem, keyPem, fingerprint: fingerprintOfPem(certPem), generated: false, certFile, keyFile }
    }
  }

  const created = createSelfSignedCertificate({ commonName, sans })
  fs.mkdirSync(path.dirname(certFile), { recursive: true })
  fs.mkdirSync(path.dirname(keyFile), { recursive: true })
  fs.writeFileSync(certFile, created.certPem, { encoding: 'utf8', mode: 0o600 })
  fs.writeFileSync(keyFile, created.keyPem, { encoding: 'utf8', mode: 0o600 })
  return { ...created, generated: true, certFile, keyFile }
}
