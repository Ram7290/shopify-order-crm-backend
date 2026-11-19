import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableCors({ origin: process.env.FRONTEND_URL?.replace(/\/+$/, ''), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
