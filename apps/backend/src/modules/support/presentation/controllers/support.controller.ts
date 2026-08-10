import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { SupportService } from '../../application/services/support.service';
import { CreateSupportRequestDto } from '../../application/dto/create-support-request.dto';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  /** No auth guard — deliberately public, same reasoning as the DTO's
   * own docstring. Rate-limited at 5/min per IP (Nest's default
   * Throttler tracking), matching the same tightness already used
   * for auth/register and billing/subscribe — public + unauthenticated
   * endpoints are the ones most worth protecting from scripted abuse. */
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  submit(@Body() dto: CreateSupportRequestDto) {
    return this.supportService.submit(dto);
  }

  /** CLOSES A CRITICAL GAP (proactive business audit): the module
   * could receive requests but the team had no way to ever read them
   * back — see SupportService.listAll's own docstring. */
  @Get()
  @UseGuards(InternalAdminGuard)
  listAll() {
    return this.supportService.listAll();
  }
}
