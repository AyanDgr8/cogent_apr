// agentEvents.js
// Fetch Agent Activity Events for a tenant
//
// Usage examples:
//   node -r dotenv/config agentEvents.js mc_int 1753251240 1753258440
//
// The script automatically handles pagination, retries (exp backoff),
// and self-signed certificates (inherits httpsAgent from tokenService).

import axios from 'axios';
import { httpsAgent } from './tokenService.js';

const MAX_RETRIES = 3;

/**
 * Get token specifically for the UC events server with tenant subdomain
 * @returns {Promise<string>} access token
 */
async function getUCToken() {
  const baseUrl = `https://ira-spc-sj.ucprem.voicemeetme.com:9443`;
  
  const candidates = [
    { url: `${baseUrl}/api/v2/config/login/oauth`, body: { domain: process.env.TENANT, username: process.env.API_USERNAME, password: process.env.API_PASSWORD } },
    { url: `${baseUrl}/api/v2/login`, body: { domain: process.env.TENANT, username: process.env.API_USERNAME, password: process.env.API_PASSWORD } },
    { url: `${baseUrl}/api/login`, body: { domain: process.env.TENANT, username: process.env.API_USERNAME, password: process.env.API_PASSWORD } },
  ];

  for (const { url, body } of candidates) {
    for (let attempt = 0, delay = 1000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
      try {
        const { data } = await axios.post(url, body, {
          timeout: 720000,
          httpsAgent,
          headers: { Accept: 'application/json' }
        });

        const access = data.accessToken || data.access_token;
        if (!access) throw new Error('No access token in response');

        console.log(` UC server login succeeded at ${url}`);
        return access;
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) {
          console.warn(`Login failed at ${url}: ${err.response?.status || err.message}`);
        } else {
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }
  throw new Error('All UC server login attempts failed – check credentials/endpoints');
}

/**
 * Filter events to show timestamps where agent state is "available" OR "Logoff" AND enabled is true
 * @param {object[]} events - Array of all events
 * @returns {object[]} - Array of enabled available/logoff state events with timestamps
 */
function getAvailableStateTimestamps(events) {
  console.log(`\n🔍 FILTERING FOR AVAILABLE & LOGOFF STATES (ENABLED ONLY):`);
  console.log(`📊 Total events to filter: ${events.length}`);
  
  // Filter for events where state is "available" OR "Logoff" AND enabled is true
  const targetEvents = events.filter(event => 
    event && 
    event.state && 
    (event.state.toLowerCase() === 'available' || event.state.toLowerCase() === 'logoff') &&
    event.enabled === true
  );
  
  console.log(`✅ Found ${targetEvents.length} events with state "available" or "Logoff" and enabled: true`);
  
  // Show breakdown by state type
  const availableEvents = targetEvents.filter(event => event.state.toLowerCase() === 'available');
  const logoffEvents = targetEvents.filter(event => event.state.toLowerCase() === 'logoff');
  console.log(`   📊 Available events: ${availableEvents.length}`);
  console.log(`   📊 Logoff events: ${logoffEvents.length}`);
  
  // Show how many were filtered out due to enabled: false or wrong state
  const allAvailableEvents = events.filter(event => 
    event && event.state && event.state.toLowerCase() === 'available'
  );
  const allLogoffEvents = events.filter(event => 
    event && event.state && event.state.toLowerCase() === 'logoff'
  );
  const disabledAvailableEvents = allAvailableEvents.length - availableEvents.length;
  const disabledLogoffEvents = allLogoffEvents.length - logoffEvents.length;
  
  if (disabledAvailableEvents > 0) {
    console.log(`⚠️  Filtered out ${disabledAvailableEvents} "available" events with enabled: false`);
  }
  if (disabledLogoffEvents > 0) {
    console.log(`⚠️  Filtered out ${disabledLogoffEvents} "Logoff" events with enabled: false`);
  }
  
  // Extract and format the results
  const results = targetEvents.map(event => ({
    username: event.username,
    ext: event.ext,
    user_id: event.user_id,
    event: event.event,
    state: event.state,
    timestamp: event.Timestamp,
    // Convert timestamp to Dubai GST for display
    timestampGST: new Date(event.Timestamp * 1000).toLocaleString('en-AE', {
      timeZone: 'Asia/Dubai',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }),
    enabled: event.enabled
  }));
  
  // Sort results by timestamp for chronological order
  results.sort((a, b) => a.timestamp - b.timestamp);
  
  // Log the results for debugging
  if (results.length > 0) {
    console.log(`\n📋 ENABLED AVAILABLE & LOGOFF STATE EVENTS FOUND:`);
    results.forEach((event, index) => {
      console.log(`${index + 1}. ${event.username} (${event.ext}) - State: ${event.state} - Timestamp: ${event.timestamp} (${event.timestampGST}) - Enabled: ${event.enabled}`);
    });
  } else {
    console.log(`❌ No events found with state "available" or "Logoff" and enabled: true in the selected time range`);
  }
  
  return results;
}

/**
 * Extract first login and last logoff timestamps per agent for the given time range
 * @param {object[]} events - Array of all events
 * @returns {object} - Object with agent data containing first login and last logoff timestamps
 */
export function getAgentLoginLogoffTimes(events) {
  console.log(`\n🔍 EXTRACTING FIRST LOGIN & LAST LOGOFF TIMES PER AGENT:`);
  console.log(`📊 Total events to process: ${events.length}`);
  
  const agentData = new Map();
  
  // Process events to find login and logoff times per agent
  events.forEach(event => {
    if (!event) return;
    
    // Extract timestamp with fallback (handle case variations)
    const timestamp = event.Timestamp || event.timestamp || event.event_timestamp || event.time;
    if (!timestamp) {
      console.warn('⚠️ Event missing timestamp:', event);
      return;
    }
    
    // Extract agent identifiers with fallbacks
    const ext = event.ext || event.extension || event.agent_extension;
    const username = event.username || event.agent_name || event.name;
    const user_id = event.user_id || event.userId || event.agent_id;
    
    // Need at least extension and username
    if (!ext || !username) {
      console.warn('⚠️ Event missing ext or username:', { ext, username, event });
      return;
    }
    
    // Use extension as primary key if user_id is missing
    const agentKey = user_id ? `${user_id}_${ext}` : `unknown_${ext}`;
    
    if (!agentData.has(agentKey)) {
      agentData.set(agentKey, {
        user_id: user_id || 'unknown',
        username: username,
        ext: ext,
        firstLoginTime: null,
        firstLoginTimestamp: null,
        lastLogoffTime: null,
        lastLogoffTimestamp: null,
        loginEvents: [],
        logoffEvents: []
      });
    }
    
    const agent = agentData.get(agentKey);
    
    // Normalize enabled field (handle boolean, string, number)
    const enabled = event.enabled === true || event.enabled === 'true' || event.enabled === 1;
    const disabled = event.enabled === false || event.enabled === 'false' || event.enabled === 0;
    
    
    // Check for Login events: agent_reg with enabled: true
    if (event.event && event.event.toLowerCase() === 'agent_reg' && enabled) {
      agent.loginEvents.push({
        timestamp: timestamp,
        timestampGST: new Date(timestamp * 1000).toLocaleString('en-AE', {
          timeZone: 'Asia/Dubai',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      });
      console.log(`✅ Login event found for ${username} (${ext}) at timestamp ${timestamp}`);
    }
    
    // Check for Logout events: agent_reg with enabled: false
    if (event.event && event.event.toLowerCase() === 'agent_reg' && disabled) {
      agent.logoffEvents.push({
        timestamp: timestamp,
        timestampGST: new Date(timestamp * 1000).toLocaleString('en-AE', {
          timeZone: 'Asia/Dubai',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      });
      console.log(`✅ Logout event found for ${username} (${ext}) at timestamp ${timestamp}`);
    }
  });
  
  // Process each agent to find first login and last logoff
  agentData.forEach((agent, agentKey) => {
    // Sort login events by timestamp (ascending) to get first login
    if (agent.loginEvents.length > 0) {
      agent.loginEvents.sort((a, b) => a.timestamp - b.timestamp);
      const firstLogin = agent.loginEvents[0];
      agent.firstLoginTime = firstLogin.timestampGST;
      agent.firstLoginTimestamp = firstLogin.timestamp;
    }
    
    // Sort logoff events by timestamp (descending) to get last logoff
    if (agent.logoffEvents.length > 0) {
      agent.logoffEvents.sort((a, b) => b.timestamp - a.timestamp);
      const lastLogoff = agent.logoffEvents[0];
      agent.lastLogoffTime = lastLogoff.timestampGST;
      agent.lastLogoffTimestamp = lastLogoff.timestamp;
    }
    
    // Clean up temporary arrays
    delete agent.loginEvents;
    delete agent.logoffEvents;
  });
  
  const results = Array.from(agentData.values());
  
  // Log results for debugging
  console.log(`\n📋 AGENT LOGIN/LOGOFF SUMMARY:`);
  console.log(`👥 Total agents processed: ${results.length}`);
  
  results.forEach((agent, index) => {
    console.log(`${index + 1}. ${agent.username} (${agent.ext}):`);
    console.log(`   📅 First Login: ${agent.firstLoginTime || 'Not found'}`);
    console.log(`   📅 Last Logoff: ${agent.lastLogoffTime || 'Not found'}`);
  });
  
  return results;
}

/**
 * Calculate call summary statistics from agent data
 * @param {object} agentData - Object containing agent data with call statistics
 * @returns {object} - Summary with total calls, answered calls, and failed calls
 */
export function calculateCallSummary(agentData) {
  console.log(`\n📊 CALCULATING CALL SUMMARY STATISTICS:`);
  
  let totalCalls = 0;
  let totalAnsweredCalls = 0;
  let totalFailedCalls = 0;
  let activeAgents = 0;
  
  const agentSummaries = [];
  
  // Process each agent in the data
  Object.entries(agentData).forEach(([agentId, agent]) => {
    const calls = agent.total_calls || 0;
    const answered = agent.answered_calls || 0;
    const failed = calls - answered;
    
    // Only count agents with activity
    if (calls > 0) {
      activeAgents++;
      agentSummaries.push({
        id: agentId,
        name: agent.name,
        total_calls: calls,
        answered_calls: answered,
        failed_calls: failed
      });
    }
    
    totalCalls += calls;
    totalAnsweredCalls += answered;
    totalFailedCalls += failed;
  });
  
  // Sort agents by total calls (descending)
  agentSummaries.sort((a, b) => b.total_calls - a.total_calls);
  
  console.log(`👥 Total agents in dataset: ${Object.keys(agentData).length}`);
  console.log(`🎯 Active agents (with calls): ${activeAgents}`);
  console.log(`📞 Total calls: ${totalCalls}`);
  console.log(`✅ Answered calls: ${totalAnsweredCalls}`);
  console.log(`❌ Failed calls: ${totalFailedCalls}`);
  
  if (totalCalls > 0) {
    const answerRate = ((totalAnsweredCalls / totalCalls) * 100).toFixed(1);
    const failureRate = ((totalFailedCalls / totalCalls) * 100).toFixed(1);
    console.log(`📈 Answer rate: ${answerRate}%`);
    console.log(`📉 Failure rate: ${failureRate}%`);
  }
  
  return {
    summary: {
      totalCalls,
      answeredCalls: totalAnsweredCalls,
      failedCalls: totalFailedCalls,
      totalAgents: Object.keys(agentData).length,
      activeAgents,
      answerRate: totalCalls > 0 ? ((totalAnsweredCalls / totalCalls) * 100).toFixed(1) : '0.0',
      failureRate: totalCalls > 0 ? ((totalFailedCalls / totalCalls) * 100).toFixed(1) : '0.0'
    },
    agentDetails: agentSummaries
  };
}

/**
 * Display call summary in a formatted table
 * @param {object} callSummary - Result from calculateCallSummary function
 */
export function displayCallSummary(callSummary) {
  const { summary, agentDetails } = callSummary;
  
  console.log(`\n🎯 CALL CENTER SUMMARY REPORT`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📊 Overall Statistics:`);
  console.log(`   Total Calls:     ${summary.totalCalls.toLocaleString()}`);
  console.log(`   Answered Calls:  ${summary.answeredCalls.toLocaleString()}`);
  console.log(`   Failed Calls:    ${summary.failedCalls.toLocaleString()}`);
  console.log(`   Answer Rate:     ${summary.answerRate}%`);
  console.log(`   Failure Rate:    ${summary.failureRate}%`);
  console.log(`   Total Agents:    ${summary.totalAgents}`);
  console.log(`   Active Agents:   ${summary.activeAgents}`);
  
  if (agentDetails.length > 0) {
    console.log(`\n👥 ACTIVE AGENTS BREAKDOWN:`);
    console.log(`================================================================================`);
    console.log(`Agent Extension   Name                      Total    Answered   Failed   `);
    console.log(`--------------------------------------------------------------------------------`);
    
    agentDetails.forEach(agent => {
      const rate = agent.total_calls > 0 ? 
        `${((agent.answered_calls / agent.total_calls) * 100).toFixed(1)}%` : 
        '0.0%';
      
      console.log(
        `${(agent.id || 'N/A').toString().padEnd(15)} ${(agent.name || 'Unknown').substring(0, 24).padEnd(25)} ${String(agent.total_calls).padEnd(8)} ${String(agent.answered_calls).padEnd(10)} ${String(agent.failed_calls).padEnd(8)}`
      );
    });
  }
  
  console.log(`\n${'='.repeat(50)}`);
}

/**
 * Process agent data from JSON file or object and display call summary
 * @param {string|object} input - File path to JSON or agent data object
 */
export async function processAgentCallData(input) {
  let agentData;
  
  try {
    if (typeof input === 'string') {
      // If input is a file path, read and parse JSON
      const fs = await import('fs/promises');
      const fileContent = await fs.readFile(input, 'utf8');
      agentData = JSON.parse(fileContent);
      console.log(`📁 Loaded agent data from file: ${input}`);
    } else if (typeof input === 'object') {
      // If input is already an object, use it directly
      agentData = input;
      console.log(`📊 Processing agent data object`);
    } else {
      throw new Error('Input must be a file path (string) or agent data object');
    }
    
    const callSummary = calculateCallSummary(agentData);
    displayCallSummary(callSummary);
    
    return callSummary;
  } catch (error) {
    console.error(`❌ Error processing agent call data:`, error.message);
    throw error;
  }
}

/**
 * Fetch agent activity events, automatically traversing pages until completion.
 * @param {string} acct                         – tenant / account id.
 * @param {object} opts                         – query options.
 * @param {number} opts.startDate               – unix timestamp start of range.
 * @param {number} opts.endDate                 – unix timestamp end of range.
 * @param {string} [opts.timeRange]             – time range in format like 1d, 1w, 1h, etc.
 * @param {number} [opts.pageSize]              – number of records per page.
 * @param {string} [opts.startKey]              – start key for pagination.
 * @param {boolean} [opts.filterResults=true]   – whether to filter results or return raw events.
 * @returns {Promise<object[]>}                 – concatenated rows.
 */
export async function fetchAgentEvents(
  acct,
  { startDate, endDate, timeRange, pageSize = 2000, startKey, filterResults = true }
) {
  const token = await getUCToken(acct);
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'X-Account-ID': process.env.ACCOUNT_ID || acct,
    'X-User-Agent': 'portal'
  };

  const params = {
    startDate: String(startDate),
    endDate: String(endDate)
  };

  // Add potential parameters that might be needed for all agents
  if (timeRange) params.timeRange = timeRange;
  if (pageSize) params.pageSize = pageSize;
  if (startKey) params.start_key = startKey;  // Use start_key parameter name for pagination
  
  console.log(`🔍 API Parameters being sent:`, JSON.stringify(params, null, 2));

  const allRecords = [];
  let currentStartKey = startKey;

  // Try base server URL first (matches Stats API), then tenant subdomain
  const possibleBaseUrls = [
    `https://ira-spc-sj.ucprem.voicemeetme.com:9443`, // base server (same as Stats API)
    `https://${acct}.ira-spc-sj.ucprem.voicemeetme.com:9443` // tenant subdomain
  ];
  
  // Try multiple possible endpoint paths
  const possibleEndpoints = [
    '/api/v2/reports/callcenter/agents/activity/events',
    '/api/v2/callcenter/agents/activity/events', 
    '/ucp/v2/callcenter/agents/activity/events',
    '/api/v2/reports/callcenter/agents/events',
    '/api/v2/callcenter/agents/events',
    '/api/v2/agents/activity/events',
    '/api/v2/agents/events',
    '/api/callcenter/agents/activity/events',
    '/api/callcenter/agents/events'
  ];

  let response;
  let successfulEndpoint = null;
  let successfulBaseUrl = null;
  let pageCount = 0;
  const MAX_PAGES = 1000; // Safety limit to prevent infinite loops

  // First, find a working endpoint combination
  let endpointFound = false;
  for (const baseUrl of possibleBaseUrls) {
    console.log(`\n🌐 Trying base URL: ${baseUrl}`);
    
    for (const endpoint of possibleEndpoints) {
      console.log(`\n🔍 Trying endpoint: ${endpoint}`);
      
      for (let i = 0, delay = 1000; i < MAX_RETRIES; i++, delay *= 2) {
        try {
          const fullUrl = `${baseUrl}${endpoint}`;
          console.log(`🔍 Testing API call to: ${fullUrl}`);
          
          const testResponse = await axios.get(fullUrl, { 
            params: { ...params, pageSize: 10 }, // Small test request
            headers, 
            timeout: 720000, // Increased to 12 minutes (720 seconds)
            httpsAgent 
          });
          
          console.log(`✅ API test succeeded with status: ${testResponse.status}`);
          successfulEndpoint = endpoint;
          successfulBaseUrl = baseUrl;
          endpointFound = true;
          break;
        } catch (err) {
          const errorMsg = err.response?.status || err.message;
          console.error(`❌ Test attempt ${i + 1} failed:`, errorMsg);
          
          // For 500 errors, wait longer before retrying
          if (err.response?.status === 500) {
            console.log(`🔄 Server error (500) detected, waiting ${delay * 2}ms before retry...`);
            await new Promise(r => setTimeout(r, delay * 2));
          } else if (i < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, delay));
          }
          
          if (i === MAX_RETRIES - 1) {
            console.log(`❌ All test attempts failed for ${baseUrl}${endpoint}`);
          }
        }
      }
      
      if (endpointFound) break;
    }
    
    if (endpointFound) break;
  }
  
  if (!endpointFound) {
    throw new Error('All endpoint paths failed - no working agent events API found');
  }

  console.log(`🎉 Found working combination: ${successfulBaseUrl}${successfulEndpoint}`);

  // Now paginate through all data using the working endpoint
  let currentStartDate = startDate;
  
  while (pageCount < MAX_PAGES) {
    // Update params for this iteration
    params.startDate = String(currentStartDate);
    params.endDate = String(endDate); // Keep endDate constant
    
    // Remove start_key parameter - we use startDate instead
    if (params.start_key) {
      delete params.start_key;
    }

    try {
      const fullUrl = `${successfulBaseUrl}${successfulEndpoint}`;
      console.log(`📋 Page ${pageCount + 1}: Fetching from ${fullUrl}`);
      if (pageCount < 3 || pageCount % 10 === 0) {
        console.log(`📋 Query params:`, params);
      }
      
      response = await axios.get(fullUrl, { params, headers, timeout: 30000, httpsAgent });
      
      const { data } = response;
      const events = data.events || (Array.isArray(data) ? data : []);
      
      console.log(`📊 Page ${pageCount + 1}: Fetched ${events.length} records (total so far: ${allRecords.length + events.length})`);
      
      // If no events returned, we're done
      if (events.length === 0) {
        console.log(`✅ No more data - pagination complete. Total: ${allRecords.length} records`);
        break;
      }
      
      allRecords.push(...events);
      pageCount++;
      
      // Check for next_start_key in response data
      const newStartKey = data.next_start_key;
      
      // CRITICAL: Stop if next_start_key is null, undefined, or empty string
      if (!newStartKey || newStartKey === '' || newStartKey === null || newStartKey === undefined) {
        console.log(`✅ Pagination complete - next_start_key is "${newStartKey}". Total: ${allRecords.length} records in ${pageCount} pages`);
        break;
      }
      
      // Use next_start_key as the new startDate for next iteration
      currentStartDate = newStartKey;
      
      if (pageCount <= 3 || pageCount % 10 === 0) {
        console.log(`🔄 Page ${pageCount} complete. Next startDate: "${newStartKey}"`);
      }
      
    } catch (error) {
      console.error(`❌ Error on page ${pageCount + 1}:`, error.message);
      
      // Retry logic for transient errors including 500 errors
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout') || 
          error.message.includes('ECONNRESET') || error.message.includes('502') || 
          error.message.includes('503') || error.response?.status === 500) {
        const errorType = error.code === 'ECONNABORTED' ? 'timeout' : 
                         error.response?.status === 500 ? 'server error (500)' : 'transient';
        console.log(`🔄 Retrying page ${pageCount + 1} due to ${errorType}...`);
        
        // Wait longer for server errors
        const waitTime = error.response?.status === 500 ? 5000 : 3000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue; // Retry the same page
      }
      
      break; // Exit on non-transient errors
    }
  }

  if (pageCount >= MAX_PAGES) {
    console.log(`⚠️ Reached maximum page limit (${MAX_PAGES}). Total: ${allRecords.length} records`);
  }

  if (filterResults) {
    return getAvailableStateTimestamps(allRecords);
  } else {
    return allRecords;
  }
}

/**
 * Generate time slots based on start and end times
 * @param {string} startTime - Start time in HH:MM format (24-hour)
 * @param {string} endTime - End time in HH:MM format (24-hour)
 * @returns {Array} - Array of time slot objects with start and end times
 */
export function generateTimeSlots(startDateTime, endDateTime) {
  const slots = [];
  const startDate = new Date(startDateTime);
  const endDate = new Date(endDateTime);

  // Always generate full hourly slots (ignore minutes)
  const startHour = startDate.getHours();
  const endHour = endDate.getHours();

  const dateLabel = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  
  let currentHour = startHour;
  
  // Generate hourly slots from start hour to end hour
  while (currentHour < endHour) {
    const slotStart = `${String(currentHour).padStart(2, '0')}:00`;
    const nextHour = currentHour + 1;
    const slotEnd = `${String(nextHour).padStart(2, '0')}:00`;
    
    // Format for display (12-hour format with AM/PM)
    const formatTime = (hour) => {
      const period = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      return `${String(displayHour).padStart(2, '0')}:00 ${period}`;
    };
    
    slots.push({
      start24: slotStart,
      end24: slotEnd,
      startDisplay: formatTime(currentHour),
      endDisplay: formatTime(nextHour),
      label: `${dateLabel}, ${formatTime(currentHour)} - ${formatTime(nextHour)}`
    });
    
    currentHour = nextHour;
  }
  
  return slots;
}

/**
 * Calculate call summary by time slots for each agent
 * @param {object} agentData - Object containing agent data with call statistics
 * @param {Date} startDateTime - Start date and time object
 * @param {Date} endDateTime - End date and time object
 * @param {Array} events - Raw events data for time-based analysis (optional)
 * @returns {object} - Summary with time slot breakdowns per agent
 */
/**
 * Generate enhanced agent report using DATABASE TABLE data for a specific time slot
 * This function works with data that was already fetched and stored in agent_stats and agent_activity tables
 * @param {object} dbStatsData - Agent stats data from database (converted to API format)
 * @param {Array} dbActivitiesData - Agent activities data from database
 * @param {object} timeSlot - Specific time slot object with startTime and endTime
 * @param {Map} loginLogoffMap - Pre-calculated login/logout times for all agents (entire day)
 * @returns {object} - Report with agent time slot data
 */
export async function generateEnhancedAgentReportFromDB(dbStatsData, dbActivitiesData, timeSlot, loginLogoffMap = null) {
  console.log(`\n📊 GENERATING ENHANCED AGENT REPORT FROM DATABASE TABLES:`);
  console.log(`   Time Slot: ${timeSlot.slotLabel}`);
  console.log(`   Start: ${new Date(timeSlot.startTime * 1000).toISOString()}`);
  console.log(`   End: ${new Date(timeSlot.endTime * 1000).toISOString()}`);

  // The dbStatsData is already filtered for this specific time slot by populate-final-hourly.js
  // So we can use it directly without additional filtering
  const slotAgentData = dbStatsData;
  
  // Log call statistics for debugging
  const agentsWithCalls = Object.values(slotAgentData).filter(agent => agent.total_calls > 0);
  if (agentsWithCalls.length > 0) {
    console.log(`   📞 Agents with calls in this time slot:`);
    agentsWithCalls.forEach(agent => {
      console.log(`      - ${agent.name} (${agent.extension}): ${agent.total_calls} calls, ${agent.answered_calls} answered`);
    });
  }

  // The dbActivitiesData is already filtered for this specific time slot by populate-final-hourly.js
  const slotActivities = dbActivitiesData;

  console.log(`   📊 Using ${Object.keys(slotAgentData).length} agents and ${slotActivities.length} activities for this slot`);

  // Create DateTime objects for the slot
  const startDateTime = new Date(timeSlot.startTime * 1000);
  const endDateTime = new Date(timeSlot.endTime * 1000);

  // Use the existing generateEnhancedAgentReport function with filtered data
  return await generateEnhancedAgentReport(slotAgentData, startDateTime, endDateTime, slotActivities, loginLogoffMap);
}

const REPORT_STATE_EVENTS = new Map([
  ['agent_idle', 'idle_time'],
  ['agent_on_call', 'on_call_time'],
  ['agent_wrap_up', 'wrap_up_time'],
  ['agent_hold', 'hold_time'],
  ['agent_not_avail_state', 'not_available_time']
]);

const isEnabledEvent = (value) => value === true || value === 'true' || value === 1 || value === '1';

function fitAvailableStatesToRegisteredBudget(agent) {
  const fitted = { ...agent };
  const registered = Number(fitted.registered_time) || 0;
  const notAvailable = Math.min(registered, Number(fitted.not_available_time) || 0);
  fitted.not_available_time = notAvailable;
  if (fitted.not_available_detailed_report && typeof fitted.not_available_detailed_report === 'object') {
    let remaining = notAvailable;
    const cappedDetails = {};
    for (const [state, rawDuration] of Object.entries(fitted.not_available_detailed_report)) {
      const duration = Math.min(remaining, Math.max(0, Number(rawDuration) || 0));
      if (duration > 0) cappedDetails[state] = duration;
      remaining -= duration;
    }
    fitted.not_available_detailed_report = cappedDetails;
  }
  const availableBudget = Math.max(0, registered - notAvailable);
  const fields = ['idle_time', 'wrap_up_time', 'hold_time', 'on_call_time'];
  const total = fields.reduce((sum, field) => sum + (Number(fitted[field]) || 0), 0);
  let excess = Math.max(0, total - availableBudget);
  fitted._state_overlap_trimmed_seconds = excess;

  // Whole calls are the usual source of cross-hour overlap, followed by wrap
  // and hold. Preserve idle last because the stats API already clips it to the
  // requested interval in the observed responses.
  for (const field of ['on_call_time', 'wrap_up_time', 'hold_time', 'idle_time']) {
    if (excess <= 0) break;
    const value = Number(fitted[field]) || 0;
    const reduction = Math.min(value, excess);
    fitted[field] = value - reduction;
    excess -= reduction;
  }
  return fitted;
}

/**
 * The stats API does not include an in-progress state in its duration counters
 * when the requested interval ends in the middle of that state. Reconcile that
 * trailing interval from activity events so calls, wrap-up, hold, idle and AUX
 * states are clipped at the report boundary and attributed to the correct hour.
 *
 * Completed state durations remain sourced from the stats API. This deliberately
 * only fills the positive registered-time remainder, preventing double counting
 * when the API has already included an active state.
 */
export function reconcileTrailingAgentState(agent, agentEvents, slotStart, slotEnd) {
  const reconciled = {
    ...agent,
    not_available_detailed_report: {
      ...(agent.not_available_detailed_report || {})
    }
  };

  const registeredTime = Number(reconciled.registered_time) || 0;
  const timeline = calculateClippedEventStateDurations(agentEvents, slotStart, slotEnd);
  const connectTime = Number(reconciled.total_connect_seconds) || 0;
  const requiredCoverage = Math.max(0, registeredTime - connectTime - 2);

  // When the event timeline covers the registered interval (apart from the API's
  // explicit connect/transition seconds), it is authoritative. Unlike aggregate
  // call statistics, these intervals are clipped at both hourly boundaries.
  if (timeline.coveredSeconds >= requiredCoverage && timeline.coveredSeconds > 0) {
    reconciled.idle_time = timeline.idle_time;
    reconciled.wrap_up_time = timeline.wrap_up_time;
    reconciled.hold_time = timeline.hold_time;
    reconciled.on_call_time = timeline.on_call_time;
    reconciled.not_available_time = timeline.not_available_time;
    reconciled.not_available_detailed_report = timeline.not_available_detailed_report;
    reconciled._state_reconciliation_source = 'event_timeline';
    reconciled._state_covered_seconds = timeline.coveredSeconds;
    return fitAvailableStatesToRegisteredBudget(reconciled);
  }

  reconciled._state_reconciliation_source = 'stats_fallback';
  reconciled._state_covered_seconds = timeline.coveredSeconds;

  const accountedTime = [
    'idle_time',
    'wrap_up_time',
    'hold_time',
    'on_call_time',
    'not_available_time'
  ].reduce((sum, field) => sum + (Number(reconciled[field]) || 0), 0);
  let remainder = Math.max(0, registeredTime - accountedTime);

  if (remainder === 0 || !Array.isArray(agentEvents) || agentEvents.length === 0) {
    return fitAvailableStatesToRegisteredBudget(reconciled);
  }

  const relevantEvents = agentEvents
    .filter(event => {
      const timestamp = Number(event.Timestamp ?? event.timestamp);
      return REPORT_STATE_EVENTS.has(String(event.event || '').toLowerCase()) &&
        Number.isFinite(timestamp) && timestamp >= slotStart && timestamp < slotEnd;
    })
    .sort((a, b) => Number(a.Timestamp ?? a.timestamp) - Number(b.Timestamp ?? b.timestamp));

  // At a transition timestamp the API can emit both the new enabled event and
  // the old disabled event. The last enabled state that has no later end or
  // replacement is the state still active at the slot boundary.
  let activeEvent = null;
  for (const event of relevantEvents) {
    const eventType = String(event.event || '').toLowerCase();
    if (isEnabledEvent(event.enabled)) {
      if (eventType === 'agent_hold' || !activeEvent || activeEvent.eventType !== 'agent_hold') {
        activeEvent = { event, eventType };
      }
    } else if (activeEvent && activeEvent.eventType === eventType) {
      activeEvent = null;
    }
  }

  if (!activeEvent) return fitAvailableStatesToRegisteredBudget(reconciled);

  const activeStart = Math.max(slotStart, Number(activeEvent.event.Timestamp ?? activeEvent.event.timestamp));
  const trailingDuration = Math.max(0, slotEnd - activeStart);
  const supplement = Math.min(remainder, trailingDuration);
  if (supplement === 0) return fitAvailableStatesToRegisteredBudget(reconciled);

  const field = REPORT_STATE_EVENTS.get(activeEvent.eventType);
  reconciled[field] = (Number(reconciled[field]) || 0) + supplement;
  remainder -= supplement;

  if (field === 'not_available_time') {
    const state = activeEvent.event.state;
    if (state && String(state).toLowerCase() !== 'none') {
      reconciled.not_available_detailed_report[state] =
        (Number(reconciled.not_available_detailed_report[state]) || 0) + supplement;
    }
  }

  return fitAvailableStatesToRegisteredBudget(reconciled);
}

const EVENT_STATE_PRIORITY = ['agent_hold', 'agent_not_avail_state', 'agent_wrap_up', 'agent_on_call', 'agent_idle'];

function eventTimestamp(event) {
  return Number(event.Timestamp ?? event.timestamp);
}

function eventEnabled(event) {
  return isEnabledEvent(event.enabled);
}

function stateField(eventType) {
  return REPORT_STATE_EVENTS.get(eventType) || null;
}

/** Build exclusive state durations from raw transitions and clip them to a slot. */
export function calculateClippedEventStateDurations(agentEvents, slotStart, slotEnd) {
  const totals = {
    idle_time: 0,
    wrap_up_time: 0,
    hold_time: 0,
    on_call_time: 0,
    not_available_time: 0,
    not_available_detailed_report: {},
    coveredSeconds: 0
  };
  if (!Array.isArray(agentEvents) || slotEnd <= slotStart) return totals;

  const events = agentEvents
    .filter(event => {
      const type = String(event.event || '').toLowerCase();
      const ts = eventTimestamp(event);
      return REPORT_STATE_EVENTS.has(type) && Number.isFinite(ts) && ts < slotEnd;
    })
    .sort((a, b) => eventTimestamp(a) - eventTimestamp(b));

  const flags = new Map(EVENT_STATE_PRIORITY.map(type => [type, false]));
  let activeType = null;
  let activeState = null;

  const chooseActive = () => EVENT_STATE_PRIORITY.find(type => flags.get(type)) || null;
  const activate = (event) => {
    const type = String(event.event || '').toLowerCase();
    if (type === 'agent_hold') {
      flags.set(type, true);
    } else if (type === 'agent_idle') {
      // Returning to idle closes every foreground state, including AUX states
      // whose API stream sometimes omits an explicit enabled=false event.
      for (const primary of EVENT_STATE_PRIORITY.slice(1)) flags.set(primary, false);
      flags.set(type, true);
    } else if (type === 'agent_not_avail_state') {
      flags.set('agent_idle', false);
      flags.set(type, true);
    } else if (type === 'agent_wrap_up') {
      flags.set('agent_idle', false);
      flags.set('agent_on_call', false);
      flags.set(type, true);
    } else if (type === 'agent_on_call') {
      flags.set('agent_idle', false);
      flags.set('agent_wrap_up', false);
      flags.set(type, true);
    }
    activeType = chooseActive();
    if (type === 'agent_not_avail_state') activeState = event.state;
    else if (activeType !== 'agent_not_avail_state') activeState = null;
  };
  const deactivate = (event) => {
    const type = String(event.event || '').toLowerCase();
    flags.set(type, false);
    // Some historical rows lost the simultaneous agent_on_call=true event due
    // to the former database unique key. Leaving idle still proves that call or
    // dialing activity began; a same-timestamp AUX/wrap event will replace it.
    if (type === 'agent_idle' && !chooseActive()) {
      flags.set('agent_on_call', true);
    }
    activeType = chooseActive();
    if (activeType !== 'agent_not_avail_state') activeState = null;
  };

  // Establish the state at slot start from all earlier transitions.
  for (const event of events) {
    if (eventTimestamp(event) >= slotStart) break;
    if (eventEnabled(event)) activate(event); else deactivate(event);
  }

  const inSlot = events.filter(event => eventTimestamp(event) >= slotStart);
  const groups = new Map();
  for (const event of inSlot) {
    const ts = eventTimestamp(event);
    if (!groups.has(ts)) groups.set(ts, []);
    groups.get(ts).push(event);
  }

  const addDuration = (type, state, seconds) => {
    if (!type || seconds <= 0) return;
    const field = stateField(type);
    totals[field] += seconds;
    totals.coveredSeconds += seconds;
    if (field === 'not_available_time' && state && String(state).toLowerCase() !== 'none') {
      totals.not_available_detailed_report[state] =
        (totals.not_available_detailed_report[state] || 0) + seconds;
    }
  };

  let cursor = slotStart;
  for (const [ts, sameTimeEvents] of groups) {
    if (ts > cursor) {
      // A disabled event proves which state occupied an otherwise unknown
      // interval immediately before it (important at the first report slot).
      if (!activeType) {
        const ending = sameTimeEvents.find(event => !eventEnabled(event));
        if (ending) {
          activeType = String(ending.event || '').toLowerCase();
          activeState = activeType === 'agent_not_avail_state' ? ending.state : null;
        }
      }
      addDuration(activeType, activeState, ts - cursor);
    }

    // End old states first, then enable the new state at the same timestamp.
    for (const event of sameTimeEvents.filter(event => !eventEnabled(event))) deactivate(event);
    for (const event of sameTimeEvents.filter(eventEnabled)) activate(event);
    cursor = ts;
  }
  addDuration(activeType, activeState, slotEnd - cursor);
  return totals;
}

export async function generateEnhancedAgentReport(agentData, startDateTime, endDateTime, events, loginLogoffMap = null) {
  console.log(`\n📊 GENERATING ENHANCED AGENT REPORT (${startDateTime.toISOString()} - ${endDateTime.toISOString()}):`);

  // Check if this is a single time slot (called from populate-final-hourly.js)
  const timeDiffHours = (endDateTime - startDateTime) / (1000 * 60 * 60);
  const isSingleSlot = timeDiffHours <= 1;
  
  let timeSlots;
  if (isSingleSlot) {
    // Create a single time slot for the exact time range provided
    const startHour = startDateTime.getHours();
    const endHour = endDateTime.getHours();
    const dateLabel = `${String(startDateTime.getDate()).padStart(2, '0')}/${String(startDateTime.getMonth() + 1).padStart(2, '0')}/${startDateTime.getFullYear()}`;
    
    const formatTime = (hour) => {
      const period = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      return `${String(displayHour).padStart(2, '0')}:00 ${period}`;
    };
    
    timeSlots = [{
      start24: `${String(startHour).padStart(2, '0')}:00`,
      end24: `${String(endHour).padStart(2, '0')}:00`,
      startDisplay: formatTime(startHour),
      endDisplay: formatTime(endHour),
      label: `${dateLabel}, ${formatTime(startHour)} - ${formatTime(endHour)}`
    }];
  } else {
    // Generate multiple time slots for the full range
    timeSlots = generateTimeSlots(startDateTime, endDateTime);
  }
  
  const agentTimeSlots = [];

  // Helper to format seconds into HH:MM:SS
  const formatSeconds = (seconds) => {
    if (seconds == null || isNaN(seconds)) return '00:00:00';
    return new Date(seconds * 1000).toISOString().substr(11, 8);
  };

  // Helper to get login time from agent data registered_time
  const getLoginTimeFromRegisteredTime = (agent) => {
    const registeredTime = agent.registered_time || 0;
    return formatSeconds(registeredTime);
  };

  // Helper to get idle time from agent data
  const getIdleTimeFromAgentData = (agent) => {
    const idleTime = agent.idle_time || 0;
    return formatSeconds(idleTime);
  };

  // Helper to get not available time from agent data
  const getNotAvailableTimeFromAgentData = (agent) => {
    const notAvailableTime = agent.not_available_time || 0;
    return formatSeconds(notAvailableTime);
  };

  // Available Time is the registered duration remaining after all Not Available/AUX time.
  const getAvailableTimeFromAgentData = (agent) => {
    const registeredTime = Number(agent.registered_time) || 0;
    const notAvailableTime = Number(agent.not_available_time) || 0;
    return formatSeconds(Math.max(0, registeredTime - notAvailableTime));
  };

  // Helper to extract custom states from agent's not_available_detailed_report
  const getCustomStatesFromAgentData = (agent) => {
    if (!agent.not_available_detailed_report || typeof agent.not_available_detailed_report !== 'object') {
      return '';
    }

    const detailedReport = agent.not_available_detailed_report;
    const states = [];

    // Convert each state and its duration to the format: [state_name : duration_seconds]
    for (const [stateName, durationSeconds] of Object.entries(detailedReport)) {
      if (durationSeconds > 0) {
        states.push(`[${stateName} : ${durationSeconds}]`);
      }
    }

    return states.join(', ');
  };

  // Helper to extract individual custom states from the combined custom states string
  const getIndividualCustomStatesFromCustomStatesString = (customStatesString) => {
    const defaultStates = {
      customStateShortBreak: '00:00:00',
      customStateBioBreak: '00:00:00',
      customStateLunchBreak: '00:00:00',
      customStateLogoff: '00:00:00',
      customStateMeeting: '00:00:00',
      customStateTraining: '00:00:00',
      customStateTicketB2B: '00:00:00',
      customStateTicketB2C: '00:00:00',
      customStateChat: '00:00:00',
      customStateLogIn: '00:00:00'
    };

    if (!customStatesString || customStatesString.trim() === '') {
      return defaultStates;
    }

    // Map state names to our database column names
    const stateMapping = {
      'Short Break': 'customStateShortBreak',
      'Bio Break': 'customStateBioBreak', 
      'Lunch Break': 'customStateLunchBreak',
      'Logoff': 'customStateLogoff',
      'Meeting': 'customStateMeeting',
      'training': 'customStateTraining',
      'Ticket_B2B': 'customStateTicketB2B',
      'Ticket_B2C': 'customStateTicketB2C',
      'Chat': 'customStateChat',
      'Log In': 'customStateLogIn'
    };

    // Parse format: [state_name : duration_seconds], [state_name : duration_seconds], ...
    const stateMatches = customStatesString.match(/\[([^:]+)\s*:\s*(\d+)\]/g);
    
    if (stateMatches) {
      stateMatches.forEach(match => {
        const parts = match.slice(1, -1).split(':'); // Remove brackets and split
        const stateName = parts[0].trim();
        const durationSeconds = parseInt(parts[1].trim());
        
        const mappedKey = stateMapping[stateName];
        if (mappedKey && durationSeconds > 0) {
          defaultStates[mappedKey] = formatSeconds(durationSeconds);
        }
      });
    }

    return defaultStates;
  };

  // Helper to extract individual custom states from agent's not_available_detailed_report
  const getIndividualCustomStatesFromAgentData = (agent) => {
    // First try to extract from not_available_detailed_report (for direct API calls)
    if (agent.not_available_detailed_report && typeof agent.not_available_detailed_report === 'object') {
      const defaultStates = {
        customStateShortBreak: '00:00:00',
        customStateBioBreak: '00:00:00',
        customStateLunchBreak: '00:00:00',
        customStateLogoff: '00:00:00',
        customStateMeeting: '00:00:00',
        customStateTraining: '00:00:00',
        customStateTicketB2B: '00:00:00',
        customStateTicketB2C: '00:00:00',
        customStateChat: '00:00:00',
        customStateLogIn: '00:00:00'
      };

      const detailedReport = agent.not_available_detailed_report;
      
      // Map API state names to our database column names
      const stateMapping = {
        'Short Break': 'customStateShortBreak',
        'Bio Break': 'customStateBioBreak', 
        'Lunch Break': 'customStateLunchBreak',
        'Logoff': 'customStateLogoff',
        'Meeting': 'customStateMeeting',
        'training': 'customStateTraining',
        'Ticket_B2B': 'customStateTicketB2B',
        'Ticket_B2C': 'customStateTicketB2C',
        'Chat': 'customStateChat',
        'Log In': 'customStateLogIn'
      };

      // Convert each state duration from seconds to HH:MM:SS format
      for (const [stateName, durationSeconds] of Object.entries(detailedReport)) {
        const mappedKey = stateMapping[stateName];
        if (mappedKey && durationSeconds > 0) {
          defaultStates[mappedKey] = formatSeconds(durationSeconds);
        }
      }

      return defaultStates;
    }

    // Fallback: try to extract from the combined custom states string (for database-sourced data)
    const customStatesString = getCustomStatesFromAgentData(agent);
    return getIndividualCustomStatesFromCustomStatesString(customStatesString);
  };


  // Group events by agent extension for quick lookup
  const eventsByAgent = new Map();
  if (events) {
    for (const event of events) {
      if (!eventsByAgent.has(event.ext)) {
        eventsByAgent.set(event.ext, []);
      }
      eventsByAgent.get(event.ext).push(event);
    }
  }

  // Get login/logoff times for all agents at once
  // Use pre-calculated map if provided (from populate script), otherwise calculate from events
  if (!loginLogoffMap) {
    const loginLogoffData = getAgentLoginLogoffTimes(events || []);
    loginLogoffMap = new Map(loginLogoffData.map(item => [item.ext, item]));
  }

  // Convert agentData object to array format
  const agentArray = Object.entries(agentData).map(([extension, data]) => ({
    extension,
    ...data
  }));

  for (const originalAgent of agentArray) {
    const originalAgentEvents = eventsByAgent.get(originalAgent.extension) || [];
    const agent = reconcileTrailingAgentState(
      originalAgent,
      originalAgentEvents,
      Math.floor(startDateTime.getTime() / 1000),
      Math.floor(endDateTime.getTime() / 1000)
    );
    const agentId = agent.extension;
    const agentName = agent.name || 'Unknown Agent';
    const totalCalls = agent.total_calls || 0;
    const answeredCalls = agent.answered_calls || 0;

    const agentLoginInfo = loginLogoffMap.get(agentId) || {};

    // Smart call assignment: only assign calls to time slots with actual activity
    // Activity indicators: custom states, login time, or not available time
    let slotsWithActivity = [];
    
    // First pass: identify which slots have activity
    for (let i = 0; i < timeSlots.length; i++) {
      const slot = timeSlots[i];
      const agentEventsForSlot = eventsByAgent.get(agentId) || [];
      
      // Create proper slot start/end DateTime objects for this specific slot
      const slotStartDateTime = new Date(startDateTime.getTime() + (i * 60 * 60 * 1000)); // Add i hours
      const slotEndDateTime = new Date(slotStartDateTime.getTime() + (60 * 60 * 1000)); // Add 1 hour
      
      const customStates = getCustomStatesFromAgentData(agent); // Use API's not_available_detailed_report
      const slotLoginTime = getLoginTimeFromRegisteredTime(agent); // Use registered_time from agent data
      const slotNotAvailableTime = getNotAvailableTimeFromAgentData(agent); // Use not_available_time from agent data
      
      // Check if this slot has any activity
      const hasActivity = customStates.length > 0 || 
                         slotLoginTime !== '00:00:00' || 
                         slotNotAvailableTime !== '00:00:00';
      
      // Debug logging for Test MultyComm
      if (agentName === 'Test MultyComm') {
        console.log(`🔍 SLOT ${i}: ${slot.label}`);
        console.log(`   Custom States: "${customStates}" (length: ${customStates.length})`);
        console.log(`   Login Time: "${slotLoginTime}"`);
        console.log(`   Not Available: "${slotNotAvailableTime}"`);
        console.log(`   Has Activity: ${hasActivity}`);
      }
      
      
      if (hasActivity) {
        slotsWithActivity.push(i);
      }
    }
    
    // If no slots have activity, assign calls to the first slot (fallback)
    if (slotsWithActivity.length === 0 && totalCalls > 0) {
      slotsWithActivity = [0];
      
      // Debug logging for agents with calls but no activity
      if (agentName === 'Test MultyComm') {
        console.log(`⚠️  FALLBACK: ${agentName} has ${totalCalls} calls but no active slots detected`);
        console.log(`   Assigning all calls to first slot as fallback`);
      }
    } else if (agentName === 'Test MultyComm' && totalCalls > 0) {
      console.log(`✅ ACTIVITY DETECTED: ${agentName} has ${totalCalls} calls`);
      console.log(`   Active slots: [${slotsWithActivity.join(', ')}] out of ${timeSlots.length} total slots`);
    }
    
    
    // Distribute calls only among slots with activity
    let callsPerSlot, answeredPerSlot, remainder, answeredRemainder;
    
    if (isSingleSlot || slotsWithActivity.length <= 1) {
      // Single slot or only one active slot: assign all calls to that slot
      callsPerSlot = totalCalls;
      answeredPerSlot = answeredCalls;
      remainder = 0;
      answeredRemainder = 0;
    } else {
      // Multiple active slots: distribute calls among active slots only
      callsPerSlot = slotsWithActivity.length > 0 ? Math.floor(totalCalls / slotsWithActivity.length) : 0;
      answeredPerSlot = slotsWithActivity.length > 0 ? Math.floor(answeredCalls / slotsWithActivity.length) : 0;
      remainder = slotsWithActivity.length > 0 ? totalCalls % slotsWithActivity.length : 0;
      answeredRemainder = slotsWithActivity.length > 0 ? answeredCalls % slotsWithActivity.length : 0;
    }

    for (let i = 0; i < timeSlots.length; i++) {
      const slot = timeSlots[i];
      
      // Only assign calls to slots with activity
      const isActiveSlot = slotsWithActivity.includes(i);
      const activeSlotIndex = slotsWithActivity.indexOf(i);
      
      let slotCalls, slotAnswered, slotFailed;
      if (isActiveSlot) {
        slotCalls = callsPerSlot + (activeSlotIndex < remainder ? 1 : 0);
        slotAnswered = answeredPerSlot + (activeSlotIndex < answeredRemainder ? 1 : 0);
        slotFailed = slotCalls - slotAnswered;
      } else {
        // No calls for inactive slots
        slotCalls = 0;
        slotAnswered = 0;
        slotFailed = 0;
      }
      
      // Calculate AHT (Average Handle Time) = (talked_time + wrap_up_time + hold_time) / total_calls
      const talkedTimeSeconds = agent.talked_time || agent.on_call_time || 0;
      const wrapUpTimeSeconds = agent.wrap_up_time || 0;
      const holdTimeSeconds = agent.hold_time || 0;
      const totalHandleTimeSeconds = talkedTimeSeconds + wrapUpTimeSeconds + holdTimeSeconds;
      const aht = totalCalls > 0 ? (totalHandleTimeSeconds / totalCalls) : 0;
      const ahtFormatted = formatSeconds(aht);
      
      console.log(`Agent ${agentName} AHT calculation:`, {
        talked_time: talkedTimeSeconds,
        wrap_up_time: wrapUpTimeSeconds,
        hold_time: holdTimeSeconds,
        total_calls: totalCalls,
        aht: aht,
        ahtFormatted: ahtFormatted
      });

      const agentEventsForSlot = eventsByAgent.get(agentId) || [];
      const customStates = getCustomStatesFromAgentData(agent); // Use API's not_available_detailed_report
      const individualCustomStates = getIndividualCustomStatesFromAgentData(agent); // Extract individual custom states
      
      // Use registered_time from agent data as login time instead of calculating from events
      const slotLoginTime = getLoginTimeFromRegisteredTime(agent);
      const slotAvailableTime = getAvailableTimeFromAgentData(agent);
      const slotIdleTime = getIdleTimeFromAgentData(agent);
      const slotNotAvailableTime = getNotAvailableTimeFromAgentData(agent);

      agentTimeSlots.push({
        agentId,
        agentName,
        extension: agentId,
        timeSlot: slot.label,
        totalCalls: slotCalls,
        answeredCalls: slotAnswered,
        failedCalls: slotFailed,
        aht: ahtFormatted,
        loginTime: slotLoginTime,
        availableTime: slotAvailableTime,
        idleTime: slotIdleTime,
        firstLoginTime: agentLoginInfo.firstLoginTime || '',
        lastLogoutTime: agentLoginInfo.lastLogoffTime || '',
        notAvailableTime: slotNotAvailableTime,
        wrapUpTime: formatSeconds(agent.wrap_up_time),
        holdTime: formatSeconds(agent.hold_time),
        onCallTime: formatSeconds(agent.on_call_time),
        customStates: customStates,
        // Individual custom states
        ...individualCustomStates
      });
    }
  }

  agentTimeSlots.sort((a, b) => {
    if (a.agentName !== b.agentName) {
      return a.agentName.localeCompare(b.agentName);
    }
    const aSlotIndex = timeSlots.findIndex(slot => slot.label === a.timeSlot);
    const bSlotIndex = timeSlots.findIndex(slot => slot.label === b.timeSlot);
    return aSlotIndex - bSlotIndex;
  });

  console.log(`⏰ Generated ${timeSlots.length} time slots`);
  console.log(`👥 Processing ${agentArray.length} agents`);
  console.log(`📋 Created ${agentTimeSlots.length} agent-slot combinations`);

  return {
    timeSlots,
    agentTimeSlots,
    summary: {
      totalSlots: timeSlots.length,
      totalAgents: agentData.length,
      totalRecords: agentTimeSlots.length
    }
  };
}

/**
 * Display time slot summary in the requested format
 * @param {object} timeSlotSummary - Result from calculateTimeSlotSummary function
 */
export function displayTimeSlotSummary(timeSlotSummary) {
  const { agentTimeSlots, summary } = timeSlotSummary;
  
  console.log(`\n🎯 AGENT ACTIVITY BY TIME SLOTS`);
  console.log(`${'='.repeat(80)}`);
  console.log(`📊 Summary: ${summary.totalAgents} agents across ${summary.totalSlots} time slots`);
  console.log(`📋 Total records: ${summary.totalRecords}`);
  console.log(`\n👥 AGENT TIME SLOT BREAKDOWN:`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Agent Name                    Time Slot              Calls  Ans  Fail  Rate`);
  console.log(`${'-'.repeat(80)}`);
  
  agentTimeSlots.forEach(record => {
    const name = record.agentName.substring(0, 28).padEnd(29);
    const timeSlot = record.timeSlot.padEnd(22);
    const calls = String(record.totalCalls).padStart(5);
    const answered = String(record.answeredCalls).padStart(4);
    const failed = String(record.failedCalls).padStart(4);
    const rate = record.answerRate.padStart(6);
    
    console.log(`${name} ${timeSlot} ${calls} ${answered} ${failed} ${rate}`);
  });
  
  console.log(`\n${'='.repeat(80)}`);
}

/**
 * Process agent data and display time slot summary
 * @param {string|object} input - File path to JSON or agent data object
 * @param {string} startTime - Start time in HH:MM format (default: "08:20")
 * @param {string} endTime - End time in HH:MM format (default: "13:35")
 */
export async function processAgentTimeSlotData(input, startTime = "08:20", endTime = "13:35") {
  try {
    let agentData;
    
    if (typeof input === 'string') {
      // Read from file
      const fs = await import('fs/promises');
      const fileContent = await fs.readFile(input, 'utf8');
      agentData = JSON.parse(fileContent);
      console.log(`📁 Loaded agent data from: ${input}`);
    } else if (typeof input === 'object' && input !== null) {
      // Use provided object
      agentData = input;
      console.log(`📊 Processing provided agent data object`);
    } else {
      throw new Error('Input must be a file path (string) or agent data object');
    }
    
    const timeSlotSummary = calculateTimeSlotSummary(agentData, startTime, endTime);
    displayTimeSlotSummary(timeSlotSummary);
    
    return timeSlotSummary;
  } catch (error) {
    console.error(`❌ Error processing agent time slot data:`, error.message);
    throw error;
  }
}

/**
 * CLI interface for testing
 */
async function cli() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
🎯 Agent Events CLI Tool

USAGE:
  Events Mode (fetch agent events):
    node agentEvents.js <tenant> <startTimestamp> <endTimestamp>
    
  Summary Mode (process call summary from JSON):
    node agentEvents.js summary <jsonFile> <startTimestamp> <endTimestamp> [summary]
    
  Time Slots Mode (process time slot breakdown):
    node agentEvents.js timeslots <jsonFile> <startTime> <endTime>
    node agentEvents.js timeslots <jsonFile>  # Uses default 08:20-13:35

EXAMPLES:
  # Fetch events for tenant 'mc_int' for specific time range
  node agentEvents.js mc_int 1753251240 1753258440
  
  # Generate call summary from JSON file
  node agentEvents.js summary agent_data.json 0 0 summary
  
  # Generate time slot breakdown with custom times
  node agentEvents.js timeslots agent_data.json 08:20 13:35
  
  # Generate time slot breakdown with default times (08:20-13:35)
  node agentEvents.js timeslots agent_data.json

MODES:
  events    - Fetch agent activity events from API
  summary   - Process call summary statistics from JSON file
  timeslots - Generate hourly time slot breakdown per agent
    `);
    return;
  }

  const mode = args[0];

  try {
    if (mode === 'summary') {
      // Summary mode: node agentEvents.js summary <jsonFile> <startTimestamp> <endTimestamp> [summary]
      const [, jsonFile] = args;
      if (!jsonFile) {
        console.error('❌ JSON file path required for summary mode');
        return;
      }
      await processAgentCallData(jsonFile);
      
    } else if (mode === 'timeslots') {
      // Time slots mode: node agentEvents.js timeslots <jsonFile> [startTime] [endTime]
      const [, jsonFile, startTime = "08:20", endTime = "13:35"] = args;
      if (!jsonFile) {
        console.error('❌ JSON file path required for timeslots mode');
        return;
      }
      console.log(`🕐 Processing time slots from ${startTime} to ${endTime}`);
      await processAgentTimeSlotData(jsonFile, startTime, endTime);
      
    } else {
      // Events mode: node agentEvents.js <tenant> <startTimestamp> <endTimestamp>
      const [tenant, startTimestamp, endTimestamp] = args;
      if (!tenant || !startTimestamp || !endTimestamp) {
        console.error('❌ Missing required arguments: tenant, startTimestamp, endTimestamp');
        return;
      }

      const startDate = parseInt(startTimestamp);
      const endDate = parseInt(endTimestamp);
      
      console.log(`🔍 Fetching agent events for tenant: ${tenant}`);
      console.log(`📅 Time range: ${new Date(startDate * 1000).toISOString()} to ${new Date(endDate * 1000).toISOString()}`);
      
      const events = await fetchAgentEvents(tenant, { startDate, endDate });
      
      if (events && events.length > 0) {
        console.log(`✅ Successfully fetched ${events.length} events`);
        console.log(`📊 Sample event:`, JSON.stringify(events[0], null, 2));
        
        // You can add additional processing here if needed
        const loginTimes = getAgentLoginLogoffTimes(events);
        if (loginTimes.length > 0) {
          console.log(`\n👥 Agent Login/Logoff Summary:`);
          loginTimes.forEach(agent => {
            console.log(`${agent.agentName} (${agent.agentId}): ${agent.loginTime} - ${agent.logoffTime}`);
          });
        }
      } else {
        console.log(`⚠️  No events found for the specified time range`);
      }
    }
  } catch (error) {
    console.error(`❌ CLI Error:`, error.message);
    if (error.response?.data) {
      console.error(`📄 Response data:`, JSON.stringify(error.response.data, null, 2));
    }
  }
}
