/** Synthetic complete SDK symbolic-link data for parser and owner models. */
export function linkBytes(target = '../package/bin.js'): Buffer {
  const text = Buffer.from(target, 'utf16le'), bytes = Buffer.alloc(20 + text.length)
  bytes.writeUInt32LE(0xa000000c); bytes.writeUInt16LE(bytes.length - 8, 4)
  bytes.writeUInt16LE(text.length, 10); bytes.writeUInt32LE(1, 16); text.copy(bytes, 20)
  return bytes
}
