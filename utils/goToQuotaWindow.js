/**
 * GO TO daily activation quota (non-priority drivers) in a fixed IANA timezone.
 * @see GOTO_QUOTA_TIMEZONE
 */

const NON_PRIORITY_GOTO_DAILY_ACTIVATION_LIMIT = 2;

function getGoToQuotaTimezone() {
    return process.env.GOTO_QUOTA_TIMEZONE || 'Asia/Kolkata';
}

/**
 * Calendar date key YYYY-MM-DD in the quota timezone (for comparisons / storage).
 * @param {Date} [date=new Date()]
 * @param {string} [timeZone]
 * @returns {string}
 */
function getGoToQuotaDayKey(date = new Date(), timeZone = getGoToQuotaTimezone()) {
    return date.toLocaleDateString('en-CA', { timeZone });
}

/**
 * Stored quota day for a driver document (prefers goToQuotaDayKey, else legacy from goToLastActivationDate).
 * @param {object} driver Mongoose doc or plain object
 * @param {string} timeZone
 * @returns {string|null}
 */
function getStoredGoToQuotaDayKey(driver, timeZone = getGoToQuotaTimezone()) {
    if (driver.goToQuotaDayKey) {
        return String(driver.goToQuotaDayKey);
    }
    if (driver.goToLastActivationDate) {
        return getGoToQuotaDayKey(new Date(driver.goToLastActivationDate), timeZone);
    }
    return null;
}

/**
 * JSON fragment for GET/POST go-to responses.
 * @param {object} driver
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @param {string} [opts.timeZone]
 */
function computeGoToHandling(driver, opts = {}) {
    const timeZone = opts.timeZone ?? getGoToQuotaTimezone();
    const now = opts.now ?? new Date();
    const todayKey = getGoToQuotaDayKey(now, timeZone);
    const isPriorityDriver = !!driver.isPriorityDriver;

    if (isPriorityDriver) {
        return {
            isPriorityDriver: true,
            dailyActivationLimit: null,
            activationsUsedToday: null,
            activationsRemainingToday: null,
        };
    }

    const storedKey = getStoredGoToQuotaDayKey(driver, timeZone);
    const usedToday = storedKey === todayKey ? Number(driver.goToDailyActivations) || 0 : 0;
    const limit = NON_PRIORITY_GOTO_DAILY_ACTIVATION_LIMIT;

    return {
        isPriorityDriver: false,
        dailyActivationLimit: limit,
        activationsUsedToday: usedToday,
        activationsRemainingToday: Math.max(0, limit - usedToday),
    };
}

/**
 * Mongo aggregation expression: effective activations already counted for quota "today"
 * (matches computeGoToHandling for non-priority). todayKey is YYYY-MM-DD in GOTO_QUOTA_TIMEZONE.
 * @param {string} todayKey
 * @returns {object}
 */
function mongoExprEffectiveGoToActivationsToday(todayKey) {
    const tz = getGoToQuotaTimezone();
    return {
        $cond: {
            if: { $eq: ['$goToQuotaDayKey', todayKey] },
            then: { $ifNull: ['$goToDailyActivations', 0] },
            else: {
                $cond: {
                    if: {
                        $and: [
                            {
                                $or: [
                                    { $eq: ['$goToQuotaDayKey', null] },
                                    { $eq: [{ $type: '$goToQuotaDayKey' }, 'missing'] },
                                ],
                            },
                            { $ne: ['$goToLastActivationDate', null] },
                        ],
                    },
                    then: {
                        $cond: {
                            if: {
                                $eq: [
                                    {
                                        $dateToString: {
                                            format: '%Y-%m-%d',
                                            date: '$goToLastActivationDate',
                                            timezone: tz,
                                        },
                                    },
                                    todayKey,
                                ],
                            },
                            then: { $ifNull: ['$goToDailyActivations', 0] },
                            else: 0,
                        },
                    },
                    else: 0,
                },
            },
        },
    };
}

/**
 * Pipeline for a successful non-priority activation (after route build). Reads pre-update fields only.
 * @param {string} todayKey
 * @param {object} goToSnapshotPlain plain object for goTo subdocument
 * @param {Date} now
 * @returns {object[]}
 */
function buildNonPriorityGoToActivatePipeline(todayKey, goToSnapshotPlain, now) {
    const usedBefore = mongoExprEffectiveGoToActivationsToday(todayKey);
    return [
        {
            $set: {
                goTo: goToSnapshotPlain,
                goToLastActivationDate: now,
                goToQuotaDayKey: todayKey,
                goToDailyActivations: { $add: [usedBefore, 1] },
            },
        },
    ];
}

/**
 * Filter for findOneAndUpdate: non-priority driver may activate only if effective used today < limit.
 * @param {import('mongoose').Types.ObjectId|string} driverId
 * @param {string} todayKey
 */
function buildNonPriorityGoToActivateFilter(driverId, todayKey) {
    const usedExpr = mongoExprEffectiveGoToActivationsToday(todayKey);
    return {
        _id: driverId,
        isPriorityDriver: false,
        $expr: { $lt: [usedExpr, NON_PRIORITY_GOTO_DAILY_ACTIVATION_LIMIT] },
    };
}

module.exports = {
    NON_PRIORITY_GOTO_DAILY_ACTIVATION_LIMIT,
    getGoToQuotaTimezone,
    getGoToQuotaDayKey,
    getStoredGoToQuotaDayKey,
    computeGoToHandling,
    mongoExprEffectiveGoToActivationsToday,
    buildNonPriorityGoToActivatePipeline,
    buildNonPriorityGoToActivateFilter,
};
