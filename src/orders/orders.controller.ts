import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
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
  create(@Body() body: CreateOrderDto) {
    return this.orders.createInShopify(body);
  }
}
