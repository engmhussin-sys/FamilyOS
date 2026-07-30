import { HealthController } from '../../src/modules/health/presentation/controllers/health.controller';

describe('HealthController', () => {
  function buildController(prismaOk: boolean, redisOk: boolean) {
    const prismaMock = {
      $queryRaw: jest.fn(prismaOk ? () => Promise.resolve([{ '?column?': 1 }]) : () => Promise.reject(new Error('db down'))),
    };
    const redisMock = {
      ping: jest.fn(redisOk ? () => Promise.resolve() : () => Promise.reject(new Error('redis down'))),
    };
    const controller = new HealthController(prismaMock as any, redisMock as any);
    return controller;
  }

  it('live() always returns ok, checking nothing external', () => {
    const controller = buildController(false, false); // even with both dependencies down
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  describe('ready()', () => {
    function fakeResponse() {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    }

    it('returns 200 with status ok when both DB and Redis are reachable', async () => {
      const controller = buildController(true, true);
      const res = fakeResponse();

      await controller.ready(res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ok', database: true, redis: true }),
      );
    });

    it('returns 503 when the database is unreachable', async () => {
      const controller = buildController(false, true);
      const res = fakeResponse();

      await controller.ready(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'degraded', database: false }),
      );
    });

    it('returns 503 when Redis is unreachable', async () => {
      const controller = buildController(true, false);
      const res = fakeResponse();

      await controller.ready(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'degraded', redis: false }),
      );
    });

    it('returns 503 when BOTH are unreachable', async () => {
      const controller = buildController(false, false);
      const res = fakeResponse();

      await controller.ready(res);

      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});
