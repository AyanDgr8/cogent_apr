#!/usr/bin/env node
// update_records.js
//
// Applies the Available Time update to an existing APR database:
//
//   1. Schema migration (idempotent, safe to re-run):
//        • adds agent_complete_hourly_<tenant>.available_time
//        • widens agent_activity_<tenant>.unique_agent_activity to include
//          event_type and event_state, so two state transitions sharing a
//          timestamp are both stored instead of collapsing onto one row
//        • adds any custom_state_<state> column the tenant config declares
//
//   2. Backfill of already-populated rows: recomputes login/available/idle/
//      wrap-up/hold/on-call/not-available time and the per-state break columns
//      from the stored activity events, clipping every state interval to its
//      hourly slot rather than trusting the stats API's aggregate attribution.
//
// Usage:
//   node update_records.js --migrate-only                    # schema only, all tenants
//   node update_records.js 12-08-2026 12-08-2026             # migrate + backfill one day
//   node update_records.js 01-08-2026 12-08-2026 --tenant=hth
//
// Dates are inclusive and interpreted in IST (Asia/Kolkata), matching the
// timezone the report slots are labelled in.

import dotenv from 'dotenv';
import { pool } from './database/config.js';
import { reconcileTrailingAgentState } from './agentEvents.js';
import { TENANT_CONFIG, getAllTenants } from './tenantConfig.js';

dotenv.config();
process.env.TZ = 'Asia/Kolkata';

const DATE_PATTERN = /^(\d{2})-(\d{2})-(\d{4})$/;
const IST_OFFSET_SECONDS = (5 * 60 + 30) * 60;

const ACTIVITY_UNIQUE_KEY = ['agent_name', 'event_timestamp', 'event_type', 'event_state'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage() {
    console.error(`
Usage:
  node update_records.js --migrate-only [--tenant=<tenant>]
  node update_records.js <DD-MM-YYYY> <DD-MM-YYYY> [--tenant=<tenant>]

Options:
  --migrate-only   Apply the schema changes and exit without backfilling.
  --skip-migrate   Backfill only; assume the schema is already migrated.
  --tenant=<name>  Restrict to one tenant (default: every tenant in tenantConfig.js).

Available tenants: ${getAllTenants().join(', ')}
`);
}

function parseDate(value, endOfDay = false) {
    const match = DATE_PATTERN.exec(value || '');
    if (!match) {
        throw new Error(`Invalid date "${value || ''}". Expected DD-MM-YYYY.`);
    }

    const [, dayText, monthText, yearText] = match;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    const testDate = new Date(Date.UTC(year, month - 1, day));

    if (
        testDate.getUTCFullYear() !== year ||
        testDate.getUTCMonth() !== month - 1 ||
        testDate.getUTCDate() !== day
    ) {
        throw new Error(`Invalid calendar date "${value}".`);
    }

    // APR report slots are labelled in IST (UTC+05:30).
    const midnightUtc = Date.UTC(year, month - 1, day) / 1000 - IST_OFFSET_SECONDS;
    return endOfDay ? midnightUtc + 24 * 60 * 60 : midnightUtc;
}

function formatSeconds(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder].map(part => String(part).padStart(2, '0')).join(':');
}

// Same derivation the report and the insert path use, so the migration creates
// exactly the columns the rest of the code writes to.
function stateColumnName(stateName) {
    return `custom_state_${String(stateName).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

function tenantStates(tenant) {
    const config = TENANT_CONFIG[tenant];
    if (!config) throw new Error(`Unknown tenant "${tenant}".`);
    const productive = config.productive_states || [];
    const nonProductive = config.non_productive_states || [];
    return {
        all: [...productive, ...nonProductive],
        productive: new Set(productive),
        nonProductive: new Set(nonProductive)
    };
}

async function tableExists(table) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [table]
    );
    return Number(rows[0].n) > 0;
}

async function columnExists(table, column) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    return Number(rows[0].n) > 0;
}

async function indexColumns(table, keyName) {
    const [rows] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [keyName]);
    return rows
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
        .map(row => row.Column_name);
}

// ---------------------------------------------------------------------------
// Step 1: schema migration
// ---------------------------------------------------------------------------

async function migrateTenant(tenant) {
    const hourlyTable = `agent_complete_hourly_${tenant}`;
    const activityTable = `agent_activity_${tenant}`;
    const changes = [];

    if (!(await tableExists(hourlyTable))) {
        console.log(`   ⏭️  ${hourlyTable} does not exist — skipping tenant "${tenant}"`);
        return { skipped: true, changes };
    }

    // 1a. available_time
    if (await columnExists(hourlyTable, 'available_time')) {
        console.log(`   ✓ ${hourlyTable}.available_time already present`);
    } else {
        await pool.query(`
            ALTER TABLE \`${hourlyTable}\`
            ADD COLUMN available_time VARCHAR(20) NOT NULL DEFAULT '00:00:00'
            COMMENT 'Registered time minus not available time'
            AFTER login_time
        `);
        changes.push(`${hourlyTable}.available_time added`);
        console.log(`   ➕ ${hourlyTable}.available_time added`);
    }

    // 1b. per-tenant custom state columns
    const { all: allStates } = tenantStates(tenant);
    for (const state of allStates) {
        const column = stateColumnName(state);
        if (await columnExists(hourlyTable, column)) continue;
        await pool.query(`
            ALTER TABLE \`${hourlyTable}\`
            ADD COLUMN \`${column}\` VARCHAR(20) DEFAULT '00:00:00'
            COMMENT ${pool.escape(`Custom State - ${state} duration`)}
        `);
        changes.push(`${hourlyTable}.${column} added`);
        console.log(`   ➕ ${hourlyTable}.${column} added (state "${state}")`);
    }

    // 1c. widen the activity uniqueness key
    if (await tableExists(activityTable)) {
        const current = await indexColumns(activityTable, 'unique_agent_activity');
        if (current.join(',') === ACTIVITY_UNIQUE_KEY.join(',')) {
            console.log(`   ✓ ${activityTable}.unique_agent_activity already widened`);
        } else {
            if (current.length > 0) {
                await pool.query(`ALTER TABLE \`${activityTable}\` DROP INDEX unique_agent_activity`);
            }
            await pool.query(`
                ALTER TABLE \`${activityTable}\`
                ADD UNIQUE KEY unique_agent_activity (${ACTIVITY_UNIQUE_KEY.join(', ')})
            `);
            changes.push(`${activityTable}.unique_agent_activity widened`);
            console.log(`   ➕ ${activityTable}.unique_agent_activity widened to (${ACTIVITY_UNIQUE_KEY.join(', ')})`);
        }
    } else {
        console.log(`   ⏭️  ${activityTable} does not exist — index not migrated`);
    }

    return { skipped: false, changes };
}

// ---------------------------------------------------------------------------
// Step 2: backfill
// ---------------------------------------------------------------------------

function buildCustomStateValues(detailedReport, tenant) {
    const { all: allStates, productive, nonProductive } = tenantStates(tenant);

    // Column name -> seconds, seeded at zero so a state that disappeared from a
    // slot is reset instead of keeping a stale duration.
    const columns = Object.fromEntries(allStates.map(state => [stateColumnName(state), 0]));

    // Match API state names case-insensitively; deployments report "lunch",
    // "Lunch" and "LUNCH" for the same configured state.
    const byNormalized = new Map(allStates.map(state => [state.toLowerCase(), state]));

    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;

    for (const [rawState, rawDuration] of Object.entries(detailedReport || {})) {
        const duration = Math.max(0, Number(rawDuration) || 0);
        if (duration <= 0) continue;

        const configured = byNormalized.get(String(rawState).toLowerCase());
        if (configured) {
            columns[stateColumnName(configured)] += duration;
            if (productive.has(configured)) productiveSeconds += duration;
            if (nonProductive.has(configured)) nonProductiveSeconds += duration;
        }
    }

    return {
        columns,
        productiveSeconds,
        nonProductiveSeconds,
        text: Object.entries(detailedReport || {})
            .filter(([, duration]) => Number(duration) > 0)
            .map(([state, duration]) => `[${state} : ${Math.floor(Number(duration))}]`)
            .join(', ') || null
    };
}

async function assertActivityEventIndex(activityTable) {
    const columns = await indexColumns(activityTable, 'unique_agent_activity');
    if (columns.join(',') !== ACTIVITY_UNIQUE_KEY.join(',')) {
        throw new Error(
            `${activityTable} unique index is incompatible (${columns.join(', ') || 'missing'}). ` +
            `Expected: ${ACTIVITY_UNIQUE_KEY.join(', ')}. Run with --migrate-only first.`
        );
    }
}

async function backfillTenant(tenant, startTimestamp, endExclusiveTimestamp) {
    const hourlyTable = `agent_complete_hourly_${tenant}`;
    const statsTable = `agent_stats_${tenant}`;
    const activityTable = `agent_activity_${tenant}`;

    if (!(await tableExists(hourlyTable))) {
        console.log(`   ⏭️  ${hourlyTable} does not exist — skipping tenant "${tenant}"`);
        return null;
    }

    await assertActivityEventIndex(activityTable);

    const { all: allStates } = tenantStates(tenant);
    const stateColumns = allStates.map(stateColumnName);

    const [rows] = await pool.execute(`
        SELECT
            hourly.id,
            hourly.agent_extension,
            hourly.start_time,
            hourly.end_time,
            stats.raw_data
        FROM \`${hourlyTable}\` AS hourly
        INNER JOIN \`${statsTable}\` AS stats
            ON stats.agent_extension = hourly.agent_extension
           AND stats.start_time = hourly.start_time
           AND stats.end_time = hourly.end_time
        WHERE hourly.start_time >= ?
          AND hourly.start_time < ?
        ORDER BY hourly.start_time, hourly.agent_extension
    `, [startTimestamp, endExclusiveTimestamp]);

    // Events are loaded for the whole range, not per slot: a state that begins
    // in one hour and ends in the next can only be clipped correctly when the
    // surrounding transitions are visible.
    const [activityRows] = await pool.execute(`
        SELECT event_timestamp, raw_data, event_type, event_state
        FROM \`${activityTable}\`
        WHERE event_timestamp >= ?
          AND event_timestamp < ?
        ORDER BY event_timestamp, id
    `, [startTimestamp, endExclusiveTimestamp]);

    const eventsByExtension = new Map();
    for (const activity of activityRows) {
        let raw;
        try {
            raw = typeof activity.raw_data === 'string' ? JSON.parse(activity.raw_data) : activity.raw_data;
        } catch {
            continue;
        }
        const extension = String(raw?.ext ?? raw?.extension ?? '');
        if (!extension) continue;
        if (!eventsByExtension.has(extension)) eventsByExtension.set(extension, []);
        eventsByExtension.get(extension).push({
            ...raw,
            event: activity.event_type || raw?.event,
            state: activity.event_state || raw?.state,
            Timestamp: activity.event_timestamp
        });
    }

    const assignments = [
        'login_time = ?', 'available_time = ?', 'idle_time = ?', 'wrap_up_time = ?',
        'hold_time = ?', 'on_call_time = ?', 'not_available_time = ?', 'custom_states = ?',
        'productive_break_time = ?', 'non_productive_break_time = ?',
        ...stateColumns.map(column => `\`${column}\` = ?`)
    ];
    const updateSql = `UPDATE \`${hourlyTable}\` SET ${assignments.join(', ')} WHERE id = ?`;

    const connection = await pool.getConnection();
    let changedRows = 0;
    let timelineRows = 0;
    let fallbackRows = 0;
    let normalizedFallbackRows = 0;
    let trimmedOverlapSeconds = 0;

    try {
        await connection.beginTransaction();
        for (const row of rows) {
            let rawStats;
            try {
                rawStats = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
            } catch {
                continue;
            }

            const extension = String(row.agent_extension);
            const slotEvents = eventsByExtension.get(extension) || [];
            const reconciled = reconcileTrailingAgentState(
                { ...rawStats, extension },
                slotEvents,
                row.start_time,
                row.end_time
            );

            const registered = Number(reconciled.registered_time) || 0;
            const notAvailable = Number(reconciled.not_available_time) || 0;
            const custom = buildCustomStateValues(reconciled.not_available_detailed_report, tenant);

            if (reconciled._state_reconciliation_source === 'event_timeline') {
                timelineRows += 1;
            } else {
                fallbackRows += 1;
                const trimmed = Number(reconciled._state_overlap_trimmed_seconds) || 0;
                if (trimmed > 0) normalizedFallbackRows += 1;
                trimmedOverlapSeconds += trimmed;
            }

            const [result] = await connection.execute(updateSql, [
                formatSeconds(registered),
                formatSeconds(Math.max(0, registered - notAvailable)),
                formatSeconds(reconciled.idle_time),
                formatSeconds(reconciled.wrap_up_time),
                formatSeconds(reconciled.hold_time),
                formatSeconds(reconciled.on_call_time),
                formatSeconds(notAvailable),
                custom.text,
                formatSeconds(custom.productiveSeconds),
                formatSeconds(custom.nonProductiveSeconds),
                ...stateColumns.map(column => formatSeconds(custom.columns[column])),
                row.id
            ]);
            changedRows += result.changedRows || 0;
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    const [summary] = await pool.execute(`
        SELECT COUNT(*) AS rows_in_range
        FROM \`${hourlyTable}\`
        WHERE start_time >= ? AND start_time < ?
    `, [startTimestamp, endExclusiveTimestamp]);

    // Two invariants the reconciliation is supposed to guarantee. A non-zero
    // count here means the data is still inconsistent and worth investigating.
    const [quality] = await pool.execute(`
        SELECT
            SUM(
                TIME_TO_SEC(idle_time) + TIME_TO_SEC(wrap_up_time) +
                TIME_TO_SEC(hold_time) + TIME_TO_SEC(on_call_time) >
                TIME_TO_SEC(available_time)
            ) AS available_state_overlaps,
            SUM(
                ABS(
                    TIME_TO_SEC(login_time) - TIME_TO_SEC(available_time) -
                    TIME_TO_SEC(not_available_time)
                ) > 1
            ) AS registration_mismatches
        FROM \`${hourlyTable}\`
        WHERE start_time >= ? AND start_time < ?
    `, [startTimestamp, endExclusiveTimestamp]);

    return {
        processed: rows.length,
        changedRows,
        timelineRows,
        fallbackRows,
        normalizedFallbackRows,
        trimmedOverlapSeconds,
        activityEvents: activityRows.length,
        rowsInRange: Number(summary[0].rows_in_range) || 0,
        availableStateOverlaps: Number(quality[0].available_state_overlaps) || 0,
        registrationMismatches: Number(quality[0].registration_mismatches) || 0
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    const flags = argv.filter(arg => arg.startsWith('--'));
    const positional = argv.filter(arg => !arg.startsWith('--'));

    const migrateOnly = flags.includes('--migrate-only');
    const skipMigrate = flags.includes('--skip-migrate');
    const tenantFlag = flags.find(flag => flag.startsWith('--tenant='));
    const requestedTenant = tenantFlag ? tenantFlag.split('=')[1] : null;

    const unknownFlags = flags.filter(flag =>
        !['--migrate-only', '--skip-migrate'].includes(flag) && !flag.startsWith('--tenant=')
    );
    if (unknownFlags.length > 0) {
        console.error(`Unknown option(s): ${unknownFlags.join(', ')}`);
        usage();
        process.exitCode = 1;
        return;
    }

    if (migrateOnly && skipMigrate) {
        console.error('--migrate-only and --skip-migrate are mutually exclusive.');
        process.exitCode = 1;
        return;
    }

    if (!migrateOnly && positional.length !== 2) {
        usage();
        process.exitCode = 1;
        return;
    }

    if (requestedTenant && !TENANT_CONFIG[requestedTenant]) {
        console.error(`Unknown tenant "${requestedTenant}". Available: ${getAllTenants().join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const tenants = requestedTenant ? [requestedTenant] : getAllTenants();

    let startTimestamp = null;
    let endExclusiveTimestamp = null;
    if (!migrateOnly) {
        startTimestamp = parseDate(positional[0]);
        endExclusiveTimestamp = parseDate(positional[1], true);
        if (startTimestamp >= endExclusiveTimestamp) {
            throw new Error('The end date must be on or after the start date.');
        }
    }

    console.log(`\n🏢 Tenants: ${tenants.join(', ')}`);

    if (!skipMigrate) {
        console.log('\n🛠️  STEP 1: Applying schema updates...');
        for (const tenant of tenants) {
            console.log(`\n   → ${tenant}`);
            const { changes } = await migrateTenant(tenant);
            if (changes.length === 0) console.log('   ✓ Already up to date');
        }
        console.log('\n✅ Schema updates complete.');
    } else {
        console.log('\n⏭️  STEP 1 skipped (--skip-migrate)');
    }

    if (migrateOnly) {
        console.log('\n✅ Done (--migrate-only): no rows were backfilled.');
        return;
    }

    console.log(`\n🔄 STEP 2: Backfilling ${positional[0]} 12:00 AM through ${positional[1]} 11:59 PM (IST)...`);

    for (const tenant of tenants) {
        console.log(`\n   → ${tenant}`);
        const stats = await backfillTenant(tenant, startTimestamp, endExclusiveTimestamp);
        if (!stats) continue;

        console.log(`      Rows processed: ${stats.processed}`);
        console.log(`      Rows changed: ${stats.changedRows}`);
        console.log(`      Rows calculated from clipped event timelines: ${stats.timelineRows}`);
        console.log(`      Rows using stats fallback (insufficient/no events): ${stats.fallbackRows}`);
        console.log(`      Fallback rows normalized to Available Time: ${stats.normalizedFallbackRows}`);
        console.log(`      Overlapping fallback seconds removed: ${stats.trimmedOverlapSeconds}`);
        console.log(`      Activity events considered: ${stats.activityEvents}`);
        console.log(`      Report rows in range: ${stats.rowsInRange}`);
        console.log(`      Rows where available-state total exceeds Available Time: ${stats.availableStateOverlaps}`);
        console.log(`      Rows where Available + Not Available differs from Login Time: ${stats.registrationMismatches}`);
    }

    console.log('\n✅ Backfill complete.');
}

main()
    .catch(error => {
        console.error(`\n❌ Failed to update records: ${error.message || error.sqlMessage || String(error)}`);
        if (error.code) console.error(`   Database error code: ${error.code}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end().catch(() => {});
    });
