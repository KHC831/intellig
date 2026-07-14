/**
 * Compile-time tie between a webview protocol's inbound UNION and its runtime
 * `*_INBOUND_TYPES` discriminant array — the two are hand-kept in parallel, and
 * without this tie a variant added to the union + host switch but NOT the array
 * would be silently guard-rejected at runtime (the effort's own bug class,
 * inside the guard). `check:typed-messages` REQUIRES this tie in any file that
 * defines an `*_INBOUND_TYPES` array.
 *
 * Usage (one type alias per protocol, no runtime cost):
 *   type _Tie = AssertInboundArrayTie<InboundArrayTie<XInbound, typeof X_INBOUND_TYPES>>;
 */

/**
 * `true` when `A` covers `U['type']` exactly both ways; otherwise a descriptive
 * tuple carrying the offending discriminant(s) — which fails the `extends true`
 * assertion below at the exact protocol file.
 */
export type InboundArrayTie<U extends { type: string }, A extends readonly string[]> = [
  Exclude<U['type'], A[number]>,
] extends [never]
  ? [Exclude<A[number], U['type']>] extends [never]
    ? true
    : ['discriminant in the array but missing from the union', Exclude<A[number], U['type']>]
  : ['discriminant in the union but missing from the array', Exclude<U['type'], A[number]>];

/** Force {@link InboundArrayTie} to `true`; a mismatch fails the constraint here. */
export type AssertInboundArrayTie<T extends true> = T;
