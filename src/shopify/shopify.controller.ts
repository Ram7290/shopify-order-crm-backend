import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/auth.guard.js';
import { ShopifyService } from './shopify.service.js';

@Controller('shopify')
export class ShopifyController {
  constructor(
    private readonly shopify: ShopifyService,
    private readonly config: ConfigService,
  ) {}

  @Get('install')
  install(@Query('shop') shop: string, @Res() res: Response) {
    res.redirect(this.shopify.buildInstallUrl(shop));
  }

  @Get('callback')
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const shop = await this.shopify.completeInstall(query);
    const frontend = this.config.getOrThrow<string>('FRONTEND_URL');
    res.redirect(`${frontend}/?shopify=connected&shop=${encodeURIComponent(shop)}`);
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  status() {
    return this.shopify.getStatus();
  }

  @Get('variants')
  @UseGuards(JwtAuthGuard)
  variants(@Query('search') search = '') {
    return this.shopify.searchVariants(String(search).slice(0, 100));
  }
}
