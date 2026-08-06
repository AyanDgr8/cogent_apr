#!/usr/bin/env node
import { pool } from './database/config.js';
import { 
    getAllAgentStatsForTimeRange,
    getAllAgentActivitiesForTimeRange,
    convertDbStatsToApiFormat,
    convertDbActivitiesToApiFormat
} from './database/config.js';

async function debugAgentMatching() {
    try {
        console.log('🔍 DEBUGGING AGENT MATCHING ISSUE');
        console.log('=================================');
        
        const startTime = 1762760945;
        const endTime = 1762764545;
        
        // Get data from database
        const [allDbStatsRows, dbActivityRows] = await Promise.all([
            getAllAgentStatsForTimeRange(startTime, endTime),
            getAllAgentActivitiesForTimeRange(startTime, endTime)
        ]);
        
        console.log(`\n📊 Raw Data Counts:`);
        console.log(`  • Stats Records: ${allDbStatsRows.length}`);
        console.log(`  • Activity Records: ${dbActivityRows.length}`);
        
        // Convert to API format
        const slotStatsData = convertDbStatsToApiFormat(allDbStatsRows);
        const dbActivitiesData = convertDbActivitiesToApiFormat(dbActivityRows);
        
        console.log(`\n📊 Converted Data:`);
        console.log(`  • Stats Agents: ${Object.keys(slotStatsData).length}`);
        console.log(`  • Activity Events: ${dbActivitiesData.length}`);
        
        // Show sample stats agents
        console.log(`\n👥 Sample Stats Agents (first 5):`);
        Object.entries(slotStatsData).slice(0, 5).forEach(([ext, data], index) => {
            console.log(`  ${index + 1}. Extension: "${ext}" | Name: "${data.name}" | Extension in data: "${data.extension}"`);
        });
        
        // Show sample activity agents
        console.log(`\n👥 Sample Activity Agents (first 10):`);
        const uniqueActivityAgents = [...new Set(dbActivitiesData.map(a => a.name || a.username || a.agent_name))];
        uniqueActivityAgents.slice(0, 10).forEach((name, index) => {
            const sampleActivity = dbActivitiesData.find(a => (a.name || a.username || a.agent_name) === name);
            console.log(`  ${index + 1}. Name: "${name}" | Ext: "${sampleActivity.ext || sampleActivity.extension || 'N/A'}"`);
        });
        
        console.log(`\n🔍 Total Unique Activity Agents: ${uniqueActivityAgents.length}`);
        
        // Try to find matches
        console.log(`\n🔗 Checking Matches:`);
        let matchCount = 0;
        for (const [statsExt, statsData] of Object.entries(slotStatsData)) {
            const matchingActivities = dbActivitiesData.filter(activity => {
                const activityAgent = activity.name || activity.username || activity.agent_name;
                const activityExt = activity.ext || activity.extension;
                
                return activityAgent === statsData.name || 
                       activityAgent === statsExt ||
                       activityExt === statsExt ||
                       activityExt === statsData.extension;
            });
            
            if (matchingActivities.length > 0) {
                matchCount++;
                console.log(`  ✅ ${statsData.name} (${statsExt}): ${matchingActivities.length} activities`);
                if (matchCount >= 5) break; // Show first 5 matches
            }
        }
        
        console.log(`\n📈 Match Summary: ${matchCount} agents with both stats and activities`);
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

debugAgentMatching();
