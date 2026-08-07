import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BrandKitService } from './brand-kit.service';

export class UpdateBrandKitDto {
  @IsOptional()
  @IsObject()
  typography?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  palette?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  brand?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsIn(['compendium', 'tweet'])
  template?: string;
}

@Controller('brand-kit')
export class BrandKitController {
  constructor(private readonly service: BrandKitService) {}

  @Get()
  async get(@CurrentUser() user: { tenantId: string }) {
    return this.service.getOrCreateDefault(user.tenantId);
  }

  @Patch()
  async update(@CurrentUser() user: { tenantId: string }, @Body() dto: UpdateBrandKitDto) {
    return this.service.update(user.tenantId, dto);
  }

  @Post('reset')
  async reset(@CurrentUser() user: { tenantId: string }) {
    return this.service.resetToSeed(user.tenantId);
  }

  // ---- estilos nomeados ----

  @Get('list')
  async list(@CurrentUser() user: { tenantId: string }) {
    return this.service.list(user.tenantId);
  }

  @Post('styles')
  async createStyle(@CurrentUser() user: { tenantId: string }, @Body() dto: UpdateBrandKitDto) {
    return this.service.createStyle(user.tenantId, dto);
  }

  @Patch('styles/:id')
  async updateStyle(
    @CurrentUser() user: { tenantId: string },
    @Param('id') id: string,
    @Body() dto: UpdateBrandKitDto,
  ) {
    return this.service.updateStyle(user.tenantId, id, dto);
  }

  @Delete('styles/:id')
  async removeStyle(@CurrentUser() user: { tenantId: string }, @Param('id') id: string) {
    await this.service.removeStyle(user.tenantId, id);
    return { ok: true };
  }
}
