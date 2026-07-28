import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  app.enableCors({
    origin: process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? [],
    credentials: true,
  });

  // Global validation: every DTO is validated against its class-validator
  // decorators before it ever reaches a controller method. `whitelist`
  // strips unknown properties instead of accepting them — the backend
  // never trusts client input beyond what a DTO explicitly declares.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  logger.log(`AI Family Digital Coach API listening on port ${port}`);
}

bootstrap();
