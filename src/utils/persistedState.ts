/**
 * Versioned validate-on-load persistence for host `Memento` state
 * (`workspaceState` / `globalState`). Generalizes the ad-hoc validated stores
 * (logFilter / panelLayout / columnLayout) into one seam:
 *
 *   - a `PersistedSlot` bundles the four things that must agree (key, version,
 *     validator, optional serializer) so a call site can't forget one;
 *   - `loadPersisted` validates every payload (no unchecked `get<T>`), drops a
 *     version-mismatched blob to the caller's default, and keeps legacy bare
 *     (un-enveloped) values working so no user loses state on rollout;
 *   - `savePersisted` wraps writes in a `{v,data}` envelope.
 *
 * `check:persisted-state` bans raw Memento get/update everywhere else.
 */

/**
 * Minimal structural Memento — just the get/update this module uses. NOT
 * `vscode.Memento`: ResetDialog/RebaseDialog hold a globalState-shaped SUBSET
 * that lacks `keys()`, and structural typing must accept it.
 */
export type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
};

/** Envelope every slot writes: version tag + payload. */
type Envelope = {
  v: number;
  data: unknown;
};

export type PersistedSlot<T> = {
  readonly key: string;
  readonly version: number;
  /** Validate a raw payload → the typed value, or undefined to fall back. */
  readonly validate: (raw: unknown) => T | undefined;
  /** Optional encode for non-JSON values (e.g. Date → ISO). Default: identity. */
  readonly serialize?: (value: T) => unknown;
};

/**
 * True only for our own `{v:number, data}` envelope. Deliberately strict so no
 * current bare shape (arrays, strings, booleans, enum strings, or a
 * `Record<string,string[]>`) can be mistaken for an envelope: a bare blob never
 * carries a numeric `v`, and a hand-edited object with a wrong-typed `v` fails
 * the `typeof === 'number'` check and falls to the legacy validate path.
 */
function isEnvelope(v: unknown): v is Envelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).v === 'number' &&
    'data' in (v as Record<string, unknown>)
  );
}

/**
 * Load a slot. Returns undefined (→ caller's default) when nothing valid is
 * stored, the version tag mismatches, or validation rejects the payload.
 * Back-compat: a bare (un-enveloped) legacy value is validated as the CURRENT
 * version, so existing users keep their state on first run after this ships.
 */
export function loadPersisted<T>(state: MementoLike, slot: PersistedSlot<T>): T | undefined {
  const stored = state.get<unknown>(slot.key);
  if (stored === undefined) {
    return undefined;
  }
  if (isEnvelope(stored)) {
    if (stored.v !== slot.version) {
      return undefined; // shape changed → drop
    }
    return slot.validate(stored.data);
  }
  return slot.validate(stored); // legacy bare value = current version
}

/** Save a slot (wrapped in the version envelope); undefined clears the slot. */
export function savePersisted<T>(
  state: MementoLike,
  slot: PersistedSlot<T>,
  value: T | undefined
): Thenable<void> {
  if (value === undefined) {
    return state.update(slot.key, undefined);
  }
  const data = slot.serialize ? slot.serialize(value) : value;
  return state.update(slot.key, { v: slot.version, data } satisfies Envelope);
}

// ─── Shared field-reader validators (folded from logFilterStorage) ───────────
// Each returns `undefined` on the wrong type so a slot validator can compose
// them field-by-field and degrade a junk payload to the caller's default.

/** A non-empty string, else undefined. */
export function readString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function readBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A non-empty array of strings, else undefined. */
export function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x): x is string => typeof x === 'string')) {
    return undefined;
  }
  return v;
}

/** An ISO date string → Date, else undefined. */
export function readDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * A record whose every value is a string array (empty arrays allowed), else
 * undefined. The empty object is valid (no entries). Used by the recent-branches
 * slot.
 */
export function readRecordOfStringArrays(v: unknown): Record<string, string[]> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(val) || !val.every((x): x is string => typeof x === 'string')) {
      return undefined;
    }
    out[k] = val;
  }
  return out;
}

/** A validator that accepts a value only if it is one of `allowed`. */
export function readEnum<T extends string>(allowed: readonly T[]): (v: unknown) => T | undefined {
  return (v: unknown): T | undefined =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}
