import { Inject, Injectable, Logger } from '@nestjs/common';

import { PAIRING_TRANSITIONS, DEVICE_REQUIRED_EVENTS } from '../../domain/pairing-transitions.table';
import type {
  IPairingTransitionInput,
  IPairingTransitionRule,
  PairingStateValue,
} from '../../domain/pairing.types';
import {
  InvalidPairingTransitionException,
  MissingChildIdException,
  MissingDeviceIdException,
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
 * Per Decision-065/066: childId is the required Primary Owner reference
 * for every operation here — deviceId is an optional secondary reference,
 * only present from DEVICE_REGISTERED onward. State lookups are always
 * childId-scoped (never deviceId-scoped), keeping a child's pairing
 * timeline coherent across a future device replacement.
 *
 * Deliberately does NOT know about Redis invitations, registration
 * tokens, trust/risk scoring, or policy assignment — those are Services
 * 2-5 (Invitation, Registration Token, Trust Evaluation, Risk
 * Evaluation), not built in this step.
 */
@Injectable()
export class PairingStateMachineService {
  private readonly logger = new Logger(PairingStateMachineService.name);

  constructor(
    @Inject(PAIRING_EVENT_REPOSITORY)
    private readonly pairingEventRepository: IPairingEventRepository,
  ) {}

  /**
   * Returns the current state for a child's pairing timeline, or null if
   * no pairing history exists yet at all. Always a fresh read — never
   * cached or trusted from the caller.
   */
  async getCurrentState(childId: string): Promise<PairingStateValue | null> {
    this.assertHasChildId(childId);
    const latest = await this.pairingEventRepository.findLatest(childId);
    return (latest?.toState as PairingStateValue) ?? null;
  }

  /**
   * Validates and applies one transition. Throws
   * InvalidPairingTransitionException without recording anything if the
   * event isn't legal from the current state — an audit row is only ever
   * written for a transition that actually happened.
   */
  async transition(input: IPairingTransitionInput): Promise<IPairingEventRecord> {
    this.assertHasChildId(input.childId);

    const currentState = await this.getCurrentState(input.childId);

    const rule = this.findRule(input.event, currentState);
    if (!rule) {
      throw new InvalidPairingTransitionException(input.event, currentState);
    }

    if (DEVICE_REQUIRED_EVENTS.has(input.event) && !input.deviceId) {
      throw new MissingDeviceIdException(input.event);
    }

    const record = await this.pairingEventRepository.record({
      childId: input.childId,
      deviceId: input.deviceId,
      eventType: input.event,
      fromState: currentState,
      toState: rule.toState,
      actorType: input.actorType,
      actorId: input.actorId,
      metadata: input.metadata,
    });

    this.logger.log(
      `Pairing transition: ${input.event} (${currentState ?? '(none)'} -> ${rule.toState}) ` +
        `[child=${input.childId}${input.deviceId ? `, device=${input.deviceId}` : ''}]`,
    );

    return record;
  }

  /** True/false version of transition's validation, without side
   * effects - useful for a caller (e.g. a future controller) that wants
   * to decide whether to even attempt an action before doing other work. */
  async canTransition(
    childId: string,
    event: IPairingTransitionInput['event'],
  ): Promise<boolean> {
    const currentState = await this.getCurrentState(childId);
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

  private assertHasChildId(childId: string): void {
    if (!childId) {
      throw new MissingChildIdException();
    }
  }
}
