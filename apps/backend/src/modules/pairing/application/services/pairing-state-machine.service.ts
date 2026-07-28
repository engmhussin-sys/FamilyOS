import { Inject, Injectable, Logger } from '@nestjs/common';

import { PAIRING_TRANSITIONS } from '../../domain/pairing-transitions.table';
import type {
  IPairingTransitionInput,
  IPairingTransitionRule,
  PairingStateValue,
} from '../../domain/pairing.types';
import {
  InvalidPairingTransitionException,
  MissingPairingCorrelationKeyException,
} from '../../domain/pairing.errors';
import {
  PAIRING_EVENT_REPOSITORY,
  type IPairingEventRepository,
  type IPairingEventRecord,
} from '../ports/pairing-event.repository.port';

/**
 * Owns exactly three responsibilities, per this step's brief:
 *   1. Valid transitions — is (event, currentState) legal at all.
 *   2. State validation — what IS the current state, looked up fresh
 *      each time (never trusted from a caller-supplied value).
 *   3. Event generation — every successful transition is recorded via
 *      IPairingEventRepository, unconditionally (Decision-059: "no
 *      transition without audit").
 *
 * Deliberately does NOT know about Redis invitations, registration
 * tokens, trust/risk scoring, or policy assignment — those are Services
 * 2-5 (Invitation, Registration Token, Trust Evaluation, Risk
 * Evaluation), not built in this step. This service's only job is
 * enforcing the state machine's shape and writing its audit trail.
 */
@Injectable()
export class PairingStateMachineService {
  private readonly logger = new Logger(PairingStateMachineService.name);

  constructor(
    @Inject(PAIRING_EVENT_REPOSITORY)
    private readonly pairingEventRepository: IPairingEventRepository,
  ) {}

  /**
   * Returns the current state for a device/child, or null if no pairing
   * history exists yet at all. Always a fresh read — see class docstring
   * point 2: state is never cached or trusted from the caller.
   */
  async getCurrentState(correlation: {
    deviceId?: string;
    childId?: string;
  }): Promise<PairingStateValue | null> {
    this.assertHasCorrelationKey(correlation);
    const latest = await this.pairingEventRepository.findLatest(correlation);
    return (latest?.toState as PairingStateValue) ?? null;
  }

  /**
   * Validates and applies one transition. Throws
   * InvalidPairingTransitionException without recording anything if the
   * event isn't legal from the current state — an audit row is only ever
   * written for a transition that actually happened.
   */
  async transition(input: IPairingTransitionInput): Promise<IPairingEventRecord> {
    this.assertHasCorrelationKey(input);

    const currentState = await this.getCurrentState({
      deviceId: input.deviceId,
      childId: input.childId,
    });

    const rule = this.findRule(input.event, currentState);
    if (!rule) {
      throw new InvalidPairingTransitionException(input.event, currentState);
    }

    const record = await this.pairingEventRepository.record({
      deviceId: input.deviceId,
      childId: input.childId,
      eventType: input.event,
      fromState: currentState,
      toState: rule.toState,
      actorType: input.actorType,
      actorId: input.actorId,
      metadata: input.metadata,
    });

    this.logger.log(
      `Pairing transition: ${input.event} (${currentState ?? '(none)'} -> ${rule.toState}) ` +
        `[${input.deviceId ? `device=${input.deviceId}` : `child=${input.childId}`}]`,
    );

    return record;
  }

  /** True/false version of transition's validation, without side
   * effects - useful for a caller (e.g. a future controller) that wants
   * to decide whether to even attempt an action before doing other work. */
  async canTransition(
    correlation: { deviceId?: string; childId?: string },
    event: IPairingTransitionInput['event'],
  ): Promise<boolean> {
    const currentState = await this.getCurrentState(correlation);
    return this.findRule(event, currentState) !== undefined;
  }

  private findRule(
    event: IPairingTransitionInput['event'],
    currentState: PairingStateValue | null,
  ): IPairingTransitionRule | undefined {
    return PAIRING_TRANSITIONS.find(
      (rule) => rule.event === event && rule.allowedFromStates.includes(currentState),
    );
  }

  private assertHasCorrelationKey(correlation: { deviceId?: string; childId?: string }): void {
    if (!correlation.deviceId && !correlation.childId) {
      throw new MissingPairingCorrelationKeyException();
    }
  }
}
