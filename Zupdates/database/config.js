// Database configuration
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agent_reports',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true
};

// Create connection pool
export const pool = mysql.createPool(dbConfig);

// Test database connection
export async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
}

// Execute query with error handling
export async function executeQuery(query, params = []) {
    try {
        // Use query() for DDL statements, execute() for DML with parameters
        if (params.length === 0 && (
            query.toUpperCase().includes('CREATE') ||
            query.toUpperCase().includes('DROP') ||
            query.toUpperCase().includes('ALTER') ||
            query.toUpperCase().includes('SHOW') ||
            query.toUpperCase().includes('DESCRIBE')
        )) {
            const [results] = await pool.query(query);
            return results;
        } else {
            const [results] = await pool.execute(query, params);
            return results;
        }
    } catch (error) {
        console.error('❌ Query execution failed:', error.message);
        console.error('Query:', query);
        console.error('Params:', params);
        throw error;
    }
}

// Insert agent stats data with hourly time slot approach
export async function insertAgentStats(agentName, agentTags, rawData, startTime, endTime, timeSlotLabel) {
    // Extract extension from rawData
    const extension = rawData.extension || 'unknown';
    
    const query = `
        INSERT INTO agent_stats (agent_name, agent_extension, agent_tags, raw_data, start_time, end_time, time_slot_label)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        agent_name = VALUES(agent_name),
        agent_extension = VALUES(agent_extension),
        agent_tags = VALUES(agent_tags),
        raw_data = JSON_MERGE_PATCH(raw_data, VALUES(raw_data)),
        updated_at = CURRENT_TIMESTAMP
    `;
    
    return executeQuery(query, [
        agentName,
        extension,
        JSON.stringify(agentTags),
        JSON.stringify(rawData),
        startTime,
        endTime,
        timeSlotLabel
    ]);
}

// Insert agent activity data with time slot association
export async function insertAgentActivity(agentName, eventTimestamp, rawData, timeSlotStart, timeSlotEnd, timeSlotLabel, eventType = null, eventState = null) {
    const query = `
        INSERT INTO agent_activity (agent_name, event_timestamp, raw_data, time_slot_start, time_slot_end, time_slot_label, event_type, event_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        raw_data = JSON_MERGE_PATCH(raw_data, VALUES(raw_data)),
        time_slot_start = VALUES(time_slot_start),
        time_slot_end = VALUES(time_slot_end),
        time_slot_label = VALUES(time_slot_label),
        event_type = VALUES(event_type),
        event_state = VALUES(event_state)
    `;
    
    return executeQuery(query, [
        agentName,
        eventTimestamp,
        JSON.stringify(rawData),
        timeSlotStart,
        timeSlotEnd,
        timeSlotLabel,
        eventType,
        eventState
    ]);
}

// Insert agent complete hourly data with hourly time slots
export async function insertAgentCompleteHourly(reportData) {
    const query = `
        INSERT INTO agent_complete_hourly (
            agent_name, agent_extension, start_time, end_time, time_slot_label, 
            slot_start_datetime, slot_end_datetime, total_calls, answered_calls, failed_calls,
            answer_rate_percent, aht, login_time, available_time, first_login_time, last_logout_time, 
            not_available_time, wrap_up_time, hold_time, on_call_time, custom_states, 
            custom_state_short_break, custom_state_bio_break, custom_state_lunch_break, 
            custom_state_logoff, custom_state_meeting, custom_state_training, 
            custom_state_ticket_b2b, custom_state_ticket_b2c, custom_state_chat, custom_state_log_in,
            productive_break_time, non_productive_break_time, idle_time,
            report_start_time, report_end_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        agent_name = VALUES(agent_name),
        total_calls = CASE 
            WHEN VALUES(total_calls) > 0 OR total_calls = 0 THEN VALUES(total_calls)
            ELSE total_calls 
        END,
        answered_calls = CASE 
            WHEN VALUES(answered_calls) > 0 OR answered_calls = 0 THEN VALUES(answered_calls)
            ELSE answered_calls 
        END,
        failed_calls = CASE 
            WHEN VALUES(failed_calls) > 0 OR failed_calls = 0 THEN VALUES(failed_calls)
            ELSE failed_calls 
        END,
        answer_rate_percent = CASE 
            WHEN VALUES(answer_rate_percent) > 0 OR answer_rate_percent = 0 THEN VALUES(answer_rate_percent)
            ELSE answer_rate_percent 
        END,
        aht = CASE 
            WHEN VALUES(aht) != '00:00:00' OR aht = '00:00:00' THEN VALUES(aht)
            ELSE aht 
        END,
        login_time = CASE 
            WHEN VALUES(login_time) != '00:00:00' OR login_time = '00:00:00' THEN VALUES(login_time)
            ELSE login_time 
        END,
        available_time = VALUES(available_time),
        first_login_time = CASE 
            WHEN VALUES(first_login_time) IS NOT NULL THEN VALUES(first_login_time)
            ELSE first_login_time 
        END,
        last_logout_time = CASE 
            WHEN VALUES(last_logout_time) IS NOT NULL THEN VALUES(last_logout_time)
            ELSE last_logout_time 
        END,
        not_available_time = CASE 
            WHEN VALUES(not_available_time) != '00:00:00' OR not_available_time = '00:00:00' THEN VALUES(not_available_time)
            ELSE not_available_time 
        END,
        wrap_up_time = CASE 
            WHEN VALUES(wrap_up_time) != '00:00:00' OR wrap_up_time = '00:00:00' THEN VALUES(wrap_up_time)
            ELSE wrap_up_time 
        END,
        hold_time = CASE 
            WHEN VALUES(hold_time) != '00:00:00' OR hold_time = '00:00:00' THEN VALUES(hold_time)
            ELSE hold_time 
        END,
        on_call_time = CASE 
            WHEN VALUES(on_call_time) != '00:00:00' OR on_call_time = '00:00:00' THEN VALUES(on_call_time)
            ELSE on_call_time 
        END,
        custom_states = CASE 
            WHEN VALUES(custom_states) IS NOT NULL AND VALUES(custom_states) != '' THEN VALUES(custom_states)
            ELSE custom_states 
        END,
        productive_break_time = CASE 
            WHEN VALUES(productive_break_time) != '00:00:00' OR productive_break_time = '00:00:00' THEN VALUES(productive_break_time)
            ELSE productive_break_time 
        END,
        non_productive_break_time = CASE 
            WHEN VALUES(non_productive_break_time) != '00:00:00' OR non_productive_break_time = '00:00:00' THEN VALUES(non_productive_break_time)
            ELSE non_productive_break_time 
        END,
        idle_time = CASE 
            WHEN VALUES(idle_time) != '00:00:00' OR idle_time = '00:00:00' THEN VALUES(idle_time)
            ELSE idle_time 
        END,
        custom_state_short_break = CASE 
            WHEN VALUES(custom_state_short_break) != '00:00:00' OR custom_state_short_break = '00:00:00' THEN VALUES(custom_state_short_break)
            ELSE custom_state_short_break 
        END,
        custom_state_bio_break = CASE 
            WHEN VALUES(custom_state_bio_break) != '00:00:00' OR custom_state_bio_break = '00:00:00' THEN VALUES(custom_state_bio_break)
            ELSE custom_state_bio_break 
        END,
        custom_state_lunch_break = CASE 
            WHEN VALUES(custom_state_lunch_break) != '00:00:00' OR custom_state_lunch_break = '00:00:00' THEN VALUES(custom_state_lunch_break)
            ELSE custom_state_lunch_break 
        END,
        custom_state_logoff = CASE 
            WHEN VALUES(custom_state_logoff) != '00:00:00' OR custom_state_logoff = '00:00:00' THEN VALUES(custom_state_logoff)
            ELSE custom_state_logoff 
        END,
        custom_state_meeting = CASE 
            WHEN VALUES(custom_state_meeting) != '00:00:00' OR custom_state_meeting = '00:00:00' THEN VALUES(custom_state_meeting)
            ELSE custom_state_meeting 
        END,
        custom_state_training = CASE 
            WHEN VALUES(custom_state_training) != '00:00:00' OR custom_state_training = '00:00:00' THEN VALUES(custom_state_training)
            ELSE custom_state_training 
        END,
        custom_state_ticket_b2b = CASE 
            WHEN VALUES(custom_state_ticket_b2b) != '00:00:00' OR custom_state_ticket_b2b = '00:00:00' THEN VALUES(custom_state_ticket_b2b)
            ELSE custom_state_ticket_b2b 
        END,
        custom_state_ticket_b2c = CASE 
            WHEN VALUES(custom_state_ticket_b2c) != '00:00:00' OR custom_state_ticket_b2c = '00:00:00' THEN VALUES(custom_state_ticket_b2c)
            ELSE custom_state_ticket_b2c 
        END,
        custom_state_chat = CASE 
            WHEN VALUES(custom_state_chat) != '00:00:00' OR custom_state_chat = '00:00:00' THEN VALUES(custom_state_chat)
            ELSE custom_state_chat 
        END,
        custom_state_log_in = CASE 
            WHEN VALUES(custom_state_log_in) != '00:00:00' OR custom_state_log_in = '00:00:00' THEN VALUES(custom_state_log_in)
            ELSE custom_state_log_in 
        END
    `;
    
    return executeQuery(query, [
        reportData.agentName,
        reportData.agentExtension,
        reportData.startTime,
        reportData.endTime,
        reportData.timeSlotLabel,
        reportData.slotStartDatetime || null,
        reportData.slotEndDatetime || null,
        reportData.totalCalls,
        reportData.answeredCalls,
        reportData.failedCalls,
        reportData.answerRatePercent || 0,
        reportData.aht,
        reportData.loginTime,
        reportData.availableTime || '00:00:00',
        reportData.firstLoginTime,
        reportData.lastLogoutTime,
        reportData.notAvailableTime,
        reportData.wrapUpTime,
        reportData.holdTime,
        reportData.onCallTime,
        reportData.customStates,
        reportData.customStateShortBreak || '00:00:00',
        reportData.customStateBioBreak || '00:00:00',
        reportData.customStateLunchBreak || '00:00:00',
        reportData.customStateLogoff || '00:00:00',
        reportData.customStateMeeting || '00:00:00',
        reportData.customStateTraining || '00:00:00',
        reportData.customStateTicketB2B || '00:00:00',
        reportData.customStateTicketB2C || '00:00:00',
        reportData.customStateChat || '00:00:00',
        reportData.customStateLogIn || '00:00:00',
        reportData.productiveBreakTime || '00:00:00',
        reportData.nonProductiveBreakTime || '00:00:00',
        reportData.idleTime || '00:00:00',
        reportData.reportStartTime,
        reportData.reportEndTime
    ]);
}

// Clear tables for fresh data
export async function clearTables() {
    try {
        await executeQuery('DELETE FROM agent_complete_hourly');
        await executeQuery('DELETE FROM agent_activity');
        await executeQuery('DELETE FROM agent_stats');
        console.log('✅ All tables cleared successfully');
    } catch (error) {
        console.error('❌ Failed to clear tables:', error.message);
        throw error;
    }
}

// Get agent stats by extension
export async function getAgentStats(agentExtension) {
    const query = 'SELECT * FROM agent_stats WHERE agent_extension = ?';
    return executeQuery(query, [agentExtension]);
}

// Get agent activities by extension and time range
export async function getAgentActivities(agentExtension, startTime, endTime) {
    const query = `
        SELECT * FROM agent_activity 
        WHERE agent_extension = ? 
        AND event_timestamp BETWEEN ? AND ?
        ORDER BY event_timestamp
    `;
    return executeQuery(query, [agentExtension, startTime, endTime]);
}

// Get agent complete hourly data by time range
export async function getAgentCompleteHourly(startTime, endTime) {
    const query = `
        SELECT * FROM agent_complete_hourly 
        WHERE start_time >= ? AND end_time <= ?
        ORDER BY agent_name, start_time
    `;
    return executeQuery(query, [startTime, endTime]);
}

// Batch insert agent stats for multiple time slots
export async function batchInsertAgentStats(agentStatsArray) {
    if (!agentStatsArray || agentStatsArray.length === 0) {
        return { affectedRows: 0 };
    }
    
    // For batch inserts with ON DUPLICATE KEY UPDATE, we need to insert one by one
    // or use a different approach. Let's use individual inserts for now.
    let totalAffectedRows = 0;
    
    for (const item of agentStatsArray) {
        try {
            const result = await insertAgentStats(
                item.agentName,
                item.agentTags,
                item.rawData,
                item.startTime,
                item.endTime,
                item.timeSlotLabel
            );
            totalAffectedRows += result.affectedRows || 0;
        } catch (error) {
            console.error(`Failed to insert agent stats for ${item.agentName}:`, error.message);
        }
    }
    
    return { affectedRows: totalAffectedRows };
}

// Batch insert agent activities for multiple events
export async function batchInsertAgentActivities(activitiesArray) {
    if (!activitiesArray || activitiesArray.length === 0) {
        return { affectedRows: 0 };
    }
    
    // Use individual inserts for better error handling
    let totalAffectedRows = 0;
    
    for (const item of activitiesArray) {
        try {
            const result = await insertAgentActivity(
                item.agentName,
                item.eventTimestamp,
                item.rawData,
                item.timeSlotStart,
                item.timeSlotEnd,
                item.timeSlotLabel,
                item.eventType,
                item.eventState
            );
            totalAffectedRows += result.affectedRows || 0;
        } catch (error) {
            console.error(`Failed to insert agent activity for ${item.agentName}:`, error.message);
        }
    }
    
    return { affectedRows: totalAffectedRows };
}

// Get agent stats for a specific time slot
export async function getAgentStatsForTimeSlot(startTime, endTime) {
    const query = `
        SELECT * FROM agent_stats 
        WHERE start_time = ? AND end_time = ?
        ORDER BY agent_name
    `;
    return executeQuery(query, [startTime, endTime]);
}

// Get agent activities for a specific time slot
export async function getAgentActivitiesForTimeSlot(startTime, endTime) {
    const query = `
        SELECT * FROM agent_activity 
        WHERE time_slot_start = ? AND time_slot_end = ?
        ORDER BY agent_name, event_timestamp
    `;
    return executeQuery(query, [startTime, endTime]);
}

// Extract event details from raw data
export function extractEventDetails(rawData) {
    try {
        const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        
        return {
            eventType: data.event || data.eventType || data.type || null,
            eventState: data.state || data.status || data.agentState || null
        };
    } catch (error) {
        console.warn('Failed to extract event details from raw data:', error.message);
        return {
            eventType: null,
            eventState: null
        };
    }
}

// Get all agent stats data for a time range (for final APR processing)
export async function getAllAgentStatsForTimeRange(startTime, endTime) {
    const query = `
        SELECT * FROM agent_stats 
        WHERE start_time < ? AND end_time > ?
        ORDER BY agent_name, start_time
    `;
    return executeQuery(query, [endTime, startTime]);
}

// Get all agent activities for a time range (for final APR processing)
export async function getAllAgentActivitiesForTimeRange(startTime, endTime) {
    const query = `
        SELECT * FROM agent_activity 
        WHERE time_slot_start < ? AND time_slot_end > ?
        ORDER BY agent_name, event_timestamp
    `;
    return executeQuery(query, [endTime, startTime]);
}

// Convert database agent stats to API format for compatibility
export function convertDbStatsToApiFormat(dbStatsRows) {
    const apiFormat = {};
    
    for (const row of dbStatsRows) {
        try {
            const rawData = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
            const extension = row.agent_extension || 'unknown';  // Use dedicated column instead of raw_data
            
            apiFormat[extension] = {
                ...rawData,
                name: row.agent_name,
                tags: typeof row.agent_tags === 'string' ? JSON.parse(row.agent_tags) : row.agent_tags,
                extension: extension  // Ensure extension is explicitly set
            };
        } catch (error) {
            console.warn(`Failed to convert stats for ${row.agent_name}:`, error.message);
        }
    }
    
    return apiFormat;
}

// Convert database agent activities to API format for compatibility
export function convertDbActivitiesToApiFormat(dbActivityRows) {
    return dbActivityRows.map(row => {
        try {
            const rawData = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
            return {
                ...rawData,
                Timestamp: row.event_timestamp,
                name: row.agent_name,
                username: row.agent_name,
                event: row.event_type,
                state: row.event_state
            };
        } catch (error) {
            console.warn(`Failed to convert activity for ${row.agent_name}:`, error.message);
            return {
                Timestamp: row.event_timestamp,
                name: row.agent_name,
                username: row.agent_name,
                event: row.event_type || 'unknown',
                state: row.event_state || 'unknown'
            };
        }
    });
}

export default {
    pool,
    testConnection,
    executeQuery,
    insertAgentStats,
    insertAgentActivity,
    insertAgentCompleteHourly,
    clearTables,
    getAgentStats,
    getAgentActivities,
    getAgentCompleteHourly,
    batchInsertAgentStats,
    batchInsertAgentActivities,
    getAgentStatsForTimeSlot,
    getAgentActivitiesForTimeSlot,
    getAllAgentStatsForTimeRange,
    getAllAgentActivitiesForTimeRange,
    convertDbStatsToApiFormat,
    convertDbActivitiesToApiFormat,
    extractEventDetails
};
