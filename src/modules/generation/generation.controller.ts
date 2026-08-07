import {
  Controller,
  Delete,
  Post,
  Param,
  ParseIntPipe,
  Body,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerationService } from './generation.service';
import { SlideImageService } from './slide-image.service';
import { GenerateDto } from './dto/generate.dto';
import { SuggestThemeDto } from './dto/suggest-theme.dto';
import { RegenerateSlideDto } from './dto/regenerate-slide.dto';
import { GenerateSlideImageDto } from './dto/generate-slide-image.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('generation')
export class GenerationController {
  constructor(
    private readonly generationService: GenerationService,
    private readonly slideImageService: SlideImageService,
  ) {}

  @Post('generate')
  async generate(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Body() dto: GenerateDto,
  ) {
    return this.generationService.generate(dto, user.tenantId, user.userId);
  }

  @Post('suggest-theme')
  async suggestTheme(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Body() dto: SuggestThemeDto,
  ) {
    return this.generationService.suggestThemes(dto, user.tenantId);
  }

  @Post('regenerate/:id')
  async regenerate(@Param('id') id: string) {
    return this.generationService.regenerate(id);
  }

  @Post('regenerate-slide')
  async regenerateSlide(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Body() dto: RegenerateSlideDto,
  ) {
    return this.generationService.regenerateSlide(dto.contentId, dto.position, user.tenantId, dto.hint);
  }

  @Post(':contentId/slides/:position/image')
  async generateSlideImage(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Param('contentId') contentId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body() dto: GenerateSlideImageDto,
  ) {
    return this.slideImageService.generateForSlide(contentId, position, user.tenantId, dto.prompt);
  }

  /** Escolhe do acervo (banco de imagens) para este slide — pode devolver null. */
  @Post(':contentId/slides/:position/image/bank')
  async pickBankImage(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Param('contentId') contentId: string,
    @Param('position', ParseIntPipe) position: number,
  ) {
    return this.generationService.pickBankForSlide(contentId, position, user.tenantId);
  }

  /** Upload manual de imagem-fonte para este slide (campo `file`). */
  @Post(':contentId/slides/:position/image/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSlideSourceImage(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Param('contentId') contentId: string,
    @Param('position', ParseIntPipe) position: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.slideImageService.uploadForSlide(contentId, position, user.tenantId, file);
  }

  @Delete(':contentId/slides/:position/image')
  async removeSlideImage(
    @CurrentUser() user: { userId: string; tenantId: string },
    @Param('contentId') contentId: string,
    @Param('position', ParseIntPipe) position: number,
  ) {
    await this.slideImageService.removeForSlide(contentId, position, user.tenantId);
    return { removed: true };
  }
}
