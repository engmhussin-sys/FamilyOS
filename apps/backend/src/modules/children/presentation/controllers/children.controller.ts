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
import type { IChildView } from '../../domain/child.types';

/**
 * Every route here is scoped to `user.familyId` taken from the verified
 * access token — never from a request body/param — so one family can never
 * read or mutate another family's children, regardless of what childId a
 * client sends. This is the concrete implementation of the "root of
 * authorization is the Family" rule from docs/database/README.md §2.
 *
 * THE SERIALIZATION BOUNDARY. Every handler that returns a child declares
 * `IChildView` — the whitelist in `child.types.ts` — as its return type, so
 * the compiler, not a reviewer's memory, is what stops the raw Prisma row
 * from reaching a client. That row carries `pinCodeHash` (the child app's
 * login PIN, hashed); these routes used to return it verbatim, which put a
 * trivially-invertible credential into HTTP caches, client logs and crash
 * reports. `IChildView` is derived from the repository's `select`, so a
 * column added to `Child` tomorrow is not exposed here by default and
 * widening the response is a deliberate edit to one list.
 */
@Controller('children')
@UseGuards(JwtAuthGuard)
export class ChildrenController {
  constructor(private readonly childrenService: ChildrenService) {}

  @Post()
  @ParentSurface()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateChildDto, @CurrentUser() user: IJwtPayload): Promise<IChildView> {
    return this.childrenService.createChild(user.familyId!, dto);
  }

  @Get()
  @ParentSurface()
  list(@CurrentUser() user: IJwtPayload): Promise<IChildView[]> {
    return this.childrenService.listChildren(user.familyId!);
  }

  @Get(':childId')
  @ParentSurface()
  getOne(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload): Promise<IChildView> {
    return this.childrenService.getChildOrThrow(childId, user.familyId!);
  }

  @Patch(':childId')
  @ParentSurface()
  update(
    @Param('childId') childId: string,
    @Body() dto: UpdateChildDto,
    @CurrentUser() user: IJwtPayload,
  ): Promise<IChildView> {
    return this.childrenService.updateChild(childId, user.familyId!, dto);
  }

  @Delete(':childId')
  @ParentSurface()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload): Promise<void> {
    await this.childrenService.deleteChild(childId, user.familyId!);
  }
}
