/**
 * Per-conversation policy routing for the QQ bridge.
 *
 * Why this module exists (P2 of QSH_PLAN.md §3):
 *   The bridge historically kept ONE process-global `currentMode`. That makes
 *   "this group runs simulation, but the admin's private chat runs closed-agent"
 *   impossible, and it means every mode decision in a 10k-line file reads the
 *   same mutable global. This module turns the decision into a pure lookup:
 *   given a conversation key, what are the mode / preset / model / effort?
 *
 * Design constraints, all deliberate:
 *
 *  1. **Pure and synchronous.** No fs, no config, no timers, no DSH calls. The
 *     bridge keeps ownership of persistence and of preset *installation*; this
 *     module only answers policy questions. That keeps it testable offline and
 *     keeps the security-relevant logic in one auditable place.
 *
 *  2. **Legacy mode names are the internal vocabulary.** The four historical
 *     names (`chat` / `reserved` / `reserved2` / `closed-agent`) stay valid, so
 *     introducing this module changes *where* a decision is read from, not what
 *     the decision is. Converging the user-visible modes down to two
 *     (`closed-agent` / `simulation`) is a separate, later step.
 *
 *  3. **Fail-closed.** An unparseable key throws rather than defaulting; an
 *     unknown mode throws; a record that does not *name* its preset throws
 *     (`preset: null` was the retracted option A — ADR 0003 §决定 replaced it
 *     with an explicit `qsh-closed`, so "no preset named" is now a config error,
 *     not a silent fall back to a name baked in here); a preset that does not
 *     belong to its mode throws; `closed-agent` is refused for any key that is
 *     not the owner's private conversation. Nothing here may silently widen
 *     access.
 *
 *  4. **Default is never privileged.** `defaults` must resolve to a simulation
 *     mode. `closed-agent` can only ever come from an explicit owner entry.
 *
 *  5. **Actor is a declaration, and the caller must authenticate it.** The
 *     `updatedBy` field records who asked for a change; this module does not
 *     verify it. Returned audit events are NOT persisted here — the caller must
 *     store them before treating a change as durable (iron law L5).
 */

/** Simulation is the safe default: no local tools, whitelist-gated. */
const SIMULATION_MODES = Object.freeze(['chat', 'reserved', 'reserved2']);

/**
 * Accepted mode spellings.
 *
 * `simulation` is the canonical name and is kept AS ITSELF, not folded into the
 * legacy `reserved2`. Folding it would make `modeFor()` return an internal legacy
 * string, leaking the old vocabulary back out of the layer that exists to hide
 * it. The legacy names stay accepted so the bridge's current global setting keeps
 * working while the per-conversation config adopts the new spelling.
 */
const MODE_ALIASES = Object.freeze({
  simulation: 'simulation',
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  'closed-agent': 'closed-agent',
});

/** All internal mode names, including both simulation spellings. */
const ALL_MODES = Object.freeze([...SIMULATION_MODES, 'simulation', 'closed-agent']);

/**
 * Which presets a mode may use. `closed-agent` intentionally allows only its own
 * closed preset; simulation allows the simulator presets. Anything else is
 * rejected so a typo or a stale config cannot attach an unexpected tool surface.
 *
 * **One generation per spelling, on purpose.** `simulation` is the canonical
 * rename of `reserved2` (QSH_PLAN.md §2.1), so it is the entry that carries the
 * QSH names the plan installs — `qsh-sim` / `qsh-sim-v2` (ADR 0003 §决定 point 4)
 * — and `[0]` is the preset this layer emits by default, exactly as
 * QSH_PLAN.md §3.1 writes `"defaults": { "mode": "simulation", "preset":
 * "qsh-sim" }`. The legacy spellings keep the presets that are actually
 * installed today (`qq-chat` / `qq-chat-v2`), so a config written before the P3
 * rename stays loadable *and* `reserved2 + qsh-sim` stays a detectable mismatch
 * instead of silently resolving to a preset that deployment never installed.
 * Deployments that install a different generation pass their own table through
 * the `modePresets` option — that is why both lists exist rather than one.
 */
const DEFAULT_MODE_PRESETS = Object.freeze({
  chat: Object.freeze(['qq-chat']),
  reserved: Object.freeze(['qq-chat']),
  reserved2: Object.freeze(['qq-chat-v2']),
  // `simulation` is the canonical spelling of `reserved2`. It leads with the
  // canonical preset names; `qq-chat-v2` stays accepted because that is the
  // preset the still-legacy bridge actually installs for this mode.
  simulation: Object.freeze(['qsh-sim', 'qsh-sim-v2', 'qq-chat-v2']),
  'closed-agent': Object.freeze(['qsh-closed']),
});

/**
 * Build a mode -> allowed-presets table from caller-supplied names, falling back
 * to the defaults per mode. Callers that install different presets pass their
 * own; callers that install nothing get the shipped defaults.
 */
function buildModePresets(overrides = {}) {
  const out = {};
  for (const mode of ALL_MODES) {
    const list = overrides[mode];
    if (list === undefined) { out[mode] = DEFAULT_MODE_PRESETS[mode]; continue; }
    if (!Array.isArray(list) || list.length === 0
      || list.some((p) => typeof p !== 'string' || p.trim() !== p || p.length === 0)) {
      throw new TypeError(`presets for ${mode} must be a non-empty array of trimmed strings`);
    }
    out[mode] = Object.freeze([...list]);
  }
  return Object.freeze(out);
}

/** Legacy mode -> canonical QSH mode (ADR 0003 / QSH_PLAN.md §2.1). */
export const LEGACY_TO_CANONICAL = Object.freeze({
  chat: 'simulation',
  reserved: 'simulation',
  reserved2: 'simulation',
  'closed-agent': 'closed-agent',
  simulation: 'simulation',
});

/**
 * Capability facts per mode. These are *statements about the preset*, not an
 * enforcement point: enforcement is the preset's tool guard (iron law L7) plus
 * the bridge's own gates. Kept here so the router is the single place that
 * answers "may this mode use local tools?".
 */
const PERMISSIONS = Object.freeze({
  simulation: Object.freeze({ localExecution: false, localFiles: false, adminCommands: false }),
  'closed-agent': Object.freeze({ localExecution: true, localFiles: true, adminCommands: true }),
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/**
 * Canonicalise `private:<id>` / `group:<id>`.
 * Mirrors the bridge's own canonicalV2Key: only `\d+`, safe integer, non-zero.
 * Returns null for anything else so callers can fail closed explicitly.
 */
export function canonicalConversationKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

function requireKey(key) {
  const c = canonicalConversationKey(key);
  if (c === null) throw new TypeError(`Invalid conversation key: ${String(key)}`);
  return c;
}

/** ownerQQ may be a number or a numeric string; anything else is a config error. */
function normalizeOwnerQQ(ownerQQ) {
  if (ownerQQ === null || ownerQQ === undefined || ownerQQ === '') return null;
  const t = typeof ownerQQ;
  if (t !== 'string' && t !== 'number') {
    throw new TypeError('ownerQQ must be a positive safe integer or omitted');
  }
  const c = canonicalConversationKey(`private:${String(ownerQQ).trim()}`);
  if (c === null) throw new TypeError('ownerQQ must be a positive safe integer or omitted');
  return Number(c.slice('private:'.length));
}

function optionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be null or a non-empty trimmed string`);
  }
  return value;
}

/**
 * Map any accepted mode spelling to an internal mode name.
 *
 * Strictly a string. `String(mode)` would accept any object whose `toString`
 * happens to return an alias — e.g. `{ toString: () => 'closed-agent' }` out of
 * a hand-edited JSON file would select the privileged mode instead of being
 * rejected as the type error it is. `normalizeOwnerQQ` has to coerce because QQ
 * ids are legitimately written both as number and string; a mode name is only
 * ever a string.
 */
export function normalizeMode(mode) {
  if (typeof mode !== 'string') {
    throw new TypeError(`Unknown mode: expected a string, got ${typeof mode}`);
  }
  const m = mode.trim();
  if (!Object.prototype.hasOwnProperty.call(MODE_ALIASES, m)) {
    throw new TypeError(`Unknown mode: ${mode}`);
  }
  return MODE_ALIASES[m];
}

/**
 * `updatedBy` records the actor. Only the console and the owner's private
 * command channel may change policy; `first-run`/`migration` are accepted only
 * on the provisioning path, never through the change API.
 */
function requireUpdatedBy(updatedBy, ownerKey, { allowSystem = false } = {}) {
  if (updatedBy === 'console') return updatedBy;
  if (ownerKey !== null && updatedBy === `command:${ownerKey}`) return updatedBy;
  if (allowSystem && (updatedBy === 'first-run' || updatedBy === 'migration')) return updatedBy;
  throw new TypeError('updatedBy must identify console or the owner private command');
}

/**
 * Validate one policy record (a conversation entry, or `defaults`).
 *
 * Check order is load-bearing, not stylistic:
 *   1. the shape and the **actor** (`updatedBy`) — authorization before payload,
 *      so a record that is both unauthenticated and malformed reports the
 *      authentication failure rather than hinting at payload details;
 *   2. the mode;
 *   3. the preset — mandatory, and it has to belong to the mode;
 *   4. the `closed-agent` boundaries.
 *
 * `updatedBy` is checked here because a record with no provenance is not
 * auditable, and `first-run` / `migration` are accepted because they are the
 * actors `createInitialConversationState` / `migrateLegacyMode` stamp into the
 * state they return — a loader that refused them could not read back the file
 * this module itself wrote, and `setConversation` re-normalises the whole state
 * on every write, so it would refuse the owner's own pre-existing record.
 * Refusing a *live* actor (an interactive change) is the job of the change API,
 * which authenticates `updatedBy` itself before calling in here.
 */
function normalizePolicy(record, label, ownerKey, modePresets, { isDefault = false } = {}) {
  if (!isPlainObject(record)) throw new TypeError(`${label} must be an object`);
  if (!isDefault) {
    requireUpdatedBy(record.updatedBy, ownerKey, { allowSystem: true });
  }
  if (!own(record, 'mode')) throw new TypeError(`${label} requires mode`);

  const mode = normalizeMode(record.mode);

  // The preset is NOT optional. ADR 0003 (§决定) retired option A — the one where
  // `preset: null` meant "whatever the DSH global default is" — precisely because
  // a policy that does not name its preset cannot be audited: the tool surface
  // then depends on a setting this module cannot see. A record that names none
  // is therefore a config error (L1 fail-closed), not an invitation to fill in a
  // default here.
  if (!own(record, 'preset') || record.preset === null) {
    throw new TypeError(`${label} requires preset (preset: null was retired by ADR 0003)`);
  }
  if (typeof record.preset !== 'string' || !modePresets[mode].includes(record.preset)) {
    throw new TypeError(`${label} has an unknown or unsafe preset for ${mode}`);
  }
  const preset = record.preset;

  if (isDefault && mode === 'closed-agent') {
    throw new TypeError('defaults must remain simulation (closed-agent is per-conversation only)');
  }
  // One boundary, one message: whether the owner is unconfigured or the key is
  // simply not the owner's, the reason a `closed-agent` record is refused is the
  // same — this key is not the owner's private conversation. Reporting
  // "requires a configured ownerQQ" only in the first case made the same
  // rejection read as two unrelated errors depending on deployment state.
  if (mode === 'closed-agent' && label !== ownerKey) {
    throw new TypeError(ownerKey === null
      ? 'closed-agent is restricted to the owner private conversation (no ownerQQ is configured)'
      : 'closed-agent is restricted to the owner private conversation');
  }

  const normalized = { mode, preset };
  if (isDefault) {
    normalized.model = own(record, 'model') ? optionalText(record.model, `${label}.model`) : null;
    normalized.reasoningEffort = own(record, 'reasoningEffort')
      ? optionalText(record.reasoningEffort, `${label}.reasoningEffort`) : null;
    return normalized;
  }

  normalized.updatedBy = record.updatedBy;
  if (own(record, 'model')) normalized.model = optionalText(record.model, `${label}.model`);
  if (own(record, 'reasoningEffort')) {
    normalized.reasoningEffort = optionalText(record.reasoningEffort, `${label}.reasoningEffort`);
  }
  return normalized;
}

function normalizeState(state, ownerQQ, modePresets) {
  if (!isPlainObject(state) || state.version !== 1) {
    throw new TypeError('conversation state must have version 1');
  }
  const defaults = normalizePolicy(state.defaults, 'defaults', null, modePresets, { isDefault: true });
  if (!isPlainObject(state.conversations)) throw new TypeError('conversations must be an object');

  // Two passes, keys first. `private:42` and `private:042` are the same
  // conversation, so a state that contains both is corrupt whichever payload
  // wins. Detecting that in a pass of its own means (a) the error is the
  // duplicate, not whichever payload happens to be malformed, and (b) the
  // outcome no longer depends on JSON key order.
  const rawKeys = new Map();
  for (const rawKey of Object.keys(state.conversations)) {
    const key = requireKey(rawKey);
    if (rawKeys.has(key)) throw new TypeError(`Duplicate conversation key: ${key}`);
    rawKeys.set(key, rawKey);
  }

  const ownerKey = ownerQQ === null ? null : `private:${ownerQQ}`;
  const conversations = {};
  for (const [key, rawKey] of rawKeys) {
    conversations[key] = normalizePolicy(state.conversations[rawKey], key, ownerKey, modePresets);
  }
  return { version: 1, defaults, conversations };
}

/**
 * Build the initial conversations state.
 *
 * @param ownerQQ  the admin's QQ, or null/'' when not configured yet
 * @param options.defaultMode  the global mode to keep as the fallback default,
 *                             so adopting this module does not change behaviour
 * @param options.closedAgentEnabled  whether owner-private starts as closed-agent
 */
export function createInitialConversationState(ownerQQ, {
  defaultMode = null,
  closedAgentEnabled = true,
  modePresets,
} = {}) {
  const owner = normalizeOwnerQQ(ownerQQ);
  if (typeof closedAgentEnabled !== 'boolean') {
    throw new TypeError('closedAgentEnabled must be boolean');
  }
  const presets = modePresets ?? buildModePresets();

  // The fallback mode for conversations with no explicit entry.
  // closed-agent may never be a *default*: it is a per-conversation privilege,
  // never a blanket applied to every channel. Every other accepted spelling is a
  // simulation mode, and they are collapsed onto the canonical one here so this
  // layer never *emits* the legacy vocabulary (QSH_PLAN.md §3.1 writes
  // `"defaults": { "mode": "simulation" }`). `defaultMode` is still validated:
  // an unrecognised spelling is a config error, not a silent fallback.
  const requested = (defaultMode === null || defaultMode === undefined || defaultMode === '')
    ? null
    : normalizeMode(defaultMode);
  const safeDefault = (requested === null || requested === 'closed-agent')
    ? 'simulation'
    : LEGACY_TO_CANONICAL[requested];

  const conversations = {};
  // Owner-private starts as closed-agent when the owner is known and the caller
  // has not opted out — the documented first-run default (QSH_PLAN.md §6.2 step 3,
  // "管理员模式开关，默认开启"). Pre-populating the owner's OWN conversation is
  // not the same as initialising the global mode to closed-agent: it grants
  // nothing to any other channel.
  if (owner !== null && closedAgentEnabled) {
    conversations[`private:${owner}`] = {
      mode: 'closed-agent',
      preset: presets['closed-agent'][0],
      model: null,
      reasoningEffort: null,
      updatedBy: 'first-run',
    };
  }
  return {
    version: 1,
    defaults: {
      mode: safeDefault,
      preset: presets[safeDefault][0],
      model: null,
      reasoningEffort: null,
    },
    conversations,
  };
}

/**
 * Explicit migration from the single global mode to per-conversation state.
 * Returns the events the caller must persist (this module never writes).
 */
export function migrateLegacyMode({ mode, ownerQQ, modePresets } = {}) {
  if (!ALL_MODES.includes(mode)) {
    throw new TypeError('Unknown legacy mode; refusing migration');
  }
  const owner = normalizeOwnerQQ(ownerQQ);
  const closedAgentEnabled = mode === 'closed-agent' && owner !== null;
  const state = createInitialConversationState(owner, {
    defaultMode: mode,
    closedAgentEnabled,
    modePresets,
  });
  // 迁移事件没有"静默"分支：旧写法在 `mode === 'reserved2' && owner === null` 时返回 events: []，
  // 而"老配置是二代仿真 + 从没配过 ownerQQ"恰恰是最常见的一次迁移 —— 也就是说最常见的迁移是唯一
  // 不留审计记录的那种，与本模块"caller must persist the events"的契约直接矛盾：调用方按约定落盘，
  // 却什么都落不下来，事后无法回答"这批会话的默认模式是什么时候、按哪次迁移改的"。
  // （`closedAgentEnabled === false` 这一项对 reserved2 恒为真，所以那个条件实际只是在判断 owner === null。）
  const events = [{
    type: 'legacy-mode-migrated',
    from: mode,
    to: closedAgentEnabled ? 'closed-agent for owner private; default elsewhere' : `default ${state.defaults.mode}`,
    ownerKey: closedAgentEnabled ? `private:${owner}` : null,
    reason: mode === 'closed-agent' && owner === null ? 'missing ownerQQ; downgraded' : null,
  }];
  if (closedAgentEnabled) state.conversations[`private:${owner}`].updatedBy = 'migration';
  return { state, events };
}

/**
 * Read-only policy lookup. Construct once per config change; never mutate.
 *
 * `defaultMode` is the process-global mode and is used for any conversation that
 * has no explicit entry. That is what makes this a drop-in replacement during the
 * migration: behaviour for conversations without an override is unchanged.
 * The legacy spellings are accepted here (`reserved2` is what the running bridge
 * still has persisted) and are stored in canonical form — storing the raw
 * spelling would pair e.g. `reserved2` with the canonical `qsh-sim` preset and
 * then reject that same state on the next load, i.e. the router could not read
 * back what it had just written.
 */
export class SessionRouter {
  #ownerQQ;
  #defaultMode;
  #state;
  #now;
  #modePresets;

  constructor({ ownerQQ = null, defaultMode = 'reserved2', state, now = Date.now, modePresets } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#now = now;
    this.#ownerQQ = normalizeOwnerQQ(ownerQQ);
    this.#modePresets = modePresets ?? buildModePresets();

    const init = state === undefined
      ? createInitialConversationState(this.#ownerQQ, { defaultMode, modePresets: this.#modePresets })
      : state;
    // Loading is the provisioning path: the state we are handed was written by
    // `createInitialConversationState` / `migrateLegacyMode`, whose `updatedBy`
    // is `first-run` / `migration` — see `normalizePolicy`.
    this.#state = normalizeState(init, this.#ownerQQ, this.#modePresets);

    // An explicit defaultMode wins over the persisted default: the DSH setting
    // is still authoritative for "what is the global mode right now". It cannot
    // introduce a privileged default — `defaults` is validated above and
    // `closed-agent` is refused there.
    const dm = normalizeMode(defaultMode);
    if (dm !== 'closed-agent') this.#state.defaults.mode = LEGACY_TO_CANONICAL[dm];
    this.#defaultMode = this.#state.defaults.mode;
  }

  get ownerQQ() { return this.#ownerQQ; }
  get defaultMode() { return this.#defaultMode; }
  /** Allowed presets per mode, as supplied by the caller. */
  get modePresets() { return this.#modePresets; }

  #auditAt() {
    const at = this.#now();
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new TypeError('audit time must be a non-negative safe integer in milliseconds');
    }
    return at;
  }

  snapshot() { return structuredClone(this.#state); }

  /** The conversation entry, or null when this key has no explicit override. */
  overrideFor(key) {
    const canonical = requireKey(key);
    return own(this.#state.conversations, canonical) ? this.#state.conversations[canonical] : null;
  }

  /** Resolved policy for a conversation. Never returns a privileged mode by default. */
  policyFor(key) {
    const canonical = requireKey(key);
    const record = this.#state.conversations[canonical] ?? this.#state.defaults;
    const defaults = this.#state.defaults;
    const mode = record.mode;

    // Every record that reaches this point named its preset explicitly —
    // `normalizePolicy` refuses `preset: null` and any name that does not belong
    // to the mode — so resolution is a read, not a fallback chain. The fallback
    // to `modePresets[mode][0]` is unreachable for stored state and is kept only
    // as a total-function guard.
    const preset = own(record, 'preset') && record.preset
      ? record.preset
      : this.#modePresets[mode][0];

    return Object.freeze({
      key: canonical,
      mode,
      canonicalMode: LEGACY_TO_CANONICAL[mode],
      preset,
      model: own(record, 'model') ? record.model : defaults.model,
      reasoningEffort: own(record, 'reasoningEffort')
        ? record.reasoningEffort : defaults.reasoningEffort,
      hasOverride: own(this.#state.conversations, canonical),
    });
  }

  /**
   * The conversation's mode in its **canonical** spelling:
   * `'closed-agent'` | `'simulation'`.
   *
   * 旧拼写（`chat` / `reserved` / `reserved2`）只在**存储与迁移**层存在，不从这里漏出去 ——
   * 这一层的存在意义就是把旧词汇挡在里面（见 MODE_ALIASES 的说明）。旧实现返回的是内部
   * 原始拼写，于是 `reserved2` 会一路泄漏到调用方，和本文件自己的契约矛盾，
   * 也让"迁移到 simulation"这件事在对外行为上等于没发生。需要旧拼写的地方请用
   * {@link internalModeFor}。
   */
  modeFor(key) { return this.policyFor(key).canonicalMode; }

  /** `modeFor` 的同义方法，保留给按 "canonical" 语义阅读的调用点。 */
  canonicalModeFor(key) { return this.policyFor(key).canonicalMode; }

  /**
   * 内部/存储层的模式拼写（可能是 `chat` / `reserved` / `reserved2` 这类旧名）。
   * 只有迁移与"当前全局设置仍是旧名"这类兼容判断才需要它；业务代码一律用 `modeFor`。
   */
  internalModeFor(key) { return this.policyFor(key).mode; }

  presetFor(key) { return this.policyFor(key).preset; }
  modelFor(key) { return this.policyFor(key).model; }
  effortFor(key) { return this.policyFor(key).reasoningEffort; }

  permissionsFor(key) { return PERMISSIONS[this.canonicalModeFor(key)]; }

  /**
   * True when this conversation may run in its resolved mode.
   *
   * `closed-agent` is only ever allowed for the owner's private conversation.
   * A conversation whose resolved mode is closed-agent but whose key is not the
   * owner's is refused — that is the L2 boundary, and it must stay here so every
   * caller inherits it.
   */
  modeAllowsKey(key) {
    const canonical = canonicalConversationKey(key);
    if (canonical === null) return false;
    if (this.modeFor(canonical) !== 'closed-agent') return true;
    return this.#ownerQQ !== null && canonical === `private:${this.#ownerQQ}`;
  }

  /** Stable identity of the policy; a change means the session must be rebuilt. */
  policyFingerprint(key) {
    const { mode, preset, model, reasoningEffort } = this.policyFor(key);
    return JSON.stringify([mode, preset, model, reasoningEffort, this.#ownerQQ]);
  }

  /**
   * Set an override. `updatedBy` must come from an already-authenticated layer.
   * Caller must persist the returned auditEvent (iron law L5).
   */
  setConversation(key, record) {
    const canonical = requireKey(key);
    const ownerKey = this.#ownerQQ === null ? null : `private:${this.#ownerQQ}`;
    // Load-bearing, not redundant: this is where a *live* actor is
    // authenticated. `normalizeState` below accepts `first-run`/`migration`
    // because it must be able to re-read records provisioning already wrote, so
    // the refusal of those two actors — and the "actor failure before payload
    // failure" ordering — has to happen here.
    requireUpdatedBy(record?.updatedBy, ownerKey, { allowSystem: false });

    const before = this.policyFor(canonical);
    const beforeFp = this.policyFingerprint(canonical);
    const hadOverride = own(this.#state.conversations, canonical);

    const candidate = {
      ...this.#state,
      conversations: { ...this.#state.conversations, [canonical]: record },
    };
    const next = normalizeState(candidate, this.#ownerQQ, this.#modePresets);
    const at = this.#auditAt();
    this.#state = next;

    const after = this.policyFor(canonical);
    const changedKeys = beforeFp === this.policyFingerprint(canonical) ? [] : [canonical];
    return Object.freeze({
      key: canonical,
      changedKeys,
      auditEvent: Object.freeze({
        type: 'conversation-set',
        key: canonical,
        updatedBy: next.conversations[canonical].updatedBy,
        at,
        // The whole resolved policy, not just the fields this module happens to
        // compare: the audit trail is what answers "which preset was this
        // conversation on when it changed", and `canonicalMode`/`hasOverride`
        // are exactly the parts a reader would otherwise have to reconstruct.
        before,
        after,
        hadOverride,
        policyChanged: changedKeys.length > 0,
      }),
    });
  }

  /** Remove an override so the conversation falls back to the default. */
  deleteConversation(key, { updatedBy } = {}) {
    const canonical = requireKey(key);
    const ownerKey = this.#ownerQQ === null ? null : `private:${this.#ownerQQ}`;
    const actor = requireUpdatedBy(updatedBy, ownerKey, { allowSystem: false });

    const before = this.policyFor(canonical);
    const beforeFp = this.policyFingerprint(canonical);
    const hadOverride = own(this.#state.conversations, canonical);

    const conversations = { ...this.#state.conversations };
    delete conversations[canonical];
    const next = normalizeState({ ...this.#state, conversations }, this.#ownerQQ, this.#modePresets);
    const at = this.#auditAt();
    this.#state = next;

    const after = this.policyFor(canonical);
    const changedKeys = beforeFp === this.policyFingerprint(canonical) ? [] : [canonical];
    return Object.freeze({
      key: canonical,
      changedKeys,
      auditEvent: Object.freeze({
        type: 'conversation-deleted',
        key: canonical,
        updatedBy: actor,
        at,
        before,
        after,
        hadOverride,
        noOp: !hadOverride,
        policyChanged: changedKeys.length > 0,
      }),
    });
  }
}
