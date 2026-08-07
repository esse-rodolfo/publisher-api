import { IsString, IsIn, IsOptional, IsObject } from 'class-validator';
import { PATTERNS, Persona, HookPattern, TemplateName } from '../types';

export class GenerateDto {
  @IsString()
  tema: string;

  /** Slug de uma persona do tenant — existência validada no GenerationService. */
  @IsString()
  persona: Persona;

  @IsOptional()
  @IsIn(PATTERNS)
  pattern?: HookPattern;

  /** família visual escolhida no wizard; ausente = automático (pelo pattern). */
  @IsOptional()
  @IsIn(['compendium', 'tweet', 'custom'])
  template?: TemplateName;

  /** snapshot de estilo do template escolhido (tipografia/paleta) — ex.: Twitter dark. */
  @IsOptional()
  @IsObject()
  styleData?: Record<string, unknown>;

  /**
   * Política de imagem dos slides (escolhida no wizard):
   * - 'ai': gera por IA nos slides com image_prompt (comportamento atual)
   * - 'bank': escolhe do acervo do tenant (banco de imagens) nos mesmos slides
   * - 'upload': usuário sobe manualmente no studio — nenhuma ação automática
   * - 'none' / ausente: sem imagem automática (default atual)
   */
  @IsOptional()
  @IsIn(['ai', 'bank', 'upload', 'none'])
  imagePolicy?: 'ai' | 'bank' | 'upload' | 'none';
}
