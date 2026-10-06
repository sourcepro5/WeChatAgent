/** Preserve generated inline persona text exactly for the plugin's local-policy check. */
export function socialPersona(config, key, loadRole) {
  const selected = config.roles?.[key] ?? config.role_name;
  const personaName = selected && typeof selected === 'object'
    ? selected.name ?? config.persona_name ?? config.role_name ?? ''
    : config.persona_name ?? config.role_name ?? '';
  if (typeof selected === 'string' && selected) return { persona: loadRole(selected), personaName };
  const role = selected && typeof selected === 'object' ? selected : (config.role ?? '');
  if (typeof role === 'string') return { persona: role, personaName };
  if (typeof role.persona === 'string') return { persona: role.persona, personaName };
  return { persona: [
    role.name && `名字：${role.name}`, role.speaking_style && `语气：${role.speaking_style}`,
    role.interests && `兴趣：${Array.isArray(role.interests) ? role.interests.join('、') : role.interests}`,
    role.initiative && `主动性：${role.initiative}`, role.verbosity && `话量：${role.verbosity}`,
    role.social_energy && `社交精力：${role.social_energy}`,
  ].filter(Boolean).join('；'), personaName };
}
