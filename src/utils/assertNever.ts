/**
 * Compile-time exhaustiveness guard for discriminated-union switches.
 *
 * Placed in the `default:` arm of a switch over a union, it forces a build error
 * the moment a new variant is added but left unhandled (the argument stops being
 * `never`). At runtime it is unreachable for a well-typed union; if a rogue value
 * slips past the type system it throws with the value embedded rather than
 * silently falling through.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
