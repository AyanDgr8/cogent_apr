#!/usr/bin/env node
// check-test-multycomm.js
// Check database data for Test MultyComm in specific time slot

import dotenv from 'dotenv';
import { pool } from './database/config.js';

dotenv.config();

async function checkTestMultyCommData() {
    const agentName = 'Test MultyComm';

    console.log('🔍 CHECKING LATEST DATA FOR:', agentName);
    console.log('');

    try {
        // First, check the latest records in agent_complete_hourly for Test MultyComm
        console.log('🎯 LATEST RECORDS IN AGENT_COMPLETE_HOURLY TABLE:');
        const [latestRecords] = await pool.execute(
            'SELECT * FROM agent_complete_hourly WHERE agent_name = ? ORDER BY created_at DESC LIMIT 5',
            [agentName]
        );
        
        if (latestRecords.length > 0) {
            console.log('✅ Found', latestRecords.length, 'latest record(s)');
            latestRecords.forEach((row, index) => {
                console.log(`   Record ${index + 1}:`);
                console.log('     - Time Slot:', row.time_slot_label);
                console.log('     - Agent Extension:', row.agent_extension);
                console.log('     - Total Calls:', row.total_calls);
                console.log('     - Answered Calls:', row.answered_calls);
                console.log('     - AHT:', row.aht);
                console.log('     - Custom States:', row.custom_states ? row.custom_states.substring(0, 80) + '...' : 'None');
                console.log('     - Created At:', row.created_at);
                console.log('');
            });
        } else {
            console.log('❌ No records found for Test MultyComm');
        }

        // Check if there are recent agent_stats records that might not have been processed
        console.log('📊 LATEST AGENT_STATS RECORDS:');
        const [latestStats] = await pool.execute(
            'SELECT * FROM agent_stats WHERE agent_name = ? ORDER BY created_at DESC LIMIT 3',
            [agentName]
        );
        
        if (latestStats.length > 0) {
            console.log('✅ Found', latestStats.length, 'latest stats record(s)');
            latestStats.forEach((row, index) => {
                const rawData = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
                console.log(`   Stats Record ${index + 1}:`);
                console.log('     - Time Slot:', row.time_slot_label);
                console.log('     - Total Calls:', rawData.total_calls);
                console.log('     - Answered Calls:', rawData.answered_calls);
                console.log('     - Created At:', row.created_at);
                console.log('');
            });
        } else {
            console.log('❌ No agent_stats records found');
        }

        // Check if there's a mismatch - stats exist but complete_hourly doesn't
        if (latestStats.length > 0 && latestRecords.length === 0) {
            console.log('⚠️  ISSUE DETECTED: agent_stats records exist but no agent_complete_hourly records!');
            console.log('    This suggests the final report generation is not working properly.');
        } else if (latestStats.length > 0 && latestRecords.length > 0) {
            const latestStatsTime = new Date(latestStats[0].created_at);
            const latestCompleteTime = new Date(latestRecords[0].created_at);
            
            if (latestStatsTime > latestCompleteTime) {
                console.log('⚠️  TIMING ISSUE: Latest agent_stats is newer than latest agent_complete_hourly');
                console.log('    Latest Stats:', latestStats[0].created_at);
                console.log('    Latest Complete:', latestRecords[0].created_at);
                console.log('    The final report generation might be lagging behind.');
            } else {
                console.log('✅ TIMING OK: agent_complete_hourly is up to date with agent_stats');
            }
        }

    } catch (error) {
        console.error('❌ Database error:', error.message);
    }
}

checkTestMultyCommData().catch(console.error);
