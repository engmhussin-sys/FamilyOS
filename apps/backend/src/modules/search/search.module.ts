import { Module } from '@nestjs/common';

import { SearchController } from './presentation/controllers/search.controller';
import { SearchService } from './application/search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
