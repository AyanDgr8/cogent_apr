// Database configuration
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
    port: process.env.DB_PORT || 3306,
    // Read/write MySQL DATETIME values consistently as Indian Standard Time.
    timezone: '+05:30',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Create connection pool
export const pool = mysql.createPool(dbConfig);

// MySQL functions such as NOW() and TIMESTAMP conversions use the session
// timezone. Apply IST to every physical connection created by the pool.
pool.on('connection', connection => {
    connection.query("SET time_zone = '+05:30'", error => {
        if (error) console.error('❌ Failed to set MySQL session timezone to IST:', error.message);
    });
});

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
export async function insertAgentStats(agentName, agentTags, rawData, startTime, endTime, timeSlotLabel, tenant) {
    // Extract extension from rawData
    const extension = rawData.extension || 'unknown';
    
    // Use tenant-specific table name
    const tableName = tenant ? `agent_stats_${tenant}` : 'agent_stats';
    
    const query = `
        INSERT INTO ${tableName} (agent_name, agent_extension, agent_tags, raw_data, start_time, end_time, time_slot_label)
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
export async function insertAgentActivity(agentName, eventTimestamp, rawData, timeSlotStart, timeSlotEnd, timeSlotLabel, eventType = null, eventState = null, tenant) {
    // Use tenant-specific table name
    const tableName = tenant ? `agent_activity_${tenant}` : 'agent_activity';
    
    const query = `
        INSERT INTO ${tableName} (agent_name, event_timestamp, raw_data, time_slot_start, time_slot_end, time_slot_label, event_type, event_state)
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
export async function insertAgentCompleteHourly(reportData, tenant) {
    // Use tenant-specific table name
    const tableName = tenant ? `agent_complete_hourly_${tenant}` : 'agent_complete_hourly';
    
    // Get tenant config to extract custom states dynamically
    const { TENANT_CONFIG } = await import('../tenantConfig.js');
    const tenantConfig = TENANT_CONFIG[tenant];
    const allStates = [
        ...(tenantConfig?.productive_states || []),
        ...(tenantConfig?.non_productive_states || [])
    ];
    
    // Generate custom state column names and values dynamically
    const customStateColumns = allStates.map(state => {
        const columnName = `custom_state_${state.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        return columnName;
    });
    
    const customStateValues = allStates.map(state => {
        const columnName = `custom_state_${state.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        return reportData[columnName] || '00:00:00';
    });
    
    // Build column list
    const baseColumns = [
        'agent_name', 'agent_extension', 'start_time', 'end_time', 'time_slot_label',
        'slot_start_datetime', 'slot_end_datetime', 'total_calls', 'answered_calls', 'failed_calls',
        'answer_rate_percent', 'aht', 'login_time', 'first_login_time', 'last_logout_time',
        'not_available_time', 'wrap_up_time', 'hold_time', 'on_call_time', 'custom_states',
        'productive_break_time', 'non_productive_break_time', 'idle_time',
        'report_start_time', 'report_end_time'
    ];
    
    const allColumns = [...baseColumns, ...customStateColumns];
    const placeholders = allColumns.map(() => '?').join(', ');
    
    // Build UPDATE clause for custom states
    const customStateUpdates = customStateColumns.map(col => 
        `${col} = IFNULL(VALUES(${col}), ${col})`
    ).join(',\n    ');
    
    const query = `
INSERT INTO ${tableName} (
    ${allColumns.join(', ')}
)
VALUES (${placeholders})
ON DUPLICATE KEY UPDATE
    agent_name = VALUES(agent_name),
    time_slot_label = VALUES(time_slot_label),
    total_calls = VALUES(total_calls),
    answered_calls = VALUES(answered_calls),
    failed_calls = VALUES(failed_calls),
    answer_rate_percent = VALUES(answer_rate_percent),
    aht = IFNULL(VALUES(aht), aht),
    login_time = IFNULL(VALUES(login_time), login_time),
    first_login_time = IFNULL(VALUES(first_login_time), first_login_time),
    last_logout_time = IFNULL(VALUES(last_logout_time), last_logout_time),
    not_available_time = IFNULL(VALUES(not_available_time), not_available_time),
    wrap_up_time = IFNULL(VALUES(wrap_up_time), wrap_up_time),
    hold_time = IFNULL(VALUES(hold_time), hold_time),
    on_call_time = IFNULL(VALUES(on_call_time), on_call_time),
    custom_states = IF(VALUES(custom_states) != '', VALUES(custom_states), custom_states),
    productive_break_time = IFNULL(VALUES(productive_break_time), productive_break_time),
    non_productive_break_time = IFNULL(VALUES(non_productive_break_time), non_productive_break_time),
    idle_time = IFNULL(VALUES(idle_time), idle_time)${customStateUpdates ? ',\n    ' + customStateUpdates : ''}
`;
    
    // Build values array dynamically
    const baseValues = [
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
        reportData.firstLoginTime,
        reportData.lastLogoutTime,
        reportData.notAvailableTime,
        reportData.wrapUpTime,
        reportData.holdTime,
        reportData.onCallTime,
        reportData.customStates,
        reportData.productiveBreakTime || '00:00:00',
        reportData.nonProductiveBreakTime || '00:00:00',
        reportData.idleTime || '00:00:00',
        reportData.reportStartTime,
        reportData.reportEndTime
    ];
    
    const allValues = [...baseValues, ...customStateValues];
    
    return executeQuery(query, allValues);
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
export async function batchInsertAgentStats(agentStatsArray, tenant) {
    if (!agentStatsArray || agentStatsArray.length === 0) {
        return { affectedRows: 0 };
    }
    
    // Use tenant-specific table name
    const tableName = tenant ? `agent_stats_${tenant}` : 'agent_stats';
    
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
                item.timeSlotLabel,
                tenant
            );
            totalAffectedRows += result.affectedRows || 0;
        } catch (error) {
            console.error(`Failed to insert agent stats for ${item.agentName}:`, error.message);
        }
    }
    
    return { affectedRows: totalAffectedRows };
}

// Batch insert agent activities for multiple events
export async function batchInsertAgentActivities(activitiesArray, tenant) {
    if (!activitiesArray || activitiesArray.length === 0) {
        return { affectedRows: 0 };
    }
    
    // Use tenant-specific table name
    const tableName = tenant ? `agent_activity_${tenant}` : 'agent_activity';
    
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
                item.eventState,
                tenant
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
export async function getAllAgentStatsForTimeRange(startTime, endTime, tenant) {
    const tableName = tenant ? `agent_stats_${tenant}` : 'agent_stats';
    const query = `
        SELECT * FROM ${tableName} 
        WHERE start_time < ? AND end_time > ?
        ORDER BY agent_name, start_time
    `;
    return executeQuery(query, [endTime, startTime]);
}

// Get all agent activities for a time range (for final APR processing)
export async function getAllAgentActivitiesForTimeRange(startTime, endTime, tenant) {
    const tableName = tenant ? `agent_activity_${tenant}` : 'agent_activity';
    const query = `
        SELECT * FROM ${tableName} 
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
