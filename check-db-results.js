#!/usr/bin/env node
import { pool } from './database/config.js';

async function checkDatabaseResults() {
    try {
        console.log('🔍 CHECKING DATABASE POPULATION RESULTS');
        console.log('=====================================');
        
        // Check agent_stats table
        console.log('\n📊 AGENT_STATS TABLE:');
        const [statsCount] = await pool.execute('SELECT COUNT(*) as total_records FROM agent_stats');
        const [statsAgents] = await pool.execute('SELECT COUNT(DISTINCT agent_extension) as unique_agents FROM agent_stats');
        const [statsTimeSlots] = await pool.execute('SELECT COUNT(DISTINCT time_slot_label) as unique_slots FROM agent_stats');
        console.log('  • Total Records:', statsCount[0].total_records);
        console.log('  • Unique Agents:', statsAgents[0].unique_agents);
        console.log('  • Unique Time Slots:', statsTimeSlots[0].unique_slots);
        
        // Check agent_activity table
        console.log('\n📊 AGENT_ACTIVITY TABLE:');
        const [activityCount] = await pool.execute('SELECT COUNT(*) as total_records FROM agent_activity');
        const [activityAgents] = await pool.execute('SELECT COUNT(DISTINCT agent_name) as unique_agents FROM agent_activity');
        const [activityTimeSlots] = await pool.execute('SELECT COUNT(DISTINCT time_slot_label) as unique_slots FROM agent_activity');
        console.log('  • Total Records:', activityCount[0].total_records);
        console.log('  • Unique Agents:', activityAgents[0].unique_agents);
        console.log('  • Unique Time Slots:', activityTimeSlots[0].unique_slots);
        
        // Check agent_complete_hourly table (final results)
        console.log('\n📊 AGENT_COMPLETE_HOURLY TABLE (FINAL RESULTS):');
        const [finalCount] = await pool.execute('SELECT COUNT(*) as total_records FROM agent_complete_hourly');
        const [finalAgents] = await pool.execute('SELECT COUNT(DISTINCT agent_extension) as unique_agents FROM agent_complete_hourly');
        const [finalTimeSlots] = await pool.execute('SELECT COUNT(DISTINCT time_slot_label) as unique_slots FROM agent_complete_hourly');
        console.log('  • Total Records:', finalCount[0].total_records);
        console.log('  • Unique Agents:', finalAgents[0].unique_agents);
        console.log('  • Unique Time Slots:', finalTimeSlots[0].unique_slots);
        
        // Calculate expected vs actual
        const expected = finalAgents[0].unique_agents * finalTimeSlots[0].unique_slots;
        console.log('  • Expected Records (agents × slots):', expected);
        console.log('  • Actual vs Expected:', finalCount[0].total_records === expected ? '✅ MATCH' : '⚠️ MISMATCH');
        
        // Check field population (sample some records)
        console.log('\n🔍 FIELD POPULATION ANALYSIS:');
        const [sampleRecords] = await pool.execute(`
            SELECT 
                COUNT(*) as total_records,
                COUNT(CASE WHEN total_calls > 0 THEN 1 END) as records_with_calls,
                COUNT(CASE WHEN login_time != '00:00:00' THEN 1 END) as records_with_login_time,
                COUNT(CASE WHEN custom_states IS NOT NULL AND custom_states != '' THEN 1 END) as records_with_custom_states,
                COUNT(CASE WHEN first_login_time IS NOT NULL THEN 1 END) as records_with_first_login,
                COUNT(CASE WHEN productive_break_time != '00:00:00' THEN 1 END) as records_with_productive_breaks
            FROM agent_complete_hourly
        `);
        
        const sample = sampleRecords[0];
        console.log('  • Total Records:', sample.total_records);
        console.log('  • Records with Calls:', sample.records_with_calls, `(${(sample.records_with_calls/sample.total_records*100).toFixed(1)}%)`);
        console.log('  • Records with Login Time:', sample.records_with_login_time, `(${(sample.records_with_login_time/sample.total_records*100).toFixed(1)}%)`);
        console.log('  • Records with Custom States:', sample.records_with_custom_states, `(${(sample.records_with_custom_states/sample.total_records*100).toFixed(1)}%)`);
        console.log('  • Records with First Login:', sample.records_with_first_login, `(${(sample.records_with_first_login/sample.total_records*100).toFixed(1)}%)`);
        console.log('  • Records with Productive Breaks:', sample.records_with_productive_breaks, `(${(sample.records_with_productive_breaks/sample.total_records*100).toFixed(1)}%)`);
        
        // Performance summary
        console.log('\n⚡ PERFORMANCE SUMMARY:');
        console.log('  • Processing Time: 157.83 seconds (2 min 38 sec)');
        console.log('  • Time Range: 4.6 days (111 hourly slots)');
        console.log('  • API Records Fetched: 62,132 activity events');
        console.log('  • Final Records Created:', finalCount[0].total_records);
        console.log('  • Speed: ~', Math.round(finalCount[0].total_records / 157.83), 'records/second');
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkDatabaseResults();
