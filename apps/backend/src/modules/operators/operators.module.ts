import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalAdminGuard } from '../../common/guards/internal-admin.guard';
import { OperatorService } from './application/operator.service';
import { OperatorSessionService } from './application/operator-session.service';
import { OperatorAuthGuard } from './presentation/guards/operator-auth.guard';
import { OperatorAuthController } from './presentation/controllers/operator-auth.controller';
import { OperatorAdminController } from './presentation/controllers/operator-admin.controller';

/**
 * SPRINT F2 — WHO IS OPERATING THIS PLATFORM.
 *
 * It imports `AuthModule` for ONE thing: `PasswordService`. Operators and
 * parents are different populations with different tokens and different tables,
 * and the only thing they share is that argon2id is the right way to store a
 * password — reimplementing that for staff would mean two hashing policies, and
 * the weaker one would be the one nobody reviewed.
 *
 * `InternalAdminGuard` is provided (not re-implemented) so `OperatorAuthGuard`
 * can DELEGATE the shared-key check to it. The outer gate keeps exactly the
 * behaviour it has today, including failing closed when the key is unset.
 *
 * `OperatorAuthController` is the way in: sign in, sign out, who am I, and the
 * self-closing bootstrap. Every one of its routes sits behind the shared key as
 * well, which is what keeps the operator LOGIN itself off the public internet —
 * a sign-in form anyone can reach is a password oracle for a console that can
 * suspend households.
 *
 * NOT ONE of the forty-five EXISTING operator routes has been moved behind the
 * new guard. Only the safety desk — the newest and most sensitive surface, and
 * the one that should never have had a shared secret alone in front of it —
 * uses it today. Moving the rest logs every operator out of a live console and
 * belongs in its own deploy.
 *
 * `OperatorAdminController` carries the routes for `operators.manage`. It was
 * added by review rather than by plan: `create` and `update` had been written
 * and tested with NO ROUTE REACHING THEM, so the single capability this sprint
 * exists to deliver — revoking one person's access without revoking everyone's —
 * could not be performed by anybody through the API.
 */
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [OperatorAuthController, OperatorAdminController],
  providers: [OperatorSessionService, OperatorService, OperatorAuthGuard, InternalAdminGuard],
  // `InternalAdminGuard` is exported alongside the guard that delegates to it:
  // Nest instantiates a `@UseGuards(...)` class in the CONSUMING module's
  // context, so any module mounting `OperatorAuthGuard` must be able to resolve
  // its outer gate too. Caught by `app.module.spec.ts` the first time this was
  // wired, which is exactly what that suite is for.
  exports: [OperatorSessionService, OperatorService, OperatorAuthGuard, InternalAdminGuard],
})
export class OperatorsModule {}
