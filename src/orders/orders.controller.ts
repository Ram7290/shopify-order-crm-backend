import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { ListOrdersQuery } from './dto/list-orders.query.js';
import { OrdersService } from './orders.service.js';
import { OrdersSyncService } from './orders-sync.service.js';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly sync: OrdersSyncService,
  ) {}

  @Get()
  list(@Query() query: ListOrdersQuery) {
    return this.orders.list(query);
  }

  @Post('sync')
  syncFromShopify() {
    return this.sync.syncAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findOne(id);
  }

  @Post()
  create(@Body() body: CreateOrderDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!idempotencyKey || !/^[A-Za-z0-9-]{8,100}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key header is required (8-100 letters, digits or dashes)');
    }
    return this.orders.createInShopify(body, idempotencyKey);
  }
}
