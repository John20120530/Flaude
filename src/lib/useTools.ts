/**
 * React hook that mirrors the global tool registry into component state.
 * Re-renders whenever tools are registered, unregistered, or have their
 * disabled flag toggled.
 */

import { useEffect, useState } from 'react';
import {
  listTools,
  onRegistryChange,
  type ToolDefinition,
  type ToolSource,
} from './tools';
import type { WorkMode } from '@/types';

interface Filter {
  source?: ToolSource;
  mode?: WorkMode;
  includeDisabled?: boolean;
}

export function useRegisteredTools(filter?: Filter): ToolDefinition[] {
  const [tools, setTools] = useState<ToolDefinition[]>(() =>
    listTools({ includeDisabled: true, ...filter })
  );
  useEffect(() => {
    const unsub = onRegistryChange(() =>
      setTools(listTools({ includeDisabled: true, ...filter }))
    );
    return unsub;
    // We intentionally serialize the filter so referentially-new filter
    // objects with identical fields don't re-run the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter?.source, filter?.mode, filter?.includeDisabled]);
  return tools;
}
