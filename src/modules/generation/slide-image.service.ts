import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SlideImage } from '@publisher/scene-engine';
import { PrismaService } from '../../database/prisma.service';
import { MinioClient } from '../../database/minio.client';
import { GenerationOutput, SlideImageRaw } from './types';

type ImageModel = SlideImageRaw['model'];

/**
 * Geração de imagem por slide (P1 do template tweet). Usa o `image_prompt`
 * emitido pelo LLM (ou um override), gera via Gemini/OpenAI (fetch nativo),
 * sobe no MinIO e grava o SlideImage em snake_case no slidesData + bodyData —
 * mesma dupla-escrita do regenerateSlide; o adapter de render (carousel-to-doc)
 * converte pro camelCase do scene-engine.
 */
@Injectable()
export class SlideImageService {
  private readonly logger = new Logger(SlideImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly minio: MinioClient,
  ) {}

  /** true se há provedor de imagem configurado (Gemini ou OpenAI). */
  hasProvider(): boolean {
    return Boolean(
      this.config.get<string>('GEMINI_API_KEY') ||
        this.config.get<string>('OPENAI_API_KEY'),
    );
  }

  async generateForSlide(
    contentId: string,
    position: number,
    tenantId: string,
    promptOverride?: string,
  ): Promise<SlideImage> {
    const { raw, bodyIdx } = await this.loadBodySlide(contentId, position, tenantId);
    const slide = raw.slides[bodyIdx];

    const prompt =
      promptOverride?.trim() || slide.image_prompt?.trim() || slide.image?.prompt?.trim();
    if (!prompt) {
      throw new BadRequestException(
        `Slide ${position} não possui image_prompt; envie um prompt no corpo da requisição`,
      );
    }

    const provider = this.resolveProvider();

    try {
      const buffer = await this.generateImage(provider, prompt);

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const key = `${contentId}/slides/${position}/image-${stamp}.png`;
      await this.minio.putBuffer(key, buffer, 'image/png');

      const { width, height } = this.pngSize(buffer);
      const image: SlideImageRaw = {
        // preserva ajustes visuais de uma imagem anterior, se houver
        seed: slide.image?.seed,
        focal: slide.image?.focal,
        treatment: slide.image?.treatment,
        enabled: true,
        role: 'figure',
        source: 'ai',
        prompt,
        model: provider.model,
        status: 'ready',
        asset_url: this.minio.publicUrl(key),
        asset_key: key,
        width,
        height,
      };

      await this.writeSlideImage(contentId, position, raw, bodyIdx, image);
      this.logger.log(`Imagem do slide ${position} gerada (${provider.model}): ${key}`);
      return this.toSceneImage(image);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: SlideImageRaw = {
        enabled: true,
        role: 'figure',
        source: 'ai',
        prompt,
        model: provider.model,
        status: 'failed',
        last_error: message.slice(0, 500),
      };
      // best-effort: registra a falha no slide sem mascarar o erro original
      await this.writeSlideImage(contentId, position, raw, bodyIdx, failed).catch((e) =>
        this.logger.warn(`Falha ao gravar status failed no slide ${position}: ${e}`),
      );
      this.logger.warn(`Geração de imagem do slide ${position} falhou: ${message}`);
      throw new BadGatewayException(
        `Não foi possível gerar a imagem do slide ${position}. Tente novamente.`,
      );
    }
  }

  /**
   * Grava uma imagem EXTERNA num slide (acervo ou upload manual) usando a
   * mesma dupla-escrita da geração. Preserva seed/focal/treatment anteriores.
   */
  async applyImage(
    contentId: string,
    position: number,
    tenantId: string,
    image: Omit<SlideImageRaw, 'seed' | 'focal' | 'treatment'>,
  ): Promise<SlideImage> {
    const { raw, bodyIdx } = await this.loadBodySlide(contentId, position, tenantId);
    const slide = raw.slides[bodyIdx];
    const full: SlideImageRaw = {
      seed: slide.image?.seed,
      focal: slide.image?.focal,
      treatment: slide.image?.treatment,
      ...image,
    };
    await this.writeSlideImage(contentId, position, raw, bodyIdx, full);
    this.logger.log(`Imagem ${full.source} aplicada ao slide ${position} (content ${contentId})`);
    return this.toSceneImage(full);
  }

  /** Upload manual de imagem-fonte para um slide (3ª opção da política). */
  async uploadForSlide(
    contentId: string,
    position: number,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<SlideImage> {
    if (!file) throw new BadRequestException('Arquivo "file" ausente');
    const accepted = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!accepted.has(file.mimetype)) {
      throw new BadRequestException(`Tipo ${file.mimetype} não aceito (jpeg, png ou webp)`);
    }
    if (file.size > 15 * 1024 * 1024) {
      throw new BadRequestException('Imagem excede o limite de 15MB');
    }

    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const key = `${contentId}/slides/${position}/upload-${stamp}.${ext}`;
    await this.minio.putBuffer(key, file.buffer, file.mimetype);

    const { width, height } = this.pngSize(file.buffer);
    return this.applyImage(contentId, position, tenantId, {
      enabled: true,
      role: 'figure',
      source: 'upload',
      status: 'ready',
      asset_url: this.minio.publicUrl(key),
      asset_key: key,
      width,
      height,
    });
  }

  /** Remove a imagem do slide (limpa `slide.image` na dupla-escrita). */
  async removeForSlide(contentId: string, position: number, tenantId: string): Promise<void> {
    const { raw, bodyIdx } = await this.loadBodySlide(contentId, position, tenantId);
    await this.writeSlideImage(contentId, position, raw, bodyIdx, undefined);
    this.logger.log(`Imagem do slide ${position} removida (content ${contentId})`);
  }

  /** Carrega content + slidesData validando tenant e que position é slide de corpo. */
  private async loadBodySlide(contentId: string, position: number, tenantId: string) {
    const content = await this.prisma.content.findFirst({
      where: { id: contentId, tenantId, deletedAt: null },
    });
    if (!content) throw new NotFoundException(`Content ${contentId} not found`);

    const raw = (content.slidesData ?? {}) as unknown as GenerationOutput;
    const bodyIdx = position - 1; // cover=0 → body i ocupa position i+1
    if (!Array.isArray(raw.slides) || bodyIdx < 0 || bodyIdx >= raw.slides.length) {
      throw new BadRequestException(`Posição ${position} não é um slide de corpo`);
    }
    return { content, raw, bodyIdx };
  }

  /** Dupla-escrita: slidesData.slides[bodyIdx].image + bodyData da linha Slide. */
  private async writeSlideImage(
    contentId: string,
    position: number,
    raw: GenerationOutput,
    bodyIdx: number,
    image: SlideImageRaw | undefined,
  ): Promise<void> {
    const slide = { ...raw.slides[bodyIdx] };
    if (image) slide.image = image;
    else delete slide.image;
    raw.slides[bodyIdx] = slide;

    await this.prisma.content.update({
      where: { id: contentId },
      data: { slidesData: raw as any },
    });

    const dbSlide = await this.prisma.slide.findFirst({ where: { contentId, position } });
    if (dbSlide) {
      const body = { ...((dbSlide.bodyData as Record<string, unknown>) ?? {}) };
      if (image) body.image = image;
      else delete body.image;
      await this.prisma.slide.update({
        where: { id: dbSlide.id },
        data: { bodyData: body as any },
      });
    }
  }

  /** Resolve o provedor pela env: Gemini tem prioridade; sem chave → 422. */
  private resolveProvider(): { model: ImageModel; apiKey: string } {
    const geminiKey = this.config.get<string>('GEMINI_API_KEY');
    if (geminiKey) return { model: 'nano-banana', apiKey: geminiKey };

    const openaiKey = this.config.get<string>('OPENAI_API_KEY');
    if (openaiKey) return { model: 'gpt-5.5-image', apiKey: openaiKey };

    throw new UnprocessableEntityException(
      'Nenhum provedor de imagem configurado (defina GEMINI_API_KEY ou OPENAI_API_KEY)',
    );
  }

  private async generateImage(
    provider: { model: ImageModel; apiKey: string },
    prompt: string,
  ): Promise<Buffer> {
    return provider.model === 'nano-banana'
      ? this.generateWithGemini(prompt, provider.apiKey)
      : this.generateWithOpenAI(prompt, provider.apiKey);
  }

  /** Gemini image generation (nano-banana) via REST; 16:9 via imageConfig. */
  private async generateWithGemini(prompt: string, apiKey: string): Promise<Buffer> {
    const model = this.config.get<string>('GEMINI_IMAGE_MODEL') ?? 'gemini-2.5-flash-image';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: '16:9' },
          },
        }),
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
      }>;
    };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error('Gemini não retornou imagem na resposta');
    return Buffer.from(part.inlineData.data, 'base64');
  }

  /** OpenAI images (gpt-5.5-image) via REST; landscape 1536x1024 (não há 16:9 exato). */
  private async generateWithOpenAI(prompt: string, apiKey: string): Promise<Buffer> {
    const model = this.config.get<string>('OPENAI_IMAGE_MODEL') ?? 'gpt-5.5-image';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt, n: 1, size: '1536x1024' }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = json.data?.[0];
    if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
    if (first?.url) {
      const img = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error(`OpenAI asset download ${img.status}`);
      return Buffer.from(await img.arrayBuffer());
    }
    throw new Error('OpenAI não retornou imagem na resposta');
  }

  /** Dimensões do PNG lidas do IHDR (bytes 16-23); vazio se não for PNG. */
  private pngSize(buf: Buffer): { width?: number; height?: number } {
    if (buf.length < 24 || buf[0] !== 0x89 || buf.readUInt32BE(12) !== 0x49484452) return {};
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  /** snake_case persistido → SlideImage camelCase do scene-engine (contrato da API). */
  private toSceneImage(i: SlideImageRaw): SlideImage {
    return {
      enabled: i.enabled,
      role: i.role,
      source: i.source,
      assetId: i.asset_id,
      prompt: i.prompt,
      model: i.model,
      seed: i.seed,
      focal: i.focal,
      treatment: i.treatment,
      status: i.status,
      assetUrl: i.asset_url,
      assetKey: i.asset_key,
      width: i.width,
      height: i.height,
      lastError: i.last_error,
    };
  }
}
