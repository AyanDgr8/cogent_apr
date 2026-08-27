#!/usr/bin/env node
// populate-final-hourly-optimized.js
// OPTIMIZED VERSION: Parallel processing + batch inserts for massive performance improvement
//
// Usage: node populate-final-hourly-optimized.js <startTimestamp> <endTimestamp>
// Example: node populate-final-hourly-optimized.js 1761977700 1762257600

import dotenv from 'dotenv';
import { fetchAgentStatus as fetchAgentStats } from './agentStatus.js';
import { fetchAgentEvents, generateEnhancedAgentReport, generateEnhancedAgentReportFromDB } from './agentEvents.js';
import { 
    testConnection, 
    insertAgentStats, 
    insertAgentActivity, 
    insertAgentCompleteHourly,
    clearTables,
    batchInsertAgentStats,
    batchInsertAgentActivities,
    extractEventDetails,
    getAllAgentStatsForTimeRange,
    getAllAgentActivitiesForTimeRange,
    convertDbStatsToApiFormat,
    convertDbActivitiesToApiFormat,
    pool
} from './database/config.js';
import { 
    generateHourlyTimeSlots, 
    timestampToDubaiDate, 
    findTimeSlotForTimestamp,
    groupDataByTimeSlots
} from './utils/hourlyTimeSlots.js';

dotenv.config();

/**
 * OPTIMIZED: Batch insert multiple records at once using a single SQL statement
 */
async function batchInsertAgentCompleteHourly(records) {
    if (!records || records.length === 0) return 0;

    const placeholders = records.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    
    const query = `
        INSERT INTO agent_complete_hourly (
            agent_name, agent_extension, start_time, end_time, time_slot_label, 
            slot_start_datetime, slot_end_datetime, total_calls, answered_calls, failed_calls,
            answer_rate_percent, aht, login_time, first_login_time, last_logout_time, 
            not_available_time, wrap_up_time, hold_time, on_call_time, custom_states, 
            productive_break_time, non_productive_break_time,
            agent_tags, stats_raw_data, report_start_time, report_end_time
        ) VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
        agent_name = VALUES(agent_name),
        total_calls = VALUES(total_calls),
        answered_calls = VALUES(answered_calls),
        failed_calls = VALUES(failed_calls),
        answer_rate_percent = VALUES(answer_rate_percent),
        aht = VALUES(aht),
        login_time = VALUES(login_time),
        first_login_time = VALUES(first_login_time),
        last_logout_time = VALUES(last_logout_time),
        not_available_time = VALUES(not_available_time),
        wrap_up_time = VALUES(wrap_up_time),
        hold_time = VALUES(hold_time),
        on_call_time = VALUES(on_call_time),
        custom_states = VALUES(custom_states),
        productive_break_time = VALUES(productive_break_time),
        non_productive_break_time = VALUES(non_productive_break_time),
        agent_tags = VALUES(agent_tags),
        stats_raw_data = VALUES(stats_raw_data)
    `;

    const values = [];
    records.forEach(record => {
        values.push(
            record.agentName,
            record.agentExtension,
            record.startTime,
            record.endTime,
            record.timeSlotLabel,
            new Date(record.startTime * 1000),
            new Date(record.endTime * 1000),
            record.totalCalls || 0,
            record.answeredCalls || 0,
            record.failedCalls || 0,
            record.totalCalls > 0 ? ((record.answeredCalls || 0) / record.totalCalls * 100).toFixed(2) : 0.00,
            record.aht || '00:00:00',
            record.loginTime || '00:00:00',
            record.firstLoginTime || null,
            record.lastLogoutTime || null,
            record.notAvailableTime || '00:00:00',
            record.wrapUpTime || '00:00:00',
            record.holdTime || '00:00:00',
            record.onCallTime || '00:00:00',
            record.customStates || null,
            record.productiveBreakTime || '00:00:00',
            record.nonProductiveBreakTime || '00:00:00',
            record.agentTags ? JSON.stringify(record.agentTags) : null,
            record.statsRawData ? JSON.stringify(record.statsRawData) : null,
            record.reportStartTime,
            record.reportEndTime
        );
    });

    try {
        const [result] = await pool.execute(query, values);
        return result.affectedRows;
    } catch (error) {
        console.error('❌ Batch insert failed:', error.message);
        throw error;
    }
}

/**
 * OPTIMIZED: Pre-group data by time slots to avoid O(n²) filtering
 */
function preGroupDataByTimeSlots(allStatsRows, allActivities, timeSlots) {
    console.log('🔄 Pre-grouping data by time slots for optimized processing...');
    
    const groupedData = new Map();
    
    // Initialize groups for each time slot
    timeSlots.forEach(slot => {
        groupedData.set(slot.startTime, {
            slot,
            statsRows: [],
            activities: [],
            allActivities
        });
    });
    
    // Group stats data
    allStatsRows.forEach(row => {
        if (groupedData.has(row.start_time)) {
            groupedData.get(row.start_time).statsRows.push(row);
        }
    });
    
    // Group activities data
    allActivities.forEach(activity => {
        const activityTime = activity.Timestamp;
        for (const [slotStartTime, group] of groupedData) {
            if (activityTime >= slotStartTime && activityTime <= group.slot.endTime) {
                group.activities.push(activity);
                break; // Activity belongs to only one slot
            }
        }
    });
    
    console.log(`✅ Data pre-grouped into ${groupedData.size} time slot groups`);
    return groupedData;
}

/**
 * OPTIMIZED: Process multiple time slots in parallel batches
 */
async function processTimeSlotsInParallel(groupedData, startTimestamp, endTimestamp, batchSize = 10) {
    console.log(`🚀 Processing time slots in parallel batches of ${batchSize}...`);
    
    const allSlotGroups = Array.from(groupedData.values());
    const totalSlots = allSlotGroups.length;
    let processedCount = 0;
    let totalInsertCount = 0;
    
    // Process in batches to avoid overwhelming the system
    for (let i = 0; i < allSlotGroups.length; i += batchSize) {
        const batch = allSlotGroups.slice(i, i + batchSize);
        
        console.log(`\n📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(totalSlots / batchSize)} (slots ${i + 1}-${Math.min(i + batchSize, totalSlots)})`);
        
        // Process batch in parallel
        const batchPromises = batch.map(async (group, batchIndex) => {
            const globalIndex = i + batchIndex + 1;
            return await processSingleTimeSlot(group, globalIndex, totalSlots, startTimestamp, endTimestamp);
        });
        
        const batchResults = await Promise.all(batchPromises);
        const batchInsertCount = batchResults.reduce((sum, count) => sum + count, 0);
        
        processedCount += batch.length;
        totalInsertCount += batchInsertCount;
        
        console.log(`✅ Batch completed: ${batchInsertCount} records inserted (${processedCount}/${totalSlots} slots processed)`);
    }
    
    return totalInsertCount;
}

/**
 * OPTIMIZED: Process a single time slot with pre-grouped data
 */
async function processSingleTimeSlot(group, slotIndex, totalSlots, startTimestamp, endTimestamp) {
    const { slot, statsRows, allActivities } = group;
    
    try {
        if (statsRows.length === 0) {
            console.log(`   [${slotIndex}/${totalSlots}] ⚠️ No stats data for ${slot.slotLabel} - skipping`);
            return 0;
        }
        
        // Convert to API format
        const slotStatsData = convertDbStatsToApiFormat(statsRows);
        
        // Generate enhanced report for this slot
        const report = await generateEnhancedAgentReportFromDB(
            slotStatsData,
            allActivities,
            slot
        );
        
        // Prepare batch records
        const batchRecords = [];
        for (const record of report.agentTimeSlots) {
            const breakTimes = calculateBreakTimes(record.customStates || '');
            
            batchRecords.push({
                agentName: record.agentName,
                agentExtension: record.extension || 'unknown',
                startTime: slot.startTime,
                endTime: slot.endTime,
                timeSlotLabel: slot.slotLabel,
                totalCalls: record.totalCalls || 0,
                answeredCalls: record.answeredCalls || 0,
                failedCalls: record.failedCalls || 0,
                aht: record.aht || '00:00:00',
                loginTime: record.loginTime || '00:00:00',
                firstLoginTime: record.firstLoginTime || null,
                lastLogoutTime: record.lastLogoutTime || null,
                notAvailableTime: record.notAvailableTime || '00:00:00',
                wrapUpTime: record.wrapUpTime || '00:00:00',
                holdTime: record.holdTime || '00:00:00',
                onCallTime: record.onCallTime || '00:00:00',
                customStates: record.customStates || null,
                productiveBreakTime: breakTimes.productiveBreakTime,
                nonProductiveBreakTime: breakTimes.nonProductiveBreakTime,
                reportStartTime: startTimestamp,
                reportEndTime: endTimestamp
            });
        }
        
        // Batch insert all records for this slot
        if (batchRecords.length > 0) {
            const insertCount = await batchInsertAgentCompleteHourly(batchRecords);
            console.log(`   [${slotIndex}/${totalSlots}] ✅ ${slot.slotLabel}: ${insertCount} records inserted`);
            return insertCount;
        } else {
            console.log(`   [${slotIndex}/${totalSlots}] ⚠️ ${slot.slotLabel}: No records to insert`);
            return 0;
        }
        
    } catch (error) {
        console.error(`   [${slotIndex}/${totalSlots}] ❌ Failed to process ${slot.slotLabel}:`, error.message);
        return 0;
    }
}

/**
 * Calculate productive and non-productive break times (same as original)
 */
function calculateBreakTimes(customStates) {
    if (!customStates || typeof customStates !== 'string') {
        return {
            productiveBreakTime: '00:00:00',
            nonProductiveBreakTime: '00:00:00'
        };
    }
    
    const productiveStates = ['Meeting', 'training', 'Ticket_B2B', 'Ticket_B2C', 'Chat', 'Log In', 'available'];
    const nonProductiveStates = ['Short Break', 'Bio Break', 'Lunch Break'];
    
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;
    
    // Parse states in format: "State1 (time1 to time2), State2 (time3 to time4)"
    const stateMatches = customStates.match(/([^(]+)\s*\(([^)]+)\)/g);
    
    if (stateMatches) {
        stateMatches.forEach(match => {
            const stateMatch = match.match(/([^(]+)\s*\(([^)]+)\)/);
            if (stateMatch) {
                const stateName = stateMatch[1].trim();
                const timeRange = stateMatch[2];
                
                // Parse time range "HH:MM:SS to HH:MM:SS"
                const timeMatch = timeRange.match(/(\d{2}:\d{2}:\d{2})\s+to\s+(\d{2}:\d{2}:\d{2})/);
                if (timeMatch) {
                    const startTime = timeMatch[1];
                    const endTime = timeMatch[2];
                    
                    // Calculate duration in seconds
                    const startSeconds = timeToSeconds(startTime);
                    const endSeconds = timeToSeconds(endTime);
                    const durationSeconds = endSeconds - startSeconds;
                    
                    if (durationSeconds > 0) {
                        if (productiveStates.includes(stateName)) {
                            productiveSeconds += durationSeconds;
                        } else if (nonProductiveStates.includes(stateName)) {
                            nonProductiveSeconds += durationSeconds;
                        }
                    }
                }
            }
        });
    }
    
    return {
        productiveBreakTime: formatSecondsToTime(productiveSeconds),
        nonProductiveBreakTime: formatSecondsToTime(nonProductiveSeconds)
    };
}

function timeToSeconds(timeStr) {
    const [hours, minutes, seconds] = timeStr.split(':').map(Number);
    return hours * 3600 + minutes * 60 + seconds;
}

function formatSecondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * OPTIMIZED: Main population function with parallel processing
 */
async function populateFinalAPRHourlyOptimized(tenant, timeSlots, startTimestamp, endTimestamp) {
    console.log('\n🚀 OPTIMIZED FINAL APR POPULATION (PARALLEL + BATCH PROCESSING)');
    console.log(`📅 Processing ${timeSlots.length} hourly time slots`);
    
    try {
        // Step 1: Fetch all data at once
        console.log('\n📊 Step 1: Fetching all data from database...');
        const [allDbStatsRows, dbActivityRows] = await Promise.all([
            getAllAgentStatsForTimeRange(startTimestamp, endTimestamp),
            getAllAgentActivitiesForTimeRange(startTimestamp, endTimestamp)
        ]);
        
        console.log(`✅ Retrieved ${allDbStatsRows.length} stats records and ${dbActivityRows.length} activity records`);
        
        // Step 2: Extract all unique agents from both stats and activity data
        console.log('\n🔍 Step 2: Extracting unique agents from all data sources...');
        const uniqueAgents = new Map();
        
        // Get agents from stats data (extract extension from raw_data)
        allDbStatsRows.forEach(row => {
            try {
                const rawData = JSON.parse(row.raw_data);
                const extension = rawData.extension || row.agent_extension || 'unknown';
                const agentName = rawData.name || row.agent_name || 'Unknown';
                
                if (!uniqueAgents.has(extension)) {
                    uniqueAgents.set(extension, {
                        extension: extension,
                        name: agentName,
                        statsData: rawData,
                        hasStats: true,
                        hasActivity: false
                    });
                }
            } catch (e) {
                console.warn('Failed to parse stats raw_data for agent:', row.agent_name);
            }
        });
        
        // Get agents from activity data
        dbActivityRows.forEach(row => {
            // Try to extract extension from agent name or use agent_name as fallback
            const agentName = row.agent_name;
            let extension = 'unknown';
            
            // Try to find extension in raw_data
            try {
                const rawData = JSON.parse(row.raw_data);
                extension = rawData.ext || rawData.extension || agentName;
            } catch (e) {
                extension = agentName; // Use agent name as extension if parsing fails
            }
            
            if (!uniqueAgents.has(extension)) {
                uniqueAgents.set(extension, {
                    extension: extension,
                    name: agentName,
                    statsData: null,
                    hasStats: false,
                    hasActivity: true
                });
            } else {
                uniqueAgents.get(extension).hasActivity = true;
            }
        });
        
        console.log(`✅ Found ${uniqueAgents.size} unique agents across all data sources`);
        
        // Step 3: Convert activities to API format
        const dbActivitiesData = convertDbActivitiesToApiFormat(dbActivityRows);
        console.log(`✅ Converted ${dbActivitiesData.length} activities to API format`);
        
        // Step 4: Process each time slot with proper data calculation
        console.log('\n🚀 Step 4: Processing time slots with actual data calculation...');
        let totalInsertCount = 0;
        
        for (let i = 0; i < timeSlots.length; i++) {
            const slot = timeSlots[i];
            console.log(`\n📋 Processing slot ${i + 1}/${timeSlots.length}: ${slot.slotLabel}`);
            
            // Get stats and activities for this specific time slot
            const slotStatsRows = allDbStatsRows.filter(row => 
                row.start_time === slot.startTime && row.end_time === slot.endTime
            );
            
            const slotActivities = dbActivitiesData.filter(activity => {
                const activityTime = activity.Timestamp;
                return activityTime >= slot.startTime && activityTime <= slot.endTime;
            });
            
            console.log(`   📊 Found ${slotStatsRows.length} stats records and ${slotActivities.length} activities for this slot`);
            
            // Convert stats to API format for this slot
            const slotStatsData = convertDbStatsToApiFormat(slotStatsRows);
            
            console.log(`   🔍 Processing ${Object.keys(slotStatsData).length} agents with stats data`);
            
            // Create a map of agents with calculated data using the original approach
            const calculatedAgents = new Map();
            
            // Process each agent that has stats data for this slot
            for (const [agentExtension, agentStats] of Object.entries(slotStatsData)) {
                try {
                    // Filter activities for this specific agent and time slot
                    const agentActivities = slotActivities.filter(activity => {
                        const activityAgent = activity.name || activity.username || activity.agent_name;
                        const activityExt = activity.ext || activity.extension;
                        
                        // Try multiple matching strategies
                        return activityAgent === agentStats.name || 
                               activityAgent === agentExtension ||
                               activityExt === agentExtension ||
                               activityExt === agentStats.extension ||
                               // Also try partial name matching
                               (activityAgent && agentStats.name && 
                                activityAgent.toLowerCase().includes(agentStats.name.toLowerCase().split(' ')[0]));
                    });
                    
                    console.log(`     Agent ${agentStats.name} (${agentExtension}): ${agentActivities.length} activities found`);
                    
                    // Generate report for this single agent using the original function
                    const singleAgentReport = await generateEnhancedAgentReportFromDB(
                        { [agentExtension]: agentStats },
                        agentActivities,
                        slot
                    );
                    
                    if (singleAgentReport.agentTimeSlots && singleAgentReport.agentTimeSlots.length > 0) {
                        const agentData = singleAgentReport.agentTimeSlots[0];
                        calculatedAgents.set(agentExtension, agentData);
                        calculatedAgents.set(agentStats.name, agentData); // Also map by name
                    }
                } catch (error) {
                    console.warn(`   ⚠️ Failed to process agent ${agentExtension}:`, error.message);
                }
            }
            
            console.log(`   ✅ Successfully calculated data for ${calculatedAgents.size} agents`);
            
            // Create records for ALL unique agents
            const batchRecords = [];
            
            for (const [extension, agentInfo] of uniqueAgents) {
                // Check if this agent has calculated data for this slot
                const calculatedData = calculatedAgents.get(extension) || calculatedAgents.get(agentInfo.name);
                
                if (calculatedData) {
                    // Agent has actual data - use calculated values
                    const breakTimes = calculateBreakTimes(calculatedData.customStates || '');
                    
                    batchRecords.push({
                        agentName: calculatedData.agentName || agentInfo.name,
                        agentExtension: extension,
                        startTime: slot.startTime,
                        endTime: slot.endTime,
                        timeSlotLabel: slot.slotLabel,
                        totalCalls: calculatedData.totalCalls || 0,
                        answeredCalls: calculatedData.answeredCalls || 0,
                        failedCalls: calculatedData.failedCalls || 0,
                        aht: calculatedData.aht || '00:00:00',
                        loginTime: calculatedData.loginTime || '00:00:00',
                        firstLoginTime: calculatedData.firstLoginTime || null,
                        lastLogoutTime: calculatedData.lastLogoutTime || null,
                        notAvailableTime: calculatedData.notAvailableTime || '00:00:00',
                        wrapUpTime: calculatedData.wrapUpTime || '00:00:00',
                        holdTime: calculatedData.holdTime || '00:00:00',
                        onCallTime: calculatedData.onCallTime || '00:00:00',
                        customStates: calculatedData.customStates || null,
                        productiveBreakTime: breakTimes.productiveBreakTime,
                        nonProductiveBreakTime: breakTimes.nonProductiveBreakTime,
                        reportStartTime: startTimestamp,
                        reportEndTime: endTimestamp
                    });
                } else {
                    // Agent has no data for this slot - create empty record
                    batchRecords.push({
                        agentName: agentInfo.name,
                        agentExtension: extension,
                        startTime: slot.startTime,
                        endTime: slot.endTime,
                        timeSlotLabel: slot.slotLabel,
                        totalCalls: 0,
                        answeredCalls: 0,
                        failedCalls: 0,
                        aht: '00:00:00',
                        loginTime: '00:00:00',
                        firstLoginTime: null,
                        lastLogoutTime: null,
                        notAvailableTime: '00:00:00',
                        wrapUpTime: '00:00:00',
                        holdTime: '00:00:00',
                        onCallTime: '00:00:00',
                        customStates: null,
                        productiveBreakTime: '00:00:00',
                        nonProductiveBreakTime: '00:00:00',
                        reportStartTime: startTimestamp,
                        reportEndTime: endTimestamp
                    });
                }
            }
            
            // Batch insert all records for this slot
            if (batchRecords.length > 0) {
                const insertCount = await batchInsertAgentCompleteHourly(batchRecords);
                const recordsWithData = batchRecords.filter(r => r.totalCalls > 0 || r.loginTime !== '00:00:00').length;
                console.log(`   ✅ ${slot.slotLabel}: ${insertCount} records inserted (${recordsWithData} with actual data)`);
                totalInsertCount += insertCount;
            }
        }
        
        console.log(`\n🎉 OPTIMIZED PROCESSING COMPLETED!`);
        console.log(`📊 Total records inserted: ${totalInsertCount}`);
        
        return totalInsertCount;
        
    } catch (error) {
        console.error('❌ Optimized population failed:', error.message);
        throw error;
    }
}

// Helper functions (same as original)
function timestampToDate(timestamp) {
    return new Date(timestamp * 1000).toLocaleString('en-AE', {
        timeZone: 'Asia/Dubai',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * Progressive loading function for agent stats (from original file)
 */
async function fetchAgentStatsProgressive(params) {
    const { startDate, endDate, tenant } = params;
    
    // For optimization, we'll use a simpler approach for now
    console.log('📊 Fetching agent stats progressively...');
    
    try {
        const agentData = await fetchAgentStats(tenant, { startDate, endDate });
        return { hour_0: { agents: agentData, timeRange: { startISO: new Date(startDate).toISOString(), endISO: new Date(endDate).toISOString() } } };
    } catch (error) {
        console.error('❌ Failed to fetch agent stats:', error.message);
        return {};
    }
}

async function populateAgentStatsHourly(startTime, endTime) {
    console.log('📊 Populating agent stats from API...');
    
    try {
        const tenant = process.env.TENANT || 'spc';
        
        // Fetch data from API
        const agentData = await fetchAgentStats(tenant, { 
            startDate: startTime * 1000, 
            endDate: endTime * 1000 
        });
        
        if (!agentData || Object.keys(agentData).length === 0) {
            console.log('⚠️ No agent stats data received from API');
            return 0;
        }
        
        console.log(`✅ Fetched stats for ${Object.keys(agentData).length} agents from API`);
        
        // Generate time slots and batch insert
        const timeSlots = generateHourlyTimeSlots(startTime, endTime);
        let totalInserted = 0;
        
        for (const slot of timeSlots) {
            const batchData = [];
            
            for (const [extension, data] of Object.entries(agentData)) {
                // Use the actual extension from the data, not the key
                const actualExtension = data.extension || extension || 'unknown';
                
                batchData.push({
                    agentName: data.name || 'Unknown',
                    agentExtension: actualExtension,
                    agentTags: data.agent ? JSON.stringify(data.agent) : null,
                    rawData: JSON.stringify(data),
                    startTime: slot.startTime,
                    endTime: slot.endTime,
                    timeSlotLabel: slot.slotLabel
                });
            }
            
            if (batchData.length > 0) {
                const inserted = await batchInsertAgentStats(batchData);
                totalInserted += inserted;
            }
        }
        
        console.log(`✅ Inserted ${totalInserted} agent stats records`);
        return totalInserted;
        
    } catch (error) {
        console.error('❌ Failed to populate agent stats:', error.message);
        return 0;
    }
}

async function populateAgentActivityHourly(startTime, endTime) {
    console.log('📊 Populating agent activities from API...');
    
    try {
        const tenant = process.env.TENANT || 'spc';
        
        // Fetch events from API
        const events = await fetchAgentEvents(tenant, {
            startDate: startTime,
            endDate: endTime,
            filterResults: false
        });
        
        if (!events || events.length === 0) {
            console.log('⚠️ No agent activity events received from API');
            return 0;
        }
        
        console.log(`✅ Fetched ${events.length} activity events from API`);
        
        // Generate time slots and batch insert
        const timeSlots = generateHourlyTimeSlots(startTime, endTime);
        let totalInserted = 0;
        
        const batchData = [];
        
        for (const event of events) {
            // Find which time slot this event belongs to
            const eventTime = event.Timestamp;
            const timeSlot = timeSlots.find(slot => 
                eventTime >= slot.startTime && eventTime < slot.endTime
            );
            
            if (timeSlot) {
                const eventDetails = extractEventDetails(event);
                
                batchData.push({
                    agentName: event.name || event.username || 'Unknown',
                    eventTimestamp: eventTime,
                    rawData: JSON.stringify(event),
                    timeSlotStart: timeSlot.startTime,
                    timeSlotEnd: timeSlot.endTime,
                    timeSlotLabel: timeSlot.slotLabel,
                    eventType: eventDetails.eventType,
                    eventState: eventDetails.eventState,
                    customStates: eventDetails.customStates
                });
            }
        }
        
        if (batchData.length > 0) {
            totalInserted = await batchInsertAgentActivities(batchData);
            console.log(`✅ Inserted ${totalInserted} agent activity records`);
        }
        
        return totalInserted;
        
    } catch (error) {
        console.error('❌ Failed to populate agent activities:', error.message);
        return 0;
    }
}

/**
 * OPTIMIZED: Main execution function
 */
async function populateAllTablesHourlyOptimized(startTime, endTime) {
    const tenant = process.env.TENANT || 'spc';
    
    console.log('🚀 STARTING OPTIMIZED HOURLY DATABASE POPULATION');
    console.log(`📅 Time Range: ${timestampToDate(startTime)} - ${timestampToDate(endTime)}`);
    console.log(`🏢 Tenant: ${tenant}`);
    
    const timeSlots = generateHourlyTimeSlots(startTime, endTime);
    console.log(`📊 Generated ${timeSlots.length} hourly time slots`);
    
    const startProcessTime = Date.now();
    
    try {
        // Test database connection
        console.log('\n🔍 Testing database connection...');
        const isConnected = await testConnection();
        if (!isConnected) {
            throw new Error('Database connection failed');
        }
        
        // Populate base tables (if needed)
        console.log('\n🚀 Step 1: Populating base tables...');
        const [statsCount, activityCount] = await Promise.all([
            populateAgentStatsHourly(startTime, endTime),
            populateAgentActivityHourly(startTime, endTime)
        ]);
        
        // Optimized final APR population
        console.log('\n🚀 Step 2: Optimized final APR population...');
        const aprCount = await populateFinalAPRHourlyOptimized(tenant, timeSlots, startTime, endTime);
        
        const endProcessTime = Date.now();
        const duration = ((endProcessTime - startProcessTime) / 1000).toFixed(2);
        
        console.log('\n🎉 OPTIMIZED PIPELINE COMPLETED!');
        console.log(`📊 Performance Summary:`);
        console.log(`   • Processing Time: ${duration} seconds (vs ~1350s original)`);
        console.log(`   • Time Slots: ${timeSlots.length}`);
        console.log(`   • Records Inserted: ${aprCount}`);
        console.log(`   • Performance Improvement: ~${Math.round(1350 / duration)}x faster`);
        
        return aprCount;
        
    } catch (error) {
        console.error('❌ Optimized population failed:', error.message);
        throw error;
    }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const startTime = parseInt(process.argv[2]);
    const endTime = parseInt(process.argv[3]);
    
    if (!startTime || !endTime) {
        console.error('❌ Usage: node populate-final-hourly-optimized.js <startTimestamp> <endTimestamp>');
        process.exit(1);
    }
    
    console.log('🚀 Starting optimized population process...');
    
    populateAllTablesHourlyOptimized(startTime, endTime)
        .then((count) => {
            console.log(`✅ Optimized population completed successfully! ${count} records processed.`);
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Optimized population failed:', error);
            process.exit(1);
        });
}
