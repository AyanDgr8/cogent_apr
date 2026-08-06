// Database query utilities for agent reporting system

import { executeQuery, pool } from './config.js';

/**
 * Get agent statistics summary
 */
export async function getAgentStatsSummary() {
    const query = `
        SELECT 
            COUNT(*) as total_agents,
            COUNT(CASE WHEN JSON_EXTRACT(raw_data, '$.total_calls') > 0 THEN 1 END) as active_agents,
            SUM(JSON_EXTRACT(raw_data, '$.total_calls')) as total_calls,
            SUM(JSON_EXTRACT(raw_data, '$.answered_calls')) as total_answered,
            AVG(JSON_EXTRACT(raw_data, '$.total_calls')) as avg_calls_per_agent
        FROM agent_stats
    `;
    return executeQuery(query);
}

/**
 * Get top performing agents by calls
 */
export async function getTopAgentsByCalls(limit = 10) {
    const query = `
        SELECT 
            agent_name,
            agent_extension,
            JSON_EXTRACT(raw_data, '$.total_calls') as total_calls,
            JSON_EXTRACT(raw_data, '$.answered_calls') as answered_calls,
            ROUND(
                (JSON_EXTRACT(raw_data, '$.answered_calls') / 
                 NULLIF(JSON_EXTRACT(raw_data, '$.total_calls'), 0)) * 100, 2
            ) as answer_rate_percent
        FROM agent_stats
        WHERE JSON_EXTRACT(raw_data, '$.total_calls') > 0
        ORDER BY JSON_EXTRACT(raw_data, '$.total_calls') DESC
        LIMIT ?
    `;
    return executeQuery(query, [limit]);
}

/**
 * Get agent activity summary by event type
 */
export async function getActivitySummaryByEvent() {
    const query = `
        SELECT 
            JSON_EXTRACT(raw_data, '$.event') as event_type,
            COUNT(*) as event_count,
            COUNT(DISTINCT agent_extension) as unique_agents
        FROM agent_activity
        GROUP BY JSON_EXTRACT(raw_data, '$.event')
        ORDER BY event_count DESC
    `;
    return executeQuery(query);
}

/**
 * Get custom states usage
 */
export async function getCustomStatesUsage() {
    const query = `
        SELECT 
            JSON_EXTRACT(raw_data, '$.state') as custom_state,
            COUNT(*) as usage_count,
            COUNT(DISTINCT agent_extension) as unique_agents
        FROM agent_activity
        WHERE JSON_EXTRACT(raw_data, '$.event') = 'agent_not_avail_state'
        AND JSON_EXTRACT(raw_data, '$.state') NOT IN ('none', 'available')
        AND JSON_EXTRACT(raw_data, '$.enabled') = true
        GROUP BY JSON_EXTRACT(raw_data, '$.state')
        ORDER BY usage_count DESC
    `;
    return executeQuery(query);
}

/**
 * Get final APR summary
 */
export async function getFinalAPRSummary() {
    const query = `
        SELECT 
            COUNT(DISTINCT agent_extension) as total_agents,
            COUNT(DISTINCT time_slot) as total_time_slots,
            COUNT(*) as total_records,
            SUM(total_calls) as total_calls,
            SUM(answered_calls) as total_answered,
            SUM(failed_calls) as total_failed,
            ROUND(AVG(total_calls), 2) as avg_calls_per_slot
        FROM final_apr
    `;
    return executeQuery(query);
}

/**
 * Get agent performance by time slot
 */
export async function getAgentPerformanceByTimeSlot(agentExtension) {
    const query = `
        SELECT 
            time_slot,
            total_calls,
            answered_calls,
            failed_calls,
            aht,
            custom_states,
            created_at
        FROM final_apr
        WHERE agent_extension = ?
        ORDER BY time_slot
    `;
    return executeQuery(query, [agentExtension]);
}

/**
 * Get busiest time slots
 */
export async function getBusiestTimeSlots(limit = 10) {
    const query = `
        SELECT 
            time_slot,
            SUM(total_calls) as total_calls,
            COUNT(DISTINCT agent_extension) as active_agents,
            ROUND(AVG(total_calls), 2) as avg_calls_per_agent
        FROM final_apr
        GROUP BY time_slot
        ORDER BY total_calls DESC
        LIMIT ?
    `;
    return executeQuery(query, [limit]);
}

/**
 * Get agent login/logout patterns
 */
export async function getLoginLogoutPatterns() {
    const query = `
        SELECT 
            agent_name,
            agent_extension,
            COUNT(DISTINCT time_slot) as active_slots,
            MIN(first_login_time) as earliest_login,
            MAX(last_logout_time) as latest_logout,
            SUM(total_calls) as total_calls
        FROM final_apr
        WHERE first_login_time IS NOT NULL OR last_logout_time IS NOT NULL
        GROUP BY agent_name, agent_extension
        ORDER BY total_calls DESC
    `;
    return executeQuery(query);
}

/**
 * Search agents by name or extension
 */
export async function searchAgents(searchTerm) {
    const query = `
        SELECT DISTINCT
            agent_name,
            agent_extension,
            JSON_EXTRACT(s.raw_data, '$.total_calls') as total_calls,
            JSON_EXTRACT(s.raw_data, '$.answered_calls') as answered_calls
        FROM final_apr f
        LEFT JOIN agent_stats s ON f.agent_extension = s.agent_extension
        WHERE f.agent_name LIKE ? OR f.agent_extension LIKE ?
        ORDER BY agent_name
    `;
    const searchPattern = `%${searchTerm}%`;
    return executeQuery(query, [searchPattern, searchPattern]);
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
    const queries = [
        'SELECT COUNT(*) as count, "agent_stats" as table_name FROM agent_stats',
        'SELECT COUNT(*) as count, "agent_activity" as table_name FROM agent_activity',
        'SELECT COUNT(*) as count, "final_apr" as table_name FROM final_apr'
    ];
    
    const results = [];
    for (const query of queries) {
        const result = await executeQuery(query);
        results.push(result[0]);
    }
    
    return results;
}

/**
 * Clean old data (older than specified days)
 */
export async function cleanOldData(daysOld = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    const queries = [
        'DELETE FROM final_apr WHERE created_at < ?',
        'DELETE FROM agent_activity WHERE created_at < ?',
        'DELETE FROM agent_stats WHERE updated_at < ?'
    ];
    
    const results = [];
    for (const query of queries) {
        const result = await executeQuery(query, [cutoffDate]);
        results.push(result);
    }
    
    return results;
}

export default {
    getAgentStatsSummary,
    getTopAgentsByCalls,
    getActivitySummaryByEvent,
    getCustomStatesUsage,
    getFinalAPRSummary,
    getAgentPerformanceByTimeSlot,
    getBusiestTimeSlots,
    getLoginLogoutPatterns,
    searchAgents,
    getDatabaseStats,
    cleanOldData
};
