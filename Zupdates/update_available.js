#!/usr/bin/env node

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { reconcileTrailingAgentState } from './agentEvents.js';

dotenv.config();

const DATE_PATTERN = /^(\d{2})-(\d{2})-(\d{4})$/;
const DUBAI_OFFSET_SECONDS = 4 * 60 * 60;

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

    // APR report slots are labelled in Asia/Dubai (UTC+04:00).
    const midnightUtc = Date.UTC(year, month - 1, day) / 1000 - DUBAI_OFFSET_SECONDS;
    return endOfDay ? midnightUtc + 24 * 60 * 60 : midnightUtc;
}

function usage() {
    console.error('Usage: node update_available.js DD-MM-YYYY DD-MM-YYYY');
    console.error('Example: node update_available.js 12-08-2026 12-08-2026');
}

function formatSeconds(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder].map(part => String(part).padStart(2, '0')).join(':');
}

const CUSTOM_STATE_COLUMNS = {
    'Short Break': 'custom_state_short_break',
    'Bio Break': 'custom_state_bio_break',
    'Lunch Break': 'custom_state_lunch_break',
    'Logoff': 'custom_state_logoff',
    'Log off': 'custom_state_logoff',
    'Meeting': 'custom_state_meeting',
    'training': 'custom_state_training',
    'Ticket_B2B': 'custom_state_ticket_b2b',
    'Ticket_B2C': 'custom_state_ticket_b2c',
    'Chat': 'custom_state_chat',
    'Log In': 'custom_state_log_in'
};

const PRODUCTIVE_STATES = new Set(['Meeting', 'training', 'Ticket_B2B', 'Ticket_B2C', 'Chat', 'Log In']);
const NON_PRODUCTIVE_STATES = new Set(['Short Break', 'Bio Break', 'Lunch Break']);

function buildCustomStateValues(detailedReport = {}) {
    const columns = Object.fromEntries(
        [...new Set(Object.values(CUSTOM_STATE_COLUMNS))].map(column => [column, 0])
    );
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;

    for (const [state, rawDuration] of Object.entries(detailedReport || {})) {
        const duration = Math.max(0, Number(rawDuration) || 0);
        const column = CUSTOM_STATE_COLUMNS[state];
        if (column) columns[column] += duration;
        if (PRODUCTIVE_STATES.has(state)) productiveSeconds += duration;
        if (NON_PRODUCTIVE_STATES.has(state)) nonProductiveSeconds += duration;
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

async function assertActivityEventIndex(connection) {
    const [indexes] = await connection.query(`
        SHOW INDEX FROM agent_activity WHERE Key_name = 'unique_agent_activity'
    `);
    const columns = indexes
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
        .map(index => index.Column_name);
    const expected = ['agent_name', 'event_timestamp', 'event_type', 'event_state'];
    if (columns.join(',') !== expected.join(',')) {
        throw new Error(
            `agent_activity unique index is incompatible (${columns.join(', ') || 'missing'}). ` +
            `Expected: ${expected.join(', ')}. Apply database/schema.sql before backfilling.`
        );
    }
}

async function main() {
    const [, , startDate, endDate] = process.argv;
    if (!startDate || !endDate || process.argv.length !== 4) {
        usage();
        process.exitCode = 1;
        return;
    }

    const startTimestamp = parseDate(startDate);
    const endExclusiveTimestamp = parseDate(endDate, true);
    if (startTimestamp >= endExclusiveTimestamp) {
        throw new Error('The end date must be on or after the start date.');
    }

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'agent_reports_spc',
        port: Number(process.env.DB_PORT || 3306)
    });

    try {
        await assertActivityEventIndex(connection);

        const [rows] = await connection.execute(`
            SELECT
                hourly.id,
                hourly.agent_extension,
                hourly.start_time,
                hourly.end_time,
                stats.raw_data
            FROM agent_complete_hourly AS hourly
            INNER JOIN agent_stats AS stats
                ON stats.agent_extension = hourly.agent_extension
               AND stats.start_time = hourly.start_time
               AND stats.end_time = hourly.end_time
            WHERE hourly.start_time >= ?
              AND hourly.start_time < ?
            ORDER BY hourly.start_time, hourly.agent_extension
        `, [startTimestamp, endExclusiveTimestamp]);

        const [activityRows] = await connection.execute(`
            SELECT event_timestamp, raw_data, event_type, event_state
            FROM agent_activity
            WHERE event_timestamp >= ?
              AND event_timestamp < ?
            ORDER BY event_timestamp, id
        `, [startTimestamp, endExclusiveTimestamp]);

        const eventsByExtension = new Map();
        for (const activity of activityRows) {
            const raw = typeof activity.raw_data === 'string'
                ? JSON.parse(activity.raw_data)
                : activity.raw_data;
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

        const updateSql = `
            UPDATE agent_complete_hourly SET
                login_time = ?, available_time = ?, idle_time = ?, wrap_up_time = ?, hold_time = ?,
                on_call_time = ?, not_available_time = ?, custom_states = ?,
                productive_break_time = ?, non_productive_break_time = ?,
                custom_state_short_break = ?, custom_state_bio_break = ?,
                custom_state_lunch_break = ?, custom_state_logoff = ?,
                custom_state_meeting = ?, custom_state_training = ?,
                custom_state_ticket_b2b = ?, custom_state_ticket_b2c = ?,
                custom_state_chat = ?, custom_state_log_in = ?
            WHERE id = ?
        `;

        await connection.beginTransaction();
        let changedRows = 0;
        let timelineRows = 0;
        let fallbackRows = 0;
        let normalizedFallbackRows = 0;
        let trimmedOverlapSeconds = 0;
        try {
            for (const row of rows) {
                const rawStats = typeof row.raw_data === 'string'
                    ? JSON.parse(row.raw_data)
                    : row.raw_data;
                const extension = String(row.agent_extension);
                // Preserve events from earlier slots so the state active at this
                // row's start boundary can be reconstructed and clipped.
                const slotEvents = eventsByExtension.get(extension) || [];
                const reconciled = reconcileTrailingAgentState(
                    { ...rawStats, extension },
                    slotEvents,
                    row.start_time,
                    row.end_time
                );
                const registered = Number(reconciled.registered_time) || 0;
                const notAvailable = Number(reconciled.not_available_time) || 0;
                const custom = buildCustomStateValues(reconciled.not_available_detailed_report);
                if (reconciled._state_reconciliation_source === 'event_timeline') timelineRows += 1;
                else {
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
                    formatSeconds(custom.columns.custom_state_short_break),
                    formatSeconds(custom.columns.custom_state_bio_break),
                    formatSeconds(custom.columns.custom_state_lunch_break),
                    formatSeconds(custom.columns.custom_state_logoff),
                    formatSeconds(custom.columns.custom_state_meeting),
                    formatSeconds(custom.columns.custom_state_training),
                    formatSeconds(custom.columns.custom_state_ticket_b2b),
                    formatSeconds(custom.columns.custom_state_ticket_b2c),
                    formatSeconds(custom.columns.custom_state_chat),
                    formatSeconds(custom.columns.custom_state_log_in),
                    row.id
                ]);
                changedRows += result.changedRows || 0;
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        }

        const [summary] = await connection.execute(`
            SELECT COUNT(*) AS rows_in_range
            FROM agent_complete_hourly
            WHERE start_time >= ? AND start_time < ?
        `, [startTimestamp, endExclusiveTimestamp]);

        console.log(`All state durations reconciled for ${startDate} 12:00 AM through ${endDate} 11:59 PM (Asia/Dubai).`);
        console.log(`Rows processed: ${rows.length}`);
        console.log(`Rows changed: ${changedRows}`);
        console.log(`Rows calculated from clipped event timelines: ${timelineRows}`);
        console.log(`Rows using stats fallback (insufficient/no events): ${fallbackRows}`);
        console.log(`Fallback rows normalized to Available Time: ${normalizedFallbackRows}`);
        console.log(`Overlapping fallback seconds removed: ${trimmedOverlapSeconds}`);
        console.log(`Activity events considered: ${activityRows.length}`);
        console.log(`Report rows in range: ${summary[0].rows_in_range}`);

        const [quality] = await connection.execute(`
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
            FROM agent_complete_hourly
            WHERE start_time >= ? AND start_time < ?
        `, [startTimestamp, endExclusiveTimestamp]);
        console.log(`Rows where available-state total exceeds Available Time: ${Number(quality[0].available_state_overlaps) || 0}`);
        console.log(`Rows where Available + Not Available differs from Login Time: ${Number(quality[0].registration_mismatches) || 0}`);
    } finally {
        await connection.end();
    }
}

main().catch((error) => {
    console.error(`Failed to reconcile hourly state durations: ${error.message || error.sqlMessage || String(error)}`);
    if (error.code) console.error(`Database error code: ${error.code}`);
    process.exitCode = 1;
});
