/** Optional host capability: Obsidian 1.8.7 has no persistent secret store. */
interface SecretStore {
  getSecret(name: string): string | null;
  setSecret(name: string, value: string): void;
}

export function secretStore(host: object): SecretStore | null {
  const candidate: unknown = Reflect.get(host, 'secretStorage');
  if (!candidate || typeof candidate !== 'object' ||
      !('getSecret' in candidate) || typeof candidate.getSecret !== 'function' ||
      !('setSecret' in candidate) || typeof candidate.setSecret !== 'function') return null;
  const get = candidate.getSecret, set = candidate.setSecret;
  return {
    getSecret(name) {
      const value: unknown = get.call(candidate, name);
      return typeof value === 'string' ? value : null;
    },
    setSecret(name, value) { set.call(candidate, name, value); },
  };
}
