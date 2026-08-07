import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodErrorText } from '../generation/prompts/output-schema';

/**
 * Categorização de imagem do acervo por IA (Claude vision).
 *
 * O texto que sai daqui É o índice: `description + subjects + themes` viram o
 * embedding que responde à busca semântica. Descrição genérica = busca ruim —
 * o prompt exige especificidade concreta e o plano manda REVISAR as primeiras
 * descrições antes de indexar lote grande (docs/plano-banco-de-imagens.md).
 *
 * Segue o padrão de structured output do repo (Zod + um repair loop, como o
 * completeJson do GenerationService) em vez de output_config nativo — decisão
 * de consistência com o codebase.
 */

const CATEGORIZATION_SCHEMA = z.object({
  description: z.string().min(10),
  subjects: z.array(z.string()).min(1).max(10),
  themes: z.array(z.string()).min(1).max(8),
  setting: z.enum(['escritorio', 'casa', 'rua', 'estudio', 'abstrato', 'outro']),
  people: z.enum(['nenhuma', 'uma', 'grupo']),
  mood: z.string(),
  colors: z.array(z.string()).max(5),
  usable_as: z.array(z.enum(['figure', 'background'])).min(1),
  has_text: z.boolean(),
  quality_flag: z.enum(['ok', 'ruido', 'baixa_resolucao', 'marca_dagua']),
});

export type MediaCategorization = z.infer<typeof CATEGORIZATION_SCHEMA>;

const SYSTEM_PROMPT = `Você cataloga fotos do acervo de um estúdio de conteúdo para Instagram.
Sua descrição é o ÍNDICE DE BUSCA da foto: outra IA vai buscar por assunto de post
("contador analisando planilha", "rotina de escritório", "reunião de equipe") e só
encontra o que você escreveu. Seja CONCRETO e ESPECÍFICO.

Regras:
- description: 1-2 frases do que a foto MOSTRA (quem, o quê, onde). Proibido genérico
  tipo "pessoa trabalhando" — diga "mulher de blazer digitando num notebook em mesa
  de escritório com papéis e calculadora ao lado".
- subjects: objetos/pessoas/cenário visíveis (substantivos concretos).
- themes: assuntos de post que esta foto ilustra BEM (ex.: "rotina contábil",
  "análise financeira", "trabalho remoto", "atendimento ao cliente").
- setting/people/mood/colors: literais do que se vê.
- usable_as: "figure" se funciona como foto de apoio num card; "background" se
  aguenta texto por cima (área limpa, pouco detalhe).
- has_text: true se há QUALQUER texto legível na foto (letreiro, tela, documento
  legível). Foto com texto compete com a copy do post.
- quality_flag: "ok" salvo problema visível (ruído/granulação forte, resolução
  claramente baixa, marca d'água).

Responda APENAS o JSON, sem markdown.`;

type SupportedMime = 'image/jpeg' | 'image/png' | 'image/webp';

@Injectable()
export class MediaIndexService {
  private readonly logger = new Logger(MediaIndexService.name);
  private readonly anthropic: Anthropic;

  constructor(private readonly config: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  private get model(): string {
    // claude-opus-5 default; MEDIA_INDEX_MODEL=claude-haiku-4-5-20251001 corta
    // ~5x o custo de ingestão (alavanca documentada no plano — decisão do JP).
    return this.config.get<string>('MEDIA_INDEX_MODEL') ?? 'claude-opus-5';
  }

  /** Categoriza uma imagem (buffer) — o texto retornado é o índice de busca. */
  async categorize(buffer: Buffer, mimeType: SupportedMime): Promise<MediaCategorization> {
    const image: Anthropic.ImageBlockParam = {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
    };
    const opts = { maxRetries: 3, timeout: 90_000 };
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: [image, { type: 'text', text: 'Catalogue esta foto.' }] },
    ];

    let resp = await this.anthropic.messages.create(
      { model: this.model, max_tokens: 2048, system: SYSTEM_PROMPT, messages },
      opts,
    );
    let text = this.extractJsonText(resp);
    let result = CATEGORIZATION_SCHEMA.safeParse(this.safeJson(text));

    if (!result.success) {
      const errs = zodErrorText(result.error);
      this.logger.warn(`Categorização fora do schema; repair loop:\n${errs}`);
      resp = await this.anthropic.messages.create(
        {
          model: this.model,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [
            ...messages,
            { role: 'assistant', content: text },
            {
              role: 'user',
              content: `O JSON acima viola o schema:\n${errs}\nResponda APENAS o JSON corrigido, sem markdown.`,
            },
          ],
        },
        opts,
      );
      text = this.extractJsonText(resp);
      result = CATEGORIZATION_SCHEMA.safeParse(this.safeJson(text));
      if (!result.success) {
        throw new Error(`Categorização inválida após repair:\n${zodErrorText(result.error)}`);
      }
    }

    return result.data;
  }

  /** Texto que vira o embedding — MANTER estável: mudar o formato exige reindexar. */
  static embeddingText(c: {
    description: string | null;
    subjects: string[];
    themes: string[];
  }): string {
    return [c.description ?? '', c.subjects.join(', '), c.themes.join(', ')]
      .filter(Boolean)
      .join('\n');
  }

  private extractJsonText(resp: Anthropic.Message): string {
    const block = resp.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('Sem resposta de texto do Claude');
    const s = block.text.trim();
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    return (m ? m[1] : s).trim();
  }

  private safeJson(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
}
