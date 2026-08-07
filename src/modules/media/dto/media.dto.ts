import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListMediaQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'INDEXING', 'READY', 'FAILED'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class UpdateMediaDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjects?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  themes?: string[];
}

export class SearchMediaDto {
  @IsString()
  @MaxLength(500)
  query: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  limit?: number;

  /** exclui fotos com texto legível / qualidade ruim (uso sob copy). */
  @IsOptional()
  @IsBoolean()
  forCopyOverlay?: boolean;
}

export class PickMediaDto {
  @IsString()
  @MaxLength(2000)
  slideText: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  theme?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  persona?: string;

  /** true só quando a escolha será aplicada ao post (incrementa times_used). */
  @IsOptional()
  @IsBoolean()
  markUsed?: boolean;
}
