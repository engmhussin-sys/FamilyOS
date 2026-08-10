import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { CreateHabitDto } from '../../src/modules/life-intelligence/application/dto/habit.dto';

describe('CreateHabitDto (Sprint 16.1 Phase 1 — CLOSES A REAL GAP: these fields existed on the Service since Sprint 16 but had no validated API path)', () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(CreateHabitDto, payload);
    return validate(dto);
  }

  it('a minimal, existing-shape payload (title + category only) is still valid — full backward compatibility', async () => {
    const errors = await validateDto({ title: 'Drink water', category: 'health' });
    expect(errors).toHaveLength(0);
  });

  it('a fully-populated payload with every new field is valid', async () => {
    const errors = await validateDto({
      title: 'Morning Quran review',
      category: 'faith',
      description: "Review yesterday's memorization",
      scheduledStartTime: '07:00',
      scheduledEndTime: '07:30',
      recurrence: 'DAILY',
      priority: 'HIGH',
      isShared: false,
    });
    expect(errors).toHaveLength(0);
  });

  describe('scheduledStartTime/scheduledEndTime format', () => {
    it('rejects a malformed time string', async () => {
      const errors = await validateDto({ title: 't', category: 'c', scheduledStartTime: '25:99' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-HH:MM string entirely', async () => {
      const errors = await validateDto({ title: 't', category: 'c', scheduledStartTime: 'morning' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts valid boundary times (00:00 and 23:59)', async () => {
      const errors1 = await validateDto({ title: 't', category: 'c', scheduledStartTime: '00:00' });
      const errors2 = await validateDto({ title: 't', category: 'c', scheduledEndTime: '23:59' });
      expect(errors1).toHaveLength(0);
      expect(errors2).toHaveLength(0);
    });
  });

  describe('recurrence', () => {
    it('accepts all three real recurrence values', async () => {
      for (const value of ['DAILY', 'WEEKLY', 'SPECIFIC_DAYS']) {
        const errors = await validateDto({ title: 't', category: 'c', recurrence: value });
        expect(errors).toHaveLength(0);
      }
    });

    it('rejects an invalid recurrence value', async () => {
      const errors = await validateDto({ title: 't', category: 'c', recurrence: 'HOURLY' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('recurrenceDaysOfWeek', () => {
    it('accepts a valid array of day-of-week integers (0-6)', async () => {
      const errors = await validateDto({ title: 't', category: 'c', recurrenceDaysOfWeek: [0, 3, 6] });
      expect(errors).toHaveLength(0);
    });

    it('rejects an out-of-range day value', async () => {
      const errors = await validateDto({ title: 't', category: 'c', recurrenceDaysOfWeek: [7] });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a negative day value', async () => {
      const errors = await validateDto({ title: 't', category: 'c', recurrenceDaysOfWeek: [-1] });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('priority', () => {
    it('accepts all three real priority values', async () => {
      for (const value of ['LOW', 'NORMAL', 'HIGH']) {
        const errors = await validateDto({ title: 't', category: 'c', priority: value });
        expect(errors).toHaveLength(0);
      }
    });

    it('rejects an invalid priority value', async () => {
      const errors = await validateDto({ title: 't', category: 'c', priority: 'URGENT' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  it('still rejects a missing required title (existing behavior unchanged)', async () => {
    const errors = await validateDto({ category: 'c' });
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });
});
