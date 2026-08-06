#!/usr/bin/env node
// populate-final-hourly.js
// Populate all database tables with agent data using hourly time slots
//
// Usage: node populate-final-hourly.js <startTimestamp> <endTimestamp>
// Example: node populate-final-hourly.js 1761977700 1762257600

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
    convertDbActivitiesToApiFormat
} from './database/config.js';
import { 
    generateHourlyTimeSlots, 
    findTimeSlotForTimestamp,
    groupDataByTimeSlots
} from './utils/hourlyTimeSlotsFixed.js';
import { TENANT_CONFIG } from './tenantConfig.js';

dotenv.config();

/**
 * Progressive loading function for agent stats to handle large datasets
 * UPDATED: Now uses HOURLY chunks instead of daily chunks for better granularity
 */
async function fetchAgentStatsProgressive(params) {
    const { startDate, endDate, tenant } = params;
    
    // State management for progressive loading
    const progressiveState = {
        currentResults: {},
        loadedRecords: 0,
        totalRecords: 0,
        isComplete: false,
        chunkSize: 60 * 60 * 1000, // 1 HOUR chunks in milliseconds (changed from 24 hours)
        currentChunk: 0,
        totalChunks: 0
    };
    
    try {
        // Calculate total chunks needed
        const totalTimeRange = endDate - startDate;
        progressiveState.totalChunks = Math.ceil(totalTimeRange / progressiveState.chunkSize);
        
        console.log(`📊 Progressive Loading: Processing ${progressiveState.totalChunks} HOURLY chunks`);
        console.log(`📅 Chunk size: 1 HOUR (${progressiveState.chunkSize / (1000 * 60 * 60)} hours)`);
        
        // Process data in HOURLY chunks
        for (let chunkIndex = 0; chunkIndex < progressiveState.totalChunks; chunkIndex++) {
            const chunkStartDate = startDate + (chunkIndex * progressiveState.chunkSize);
            const chunkEndDate = Math.min(chunkStartDate + progressiveState.chunkSize, endDate);
            
            // Update progress
            const percentComplete = Math.round((chunkIndex / progressiveState.totalChunks) * 100);
            console.log(`🔄 Loading hourly chunk ${chunkIndex + 1}/${progressiveState.totalChunks} (${percentComplete}%)`);
            console.log(`   📅 Hour range: ${new Date(chunkStartDate).toISOString()} to ${new Date(chunkEndDate).toISOString()}`);
            
            try {
                // Fetch data for this HOURLY chunk
                console.log(`🔍 DEBUG: Calling fetchAgentStats with tenant='${tenant}', startDate=${chunkStartDate}, endDate=${chunkEndDate}`);
                const chunkData = await fetchAgentStats(tenant, {
                    startDate: chunkStartDate,
                    endDate: chunkEndDate
                });
                console.log(`🔍 DEBUG: Hourly chunk ${chunkIndex + 1} returned:`, chunkData ? Object.keys(chunkData).length : 0, 'records');
                
                if (chunkData && Object.keys(chunkData).length > 0) {
                    // Store each hourly chunk separately instead of merging
                    // This preserves hourly granularity of the data
                    const hourlyKey = `hour_${chunkIndex}`;
                    progressiveState.currentResults[hourlyKey] = {
                        timeRange: {
                            start: chunkStartDate,
                            end: chunkEndDate,
                            startISO: new Date(chunkStartDate).toISOString(),
                            endISO: new Date(chunkEndDate).toISOString()
                        },
                        agents: chunkData
                    };
                    
                    progressiveState.loadedRecords += Object.keys(chunkData).length;
                    console.log(`   ✅ Loaded ${Object.keys(chunkData).length} agent records from hourly chunk ${chunkIndex + 1}`);
                } else {
                    console.log(`   ⚠️ No data in hourly chunk ${chunkIndex + 1}`);
                }
                
                // Add small delay between chunks to prevent overwhelming the API
                if (chunkIndex < progressiveState.totalChunks - 1) {
                    await new Promise(resolve => setTimeout(resolve, 200)); // Slightly longer delay for hourly calls
                }
                
            } catch (chunkError) {
                console.error(`❌ Error loading hourly chunk ${chunkIndex + 1}:`, chunkError.message);
                // Continue with next chunk instead of failing completely
                continue;
            }
        }
        
        progressiveState.isComplete = true;
        progressiveState.totalRecords = Object.keys(progressiveState.currentResults).length;
        
        console.log(`✅ Progressive hourly loading complete: ${progressiveState.totalRecords} hourly chunks loaded`);
        
        return progressiveState.currentResults;
        
    } catch (error) {
        console.error('❌ Progressive hourly loading failed:', error.message);
        throw error;
    }
}

/**
 * Convert Unix timestamp to readable date string (Asia/Kolkata timezone)
 */
function timestampToDate(timestamp) {
    return new Date(timestamp * 1000).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * Extract individual custom states from API response's not_available_detailed_report
 * Dynamically processes all states from API without hardcoded mappings
 * @param {object} notAvailableDetailedReport - Object with state names as keys and duration in seconds as values
 * @returns {object} - Object with custom state durations in HH:MM:SS format
 */
function extractIndividualCustomStatesFromAPI(notAvailableDetailedReport) {
    const customStates = {};

    if (!notAvailableDetailedReport || typeof notAvailableDetailedReport !== 'object') {
        return customStates;
    }

    // Helper to convert state name to camelCase database column name
    const toColumnName = (stateName) => {
        // Convert to camelCase: "Lunch Break" -> "lunchBreak", "Log In" -> "logIn"
        return 'customState' + stateName
            .split(/[\s-]+/)  // Split by space or hyphen
            .map((word, index) => {
                // Capitalize first letter of each word
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
    };

    // Helper to format seconds into HH:MM:SS
    const formatSeconds = (seconds) => {
        if (seconds == null || isNaN(seconds)) return '00:00:00';
        return new Date(seconds * 1000).toISOString().substr(11, 8);
    };

    // Process each state from the API response dynamically
    for (const [stateName, durationSeconds] of Object.entries(notAvailableDetailedReport)) {
        if (durationSeconds > 0) {
            const columnName = toColumnName(stateName);
            customStates[columnName] = formatSeconds(durationSeconds);
        }
    }

    return customStates;
}

/**
 * Extract individual custom states from the combined custom states string
 * Dynamically processes all states without hardcoded mappings
 * @param {string} customStatesString - Custom states in format: "[State : duration_seconds], [State : duration_seconds], ..."
 * @returns {object} - Object with individual custom state durations in HH:MM:SS format
 */
function extractIndividualCustomStates(customStatesString) {
    const customStates = {};

    if (!customStatesString || customStatesString.trim() === '') {
        return customStates;
    }

    // Helper to convert state name to camelCase database column name
    const toColumnName = (stateName) => {
        return 'customState' + stateName
            .split(/[\s-]+/)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    };

    // Helper to format seconds into HH:MM:SS
    const formatSeconds = (seconds) => {
        if (seconds == null || isNaN(seconds)) return '00:00:00';
        return new Date(seconds * 1000).toISOString().substr(11, 8);
    };

    // Parse format: [state_name : duration_seconds], [state_name : duration_seconds], ...
    const stateMatches = customStatesString.match(/\[([^:]+)\s*:\s*(\d+)\]/g);
    
    if (stateMatches) {
        stateMatches.forEach(match => {
            const parts = match.slice(1, -1).split(':');
            const stateName = parts[0].trim();
            const durationSeconds = parseInt(parts[1].trim());
            
            if (durationSeconds > 0) {
                const columnName = toColumnName(stateName);
                customStates[columnName] = formatSeconds(durationSeconds);
            }
        });
    }

    return customStates;
}

/**
 * Calculate productive and non-productive break times from API response's not_available_detailed_report
 * Uses tenant configuration to determine which states are productive/non-productive
 * @param {object} notAvailableDetailedReport - Object with state names as keys and duration in seconds as values
 * @param {string} tenant - Tenant name to get configuration
 * @returns {object} - {productiveBreakTime: "HH:MM:SS", nonProductiveBreakTime: "HH:MM:SS"}
 */
function calculateBreakTimesFromAPI(notAvailableDetailedReport, tenant) {
    // Get tenant configuration for productive/non-productive states
    const tenantConfig = TENANT_CONFIG[tenant] || {};
    const productiveStates = tenantConfig.productive_states || [];
    const nonProductiveStates = tenantConfig.non_productive_states || [];
    
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;
    
    if (!notAvailableDetailedReport || typeof notAvailableDetailedReport !== 'object') {
        return {
            productiveBreakTime: '00:00:00',
            nonProductiveBreakTime: '00:00:00'
        };
    }
    
    try {
        // Process each state from the API response
        for (const [stateName, durationSeconds] of Object.entries(notAvailableDetailedReport)) {
            if (durationSeconds > 0) {
                // Check if it's productive or non-productive
                const isProductive = productiveStates.some(state => stateName.toLowerCase().includes(state.toLowerCase()));
                const isNonProductive = nonProductiveStates.some(state => stateName.toLowerCase().includes(state.toLowerCase()));
                
                if (isProductive) {
                    productiveSeconds += durationSeconds;
                    console.log(`✅ Productive: ${stateName} = ${formatSecondsToTime(durationSeconds)}`);
                } else if (isNonProductive) {
                    nonProductiveSeconds += durationSeconds;
                    console.log(`🔴 Non-productive: ${stateName} = ${formatSecondsToTime(durationSeconds)}`);
                } else {
                    console.log(`⚠️ Unclassified state: ${stateName}`);
                }
            }
        }
    } catch (error) {
        console.error('Error parsing custom states from API:', error);
    }
    
    const result = {
        productiveBreakTime: formatSecondsToTime(productiveSeconds),
        nonProductiveBreakTime: formatSecondsToTime(nonProductiveSeconds)
    };
    
    console.log(`📊 Break time calculation (API): Productive=${result.productiveBreakTime}, Non-productive=${result.nonProductiveBreakTime}`);
    
    return result;
}

/**
 * Calculate productive and non-productive break times from custom states
 * @param {string} customStatesText - Custom states in format: "State1 (time1 to time2), State2 (time3 to time4), ..."
 * @returns {object} - {productiveBreakTime: "HH:MM:SS", nonProductiveBreakTime: "HH:MM:SS"}
 */
function calculateBreakTimes(customStatesText) {
    // Define productive and non-productive states based on new schema
    const productiveStates = ['Training', 'Login', 'Log In', 'Chat', 'Meeting', 'Setup', 'LQ', 'Gallabox', 'Quality Feedback', 'Quality feedback', 'Query CP', 'Query CX', 'Feedback Session', 'Floor Support'];
    const nonProductiveStates = ['Lunch Break', 'Tea Break', 'Bio', 'Short Break 1', 'Short Break1', 'Short Break 2', 'Short Break2', 'Logoff', 'Downtime'];
    
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;
    
    if (!customStatesText || customStatesText.trim() === '') {
        return {
            productiveBreakTime: '00:00:00',
            nonProductiveBreakTime: '00:00:00'
        };
    }
    
    try {
        // Check if it's the new API format: [state_name : duration_seconds]
        if (customStatesText.includes('[') && customStatesText.includes(':') && !customStatesText.includes(' to ')) {
            // Parse new format: [state_name : duration_seconds], [state_name : duration_seconds], ...
            const stateMatches = customStatesText.match(/\[([^:]+)\s*:\s*(\d+)\]/g);
            
            if (stateMatches) {
                for (const match of stateMatches) {
                    const parts = match.slice(1, -1).split(':'); // Remove brackets and split
                    const stateName = parts[0].trim();
                    const durationSeconds = parseInt(parts[1].trim());
                    
                    // Check if it's productive or non-productive
                    const isProductive = productiveStates.some(state => stateName.toLowerCase().includes(state.toLowerCase()));
                    const isNonProductive = nonProductiveStates.some(state => stateName.toLowerCase().includes(state.toLowerCase()));
                    
                    if (isProductive) {
                        productiveSeconds += durationSeconds;
                        console.log(`✅ Productive: ${stateName} = ${formatSecondsToTime(durationSeconds)}`);
                    } else if (isNonProductive) {
                        nonProductiveSeconds += durationSeconds;
                        console.log(`🔴 Non-productive: ${stateName} = ${formatSecondsToTime(durationSeconds)}`);
                    } else {
                        console.log(`⚠️ Unclassified state: ${stateName}`);
                    }
                }
            }
        } else {
            // Parse the old custom states text format: "State1 (time1 to time2), State2 (time3 to time4)"
            const stateEntries = customStatesText.split('), ');
            
            for (let i = 0; i < stateEntries.length; i++) {
                let entry = stateEntries[i];
                
                // Add back closing parenthesis if it's not the last entry (since split removes it)
                if (i < stateEntries.length - 1) {
                    entry += ')';
                }
                
                // Extract state name and time range using improved regex
                const match = entry.match(/^(.+?)\s+\((.+?)\s+to\s+(.+?)\)$/);
                if (!match) {
                    console.log(`⚠️ Could not parse entry: "${entry}"`);
                    continue;
                }
                
                const stateName = match[1].trim();
                const startTimeStr = match[2].trim();
                const endTimeStr = match[3].trim();
                
                // Parse time strings (format: "HH:MM:SS AM/PM")
                const startTime = parseTimeString(startTimeStr);
                const endTime = parseTimeString(endTimeStr);
                
                if (startTime && endTime) {
                    const durationSeconds = Math.abs(endTime - startTime) / 1000;
                    
                    // Check if it's productive or non-productive
                    const isProductive = productiveStates.some(state => stateName.toLowerCase().includes(state.toLowerCase()));
                    const isNonProductive = nonProductiveStates.some(state => stateName.toLowerCase().includes(state.toLowerCase()));
                    
                    if (isProductive) {
                        productiveSeconds += durationSeconds;
                        console.log(`✅ Productive: ${stateName} = ${formatSecondsToTime(durationSeconds)}`);
                    } else if (isNonProductive) {
                        nonProductiveSeconds += durationSeconds;
                        console.log(`🔴 Non-productive: ${stateName} = ${formatSecondsToTime(durationSeconds)}`);
                    } else {
                        console.log(`⚠️ Unclassified state: ${stateName}`);
                    }
                } else {
                    console.log(`❌ Failed to parse times for: ${stateName} (${startTimeStr} to ${endTimeStr})`);
                }
            }
        }
    } catch (error) {
        console.error('Error parsing custom states:', error);
    }
    
    const result = {
        productiveBreakTime: formatSecondsToTime(productiveSeconds),
        nonProductiveBreakTime: formatSecondsToTime(nonProductiveSeconds)
    };
    
    console.log(`📊 Break time calculation: Productive=${result.productiveBreakTime}, Non-productive=${result.nonProductiveBreakTime}`);
    
    return result;
}

/**
 * Parse time string in format "HH:MM:SS AM/PM" to Date object
 * @param {string} timeStr - Time string like "12:30:45 PM"
 * @returns {Date|null} - Date object or null if parsing fails
 */
function parseTimeString(timeStr) {
    try {
        // Create a date with today's date and the given time
        const today = new Date().toDateString();
        return new Date(`${today} ${timeStr}`);
    } catch (error) {
        return null;
    }
}

/**
 * Format seconds to HH:MM:SS format
 * @param {number} seconds - Total seconds
 * @returns {string} - Formatted time string
 */
function formatSecondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Populate agent stats with hourly time slot approach (HOURLY API CALLS)
 * For agent_stats: Update existing records within time range instead of adding new rows
 * 
 * NEW APPROACH: Makes separate API calls for each hourly time slot to get
 * granular hourly data instead of daily aggregates. This provides true hourly
 * statistics but increases API calls from 1 to N hours for better accuracy.
 */
async function populateAgentStatsHourly(startTimestamp, endTimestamp, tenant) {
    try {
        console.log('\n📊 Populating agent stats with hourly time slots (HOURLY API CALLS)...');
        
        // Generate hourly time slots
        const timeSlots = generateHourlyTimeSlots(startTimestamp, endTimestamp);
        console.log(`📅 Generated ${timeSlots.length} hourly time slots`);
        
        // PROGRESSIVE LOADING: Fetch agent stats with HOURLY chunked approach for large datasets
        console.log('\n🚀 Fetching agent stats using PROGRESSIVE HOURLY LOADING for large datasets...');
        console.log(`📊 Fetching stats from ${timestampToDate(startTimestamp)} to ${timestampToDate(endTimestamp)}`);
        
        let hourlyAgentData = null;
        try {
            console.log(`🔍 DEBUG: Calling fetchAgentStatsProgressive with:`);
            console.log(`   - startDate: ${startTimestamp * 1000} (${new Date(startTimestamp * 1000).toISOString()})`);
            console.log(`   - endDate: ${endTimestamp * 1000} (${new Date(endTimestamp * 1000).toISOString()})`);
            console.log(`   - tenant: ${tenant}`);
            
            hourlyAgentData = await fetchAgentStatsProgressive({
                startDate: startTimestamp * 1000, // Convert to milliseconds
                endDate: endTimestamp * 1000,      // Convert to milliseconds
                tenant: tenant  // Use correct tenant for authentication
            });
            
            console.log(`✅ Successfully fetched ${Object.keys(hourlyAgentData || {}).length} hourly chunks using progressive loading`);
            
            if (!hourlyAgentData || Object.keys(hourlyAgentData).length === 0) {
                console.log(`⚠️ WARNING: Stats API returned empty data. This will cause 0 records in agent_complete_hourly`);
                console.log(`🔍 DEBUG: Raw stats response:`, JSON.stringify(hourlyAgentData, null, 2));
                
                // FALLBACK: Try to get basic agent list from activities data
                console.log(`🔄 FALLBACK: Attempting to create basic agent stats from activities data...`);
                try {
                    const events = await fetchAgentEvents(tenant, {
                        startDate: startTimestamp,
                        endDate: endTimestamp,
                        filterResults: false
                    });
                    
                    if (events && events.length > 0) {
                        console.log(`📊 Found ${events.length} activity events, extracting unique agents...`);
                        const uniqueAgents = {};
                        
                        events.forEach(event => {
                            const agentName = event.name || event.username || event.agent_name || 'Unknown';
                            const extension = event.ext || event.extension || 'unknown';
                            
                            if (!uniqueAgents[extension]) {
                                uniqueAgents[extension] = {
                                    name: agentName,
                                    extension: extension,
                                    total_calls: 0,
                                    answered_calls: 0,
                                    talked_time: '00:00:00',
                                    // Add basic stats structure
                                    agent: {
                                        Login: '00:00:00',
                                        Train: '00:00:00',
                                        lunch: '00:00:00',
                                        training: '00:00:00'
                                    }
                                };
                            }
                        });
                        
                        // Convert to hourly format for consistency
                        hourlyAgentData = {
                            hour_0: {
                                timeRange: {
                                    start: startTimestamp * 1000,
                                    end: endTimestamp * 1000,
                                    startISO: new Date(startTimestamp * 1000).toISOString(),
                                    endISO: new Date(endTimestamp * 1000).toISOString()
                                },
                                agents: uniqueAgents
                            }
                        };
                        console.log(`✅ FALLBACK: Created basic stats for ${Object.keys(uniqueAgents).length} agents from activities`);
                    }
                } catch (fallbackError) {
                    console.error(`❌ FALLBACK failed:`, fallbackError.message);
                }
            } else {
                console.log(`🔍 DEBUG: Sample hourly chunk:`, Object.keys(hourlyAgentData)[0]);
                const firstChunk = hourlyAgentData[Object.keys(hourlyAgentData)[0]];
                if (firstChunk && firstChunk.agents) {
                    console.log(`🔍 DEBUG: First chunk has ${Object.keys(firstChunk.agents).length} agents`);
                    console.log(`🔍 DEBUG: Time range: ${firstChunk.timeRange?.startISO} to ${firstChunk.timeRange?.endISO}`);
                }
            }
        } catch (error) {
            console.error(`❌ Progressive hourly stats loading failed:`, error.message);
            console.error(`🔍 DEBUG: Full error:`, error);
            throw error;
        }
        
        let totalInsertCount = 0;
        let totalUpdateCount = 0;
        
        // Process each hourly time slot using the corresponding hourly data
        for (let i = 0; i < timeSlots.length; i++) {
            const slot = timeSlots[i];
            console.log(`\n📅 Processing slot ${i + 1}/${timeSlots.length}: ${slot.slotLabel}`);
            
            try {
                // Find the corresponding hourly chunk for this time slot
                const hourlyKey = `hour_${i}`;
                const hourlyChunk = hourlyAgentData?.[hourlyKey];
                
                if (!hourlyChunk || !hourlyChunk.agents || Object.keys(hourlyChunk.agents).length === 0) {
                    console.log(`   ⚠️ No agent stats data for slot ${slot.slotLabel} (hourly chunk: ${hourlyKey})`);
                    continue;
                }
                
                const agentData = hourlyChunk.agents;
                console.log(`   📊 Processing ${Object.keys(agentData).length} agents for slot ${slot.slotLabel}...`);
                console.log(`   🕐 Hourly chunk time range: ${hourlyChunk.timeRange?.startISO} → ${hourlyChunk.timeRange?.endISO}`);
                
                let slotInsertCount = 0;
                let slotUpdateCount = 0;
                
                // Prepare batch data for this time slot
                const batchStatsData = [];
                
                // Process each agent's stats for this hourly slot
                // Now using actual hourly data from the API instead of daily aggregates
                for (const [extension, data] of Object.entries(agentData)) {
                    try {
                        // Debug: Log the first few extensions to verify they're correct
                        if (batchStatsData.length < 3) {
                            console.log(`🔍 DEBUG: Processing extension="${extension}", agent="${data.name}"`);
                        }
                        
                        // Store the extension in the raw_data for later use in final_apr
                        const enhancedRawData = {
                            ...data,
                            extension: extension, // Add extension to raw_data
                            hourlyTimeRange: hourlyChunk.timeRange // Add hourly time range info
                        };
                        
                        const agentStatsRecord = {
                            agentName: data.name || 'Unknown Agent',
                            agentTags: data.tags || [],
                            rawData: enhancedRawData,
                            startTime: slot.startTime,
                            endTime: slot.endTime,
                            timeSlotLabel: slot.slotLabel
                        };
                        
                        batchStatsData.push(agentStatsRecord);
                        
                    } catch (error) {
                        console.error(`      ❌ Failed to prepare stats for agent ${extension} (${data.name}) in slot ${slot.slotLabel}:`, error.message);
                    }
                }
                
                // Batch insert/update for this time slot
                if (batchStatsData.length > 0) {
                    console.log(`   🔍 DEBUG: About to insert ${batchStatsData.length} records for slot ${slot.slotLabel}`);
                    console.log(`   🔍 DEBUG: Sample record:`, JSON.stringify(batchStatsData[0], null, 2));
                    
                    const result = await batchInsertAgentStats(batchStatsData, tenant);
                    slotInsertCount = batchStatsData.length;
                    totalInsertCount += slotInsertCount;
                    
                    console.log(`   🔍 DEBUG: Insert result:`, result);
                    console.log(`   ✅ Processed ${slotInsertCount} agent records for slot ${slot.slotLabel} using HOURLY API data`);
                } else {
                    console.log(`   ⚠️ No batch data to insert for slot ${slot.slotLabel}`);
                }
                
            } catch (error) {
                console.error(`❌ Failed to process slot ${slot.slotLabel}:`, error.message);
            }
        }
        
        console.log(`\n🎉 Successfully processed ${timeSlots.length} hourly time slots with ${totalInsertCount} total agent records using HOURLY API calls`);
        return totalInsertCount;
        
    } catch (error) {
        console.error('❌ Failed to populate agent stats:', error.message);
        throw error;
    }
}

/**
 * Populate agent activity events with hourly time slot association
 * For agent_activity: Create new rows for each state change within time slots
 */
async function populateAgentActivityHourly(startTimestamp, endTimestamp, tenant) {
    try {
        console.log('\n🎯 Populating agent activity events with hourly time slot association...');
        console.log(`🔍 DEBUG: populateAgentActivityHourly called with:`);
        console.log(`   - startTimestamp: ${startTimestamp} (${timestampToDate(startTimestamp)})`);
        console.log(`   - endTimestamp: ${endTimestamp} (${timestampToDate(endTimestamp)})`);
        console.log(`   - tenant: ${tenant}`);
        
        // Generate hourly time slots
        const timeSlots = generateHourlyTimeSlots(startTimestamp, endTimestamp);
        console.log(`📅 Using ${timeSlots.length} hourly time slots for activity events`);
        
        if (timeSlots.length <= 5) {
            console.log(`🔍 DEBUG: Time slots generated:`);
            timeSlots.forEach((slot, index) => {
                console.log(`   ${index + 1}. ${slot.slotLabel}`);
            });
        }
        
        // Fetch all agent activity events for the entire time range
        console.log('🔄 Fetching agent activity events...');
        console.log(`🔍 DEBUG: Using tenant: ${tenant} for events API`);
        const events = await fetchAgentEvents(tenant, {
            startDate: startTimestamp,
            endDate: endTimestamp,
            filterResults: false
        });
        
        if (!events || events.length === 0) {
            console.log('⚠️ No agent activity events found');
            return 0;
        }
        
        console.log(`📊 Processing ${events.length} agent activity events...`);
        
        let totalInsertCount = 0;
        const batchActivityData = [];
        
        // Process each event and assign it to appropriate time slot
        for (const event of events) {
            try {
                // Debug: Log first few events to verify timestamp extraction
                if (totalInsertCount < 3) {
                    console.log(`🔍 Event ${totalInsertCount + 1}: Timestamp=${event.Timestamp}, Username=${event.username}, State=${event.state}`);
                }
                
                // Extract event timestamp (try multiple possible field names)
                let eventTimestamp = event.Timestamp ||  // Capital T - this is the correct field!
                                   event.timestamp || 
                                   event.event_timestamp || 
                                   event.time || 
                                   event.created_at ||
                                   event.date ||
                                   event.event_time ||
                                   event.created ||
                                   event.updated ||
                                   event.event_date;
                
                // Convert to seconds if in milliseconds
                if (eventTimestamp > 2000000000) {
                    eventTimestamp = Math.floor(eventTimestamp / 1000);
                }
                
                // Find the time slot this event belongs to
                const timeSlot = findTimeSlotForTimestamp(eventTimestamp, timeSlots);
                
                if (!timeSlot) {
                    console.warn(`   ⚠️ Event timestamp ${eventTimestamp} (${timestampToDate(eventTimestamp)}) does not fall within any time slot`);
                    continue;
                }
                
                // Extract event details
                const eventDetails = extractEventDetails(event);
                
                // Prepare activity record
                const activityRecord = {
                    agentName: event.name || event.agent_name || event.username || 'Unknown Agent',
                    eventTimestamp: eventTimestamp,
                    rawData: event,
                    timeSlotStart: timeSlot.startTime,
                    timeSlotEnd: timeSlot.endTime,
                    timeSlotLabel: timeSlot.slotLabel,
                    eventType: eventDetails.eventType,
                    eventState: eventDetails.eventState
                };
                
                batchActivityData.push(activityRecord);
                
            } catch (error) {
                console.error(`   ❌ Failed to process event:`, error.message);
                console.error('   Event data:', JSON.stringify(event, null, 2));
            }
        }
        
        // Batch insert all activity records
        if (batchActivityData.length > 0) {
            console.log(`🔄 Batch inserting ${batchActivityData.length} activity records...`);
            
            // Process in chunks to avoid memory issues
            const chunkSize = 1000;
            for (let i = 0; i < batchActivityData.length; i += chunkSize) {
                const chunk = batchActivityData.slice(i, i + chunkSize);
                await batchInsertAgentActivities(chunk, tenant);
                totalInsertCount += chunk.length;
                
                if (i + chunkSize < batchActivityData.length) {
                    console.log(`   📝 Inserted ${i + chunkSize}/${batchActivityData.length} activity records...`);
                }
            }
        }
        
        console.log(`✅ Successfully processed ${events.length} events into ${totalInsertCount} activity records across ${timeSlots.length} time slots`);
        return totalInsertCount;
        
    } catch (error) {
        console.error('❌ Failed to populate agent activity:', error.message);
        throw error;
    }
}

/**
 * Populate final_apr table with hourly time slot data using DATABASE TABLES as source
 * 
 * NEW APPROACH: This function now fetches data from agent_stats and agent_activity tables
 * instead of making direct API calls. This creates a proper data pipeline:
 * APIs → Database Tables → Final Report Table
 * 
 * Key features:
 * - Fetches data from agent_stats and agent_activity tables
 * - Converts database format to API format for compatibility
 * - Uses existing generateEnhancedAgentReport function
 * - Maintains all existing functionality while using database as source
 */
async function populateFinalAPRHourly(tenant, timeSlots, startTimestamp, endTimestamp) {
    console.log('\n📋 POPULATING FINAL APR TABLE FROM DATABASE TABLES...');
    console.log('🔄 NEW APPROACH: Using agent_stats and agent_activity tables as data source');
    
    try {
        console.log(`📅 Processing ${timeSlots.length} hourly time slots for final APR`);
        
        // Step 1: Get all agent stats records from database tables (we'll filter by time slot later)
        console.log('\n🗄️ STEP 1: Fetching ALL agent stats records from DATABASE TABLES...');
        console.log(`📊 Querying agent_stats table from ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(endTimestamp * 1000).toISOString()}`);
        
        let allDbStatsRows = null;
        try {
            console.log(`🔍 DEBUG: Querying agent_stats table with:`);
            console.log(`   - startTime >= ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`);
            console.log(`   - endTime <= ${endTimestamp} (${new Date(endTimestamp * 1000).toISOString()})`);
            
            allDbStatsRows = await getAllAgentStatsForTimeRange(startTimestamp, endTimestamp, tenant);
            console.log(`✅ Retrieved ${allDbStatsRows.length} agent stats records from database`);
            
            if (allDbStatsRows.length === 0) {
                console.log(`⚠️ WARNING: No records found in agent_stats table for this time range`);
                console.log(`🔍 This means the Stats API didn't populate any data in the first step`);
            } else {
                console.log(`🔍 DEBUG: Sample database record:`, JSON.stringify(allDbStatsRows[0], null, 2));
            }
        } catch (error) {
            console.error(`❌ Database stats loading failed:`, error.message);
            console.error(`🔍 DEBUG: Full error:`, error);
            allDbStatsRows = [];
        }
        
        // Step 2: Fetch agent activities from database tables
        console.log('\n🗄️ STEP 2: Fetching agent activities from DATABASE TABLES...');
        console.log(`📊 Querying agent_activity table for time range...`);
        
        let dbActivitiesData = null;
        try {
            const dbActivityRows = await getAllAgentActivitiesForTimeRange(startTimestamp, endTimestamp, tenant);
            console.log(`✅ Retrieved ${dbActivityRows.length} agent activity records from database`);
            
            // Convert database format to API format for compatibility
            dbActivitiesData = convertDbActivitiesToApiFormat(dbActivityRows);
            console.log(`✅ Converted to API format: ${dbActivitiesData.length} activity events`);
        } catch (error) {
            console.error(`❌ Database activities loading failed:`, error.message);
            dbActivitiesData = [];
        }
        
        console.log('✅ All database queries completed!');
        
        // Step 2.5: Calculate first login and last logout times for all agents using ALL events
        console.log('\n🔍 STEP 2.5: Calculating first login and last logout times for all agents...');
        const { getAgentLoginLogoffTimes } = await import('./agentEvents.js');
        const loginLogoffData = getAgentLoginLogoffTimes(dbActivitiesData || []);
        const loginLogoffMap = new Map(loginLogoffData.map(item => [item.ext, item]));
        console.log(`✅ Calculated login/logout times for ${loginLogoffData.length} agents`);
        
        
        // Step 3: Process each time slot using database data
        console.log('\n🔄 STEP 3: Processing time slots using database data...');
        let insertCount = 0;
        
        for (let i = 0; i < timeSlots.length; i++) {
            const slot = timeSlots[i];
            
            console.log(`\n📋 Processing slot ${i + 1}/${timeSlots.length}: ${slot.slotLabel}`);
            
            try {
                if (!allDbStatsRows || allDbStatsRows.length === 0) {
                    console.log(`   ⚠️ No agent stats data available for slot ${slot.slotLabel}`);
                    continue;
                }
                
                // Filter agent stats records for this SPECIFIC time slot
                const slotStatsRows = allDbStatsRows.filter(row => {
                    return row.start_time === slot.startTime && row.end_time === slot.endTime;
                });
                
                console.log(`   📊 Found ${slotStatsRows.length} agent stats records for this specific time slot`);
                
                if (slotStatsRows.length === 0) {
                    console.log(`   ⚠️ No agent stats records for slot ${slot.slotLabel} - skipping`);
                    continue;
                }
                
                // Convert the slot-specific stats to API format
                const slotStatsData = convertDbStatsToApiFormat(slotStatsRows);
                
                // Log agents with calls for debugging
                const agentsWithCalls = Object.values(slotStatsData).filter(agent => agent.total_calls > 0);
                if (agentsWithCalls.length > 0) {
                    console.log(`   📞 Found ${agentsWithCalls.length} agents with calls in this slot:`);
                    agentsWithCalls.forEach(agent => {
                        console.log(`      - ${agent.name} (${agent.extension}): ${agent.total_calls} total, ${agent.answered_calls} answered`);
                    });
                }
                
                // Filter activities for this specific time slot
                const slotActivities = dbActivitiesData.filter(activity => {
                    const activityTime = activity.Timestamp;
                    return activityTime >= slot.startTime && activityTime <= slot.endTime;
                });
                
                console.log(`   📊 Found ${slotActivities.length} activities for slot ${slot.slotLabel}`);
                
                // Generate enhanced report using DATABASE TABLE DATA for this specific time slot
                console.log(`   🔄 Using generateEnhancedAgentReportFromDB for slot-specific data processing...`);
                
                const report = await generateEnhancedAgentReportFromDB(
                    slotStatsData,    // Agent stats filtered for this specific time slot
                    slotActivities,   // Activities filtered for this specific time slot
                    slot,             // Time slot object with startTime, endTime, slotLabel
                    loginLogoffMap,   // Pre-calculated login/logout times for all agents (entire day)
                    tenant            // Tenant key for dynamic custom state handling
                );
                
                // Batch process records for efficient database insertion
                const batchRecords = [];
                for (const record of report.agentTimeSlots) {
                    try {
                        const agentExtension = record.extension || 'unknown';
                        
                        // Calculate productive and non-productive break times - try API format first, then fallback to string format
                        let breakTimes;
                        if (record.rawData && record.rawData.not_available_detailed_report) {
                            // Use new API format with not_available_detailed_report object
                            breakTimes = calculateBreakTimesFromAPI(record.rawData.not_available_detailed_report);
                        } else {
                            // Fallback to old string format
                            breakTimes = calculateBreakTimes(record.customStates || '');
                        }
                        
                        // Extract individual custom states - try API format first, then fallback to string format
                        let individualCustomStates;
                        if (record.rawData && record.rawData.not_available_detailed_report) {
                            // Use new API format with not_available_detailed_report object
                            individualCustomStates = extractIndividualCustomStatesFromAPI(record.rawData.not_available_detailed_report);
                        } else {
                            // Fallback to old string format
                            individualCustomStates = extractIndividualCustomStates(record.customStates || '');
                        }
                        
                        const reportData = {
                            agentName: record.agentName,
                            agentExtension: agentExtension,
                            startTime: slot.startTime,
                            endTime: slot.endTime,
                            timeSlotLabel: slot.slotLabel,
                            totalCalls: record.totalCalls || 0,
                            answeredCalls: record.answeredCalls || 0,
                            failedCalls: record.failedCalls || 0,
                            aht: record.aht || '00:00:00',
                            loginTime: record.loginTime || '00:00:00',
                            idleTime: record.idleTime || '00:00:00',
                            firstLoginTime: record.firstLoginTime || null,
                            lastLogoutTime: record.lastLogoutTime || null,
                            notAvailableTime: record.notAvailableTime || '00:00:00',
                            wrapUpTime: record.wrapUpTime || '00:00:00',
                            holdTime: record.holdTime || '00:00:00',
                            onCallTime: record.onCallTime || '00:00:00',
                            customStates: record.customStates || null,
                            // Individual custom states

                            customStateLogin: individualCustomStates.customStateLogin,
                            customStateLogout: individualCustomStates.customStateLogout,
                            customStateLunchBreak: individualCustomStates.customStateLunchBreak,
                            customStateTeaBreak: individualCustomStates.customStateTeaBreak,
                            customStateBio: individualCustomStates.customStateBio,
                            customStateShortBreak1: individualCustomStates.customStateShortBreak1,
                            customStateShortBreak2: individualCustomStates.customStateShortBreak2,
                            customStateTraining: individualCustomStates.customStateTraining,
                            customStateChat: individualCustomStates.customStateChat,
                            customStateMeeting: individualCustomStates.customStateMeeting,
                            customStateDowntime: individualCustomStates.customStateDowntime,
                            customStateFeedbackSession: individualCustomStates.customStateFeedbackSession,
                            customStateFloorSupport: individualCustomStates.customStateFloorSupport,
                            customStateGallabox: individualCustomStates.customStateGallabox,
                            customStateLq: individualCustomStates.customStateLq,
                            customStateQualityFeedback: individualCustomStates.customStateQualityFeedback,
                            customStateQueryCp: individualCustomStates.customStateQueryCp,
                            customStateQueryCx: individualCustomStates.customStateQueryCx,
                            customStateSetup: individualCustomStates.customStateSetup,
                            productiveBreakTime: breakTimes.productiveBreakTime,
                            nonProductiveBreakTime: breakTimes.nonProductiveBreakTime,
                            reportStartTime: startTimestamp,
                            reportEndTime: endTimestamp
                        };
                        
                        batchRecords.push(reportData);
                        
                    } catch (error) {
                        console.error(`   ❌ Failed to prepare final APR for ${record.agentName} in slot ${slot.slotLabel}:`, error.message);
                    }
                }
                
                // Batch insert records for this time slot
                if (batchRecords.length > 0) {
                    try {
                        const batchSize = 100; // Process 100 records at a time
                        for (let i = 0; i < batchRecords.length; i += batchSize) {
                            const batch = batchRecords.slice(i, i + batchSize);
                            
                            // Insert batch
                            for (const record of batch) {
                                await insertAgentCompleteHourly(record, tenant);
                                insertCount++;
                            }
                            
                            // Progress feedback for large batches
                            if (batchRecords.length > batchSize) {
                                const processed = Math.min(i + batchSize, batchRecords.length);
                                console.log(`   📝 Inserted ${processed}/${batchRecords.length} records for slot ${slot.slotLabel}...`);
                            }
                        }
                        console.log(`   ✅ Successfully processed ${batchRecords.length} agent records for slot ${slot.slotLabel}`);
                    } catch (batchError) {
                        console.error(`   ❌ Batch insert failed for slot ${slot.slotLabel}:`, batchError.message);
                    }
                } else {
                    console.log(`   ⚠️ No records to insert for slot ${slot.slotLabel}`);
                }
                
            } catch (error) {
                console.error(`❌ Failed to process slot ${slot.slotLabel}:`, error.message);
            }
        }
        
        console.log(`\n🎉 Successfully populated ${insertCount} records in agent_complete_hourly table using DATABASE TABLES as source`);
        return insertCount;
        
    } catch (error) {
        console.error('❌ Failed to populate final APR hourly from database tables:', error.message);
        throw error;
    }
}

/**
 * Populate all tables with hourly time slot data
 */
async function populateAllTablesHourly(startTime, endTime, tenant) {
    
    console.log('🚀 STARTING HOURLY-BASED DATABASE POPULATION PROCESS');
    console.log(`📅 Time Range: ${timestampToDate(startTime)} - ${timestampToDate(endTime)}`);
    console.log(`🏢 Tenant: ${tenant}`);
    
    // Show example of hourly time slots that will be generated
    const exampleSlots = generateHourlyTimeSlots(startTime, endTime);
    console.log(`\n📊 Will generate ${exampleSlots.length} hourly time slots:`);
    console.log(`   First slot: ${exampleSlots[0]?.slotLabel || 'N/A'}`);
    console.log(`   Last slot: ${exampleSlots[exampleSlots.length - 1]?.slotLabel || 'N/A'}`);
    
    const startProcessTime = Date.now();
    
    try {
        // Test database connection
        console.log('\n🔍 Testing database connection...');
        const isConnected = await testConnection();
        if (!isConnected) {
            throw new Error('Database connection failed');
        }
        
        // Clear existing data (optional - comment out if you want to keep existing data)
        // console.log('\n🧹 Clearing existing data...');
        // await clearTables();
        console.log('\n📝 Skipping table clearing - keeping existing data...');
        
        // NEW DATA PIPELINE: APIs → Database Tables → Final Report Table
        console.log('\n🚀 STEP 1: Populate base tables from APIs (PARALLEL execution)...');
        const [statsCount, activityCount] = await Promise.all([
            populateAgentStatsHourly(startTime, endTime, tenant),
            populateAgentActivityHourly(startTime, endTime, tenant)
        ]);
        
        console.log('\n✅ Base tables populated! Now generating final APR from DATABASE TABLES...');
        console.log('🔄 STEP 2: Generate final APR using database tables as source...');
        const aprCount = await populateFinalAPRHourly(tenant, exampleSlots, startTime, endTime);
        
        const endProcessTime = Date.now();
        const duration = ((endProcessTime - startProcessTime) / 1000).toFixed(2);
        
        console.log('\n🎉 NEW DATA PIPELINE COMPLETED SUCCESSFULLY!');
        console.log(`📊 Summary (APIs → Database Tables → Final Report):`);
        console.log(`   • Agent Stats (from API): ${statsCount} records`);
        console.log(`   • Agent Activity (from API): ${activityCount} records`);
        console.log(`   • Final APR (from DB tables): ${aprCount} records`);
        console.log(`   • Time Slots Generated: ${exampleSlots.length} hourly slots`);
        console.log(`   • Data Pipeline: APIs → agent_stats & agent_activity → agent_complete_hourly`);
        console.log(`⏱️  Total Duration: ${duration} seconds`);
        
        // Return success (don't exit when called from populate service)
        return true;
        
    } catch (error) {
        console.error('\n💥 HOURLY-BASED DATABASE POPULATION FAILED:', error.message);
        
        // Return failure (don't exit when called from populate service)
        return false;
    }
}

/**
 * CLI interface
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length !== 2) {
        console.log(`
🎯 Agent Database Population Tool (Hourly Time Slots)

USAGE:
  node populate-final-hourly.js <startTimestamp> <endTimestamp>

EXAMPLE:
  node populate-final-hourly.js 1761977700 1762257600
  
  This will populate data with hourly time slots:
  Start: ${timestampToDate(1761977700)} (01/11/2025, 12:00AM)
  End:   ${timestampToDate(1762257600)} (04/11/2025, 04:00PM)
  
  Hourly slots will be generated like:
  • 01/11/2025, 12:00AM - 01/11/2025, 01:00AM
  • 01/11/2025, 01:00AM - 01/11/2025, 02:00AM
  • 01/11/2025, 02:00AM - 01/11/2025, 03:00AM
  • ... and so on until ...
  • 04/11/2025, 03:00PM - 04/11/2025, 04:00PM

PARAMETERS:
  startTimestamp  - Unix timestamp for start time (seconds)
  endTimestamp    - Unix timestamp for end time (seconds)
  tenant          - (Optional) Tenant name (thriveco, hero, amity)
                    If not specified, populates ALL tenants in parallel

EXAMPLES:
  node populate-final-hourly.js 1779647400 1779733740 thriveco  # Single tenant
  node populate-final-hourly.js 1779647400 1779733740 hero      # Single tenant
  node populate-final-hourly.js 1779647400 1779733740            # ALL tenants (parallel)

NEW DATA PIPELINE:
  • STEP 1: APIs → agent_stats & agent_activity tables
  • STEP 2: Database tables → agent_complete_hourly table
  
DATABASE BEHAVIOR:
  • agent_stats: Updates existing records within each hourly time slot (from HOURLY API calls)
  • agent_activity: Creates new rows for each state change event (from API)
  • agent_complete_hourly: Generates comprehensive reports from DATABASE TABLES

API CALL BEHAVIOR:
  • Agent_Stats API: Called ONCE PER HOUR (744 calls for your example range)
  • Each API call covers exactly 1 hour: startTime=X, endTime=X+1hour
  • Example: 01/08/2025 12:00AM-01:00AM, then 01/08/2025 01:00AM-02:00AM, etc.

ENVIRONMENT VARIABLES:
  DB_HOST         - MySQL host (default: localhost)
  DB_USER         - MySQL username (default: root)
  DB_PASSWORD     - MySQL password (default: empty)
  DB_NAME         - Database name (default: agent_reports)
  DB_PORT         - MySQL port (default: 3306)
  TENANT          - Tenant name (default: all tenants if not specified)
        `);
        process.exit(1);
    }
    
    const startTime = parseInt(args[0]);
    const endTime = parseInt(args[1]);
    const tenant = args[2] || process.env.TENANT || null;
    
    // Validate timestamps
    if (isNaN(startTime) || isNaN(endTime)) {
        console.error('❌ Invalid timestamps. Please provide valid Unix timestamps.');
        process.exit(1);
    }
    
    if (startTime >= endTime) {
        console.error('❌ Start time must be before end time.');
        process.exit(1);
    }
    
    // Check if timestamps are reasonable (not too far in past/future)
    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - (365 * 24 * 60 * 60);
    const oneYearFromNow = now + (365 * 24 * 60 * 60);
    
    if (startTime < oneYearAgo || endTime > oneYearFromNow) {
        console.warn('⚠️  Warning: Timestamps seem to be outside reasonable range (more than 1 year ago or in future)');
    }
    
    let success;
    
    // If no tenant specified, populate all tenants in parallel
    if (!tenant) {
        const allTenants = Object.keys(TENANT_CONFIG);
        console.log(`\n🌐 No tenant specified - populating data for ALL tenants in parallel: ${allTenants.join(', ')}\n`);
        
        const results = await Promise.allSettled(
            allTenants.map(tenantKey => 
                populateAllTablesHourly(startTime, endTime, tenantKey)
                    .then(result => ({ tenant: tenantKey, success: result }))
                    .catch(error => ({ tenant: tenantKey, success: false, error: error.message }))
            )
        );
        
        console.log('\n📊 SUMMARY OF ALL TENANTS:');
        results.forEach(result => {
            if (result.status === 'fulfilled') {
                const { tenant: t, success: s, error } = result.value;
                if (s) {
                    console.log(`  ✅ ${t}: SUCCESS`);
                } else {
                    console.log(`  ❌ ${t}: FAILED - ${error || 'Unknown error'}`);
                }
            } else {
                console.log(`  ❌ Tenant processing failed: ${result.reason}`);
            }
        });
        
        success = results.every(r => r.status === 'fulfilled' && r.value.success);
    } else {
        // Single tenant mode
        success = await populateAllTablesHourly(startTime, endTime, tenant);
    }
    
    // Exit with appropriate code when run directly from CLI
    process.exit(success ? 0 : 1);
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('💥 Unexpected error:', error);
        process.exit(1);
    });
}

export {
    populateAgentStatsHourly,
    populateAgentActivityHourly,
    populateFinalAPRHourly,
    populateAllTablesHourly
};
