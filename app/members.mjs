// Member identity is independent of the CLI harness. Credentials never enter SSE state.
export function validateMember(body, previous = {}) {
  const name = String(body.name || '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name) || ['user', 'system', 'moderator', '__proto__', 'constructor', 'prototype'].includes(name))
    throw new Error('标识须为小写字母开头的字母、数字或下划线（最多32位），且不能使用保留名称');
  const label = String(body.label || '').trim().slice(0, 60);
  // The harness is chosen when the member is created: OpenCode (any provider, own endpoint and key) or another CLI
  // with its own login, where an empty model means the CLI's default.
  const harness = previous.harness || (['claude', 'codex', 'agy'].includes(body.harness) ? body.harness : 'opencode');
  const model = String(body.model || '').trim();
  const color = /^#[\da-f]{6}$/i.test(body.color || '') ? body.color : '#7c5cff', persona = String(body.persona || '').slice(0, 4000);
  if (harness !== 'opencode') {
    if (!/^[\w.:/-]*$/.test(model)) throw new Error('模型 ID 格式不对');
    return { name, label, model, baseURL: '', protocol: 'responses', apiKey: '', harness, color, persona };
  }
  if (!/^[\w.-]+\/\S+$/.test(model)) throw new Error('模型须为 provider/model 格式');
  const baseURL = String(body.baseURL || '').trim();
  if (baseURL) {
    const url = new URL(baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址须为 HTTP(S)，不能包含账号密码');
  }
  const protocol = body.protocol || 'responses';
  if (!['responses', 'chat'].includes(protocol)) throw new Error('未知 API 协议');
  const apiKey = body.clearKey ? '' : String(body.apiKey || previous.apiKey || '');
  return { name, label, model, baseURL, protocol, apiKey, harness, color, persona };
}

export function providerConfig(member, v2) {
  if (!member || (!member.baseURL && !member.apiKey)) return {};
  const slash = member.model.indexOf('/');
  const provider = member.model.slice(0, slash), model = member.model.slice(slash + 1);
  const options = { ...(member.baseURL ? { baseURL: member.baseURL } : {}),
    ...(member.apiKey ? { apiKey: '{env:AGENT_CHAT_MEMBER_API_KEY}' } : {}) };
  return v2 ? { providers: { [provider]: {
    name: member.label || member.name, env: ['AGENT_CHAT_MEMBER_API_KEY'],
    package: member.protocol === 'chat' ? '@opencode/ai/providers/openai-compatible' : '@opencode/ai/providers/openai-compatible/responses',
    settings: options, models: { [model]: { name: model } },
  } } } : { provider: { [provider]: {
    name: member.label || member.name, npm: member.protocol === 'chat' ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai',
    options, models: { [model]: { name: model } },
  } } };
}

// What members are @-called by: the alias when it is one token, else the handle.
export const atToken = (name, alias) => (alias && !/[\s@]/.test(alias) ? alias : name);

// Members @-mentioned by handle or alias (case-insensitive), in the order they first appear. aliases[n]: one alias or
// a list (the configured alias plus the names the member gave itself in this discussion).
export function memberMentions(text, names, aliases = {}) {
  const t = text.toLowerCase();
  const pos = s => (s ? t.search(new RegExp(`@${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)) : -1);
  return names.map(n => [n, Math.min(...[n, ...[].concat(aliases[n] ?? [])].map(pos).map(i => (i < 0 ? Infinity : i)))])
    .filter(([, i]) => i < Infinity).sort((a, b) => a[1] - b[1]).map(([n]) => n);
}
