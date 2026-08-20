/**
 * SA-001 regression suite.
 *
 * Before this fix, `LifeIntelligenceController` carried a class-level
 * `@UseGuards(JwtAuthGuard)` while 22 handlers carried a method-level
 * `@UseGuards(DeviceJwtAuthGuard)`. NestJS *combines* guards
 * (global -> controller -> route) and requires all of them to pass; it
 * does not let a route-level guard replace a controller-level one. Since
 * `JwtStrategy` rejects any payload whose `actorType !== 'USER'` and
 * `DeviceJwtStrategy` rejects any payload whose `actorType !== 'DEVICE'`,
 * no token could ever satisfy both — every `/self/*` route answered 401
 * for every token type.
 *
 * These are real HTTP tests: a booted Nest application, the real guards,
 * the real Passport strategies, real signed JWTs. Only the domain
 * services behind the controller are mocked.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request = require('supertest');

import { LifeIntelligenceController } from '../../src/modules/life-intelligence/presentation/controllers/life-intelligence.controller';
import { JwtStrategy } from '../../src/modules/auth/presentation/strategies/jwt.strategy';
import { DeviceJwtStrategy } from '../../src/modules/auth/presentation/strategies/device-jwt.strategy';
import {
  JwtAuthGuard,
  DeviceJwtAuthGuard,
} from '../../src/modules/auth/presentation/guards/jwt-auth.guard';
import { HabitEngineService } from '../../src/modules/life-intelligence/application/services/habit-engine.service';
import { LifeTimelineService } from '../../src/modules/life-intelligence/application/services/life-timeline.service';
import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { FaithEngineService } from '../../src/modules/life-intelligence/application/services/faith-engine.service';
import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { SmartTaskEngineService } from '../../src/modules/life-intelligence/application/services/smart-task-engine.service';
import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { CoachingEngineService } from '../../src/modules/life-intelligence/application/services/coaching-engine.service';
import { DigitalTwinService } from '../../src/modules/life-intelligence/application/services/digital-twin.service';
import { FamilyInsightService } from '../../src/modules/life-intelligence/application/services/family-insight.service';
import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { FamilyDateService } from '../../src/common/time/family-date.service';

const ACCESS_SECRET ='test-access-secret-at-least-32-characters-long';

const parentToken = jwt.sign(
  { sub: 'user-1', actorType: 'USER', tokenKind: 'access', familyId: 'fam-1', jti: 'jti-parent' },
  ACCESS_SECRET,
  { expiresIn: '15m' },
);

const deviceToken = jwt.sign(
  { sub: 'device-1', actorType: 'DEVICE', tokenKind: 'access', familyId: 'fam-1', jti: 'jti-device' },
  ACCESS_SECRET,
  { expiresIn: '15m' },
);

describe('LifeIntelligenceController guard composition (SA-001)', () => {
  let app: INestApplication;

  const habitEngine = {
    listHabits: jest.fn().mockResolvedValue([{ id: 'habit-1' }]),
    listHabitsForChild: jest.fn().mockResolvedValue([{ id: 'habit-1' }]),
    createHabit: jest.fn(),
    completeHabit: jest.fn(),
    getScoreBreakdown: jest.fn(),
    markMissedHabits: jest.fn(),
    getMissedHabitsSignal: jest.fn(),
  };

  const pairingOrchestrator = {
    getChildAndFamilyIdForDevice: jest
      .fn()
      .mockResolvedValue({ childId: 'child-1', familyId: 'fam-1' }),
  };

  const noop = (): Record<string, jest.Mock> =>
    new Proxy({} as Record<string, jest.Mock>, {
      get: (target, prop: string) => {
        if (prop === 'then') return undefined;
        if (!target[prop]) target[prop] = jest.fn().mockResolvedValue({});
        return target[prop];
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [LifeIntelligenceController],
      providers: [
        JwtStrategy,
        DeviceJwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => ACCESS_SECRET } },
        { provide: HabitEngineService, useValue: habitEngine },
        { provide: PairingOrchestratorService, useValue: pairingOrchestrator },
        { provide: LifeTimelineService, useValue: noop() },
        { provide: HealthEngineService, useValue: noop() },
        { provide: FaithEngineService, useValue: noop() },
        { provide: LearningEngineService, useValue: noop() },
        { provide: SmartTaskEngineService, useValue: noop() },
        { provide: RewardsEngineService, useValue: noop() },
        { provide: FamilyCommunicationService, useValue: noop() },
        { provide: CoachingEngineService, useValue: noop() },
        { provide: DigitalTwinService, useValue: noop() },
        { provide: FamilyInsightService, useValue: noop() },
        { provide: DigitalWellbeingEngineService, useValue: noop() },
        { provide: ChildrenService, useValue: noop() },
        // F1: `getWellbeingInsight` now defaults `?date=` on the FAMILY's
        // calendar instead of UTC, so the controller holds the one service that
        // reads `Family.timezone`. This suite decides guard composition and
        // nothing else, so the stub answers a fixed business date.
        {
          provide: FamilyDateService,
          useValue: { getBusinessDate: jest.fn().mockResolvedValue('2026-01-15') },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('device-authenticated /self/* routes', () => {
    it('lets a DEVICE token through to the handler (was 401 before the fix)', async () => {
      const res = await request(app.getHttpServer())
        .get('/life-intelligence/self/habits')
        .set('Authorization', `Bearer ${deviceToken}`);

      expect(res.status).toBe(200);
      expect(pairingOrchestrator.getChildAndFamilyIdForDevice).toHaveBeenCalledWith('device-1');
    });

    it('rejects a PARENT token on a /self/* route', async () => {
      const res = await request(app.getHttpServer())
        .get('/life-intelligence/self/habits')
        .set('Authorization', `Bearer ${parentToken}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('This endpoint requires a device access token.');
    });

    it('rejects an unauthenticated request on a /self/* route', async () => {
      const res = await request(app.getHttpServer()).get('/life-intelligence/self/habits');
      expect(res.status).toBe(401);
    });
  });

  describe('parent-authenticated routes', () => {
    it('lets a USER token through to the handler', async () => {
      const res = await request(app.getHttpServer())
        .get('/life-intelligence/habits/child-1')
        .set('Authorization', `Bearer ${parentToken}`);

      expect(res.status).toBe(200);
      expect(habitEngine.listHabits).toHaveBeenCalledWith('child-1', 'fam-1');
    });

    it('rejects a DEVICE token on a parent route', async () => {
      const res = await request(app.getHttpServer())
        .get('/life-intelligence/habits/child-1')
        .set('Authorization', `Bearer ${deviceToken}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('This endpoint requires a parent access token.');
    });

    it('rejects an unauthenticated request on a parent route', async () => {
      const res = await request(app.getHttpServer()).get('/life-intelligence/habits/child-1');
      expect(res.status).toBe(401);
    });
  });

  /**
   * Structural gate. Removing the class-level guard means a route that
   * forgets its own `@UseGuards` becomes *public*, i.e. fail-open. This
   * test enumerates every handler on the controller and asserts each one
   * declares exactly one auth guard, and that the guard matches the route
   * family (`self/*` -> device, everything else -> parent).
   */
  describe('every route declares exactly one auth guard', () => {
    const prototype = LifeIntelligenceController.prototype;
    const handlers = Object.getOwnPropertyNames(prototype).filter((name) => {
      if (name === 'constructor') return false;
      return Reflect.hasMetadata('path', (prototype as never)[name] as object);
    });

    it('finds the expected number of handlers', () => {
      expect(handlers.length).toBeGreaterThanOrEqual(60);
    });

    it('has no class-level guard (the SA-001 root cause)', () => {
      const classGuards = Reflect.getMetadata('__guards__', LifeIntelligenceController) ?? [];
      expect(classGuards).toHaveLength(0);
    });

    it.each(handlers)('%s is guarded by exactly one matching auth guard', (name) => {
      const handler = (prototype as never)[name] as object;
      const guards: unknown[] = Reflect.getMetadata('__guards__', handler) ?? [];
      const path: string = Reflect.getMetadata('path', handler);

      expect(guards).toHaveLength(1);

      const isSelfRoute = path.startsWith('self/') || path.startsWith('communication/child/');
      expect(guards[0]).toBe(isSelfRoute ? DeviceJwtAuthGuard : JwtAuthGuard);
    });
  });
});
