const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    getGoToQuotaDayKey,
    computeGoToHandling,
    NON_PRIORITY_GOTO_DAILY_ACTIVATION_LIMIT,
} = require('../utils/goToQuotaWindow');

test('getGoToQuotaDayKey uses YYYY-MM-DD in fixed timezone', () => {
    const d = new Date('2026-04-24T18:30:00Z');
    assert.equal(getGoToQuotaDayKey(d, 'Asia/Kolkata'), '2026-04-25');
    assert.equal(getGoToQuotaDayKey(d, 'UTC'), '2026-04-24');
});

test('computeGoToHandling: priority driver has null limits', () => {
    const h = computeGoToHandling(
        { isPriorityDriver: true, goToDailyActivations: 99, goToQuotaDayKey: '2026-04-24' },
        { now: new Date('2026-04-24T12:00:00Z'), timeZone: 'UTC' }
    );
    assert.equal(h.isPriorityDriver, true);
    assert.equal(h.dailyActivationLimit, null);
    assert.equal(h.activationsUsedToday, null);
    assert.equal(h.activationsRemainingToday, null);
});

test('computeGoToHandling: non-priority same day counts toward limit', () => {
    const now = new Date('2026-04-24T15:00:00Z');
    const todayKey = getGoToQuotaDayKey(now, 'UTC');
    const h = computeGoToHandling(
        {
            isPriorityDriver: false,
            goToQuotaDayKey: todayKey,
            goToDailyActivations: 1,
        },
        { now, timeZone: 'UTC' }
    );
    assert.equal(h.activationsUsedToday, 1);
    assert.equal(h.activationsRemainingToday, 1);
    assert.equal(h.dailyActivationLimit, NON_PRIORITY_GOTO_DAILY_ACTIVATION_LIMIT);
});

test('computeGoToHandling: non-priority new calendar day resets effective used', () => {
    const now = new Date('2026-04-25T10:00:00Z');
    const h = computeGoToHandling(
        {
            isPriorityDriver: false,
            goToQuotaDayKey: '2026-04-24',
            goToDailyActivations: 2,
        },
        { now, timeZone: 'UTC' }
    );
    assert.equal(h.activationsUsedToday, 0);
    assert.equal(h.activationsRemainingToday, 2);
});

test('computeGoToHandling: legacy goToLastActivationDate when goToQuotaDayKey absent', () => {
    const now = new Date('2026-04-24T14:00:00Z');
    const h = computeGoToHandling(
        {
            isPriorityDriver: false,
            goToQuotaDayKey: null,
            goToLastActivationDate: new Date('2026-04-24T08:00:00Z'),
            goToDailyActivations: 2,
        },
        { now, timeZone: 'UTC' }
    );
    assert.equal(h.activationsUsedToday, 2);
    assert.equal(h.activationsRemainingToday, 0);
});
