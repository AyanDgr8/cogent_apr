// agentActivityFetcher.js
// Comprehensive agent activity events fetcher with complete pagination
// Based on the reference apiDataFetcher.js pattern

import dotenv from 'dotenv';
dotenv.config();

import { getApiKeyHeaders } from './tokenService.js';
import { getTenantConfig } from './tenantConfig.js';
import { insertAgentActivity } from './database/config.js';

/**
 * Fetch all agent activity events with hourly intervals and complete pagination
 * Continues until next_start_key becomes null for each hour
 * @param {string} tenant - Tenant identifier
 * @param {Object} params - API parameters (startDate, endDate, etc.)
 * @returns {Promise<Object>} - Summary of fetched data
 */
export async function fetchAllAgentActivityEvents(tenant, params) {
  console.log('🚀 Starting agent activity events fetch with hourly intervals and pagination...');
  
  const startTime = Date.now();
  const url = '/api/v2/reports/callcenter/agents/activity/events';
  
  // Import hourly intervals utility
  const { createHourlyIntervals } = await import('./utils/timeIntervals.js');
  
  // Create hourly intervals for the time range
  const hourlyIntervals = createHourlyIntervals(params.startDate, params.endDate);
  
  let totalRecords = 0;
  let totalPages = 0;
  
  console.log(`⏰ Processing ${hourlyIntervals.length} hourly intervals...`);
  
  // Process each hourly interval
  for (const interval of hourlyIntervals) {
    console.log(`\n📅 Processing interval ${interval.interval}: ${interval.startDateTime.toLocaleString()} → ${interval.endDateTime.toLocaleString()} (${interval.duration}m)`);
    
    // Fetch all pages for this specific hour
    const intervalResult = await fetchIntervalWithPagination(url, tenant, {
      startDate: interval.startTime,
      endDate: interval.endTime
    });
    
    totalRecords += intervalResult.records;
    totalPages += intervalResult.pages;
    
    console.log(`   ✅ Interval ${interval.interval}: ${intervalResult.records} events in ${intervalResult.pages} pages`);
  }
  
  const totalTime = Date.now() - startTime;
  
  const summary = {
    endpoint: 'agent_activity_events',
    totalRecords,
    totalPages,
    totalTime,
    success: true
  };
  
  console.log(`🎉 Agent activity events fetch completed in ${totalTime}ms`);
  console.log(`📊 Final summary: ${totalRecords} events across ${totalPages} pages in ${hourlyIntervals.length} hourly intervals`);
  
  return summary;
}

/**
 * Helper function to fetch a single page from the agent activity events API
 * @param {string} url - API endpoint URL
 * @param {string} tenant - Tenant identifier  
 * @param {Object} params - Request parameters
 * @returns {Promise<Object>} - API response data
 */
async function fetchPage(url, tenant, params) {
  const tenantConfig = getTenantConfig(tenant);
  const headers = getApiKeyHeaders(tenant);
  
  // Format parameters for API compatibility
  const formattedParams = { ...params };
  
  // Add pageSize parameter to maximize efficiency
  formattedParams.pageSize = 2000;
  
  // Use the actual account ID from env for API calls
  const queryParams = new URLSearchParams({
    account: tenantConfig.account_id,
    ...formattedParams
  });
  
  const fullUrl = `${tenantConfig.base_url}${url}?${queryParams}`;
  
  // Debug logging (truncate for readability)
  const truncatedUrl = fullUrl.length > 200 ? fullUrl.substring(0, 200) + '...' : fullUrl;
  console.log(`🔍 API Request: ${truncatedUrl}`);
  
  try {
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: 30000 // 30 second timeout
    });
    
    console.log(`📡 Response: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API Error Response Body:`, errorText);
      
      // Handle 401 (unauthorized) - token might be expired
      if (response.status === 401) {
        console.warn(`⚠️ 401 Unauthorized - token may be expired, will retry with fresh token`);
        throw new Error(`RETRY_AUTH:API request failed: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`❌ Error fetching page:`, error.message);
    throw error;
  }
}

/**
 * Helper function to fetch all pages for a specific interval with pagination
 * @param {string} url - API endpoint URL
 * @param {string} tenant - Tenant identifier  
 * @param {Object} params - Request parameters
 * @returns {Promise<Object>} - Summary of fetched data
 */
async function fetchIntervalWithPagination(url, tenant, params) {
  let totalRecords = 0;
  let pageCount = 0;
  let nextStartKey = null;
  
  // Pagination settings
  const MAX_PAGES = 25000; // Hard safety limit
  
  console.log(`🚀 Starting agent activity events pagination for interval...`);
  
  // Continue fetching until next_start_key becomes null or empty string
  while (pageCount < MAX_PAGES) {
    const requestParams = { ...params };
    if (nextStartKey) {
      requestParams.start_key = nextStartKey;
    }
    
    try {
      console.log(`📡 Fetching page ${pageCount + 1}${nextStartKey ? ` with start_key: "${nextStartKey}"` : ' (initial page)'}...`);
      
      const response = await fetchPage(url, tenant, requestParams);
      
      // Extract data array and pagination info
      const events = response.events || response.data || [];
      const newStartKey = response.next_start_key;
      
      console.log(`📝 Page ${pageCount + 1}: ${events.length} events, next_start_key: "${newStartKey}", Total so far: ${totalRecords + events.length}`);
      
      // If no data returned, we're done
      if (events.length === 0) {
        console.log(`✅ No more data - ${totalRecords} total events in ${pageCount + 1} pages`);
        break;
      }
      
      // Process and store events in database
      try {
        let insertedCount = 0;
        
        for (const event of events) {
          try {
            // Extract agent extension from the event (based on API response format)
            const agentExtension = event.ext || event.extension || event.agent_extension;
            const agentName = event.username || event.agent_name || event.agent?.name || 'Unknown Agent';
            const eventTimestamp = event.Timestamp || event.timestamp || event.event_timestamp || Math.floor(Date.now() / 1000);
            
            if (!agentExtension) {
              console.warn(`⚠️ Event missing agent extension:`, {
                available_fields: Object.keys(event),
                agent: event.agent,
                extension: event.extension,
                agent_extension: event.agent_extension
              });
              continue;
            }
            
            await insertAgentActivity(
              agentExtension,
              agentName,
              eventTimestamp,
              event
            );
            
            insertedCount++;
            
          } catch (insertError) {
            console.error(`❌ Failed to insert event for agent ${event.extension || 'unknown'}:`, insertError.message);
          }
        }
        
        totalRecords += events.length;
        console.log(`💾 DB Inserted: ${insertedCount}/${events.length} events successfully`);
        
        // Log sample event structure for debugging
        if (pageCount === 0 && events.length > 0) {
          const sampleEvent = events[0];
          console.log(`🔍 Sample event structure:`, {
            available_fields: Object.keys(sampleEvent),
            extension: sampleEvent.extension,
            agent_extension: sampleEvent.agent_extension,
            agent_name: sampleEvent.agent_name,
            username: sampleEvent.username,
            timestamp: sampleEvent.timestamp,
            event_timestamp: sampleEvent.event_timestamp,
            agent: sampleEvent.agent
          });
        }
        
      } catch (dbError) {
        console.error(`❌ Database error on page ${pageCount + 1}:`, dbError.message);
        console.error(`❌ Sample data that failed:`, events.slice(0, 2));
        // Continue with pagination even if DB insert fails
        totalRecords += events.length;
      }
      
      pageCount++;
      
      // CRITICAL: Stop if next_start_key is null, undefined, or empty string
      // This is the natural end of pagination as defined by the API
      if (!newStartKey || newStartKey === '' || newStartKey === null) {
        console.log(`✅ Pagination complete - next_start_key is "${newStartKey}". Total: ${totalRecords} events in ${pageCount} pages`);
        break;
      }
      
      // Continue fetching with new token
      console.log(`   ➡️  Continuing with next_start_key: "${newStartKey}"`);
      
      // Set next token for next iteration
      nextStartKey = newStartKey;
      
    } catch (error) {
      console.error(`❌ Error on page ${pageCount + 1}:`, error.message);
      console.error(`❌ Full error details:`, error);
      
      // Retry logic for transient errors and authentication issues
      if (error.message.includes('timeout') || error.message.includes('ECONNRESET') || 
          error.message.includes('502') || error.message.includes('503') ||
          error.message.includes('RETRY_AUTH')) {
        console.log(`🔄 Retrying page ${pageCount + 1} due to ${error.message.includes('RETRY_AUTH') ? 'authentication' : 'transient'} error...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        continue; // Retry the same page
      }
      
      break;
    }
  }
  
  if (pageCount >= MAX_PAGES) {
    console.log(`⚠️ Reached maximum page limit (${MAX_PAGES}). Total: ${totalRecords} events`);
  }
  
  return {
    records: totalRecords,
    pages: pageCount
  };
}


/**
 * Format date for API compatibility - API expects Unix timestamp in seconds
 * @param {string|number|Date} dateString - Date to format
 * @returns {number|null} - Unix timestamp in seconds
 */
function formatDateForApi(dateString) {
  if (!dateString) return null;
  
  // If it's already a number, assume it's already formatted correctly
  if (typeof dateString === 'number') return dateString;
  
  try {
    // Parse the date string to a Date object
    const date = dateString instanceof Date ? dateString : new Date(dateString);
    
    // Convert to Unix timestamp in seconds (not milliseconds)
    return Math.floor(date.getTime() / 1000);
  } catch (e) {
    console.error('Error formatting date:', e);
    return dateString; // Return original if parsing fails
  }
}

export default {
  fetchAllAgentActivityEvents
};
