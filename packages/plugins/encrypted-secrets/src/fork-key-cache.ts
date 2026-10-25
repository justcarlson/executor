let cachedKey: { readonly master: string; readonly derived: Buffer } | undefined;

export const pluginKey = (master: string, derive: (master: string) => Buffer): Buffer => {
  if (cachedKey?.master === master) return cachedKey.derived;
  const derived = derive(master);
  cachedKey = { master, derived };
  return derived;
};
