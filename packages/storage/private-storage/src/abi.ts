/** Windows x64 ABI facts; independently checked against the test-only Windows SDK oracle. */

/** Byte sizes and field offsets for bounded raw-buffer native calls. */
export const ABI = Object.freeze({
  pointer: 8,
  unicodeString: 16,
  unicodeBuffer: 8,
  objectAttributes: 48,
  objectRoot: 8,
  objectName: 16,
  objectFlags: 24,
  objectDescriptor: 32,
  ioStatus: 16,
  ioInformation: 8,
  renameSize: 24,
  renameRoot: 8,
  renameLength: 16,
  renameName: 20,
  fileId: 24,
  basic: 40,
  standard: 24,
  mode: 4,
  overlapped: 32,
  descriptor: 20,
  acl: 8,
  aceSid: 8,
})
