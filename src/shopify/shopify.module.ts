import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ShopifyClient } from './shopify.client.js';
import { ShopifyController } from './shopify.controller.js';
import { ShopifyService } from './shopify.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ShopifyController],
  providers: [ShopifyService, ShopifyClient],
  exports: [ShopifyService, ShopifyClient],
})
export class ShopifyModule {}
