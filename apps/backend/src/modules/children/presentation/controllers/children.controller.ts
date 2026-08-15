import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ChildrenService } from '../../application/services/children.service';
import { CreateChildDto } from '../dto/create-child.dto';
import { UpdateChildDto } from '../dto/update-child.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

/**
 * Every route here is scoped to `user.familyId` taken from the verified
 * access token — never from a request body/param — so one family can never
 * read or mutate another family's children, regardless of what childId a
 * client sends. This is the concrete implementation of the "root of
 * authorization is the Family" rule from docs/database/README.md §2.
 */
@Controller('children')
@UseGuards(JwtAuthGuard)
export class ChildrenController {
  constructor(private readonly childrenService: ChildrenService) {}

  @Post()
  @ParentSurface()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateChildDto, @CurrentUser() user: IJwtPayload) {
    return this.childrenService.createChild(user.familyId!, dto);
  }

  @Get()
  @ParentSurface()
  list(@CurrentUser() user: IJwtPayload) {
    return this.childrenService.listChildren(user.familyId!);
  }

  @Get(':childId')
  @ParentSurface()
  getOne(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.childrenService.getChildOrThrow(childId, user.familyId!);
  }

  @Patch(':childId')
  @ParentSurface()
  update(
    @Param('childId') childId: string,
    @Body() dto: UpdateChildDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.childrenService.updateChild(childId, user.familyId!, dto);
  }

  @Delete(':childId')
  @ParentSurface()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload): Promise<void> {
    await this.childrenService.deleteChild(childId, user.familyId!);
  }
}
