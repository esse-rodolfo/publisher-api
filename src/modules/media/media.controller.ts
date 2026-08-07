import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MediaService } from './media.service';
import { MediaPickService } from './media-pick.service';
import { ListMediaQueryDto, PickMediaDto, SearchMediaDto, UpdateMediaDto } from './dto/media.dto';

type AuthedUser = { userId: string; tenantId: string };

/** Acervo de imagens do tenant — ver docs/plano-banco-de-imagens.md. */
@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly pick: MediaPickService,
  ) {}

  /** Upload em lote (campo `files`, até 20 por request). */
  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', 20))
  upload(@CurrentUser() user: AuthedUser, @UploadedFiles() files: Express.Multer.File[]) {
    return this.media.upload(files, user.tenantId);
  }

  @Get()
  list(@CurrentUser() user: AuthedUser, @Query() query: ListMediaQueryDto) {
    return this.media.list(user.tenantId, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.media.get(id, user.tenantId);
  }

  /** Corrige o índice à mão (re-embedda sem repetir o Claude). */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() body: UpdateMediaDto,
  ) {
    return this.media.updateMeta(id, user.tenantId, body);
  }

  /** Reprocessa; `?full=true` refaz também a categorização do Claude. */
  @Post(':id/reindex')
  async reindex(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Query('full') full?: string,
  ) {
    await this.media.reindex(id, user.tenantId, full === 'true');
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    await this.media.remove(id, user.tenantId);
    return { ok: true };
  }

  /** Busca semântica no acervo. */
  @Post('search')
  search(@CurrentUser() user: AuthedUser, @Body() body: SearchMediaDto) {
    return this.media.search(user.tenantId, body.query, {
      limit: body.limit,
      forCopyOverlay: body.forCopyOverlay,
    });
  }

  /** Escolha por IA para um slide — devolve o asset OU null (nenhum serve). */
  @Post('pick')
  pickForSlide(@CurrentUser() user: AuthedUser, @Body() body: PickMediaDto) {
    return this.pick.pickForSlide(
      user.tenantId,
      { slideText: body.slideText, theme: body.theme, persona: body.persona },
      body.markUsed ?? false,
    );
  }
}
