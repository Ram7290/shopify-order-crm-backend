import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ShopifyModule } from '../shopify/shopify.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersPersistenceService } from './orders-persistence.service.js';
import { OrdersService } from './orders.service.js';
import { OrdersSyncService } from './orders-sync.service.js';

@Module({
  imports: [AuthModule, ShopifyModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersSyncService, OrdersPersistenceService],
  exports: [OrdersPersistenceService],
})
export class OrdersModule {}
