import { createContext, useContext } from 'react';
import type { PlannerAdapter } from './types';

const AdapterContext = createContext<PlannerAdapter | null>(null);

export function AdapterProvider({
  adapter,
  children,
}: {
  adapter: PlannerAdapter;
  children: React.ReactNode;
}): React.ReactElement {
  return <AdapterContext.Provider value={adapter}>{children}</AdapterContext.Provider>;
}

export function useAdapter(): PlannerAdapter {
  const adapter = useContext(AdapterContext);
  if (adapter === null) throw new Error('useAdapter used outside a mode session');
  return adapter;
}
