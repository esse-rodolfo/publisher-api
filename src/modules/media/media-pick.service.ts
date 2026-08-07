import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodErrorText } from '../generation/prompts/output-schema';
import { MediaService, MediaSearchHit } from './media.service';

const PICK_SCHEMA = z.object({
  asset_id: z.string().nullable(),
  reason: z.string(),
});

export interface MediaPick {
  assetId: string;
  url: string;
  key: string;
  reason: string;
}

const SYSTEM_PROMPT = `Você escolhe a foto de apoio de UM slide de carrossel de Instagram.
Receberá a copy do slide e uma lista de fotos candidatas (id + descrição).

Critério: a foto precisa ILUSTRAR o que a copy afirma — não basta ser do mesmo
universo. Foto genérica de escritório não ilustra um slide sobre "DRE em 8 minutos"
melhor do que nenhuma foto.

REGRA DURA: se nenhuma candidata ilustra bem, responda asset_id null. Slide sem
imagem é melhor que slide com imagem errada — o layout lida bem com a ausência.

Responda APENAS JSON: {"asset_id": "<id da lista ou null>", "reason": "<1 frase>"}`;

/**
 * Recuperação em duas etapas: o vetor RECUPERA (top-k barato, determinístico),
 * o LLM DECIDE (contexto da copy). O LLM só escolhe DENTRO dos candidatos —
 * id fora da lista é descartado (anti-alucinação) e vira null.
 */
@Injectable()
export class MediaPickService {
  private readonly logger = new Logger(MediaPickService.name);
  private readonly anthropic: Anthropic;

  constructor(
    private readonly config: ConfigService,
    private readonly media: MediaService,
  ) {
    this.anthropic = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  private get model(): string {
    return this.config.get<string>('MEDIA_PICK_MODEL') ?? 'claude-opus-5';
  }

  /**
   * Escolhe a foto do acervo para um slide, ou null se nenhuma serve.
   * `markUsed` incrementa o contador de uso (chamar true só quando a escolha
   * será de fato aplicada ao post — a UI de preview passa false).
   */
  async pickForSlide(
    tenantId: string,
    input: { slideText: string; theme?: string; persona?: string },
    markUsed = false,
  ): Promise<MediaPick | null> {
    const query = [input.theme, input.slideText, input.persona]
      .filter(Boolean)
      .join('\n');

    const candidates = await this.media.search(tenantId, query, {
      limit: 8,
      forCopyOverlay: true,
    });
    if (candidates.length === 0) return null;

    const picked = await this.choose(input, candidates);
    if (!picked) return null;

    if (markUsed) await this.media.markUsed(picked.assetId);
    return picked;
  }

  private async choose(
    input: { slideText: string; theme?: string; persona?: string },
    candidates: MediaSearchHit[],
  ): Promise<MediaPick | null> {
    const list = candidates
      .map(
        (c, i) =>
          `${i + 1}. id=${c.id}\n   ${c.description ?? '(sem descrição)'}\n   temas: ${c.themes.join(', ')}`,
      )
      .join('\n');
    const user = `COPY DO SLIDE:\n${input.slideText}\n${input.theme ? `\nTEMA DO POST: ${input.theme}` : ''}${input.persona ? `\nPERSONA: ${input.persona}` : ''}\n\nCANDIDATAS:\n${list}`;

    const opts = { maxRetries: 3, timeout: 30_000 };
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];

    let resp = await this.anthropic.messages.create(
      { model: this.model, max_tokens: 512, system: SYSTEM_PROMPT, messages },
      opts,
    );
    let text = this.extractJsonText(resp);
    let result = PICK_SCHEMA.safeParse(this.safeJson(text));

    if (!result.success) {
      const errs = zodErrorText(result.error);
      resp = await this.anthropic.messages.create(
        {
          model: this.model,
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          messages: [
            ...messages,
            { role: 'assistant', content: text },
            { role: 'user', content: `O JSON acima viola o schema:\n${errs}\nResponda APENAS o JSON corrigido.` },
          ],
        },
        opts,
      );
      text = this.extractJsonText(resp);
      result = PICK_SCHEMA.safeParse(this.safeJson(text));
      if (!result.success) {
        this.logger.warn(`Pick inválido após repair: ${zodErrorText(result.error)}`);
        return null; // falha de formato não pode travar a geração — sem imagem é estado válido
      }
    }

    const { asset_id, reason } = result.data;
    if (!asset_id) return null;

    const hit = candidates.find((c) => c.id === asset_id);
    if (!hit) {
      this.logger.warn(`Pick alucinou asset ${asset_id} fora dos candidatos — descartado`);
      return null;
    }
    return { assetId: hit.id, url: hit.url, key: hit.key, reason };
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
