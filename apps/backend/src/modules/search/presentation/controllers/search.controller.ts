import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { SearchService } from '../../application/search.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(@Query('q') query: string, @CurrentUser() user: IJwtPayload) {
    return this.searchService.search(user.familyId!, user.sub, query ?? '');
  }
}
