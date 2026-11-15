// Which service and credential a capability uses, and where that credential
// may go. A provider's key is only sent to that provider's own hosts; a custom
// key only to the origins it was entered for. Settings saved before 1.6.0
// resolve through the deterministic migration in providers.mjs.
import {AUTH_MODES, CAPABILITY_IDS, KEY_FIELDS, SECRET_FIELDS, WEBSOCKET_KINDS, activeOf, addressesOf, credentialOf, entryById, ownerFor,
  ownerMatches, providerHostAllowed, servicesOf} from '../ui/providers.mjs';

const fault = code => new Error(code);
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
const validTimeout = value => Number.isInteger(value) && value >= 1000 && value <= 25000;

// The active service of one capability, with the settings shape the request
// code reads. Throws before any network use when the configuration is
// incomplete or a credential would leave its provider or bound origins.
export function resolveService(settings, capability) {
  if (!CAPABILITY_IDS.includes(capability)) throw fault('VOICE_TTS_CONFIG');
  const services = servicesOf(settings), active = activeOf(services, capability);
  if (!active.entry) throw fault(capability === 'tts' ? 'VOICE_TTS_NOT_CONFIGURED' : 'VOICE_RECOGNITION_NOT_CONFIGURED');
  const {entry, method, definition, profile} = active, item = entryById(entry);
  if (entry === 'custom') {
    const auth = profile.auth ?? 'bearer';
    if (!Object.hasOwn(AUTH_MODES, auth)) throw fault('VOICE_TTS_CONFIG');
    if (auth === 'header' && (!HEADER_NAME.test(profile.authHeader ?? '') || RESERVED_HEADERS.has(String(profile.authHeader).toLowerCase()))) throw fault('VOICE_AUTH_HEADER');
    if (auth === 'header' && WEBSOCKET_KINDS.has(definition.kind)) throw fault('VOICE_AUTH_HEADER_REALTIME');
  } else {
    for (const address of addressesOf(capability, active)) if (!providerHostAllowed(item, address)) throw fault('VOICE_PROVIDER_HOST');
  }
  const {key, from} = credentialOf(settings, capability, services);
  const timeoutMs = entry === 'custom' && validTimeout(profile.timeoutMs) ? profile.timeoutMs : settings.timeoutMs;
  const flat = {
    ...profile, timeoutMs, instructions: typeof settings.instructions === 'string' ? settings.instructions : '', speed: profile.speed ?? 1,
    endpoint: String(profile.endpoint ?? ''), realtimeEndpoint: String(profile.endpoint ?? ''), realtimeProtocol: profile.protocol || 'auto',
    realtimeModel: String((definition.kind === 'realtime-session' ? profile.sessionModel : profile.model) ?? ''),
    model: String(profile.model ?? ''), voice: String(profile.voice ?? ''),
    recognitionModel: capability === 'tts' ? '' : String(profile.model ?? ''), recognitionEndpoint: '', apiKey: key,
  };
  return {capability, entry, method, item, definition, kind: definition.kind, profile, key, keyFrom: from, flat, services};
}

// HTTP headers carrying the credential.
export function authHeaders(service) {
  if (!service.key) return {};
  if (service.entry === 'custom' && service.profile.auth === 'header') return {[service.profile.authHeader]: service.key};
  return {Authorization: 'Bearer ' + service.key};
}

// A settings-page draft over the saved settings. Blank secrets keep the saved
// ones together with their saved owners; a typed secret belongs to the
// source (and, for a custom API, the addresses) it was typed for. The legacy
// key's owner can only come from the saved settings.
export function mergeDraft(saved = {}, draft = {}) {
  const value = {...saved, ...draft};
  for (const field of SECRET_FIELDS) if (!String(draft[field] ?? '')) value[field] = saved[field] ?? '';
  const before = servicesOf(saved);
  const after = draft.services?.version === 2 ? servicesOf(draft) : servicesOf(value);
  for (const capability of CAPABILITY_IDS) {
    after.owners[capability] = String(draft[KEY_FIELDS[capability]] ?? '')
      ? ownerFor(capability, activeOf(after, capability)) : before.owners[capability];
  }
  // A legacy key supplied with the draft (older pages and callers) belongs to
  // the draft's own legacy configuration.
  if (!String(draft.apiKey ?? '')) after.legacy = before.legacy;
  value.services = after;
  return value;
}

// Whether a typed or saved credential reaches this capability (for the page).
export const credentialReady = (settings, capability) => {
  const services = servicesOf(settings), active = activeOf(services, capability);
  return !!credentialOf(settings, capability, services).key || active.entry === 'custom' && active.profile.auth === 'none';
};
export {ownerMatches};
