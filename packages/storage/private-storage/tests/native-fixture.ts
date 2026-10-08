/** Synthetic FFI memory and Windows replies; this fixture never establishes native conformance. */
import type koffi from 'koffi'
import { NativeStorage } from '../src/native.ts'
import { privateDescriptor } from '../src/policy.ts'

type Argument = bigint | Buffer | string | number | null
interface ObjectFacts { name: string; directory: boolean; bytes: Buffer; offset: number }
export class NativeFixture {
  readonly sid = Buffer.from('0102000000000005150000002a000000', 'hex')
  readonly memory = new Map<bigint, Buffer>()
  readonly objects = new Map<bigint, ObjectFacts>()
  readonly events: { name: string; args: Argument[] }[] = []
  readonly overrides = new Map<string, (...args: Argument[]) => Argument>()
  address = 0x10000n
  nextHandle = 100n
  lastError = 122
  enumeration = 0
  readonly k = {
    alloc: (_type: string, length: number) => this.allocate(length),
    view: (pointer: bigint, length: number) => {
      const bytes = this.bytes(pointer)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length)
    },
    free: (pointer: bigint) => { if (!this.memory.delete(pointer)) throw new Error('double free') },
    address: (pointer: bigint) => pointer,
    load: (_name: string) => ({ func: (_convention: string, name: string) => (...args: Argument[]) => this.call(name, args) }),
  }
  constructor() {
    // Native views must share backing memory, as koffi.view does.
    this.k.view = (pointer, length) => {
      const bytes = this.bytes(pointer)
      if (length !== bytes.byteLength) throw new Error('fixture requires complete allocation views')
      return bytes.buffer
    }
  }
  allocate(length: number): bigint {
    const pointer = this.address
    this.address += BigInt(length + 16)
    this.memory.set(pointer, Buffer.from(new ArrayBuffer(length)))
    return pointer
  }
  bytes(pointer: Argument): Buffer {
    if (Buffer.isBuffer(pointer)) return pointer
    if (typeof pointer !== 'bigint') throw new Error('invalid fixture pointer')
    const bytes = this.memory.get(pointer)
    if (!bytes) throw new Error(`unknown fixture pointer ${pointer}`)
    return bytes
  }
  object(handle: Argument): ObjectFacts {
    const object = this.objects.get(handle as bigint)
    if (!object) throw new Error('unknown fixture handle')
    return object
  }
  create(name = 'record', directory = false, bytes = Buffer.from('abc')): bigint {
    const handle = this.nextHandle++
    this.objects.set(handle, { name, directory, bytes, offset: 0 })
    return handle
  }
  api(): NativeStorage { return new NativeStorage(this.k as object as typeof koffi, { koffiVersion: '3.1.1', platformPackage: 'synthetic', nativeBinarySha256: '0'.repeat(64) }) }
  call(name: string, args: Argument[]): Argument {
    this.events.push({ name, args })
    const override = this.overrides.get(name)
    return override ? override(...args) : this.defaultCall(name, args)
  }
  defaultCall(name: string, args: Argument[]): Argument {
    switch (name) {
      case 'GetLastError': return this.lastError
      case 'GetCurrentThread': case 'GetCurrentProcess': return 1n
      case 'OpenThreadToken': this.lastError = 1008; return 0
      case 'OpenProcessToken': this.bytes(args[2]!).writeBigUInt64LE(2n); return 1
      case 'IsTokenRestricted': return 0
      case 'GetTokenInformation': {
        this.bytes(args[4]!).writeUInt32LE(32)
        if (args[2] === null) { this.lastError = 122; return 0 }
        const out = this.bytes(args[2]!)
        out.writeBigUInt64LE((args[2] as bigint) + 16n)
        this.sid.copy(out, 16)
        return 1
      }
      case 'CloseHandle': return 1
      case 'WaitForSingleObject': return 0
      case 'NtCreateFile': {
        const attr = this.bytes(args[2]!)
        const unicode = this.bytes(attr.readBigUInt64LE(16))
        const name = this.bytes(unicode.readBigUInt64LE(8)).toString('utf16le', 0, unicode.readUInt16LE())
        const handle = this.create(name, ((args[8] as number) & 1) !== 0, Buffer.alloc(0))
        this.bytes(args[0]!).writeBigUInt64LE(handle)
        return 0
      }
      case 'GetFileType': return 1
      case 'NtQueryInformationFile': {
        const output = this.bytes(args[2]!)
        const object = this.object(args[0]!)
        this.bytes(args[1]!).writeBigUInt64LE(BigInt(output.length), 8)
        switch (args[4]) {
          case 4: output.writeBigInt64LE(1n, 16); output.writeBigInt64LE(2n, 24); return 0
          case 5:
            output.writeBigInt64LE(BigInt(object.bytes.length), 8); output.writeUInt32LE(1, 16)
            output[21] = object.directory ? 1 : 0; return 0
          case 16: output.writeUInt32LE(2); return 0
          case 48: {
            const value = Buffer.from(`\\parent\\${object.name}`, 'utf16le')
            output.writeUInt32LE(value.length); value.copy(output, 4)
            this.bytes(args[1]!).writeBigUInt64LE(BigInt(value.length + 4), 8)
            return 0
          }
          case 51: case 71: return 0
          default: throw new Error('unmodeled query')
        }
      }
      case 'NtQueryVolumeInformationFile': this.bytes(args[2]!).writeUInt32LE(7); this.bytes(args[1]!).writeBigUInt64LE(8n, 8); return 0
      case 'GetVolumeInformationByHandleW': this.bytes(args[5]!).writeUInt32LE(8); Buffer.from('NTFS\0', 'utf16le').copy(this.bytes(args[6]!)); return 1
      case 'GetFileInformationByHandleEx': this.bytes(args[2]!).writeBigUInt64LE(0xfedcba9876543210n); this.bytes(args[2]!).writeBigUInt64LE(0x1234567890123456n, 8); this.bytes(args[2]!).writeBigUInt64LE(0xfedcba9876543210n, 16); return 1
      case 'GetSecurityInfo': {
        const descriptor = privateDescriptor(this.sid, this.object(args[0]!).directory)
        const pointer = this.allocate(descriptor.length)
        descriptor.copy(this.bytes(pointer))
        this.bytes(args[7]!).writeBigUInt64LE(pointer)
        return 0
      }
      case 'GetSecurityDescriptorLength': return this.bytes(args[0]!).length
      case 'LocalFree': this.memory.delete(args[0] as bigint); return null
      case 'ReadFile': {
        const object = this.object(args[0]!)
        const count = object.bytes.copy(this.bytes(args[1]!), 0, object.offset)
        object.offset += count; this.bytes(args[3]!).writeUInt32LE(count); return 1
      }
      case 'WriteFile': {
        const object = this.object(args[0]!)
        object.bytes = Buffer.concat([object.bytes, this.bytes(args[1]!)])
        this.bytes(args[3]!).writeUInt32LE(args[2] as number); return 1
      }
      case 'FlushFileBuffers': case 'LockFileEx': case 'UnlockFileEx': return 1
      case 'NtSetInformationFile': return 0
      case 'NtQueryDirectoryFile': {
        if (this.enumeration++) return -2147483642
        const bytes = this.bytes(args[5]!)
        let offset = 0
        for (const [index, name] of ['.', '..', 'record', '目录'].entries()) {
          const text = Buffer.from(name, 'utf16le')
          const next = (12 + text.length + 3) & ~3
          bytes.writeUInt32LE(index === 3 ? 0 : next, offset)
          bytes.writeUInt32LE(text.length, offset + 8)
          text.copy(bytes, offset + 12); offset += next
        }
        this.bytes(args[4]!).writeBigUInt64LE(BigInt(offset), 8)
        return 0
      }
      default: throw new Error(`unmodeled native call ${name}`)
    }
  }
}
