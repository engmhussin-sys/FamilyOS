import { Injectable } from '@nestjs/common';

import { DeviceLivenessService } from '../../../pairing/application/services/device-liveness.service';
import type { JobOutcome, PlatformJobDefinition } from '../../domain/job.types';

export const DEVICE_LIVENESS_SWEEP_JOB = 'device-liveness-sweep';

/**
 * THE CLOCK BEHIND `HEARTBEAT_MISSED`.
 *
 * Twenty lines, delegating immediately, exactly like the two growth jobs beside
 * it: the rule lives in `pairing/domain/device-liveness.ts`, the work lives in
 * `pairing/application/services/device-liveness.service.ts`, and this module
 * adds a lease and a history row and no second implementation of either.
 *
 * PLATFORM, so `local_hour` is NULL. «Has this device gone quiet» is a question
 * about an elapsed interval, not about a household's calendar day — there is no
 * family-local hour at which it becomes the right question, and giving it one
 * would mean a device that dies at 02:05 waits until tomorrow to be noticed.
 *
 * CADENCE 3600s. The threshold is twenty-four hours, so hourly resolution
 * surfaces a dead device within 1/24th of the window it is measured over, and
 * the transition table makes a repeat sweep free (see the service). A shorter
 * cadence would buy resolution nobody needs against a 24-hour signal; a longer
 * one would mean a support agent asking «when did it stop» gets an answer
 * rounded to a quarter of a day.
 */
@Injectable()
export class DeviceLivenessSweepJob {
  constructor(private readonly liveness: DeviceLivenessService) {}

  definition(): PlatformJobDefinition {
    return {
      name: DEVICE_LIVENESS_SWEEP_JOB,
      scope: 'PLATFORM',
      description:
        'رصد الأجهزة الصامتة: يضع كل جهاز طفل لم تصل منه نبضة منذ ٢٤ ساعة في حالة DEGRADED، ويعود تلقائيًّا إلى HEALTHY عند أول نبضة.',
      handler: (ctx) => this.run(ctx.now),
    };
  }

  /** DETERMINISTIC: `now` is a parameter, never read inside. IDEMPOTENT: the
   * transition is legal only from HEALTHY, so a second run in the same outage
   * changes nothing. */
  async run(now: Date): Promise<JobOutcome> {
    return this.liveness.sweep(now);
  }
}
