/**
 * Typed accessor for invoking private command handler methods on context-menu
 * command classes in tests.
 *
 * Production code stores these handlers as `private async _handleXxx(item)`
 * because they're dispatched from command IDs, not called directly by other
 * services. Tests, however, want to exercise them without routing through
 * the command registry, which requires reaching across the `private`
 * boundary.
 *
 * Casting `obj as any` triggers `@typescript-eslint/no-unsafe-member-access`
 * on every call site. `invokePrivateHandler(obj, '_handleX', item)` narrows
 * the receiver to a typed record of async handlers, so the member access is
 * safe and the result type is preserved.
 *
 * This is deliberately a test-only utility — production code should never
 * call private methods by name.
 */

/** A record of handler methods keyed by their (string) method name. */
type HandlerRecord<Arg> = Record<string, (arg: Arg) => Promise<void> | void>;

/**
 * Invoke a private handler method named `name` on `target`, passing `arg`.
 * Returns whatever the handler returns (typically `Promise<void>`).
 */
export function invokePrivateHandler<Arg>(
  target: object,
  name: string,
  arg: Arg
): Promise<void> | void {
  const record = target as unknown as HandlerRecord<Arg>;
  return record[name](arg);
}
