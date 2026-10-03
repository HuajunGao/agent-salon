import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentEnv } from './agents.mjs';

test("agents don't get the service's secrets", () => {
  const env = { PATH: '/bin', LANG: 'C', TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'm', SPEECH_API_KEY: 'k', SPEECH_BASE_URL: 'u',
    FIRECRAWL_API_KEY: 'k', AGENT_USER: 'agent', PORT: '1', GH_TOKEN: 't', OPENAI_API_KEY: 'k' };
  // server: app variables and anything named like a credential go
  assert.deepEqual(Object.keys(agentEnv(env, [], true)), ['PATH', 'LANG']);
  // a harness gets back what it needs
  assert.deepEqual(Object.keys(agentEnv({ ...env, AGENT_CHAT_MEMBER_API_KEY: 'k' }, ['AGENT_CHAT_MEMBER_API_KEY', 'FIRECRAWL_API_KEY'], true)),
    ['PATH', 'LANG', 'FIRECRAWL_API_KEY', 'AGENT_CHAT_MEMBER_API_KEY']);
  // local (no AGENT_USER): only the app's variables go; the user's own CLI keys stay
  assert.deepEqual(Object.keys(agentEnv(env, [], false)), ['PATH', 'LANG', 'GH_TOKEN', 'OPENAI_API_KEY']);
});
