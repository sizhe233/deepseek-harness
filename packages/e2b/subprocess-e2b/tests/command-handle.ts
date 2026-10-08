/** Structural SDK handle fixtures without depending on its declaration-only class export. */
import type { CommandHandle } from '@deepseek-ai/dsh-e2b'

/**
 * Attach the SDK's private nominal identity to a complete public test double.
 * @param handle - Every public handle member, checked against the SDK declaration.
 * @returns The same fixture; no SDK transport or private state is constructed.
 */
export function sdkCommandHandle(handle: Pick<CommandHandle, keyof CommandHandle>): CommandHandle {
  return handle as CommandHandle
}
