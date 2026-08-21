import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalAdminGuard } from '../../common/guards/internal-admin.guard';
import { OperatorService } from './application/operator.service';
import { OperatorSessionService } from './application/operator-session.service';
import { OperatorAuthGuard } from './presentation/guards/operator-auth.guard';

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
 * NO CONTROLLER YET, and that is the honest state of this slice: the identity,
 * the sessions, the permission matrix and the guard exist and are tested, and
 * NOT ONE of the forty-five existing operator routes has been moved behind
 * them. Moving them is a second change that logs every operator out of a live
 * console, and it belongs in its own deploy with the sign-in screen that makes
 * it survivable.
 */
@Module({
  imports: [forwardRef(() => AuthModule)],
  providers: [OperatorSessionService, OperatorService, OperatorAuthGuard, InternalAdminGuard],
  exports: [OperatorSessionService, OperatorService, OperatorAuthGuard],
})
export class OperatorsModule {}
