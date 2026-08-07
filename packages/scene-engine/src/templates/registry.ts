import type { ContentText, DocSettings, TemplateFamily } from '../doc.js';
import type { SceneNode } from '../scene.js';
import type { SlideRole } from '../ids.js';
import type { MetricsProvider } from '../text/metrics.js';
import type { Tokens } from '../tokens.js';

export interface BuildCtx {
  tokens: Tokens;
  metrics: MetricsProvider;
  /** tipografia por container (override do usuário) — aplicada ANTES do layout. */
  typo?: (containerId: string) => { family?: string; weight?: number } | undefined;
  /** configurações globais do post (contador etc.). */
  settings?: DocSettings;
}

export interface RawSlide {
  role: SlideRole;
  /** índice estável de origem (p/ ids/overrides); cover=0 conceitual. */
  sourceIndex: number;
  background: string;
  nodes: SceneNode[];
}

export interface TemplateProgram {
  family: TemplateFamily;
  build(content: ContentText, ctx: BuildCtx): RawSlide[];
}

const registry = new Map<TemplateFamily, TemplateProgram>();

export function registerTemplate(p: TemplateProgram): void {
  registry.set(p.family, p);
}

export function getTemplate(family: TemplateFamily): TemplateProgram {
  const p = registry.get(family);
  if (p) return p;
  // fallback p/ tweet, o carrossel padrão do sistema ('step'/Editorial foi
  // retirado: segue registrado, mas só p/ renderizar conteúdo antigo).
  const fallback = registry.get('tweet');
  if (!fallback) throw new Error(`Nenhum template registrado para "${family}"`);
  return fallback;
}
