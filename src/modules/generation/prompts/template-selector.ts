import { HookPattern, TemplateName } from '../types';

export function selectTemplate(pattern: HookPattern): TemplateName {
  const terminalPatterns: HookPattern[] = ['D', 'G', 'H'];
  // demais padrões caem no tweet — 'step' (Editorial) saiu do sistema.
  return terminalPatterns.includes(pattern) ? 'compendium' : 'tweet';
}
